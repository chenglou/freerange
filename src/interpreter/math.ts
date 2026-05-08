import type * as ts from 'typescript'
import {
  callExpr,
  maxNumberCases,
  mergeAssumptions,
  mergeProvenance,
  numberValue,
  numberBranches,
  plainNumber,
  unknown,
  withNumberCases,
  type NumberValue,
  type NumberCase,
  type Value,
} from '../domain.ts'
import {linearConstant, linearScale} from '../linear.ts'
import type {ComparisonOperator} from '../parser.ts'
import {
  comparisonConstraint,
  proveComparisonPlain,
} from '../proof.ts'
import {noteUnsupported, type InterpreterFrame} from './context.ts'
import {auditMathSelector} from './audit.ts'

export function evaluateMathCall(name: string, values: Value[], frame: InterpreterFrame, expression: ts.CallExpression): Value {
  if (values.some(value => value.kind !== 'number')) return noteUnsupported(frame, `Math.${name} expected number arguments`, expression)
  const numbers = values as NumberValue[]
  switch (name) {
    case 'min':
    case 'max':
      auditMathSelector(name, numbers, frame, expression)
      return evaluateMathMinMax(name, numbers, frame)
    case 'floor':
      return evaluateUnaryMath(name, numbers, floorNumber)
    case 'ceil':
      return evaluateUnaryMath(name, numbers, ceilNumber)
    case 'round':
      return evaluateUnaryMath(name, numbers, roundNumber)
    case 'trunc':
      return evaluateUnaryMath(name, numbers, truncNumber)
    case 'sqrt':
      return evaluateUnaryMath(name, numbers, sqrtNumber)
    case 'abs':
      return evaluateUnaryMath(name, numbers, value => absNumber(value, frame))
    case 'sign':
      return evaluateUnaryMath(name, numbers, signNumber)
    default:
      return noteUnsupported(frame, `Unsupported Math.${name} call ${expression.getText(frame.program.sourceFile)}`, expression)
  }
}

function evaluateMathMinMax(kind: 'min' | 'max', values: NumberValue[], frame: InterpreterFrame): Value {
  if (values.length === 0) return unknown(`Math.${kind} expected at least one argument`)
  return values.slice(1).reduce((current, value) => {
    return kind === 'min' ? minNumberPair(current, value, frame) : maxNumberPair(current, value, frame)
  }, values[0]!)
}

function evaluateUnaryMath(name: string, values: NumberValue[], evaluate: (value: NumberValue) => Value): Value {
  if (values.length !== 1) return unknown(`Math.${name} expected one argument`)
  return evaluateNumberUnary(values[0]!, evaluate)
}

function evaluateNumberUnary(value: NumberValue, evaluate: (value: NumberValue) => Value): Value {
  const plain = evaluate(plainNumber(value))
  if (plain.kind !== 'number') return plain
  if (value.cases == null) return plain

  const cases: NumberCase[] = []
  for (const valueCase of value.cases) {
    const caseResult = evaluate(valueCase.value)
    if (caseResult.kind !== 'number') return plain
    cases.push({value: caseResult, assumptions: valueCase.assumptions})
    if (cases.length > maxNumberCases) return plain
  }
  return withNumberCases(plain, cases)
}

function floorNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.floor(value.min), Math.floor(value.max), true, value.expr == null ? null : `floor(${value.expr})`, null, null, value.provenance)
}

function ceilNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.ceil(value.min), Math.ceil(value.max), true, value.expr == null ? null : `ceil(${value.expr})`, null, null, value.provenance)
}

function roundNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.round(value.min), Math.round(value.max), true, value.expr == null ? null : `round(${value.expr})`, null, null, value.provenance)
}

function truncNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.trunc(value.min), Math.trunc(value.max), true, value.expr == null ? null : `trunc(${value.expr})`, null, null, value.provenance)
}

function sqrtNumber(value: NumberValue): Value {
  if (value.min < 0) return unknown('Math.sqrt expected a non-negative number')
  return numberValue(Math.sqrt(value.min), Math.sqrt(value.max), false, value.expr == null ? null : `sqrt(${value.expr})`, null, null, value.provenance)
}

function absNumber(value: NumberValue, frame: InterpreterFrame): NumberValue {
  const plain = plainNumber(value)
  if (plain.min >= 0) return withNumberCases(plain, value.cases)
  if (plain.max <= 0) {
    const result = evaluateNumberUnary(value, current => numberValue(-current.max, -current.min, current.isInteger, current.expr == null ? null : `abs(${current.expr})`, linearScale(current.linear, -1), null, current.provenance))
    return result.kind === 'number' ? result : numberValue(-plain.max, -plain.min, plain.isInteger, plain.expr == null ? null : `abs(${plain.expr})`, linearScale(plain.linear, -1), null, plain.provenance)
  }

  const max = Math.max(Math.abs(plain.min), Math.abs(plain.max))
  const joined = numberValue(0, max, plain.isInteger, plain.expr == null ? null : `abs(${plain.expr})`, null, null, plain.provenance)
  const cases: NumberCase[] = []
  for (const valueCase of numberBranches(value)) {
    const nonNegative = comparisonConstraint(valueCase.value, '>=', numberValue(0, 0, true, '0', linearConstant(0)), undefined, 'branch')
    const nonPositive = comparisonConstraint(valueCase.value, '<=', numberValue(0, 0, true, '0', linearConstant(0)), undefined, 'branch')
    if (nonNegative == null || nonPositive == null) return joined

    const positiveStatus = proveComparisonPlain(valueCase.value, '>=', numberValue(0, 0, true, '0', linearConstant(0)), mergeAssumptions(frame.assumptions, valueCase.assumptions))
    const negativeStatus = proveComparisonPlain(valueCase.value, '<=', numberValue(0, 0, true, '0', linearConstant(0)), mergeAssumptions(frame.assumptions, valueCase.assumptions))

    if (positiveStatus.status !== 'fail') {
      cases.push({
        value: valueCase.value,
        assumptions: positiveStatus.status === 'pass' ? valueCase.assumptions : mergeAssumptions(valueCase.assumptions, [nonNegative]),
      })
    }
    if (negativeStatus.status !== 'fail') {
      cases.push({
        value: numberValue(-valueCase.value.max, -valueCase.value.min, valueCase.value.isInteger, valueCase.value.expr == null ? null : `abs(${valueCase.value.expr})`, linearScale(valueCase.value.linear, -1), null, valueCase.value.provenance),
        assumptions: negativeStatus.status === 'pass' ? valueCase.assumptions : mergeAssumptions(valueCase.assumptions, [nonPositive]),
      })
    }
    if (cases.length > maxNumberCases) return joined
  }
  return withNumberCases(joined, cases)
}

function signNumber(value: NumberValue): NumberValue {
  const expr = value.expr == null ? null : `sign(${value.expr})`
  if (value.min === 0 && value.max === 0) return numberValue(0, 0, true, expr, null, null, value.provenance)
  if (value.min > 0) return numberValue(1, 1, true, expr, null, null, value.provenance)
  if (value.max < 0) return numberValue(-1, -1, true, expr, null, null, value.provenance)
  if (value.min >= 0) return numberValue(0, 1, true, expr, null, null, value.provenance)
  if (value.max <= 0) return numberValue(-1, 0, true, expr, null, null, value.provenance)
  return numberValue(-1, 1, true, expr, null, null, value.provenance)
}

function minNumberPair(left: NumberValue, right: NumberValue, frame: InterpreterFrame): NumberValue {
  return choiceNumberPair('min', left, right, '<=', '<=', frame.assumptions)
}

function maxNumberPair(left: NumberValue, right: NumberValue, frame: InterpreterFrame): NumberValue {
  return choiceNumberPair('max', left, right, '>=', '>=', frame.assumptions)
}

function choiceNumberPair(
  name: 'min' | 'max',
  left: NumberValue,
  right: NumberValue,
  leftOp: ComparisonOperator,
  rightOp: ComparisonOperator,
  assumptions: ReturnType<typeof mergeAssumptions>,
): NumberValue {
  const plainLeft = plainNumber(left)
  const plainRight = plainNumber(right)
  const joined =
    name === 'min'
      ? numberValue(Math.min(plainLeft.min, plainRight.min), Math.min(plainLeft.max, plainRight.max), plainLeft.isInteger && plainRight.isInteger, callExpr(name, [plainLeft, plainRight]), null, null, mergeProvenance(plainLeft, plainRight))
      : numberValue(Math.max(plainLeft.min, plainRight.min), Math.max(plainLeft.max, plainRight.max), plainLeft.isInteger && plainRight.isInteger, callExpr(name, [plainLeft, plainRight]), null, null, mergeProvenance(plainLeft, plainRight))

  const cases: NumberCase[] = []
  for (const leftCase of numberBranches(left)) {
    for (const rightCase of numberBranches(right)) {
      const baseAssumptions = mergeAssumptions(assumptions, leftCase.assumptions, rightCase.assumptions)
      const leftWins = proveComparisonPlain(leftCase.value, leftOp, rightCase.value, baseAssumptions)
      const rightWins = proveComparisonPlain(rightCase.value, rightOp, leftCase.value, baseAssumptions)

      if (leftWins.status !== 'fail') {
        const fact = comparisonConstraint(leftCase.value, leftOp, rightCase.value, undefined, 'branch')
        if (leftWins.status === 'pass') {
          cases.push({
            value: leftCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions),
          })
        } else if (fact != null) {
          cases.push({
            value: leftCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions, [fact]),
          })
        }
      }
      if (rightWins.status !== 'fail') {
        const fact = comparisonConstraint(rightCase.value, rightOp, leftCase.value, undefined, 'branch')
        if (rightWins.status === 'pass') {
          cases.push({
            value: rightCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions),
          })
        } else if (fact != null) {
          cases.push({
            value: rightCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions, [fact]),
          })
        }
      }
      if (cases.length > maxNumberCases) return joined
    }
  }

  return withNumberCases(joined, cases)
}
