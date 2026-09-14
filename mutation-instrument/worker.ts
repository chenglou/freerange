// A child process: runs one job and writes JSON lines to stdout. It loads no TypeScript library and no Bun plugin; it
// imports the instrumented trees run.ts wrote to disk, regenerates every input from its index, and keeps only
// per-site counters and one first input per site and rule.
// usage: bun worker.ts '<job json>'
//   baseline: every entry of every copy, originals only
//   mutant:   every entry of the mutant's copy, original then mutant on each input
//   replay:   one recorded input through the instrumented original and mutant
//   verify:   one recorded input through the uninstrumented original, console.assert overridden to record lines
//   call:     one input through the uninstrumented original and mutant trees, recording lines and return values
//   verify-batch: a list of recorded inputs through the uninstrumented original, one line per input
//   score:    scoring@witness-v1's instrument gates over every entry of one copy (falseAlarm@instrument, missedFiring)
//   cw-prepare, cw-mutant: contract-writing-v1's domain, behaviour and kills on a writer's patched file (contract-writing-worker.ts)
import {readFileSync} from 'node:fs'
import {isCallerDiscard} from './callers.ts'
import {callEntry, causeOf, cloneValue, describeError, emit, encodedInput, entryFunction, findCopy, findEntry, findMutant, findNonFinite, firstFiring, installRecorder, loadModules, MAX_INPUT_CHARACTERS, newDifference, PRODUCERS, recordDifference, RULES, same, siteFirings, supportedEntries, type EntryFunction} from './child-calls.ts'
import {runContractMutant, runContractPrepare} from './contract-writing-worker.ts'
import type {Value} from './domain.ts'
import {domainLines} from './domain-lines.ts'
import {decodeJson, encodeJson} from './encode.ts'
import {compileLattice, DIGEST_START, digestValue, inputAt} from './lattice.ts'
import {decodePlan} from './plan-file.ts'
import {lowbias32} from './random.ts'
import {createRecorder, resetRecorder, type Recorder} from './recorder.ts'
import {scanFeatures} from './scan-features.ts'
import {CAUSES, CRITERION_RULE, RULE_THRESHOLDS, type CallOutcome, type CauseClass, type FilePlan, type FirstFiring, type Job, type Plan, type ScoreFailure, type ScoreRow, type SiteFirings} from './types.ts'

const started = performance.now()

// -- Modes ------------------------------------------------------------------

async function runBaseline(plan: Plan) {
  for (const copy of plan.copies) {
    const recorder = createRecorder(copy.sites, plan.stepBudget)
    installRecorder(recorder)
    const entries = supportedEntries(copy)
    const modules = await loadModules(copy.files, 'instrumented')
    const siteCount = copy.sites.length
    for (const entry of entries) {
      const fn = entryFunction(modules, entry)
      const entryStarted = performance.now()
      const lattice = compileLattice(entry, plan.settings)
      recorder.setEntry(entry.discardSites)
      const reached = new Uint32Array(siteCount)
      const counts = new Uint32Array(siteCount * RULES * PRODUCERS)
      const firsts = new Array<FirstFiring | null>(siteCount * RULES).fill(null)
      const byCause: Record<CauseClass, number>[] = []
      for (let site = 0; site < siteCount; site++) byCause.push({subnormal: 0, drift: 0, large: 0, ordinary: 0})
      const throws = newDifference()
      const nonFiniteReturns = newDifference()
      let discarded = 0
      let callerDiscarded = 0
      let overBudget = 0
      let digest = DIGEST_START
      for (let index = 0; index < plan.settings.budget; index++) {
        if ((index & 1023) === 0) emit({type: 'heartbeat', entry: entry.name, index})
        const input = inputAt(lattice, index)
        digest = digestValue(digest, input.args)
        if (isCallerDiscard(entry.callerRules, input.args)) {
          callerDiscarded += 1
          continue
        }
        resetRecorder(recorder)
        const outcome = callEntry(fn, input.args)
        if (outcome.discarded) {
          discarded += 1
          continue
        }
        if (outcome.overBudget) {
          overBudget += 1
          continue
        }
        for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
          const site = recorder.touched[touchedIndex]!
          reached[site]! += 1
          const level = recorder.levels[site]!
          if (level < 2) continue
          for (let rule = 0; rule < RULES; rule++) {
            if (level < RULE_THRESHOLDS[rule]!) continue
            counts[(site * RULES + rule) * PRODUCERS + input.producer]! += 1
            firsts[site * RULES + rule] ??= firstFiring(input, index, recorder.margins[site]!)
          }
          if (level >= RULE_THRESHOLDS[CRITERION_RULE]!) byCause[site]![causeOf(input.args, recorder.margins[site]!)] += 1
        }
        if (outcome.thrown != null) {
          recordDifference(throws, input, index, outcome.thrown)
          continue
        }
        const nonFinite = findNonFinite(outcome.value, 'return', 0)
        if (nonFinite != null) recordDifference(nonFiniteReturns, input, index, nonFinite)
      }
      const firings: (SiteFirings & {byCause: Record<CauseClass, number>})[] = []
      for (let site = 0; site < siteCount; site++) {
        if (firsts[site * RULES] == null) continue
        firings.push({...siteFirings(site, counts, firsts), byCause: byCause[site]!})
      }
      const ms = performance.now() - entryStarted
      emit({type: 'baseline', base: copy.copy, entry: entry.name, inputs: plan.settings.budget, discarded, callerDiscarded, overBudget, digest, nsPerCall: (ms * 1e6) / plan.settings.budget, reached: [...reached], firings, throws, nonFiniteReturns, ms})
    }
  }
}

async function runMutant(plan: Plan, key: string) {
  const {mutant, copy} = findMutant(plan, key)
  const recorder = createRecorder(copy.sites, plan.stepBudget)
  installRecorder(recorder)
  const entries = supportedEntries(copy)
  const originals = await loadModules(copy.files, 'instrumented')
  const mutants = await loadModules(mutant.files, 'instrumented')
  const siteCount = copy.sites.length
  const originalLevels = new Uint8Array(siteCount)
  for (const entry of entries) {
    const originalFn = entryFunction(originals, entry)
    const mutantFn = entryFunction(mutants, entry)
    const entryStarted = performance.now()
    const lattice = compileLattice(entry, plan.settings)
    recorder.setEntry(entry.discardSites)
    const counts = new Uint32Array(siteCount * RULES * PRODUCERS)
    const firsts = new Array<FirstFiring | null>(siteCount * RULES).fill(null)
    const throws = newDifference()
    const nonFiniteReturns = newDifference()
    const behavior = newDifference()
    const mutantOverBudget = newDifference()
    let discarded = 0
    let callerDiscarded = 0
    let mutantOnlyDiscards = 0
    let overBudget = 0
    let digest = DIGEST_START
    for (let index = 0; index < plan.settings.budget; index++) {
      if ((index & 1023) === 0) emit({type: 'heartbeat', entry: entry.name, index})
      const input = inputAt(lattice, index)
      digest = digestValue(digest, input.args)
      if (isCallerDiscard(entry.callerRules, input.args)) {
        callerDiscarded += 1
        continue
      }
      resetRecorder(recorder)
      const original = callEntry(originalFn, input.args)
      if (original.discarded) {
        discarded += 1
        continue
      }
      if (original.overBudget) {
        overBudget += 1
        continue
      }
      originalLevels.fill(0)
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = recorder.touched[touchedIndex]!
        originalLevels[site] = recorder.levels[site]!
      }
      resetRecorder(recorder)
      const mutated = callEntry(mutantFn, input.args)
      if (mutated.discarded) {
        mutantOnlyDiscards += 1
        continue
      }
      if (mutated.overBudget) {
        recordDifference(mutantOverBudget, input, index, `the mutant passed the step budget of ${plan.stepBudget ?? Infinity} loop ticks where the original ${original.thrown == null ? 'returned' : 'threw'}`)
        continue
      }
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = recorder.touched[touchedIndex]!
        const level = recorder.levels[site]!
        const originalLevel = originalLevels[site]!
        if (level <= originalLevel || level < 2) continue
        for (let rule = 0; rule < RULES; rule++) {
          const threshold = RULE_THRESHOLDS[rule]!
          if (level < threshold || originalLevel >= threshold) continue
          counts[(site * RULES + rule) * PRODUCERS + input.producer]! += 1
          firsts[site * RULES + rule] ??= firstFiring(input, index, recorder.margins[site]!)
        }
      }
      if (mutated.thrown != null && original.thrown == null) recordDifference(throws, input, index, mutated.thrown)
      if (mutated.thrown == null && original.thrown == null) {
        const nonFinite = findNonFinite(mutated.value, 'return', 0)
        if (nonFinite != null && findNonFinite(original.value, 'return', 0) == null) recordDifference(nonFiniteReturns, input, index, nonFinite)
      }
      const differs = mutated.thrown != null || original.thrown != null ? (mutated.thrown == null) !== (original.thrown == null) : !same(original.value, mutated.value)
      if (differs) recordDifference(behavior, input, index, `original ${original.thrown ?? encodeJson(original.value)}; mutant ${mutated.thrown ?? encodeJson(mutated.value)}`)
    }
    const kills: SiteFirings[] = []
    for (let site = 0; site < siteCount; site++) if (firsts[site * RULES] != null) kills.push(siteFirings(site, counts, firsts))
    emit({type: 'result', mutant: mutant.key, base: copy.copy, entry: entry.name, inputs: plan.settings.budget, discarded, callerDiscarded, mutantOnlyDiscards, overBudget, mutantOverBudget, digest, kills, throws, nonFiniteReturns, behavior, ms: performance.now() - entryStarted})
  }
}

function levelPairs(recorder: Recorder): [number, number][] {
  const result: [number, number][] = []
  for (let index = 0; index < recorder.touchedCount; index++) {
    const site = recorder.touched[index]!
    result.push([site, recorder.levels[site]!])
  }
  return result
}

async function runReplay(plan: Plan, key: string, entryName: string, args: Value[]) {
  const {mutant, copy} = findMutant(plan, key)
  const entry = findEntry(copy, entryName)
  const recorder = createRecorder(copy.sites, plan.stepBudget)
  installRecorder(recorder)
  const originalFn = entryFunction(await loadModules(copy.files, 'instrumented'), entry)
  const mutantFn = entryFunction(await loadModules(mutant.files, 'instrumented'), entry)
  recorder.setEntry(entry.discardSites)
  resetRecorder(recorder)
  const original = callEntry(originalFn, args)
  const originalPairs = levelPairs(recorder)
  resetRecorder(recorder)
  const mutated = callEntry(mutantFn, args)
  emit({type: 'replay', mutant: key, entry: entryName, callerDiscarded: isCallerDiscard(entry.callerRules, args), discarded: original.discarded, originalOverBudget: original.overBudget, mutantOverBudget: mutated.overBudget, original: originalPairs, mutated: levelPairs(recorder), originalThrew: original.thrown, mutantThrew: mutated.thrown})
}

// console.assert overridden to record `file:line` of the innermost stack frame in one of the trees' files.
let firedLines: string[] = []
let recordedFiles: FilePlan[] = []
function recordFailingAsserts() {
  console.assert = (condition?: unknown) => {
    const held = Boolean(condition)
    if (held) return
    const frames = (new Error().stack ?? '').split('\n')
    for (const frame of frames) {
      const file = recordedFiles.find((candidate) => frame.includes(`${candidate.source}:`))
      if (file == null) continue
      const match = new RegExp(`${file.source.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(frame)
      firedLines.push(`${file.file}:${match == null ? 0 : Number(match[1])}`)
      return
    }
    firedLines.push('unknown:0')
  }
}

function uninstrumentedCall(fn: EntryFunction, args: Value[]): CallOutcome {
  firedLines = []
  let thrown: string | null = null
  let value: string | null = null
  try {
    const text = encodeJson(fn(...args.map(cloneValue)))
    value = text.length <= MAX_INPUT_CHARACTERS ? text : `${text.slice(0, MAX_INPUT_CHARACTERS)}…`
  } catch (error) {
    thrown = describeError(error)
  }
  return {fired: firedLines, thrown, value}
}

async function runVerify(plan: Plan, copyName: string, entryName: string, args: Value[]) {
  const copy = findCopy(plan, copyName)
  const entry = findEntry(copy, entryName)
  recordedFiles = copy.files
  recordFailingAsserts()
  const outcome = uninstrumentedCall(entryFunction(await loadModules(copy.files, 'source'), entry), args)
  emit({type: 'verify', base: copyName, entry: entryName, fired: outcome.fired, thrown: outcome.thrown})
}

async function runCall(plan: Plan, key: string, entryName: string, args: Value[]) {
  const {mutant, copy} = findMutant(plan, key)
  const entry = findEntry(copy, entryName)
  recordedFiles = [...copy.files, ...mutant.files]
  recordFailingAsserts()
  const originalFn = entryFunction(await loadModules(copy.files, 'source'), entry)
  const mutantFn = entryFunction(await loadModules(mutant.files, 'source'), entry)
  const original = uninstrumentedCall(originalFn, args)
  const mutated = uninstrumentedCall(mutantFn, args)
  emit({type: 'call', mutant: key, entry: entryName, original, mutated})
}

async function runVerifyBatch(plan: Plan, copyName: string, itemsPath: string) {
  const copy = findCopy(plan, copyName)
  recordedFiles = copy.files
  recordFailingAsserts()
  const modules = await loadModules(copy.files, 'source')
  const items = decodeJson(readFileSync(itemsPath, 'utf8')) as {entry: string; args: string}[]
  for (let item = 0; item < items.length; item++) {
    const {entry, args} = items[item]!
    if ((item & 1023) === 0) emit({type: 'heartbeat', entry, index: item})
    const outcome = uninstrumentedCall(entryFunction(modules, findEntry(copy, entry)), decodeJson(args) as Value[])
    emit({type: 'verify-item', item, fired: outcome.fired, thrown: outcome.thrown})
  }
}

// -- scoring@witness-v1 instrument gates ----------------------------------------------------

// Per input of an entry: in the domain with no criterion-rule firing, firing, or outside the domain (discarded by a
// leading assert, a leak site or a caller rule, or past the step budget).
const QUIET = 0
const FIRING = 1
const OUTSIDE = 2
const LISTED_FAILURES = 20

type RowBuilder = {site: number; cause: CauseClass; indexes: number[]; producers: number[]; firstInput: string | null; features: Record<string, number>}

/**
 * The firing indexes a row verifies: all of them when there are at most `samples`, otherwise the first plus `samples`
 * distinct others at positions lowbias32(1 ^ row ordinal ^ k) modulo the count, for k = 0, 1, 2, ...
 */
function verifiedIndexes(indexes: number[], samples: number, ordinal: number): number[] {
  if (indexes.length <= samples) return indexes.slice()
  const picked = new Uint8Array(indexes.length)
  picked[0] = 1
  const result = [indexes[0]!]
  for (let k = 0; result.length <= samples; k++) {
    if (k > 100_000_000) throw new Error(`row ${ordinal}: seeded sampling found ${result.length - 1} distinct firing indexes in 1e8 draws`)
    const position = lowbias32((1 ^ ordinal ^ k) >>> 0) % indexes.length
    if (picked[position] === 1) continue
    picked[position] = 1
    result.push(indexes[position]!)
  }
  return result
}

async function runScore(plan: Plan, copyName: string, samplesPerRow: number, missedSamples: number, maxDrawsPerEntry: number) {
  const copy = findCopy(plan, copyName)
  const recorder = createRecorder(copy.sites, plan.stepBudget)
  installRecorder(recorder)
  const instrumented = await loadModules(copy.files, 'instrumented')
  const sources = await loadModules(copy.files, 'source')
  recordedFiles = copy.files
  recordFailingAsserts()
  const budget = plan.settings.budget
  const threshold = RULE_THRESHOLDS[CRITERION_RULE]!
  let ordinal = 0
  for (const entry of supportedEntries(copy)) {
    const fn = entryFunction(instrumented, entry)
    const sourceFn = entryFunction(sources, entry)
    const lattice = compileLattice(entry, plan.settings)
    recorder.setEntry(entry.discardSites)
    const domain = domainLines(copy, entry)
    const status = new Uint8Array(budget)
    const builders = new Array<RowBuilder | null>(copy.sites.length * CAUSES.length).fill(null)
    let digest = DIGEST_START
    let discarded = 0
    let callerDiscarded = 0
    let overBudget = 0
    for (let index = 0; index < budget; index++) {
      if ((index & 1023) === 0) emit({type: 'heartbeat', entry: entry.name, index})
      const input = inputAt(lattice, index)
      digest = digestValue(digest, input.args)
      if (isCallerDiscard(entry.callerRules, input.args)) {
        callerDiscarded += 1
        status[index] = OUTSIDE
        continue
      }
      resetRecorder(recorder)
      const outcome = callEntry(fn, input.args)
      if (outcome.discarded || outcome.overBudget) {
        if (outcome.discarded) discarded += 1
        else overBudget += 1
        status[index] = OUTSIDE
        continue
      }
      let features: Record<string, boolean> | null = null
      let featuresComputed = false
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = recorder.touched[touchedIndex]!
        if (recorder.levels[site]! < threshold) continue
        status[index] = FIRING
        const cause = causeOf(input.args, recorder.margins[site]!)
        const slot = site * CAUSES.length + CAUSES.indexOf(cause)
        let builder = builders[slot] ?? null
        if (builder == null) {
          builder = {site, cause, indexes: [], producers: [0, 0, 0, 0], firstInput: encodedInput(input.args), features: {}}
          builders[slot] = builder
        }
        builder.indexes.push(index)
        builder.producers[input.producer]! += 1
        if (!featuresComputed) {
          features = scanFeatures(entry.name, input.args)
          featuresComputed = true
        }
        if (features == null) continue
        for (const name of Object.keys(features)) if (features[name] === true) builder.features[name] = (builder.features[name] ?? 0) + 1
      }
    }

    // falseAlarm@instrument: regenerate each chosen firing input, check it fires the site with its cause again on the
    // instrumented original, then call the uninstrumented copy.
    const rows: ScoreRow[] = []
    for (const builder of builders) {
      if (builder == null) continue
      const site = copy.sites[builder.site]!
      const siteLine = `${site.file}:${site.line}`
      const chosen = verifiedIndexes(builder.indexes, samplesPerRow, ordinal)
      const failures: ScoreFailure[] = []
      let failureCount = 0
      for (const index of chosen) {
        const input = inputAt(lattice, index)
        resetRecorder(recorder)
        const again = callEntry(fn, input.args)
        const refires = !again.discarded && !again.overBudget && recorder.levels[builder.site]! >= threshold && causeOf(input.args, recorder.margins[builder.site]!) === builder.cause
        const call = uninstrumentedCall(sourceFn, input.args)
        const reason = digest !== entry.digest ? `input digest ${digest} differs from the plan's ${entry.digest}`
          : !refires ? 'the regenerated input does not fire the site with this cause on the instrumented original'
          : !call.fired.includes(siteLine) ? 'the uninstrumented copy does not record the site line'
          : call.fired.some((line) => domain.has(line)) ? 'the uninstrumented copy records a domain line' : null
        if (reason == null) continue
        failureCount += 1
        if (failures.length < LISTED_FAILURES) failures.push({index, reason, fired: call.fired, thrown: call.thrown})
      }
      rows.push({site: builder.site, cause: builder.cause, ordinal, count: builder.indexes.length, producers: builder.producers, firstIndex: builder.indexes[0]!, firstInput: builder.firstInput, verified: chosen.length, failureCount, failures, features: builder.features})
      ordinal += 1
    }

    // missedFiring: quiet in-domain indexes at lowbias32(2 ^ entry ordinal ^ k) modulo the budget, for k = 0, 1, 2, ...
    const sampled: number[] = []
    const seen = new Uint8Array(budget)
    let draws = 0
    for (; sampled.length < missedSamples && draws < maxDrawsPerEntry; draws++) {
      const index = lowbias32((2 ^ entry.ordinal ^ draws) >>> 0) % budget
      if (seen[index] === 1 || status[index] !== QUIET) continue
      seen[index] = 1
      sampled.push(index)
    }
    let missCount = 0
    const misses: {index: number; lines: string[]}[] = []
    for (const index of sampled) {
      const input = inputAt(lattice, index)
      resetRecorder(recorder)
      callEntry(fn, input.args)
      const lineLevels = new Map<string, number>()
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = copy.sites[recorder.touched[touchedIndex]!]!
        const line = `${site.file}:${site.line}`
        lineLevels.set(line, Math.max(lineLevels.get(line) ?? 0, recorder.levels[site.index]!))
      }
      const lines = uninstrumentedCall(sourceFn, input.args).fired.filter((line) => (lineLevels.get(line) ?? 0) <= 1)
      if (lines.length === 0) continue
      missCount += 1
      if (misses.length < LISTED_FAILURES) misses.push({index, lines})
    }
    emit({type: 'score', base: copy.copy, entry: entry.name, digest, inputs: budget, discarded, callerDiscarded, overBudget, rows, missed: {sampled: sampled.length, draws, missCount, misses}})
  }
}

const job = decodeJson(process.argv[2] ?? '') as Job
const plan = decodePlan(readFileSync(job.plan, 'utf8'))
switch (job.mode) {
  case 'baseline': await runBaseline(plan); break
  case 'mutant': await runMutant(plan, job.mutant); break
  case 'replay': await runReplay(plan, job.mutant, job.entry, decodeJson(job.args) as Value[]); break
  case 'verify': await runVerify(plan, job.base, job.entry, decodeJson(job.args) as Value[]); break
  case 'call': await runCall(plan, job.mutant, job.entry, decodeJson(job.args) as Value[]); break
  case 'verify-batch': await runVerifyBatch(plan, job.base, job.items); break
  case 'score': await runScore(plan, job.base, job.samplesPerRow, job.missedSamples, job.maxDrawsPerEntry); break
  case 'cw-prepare': await runContractPrepare(plan, job.contract, job.base, job.eligibility); break
  case 'cw-mutant': await runContractMutant(plan, job.mutant, job.eligibility); break
}
emit({type: 'done', maxRssKb: process.resourceUsage().maxRSS, ms: performance.now() - started})
