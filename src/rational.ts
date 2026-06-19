// Exact rational arithmetic for linear-proof coefficients. Every finite JS
// number is an exact rational (significand times a power of two), so converting
// in is lossless; converting out can round and callers must say so explicitly.
// No epsilon anywhere: a proof layer that drops "small" terms can certify false
// contracts (1e-10 * x with x up to 1e12 is 100, not 0).

export type Rational = {
  num: bigint
  den: bigint
}

export const rationalZero: Rational = {num: 0n, den: 1n}
export const rationalOne: Rational = {num: 1n, den: 1n}

// Finite floats convert exactly; Infinity/NaN have no rational value.
export function rationalFromNumber(value: number): Rational | null {
  if (!Number.isFinite(value)) return null
  let scaled = value
  let den = 1n
  while (!Number.isInteger(scaled)) {
    scaled *= 2
    den *= 2n
  }
  return normalize(BigInt(scaled), den)
}

export function rationalToNumber(value: Rational): number {
  const quotient = Number(value.num) / Number(value.den)
  if (Number.isFinite(quotient)) return quotient
  // Magnitudes beyond float range: divide in bigint space first.
  return Number(value.num / value.den)
}

// True when converting to a float and back loses nothing.
export function rationalIsExactNumber(value: Rational): boolean {
  const converted = rationalFromNumber(rationalToNumber(value))
  return converted != null && rationalEquals(value, converted)
}

// Largest double <= the rational: the safe direction for a published lower
// bound. rationalToNumber alone rounds to nearest, which can overstate a
// lower bound by up to an ulp.
export function rationalToNumberFloor(value: Rational): number {
  let result = rationalToNumber(value)
  while (doubleComparesToRational(result, value) > 0) result = nextDoubleDown(result)
  return result
}

// Smallest double >= the rational: the safe direction for a published upper
// bound.
export function rationalToNumberCeil(value: Rational): number {
  let result = rationalToNumber(value)
  while (doubleComparesToRational(result, value) < 0) result = nextDoubleUp(result)
  return result
}

function doubleComparesToRational(double: number, value: Rational): number {
  if (double === Number.NEGATIVE_INFINITY) return -1
  if (double === Number.POSITIVE_INFINITY) return 1
  return rationalCompare(rationalFromNumber(double)!, value)
}

const doubleScratch = new Float64Array(1)
const doubleScratchBits = new BigUint64Array(doubleScratch.buffer)

export function nextDoubleDown(value: number): number {
  if (value === Number.NEGATIVE_INFINITY) return value
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_VALUE
  if (value === 0) return -Number.MIN_VALUE
  doubleScratch[0] = value
  doubleScratchBits[0] = doubleScratchBits[0]! + (value > 0 ? -1n : 1n)
  return doubleScratch[0]!
}

export function nextDoubleUp(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return value
  if (value === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE
  if (value === 0) return Number.MIN_VALUE
  doubleScratch[0] = value
  doubleScratchBits[0] = doubleScratchBits[0]! + (value > 0 ? 1n : -1n)
  return doubleScratch[0]!
}

export function rationalAdd(left: Rational, right: Rational): Rational {
  return normalize(left.num * right.den + right.num * left.den, left.den * right.den)
}

export function rationalSubtract(left: Rational, right: Rational): Rational {
  return normalize(left.num * right.den - right.num * left.den, left.den * right.den)
}

export function rationalMultiply(left: Rational, right: Rational): Rational {
  return normalize(left.num * right.num, left.den * right.den)
}

// Division by zero has no rational value.
export function rationalDivide(left: Rational, right: Rational): Rational | null {
  if (right.num === 0n) return null
  return normalize(left.num * right.den, left.den * right.num)
}

export function rationalNegate(value: Rational): Rational {
  return {num: -value.num, den: value.den}
}

export function rationalIsZero(value: Rational): boolean {
  return value.num === 0n
}

export function rationalIsNegative(value: Rational): boolean {
  return value.num < 0n
}

export function rationalIsPositive(value: Rational): boolean {
  return value.num > 0n
}

export function rationalEquals(left: Rational, right: Rational): boolean {
  return left.num === right.num && left.den === right.den
}

// -1, 0, 1 as left compares to right.
export function rationalCompare(left: Rational, right: Rational): number {
  const difference = left.num * right.den - right.num * left.den
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

export function rationalKey(value: Rational): string {
  return `${value.num}/${value.den}`
}

function normalize(num: bigint, den: bigint): Rational {
  if (den < 0n) {
    num = -num
    den = -den
  }
  if (num === 0n) return rationalZero
  const divisor = greatestCommonDivisor(num < 0n ? -num : num, den)
  return {num: num / divisor, den: den / divisor}
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}
