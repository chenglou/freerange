import {
  addNumbers,
  linearNameForExpression,
  mergeOrigin,
  multiplyNumbers,
  nonNanExtrema,
  numberValue,
  type NumberValue,
} from './domain.ts'
import {
  linearAdd,
  linearConstant,
  linearScale,
  linearVariable,
} from './linear.ts'

// Closed forms for classified loop recurrences. The loop analysis in
// interpreter/loop-transfer.ts decides which recurrence a variable follows;
// these compute the post-loop value from start, iteration count, and the
// per-iteration amount.

// x grows by `increment` every iteration: exact linear form when the increment
// is one known number, interval bounds otherwise.
export function runningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const exactIncrement = increment.min === increment.max ? increment.min : null
  const exactLinear = exactIncrement == null || start.linear == null || count.linear == null
    ? null
    : linearAdd(start.linear, linearScale(count.linear, exactIncrement))
  const linear = exactLinear ?? linearVariable(linearNameForExpression(targetName))
  const delta = multiplyNumbers(count, increment)
  const result = addNumbers(start, delta)
  return numberValue(
    result.min,
    result.max,
    start.isInteger && count.isInteger && increment.isInteger,
    targetName,
    linear,
    null,
    mergeOrigin(start, count, increment),
  )
}

// x grows by `increment` on some iterations only, so the total delta hull must
// include zero and the exact linear form is off the table.
export function conditionalRunningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const deltaBounds = nonNanExtrema([
    0,
    count.max * increment.min,
    count.max * increment.max,
  ])
  const delta = numberValue(deltaBounds.min, deltaBounds.max, count.isInteger && increment.isInteger, null, null, null, mergeOrigin(count, increment))
  const result = addNumbers(start, delta)
  return numberValue(
    result.min,
    result.max,
    start.isInteger && count.isInteger && increment.isInteger,
    targetName,
    linearVariable(targetName),
    null,
    mergeOrigin(start, count, increment),
  )
}

export function runningExtremumNumber(kind: 'min' | 'max', targetName: string, start: NumberValue, count: NumberValue, candidate: NumberValue): NumberValue {
  if (count.max <= 0) {
    return numberValue(start.min, start.max, start.isInteger, targetName, linearVariable(linearNameForExpression(targetName)), null, start.origin)
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
    start.isInteger && candidate.isInteger,
    targetName,
    linearVariable(linearNameForExpression(targetName)),
    null,
    mergeOrigin(start, count, candidate),
  )
}

export function conditionalPushLength(arrayName: string, sourceLength: NumberValue, startLength: NumberValue = numberValue(0, 0, true, '0', linearConstant(0))): NumberValue {
  return numberValue(startLength.min, startLength.max + sourceLength.max, true, `${arrayName}.length`, linearVariable(linearNameForExpression(`${arrayName}.length`)))
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
    true,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}
