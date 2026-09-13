// A child process: runs one job and writes JSON lines to stdout. It loads no TypeScript library and no Bun plugin; it
// imports the instrumented trees run.ts wrote to disk, regenerates every input from its index, and keeps only
// per-site counters and one first input per site and rule.
// usage: bun worker.ts '<job json>'
//   baseline: every entry of every copy, originals only
//   mutant:   every entry of the mutant's copy, original then mutant on each input
//   replay:   one recorded input through the instrumented original and mutant
//   verify:   one recorded input through the uninstrumented original, console.assert overridden to record lines
//   call:     one input through the uninstrumented original and mutant trees, recording lines and return values
import {readFileSync, writeSync} from 'node:fs'
import type {Value} from './domain.ts'
import {decodeJson, encodeJson} from './encode.ts'
import {compileLattice, DIGEST_START, digestValue, inputAt, type Input} from './lattice.ts'
import {createRecorder, DISCARD, resetRecorder, type Recorder} from './recorder.ts'
import {CRITERION_RULE, RULE_THRESHOLDS, type CallOutcome, type CauseClass, type ChildLine, type CopyPlan, type Difference, type EntryPlan, type FilePlan, type FirstFiring, type Job, type MutantPlan, type Plan, type SiteFirings} from './types.ts'

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

// -- Modules and calls ------------------------------------------------------

type EntryFunction = (...args: Value[]) => unknown
type Outcome = {discarded: boolean; thrown: string | null; value: unknown}
type Modules = Map<string, Record<string, unknown>>

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

/** Imports every file of a tree, instrumented or not. Distinct paths give the original and the mutant separate module instances. */
async function loadModules(files: FilePlan[], which: 'instrumented' | 'source'): Promise<Modules> {
  const result: Modules = new Map()
  for (const file of files) result.set(file.file, (await import(file[which])) as Record<string, unknown>)
  return result
}

function entryFunction(modules: Modules, entry: EntryPlan): EntryFunction {
  const fn = modules.get(entry.file)?.[entry.name]
  if (typeof fn !== 'function') throw new Error(`the tree has no function ${entry.name} in ${entry.file}`)
  return fn as EntryFunction
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

function supportedEntries(copy: CopyPlan) {
  return copy.entries.filter((entry) => entry.unsupported == null)
}

function findMutant(plan: Plan, key: string): {mutant: MutantPlan; copy: CopyPlan} {
  const mutant = plan.mutants.find((candidate) => candidate.key === key)
  const copy = plan.copies.find((candidate) => candidate.copy === mutant?.copy)
  if (mutant == null || copy == null) throw new Error(`no mutant ${key} in the plan`)
  return {mutant, copy}
}

function findEntry(copy: CopyPlan, name: string): EntryPlan {
  const entry = copy.entries.find((candidate) => candidate.name === name)
  if (entry == null) throw new Error(`no entry ${name} in copy ${copy.copy}`)
  return entry
}

// -- Modes ------------------------------------------------------------------

async function runBaseline(plan: Plan) {
  for (const copy of plan.copies) {
    const recorder = createRecorder(copy.sites)
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
      emit({type: 'baseline', base: copy.copy, entry: entry.name, inputs: plan.settings.budget, discarded, digest, nsPerCall: (ms * 1e6) / plan.settings.budget, reached: [...reached], firings, throws, nonFiniteReturns, ms})
    }
  }
}

async function runMutant(plan: Plan, key: string) {
  const {mutant, copy} = findMutant(plan, key)
  const recorder = createRecorder(copy.sites)
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
    emit({type: 'result', mutant: mutant.key, base: copy.copy, entry: entry.name, inputs: plan.settings.budget, discarded, mutantOnlyDiscards, digest, kills, throws, nonFiniteReturns, behavior, ms: performance.now() - entryStarted})
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
  const recorder = createRecorder(copy.sites)
  installRecorder(recorder)
  const originalFn = entryFunction(await loadModules(copy.files, 'instrumented'), entry)
  const mutantFn = entryFunction(await loadModules(mutant.files, 'instrumented'), entry)
  recorder.setEntry(entry.discardSites)
  resetRecorder(recorder)
  const original = callEntry(originalFn, args)
  const originalPairs = levelPairs(recorder)
  resetRecorder(recorder)
  const mutated = callEntry(mutantFn, args)
  emit({type: 'replay', mutant: key, entry: entryName, discarded: original.discarded, original: originalPairs, mutated: levelPairs(recorder), originalThrew: original.thrown, mutantThrew: mutated.thrown})
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
  const copy = plan.copies.find((candidate) => candidate.copy === copyName)
  if (copy == null) throw new Error(`no copy ${copyName} in the plan`)
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

const job = decodeJson(process.argv[2] ?? '') as Job
const plan = decodeJson(readFileSync(job.plan, 'utf8')) as Plan
switch (job.mode) {
  case 'baseline': await runBaseline(plan); break
  case 'mutant': await runMutant(plan, job.mutant); break
  case 'replay': await runReplay(plan, job.mutant, job.entry, decodeJson(job.args) as Value[]); break
  case 'verify': await runVerify(plan, job.base, job.entry, decodeJson(job.args) as Value[]); break
  case 'call': await runCall(plan, job.mutant, job.entry, decodeJson(job.args) as Value[]); break
}
emit({type: 'done', maxRssKb: process.resourceUsage().maxRSS, ms: performance.now() - started})
