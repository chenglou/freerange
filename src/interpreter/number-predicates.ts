import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {
  gridMeet,
  integerValued,
  literalValue,
  numberWithBounds,
  outsideNumericDomain,
  withNumberCases,
  type Assumption,
  type NumberCase,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {admitsNaN} from '../proof.ts'
import {isDefaultLibraryMemberAccess, isDefaultLibrarySymbol} from './call-targets.ts'
import {unwrapExpression} from './source-syntax.ts'

export type NumberPredicateName = 'isFinite' | 'isNaN' | 'isInteger' | 'isSafeInteger'

const numberPredicateNames = new Set<NumberPredicateName>([
  'isFinite',
  'isNaN',
  'isInteger',
  'isSafeInteger',
])

export function numberPredicateCall(
  expression: ts.CallExpression,
  program: Program,
): {name: NumberPredicateName; argument: ts.Expression} | null {
  const target = unwrapExpression(expression.expression)
  if (
    !ts.isPropertyAccessExpression(target)
    || !ts.isIdentifier(target.expression)
    || target.expression.text !== 'Number'
    || !isDefaultLibrarySymbol(target.expression, program)
    || !isDefaultLibraryMemberAccess(target, program)
    || !numberPredicateNames.has(target.name.text as NumberPredicateName)
    || expression.arguments.length !== 1
  ) return null
  return {name: target.name.text as NumberPredicateName, argument: expression.arguments[0]!}
}

export function evaluateNumberPredicate(name: NumberPredicateName, value: Value, text: string, assumptions: Assumption[]): Value {
  if (value.kind === 'unknown' && value.nan != null) {
    const result = name === 'isNaN' && value.nan === 'definite'
      ? [true]
      : value.nan === 'definite'
        ? [false]
        : [true, false]
    return literalValue(result, text)
  }
  if (value.kind !== 'number') return literalValue([true, false], text)
  const mayBeNaN = admitsNaN(value, assumptions)
  switch (name) {
    case 'isFinite':
      if (!mayBeNaN && Number.isFinite(value.min) && Number.isFinite(value.max)) return literalValue([true], text)
      if (value.min === value.max && !Number.isFinite(value.min)) return literalValue([false], text)
      return literalValue([true, false], text)
    case 'isNaN':
      return literalValue(mayBeNaN ? [true, false] : [false], text)
    case 'isInteger':
      if (!mayBeNaN && Number.isFinite(value.min) && Number.isFinite(value.max) && integerValued(value)) return literalValue([true], text)
      if (value.min === value.max && (!Number.isFinite(value.min) || !Number.isInteger(value.min))) return literalValue([false], text)
      return literalValue([true, false], text)
    case 'isSafeInteger':
      if (
        !mayBeNaN
        && value.min >= Number.MIN_SAFE_INTEGER
        && value.max <= Number.MAX_SAFE_INTEGER
        && integerValued(value)
      ) return literalValue([true], text)
      if (value.min === value.max && !Number.isSafeInteger(value.min)) return literalValue([false], text)
      return literalValue([true, false], text)
  }
}

export function valueAfterNumberPredicate(
  name: NumberPredicateName,
  value: NumberValue,
  truth: boolean,
): Value | null {
  switch (name) {
    case 'isFinite':
      return truth
        ? intersectNumberPredicate(value, -Number.MAX_VALUE, Number.MAX_VALUE, value.grid)
        : null
    case 'isNaN':
      if (truth) return outsideNumericDomain('Number.isNaN is true, so the value is outside the checked numerical domain', 'definite')
      return {...value, nan: 'excluded'}
    case 'isInteger':
      return truth
        ? intersectNumberPredicate(value, -Number.MAX_VALUE, Number.MAX_VALUE, gridMeet(value.grid, 0), true)
        : null
    case 'isSafeInteger':
      return truth
        ? intersectNumberPredicate(value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, gridMeet(value.grid, 0), true)
        : null
  }
}

function intersectNumberPredicate(
  value: NumberValue,
  lower: number,
  upper: number,
  grid: number | null,
  requireInteger = false,
): NumberValue | null {
  const boundedMin = Math.max(value.min, lower)
  const boundedMax = Math.min(value.max, upper)
  const min = requireInteger ? Math.ceil(boundedMin) : boundedMin
  const max = requireInteger ? Math.floor(boundedMax) : boundedMax
  if (min > max) return null
  const plain = {...numberWithBounds(value, min, max, grid, null), nan: 'excluded' as const}
  if (value.cases == null) return plain
  const cases: NumberCase[] = []
  for (const numberCase of value.cases) {
    const boundedCaseMin = Math.max(numberCase.value.min, lower)
    const boundedCaseMax = Math.min(numberCase.value.max, upper)
    const caseMin = requireInteger ? Math.ceil(boundedCaseMin) : boundedCaseMin
    const caseMax = requireInteger ? Math.floor(boundedCaseMax) : boundedCaseMax
    if (caseMin > caseMax) continue
    cases.push({
      ...numberCase,
      value: {
        ...numberWithBounds(numberCase.value, caseMin, caseMax, gridMeet(numberCase.value.grid, grid), null),
        nan: 'excluded',
      },
    })
  }
  return cases.length === 0 ? null : withNumberCases(plain, cases)
}
