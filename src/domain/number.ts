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
  // One point cut out of an interval that otherwise contains it strictly inside — set by
  // a `count !== 0` or `width !== 4` guard (or the matching === early exit), where no
  // interval endpoint can express the cut. Division consumes the point-zero exclusion
  // directly, and the arithmetic rules below FORWARD an exclusion into a zero exclusion
  // through the same float-exact inversions requirement peeling trusts: width ≠ 4 makes
  // width - 4 ≠ 0, so the guard a peeled requires line names actually discharges it.
  // Absent means "no point excluded"; producers stay conservative by construction (x - x
  // can be zero from nonzero operands) except for those exact rules, and joins keep a
  // point only when both sides exclude it. Unlike the report sites below, this is semantics:
  // sameNumbers compares it. One point, not a set — the deliberate cap.
  excludesPoint?: number
  // Annotation only, never semantics: where finiteness and NaN-freedom were first lost,
  // kept separately so a later NaN-producing operation is not blamed on an earlier
  // overflow. Deliberately excluded from sameNumbers and never branched on by the engine.
  nonFiniteSite?: SiteID
  nanSite?: SiteID
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

// The values that pass Number.isFinite. Null means the input has no finite value.
export function finiteNumberPart(value: AbstractNumber): AbstractNumber | null {
  const lower = Math.max(value.lower, -Number.MAX_VALUE)
  const upper = Math.min(value.upper, Number.MAX_VALUE)
  return lower <= upper ? {...value, lower, upper, mayBeNaN: false} : null
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
  const result: AbstractNumber = {
    kind: 'number',
    lower: Number.isNaN(lower) ? Number.NEGATIVE_INFINITY : lower,
    upper: Number.isNaN(upper) ? Number.POSITIVE_INFINITY : upper,
    integer: left.integer && right.integer,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN || oppositeInfinities,
  }
  // The forward direction of requirement peeling: an IEEE sum is zero only when the
  // operands are exact negations, so x ≠ -c makes x + c ≠ 0 — the `width !== 4` guard a
  // peeled requires line names flows through `width - 4` and discharges the division
  // (subtraction arrives here with the right side negated).
  const pointSide = right.lower === right.upper && !right.mayBeNaN ? right
    : left.lower === left.upper && !left.mayBeNaN ? left : null
  const otherSide = pointSide === right ? left : right
  if (pointSide != null && pointExcluded(otherSide, -pointSide.lower)
    && result.lower < 0 && result.upper > 0) {
    result.excludesPoint = 0
  }
  return result
}

// a - b is a + (-b); negation is exact on every value including infinities.
export function subtractNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  const negated: AbstractNumber = {
    kind: 'number',
    lower: -right.upper,
    upper: -right.lower,
    integer: right.integer,
    mayBeNaN: right.mayBeNaN,
  }
  // Negation is exact, so an excluded point flips sign with the value.
  if (right.excludesPoint != null) negated.excludesPoint = -right.excludesPoint
  return addNumbers(left, negated)
}

export function multiplyNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  if (!safeOperands(left, right)) return unknownNumber()
  const products = [
    left.lower * right.lower,
    left.lower * right.upper,
    left.upper * right.lower,
    left.upper * right.upper,
  ]
  const result = boundedResult(Math.min(...products), Math.max(...products), left.integer && right.integer, left, right)
  // A factor of magnitude at least 1 cannot underflow a nonzero product to zero (|c·x| >=
  // |x|, and no double below the smallest subnormal exists to round to), so a zero
  // exclusion survives: `scale !== 0` discharges a division by scale * 2. The same
  // condition requirement peeling trusts, run forward.
  const pointSide = right.lower === right.upper && !right.mayBeNaN ? right
    : left.lower === left.upper && !left.mayBeNaN ? left : null
  const otherSide = pointSide === right ? left : right
  if (pointSide != null && Number.isFinite(pointSide.lower) && Math.abs(pointSide.lower) >= 1
    && pointExcluded(otherSide, 0) && !result.mayBeNaN
    && result.lower < 0 && result.upper > 0) {
    result.excludesPoint = 0
  }
  return result
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
    if (right.excludesPoint === 0) return divideAcrossZero(left, right)
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
// excluded-point cut) or a recorded nonzero requirement. An integer divisor then has
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

// ceil, round, and trunc are monotone and exact on infinities, like floor; all three
// produce integers and carry NaN through. (Math.round's half-up tie rule sits between
// floor and ceil, so the monotone endpoint images cover it.)
export function roundedNumber(operator: 'ceil' | 'round' | 'trunc', value: AbstractNumber): AbstractNumber {
  const apply = operator === 'ceil' ? Math.ceil : operator === 'round' ? Math.round : Math.trunc
  return {
    kind: 'number',
    lower: apply(value.lower),
    upper: apply(value.upper),
    integer: true,
    mayBeNaN: value.mayBeNaN,
  }
}

// Monotone over non-negative inputs; a negative operand yields NaN, so an interval
// reaching below zero clips to the non-negative part and turns the NaN flag on. sqrt
// never overflows and sqrt(Infinity) is Infinity, so the endpoint images are exact.
export function squareRootNumber(value: AbstractNumber): AbstractNumber {
  const mayBeNegative = value.lower < 0
  const clippedLower = Math.max(value.lower, 0)
  if (value.upper < 0) {
    // The result is always NaN, and the domain has no NaN-only value: bounds must be
    // real numbers, or every consumer of Math.min/Math.max over them (joins, clamps,
    // branch refinement) silently turns its own bounds into NaN — literal NaN bounds
    // here used to print `from NaN through NaN` while the function returned 0. The
    // honest cover is the claim-free full range with the NaN flag on.
    return unknownNumber()
  }
  return {
    kind: 'number',
    lower: Math.sqrt(clippedLower),
    upper: Math.sqrt(value.upper),
    integer: false,
    mayBeNaN: value.mayBeNaN || mayBeNegative,
  }
}

// JS remainder: the result's sign follows the dividend, its magnitude stays below both
// |dividend| and |divisor|, and it is NaN exactly when the dividend is infinite or the
// divisor is zero (or either is NaN). With the divisor's nonzero requirement recorded and
// a finite dividend, the result is genuinely finite and NaN-free.
export function remainderNumbers(left: AbstractNumber, right: AbstractNumber, divisorNonzero: boolean): AbstractNumber {
  if (left.mayBeNaN || right.mayBeNaN) return unknownNumber()
  const divisorMayBeZero = !divisorNonzero && includesZero(right)
  const dividendMayBeInfinite = !isFiniteNumber(left)
  // |r| < |b| tightens to |b| - 1 for integer operands — but ONLY on the divisor side:
  // against the dividend the exact bound is |r| <= |a| with no subtraction, because when
  // |a| < |b| the remainder IS the dividend (2 % 3 is 2; a review round caught the -1
  // applied to the wrong side publishing 'at most 1').
  const dividendMagnitude = Math.max(Math.abs(left.lower), Math.abs(left.upper))
  const divisorMagnitude = Math.max(Math.abs(right.lower), Math.abs(right.upper))
  const integer = left.integer && right.integer
  const divisorBound = integer && Number.isFinite(divisorMagnitude)
    ? Math.max(divisorMagnitude - 1, 0)
    : divisorMagnitude
  const bound = Math.min(dividendMagnitude, divisorBound)
  return {
    kind: 'number',
    lower: left.lower < 0 ? (Number.isFinite(bound) ? -bound : Number.NEGATIVE_INFINITY) : 0,
    upper: left.upper > 0 ? (Number.isFinite(bound) ? bound : Number.POSITIVE_INFINITY) : 0,
    integer,
    mayBeNaN: divisorMayBeZero || dividendMayBeInfinite,
  }
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
  return value.lower <= 0 && value.upper >= 0 && value.excludesPoint !== 0
}

export function isDefinitelyZero(value: AbstractNumber): boolean {
  return value.lower === 0
    && value.upper === 0
    && !value.mayBeNaN
    && value.excludesPoint !== 0
}

// Whether the abstract value provably never holds the point — by its bounds, by the
// integer flag against a fractional point, or by the excluded-point cut.
export function pointExcluded(value: AbstractNumber, point: number): boolean {
  if (point < value.lower || point > value.upper) return true
  // `integer` describes every finite inhabitant; the interval may still include an
  // infinity introduced by overflow. Only a finite fractional point is impossible.
  if (value.integer && Number.isFinite(point) && !Number.isInteger(point)) return true
  return value.excludesPoint === point
}

// A joined or widened interval may keep one hole only when both inputs exclude it. Zero
// is always considered because division cares about it even when neither input needed an
// explicit cut before their disjoint ranges were combined.
function sharedExcludedPoint(left: AbstractNumber, right: AbstractNumber, lower: number, upper: number): number | null {
  for (const point of [left.excludesPoint, right.excludesPoint, 0]) {
    if (point == null) continue
    if (pointExcluded(left, point) && pointExcluded(right, point) && lower < point && point < upper) return point
  }
  return null
}

export function joinNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  const joined: AbstractNumber = {
    kind: 'number',
    lower: Math.min(left.lower, right.lower),
    upper: Math.max(left.upper, right.upper),
    integer: left.integer && right.integer,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN,
  }
  // A point stays excluded when neither side can hold it — whether by cut or by bounds,
  // which is what pointExcluded checks. This also captures a sign-split join: [-5, -2]
  // joined with [2, 5] straddles zero yet never holds it (zero is tried even when neither
  // side carries a cut, since it is the point division cares about).
  const excludesPoint = sharedExcludedPoint(left, right, joined.lower, joined.upper)
  if (excludesPoint != null) joined.excludesPoint = excludesPoint
  const nonFiniteSite = (!isFiniteNumber(left) ? left.nonFiniteSite : undefined)
    ?? (!isFiniteNumber(right) ? right.nonFiniteSite : undefined)
  if (!isFiniteNumber(joined) && nonFiniteSite != null) joined.nonFiniteSite = nonFiniteSite
  const nanSite = (left.mayBeNaN ? left.nanSite : undefined)
    ?? (right.mayBeNaN ? right.nanSite : undefined)
  if (joined.mayBeNaN && nanSite != null) joined.nanSite = nanSite
  return joined
}

export function sameNumbers(left: AbstractNumber, right: AbstractNumber): boolean {
  return left.lower === right.lower
    && left.upper === right.upper
    && left.integer === right.integer
    && left.mayBeNaN === right.mayBeNaN
    && left.excludesPoint === right.excludesPoint
}

export function widenNumber(previous: AbstractNumber, next: AbstractNumber): AbstractNumber {
  const finite = isFiniteNumber(previous) && isFiniteNumber(next)
  const widened: AbstractNumber = {
    kind: 'number',
    lower: next.lower < previous.lower
      ? finite ? -Number.MAX_VALUE : Number.NEGATIVE_INFINITY
      : next.lower,
    upper: next.upper > previous.upper
      ? finite ? Number.MAX_VALUE : Number.POSITIVE_INFINITY
      : next.upper,
    integer: next.integer,
    mayBeNaN: next.mayBeNaN,
  }
  if (!isFiniteNumber(widened) && next.nonFiniteSite != null) widened.nonFiniteSite = next.nonFiniteSite
  if (widened.mayBeNaN && next.nanSite != null) widened.nanSite = next.nanSite
  // The widened interval is a fresh, wider cover — a point stays excluded only when both
  // rounds excluded it, same rule as joins. The cut can disappear across rounds and never
  // reappear, so the fixed point still converges.
  const excludesPoint = sharedExcludedPoint(previous, next, widened.lower, widened.upper)
  if (excludesPoint != null) widened.excludesPoint = excludesPoint
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
