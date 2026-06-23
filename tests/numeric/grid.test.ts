import {describe, expect, test} from 'bun:test'
import {
  gridJoin,
  gridMeet,
  gridOfNumber,
  withinGridWindow,
  zeroGrid,
} from '../../src/numeric/grid.ts'
import {rationalFromParts} from '../../src/numeric/rational.ts'

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
  })
})
