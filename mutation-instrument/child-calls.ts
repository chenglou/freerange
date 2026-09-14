// What worker.ts's modes share: values, cause classes, first firings and differences, calls through a tree's modules with a
// recorder installed, and lookups in a plan. Like the modes, it loads no TypeScript library.
import {writeSync} from 'node:fs'
import {maxMagnitude, type Value} from './domain.ts'
import {encodeJson} from './encode.ts'
import type {Input} from './lattice.ts'
import {BUDGET, DISCARD, type Recorder} from './recorder.ts'
import {RULE_THRESHOLDS, type CauseClass, type ChildLine, type CopyPlan, type Difference, type EntryPlan, type FilePlan, type FirstFiring, type MutantPlan, type Plan, type SiteFirings} from './types.ts'

export const RULES = RULE_THRESHOLDS.length
export const PRODUCERS = 4
export const MAX_INPUT_CHARACTERS = 2048

export function emit(line: ChildLine) {
  writeSync(1, `${encodeJson(line)}\n`)
}

// -- Values -----------------------------------------------------------------

export function cloneValue(value: Value): Value {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value != null && typeof value === 'object') {
    const result: Record<string, Value> = {}
    for (const key of Object.keys(value)) result[key] = cloneValue(value[key])
    return result
  }
  return value
}

function hasSubnormal(value: Value): boolean {
  if (typeof value === 'number') return value !== 0 && Math.abs(value) < 2.2250738585072014e-308
  if (value == null || typeof value !== 'object') return false
  return (Array.isArray(value) ? value : Object.values(value)).some(hasSubnormal)
}

export function causeOf(args: Value[], margin: number): CauseClass {
  if (hasSubnormal(args)) return 'subnormal'
  if (margin > 0 && margin <= 1e-6) return 'drift'
  if (maxMagnitude(args) > 1e4) return 'large'
  return 'ordinary'
}

export function encodedInput(args: Value[]): string | null {
  const text = encodeJson(args)
  return text.length <= MAX_INPUT_CHARACTERS ? text : null
}

export function firstFiring(input: Input, index: number, margin: number): FirstFiring {
  return {index, producer: input.producer, margin: Number.isNaN(margin) ? null : margin, cause: causeOf(input.args, margin), input: encodedInput(input.args)}
}

export function findNonFinite(value: unknown, path: string, depth: number): string | null {
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
export function same(x: unknown, y: unknown): boolean {
  if (typeof x !== 'object' || typeof y !== 'object' || x == null || y == null) return Object.is(x, y)
  const left = x as Record<string, unknown>
  const right = y as Record<string, unknown>
  const keys = Object.keys(left)
  for (const key of keys) if (!same(left[key], right[key])) return false
  return keys.length === Object.keys(right).length
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : `threw ${String(error)}`
}

// -- Modules and calls ------------------------------------------------------

export type EntryFunction = (...args: Value[]) => unknown
type Outcome = {discarded: boolean; overBudget: boolean; thrown: string | null; value: unknown}
type Modules = Map<string, Record<string, unknown>>

export function callEntry(fn: EntryFunction, args: Value[]): Outcome {
  try {
    return {discarded: false, overBudget: false, thrown: null, value: fn(...args.map(cloneValue))}
  } catch (error) {
    if (error === DISCARD) return {discarded: true, overBudget: false, thrown: null, value: undefined}
    if (error === BUDGET) return {discarded: false, overBudget: true, thrown: null, value: undefined}
    return {discarded: false, overBudget: false, thrown: describeError(error), value: undefined}
  }
}

/** Instrumented modules read `globalThis.__fr` once, at load: a tree calls the recorder installed before its first import. */
export function installRecorder(recorder: Recorder) {
  ;(globalThis as Record<string, unknown>)['__fr'] = recorder
}

/** Imports every file of a tree, instrumented or not. Distinct paths give the original and the mutant separate module instances. */
export async function loadModules(files: FilePlan[], which: 'instrumented' | 'source'): Promise<Modules> {
  const result: Modules = new Map()
  for (const file of files) result.set(file.file, (await import(file[which])) as Record<string, unknown>)
  return result
}

export function entryFunction(modules: Modules, entry: EntryPlan): EntryFunction {
  const fn = modules.get(entry.file)?.[entry.name]
  if (typeof fn !== 'function') throw new Error(`the tree has no function ${entry.name} in ${entry.file}`)
  return fn as EntryFunction
}

export function newDifference(): Difference {
  return {count: 0, first: null, detail: null}
}

export function recordDifference(difference: Difference, input: Input, index: number, detail: string) {
  difference.count += 1
  if (difference.first != null) return
  difference.first = firstFiring(input, index, NaN)
  difference.detail = detail.length <= MAX_INPUT_CHARACTERS ? detail : `${detail.slice(0, MAX_INPUT_CHARACTERS)}…`
}

export function siteFirings(site: number, counts: Uint32Array, firsts: (FirstFiring | null)[]): SiteFirings {
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

// -- Plan lookups -------------------------------------------------------------

export function supportedEntries(copy: CopyPlan) {
  return copy.entries.filter((entry) => entry.unsupported == null)
}

export function findMutant(plan: Plan, key: string): {mutant: MutantPlan; copy: CopyPlan} {
  const mutant = plan.mutants.find((candidate) => candidate.key === key)
  const copy = plan.copies.find((candidate) => candidate.copy === mutant?.copy)
  if (mutant == null || copy == null) throw new Error(`no mutant ${key} in the plan`)
  return {mutant, copy}
}

export function findCopy(plan: Plan, name: string): CopyPlan {
  const copy = plan.copies.find((candidate) => candidate.copy === name)
  if (copy == null) throw new Error(`no copy ${name} in the plan`)
  return copy
}

export function findEntry(copy: CopyPlan, name: string): EntryPlan {
  const entry = copy.entries.find((candidate) => candidate.name === name)
  if (entry == null) throw new Error(`no entry ${name} in copy ${copy.copy}`)
  return entry
}
