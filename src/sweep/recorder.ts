// The object instrumented files call, installed as `globalThis.__fr` in a child before any instrumented module loads.
// It keeps, per site, the highest level reached during one call of an entry:
//   0 not reached
//   1 reached and held
//   2 a numeric comparison missed by a tiny amount, 0 < violation <= 1e-9, e.g. `a <= b` failing by 1.1e-13
//   3 a strict comparison failed with equal operands, e.g. `index < endIndex` with index === endIndex
//   4 any other failure: a NaN operand, a violation above 1e-9, a false int or bool site, a false `!==`
// noise@none fires at level >= 2, noise@abs1e-9 at >= 3, noise@abs1e-9-literal at 4 (types.ts RULE_THRESHOLDS).
// A firing site in the current entry's discard set (its own leading asserts, and pass-through callee requirements under
// domain@v2) throws DISCARD: the input is outside the entry's domain.
// Every loop body calls tick() first (instrument.ts). A call whose loop bodies run more than the step budget in total,
// callees included, throws BUDGET: e.g. with a budget of 1,000, `gridLayout(5000, …)` stops at its 1,001st cell.
import type {Site} from './types.ts'

export const DISCARD = {sentinel: 'discard'}
export const BUDGET = {sentinel: 'budget'}

export type Recorder = {
  levels: Uint8Array
  margins: Float64Array // the violation at the site's highest level in this call, NaN when unknown
  touched: Uint16Array // sites reached in this call, touchedCount of them
  touchedCount: number
  ticks: number // loop body entries in this call
  setEntry: (discardSites: number[]) => void
  cmp: (site: number, left: unknown, op: string, right: unknown) => void
  int: (site: number, value: unknown) => void
  bool: (site: number, condition: unknown) => void
  tick: () => void
}

/** `stepBudget` null: no budget, loops run to completion. */
export function createRecorder(sites: Site[], stepBudget: number | null): Recorder {
  const discard = new Uint8Array(sites.length)
  const budget = stepBudget ?? Infinity
  const recorder: Recorder = {
    levels: new Uint8Array(sites.length),
    margins: new Float64Array(sites.length),
    touched: new Uint16Array(sites.length),
    touchedCount: 0,
    ticks: 0,
    setEntry(discardSites) {
      discard.fill(0)
      for (const site of discardSites) discard[site] = 1
    },
    tick() {
      recorder.ticks += 1
      if (recorder.ticks > budget) throw BUDGET
    },
    cmp(site, left, op, right) {
      let ok: boolean
      switch (op) {
        case '<': ok = (left as number) < (right as number); break
        case '<=': ok = (left as number) <= (right as number); break
        case '>': ok = (left as number) > (right as number); break
        case '>=': ok = (left as number) >= (right as number); break
        case '===': ok = left === right; break
        case '!==': ok = left !== right; break
        // oxlint-disable-next-line eqeqeq
        case '==': ok = left == right; break
        // oxlint-disable-next-line eqeqeq
        default: ok = left != right
      }
      if (ok) {
        reach(site, 1, NaN)
        return
      }
      if (typeof left !== 'number' || typeof right !== 'number' || op === '!==' || op === '!=' || Number.isNaN(left) || Number.isNaN(right)) {
        reach(site, 4, NaN)
        return
      }
      if (left === right) {
        reach(site, 3, 0)
        return
      }
      const margin = op === '<' || op === '<=' ? left - right : op === '>' || op === '>=' ? right - left : Math.abs(left - right)
      reach(site, margin <= 1e-9 ? 2 : 4, margin)
    },
    int(site, value) {
      if (Number.isInteger(value)) {
        reach(site, 1, NaN)
        return
      }
      reach(site, 4, typeof value === 'number' && Number.isFinite(value) ? Math.abs(value - Math.round(value)) : NaN)
    },
    bool(site, condition) {
      const held = Boolean(condition)
      reach(site, held ? 1 : 4, NaN)
    },
  }
  function reach(site: number, level: number, margin: number) {
    const previous = recorder.levels[site]!
    if (previous === 0) recorder.touched[recorder.touchedCount++] = site
    if (level > previous) {
      recorder.levels[site] = level
      recorder.margins[site] = margin
    }
    if (level >= 2 && discard[site] === 1) throw DISCARD
  }
  return recorder
}

export function resetRecorder(recorder: Recorder) {
  for (let index = 0; index < recorder.touchedCount; index++) recorder.levels[recorder.touched[index]!] = 0
  recorder.touchedCount = 0
  recorder.ticks = 0
}
