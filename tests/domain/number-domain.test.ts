import {describe, expect, test} from 'bun:test'
import {
  addNumbers,
  divideNumbers,
  gridOfNumber,
  moduloNumbers,
  multiplyNumbers,
  numberValue,
  powerNumbers,
  subtractNumbers,
  type NumberValue,
  type Value,
} from '../../src/domain.ts'
import {linearAdd, linearConstant, linearDivide, linearVariable, sameLinear, type LinearExpr} from '../../src/linear.ts'
import {nextDoubleDown, nextDoubleUp} from '../../src/numeric/float64.ts'
import {
  rationalAdd,
  rationalFromNumber,
  rationalMultiply,
  rationalToNumber,
} from '../../src/numeric/rational.ts'

function expectNumber(value: Value): NumberValue {
  expect(value.kind).toBe('number')
  if (value.kind !== 'number') throw new Error(`Expected a number, got ${value.kind}`)
  return value
}

function expectLinear(linear: LinearExpr | null): LinearExpr {
  expect(linear).not.toBe(null)
  if (linear == null) throw new Error('Expected a linear identity')
  return linear
}

describe('numeric operation invariants', () => {
  test('keeps Float64 conversion failures at the Freerange linear boundary', () => {
    expect(linearConstant(Number.POSITIVE_INFINITY)).toBe(null)
    expect(linearConstant(Number.NaN)).toBe(null)
    expect(linearDivide(linearVariable('input'), 0)).toBe(null)
    expect(sameLinear(linearDivide(linearVariable('input'), 1)!, linearVariable('input'))).toBe(true)
  })

  test('drops exact addition identities before a grid can overflow', () => {
    const leftLinear = linearVariable('left')
    const rightLinear = linearVariable('right')
    const expectedSum = expectLinear(linearAdd(leftLinear, rightLinear))
    const safeLeft = numberValue(2 ** 1020, 2 ** 1021, 1020, 'left', leftLinear)
    const safeRight = numberValue(2 ** 1020, 2 ** 1021, 1020, 'right', rightLinear)
    const safeSum = addNumbers(safeLeft, safeRight)
    expect(safeSum.max).toBe(2 ** 1022)
    expect(sameLinear(expectLinear(safeSum.linear), expectedSum)).toBe(true)
    const repeatedSafeSum = addNumbers(safeSum, safeRight)
    expect(repeatedSafeSum.max).toBe(3 * 2 ** 1021)
    expect(sameLinear(expectLinear(repeatedSafeSum.linear), expectLinear(linearAdd(expectedSum, rightLinear)))).toBe(true)

    const overflowingLeft = numberValue(2 ** 1022, 2 ** 1023, 1022, 'left', leftLinear)
    const overflowingRight = numberValue(2 ** 1022, 2 ** 1023, 1022, 'right', rightLinear)
    const overflowingSum = addNumbers(overflowingLeft, overflowingRight)
    expect(overflowingSum.max).toBe(Number.POSITIVE_INFINITY)
    expect(sameLinear(expectLinear(overflowingSum.linear), expectedSum)).toBe(false)
  })

  test('preserves possible NaN through folded operations and composition', () => {
    const maybeOne = {
      ...numberValue(1, 1, 0, 'value', linearConstant(1)),
      nan: 'possible' as const,
    }
    const two = numberValue(2, 2, 1, 'two', linearConstant(2))
    const operations: ((left: NumberValue, right: NumberValue) => Value)[] = [
      addNumbers,
      subtractNumbers,
      multiplyNumbers,
      divideNumbers,
      moduloNumbers,
    ]

    for (const operation of operations) {
      const first = expectNumber(operation(maybeOne, two))
      expect(first.nan).toBe('possible')
      const second = expectNumber(operation(first, two))
      expect(second.nan).toBe('possible')

      const excluded = expectNumber(operation(numberValue(1, 1, 0, 'one', linearConstant(1)), two))
      expect(excluded.nan).toBe('excluded')
    }

    const powered = expectNumber(powerNumbers(maybeOne, numberValue(3, 3, 0, 'three', linearConstant(3))))
    expect(powered.nan).toBe('possible')
  })

  test('preserves possible NaN through identity shortcuts', () => {
    const maybeRange = {
      ...numberValue(1, 2, 0, 'value', linearVariable('value')),
      nan: 'possible' as const,
    }
    const zero = numberValue(0, 0, 1075, 'zero', linearConstant(0))
    const maybeZero = {...zero, nan: 'possible' as const}

    expect(addNumbers(maybeRange, zero).nan).toBe('possible')
    expect(addNumbers(maybeRange, maybeZero).nan).toBe('possible')
    expect(subtractNumbers(maybeRange, maybeRange).nan).toBe('possible')
    expect(multiplyNumbers(zero, maybeRange).nan).toBe('possible')

    const excludedRange = numberValue(1, 2, 0, 'excluded', linearVariable('excluded'))
    expect(addNumbers(excludedRange, zero).nan).toBe('excluded')
    expect(subtractNumbers(excludedRange, excludedRange).nan).toBe('excluded')
    expect(multiplyNumbers(zero, excludedRange).nan).toBe('excluded')
  })

  test('contains deterministic Float64 samples through repeated operations', () => {
    const scratch = new Float64Array(1)
    const scratchBits = new BigUint64Array(scratch.buffer)
    let state = 0x243f6a8885a308d3n
    const nextFinite = () => {
      while (true) {
        state = (state * 2862933555777941757n + 3037000493n) & 0xffffffffffffffffn
        scratchBits[0] = state
        if (Number.isFinite(scratch[0])) return scratch[0]!
      }
    }
    const contains = (value: Value, concrete: number) => {
      expect(value.kind).toBe('number')
      if (value.kind !== 'number') return
      if (value.nan === 'excluded') expect(Number.isNaN(concrete)).toBe(false)
      if (Number.isNaN(concrete)) {
        expect(value.nan).toBe('possible')
      } else {
        expect(value.min <= concrete && concrete <= value.max).toBe(true)
      }
    }

    const intervalSamples = (first: number, second: number) => {
      const min = Math.min(first, second)
      const max = Math.max(first, second)
      if (Object.is(min, max) || min === max) return [first]
      if (min < 0 && max > 0) return [min, 0, max]
      const midpoint = min / 2 + max / 2
      if (Number.isFinite(midpoint) && midpoint > min && midpoint < max) return [min, midpoint, max]
      const adjacent = nextDoubleUp(min)
      return adjacent < max ? [min, adjacent, max] : [min, max]
    }

    const two = numberValue(2, 2, 1, 'two', linearConstant(2))
    const exercise = (leftSamples: number[], rightSamples: number[]) => {
      const left = numberValue(Math.min(...leftSamples), Math.max(...leftSamples), null, 'left')
      const right = numberValue(Math.min(...rightSamples), Math.max(...rightSamples), null, 'right')
      const sum = addNumbers(left, right)
      const difference = subtractNumbers(left, right)
      const product = multiplyNumbers(left, right)
      const repeatedDifference = subtractNumbers(difference, right)
      const repeatedProduct = multiplyNumbers(product, right)
      const square = powerNumbers(left, two)
      const fourthPower = powerNumbers(expectNumber(square), two)

      for (const leftConcrete of leftSamples) {
        contains(square, leftConcrete ** 2)
        contains(fourthPower, (leftConcrete ** 2) ** 2)
      }
      for (const leftConcrete of leftSamples) {
        for (const rightConcrete of rightSamples) {
          contains(sum, leftConcrete + rightConcrete)
          contains(difference, leftConcrete - rightConcrete)
          contains(product, leftConcrete * rightConcrete)
          contains(repeatedDifference, leftConcrete - rightConcrete - rightConcrete)
          contains(repeatedProduct, leftConcrete * rightConcrete * rightConcrete)
          if (right.min > 0 || right.max < 0) {
            const quotient = divideNumbers(left, right)
            contains(quotient, leftConcrete / rightConcrete)
            if (quotient.kind === 'number') {
              contains(divideNumbers(quotient, right), leftConcrete / rightConcrete / rightConcrete)
            }
            const remainder = moduloNumbers(left, right)
            contains(remainder, leftConcrete % rightConcrete)
            if (remainder.kind === 'number') {
              contains(moduloNumbers(remainder, right), (leftConcrete % rightConcrete) % rightConcrete)
            }
          }
        }
      }
      const secondSum = addNumbers(addNumbers(left, right), right)
      for (const leftConcrete of leftSamples) {
        for (const rightConcrete of rightSamples) {
          contains(secondSum, leftConcrete + rightConcrete + rightConcrete)
        }
      }
    }

    for (let index = 0; index < 500; index++) {
      exercise(intervalSamples(nextFinite(), nextFinite()), intervalSamples(nextFinite(), nextFinite()))
    }

    const smallestNormal = 2 ** -1022
    const largestSubnormal = nextDoubleDown(smallestNormal)
    const boundaryValues = [
      Number.NEGATIVE_INFINITY,
      -Number.MAX_VALUE,
      -(2 ** 53),
      -0,
      0,
      Number.MIN_VALUE,
      largestSubnormal,
      smallestNormal,
      nextDoubleDown(2 ** 53),
      2 ** 53,
      nextDoubleUp(2 ** 53),
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]
    const boundaryIntervals = [
      ...boundaryValues.map(value => [value]),
      [-Number.MIN_VALUE, 0, Number.MIN_VALUE],
      [nextDoubleDown(2 ** 53), 2 ** 53, nextDoubleUp(2 ** 53)],
      [-Number.MAX_VALUE, 0, Number.MAX_VALUE],
      [Number.NEGATIVE_INFINITY, 0, Number.POSITIVE_INFINITY],
    ]
    for (const leftSamples of boundaryIntervals) {
      for (const rightSamples of boundaryIntervals) exercise(leftSamples, rightSamples)
    }
  })

  test('checks every retained linear identity against concrete arithmetic', () => {
    let retainedIdentityCount = 0
    const checkRetainedIdentity = (
      abstract: Value,
      concrete: (value: number) => number,
      samples: number[],
    ) => {
      const result = expectNumber(abstract)
      if (result.linear == null || !result.linear.terms.has('input')) return
      for (const atom of result.linear.terms.keys()) expect(atom).toBe('input')
      retainedIdentityCount++
      for (const concreteInput of samples) {
        let evaluated = result.linear.constant
        for (const [atom, coefficient] of result.linear.terms) {
          expect(atom).toBe('input')
          evaluated = rationalAdd(evaluated, rationalMultiply(coefficient, rationalFromNumber(concreteInput)!))
        }
        expect(rationalToNumber(evaluated)).toBe(concrete(concreteInput))
      }
    }

    for (let grid = -1074; grid <= 900; grid += 31) {
      const unit = 2 ** grid
      const span = 4 * unit
      const samples = [-span, -unit, 0, unit, span]
      const input = numberValue(-span, span, grid, 'input', linearVariable('input'))
      const addend = numberValue(unit, unit, gridOfNumber(unit), 'addend', linearConstant(unit))
      checkRetainedIdentity(addNumbers(input, addend), value => value + unit, samples)
      checkRetainedIdentity(subtractNumbers(input, addend), value => value - unit, samples)

      for (const factor of [0.25, 0.5, 1, 2, 4]) {
        const constant = numberValue(factor, factor, gridOfNumber(factor), 'factor', linearConstant(factor))
        checkRetainedIdentity(multiplyNumbers(input, constant), value => value * factor, samples)
        checkRetainedIdentity(divideNumbers(input, constant), value => value / factor, samples)
      }
    }
    expect(retainedIdentityCount > 500).toBe(true)
  })
})
