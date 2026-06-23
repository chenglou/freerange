import {describe, expect, test} from 'bun:test'
import {nextDoubleDown, nextDoubleUp} from '../../src/numeric/float64.ts'
import {
  rationalAdd,
  rationalCompare,
  rationalDivide,
  rationalEquals,
  rationalFromNumber,
  rationalFromParts,
  rationalMultiply,
  rationalOne,
  rationalToNumber,
  rationalToNumberCeil,
  rationalToNumberFloor,
  rationalZero,
} from '../../src/numeric/rational.ts'

describe('exact rational and Float64 conversion', () => {
  test('rejects non-finite inputs and division by zero', () => {
    expect(rationalFromNumber(Number.POSITIVE_INFINITY)).toBe(null)
    expect(rationalFromNumber(Number.NaN)).toBe(null)
    expect(rationalDivide(rationalOne, rationalZero)).toBe(null)
    expect(rationalEquals(rationalDivide(rationalOne, rationalOne)!, rationalOne)).toBe(true)
  })

  test('normalizes construction and rejects a zero denominator', () => {
    expect(rationalEquals(rationalFromParts(2n, 4n), rationalFromParts(1n, 2n))).toBe(true)
    expect(rationalEquals(rationalFromParts(2n, -4n), rationalFromParts(-1n, 2n))).toBe(true)
    expect(rationalFromParts(0n, -5n)).toBe(rationalZero)
    expect(() => rationalFromParts(1n, 0n)).toThrow('Rational denominator cannot be zero')
  })

  test('rounds huge coefficients without losing their fractional part', () => {
    const scale = 10n ** 400n
    const belowOneAndAHalf = rationalFromParts(3n * scale + 1n, 2n * scale + 1n)
    expect(rationalToNumber(belowOneAndAHalf)).toBe(1.5)
    expect(rationalToNumberFloor(belowOneAndAHalf)).toBe(nextDoubleDown(1.5))
    expect(rationalToNumberCeil(belowOneAndAHalf)).toBe(1.5)

    const negative = rationalFromParts(-belowOneAndAHalf.num, belowOneAndAHalf.den)
    expect(rationalToNumber(negative)).toBe(-1.5)
    expect(rationalToNumberFloor(negative)).toBe(-1.5)
    expect(rationalToNumberCeil(negative)).toBe(nextDoubleUp(-1.5))

    const hugePowerOfTwo = rationalFromParts(1n << 1_000_000n, 1n)
    expect(rationalToNumber(hugePowerOfTwo)).toBe(Number.POSITIVE_INFINITY)
    expect(rationalToNumber(rationalFromParts(-hugePowerOfTwo.num, 1n))).toBe(Number.NEGATIVE_INFINITY)
  })

  test('rounds subnormal ties and the overflow threshold', () => {
    const halfMinimum = rationalFromParts(1n, 1n << 1075n)
    expect(Object.is(rationalToNumber(halfMinimum), 0)).toBe(true)
    expect(rationalToNumberFloor(halfMinimum)).toBe(0)
    expect(rationalToNumberCeil(halfMinimum)).toBe(Number.MIN_VALUE)

    const negativeHalfMinimum = rationalFromParts(-1n, 1n << 1075n)
    expect(Object.is(rationalToNumber(negativeHalfMinimum), -0)).toBe(true)
    expect(rationalToNumberFloor(negativeHalfMinimum)).toBe(-Number.MIN_VALUE)
    expect(Object.is(rationalToNumberCeil(negativeHalfMinimum), -0)).toBe(true)

    const oneAndAHalfMinimums = rationalFromParts(3n, 1n << 1075n)
    expect(rationalToNumber(oneAndAHalfMinimums)).toBe(2 * Number.MIN_VALUE)
    expect(rationalToNumberFloor(oneAndAHalfMinimums)).toBe(Number.MIN_VALUE)
    expect(rationalToNumberCeil(oneAndAHalfMinimums)).toBe(2 * Number.MIN_VALUE)

    const overflowMidpoint = rationalFromParts(((1n << 54n) - 1n) << 970n, 1n)
    expect(rationalToNumber(overflowMidpoint)).toBe(Number.POSITIVE_INFINITY)
    expect(rationalToNumberFloor(overflowMidpoint)).toBe(Number.MAX_VALUE)
    expect(rationalToNumberCeil(overflowMidpoint)).toBe(Number.POSITIVE_INFINITY)

    const belowOverflowMidpoint = rationalFromParts(overflowMidpoint.num - 1n, 1n)
    expect(rationalToNumber(belowOverflowMidpoint)).toBe(Number.MAX_VALUE)
    expect(rationalToNumberFloor(belowOverflowMidpoint)).toBe(Number.MAX_VALUE)
    expect(rationalToNumberCeil(belowOverflowMidpoint)).toBe(Number.POSITIVE_INFINITY)

    const negativeOverflowMidpoint = rationalFromParts(-overflowMidpoint.num, 1n)
    expect(rationalToNumber(negativeOverflowMidpoint)).toBe(Number.NEGATIVE_INFINITY)
    expect(rationalToNumberFloor(negativeOverflowMidpoint)).toBe(Number.NEGATIVE_INFINITY)
    expect(rationalToNumberCeil(negativeOverflowMidpoint)).toBe(-Number.MAX_VALUE)

    const aboveNegativeOverflowMidpoint = rationalFromParts(-overflowMidpoint.num + 1n, 1n)
    expect(rationalToNumber(aboveNegativeOverflowMidpoint)).toBe(-Number.MAX_VALUE)
    expect(rationalToNumberFloor(aboveNegativeOverflowMidpoint)).toBe(Number.NEGATIVE_INFINITY)
    expect(rationalToNumberCeil(aboveNegativeOverflowMidpoint)).toBe(-Number.MAX_VALUE)
  })

  test('uses ties-to-even at normal and smallest-normal boundaries', () => {
    const lowerEvenTie = rationalFromParts((1n << 53n) + 1n, 1n << 53n)
    expect(rationalToNumber(lowerEvenTie)).toBe(1)
    expect(rationalToNumberFloor(lowerEvenTie)).toBe(1)
    expect(rationalToNumberCeil(lowerEvenTie)).toBe(nextDoubleUp(1))

    const upperEven = nextDoubleUp(nextDoubleUp(1))
    const upperEvenTie = rationalFromParts((1n << 53n) + 3n, 1n << 53n)
    expect(rationalToNumber(upperEvenTie)).toBe(upperEven)
    expect(rationalToNumberFloor(upperEvenTie)).toBe(nextDoubleDown(upperEven))
    expect(rationalToNumberCeil(upperEvenTie)).toBe(upperEven)

    for (const [positiveTie, nearest, floor, ceil] of [
      [lowerEvenTie, -1, nextDoubleDown(-1), -1],
      [upperEvenTie, -upperEven, -upperEven, nextDoubleUp(-upperEven)],
    ] as const) {
      const negativeTie = rationalFromParts(-positiveTie.num, positiveTie.den)
      expect(rationalToNumber(negativeTie)).toBe(nearest)
      expect(rationalToNumberFloor(negativeTie)).toBe(floor)
      expect(rationalToNumberCeil(negativeTie)).toBe(ceil)
    }

    const smallestNormal = 2 ** -1022
    const largestSubnormal = nextDoubleDown(smallestNormal)
    const transitionTie = rationalFromParts((1n << 53n) - 1n, 1n << 1075n)
    expect(rationalToNumber(transitionTie)).toBe(smallestNormal)
    expect(rationalToNumberFloor(transitionTie)).toBe(largestSubnormal)
    expect(rationalToNumberCeil(transitionTie)).toBe(smallestNormal)
  })

  test('preserves exact doubles and composed exact arithmetic', () => {
    const smallestNormal = 2 ** -1022
    const largestSubnormal = nextDoubleDown(smallestNormal)
    for (const value of [
      Number.MIN_VALUE,
      largestSubnormal,
      smallestNormal,
      2 ** 53,
      nextDoubleUp(2 ** 53),
      Number.MAX_VALUE,
    ]) {
      expect(rationalToNumber(rationalFromNumber(value)!)).toBe(value)
      expect(rationalToNumberFloor(rationalFromNumber(value)!)).toBe(value)
      expect(rationalToNumberCeil(rationalFromNumber(value)!)).toBe(value)
    }

    let positivePower = rationalFromNumber(1.03)!
    for (let index = 1; index < 20; index++) {
      positivePower = rationalMultiply(positivePower, rationalFromNumber(1.03)!)
    }
    expect(rationalToNumber(positivePower)).toBe(1.8061112346694148)
    expect(rationalToNumberFloor(positivePower)).toBe(1.8061112346694146)
    expect(rationalToNumberCeil(positivePower)).toBe(1.8061112346694148)
  })

  test('matches JavaScript addition and multiplication over deterministic Float64 bits', () => {
    const scratch = new Float64Array(1)
    const scratchBits = new BigUint64Array(scratch.buffer)
    let state = 0x9e3779b97f4a7c15n
    const nextFinite = () => {
      while (true) {
        state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn
        scratchBits[0] = state
        if (Number.isFinite(scratch[0])) return scratch[0]!
      }
    }

    for (let index = 0; index < 2_000; index++) {
      const left = nextFinite()
      const right = nextFinite()
      const leftRational = rationalFromNumber(left)!
      const rightRational = rationalFromNumber(right)!
      expect(Object.is(rationalToNumber(leftRational), left) || (left === 0 && rationalToNumber(leftRational) === 0)).toBe(true)
      expect(Object.is(rationalToNumber(rationalAdd(leftRational, rightRational)), left + right)).toBe(true)
      expect(Object.is(rationalToNumber(rationalMultiply(leftRational, rightRational)), left * right)).toBe(true)

      const sum = rationalAdd(leftRational, rightRational)
      const floor = rationalToNumberFloor(sum)
      const ceil = rationalToNumberCeil(sum)
      if (floor !== Number.NEGATIVE_INFINITY) {
        expect(rationalCompare(rationalFromNumber(floor)!, sum) <= 0).toBe(true)
      }
      if (ceil !== Number.POSITIVE_INFINITY) {
        expect(rationalCompare(rationalFromNumber(ceil)!, sum) >= 0).toBe(true)
      }
      const nearest = rationalToNumber(sum)
      expect(floor === nearest || Object.is(floor, nextDoubleDown(nearest))).toBe(true)
      expect(ceil === nearest || Object.is(ceil, nextDoubleUp(nearest))).toBe(true)
    }
  })
})
