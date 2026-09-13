// The object instrumented files call, installed as `globalThis.__fr` in a child before any instrumented module loads.
// It keeps, per site, the highest level reached during one call of an entry:
//   0 not reached
//   1 reached and held
//   2 a numeric comparison missed by a tiny amount, 0 < violation <= 1e-9, e.g. `a <= b` failing by 1.1e-13
//   3 a strict comparison failed with equal operands, e.g. `index < endIndex` with index === endIndex
//   4 any other failure: a NaN operand, a violation above 1e-9, a false int or bool site, a false `!==`
// noise@none fires at level >= 2, noise@abs1e-9 at >= 3, noise@abs1e-9-literal at 4 (types.ts RULE_THRESHOLDS).
// A failing leading assert of the entry being called throws DISCARD: the input is outside the entry's domain.
import type {Site} from './types.ts'

export const DISCARD = {sentinel: 'discard'}

export type Recorder = {
  levels: Uint8Array
  margins: Float64Array // the violation at the site's highest level in this call, NaN when unknown
  touched: Uint16Array // sites reached in this call, touchedCount of them
  touchedCount: number
  entry: string
  cmp: (site: number, left: unknown, op: string, right: unknown) => void
  int: (site: number, value: unknown) => void
  bool: (site: number, condition: unknown) => void
}

export function createRecorder(sites: Site[]): Recorder {
  const leading = new Uint8Array(sites.length)
  const functions: (string | null)[] = []
  for (const site of sites) {
    leading[site.index] = site.leading ? 1 : 0
    functions[site.index] = site.functionName
  }
  const recorder: Recorder = {
    levels: new Uint8Array(sites.length),
    margins: new Float64Array(sites.length),
    touched: new Uint16Array(sites.length),
    touchedCount: 0,
    entry: '',
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
    if (level >= 2 && leading[site] === 1 && functions[site] === recorder.entry) throw DISCARD
  }
  return recorder
}

export function resetRecorder(recorder: Recorder) {
  for (let index = 0; index < recorder.touchedCount; index++) recorder.levels[recorder.touched[index]!] = 0
  recorder.touchedCount = 0
}
