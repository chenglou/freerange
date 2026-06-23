import {describe, expect, test} from 'bun:test'
import {numberValue} from '../../src/domain.ts'
import {
  linearAdd,
  linearConstant,
  linearDivide,
  linearScale,
  linearScaleExact,
  linearSubtract,
  linearVariable,
  sameLinear,
  singleUnitAtom,
} from '../../src/numeric/linear.ts'
import {rationalCompare, rationalEquals, rationalFromParts, rationalZero} from '../../src/numeric/rational.ts'
import {farkasProvesNonNegative, linearFeasiblePoint, linearMaximum} from '../../src/numeric/solver.ts'
import {comparisonCounterexample} from '../../src/proof.ts'

describe('generic linear numeric kernel', () => {
  test('rejects non-finite constants and division by zero', () => {
    expect(linearConstant(Number.POSITIVE_INFINITY)).toBe(null)
    expect(linearConstant(Number.NaN)).toBe(null)
    expect(linearDivide(linearVariable('input'), 0)).toBe(null)
    expect(sameLinear(linearDivide(linearVariable('input'), 1)!, linearVariable('input'))).toBe(true)
  })

  test('uses host atom identity without interpreting or printing it', () => {
    const widthAtom = 101
    const heightAtom = 202
    const width = linearVariable(widthAtom)
    const height = linearVariable(heightAtom)
    const sum = linearAdd(width, height)!
    const repeatedSum = linearAdd(linearAdd(width, height), linearConstant(0))!
    expect(sameLinear(sum, repeatedSum)).toBe(true)
    expect(sum.terms.get(widthAtom)).toBeDefined()
    expect(sum.terms.get(heightAtom)).toBeDefined()
    expect(singleUnitAtom(linearVariable(null))).toEqual({atom: null})

    const facts = [
      {diff: width, strict: false},
      {diff: height, strict: false},
      {diff: linearSubtract(linearConstant<number>(10), sum)!, strict: false},
    ]
    expect(farkasProvesNonNegative(sum, false, facts)).toBe(true)
    expect(farkasProvesNonNegative(linearSubtract(width, height)!, false, facts)).toBe(false)

    const maximum = linearMaximum(linearAdd(linearScale(width, 2), height)!, facts)
    expect(maximum.kind).toBe('optimum')
    if (maximum.kind !== 'optimum') throw new Error(`Expected an optimum, got ${maximum.kind}`)
    expect(rationalEquals(maximum.value, rationalFromParts(20n, 1n))).toBe(true)

    const nanAtom = Number.NaN
    const nanVariable = linearVariable(nanAtom)
    const nanFacts = [
      {diff: nanVariable, strict: false},
      {diff: linearSubtract(linearConstant<number>(1), nanVariable)!, strict: false},
    ]
    const nanMaximum = linearMaximum(nanVariable, nanFacts)
    expect(nanMaximum.kind).toBe('optimum')
    if (nanMaximum.kind !== 'optimum') throw new Error(`Expected an optimum, got ${nanMaximum.kind}`)
    expect(rationalEquals(nanMaximum.value, rationalFromParts(1n, 1n))).toBe(true)
  })

  test('preserves strictness through repeated Farkas composition', () => {
    const top = linearVariable(1)
    const middle = linearVariable(2)
    const bottom = linearVariable(3)
    const orderedFacts = [
      {diff: linearSubtract(top, middle)!, strict: false},
      {diff: linearSubtract(middle, bottom)!, strict: false},
      {diff: bottom, strict: true},
    ]
    expect(farkasProvesNonNegative(top, true, orderedFacts)).toBe(true)

    const nonStrictBottom = [
      orderedFacts[0]!,
      orderedFacts[1]!,
      {diff: bottom, strict: false},
    ]
    expect(farkasProvesNonNegative(top, true, nonStrictBottom)).toBe(false)
    expect(farkasProvesNonNegative(top, false, nonStrictBottom)).toBe(true)
  })

  test('handles large normalized coefficients with strict facts', () => {
    const input = linearVariable('input')
    const largeCoefficient = rationalFromParts(10n ** 500n, 10n ** 100n)
    const lowerBound = linearScaleExact(linearSubtract(input, linearConstant(2))!, largeCoefficient)
    const upperBound = linearScaleExact(linearSubtract(linearConstant(3), input)!, largeCoefficient)
    const facts = [
      {diff: lowerBound, strict: true},
      {diff: upperBound, strict: false},
    ]

    expect(farkasProvesNonNegative(linearSubtract(input, linearConstant(2))!, true, facts)).toBe(true)
    expect(farkasProvesNonNegative(linearSubtract(input, linearConstant(3))!, false, facts)).toBe(false)
    const maximum = linearMaximum(input, facts)
    expect(maximum.kind).toBe('optimum')
    if (maximum.kind !== 'optimum') throw new Error(`Expected an optimum, got ${maximum.kind}`)
    expect(rationalEquals(maximum.value, rationalFromParts(3n, 1n))).toBe(true)

    const openUpperFacts = [
      {diff: linearSubtract(linearConstant(1), input)!, strict: true},
    ]
    const openMaximum = linearMaximum(input, openUpperFacts)
    expect(openMaximum.kind).toBe('supremum')
    if (openMaximum.kind !== 'supremum') throw new Error(`Expected a supremum, got ${openMaximum.kind}`)
    expect(rationalEquals(openMaximum.value, rationalFromParts(1n, 1n))).toBe(true)
    expect(linearFeasiblePoint([
      ...openUpperFacts,
      {diff: linearSubtract(input, linearConstant(1))!, strict: false},
    ]) == null).toBe(true)

    const openIntervalFacts = [
      {diff: input, strict: true},
      {diff: linearSubtract(linearConstant(1), input)!, strict: true},
    ]
    const constantMaximum = linearMaximum(linearConstant<string>(0)!, openIntervalFacts)
    expect(constantMaximum.kind).toBe('optimum')
    if (constantMaximum.kind !== 'optimum') throw new Error(`Expected an optimum, got ${constantMaximum.kind}`)
    const interiorInput = constantMaximum.point.get('input')!
    expect(rationalCompare(interiorInput, rationalZero) > 0).toBe(true)
    expect(rationalCompare(interiorInput, rationalFromParts(1n, 1n)) < 0).toBe(true)

    expect(linearMaximum(linearConstant<string>(0)!, [
      {diff: input, strict: true},
      {diff: linearScale(input, -1)!, strict: false},
    ]).kind).toBe('infeasible')

    const value = numberValue(
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      null,
      'value',
      linearVariable('value'),
    )
    const zero = numberValue(0, 0, 1075, '0', linearConstant(0))
    const witness = comparisonCounterexample(value, '<', zero, [{
      diff: linearSubtract(value.linear, linearConstant(1))!,
      op: '<',
      text: 'given value < 1',
      leftExpr: 'value',
      rightExpr: '1',
      source: 'function-given',
    }])
    expect(witness?.kind).toBe('point')
    if (witness?.kind !== 'point') throw new Error(`Expected a point, got ${witness?.kind ?? 'null'}`)
    expect(rationalEquals(witness.point.get('value')!, rationalZero)).toBe(true)

    const integerInput = linearVariable('integerInput')
    const unboundedValue = numberValue(
      0,
      Number.POSITIVE_INFINITY,
      0,
      'unboundedValue',
      linearVariable('unboundedValue'),
    )
    const fractionalFacts = [
      {
        diff: linearSubtract(linearScale(integerInput, 2), linearConstant(1))!,
        op: '==' as const,
        source: 'function-given' as const,
      },
      {
        diff: linearAdd(integerInput, linearConstant(100))!,
        op: '>' as const,
        source: 'function-given' as const,
        integerStrict: true as const,
      },
      {
        diff: unboundedValue.linear,
        op: '>=' as const,
        source: 'function-given' as const,
      },
    ]
    expect(comparisonCounterexample(unboundedValue, '<=', zero, fractionalFacts) == null).toBe(true)
    const unboundedWitness = comparisonCounterexample(unboundedValue, '<=', zero, [fractionalFacts[2]!])
    expect(unboundedWitness?.kind).toBe('unbounded')
  })
})
