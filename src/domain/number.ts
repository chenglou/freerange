import type {SiteID} from '../ir/ids.ts'
export type AbstractNumber = {
  kind: 'number'
  // The bounds carry finiteness by construction: a value that can be ±Infinity has that
  // infinity as a bound (every producer keeps the invariant, so a "finite" flag would only
  // be a hand-maintained copy of Number.isFinite over the bounds — use isFiniteNumber).
  lower: number
  upper: number
  integer: boolean
  mayBeNaN: boolean
  // Annotation only, never semantics: the operation where finiteness or NaN-freedom was
  // first lost, for the report's blame suffix. Deliberately excluded from sameNumbers and
  // never branched on by the engine — if it participated in equality, two semantically
  // identical values re-derived through different operations would look changed at loop
  // headers and disturb fixed points. Joins keep the left side's site when both carry one;
  // blame is best-effort prose, not a guarantee.
  lossSite?: SiteID
}

export function isFiniteNumber(value: AbstractNumber): boolean {
  return Number.isFinite(value.lower) && Number.isFinite(value.upper)
}

export function finiteInputNumber(): AbstractNumber {
  return {
    kind: 'number',
    lower: -Number.MAX_VALUE,
    upper: Number.MAX_VALUE,
    integer: false,
    mayBeNaN: false,
  }
}

export function constantNumber(value: number): AbstractNumber {
  return {
    kind: 'number',
    lower: value,
    upper: value,
    integer: Number.isInteger(value),
    mayBeNaN: Number.isNaN(value),
  }
}

export function addNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return boundedResult(
    left.lower + right.lower,
    left.upper + right.upper,
    left.integer && right.integer,
    left,
    right,
  )
}

export function subtractNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return boundedResult(
    left.lower - right.upper,
    left.upper - right.lower,
    left.integer && right.integer,
    left,
    right,
  )
}

export function multiplyNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  if (!safeOperands(left, right)) return unknownNumber()
  const products = [
    left.lower * right.lower,
    left.lower * right.upper,
    left.upper * right.lower,
    left.upper * right.upper,
  ]
  return boundedResult(Math.min(...products), Math.max(...products), left.integer && right.integer, left, right)
}

export function divideNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  if (!safeOperands(left, right) || includesZero(right)) return unknownNumber()
  const quotients = [
    left.lower / right.lower,
    left.lower / right.upper,
    left.upper / right.lower,
    left.upper / right.upper,
  ]
  return boundedResult(Math.min(...quotients), Math.max(...quotients), false, left, right)
}

// floor, abs, min, and max are exact on infinities (no rounding, no overflow, no NaN
// creation), so unlike the arithmetic operators they keep their bounds instead of
// collapsing to unknown. This is what lets a clamp recover a finite range from a possibly
// overflowed input: Math.max(0, Math.min(x, 100)) is 0..100 even when x may be Infinity.
// NaN is never recovered — Math.min(NaN, 100) is NaN — so the flag just carries through.
export function floorNumber(value: AbstractNumber): AbstractNumber {
  return {
    kind: 'number',
    lower: Math.floor(value.lower),
    upper: Math.floor(value.upper),
    integer: true,
    mayBeNaN: value.mayBeNaN,
  }
}

// Division once a nonzero requirement has been recorded for the divisor: the divisor's
// range with zero cut out. An integer divisor then has magnitude at least 1, so the
// quotient is bounded by the dividend's magnitude — genuinely finite. A non-integer
// divisor can still be arbitrarily close to zero, so the quotient can overflow; the
// result is possibly non-finite but never NaN (a finite dividend over a nonzero finite
// divisor has no NaN case).
export function divideNumbersNonzeroDivisor(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  if (!safeOperands(left, right)) return unknownNumber()
  if (!includesZero(right)) return divideNumbers(left, right)
  if (!right.integer) {
    return {kind: 'number', lower: -Infinity, upper: Infinity, integer: false, mayBeNaN: false}
  }
  const negativePart: AbstractNumber = {...right, upper: Math.min(right.upper, -1)}
  const positivePart: AbstractNumber = {...right, lower: Math.max(right.lower, 1)}
  const parts = [negativePart, positivePart].filter(part => part.lower <= part.upper)
  const quotients = parts.flatMap(part => [
    left.lower / part.lower,
    left.lower / part.upper,
    left.upper / part.lower,
    left.upper / part.upper,
  ])
  if (quotients.length === 0) return unknownNumber()
  return boundedResult(Math.min(...quotients), Math.max(...quotients), false, left, right)
}

export function absoluteNumber(value: AbstractNumber): AbstractNumber {
  const lower = value.lower >= 0 ? value.lower : value.upper <= 0 ? -value.upper : 0
  return {
    kind: 'number',
    lower,
    upper: Math.max(-value.lower, value.upper),
    integer: value.integer,
    mayBeNaN: value.mayBeNaN,
  }
}

export function minimumNumbers(values: AbstractNumber[]): AbstractNumber {
  if (values.length === 0) return unknownNumber()
  return {
    kind: 'number',
    lower: Math.min(...values.map(value => value.lower)),
    upper: Math.min(...values.map(value => value.upper)),
    integer: values.every(value => value.integer),
    mayBeNaN: values.some(value => value.mayBeNaN),
  }
}

export function maximumNumbers(values: AbstractNumber[]): AbstractNumber {
  if (values.length === 0) return unknownNumber()
  return {
    kind: 'number',
    lower: Math.max(...values.map(value => value.lower)),
    upper: Math.max(...values.map(value => value.upper)),
    integer: values.every(value => value.integer),
    mayBeNaN: values.some(value => value.mayBeNaN),
  }
}

export function includesZero(value: AbstractNumber): boolean {
  return value.lower <= 0 && value.upper >= 0
}

export function joinNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  const joined: AbstractNumber = {
    kind: 'number',
    lower: Math.min(left.lower, right.lower),
    upper: Math.max(left.upper, right.upper),
    integer: left.integer && right.integer,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN,
  }
  const lossSite = left.lossSite ?? right.lossSite
  if (lossSite != null) joined.lossSite = lossSite
  return joined
}

export function sameNumbers(left: AbstractNumber, right: AbstractNumber): boolean {
  return left.lower === right.lower
    && left.upper === right.upper
    && left.integer === right.integer
    && left.mayBeNaN === right.mayBeNaN
}

export function widenNumber(previous: AbstractNumber, next: AbstractNumber): AbstractNumber {
  const finite = isFiniteNumber(previous) && isFiniteNumber(next)
  return {
    ...next,
    lower: next.lower < previous.lower
      ? finite ? -Number.MAX_VALUE : Number.NEGATIVE_INFINITY
      : next.lower,
    upper: next.upper > previous.upper
      ? finite ? Number.MAX_VALUE : Number.POSITIVE_INFINITY
      : next.upper,
  }
}

function boundedResult(
  lower: number,
  upper: number,
  integer: boolean,
  left: AbstractNumber,
  right: AbstractNumber,
): AbstractNumber {
  // With a possibly non-finite or NaN operand, the bound arithmetic itself is meaningless
  // (Infinity - Infinity is NaN), so the result collapses to unknown. With clean operands
  // the bounds are trustworthy even when they overflow to ±Infinity — overflow produces an
  // infinity at runtime, never a NaN, so the result stays NaN-free.
  if (!safeOperands(left, right)) return unknownNumber()
  return {kind: 'number', lower, upper, integer, mayBeNaN: false}
}

function safeOperands(left: AbstractNumber, right: AbstractNumber): boolean {
  return isFiniteNumber(left) && isFiniteNumber(right) && !left.mayBeNaN && !right.mayBeNaN
}

function unknownNumber(): AbstractNumber {
  return {
    kind: 'number',
    lower: Number.NEGATIVE_INFINITY,
    upper: Number.POSITIVE_INFINITY,
    integer: false,
    mayBeNaN: true,
  }
}
