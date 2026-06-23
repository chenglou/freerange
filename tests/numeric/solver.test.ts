import {describe, expect, test} from 'bun:test'
import {
  linearAdd,
  linearConstant,
  linearScale,
  linearSubtract,
  linearVariable,
  type LinearExpr,
} from '../../src/numeric/linear.ts'
import {
  rationalCompare,
  rationalEquals,
  rationalFromParts,
  rationalZero,
} from '../../src/numeric/rational.ts'
import {
  farkasProvesNonNegative,
  linearFeasiblePoint,
  linearMaximum,
} from '../../src/numeric/solver.ts'

const integer = (value: number) => rationalFromParts(BigInt(value), 1n)
const constant = <Atom>(value: number) => linearConstant<Atom>(integer(value))
const scale = <Atom>(linear: LinearExpr<Atom>, factor: number) => linearScale(linear, integer(factor))

describe('linear solver', () => {
  test('preserves strictness through repeated Farkas composition', () => {
    const top = linearVariable(1)
    const middle = linearVariable(2)
    const bottom = linearVariable(3)
    const orderedFacts = [
      {diff: linearSubtract(top, middle), strict: false},
      {diff: linearSubtract(middle, bottom), strict: false},
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

    expect(farkasProvesNonNegative(top, true, [
      {diff: linearSubtract(scale(top, 2), middle), strict: false},
      {diff: middle, strict: true},
    ])).toBe(true)
    expect(farkasProvesNonNegative(top, true, [
      {diff: linearSubtract(scale(top, 2), middle), strict: false},
      {diff: middle, strict: false},
    ])).toBe(false)
  })

  test('classifies bounded, fractional, degenerate, unbounded, and infeasible problems', () => {
    const x = linearVariable('x')
    const y = linearVariable('y')
    const nonnegativeFacts = [
      {diff: x, strict: false},
      {diff: y, strict: false},
    ]
    const sum = linearAdd(x, y)

    const bounded = linearMaximum(sum, [
      ...nonnegativeFacts,
      {diff: linearSubtract(constant(2), x), strict: false},
      {diff: linearSubtract(constant(3), y), strict: false},
    ])
    expect(bounded.kind).toBe('optimum')
    if (bounded.kind !== 'optimum') throw new Error(`Expected an optimum, got ${bounded.kind}`)
    expect(rationalEquals(bounded.value, integer(5))).toBe(true)
    expect(rationalEquals(bounded.point.get('x')!, integer(2))).toBe(true)
    expect(rationalEquals(bounded.point.get('y')!, integer(3))).toBe(true)

    const fractional = linearMaximum(sum, [
      ...nonnegativeFacts,
      {diff: linearSubtract(constant(4), linearAdd(scale(x, 2), y)), strict: false},
      {diff: linearSubtract(constant(4), linearAdd(x, scale(y, 2))), strict: false},
    ])
    expect(fractional.kind).toBe('optimum')
    if (fractional.kind !== 'optimum') throw new Error(`Expected an optimum, got ${fractional.kind}`)
    expect(rationalEquals(fractional.value, rationalFromParts(8n, 3n))).toBe(true)
    expect(rationalEquals(fractional.point.get('x')!, rationalFromParts(4n, 3n))).toBe(true)
    expect(rationalEquals(fractional.point.get('y')!, rationalFromParts(4n, 3n))).toBe(true)

    const degenerate = linearMaximum(sum, [
      ...nonnegativeFacts,
      {diff: linearSubtract(constant(1), x), strict: false},
      {diff: linearSubtract(constant(1), y), strict: false},
      {diff: linearSubtract(constant(1), sum), strict: false},
      {diff: linearSubtract(constant(2), sum), strict: false},
    ])
    expect(degenerate.kind).toBe('optimum')
    if (degenerate.kind !== 'optimum') throw new Error(`Expected an optimum, got ${degenerate.kind}`)
    expect(rationalEquals(degenerate.value, integer(1))).toBe(true)

    expect(linearMaximum(x, [{diff: x, strict: false}]).kind).toBe('unbounded')
    expect(linearMaximum(x, [
      {diff: linearSubtract(x, constant(1)), strict: false},
      {diff: linearSubtract(constant(0), x), strict: false},
    ]).kind).toBe('infeasible')

    const negativeRhsFacts = [
      {diff: linearAdd(x, constant(2)), strict: false},
      {diff: linearSubtract(constant(-1), x), strict: false},
    ]
    const negativeMaximum = linearMaximum(x, negativeRhsFacts)
    const negativeMinimum = linearMaximum(scale(x, -1), negativeRhsFacts)
    expect(negativeMaximum.kind).toBe('optimum')
    expect(negativeMinimum.kind).toBe('optimum')
    if (negativeMaximum.kind !== 'optimum' || negativeMinimum.kind !== 'optimum') {
      throw new Error('Expected bounded negative-RHS optima')
    }
    expect(rationalEquals(negativeMaximum.value, integer(-1))).toBe(true)
    expect(rationalEquals(negativeMinimum.value, integer(2))).toBe(true)

    const equalityBoundary = linearMaximum(x, [
      {diff: linearSubtract(x, constant(1)), strict: false},
      {diff: linearSubtract(constant(1), x), strict: false},
    ])
    expect(equalityBoundary.kind).toBe('optimum')
    if (equalityBoundary.kind !== 'optimum') throw new Error(`Expected an optimum, got ${equalityBoundary.kind}`)
    expect(rationalEquals(equalityBoundary.value, integer(1))).toBe(true)
  })

  test('handles huge normalized coefficients with strict facts', () => {
    const input = linearVariable('input')
    const largeCoefficient = rationalFromParts(10n ** 500n, 10n ** 100n)
    const lowerBound = linearScale(linearSubtract(input, constant(2)), largeCoefficient)
    const upperBound = linearScale(linearSubtract(constant(3), input), largeCoefficient)
    const facts = [
      {diff: lowerBound, strict: true},
      {diff: upperBound, strict: false},
    ]

    expect(farkasProvesNonNegative(linearSubtract(input, constant(2)), true, facts)).toBe(true)
    expect(farkasProvesNonNegative(linearSubtract(input, constant(3)), false, facts)).toBe(false)
    const maximum = linearMaximum(input, facts)
    expect(maximum.kind).toBe('optimum')
    if (maximum.kind !== 'optimum') throw new Error(`Expected an optimum, got ${maximum.kind}`)
    expect(rationalEquals(maximum.value, integer(3))).toBe(true)
  })

  test('distinguishes attained maxima from strict suprema', () => {
    const input = linearVariable('input')
    const openUpperFacts = [
      {diff: linearSubtract(constant(1), input), strict: true},
    ]
    const openMaximum = linearMaximum(input, openUpperFacts)
    expect(openMaximum.kind).toBe('supremum')
    if (openMaximum.kind !== 'supremum') throw new Error(`Expected a supremum, got ${openMaximum.kind}`)
    expect(rationalEquals(openMaximum.value, integer(1))).toBe(true)
    expect(linearFeasiblePoint([
      ...openUpperFacts,
      {diff: linearSubtract(input, constant(1)), strict: false},
    ])).toBe(null)

    const openIntervalFacts = [
      {diff: input, strict: true},
      {diff: linearSubtract(constant(1), input), strict: true},
    ]
    const constantMaximum = linearMaximum(constant<string>(0), openIntervalFacts)
    expect(constantMaximum.kind).toBe('optimum')
    if (constantMaximum.kind !== 'optimum') throw new Error(`Expected an optimum, got ${constantMaximum.kind}`)
    const interiorInput = constantMaximum.point.get('input')!
    expect(rationalCompare(interiorInput, rationalZero) > 0).toBe(true)
    expect(rationalCompare(interiorInput, integer(1)) < 0).toBe(true)

    expect(linearMaximum(constant<string>(0), [
      {diff: input, strict: true},
      {diff: scale(input, -1), strict: false},
    ]).kind).toBe('infeasible')
  })

  test('uses opaque atoms when returning points', () => {
    const atom = {id: 1}
    const variable = linearVariable(atom)
    const result = linearMaximum(variable, [
      {diff: variable, strict: false},
      {diff: linearSubtract(constant(10), variable), strict: false},
    ])
    expect(result.kind).toBe('optimum')
    if (result.kind !== 'optimum') throw new Error(`Expected an optimum, got ${result.kind}`)
    expect(rationalEquals(result.point.get(atom)!, integer(10))).toBe(true)

    const nanAtom = Number.NaN
    const nanVariable = linearVariable(nanAtom)
    const nanResult = linearMaximum(nanVariable, [
      {diff: nanVariable, strict: false},
      {diff: linearSubtract(constant(1), nanVariable), strict: false},
    ])
    expect(nanResult.kind).toBe('optimum')
    if (nanResult.kind !== 'optimum') throw new Error(`Expected an optimum, got ${nanResult.kind}`)
    expect(rationalEquals(nanResult.point.get(nanAtom)!, integer(1))).toBe(true)
  })
})
