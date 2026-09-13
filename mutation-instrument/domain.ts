// Input domains and number value sources for domain@v1b and lattice@v1, forked from the replay input-range prototype
// (domain.ts). A domain is what an entry function accepts: its parameter types narrowed by the entry's leading
// console.assert bounds. A side of a number that no leading assert bounds is capped at ±1e6, so every number domain is
// finite.
import {nextFloat, nextIndex, type Random} from './random.ts'

export type Scalar = number | boolean | string | null | undefined
export type Value = Scalar | Value[] | {[name: string]: Value}

// An end is open when a strict bound produced it, e.g. after `console.assert(width > 0)` the value 0 is outside the
// domain while 0.001 is inside. Integer domains always have closed ends.
export type NumberDomain = {kind: 'number'; min: number; max: number; minOpen: boolean; maxOpen: boolean; integer: boolean; excluded: number | null}
// Literal unions, booleans, and the null/undefined arm of a nullable or optional type.
export type ChoiceDomain = {kind: 'choice'; values: Scalar[]}
export type RecordDomain = {kind: 'record'; fields: {name: string; domain: Domain}[]}
export type ArrayDomain = {kind: 'array'; element: Domain; maxLength: number}
export type TupleDomain = {kind: 'tuple'; elements: Domain[]}
export type UnionDomain = {kind: 'union'; members: Domain[]}
export type Domain = NumberDomain | ChoiceDomain | RecordDomain | ArrayDomain | TupleDomain | UnionDomain

export type Comparison = '<' | '<=' | '>' | '>=' | '===' | '!=='

export const DOMAIN_VERSION = 'domain@v1b'
export const NUMBER_CAP = 1e6
export const MAX_ARRAY_LENGTH = 6

/** Every number: a parameter's domain before its leading asserts narrow it, e.g. `x <= 1e8` narrows it to [-Infinity, 1e8]. */
export function unboundedNumber(): NumberDomain {
  return {kind: 'number', min: -Infinity, max: Infinity, minOpen: false, maxOpen: false, integer: false, excluded: null}
}

/**
 * Caps, in place, every number end that no leading assert bounded: -1e6 below and 1e6 above. A declared bound replaces
 * the cap on its side, whether it's narrower or wider than the cap. E.g. after `x >= 0` and `x <= 1e8` the domain is
 * [0, 1e8], after only `x >= 0` it's [0, 1e6], and with no leading assert it's [-1e6, 1e6].
 */
export function capUnboundedEnds(domain: Domain) {
  switch (domain.kind) {
    case 'number':
      if (domain.min === -Infinity) domain.min = -NUMBER_CAP
      if (domain.max === Infinity) domain.max = NUMBER_CAP
      break
    case 'choice':
      break
    case 'record':
      for (const field of domain.fields) capUnboundedEnds(field.domain)
      break
    case 'array':
      capUnboundedEnds(domain.element)
      break
    case 'tuple':
      for (const element of domain.elements) capUnboundedEnds(element)
      break
    case 'union':
      for (const member of domain.members) capUnboundedEnds(member)
      break
  }
}

export function numberInDomain(domain: NumberDomain, value: number): boolean {
  return (domain.minOpen ? value > domain.min : value >= domain.min)
    && (domain.maxOpen ? value < domain.max : value <= domain.max)
    && (!domain.integer || Number.isInteger(value))
    && value !== domain.excluded
}

function closeIntegerEnds(domain: NumberDomain) {
  domain.min = domain.minOpen ? Math.floor(domain.min) + 1 : Math.ceil(domain.min)
  domain.max = domain.maxOpen ? Math.ceil(domain.max) - 1 : Math.floor(domain.max)
  domain.minOpen = false
  domain.maxOpen = false
}

/** Narrows `domain` in place with `value op constant`, e.g. `x >= 0` raises the minimum to 0. */
export function applyBound(domain: NumberDomain, op: Comparison, constant: number) {
  switch (op) {
    case '>=':
      if (constant > domain.min) {
        domain.min = constant
        domain.minOpen = false
      }
      break
    case '>':
      if (constant >= domain.min) {
        domain.min = constant
        domain.minOpen = true
      }
      break
    case '<=':
      if (constant < domain.max) {
        domain.max = constant
        domain.maxOpen = false
      }
      break
    case '<':
      if (constant <= domain.max) {
        domain.max = constant
        domain.maxOpen = true
      }
      break
    case '===':
      applyBound(domain, '>=', constant)
      applyBound(domain, '<=', constant)
      break
    case '!==':
      domain.excluded = constant
      break
  }
  if (domain.integer) closeIntegerEnds(domain)
}

export function applyIntegerRule(domain: NumberDomain) {
  domain.integer = true
  closeIntegerEnds(domain)
}

// -- Number value sources ---------------------------------------------------

// Non-integer range ends step inward by 1/64 px instead of by one ulp: a denormal neighbor is not a layout value.
const STEP = 1 / 64
// The span a dyadic grid and "pixel-like" random samples cover when the domain itself is larger.
const PRACTICAL_LIMIT = 2 ** 14

function lowEnd(domain: NumberDomain) {
  return domain.minOpen ? domain.min + STEP : domain.min
}

function highEnd(domain: NumberDomain) {
  return domain.maxOpen ? domain.max - STEP : domain.max
}

/** The value itself when it's in the domain, rounded toward 0 for integer domains; otherwise null. */
function admit(domain: NumberDomain, value: number): number | null {
  const snapped = domain.integer ? (value >= 0 ? Math.floor(value) : Math.ceil(value)) : value
  return numberInDomain(domain, snapped) ? snapped : null
}

function admitAll(domain: NumberDomain, raw: number[]) {
  const result: number[] = []
  for (const value of raw) {
    const admitted = admit(domain, value)
    if (admitted != null && !result.some((existing) => Object.is(existing, admitted))) result.push(admitted)
  }
  return result
}

/** Range ends and their neighbors, plus 0, -0, ±1, ±0.5 and 2. */
function edgeValues(domain: NumberDomain): number[] {
  const low = lowEnd(domain)
  const high = highEnd(domain)
  const raw = [low, high, 0, -0, 1, -1, 0.5, -0.5, 2]
  if (domain.integer) raw.push(low + 1, high - 1)
  else raw.push(low + STEP, high - STEP)
  return admitAll(domain, raw)
}

/** A dyadic grid over the practical part of the range, plus quarter steps inside each end. */
function gridValues(domain: NumberDomain): number[] {
  const low = Math.max(domain.min, -PRACTICAL_LIMIT)
  const high = Math.min(domain.max, PRACTICAL_LIMIT)
  if (!(low <= high)) return []
  const span = high - low
  const step = span === 0 ? 1 : Math.max(domain.integer ? 1 : 2 ** -6, 2 ** Math.floor(Math.log2(span / 32)))
  const raw: number[] = []
  for (let value = Math.ceil(low / step) * step; value <= high; value += step) raw.push(value)
  if (!domain.integer) for (let quarter = 1; quarter <= 4; quarter++) raw.push(low + quarter / 4, high - quarter / 4)
  return admitAll(domain, raw)
}

/** Every integer of a small integer range; otherwise edges plus the grid. */
function candidateValues(domain: NumberDomain, edges: number[], grid: number[]): number[] {
  if (domain.integer && domain.max - domain.min <= 256) {
    const result: number[] = []
    for (let value = domain.min; value <= domain.max; value++) if (value !== domain.excluded) result.push(value)
    return result
  }
  return admitAll(domain, [...edges, ...grid])
}

/** P0's small-scope values: the three lowest integers of the range, and 0, 1, 2, when they're in the domain. */
function smallValues(domain: NumberDomain): number[] {
  const start = Math.ceil(domain.min)
  const result = admitAll(domain, [start, start + 1, start + 2, 0, 1, 2])
  return result.length > 0 ? result : [lowEnd(domain)]
}

export type NumberSources = {candidates: number[]; edges: number[]; grid: number[]; small: number[]}

export function numberSources(domain: NumberDomain): NumberSources {
  const edges = edgeValues(domain)
  const grid = gridValues(domain)
  return {candidates: candidateValues(domain, edges, grid), edges, grid, small: smallValues(domain)}
}

function roundSample(random: Random, value: number) {
  const pick = nextFloat(random)
  if (pick < 0.4) return Math.round(value)
  if (pick < 0.6) return Math.round(value * 64) / 64
  if (pick < 0.7) return Math.round(value * 10) / 10
  return value
}

function sampleNumber(random: Random, domain: NumberDomain): number {
  const low = Math.max(domain.min, -PRACTICAL_LIMIT)
  const high = Math.min(domain.max, PRACTICAL_LIMIT)
  const practical = low <= high && (nextFloat(random) < 0.7 || (domain.min >= -PRACTICAL_LIMIT && domain.max <= PRACTICAL_LIMIT))
  const value = practical
    ? roundSample(random, low + nextFloat(random) * (high - low))
    : roundSample(random, domain.min + nextFloat(random) * (domain.max - domain.min))
  return admit(domain, Math.min(domain.max, Math.max(domain.min, value))) ?? lowEnd(domain)
}

/** P1-P3's draw for a leaf that isn't fixed: 20% edges, 20% grid, 60% samples. */
export function drawNumber(random: Random, domain: NumberDomain, sources: NumberSources): number {
  const pick = nextFloat(random)
  if (pick < 0.2 && sources.edges.length > 0) return sources.edges[nextIndex(random, sources.edges.length)]!
  if (pick < 0.4 && sources.grid.length > 0) return sources.grid[nextIndex(random, sources.grid.length)]!
  return sampleNumber(random, domain)
}
