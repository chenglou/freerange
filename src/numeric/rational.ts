// Exact rational arithmetic for linear-proof coefficients. Every finite JS
// number is an exact rational (significand times a power of two), so converting
// in is lossless; converting out can round and callers must say so explicitly.
// No epsilon anywhere: a proof layer that drops "small" terms can certify false
// contracts (1e-10 * x with x up to 1e12 is 100, not 0).

import {nextDoubleDown, nextDoubleUp} from './float64.ts'

declare const rationalBrand: unique symbol

export type Rational = Readonly<{
  num: bigint
  den: bigint
  [rationalBrand]: true
}>

function canonicalRational(num: bigint, den: bigint): Rational {
  return {num, den} as Rational
}

export const rationalZero = canonicalRational(0n, 1n)
export const rationalOne = canonicalRational(1n, 1n)
const maxExactlyRepresentableInteger = (1n << 53n) - 1n

export function rationalFromParts(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error('Rational denominator cannot be zero')
  return normalize(num, den)
}

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
  const exact = rationalToExactNumber(value)
  if (exact != null) return exact
  const magnitude = value.num < 0n ? -value.num : value.num
  if (magnitude <= maxExactlyRepresentableInteger && value.den <= maxExactlyRepresentableInteger) {
    return Number(value.num) / Number(value.den)
  }
  const converted = positiveRationalToNumber(magnitude, value.den)
  return value.num < 0n ? -converted : converted
}

export function rationalToExactNumber(value: Rational): number | null {
  if (value.num === 0n) return 0
  if ((value.den & (value.den - 1n)) !== 0n) return null

  const magnitude = value.num < 0n ? -value.num : value.num
  const magnitudeBits = magnitude.toString(2)
  const denominatorExponent = bigintBitLength(value.den) - 1
  const highestBit = magnitudeBits.length - 1 - denominatorExponent
  if (highestBit > 1023) return null

  const trailingZeros = magnitudeBits.length - magnitudeBits.lastIndexOf('1') - 1
  const significand = trailingZeros === 0 ? magnitude : magnitude >> BigInt(trailingZeros)
  const significandBits = magnitudeBits.length - trailingZeros
  const grid = trailingZeros - denominatorExponent
  if (grid < -1074) return null
  if (highestBit >= -1022 && significandBits > 53) return null

  const result = Number(significand) * 2 ** grid
  return value.num < 0n ? -result : result
}

function positiveRationalToNumber(num: bigint, den: bigint): number {
  const exponent = positiveRationalFloorLog2(num, den)
  if (exponent > 1023) return Number.POSITIVE_INFINITY

  if (exponent < -1022) {
    const significand = roundPositiveQuotient(num << 1074n, den)
    return Number(significand) * Number.MIN_VALUE
  }

  const significandShift = 52 - exponent
  const scaledNum = significandShift >= 0 ? num << BigInt(significandShift) : num
  const scaledDen = significandShift >= 0 ? den : den << BigInt(-significandShift)
  const significand = roundPositiveQuotient(scaledNum, scaledDen)
  return Number(significand) * 2 ** (exponent - 52)
}

function positiveRationalFloorLog2(num: bigint, den: bigint): number {
  let exponent = bigintBitLength(num) - bigintBitLength(den)
  const belowPower = exponent >= 0
    ? num < den << BigInt(exponent)
    : num << BigInt(-exponent) < den
  if (belowPower) exponent--
  return exponent
}

function bigintBitLength(value: bigint): number {
  return value.toString(2).length
}

function roundPositiveQuotient(num: bigint, den: bigint): bigint {
  const quotient = num / den
  const remainder = num % den
  const doubledRemainder = remainder * 2n
  if (doubledRemainder > den || (doubledRemainder === den && (quotient & 1n) === 1n)) {
    return quotient + 1n
  }
  return quotient
}

// Largest double <= the rational: the safe direction for a published lower
// bound. rationalToNumber alone rounds to nearest, which can overstate a
// lower bound by up to an ulp.
export function rationalToNumberFloor(value: Rational): number {
  const result = rationalToNumber(value)
  return doubleComparesToRational(result, value) > 0 ? nextDoubleDown(result) : result
}

// Smallest double >= the rational: the safe direction for a published upper
// bound.
export function rationalToNumberCeil(value: Rational): number {
  const result = rationalToNumber(value)
  return doubleComparesToRational(result, value) < 0 ? nextDoubleUp(result) : result
}

function doubleComparesToRational(double: number, value: Rational): number {
  if (double === Number.NEGATIVE_INFINITY) return -1
  if (double === Number.POSITIVE_INFINITY) return 1
  return rationalCompare(rationalFromNumber(double)!, value)
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
  return value.num === 0n ? rationalZero : canonicalRational(-value.num, value.den)
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
  return canonicalRational(num / divisor, den / divisor)
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}
