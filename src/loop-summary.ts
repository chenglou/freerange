import {
  gridJoin,
  gridOfNumber,
  integerValued,
  linearNameForExpression,
  mergeOrigin,
  numberValue,
  withinGridWindow,
  type NumberValue,
} from './domain.ts'
import {
  linearAdd,
  linearConstant,
  linearScale,
  linearVariable,
} from './linear.ts'
import {
  rationalAdd,
  rationalFromNumber,
  rationalMultiply,
  rationalToNumber,
  type Rational,
} from './numeric/rational.ts'

// Closed forms for classified loop recurrences. The loop analysis in
// interpreter/loop-transfer.ts decides which recurrence a variable follows;
// these compute the post-loop value from start, iteration count, and the
// per-iteration amount.
//
// The closed form start + count * step is real arithmetic; the float
// accumulator only matches it while every partial sum stays exact (fifteen
// `+= 0.1` additions exceed fl(15 * 0.1)). Even a one-sided endpoint bound
// needs each per-step bound start + k * step to be exactly representable, so
// that fl(total + h) <= fl(bound + step) = bound + step carries the
// induction. Both are the same dyadic-grid window check, applied to the
// values for the identity and to the hull endpoints for the bounds.

// |start| + count * |step| as an exact rational; null when any piece is
// non-finite.
function sumMagnitude(startEnd: number, countMax: number, step: number): Rational | null {
  if (!Number.isFinite(startEnd) || !Number.isFinite(countMax) || !Number.isFinite(step)) return null
  const start = rationalFromNumber(Math.abs(startEnd))!
  const total = rationalMultiply(rationalFromNumber(countMax)!, rationalFromNumber(Math.abs(step))!)
  return rationalAdd(start, total)
}

function partialSumsExact(startEnd: number, countMax: number, step: number): boolean {
  const grid = gridJoin(gridOfNumber(startEnd), gridOfNumber(step))
  if (grid == null) return false
  const magnitude = sumMagnitude(startEnd, countMax, step)
  return magnitude != null && withinGridWindow(magnitude, grid)
}

// One side of the accumulator hull. The tight endpoint start + k * step holds
// when the per-step bounds stay representable; with the step pointing away
// from this side, the start endpoint is a free monotone bound (fl(t + h)
// cannot cross t when h points the other way); otherwise the side is
// unbounded.
function accumulatorBound(side: 'min' | 'max', startEnd: number, countNear: number, countFar: number, step: number): number {
  const stepTightens = side === 'max' ? step > 0 : step < 0
  const count = stepTightens ? countFar : countNear
  if (step === 0) return startEnd
  if (partialSumsExact(startEnd, countFar, step)) {
    const exact = rationalAdd(rationalFromNumber(startEnd)!, rationalMultiply(rationalFromNumber(count)!, rationalFromNumber(step)!))
    return rationalToNumber(exact)
  }
  if (!stepTightens) return startEnd
  return side === 'max' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
}

// x grows by `increment` every iteration: exact linear form when the
// increment is one known number and every partial sum is provably exact,
// per-side windowed endpoint bounds otherwise.
export function runningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const grid = gridJoin(start.grid, increment.grid)
  const countUsable = integerValued(count) && count.min >= 0 && Number.isFinite(count.max)
  const exactIncrement = increment.min === increment.max ? increment.min : null
  const valuesExact = countUsable && exactIncrement != null && grid != null
    && partialSumsExact(Math.max(Math.abs(start.min), Math.abs(start.max)), count.max, exactIncrement)
    && Number.isFinite(start.min) && Number.isFinite(start.max)
  const exactLinear = valuesExact && start.linear != null && count.linear != null
    ? linearAdd(start.linear, linearScale(count.linear, exactIncrement))
    : null
  const linear = exactLinear ?? linearVariable(linearNameForExpression(targetName))
  // An unusable count still leaves the free monotone side: a step that points
  // away from a bound cannot cross it (the infinite countFar just disables
  // the windowed tight bound).
  const countNear = Math.max(0, count.min)
  const countFar = countUsable ? count.max : Number.POSITIVE_INFINITY
  const min = accumulatorBound('min', start.min, countNear, countFar, increment.min)
  const max = accumulatorBound('max', start.max, countNear, countFar, increment.max)
  return numberValue(min, max, grid, targetName, linear, null, mergeOrigin(start, count, increment))
}

// x grows by `increment` on some iterations only: skipped iterations leave
// the value untouched (no float op at all), so the per-step bound uses the
// step clamped toward zero on each side and the exact linear form is off the
// table.
export function conditionalRunningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const countUsable = integerValued(count) && count.min >= 0 && Number.isFinite(count.max)
  const countFar = countUsable ? count.max : Number.POSITIVE_INFINITY
  const min = accumulatorBound('min', start.min, 0, countFar, Math.min(0, increment.min))
  const max = accumulatorBound('max', start.max, 0, countFar, Math.max(0, increment.max))
  return numberValue(
    min,
    max,
    gridJoin(start.grid, increment.grid),
    targetName,
    linearVariable(targetName),
    null,
    mergeOrigin(start, count, increment),
  )
}

export function runningExtremumNumber(kind: 'min' | 'max', targetName: string, start: NumberValue, count: NumberValue, candidate: NumberValue): NumberValue {
  if (count.max <= 0) {
    return numberValue(start.min, start.max, start.grid, targetName, linearVariable(linearNameForExpression(targetName)), null, start.origin)
  }

  const hasItem = count.min >= 1
  const min = kind === 'max'
    ? hasItem ? Math.max(start.min, candidate.min) : start.min
    : Math.min(start.min, candidate.min)
  const max = kind === 'max'
    ? Math.max(start.max, candidate.max)
    : hasItem ? Math.min(start.max, candidate.max) : start.max

  return numberValue(
    min,
    max,
    gridJoin(start.grid, candidate.grid),
    targetName,
    linearVariable(linearNameForExpression(targetName)),
    null,
    mergeOrigin(start, count, candidate),
  )
}

export function conditionalPushLength(arrayName: string, sourceLength: NumberValue, startLength: NumberValue = numberValue(0, 0, 0, '0', linearConstant(0))): NumberValue {
  return numberValue(startLength.min, startLength.max + sourceLength.max, 0, `${arrayName}.length`, linearVariable(linearNameForExpression(`${arrayName}.length`)))
}

// The cursor's value after a non-empty run: the running sum with the count's
// lower bound clamped to one iteration.
export function nonEmptyLoopEnd(targetName: string, start: NumberValue, advance: NumberValue, length: NumberValue): NumberValue {
  const nonEmptyLength = {...length, min: Math.max(1, length.min)}
  return runningSumNumber(targetName, start, nonEmptyLength, advance)
}

export function indexedElementPathValue(expr: string, sourceLength: NumberValue): NumberValue {
  return numberValue(
    0,
    Math.max(0, sourceLength.max - 1),
    0,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}
