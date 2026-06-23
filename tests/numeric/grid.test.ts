import {describe, expect, test} from 'bun:test'
import {
  gridJoin,
  gridMeet,
  gridOfNumber,
  withinGridWindow,
  zeroGrid,
} from '../../src/numeric/grid.ts'
import {rationalFromParts, rationalZero} from '../../src/numeric/rational.ts'

describe('Float64 grids', () => {
  test('tracks exact binary spacing through repeated joins and intersections', () => {
    expect(gridOfNumber(0)).toBe(zeroGrid)
    expect(gridOfNumber(0.5)).toBe(-1)
    expect(gridOfNumber(1)).toBe(0)
    expect(gridOfNumber(6)).toBe(1)
    expect(gridOfNumber(Number.MIN_VALUE)).toBe(-1074)
    expect(gridOfNumber(Number.POSITIVE_INFINITY)).toBe(null)
    expect(gridOfNumber(Number.NaN)).toBe(null)

    expect(gridJoin(gridJoin(2, 0), -1)).toBe(-1)
    expect(gridJoin(2, null)).toBe(null)
    expect(gridMeet(gridMeet(-1, 0), 2)).toBe(2)
    expect(gridMeet(null, -1)).toBe(-1)
  })

  test('recognizes the exact-operation magnitude window', () => {
    expect(withinGridWindow(rationalFromParts(1n << 53n, 1n), 0)).toBe(true)
    expect(withinGridWindow(rationalFromParts((1n << 53n) + 1n, 1n), 0)).toBe(false)
    expect(withinGridWindow(rationalFromParts(1n, 1n << 1074n), -1074)).toBe(true)
    expect(withinGridWindow(rationalFromParts((1n << 53n) + 1n, 1n << 1074n), -1074)).toBe(false)

    const precisionBoundary = rationalFromParts(1n << 1023n, 1n)
    expect(withinGridWindow(precisionBoundary, 970)).toBe(true)
    expect(withinGridWindow(rationalFromParts(precisionBoundary.num + (1n << 970n), 1n), 970)).toBe(false)

    const maximumFinite = rationalFromParts(((1n << 53n) - 1n) << 971n, 1n)
    expect(withinGridWindow(maximumFinite, 971)).toBe(true)
    expect(withinGridWindow(rationalFromParts(1n << 1024n, 1n), 971)).toBe(false)
    expect(withinGridWindow(rationalFromParts(3n << 1022n, 1n), 1022)).toBe(true)
    expect(withinGridWindow(rationalFromParts(1n << 1024n, 1n), 1022)).toBe(false)
    expect(withinGridWindow(rationalFromParts(1n << 1023n, 1n), 1023)).toBe(true)
    expect(withinGridWindow(rationalFromParts(1n << 1024n, 1n), 1023)).toBe(false)
    expect(withinGridWindow(rationalZero, zeroGrid)).toBe(true)
    expect(withinGridWindow(rationalFromParts(1n, 1n), zeroGrid)).toBe(false)
  })
})
