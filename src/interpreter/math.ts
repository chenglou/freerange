import type * as ts from 'typescript'
import {
  callExpr,
  gridJoin,
  gridOfNumber,
  integerValued,
  linearNameForExpression,
  maxNumberCases,
  mergeOrigin,
  numberValue,
  numberBranches,
  plainNumber,
  powerNumbers,
  unknown,
  withNumberCases,
  type LinearConstraint,
  type NumberValue,
  type NumberCase,
  type Value,
} from '../domain.ts'
import {mergeAssumptions} from '../assumptions.ts'
import {linearAdd, linearConstant, linearScale, linearVariable} from '../linear.ts'
import type {ComparisonOperator} from '../parser.ts'
import {
  comparisonConstraint,
  proveComparisonPlain,
} from '../proof.ts'
import {combineNumberCases} from './state-cases.ts'
import {noteUnsupported, type InterpreterFrame} from './context.ts'
import {auditMathSelector} from './audit.ts'

const int32Min = -2147483648
const int32Max = 2147483647

const mathConstants = new Map<string, number>([
  ['E', Math.E],
  ['LN10', Math.LN10],
  ['LN2', Math.LN2],
  ['LOG10E', Math.LOG10E],
  ['LOG2E', Math.LOG2E],
  ['PI', Math.PI],
  ['SQRT1_2', Math.SQRT1_2],
  ['SQRT2', Math.SQRT2],
])

export function evaluateMathProperty(name: string, text: string): Value | null {
  const value = mathConstants.get(name)
  return value == null ? null : numberValue(value, value, gridOfNumber(value), text, linearConstant(value))
}

export function evaluateMathCall(name: string, values: Value[], frame: InterpreterFrame, expression: ts.CallExpression): Value {
  if (values.some(value => value.kind !== 'number')) return noteUnsupported(frame, `Math.${name} expected number arguments`, expression)
  const numbers = values as NumberValue[]
  const evaluator = mathCallEvaluators.get(name)
  if (evaluator == null) return noteUnsupported(frame, `Unsupported Math.${name} call ${expression.getText(frame.program.sourceFile)}`, expression)
  const result = evaluator(name, numbers, frame, expression)
  if (result.kind === 'number' && numbers.length === 1 && isRoundingFunctionName(name)) {
    frame.assumptions = mergeAssumptions(frame.assumptions, roundingFacts(name, result, numbers[0]!))
  }
  return result
}

type RoundingName = 'floor' | 'ceil' | 'round' | 'trunc'

function isRoundingFunctionName(name: string): name is RoundingName {
  return name === 'floor' || name === 'ceil' || name === 'round' || name === 'trunc'
}

function roundingFacts(name: RoundingName, result: NumberValue, input: NumberValue): LinearConstraint[] {
  if (result.linear == null || input.linear == null || result.expr == null || input.expr == null) return []
  const inputPlus = (offset: number) => numberValue(input.min + offset, input.max + offset, gridJoin(input.grid, gridOfNumber(offset)), null, linearAdd(input.linear, linearConstant(offset)))
  const facts: LinearConstraint[] = []
  const floorStyle = () => {
    const upper = comparisonConstraint(result, '<=', input, `${result.expr} <= ${input.expr}`)
    if (upper != null) facts.push(upper)
    const lower = comparisonConstraint(result, '>', inputPlus(-1), `${result.expr} > ${input.expr} - 1`)
    if (lower != null) facts.push(lower)
  }
  const ceilStyle = () => {
    const lower = comparisonConstraint(result, '>=', input, `${result.expr} >= ${input.expr}`)
    if (lower != null) facts.push(lower)
    const upper = comparisonConstraint(result, '<', inputPlus(1), `${result.expr} < ${input.expr} + 1`)
    if (upper != null) facts.push(upper)
  }
  switch (name) {
    case 'floor':
      floorStyle()
      return facts
    case 'ceil':
      ceilStyle()
      return facts
    case 'round': {
      // JS Math.round rounds half toward positive infinity, so the lower bound is strict.
      const lower = comparisonConstraint(result, '>', inputPlus(-0.5), `${result.expr} > ${input.expr} - 0.5`)
      if (lower != null) facts.push(lower)
      const upper = comparisonConstraint(result, '<=', inputPlus(0.5), `${result.expr} <= ${input.expr} + 0.5`)
      if (upper != null) facts.push(upper)
      return facts
    }
    case 'trunc':
      if (input.min >= 0) floorStyle()
      else if (input.max <= 0) ceilStyle()
      return facts
  }
}

type MathCallEvaluator = (name: string, values: NumberValue[], frame: InterpreterFrame, expression: ts.CallExpression) => Value
type UnaryNumberEvaluator = (value: NumberValue, frame: InterpreterFrame, name: string) => Value
type BinaryNumberEvaluator = (left: NumberValue, right: NumberValue, frame: InterpreterFrame, name: string) => Value
type MathDomainSpec = (name: string) => MathDomain

const mathCallEvaluators = new Map<string, MathCallEvaluator>([
  ['min', selectorMath('min')],
  ['max', selectorMath('max')],
  ['floor', unaryMath(floorNumber)],
  ['ceil', unaryMath(ceilNumber)],
  ['round', unaryMath(roundNumber)],
  ['trunc', unaryMath(truncNumber)],
  ['sqrt', unaryMath(sqrtNumber)],
  ['abs', unaryMath((value, frame) => absNumber(value, frame))],
  ['sign', unaryMath(signNumber)],
  ['pow', binaryMath(powerNumbers)],
  ['cbrt', unaryMath(monotoneMath(Math.cbrt))],
  ['fround', unaryMath(monotoneMath(Math.fround))],
  ['f16round', unaryMath(monotoneMath(Math.f16round))],
  ['clz32', unaryMath(clz32Number)],
  ['imul', binaryMath(imulNumber)],
  ['exp', unaryMath(monotoneMath(Math.exp))],
  ['expm1', unaryMath(monotoneMath(Math.expm1))],
  ['log', unaryMath(monotoneMath(Math.log, domainAtLeast(0, 'a non-negative number')))],
  ['log2', unaryMath(monotoneMath(Math.log2, domainAtLeast(0, 'a non-negative number')))],
  ['log10', unaryMath(monotoneMath(Math.log10, domainAtLeast(0, 'a non-negative number')))],
  ['log1p', unaryMath(monotoneMath(Math.log1p, domainAtLeast(-1, 'a number at least -1')))],
  ['asin', unaryMath(monotoneMath(Math.asin, domainBetween(-1, 1, 'a number between -1 and 1')))],
  ['acos', unaryMath(monotoneMath(Math.acos, domainBetween(-1, 1, 'a number between -1 and 1'), 'decreasing'))],
  ['atan', unaryMath(monotoneMath(Math.atan))],
  ['sinh', unaryMath(monotoneMath(Math.sinh))],
  ['asinh', unaryMath(monotoneMath(Math.asinh))],
  ['tanh', unaryMath(monotoneMath(Math.tanh))],
  ['acosh', unaryMath(monotoneMath(Math.acosh, domainAtLeast(1, 'a number at least 1')))],
  ['atanh', unaryMath(monotoneMath(Math.atanh, domainBetween(-1, 1, 'a number between -1 and 1')))],
  ['sin', unaryMath(boundedOutputMath(-1, 1))],
  ['cos', unaryMath(boundedOutputMath(-1, 1))],
  ['cosh', unaryMath(boundedOutputMath(1, Number.POSITIVE_INFINITY))],
])

function boundedOutputMath(min: number, max: number): UnaryNumberEvaluator {
  return (value, _frame, name) => numberValue(min, max, null, callExpr(`Math.${name}`, [value]))
}

function selectorMath(kind: 'min' | 'max'): MathCallEvaluator {
  return (_name, values, frame, expression) => {
    auditMathSelector(kind, values, frame, expression)
    return evaluateMathMinMax(kind, values, frame)
  }
}

function unaryMath(evaluate: UnaryNumberEvaluator): MathCallEvaluator {
  return (name, values, frame) => evaluateUnaryMath(name, values, value => evaluate(value, frame, name))
}

function binaryMath(evaluate: BinaryNumberEvaluator): MathCallEvaluator {
  return (name, values, frame) => evaluateBinaryMath(name, values, (left, right) => evaluate(left, right, frame, name))
}

function monotoneMath(
  evaluate: (value: number) => number,
  domain?: MathDomainSpec,
  direction: 'increasing' | 'decreasing' = 'increasing',
): UnaryNumberEvaluator {
  return (value, _frame, name) => monotoneNumber(name, value, evaluate, domain?.(name), direction)
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

function evaluateBinaryMath(name: string, values: NumberValue[], evaluate: (left: NumberValue, right: NumberValue) => Value): Value {
  if (values.length !== 2) return unknown(`Math.${name} expected two arguments`)
  const plain = evaluate(values[0]!, values[1]!)
  if (plain.kind !== 'number') return plain
  return withNumberCases(plain, combineNumberCases(values[0]!, values[1]!, evaluate))
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
  return roundingResult('floor', Math.floor, value)
}

function ceilNumber(value: NumberValue): NumberValue {
  return roundingResult('ceil', Math.ceil, value)
}

function roundNumber(value: NumberValue): NumberValue {
  return roundingResult('round', Math.round, value)
}

function truncNumber(value: NumberValue): NumberValue {
  return roundingResult('trunc', Math.trunc, value)
}

function roundingResult(name: 'floor' | 'ceil' | 'round' | 'trunc', apply: (n: number) => number, value: NumberValue): NumberValue {
  if (integerValued(value)) return numberValue(value.min, value.max, value.grid, value.expr, value.linear, null, value.origin)
  const expr = value.expr == null ? null : `${name}(${value.expr})`
  const linear = expr == null ? null : linearVariable(linearNameForExpression(expr))
  return numberValue(apply(value.min), apply(value.max), 0, expr, linear, null, value.origin)
}

function sqrtNumber(value: NumberValue): Value {
  if (value.min < 0) return unknown('Math.sqrt expected a non-negative number')
  return numberValue(Math.sqrt(value.min), Math.sqrt(value.max), null, value.expr == null ? null : `sqrt(${value.expr})`, null, null, value.origin)
}

type MathDomain = {
  min?: number
  max?: number
  message: string
}

function domainAtLeast(min: number, description: string): MathDomainSpec {
  return name => ({min, message: `Math.${name} expected ${description}`})
}

function domainBetween(min: number, max: number, description: string): MathDomainSpec {
  return name => ({min, max, message: `Math.${name} expected ${description}`})
}

function monotoneNumber(
  name: string,
  value: NumberValue,
  evaluate: (value: number) => number,
  domain?: MathDomain,
  direction: 'increasing' | 'decreasing' = 'increasing',
): Value {
  if (domain != null && !numberInDomain(value, domain)) return unknown(domain.message)
  const lowerArg = direction === 'increasing' ? value.min : value.max
  const upperArg = direction === 'increasing' ? value.max : value.min
  return numberValue(
    evaluate(lowerArg),
    evaluate(upperArg),
    null,
    callExpr(name, [value]),
    null,
    null,
    value.origin,
  )
}

function numberInDomain(value: NumberValue, domain: MathDomain | undefined): boolean {
  if (domain == null) return true
  if (domain.min != null && value.min < domain.min) return false
  if (domain.max != null && value.max > domain.max) return false
  return true
}

function clz32Number(value: NumberValue): NumberValue {
  const expr = callExpr('clz32', [value])
  if (value.min === value.max && Number.isFinite(value.min)) {
    const result = Math.clz32(value.min)
    return numberValue(result, result, 0, expr, null, null, value.origin)
  }
  return numberValue(0, 32, 0, expr, null, null, value.origin)
}

function imulNumber(left: NumberValue, right: NumberValue): NumberValue {
  const expr = callExpr('imul', [left, right])
  const origin = mergeOrigin(left, right)
  if (left.min === left.max && right.min === right.max && Number.isFinite(left.min) && Number.isFinite(right.min)) {
    const value = Math.imul(left.min, right.min)
    return numberValue(value, value, 0, expr, null, null, origin)
  }
  return numberValue(int32Min, int32Max, 0, expr, null, null, origin)
}

function absNumber(value: NumberValue, frame: InterpreterFrame): NumberValue {
  const plain = plainNumber(value)
  if (plain.min >= 0) return withNumberCases(plain, value.cases)
  if (plain.max <= 0) {
    const result = evaluateNumberUnary(value, current => numberValue(-current.max, -current.min, current.grid, current.expr == null ? null : `abs(${current.expr})`, linearScale(current.linear, -1), null, current.origin))
    return result.kind === 'number' ? result : numberValue(-plain.max, -plain.min, plain.grid, plain.expr == null ? null : `abs(${plain.expr})`, linearScale(plain.linear, -1), null, plain.origin)
  }

  const max = Math.max(Math.abs(plain.min), Math.abs(plain.max))
  const joined = numberValue(0, max, plain.grid, plain.expr == null ? null : `abs(${plain.expr})`, null, null, plain.origin)
  const cases: NumberCase[] = []
  for (const valueCase of numberBranches(value)) {
    const nonNegative = comparisonConstraint(valueCase.value, '>=', numberValue(0, 0, 0, '0', linearConstant(0)), undefined, 'branch')
    const nonPositive = comparisonConstraint(valueCase.value, '<=', numberValue(0, 0, 0, '0', linearConstant(0)), undefined, 'branch')
    if (nonNegative == null || nonPositive == null) return joined

    const positiveStatus = proveComparisonPlain(valueCase.value, '>=', numberValue(0, 0, 0, '0', linearConstant(0)), mergeAssumptions(frame.assumptions, valueCase.assumptions))
    const negativeStatus = proveComparisonPlain(valueCase.value, '<=', numberValue(0, 0, 0, '0', linearConstant(0)), mergeAssumptions(frame.assumptions, valueCase.assumptions))

    if (positiveStatus.status !== 'fail') {
      cases.push({
        value: valueCase.value,
        assumptions: positiveStatus.status === 'pass' ? valueCase.assumptions : mergeAssumptions(valueCase.assumptions, [nonNegative]),
      })
    }
    if (negativeStatus.status !== 'fail') {
      cases.push({
        value: numberValue(-valueCase.value.max, -valueCase.value.min, valueCase.value.grid, valueCase.value.expr == null ? null : `abs(${valueCase.value.expr})`, linearScale(valueCase.value.linear, -1), null, valueCase.value.origin),
        assumptions: negativeStatus.status === 'pass' ? valueCase.assumptions : mergeAssumptions(valueCase.assumptions, [nonPositive]),
      })
    }
    if (cases.length > maxNumberCases) return joined
  }
  return withNumberCases(joined, cases)
}

function signNumber(value: NumberValue): NumberValue {
  const expr = value.expr == null ? null : `sign(${value.expr})`
  if (value.min === 0 && value.max === 0) return numberValue(0, 0, 0, expr, null, null, value.origin)
  if (value.min > 0) return numberValue(1, 1, 0, expr, null, null, value.origin)
  if (value.max < 0) return numberValue(-1, -1, 0, expr, null, null, value.origin)
  if (value.min >= 0) return numberValue(0, 1, 0, expr, null, null, value.origin)
  if (value.max <= 0) return numberValue(-1, 0, 0, expr, null, null, value.origin)
  return numberValue(-1, 1, 0, expr, null, null, value.origin)
}

function minNumberPair(left: NumberValue, right: NumberValue, frame: InterpreterFrame): NumberValue {
  return choiceNumberPair('min', left, right, '<=', '<=', frame)
}

function maxNumberPair(left: NumberValue, right: NumberValue, frame: InterpreterFrame): NumberValue {
  return choiceNumberPair('max', left, right, '>=', '>=', frame)
}

function choiceNumberPair(
  name: 'min' | 'max',
  left: NumberValue,
  right: NumberValue,
  leftOp: ComparisonOperator,
  rightOp: ComparisonOperator,
  frame: InterpreterFrame,
): NumberValue {
  const assumptions = frame.assumptions
  const plainLeft = plainNumber(left)
  const plainRight = plainNumber(right)
  const expr = callExpr(name, [plainLeft, plainRight])
  const linear = expr == null ? null : linearVariable(linearNameForExpression(expr))
  const joined =
    name === 'min'
      ? numberValue(Math.min(plainLeft.min, plainRight.min), Math.min(plainLeft.max, plainRight.max), gridJoin(plainLeft.grid, plainRight.grid), expr, linear, null, mergeOrigin(plainLeft, plainRight))
      : numberValue(Math.max(plainLeft.min, plainRight.min), Math.max(plainLeft.max, plainRight.max), gridJoin(plainLeft.grid, plainRight.grid), expr, linear, null, mergeOrigin(plainLeft, plainRight))

  if (expr != null) {
    const op: ComparisonOperator = name === 'min' ? '<=' : '>='
    const leftFact = comparisonConstraint(joined, op, plainLeft, `${expr} ${op} ${plainLeft.expr ?? '?'}`)
    const rightFact = comparisonConstraint(joined, op, plainRight, `${expr} ${op} ${plainRight.expr ?? '?'}`)
    const facts: LinearConstraint[] = []
    if (leftFact != null) facts.push(leftFact)
    if (rightFact != null) facts.push(rightFact)
    if (facts.length > 0) frame.assumptions = mergeAssumptions(frame.assumptions, facts)
  }

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
