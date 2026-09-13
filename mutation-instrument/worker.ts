// A child process: runs one job and writes JSON lines to stdout. It loads no TypeScript library and no Bun plugin; it
// imports the instrumented files run.ts wrote to disk, regenerates every input from its index, and keeps only
// per-site counters and one first input per site and rule.
// usage: bun worker.ts '<job json>'
//   baseline: every entry of every base, originals only
//   mutant:   every entry of the mutant's base, original then mutant on each input
//   replay:   one recorded input through the instrumented original and mutant
//   verify:   one recorded input through the uninstrumented original, console.assert overridden to record lines
import {readFileSync, writeSync} from 'node:fs'
import type {Value} from './domain.ts'
import {decodeJson, encodeJson} from './encode.ts'
import {compileLattice, DIGEST_START, digestValue, inputAt, type Input} from './lattice.ts'
import {createRecorder, DISCARD, resetRecorder, type Recorder} from './recorder.ts'
import {CRITERION_RULE, RULE_THRESHOLDS, type BasePlan, type CauseClass, type ChildLine, type Difference, type EntryPlan, type FirstFiring, type Job, type Plan, type SiteFirings} from './types.ts'

const started = performance.now()
const RULES = RULE_THRESHOLDS.length
const PRODUCERS = 4
const MAX_INPUT_CHARACTERS = 2048

function emit(line: ChildLine) {
  writeSync(1, `${encodeJson(line)}\n`)
}

// -- Values -----------------------------------------------------------------

function cloneValue(value: Value): Value {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value != null && typeof value === 'object') {
    const result: Record<string, Value> = {}
    for (const key of Object.keys(value)) result[key] = cloneValue(value[key])
    return result
  }
  return value
}

function maxMagnitude(value: Value): number {
  if (typeof value === 'number') return Math.abs(value)
  if (value == null || typeof value !== 'object') return 0
  let result = 0
  for (const child of Array.isArray(value) ? value : Object.values(value)) result = Math.max(result, maxMagnitude(child))
  return result
}

function hasSubnormal(value: Value): boolean {
  if (typeof value === 'number') return value !== 0 && Math.abs(value) < 2.2250738585072014e-308
  if (value == null || typeof value !== 'object') return false
  return (Array.isArray(value) ? value : Object.values(value)).some(hasSubnormal)
}

function causeOf(args: Value[], margin: number): CauseClass {
  if (hasSubnormal(args)) return 'subnormal'
  if (margin > 0 && margin <= 1e-6) return 'drift'
  if (maxMagnitude(args) > 1e4) return 'large'
  return 'ordinary'
}

function encodedInput(args: Value[]): string | null {
  const text = encodeJson(args)
  return text.length <= MAX_INPUT_CHARACTERS ? text : null
}

function firstFiring(input: Input, index: number, margin: number): FirstFiring {
  return {index, producer: input.producer, margin: Number.isNaN(margin) ? null : margin, cause: causeOf(input.args, margin), input: encodedInput(input.args)}
}

function findNonFinite(value: unknown, path: string, depth: number): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} = ${value}`
  if (depth > 8 || value == null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findNonFinite(value[index], `${path}[${index}]`, depth + 1)
      if (found != null) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const found = findNonFinite(record[key], `${path}.${key}`, depth + 1)
    if (found != null) return found
  }
  return null
}

/** behavior@v1: skeptic_sysdiff.ts `same()`, numbers and booleans by Object.is, records field by field. */
function same(x: unknown, y: unknown): boolean {
  if (typeof x !== 'object' || typeof y !== 'object' || x == null || y == null) return Object.is(x, y)
  const left = x as Record<string, unknown>
  const right = y as Record<string, unknown>
  const keys = Object.keys(left)
  for (const key of keys) if (!same(left[key], right[key])) return false
  return keys.length === Object.keys(right).length
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : `threw ${String(error)}`
}

// -- Calls ------------------------------------------------------------------

type EntryFunction = (...args: Value[]) => unknown
type Outcome = {discarded: boolean; thrown: string | null; value: unknown}

function callEntry(fn: EntryFunction, args: Value[]): Outcome {
  try {
    return {discarded: false, thrown: null, value: fn(...args.map(cloneValue))}
  } catch (error) {
    if (error === DISCARD) return {discarded: true, thrown: null, value: undefined}
    return {discarded: false, thrown: describeError(error), value: undefined}
  }
}

function installRecorder(recorder: Recorder) {
  ;(globalThis as Record<string, unknown>)['__fr'] = recorder
}

async function loadEntries(path: string, entries: EntryPlan[]): Promise<Map<string, EntryFunction>> {
  const module = (await import(path)) as Record<string, unknown>
  const result = new Map<string, EntryFunction>()
  for (const entry of entries) {
    const fn = module[entry.name]
    if (typeof fn !== 'function') throw new Error(`${path} has no function ${entry.name}`)
    result.set(entry.name, fn as EntryFunction)
  }
  return result
}

function newDifference(): Difference {
  return {count: 0, first: null, detail: null}
}

function recordDifference(difference: Difference, input: Input, index: number, detail: string) {
  difference.count += 1
  if (difference.first != null) return
  difference.first = firstFiring(input, index, NaN)
  difference.detail = detail.length <= MAX_INPUT_CHARACTERS ? detail : `${detail.slice(0, MAX_INPUT_CHARACTERS)}…`
}

function siteFirings(site: number, counts: Uint32Array, firsts: (FirstFiring | null)[]): SiteFirings {
  const ruleCounts: number[][] = []
  const ruleFirsts: (FirstFiring | null)[] = []
  for (let rule = 0; rule < RULES; rule++) {
    const perProducer: number[] = []
    for (let producer = 0; producer < PRODUCERS; producer++) perProducer.push(counts[(site * RULES + rule) * PRODUCERS + producer]!)
    ruleCounts.push(perProducer)
    ruleFirsts.push(firsts[site * RULES + rule] ?? null)
  }
  return {site, counts: ruleCounts, first: ruleFirsts}
}

function supportedEntries(base: BasePlan) {
  return base.entries.filter((entry) => entry.unsupported == null)
}

// -- Modes ------------------------------------------------------------------

async function runBaseline(plan: Plan) {
  for (const base of plan.bases) {
    const recorder = createRecorder(base.sites)
    installRecorder(recorder)
    const entries = supportedEntries(base)
    const functions = await loadEntries(base.instrumented, entries)
    const siteCount = base.sites.length
    for (const entry of entries) {
      const fn = functions.get(entry.name)!
      const entryStarted = performance.now()
      const lattice = compileLattice(entry, plan.settings)
      recorder.entry = entry.name
      const reached = new Uint32Array(siteCount)
      const counts = new Uint32Array(siteCount * RULES * PRODUCERS)
      const firsts = new Array<FirstFiring | null>(siteCount * RULES).fill(null)
      const byCause: Record<CauseClass, number>[] = []
      for (let site = 0; site < siteCount; site++) byCause.push({subnormal: 0, drift: 0, large: 0, ordinary: 0})
      const throws = newDifference()
      const nonFiniteReturns = newDifference()
      let discarded = 0
      let digest = DIGEST_START
      for (let index = 0; index < plan.settings.budget; index++) {
        if ((index & 1023) === 0) emit({type: 'heartbeat', entry: entry.name, index})
        const input = inputAt(lattice, index)
        digest = digestValue(digest, input.args)
        resetRecorder(recorder)
        const outcome = callEntry(fn, input.args)
        if (outcome.discarded) {
          discarded += 1
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
      emit({type: 'baseline', base: base.base, entry: entry.name, inputs: plan.settings.budget, discarded, digest, nsPerCall: (ms * 1e6) / plan.settings.budget, reached: [...reached], firings, throws, nonFiniteReturns, ms})
    }
  }
}

async function runMutant(plan: Plan, mutantId: string) {
  const mutant = plan.mutants.find((candidate) => candidate.id === mutantId)
  const base = plan.bases.find((candidate) => candidate.base === mutant?.base)
  if (mutant == null || base == null) throw new Error(`no mutant ${mutantId} in the plan`)
  const recorder = createRecorder(base.sites)
  installRecorder(recorder)
  const entries = supportedEntries(base)
  const originals = await loadEntries(base.instrumented, entries)
  const mutants = await loadEntries(mutant.instrumented, entries)
  const siteCount = base.sites.length
  const originalLevels = new Uint8Array(siteCount)
  for (const entry of entries) {
    const originalFn = originals.get(entry.name)!
    const mutantFn = mutants.get(entry.name)!
    const entryStarted = performance.now()
    const lattice = compileLattice(entry, plan.settings)
    recorder.entry = entry.name
    const counts = new Uint32Array(siteCount * RULES * PRODUCERS)
    const firsts = new Array<FirstFiring | null>(siteCount * RULES).fill(null)
    const throws = newDifference()
    const nonFiniteReturns = newDifference()
    const behavior = newDifference()
    let discarded = 0
    let mutantOnlyDiscards = 0
    let digest = DIGEST_START
    for (let index = 0; index < plan.settings.budget; index++) {
      if ((index & 1023) === 0) emit({type: 'heartbeat', entry: entry.name, index})
      const input = inputAt(lattice, index)
      digest = digestValue(digest, input.args)
      resetRecorder(recorder)
      const original = callEntry(originalFn, input.args)
      if (original.discarded) {
        discarded += 1
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
    emit({type: 'result', mutant: mutant.id, base: base.base, entry: entry.name, inputs: plan.settings.budget, discarded, mutantOnlyDiscards, digest, kills, throws, nonFiniteReturns, behavior, ms: performance.now() - entryStarted})
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

async function runReplay(plan: Plan, mutantId: string, entryName: string, args: Value[]) {
  const mutant = plan.mutants.find((candidate) => candidate.id === mutantId)
  const base = plan.bases.find((candidate) => candidate.base === mutant?.base)
  const entry = base?.entries.find((candidate) => candidate.name === entryName)
  if (mutant == null || base == null || entry == null) throw new Error(`no entry ${entryName} for mutant ${mutantId}`)
  const recorder = createRecorder(base.sites)
  installRecorder(recorder)
  const originalFn = (await loadEntries(base.instrumented, [entry])).get(entry.name)!
  const mutantFn = (await loadEntries(mutant.instrumented, [entry])).get(entry.name)!
  recorder.entry = entry.name
  resetRecorder(recorder)
  const original = callEntry(originalFn, args)
  const originalPairs = levelPairs(recorder)
  resetRecorder(recorder)
  const mutated = callEntry(mutantFn, args)
  emit({type: 'replay', mutant: mutantId, entry: entryName, discarded: original.discarded, original: originalPairs, mutated: levelPairs(recorder), originalThrew: original.thrown, mutantThrew: mutated.thrown})
}

async function runVerify(plan: Plan, baseName: string, entryName: string, args: Value[]) {
  const base = plan.bases.find((candidate) => candidate.base === baseName)
  const entry = base?.entries.find((candidate) => candidate.name === entryName)
  if (base == null || entry == null) throw new Error(`no entry ${entryName} in base ${baseName}`)
  const firedLines: number[] = []
  console.assert = (condition?: unknown) => {
    const held = Boolean(condition)
    if (held) return
    const frame = (new Error().stack ?? '').split('\n').find((line) => line.includes(`${base.source}:`))
    const match = frame == null ? null : new RegExp(`${base.source.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(frame)
    firedLines.push(match == null ? 0 : Number(match[1]))
  }
  const fn = (await loadEntries(base.source, [entry])).get(entry.name)!
  let thrown: string | null = null
  try {
    fn(...args)
  } catch (error) {
    thrown = describeError(error)
  }
  emit({type: 'verify', base: baseName, entry: entryName, firedLines, thrown})
}

const job = decodeJson(process.argv[2] ?? '') as Job
const plan = decodeJson(readFileSync(job.plan, 'utf8')) as Plan
switch (job.mode) {
  case 'baseline': await runBaseline(plan); break
  case 'mutant': await runMutant(plan, job.mutant); break
  case 'replay': await runReplay(plan, job.mutant, job.entry, decodeJson(job.args) as Value[]); break
  case 'verify': await runVerify(plan, job.base, job.entry, decodeJson(job.args) as Value[]); break
}
emit({type: 'done', maxRssKb: process.resourceUsage().maxRSS, ms: performance.now() - started})
