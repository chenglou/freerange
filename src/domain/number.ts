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
  // Zero is cut out of an interval that otherwise straddles it — set by a `count !== 0`
  // guard (or an `if (count === 0) return` early exit) when zero sits strictly inside the
  // bounds, where no interval endpoint can express the cut. Division is the only consumer:
  // a guarded divisor mints no nonzero requirement. Absent means "may be zero", so every
  // arithmetic producer is conservative by construction (x - x can be zero from nonzero
  // operands); only branch refinement sets the flag, and joins keep it only when both
  // sides exclude zero. Unlike lossSite below, this is semantics: sameNumbers compares it.
  excludesZero?: boolean
  // Annotation only, never semantics: the operation where finiteness or NaN-freedom was
  // first lost, for the report's blame suffix. Deliberately excluded from sameNumbers and
  // never branched on by the engine — if it participated in equality, two semantically
  // identical values re-derived through different operations would look changed at loop
  // headers and disturb fixed points. Joins keep the left side's site when both carry one;
  // blame is best-effort prose, not a guarantee.
  lossSite?: SiteID
}

const float64Scratch = new Float64Array(1)
const bitsScratch = new BigInt64Array(float64Scratch.buffer)

// The adjacent representable double above the value — the exact refinement for a strict
// float comparison: runtime x > b implies x >= nextUp(b), and no double sits between them.
export function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Infinity) return value
  if (value === 0) return Number.MIN_VALUE
  float64Scratch[0] = value
  bitsScratch[0] = bitsScratch[0]! + (value > 0 ? 1n : -1n)
  return float64Scratch[0]
}

export function nextDown(value: number): number {
  return -nextUp(-value)
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

// Addition does not collapse on possibly-infinite operands the way multiplication and
// division must: the only NaN case is opposite-signed infinities meeting, so with NaN-free
// operands the bounds stay real. Infinity + finite is Infinity — `(a + b) + c` with finite
// inputs can overflow, never turn NaN. An endpoint sum that IS NaN (the interval corners
// mix -Infinity and +Infinity) saturates to that direction's extreme, which over-covers
// the corner soundly.
export function addNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  const lower = left.lower + right.lower
  const upper = left.upper + right.upper
  const oppositeInfinities =
    (left.upper === Number.POSITIVE_INFINITY && right.lower === Number.NEGATIVE_INFINITY)
    || (left.lower === Number.NEGATIVE_INFINITY && right.upper === Number.POSITIVE_INFINITY)
  return {
    kind: 'number',
    lower: Number.isNaN(lower) ? Number.NEGATIVE_INFINITY : lower,
    upper: Number.isNaN(upper) ? Number.POSITIVE_INFINITY : upper,
    integer: left.integer && right.integer,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN || oppositeInfinities,
  }
}

// a - b is a + (-b); negation is exact on every value including infinities.
export function subtractNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return addNumbers(left, {
    kind: 'number',
    lower: -right.upper,
    upper: -right.lower,
    integer: right.integer,
    mayBeNaN: right.mayBeNaN,
  })
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
  // A possibly-infinite dividend over a finite nonzero NaN-free divisor stays exact:
  // the division's NaN corners are 0/0 and Infinity/Infinity, and this divisor rules both
  // out, so e.g. a frame delta that can overflow divided by a step constant is possibly
  // non-finite, never NaN. The quotient corners are monotone (Infinity / 4 is Infinity) —
  // but ONLY over a one-signed divisor interval; a divisor straddling zero with zero
  // excluded by a guard takes the zero-cut path instead, since its corner quotients would
  // exclude the blow-up near zero.
  if (!left.mayBeNaN && !right.mayBeNaN && isFiniteNumber(right)) {
    if (right.lower > 0 || right.upper < 0) {
      const quotients = [
        left.lower / right.lower,
        left.lower / right.upper,
        left.upper / right.lower,
        left.upper / right.upper,
      ]
      return {
        kind: 'number',
        lower: Math.min(...quotients),
        upper: Math.max(...quotients),
        integer: false,
        mayBeNaN: false,
      }
    }
    if (right.excludesZero === true) return divideAcrossZero(left, right)
  }
  if (!safeOperands(left, right) || (right.lower <= 0 && right.upper >= 0)) return unknownNumber()
  const quotients = [
    left.lower / right.lower,
    left.lower / right.upper,
    left.upper / right.lower,
    left.upper / right.upper,
  ]
  return boundedResult(Math.min(...quotients), Math.max(...quotients), false, left, right)
}

// A divisor interval straddling zero with zero itself excluded — by a `!== 0` guard (the
// excludesZero flag) or a recorded nonzero requirement. An integer divisor then has
// magnitude at least 1, so the quotient is bounded by the dividend; a float divisor can
// sit arbitrarily close to zero, so the quotient can overflow — possibly non-finite, but
// never NaN (zero is cut, so 0/0 cannot happen).
function divideAcrossZero(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
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
  return divideAcrossZero(left, right)
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
  return value.lower <= 0 && value.upper >= 0 && value.excludesZero !== true
}

export function joinNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  const joined: AbstractNumber = {
    kind: 'number',
    lower: Math.min(left.lower, right.lower),
    upper: Math.max(left.upper, right.upper),
    integer: left.integer && right.integer,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN,
  }
  // Zero stays excluded when neither side can be zero — whether by flag or by one-signed
  // bounds, which is why the check goes through includesZero. This also captures a
  // sign-split join: [-5, -2] joined with [2, 5] straddles zero yet never holds it.
  if (!includesZero(left) && !includesZero(right) && joined.lower < 0 && joined.upper > 0) {
    joined.excludesZero = true
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
    && (left.excludesZero === true) === (right.excludesZero === true)
}

export function widenNumber(previous: AbstractNumber, next: AbstractNumber): AbstractNumber {
  const finite = isFiniteNumber(previous) && isFiniteNumber(next)
  const widened: AbstractNumber = {
    ...next,
    lower: next.lower < previous.lower
      ? finite ? -Number.MAX_VALUE : Number.NEGATIVE_INFINITY
      : next.lower,
    upper: next.upper > previous.upper
      ? finite ? Number.MAX_VALUE : Number.POSITIVE_INFINITY
      : next.upper,
  }
  // The spread copies next's flag, but the widened interval is a fresh, wider cover — the
  // flag holds only when both rounds excluded zero, same rule as joins. It can flip
  // true-to-false across rounds and never back, so the fixed point still converges.
  widened.excludesZero = !includesZero(previous) && !includesZero(next)
    && widened.lower < 0 && widened.upper > 0
  return widened
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

export function unknownNumber(): AbstractNumber {
  return {
    kind: 'number',
    lower: Number.NEGATIVE_INFINITY,
    upper: Number.POSITIVE_INFINITY,
    integer: false,
    mayBeNaN: true,
  }
}
