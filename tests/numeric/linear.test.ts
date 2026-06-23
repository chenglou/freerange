import {describe, expect, test} from 'bun:test'
import {
  linearAdd,
  linearConstant,
  linearFromTerms,
  linearScale,
  linearSubtract,
  linearVariable,
  sameLinear,
  singleUnitAtom,
} from '../../src/numeric/linear.ts'
import {
  rationalEquals,
  rationalFromParts,
  rationalOne,
  rationalZero,
} from '../../src/numeric/rational.ts'

describe('exact linear algebra', () => {
  test('normalizes terms once and composes without nullable algebra', () => {
    const widthAtom = {id: 101}
    const heightAtom = {id: 202}
    const width = linearVariable(widthAtom)
    const height = linearVariable(heightAtom)
    const normalized = linearFromTerms(rationalZero, new Map([
      [widthAtom, rationalZero],
      [heightAtom, rationalOne],
    ]))

    expect(normalized.terms.size).toBe(1)
    expect(normalized.terms.has(widthAtom)).toBe(false)
    expect(sameLinear(normalized, height)).toBe(true)

    const sum = linearAdd(width, height)
    const repeatedSum = linearAdd(linearAdd(width, height), linearConstant(rationalZero))
    expect(sameLinear(sum, repeatedSum)).toBe(true)
    expect(sameLinear(linearSubtract(linearAdd(sum, width), width), sum)).toBe(true)

    const doubled = linearScale(sum, rationalFromParts(2n, 1n))
    expect(rationalEquals(doubled.terms.get(widthAtom)!, rationalFromParts(2n, 1n))).toBe(true)
    expect(rationalEquals(doubled.terms.get(heightAtom)!, rationalFromParts(2n, 1n))).toBe(true)
  })

  test('uses opaque atom identity without interpreting or printing it', () => {
    const nullVariable = linearVariable(null)
    expect(singleUnitAtom(nullVariable)).toEqual({atom: null})
    const undefinedVariable = linearVariable(undefined)
    expect(singleUnitAtom(undefinedVariable)).toEqual({atom: undefined})

    const nanAtom = Number.NaN
    const nanVariable = linearVariable(nanAtom)
    const shifted = linearAdd(nanVariable, linearConstant<number>(rationalOne))
    expect(shifted.terms.get(nanAtom)).toBe(rationalOne)
    expect(singleUnitAtom(linearSubtract(shifted, linearConstant<number>(rationalOne)))).toEqual({atom: nanAtom})
  })
})
