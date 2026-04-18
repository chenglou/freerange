import {type ComparisonOperator} from './parser.ts'
import {
  comparisonFailureReason,
  comparisonNeed,
  formatRange,
  rangeFailureReason,
} from './reporting.ts'
import {
  mergeAssumptions,
  numberBranches,
  numberValue,
  type ArrayValue,
  type FactSource,
  type LinearConstraint,
  type NumberValue,
  type ObjectValue,
  type UnknownValue,
  type Value,
} from './domain.ts'
import {
  binaryExpression,
  callArg,
  callArgs,
  ceilDivisionProduct,
  cleanLinear,
  floorDivision,
  isZeroLinear,
  linearConstant,
  linearConstantStatus,
  linearFromExpressionText,
  linearKey,
  linearScaleExact,
  linearSubtract,
  moduloExpression,
  positiveScaleMultiple,
  productFactors,
  productText,
  reductionScales,
  sameExpressionText,
  sameLinear,
  type LinearExpr,
} from './linear.ts'

export type Truth = 'true' | 'false' | 'maybe'

export type NonNegativeFact = {
  diff: LinearExpr
  strict: boolean
  text?: string
}

const maxLinearReductionDepth = 4

export function proveRange(value: Value, min: number, max: number, requireInteger: boolean, assumptions: LinearConstraint[] = []): {status: 'pass' | 'fail' | 'unknown'; reason?: string} {
  if (value.kind !== 'number') return {status: 'unknown', reason: nonNumberReason(value)}
  if (value.min < min || value.max > max) {
    const lower = proveComparison(value, '>=', numberValue(min, min, Number.isInteger(min), `${min}`, linearConstant(min)), assumptions)
    const upper = proveComparison(value, '<=', numberValue(max, max, Number.isInteger(max), `${max}`, linearConstant(max)), assumptions)
    if (lower.status === 'pass' && upper.status === 'pass' && (!requireInteger || value.isInteger)) return {status: 'pass'}
    return {
      status: 'fail',
      reason: rangeFailureReason(value, min, max, requireInteger, assumptions),
    }
  }
  if (requireInteger && !value.isInteger) return {status: 'fail', reason: `range was ${formatRange(value)}, expected integer\nneed: ${value.expr ?? formatRange(value)} to be integer`}
  return {status: 'pass'}
}

export function proveComparison(left: Value, op: ComparisonOperator, right: Value, assumptions: LinearConstraint[]): {status: 'pass' | 'fail' | 'unknown'; reason?: string} {
  if (left.kind !== 'number') return {status: 'unknown', reason: nonNumberReason(left)}
  if (right.kind !== 'number') return {status: 'unknown', reason: nonNumberReason(right)}
  if (left.cases != null || right.cases != null) {
    let unknownStatus: {status: 'pass' | 'fail' | 'unknown'; reason?: string} | null = null
    for (const leftCase of numberBranches(left)) {
      for (const rightCase of numberBranches(right)) {
        const status = proveComparisonPlain(
          leftCase.value,
          op,
          rightCase.value,
          mergeAssumptions(assumptions, leftCase.assumptions, rightCase.assumptions),
        )
        if (status.status === 'fail') return status
        if (status.status === 'unknown') unknownStatus = status
      }
    }
    return unknownStatus ?? {status: 'pass'}
  }
  return proveComparisonPlain(left, op, right, assumptions)
}

export function proveComparisonPlain(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): {status: 'pass' | 'fail' | 'unknown'; reason?: string} {
  if (op === '==' && left.expr != null && right.expr != null && left.expr === right.expr) return {status: 'pass'}
  const mathTruth = proveMathLemma(left, op, right, assumptions)
  if (mathTruth === 'true') return {status: 'pass'}
  const truth = compareRanges(left, op, right)
  if (truth === 'true') return {status: 'pass'}
  if (truth === 'false') return {status: 'fail', reason: comparisonFailureReason(left, op, right, assumptions, 'is false', missingComparisonFact(left, op, right, assumptions))}
  const linearTruth = compareLinear(left, op, right, assumptions)
  if (linearTruth === 'true') return {status: 'pass'}
  if (linearTruth === 'false') return {status: 'fail', reason: comparisonFailureReason(left, op, right, assumptions, 'is false by exact linear facts', missingComparisonFact(left, op, right, assumptions))}
  return {status: 'unknown', reason: comparisonFailureReason(left, op, right, assumptions, 'was not proven', missingComparisonFact(left, op, right, assumptions))}
}

function compareRanges(left: NumberValue, op: ComparisonOperator, right: NumberValue): Truth {
  switch (op) {
    case '==':
      if (left.min === left.max && right.min === right.max && left.min === right.min) return 'true'
      if (left.max < right.min || right.max < left.min) return 'false'
      return 'maybe'
    case '>=':
      if (left.min >= right.max) return 'true'
      if (left.max < right.min) return 'false'
      return 'maybe'
    case '<=':
      if (left.max <= right.min) return 'true'
      if (left.min > right.max) return 'false'
      return 'maybe'
    case '>':
      if (left.min > right.max) return 'true'
      if (left.max <= right.min) return 'false'
      return 'maybe'
    case '<':
      if (left.max < right.min) return 'true'
      if (left.min >= right.max) return 'false'
      return 'maybe'
  }
}

function proveMathLemma(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): Truth {
  if (left.expr == null || right.expr == null) return 'maybe'
  if (hasComparisonFact(left.expr, op, right.expr, assumptions)) return 'true'
  if (provesChoiceOperandBound(left.expr, op, right.expr)) return 'true'
  if (provesRoundingFact(left.expr, op, right.expr)) return 'true'
  if ((op === '>=' || op === '>') && provesCeilDivisionCovers(left.expr, right.expr, assumptions)) return op === '>=' ? 'true' : 'maybe'
  if ((op === '<' || op === '<=') && provesFloorDivisionBelowCount(left.expr, right, assumptions)) return 'true'
  if ((op === '<' || op === '<=') && provesModuloBelowDivisor(left.expr, right.expr, assumptions)) return 'true'
  if ((op === '>=' || op === '>') && provesRunningSumAtLeastStart(left.expr, right.expr, assumptions)) return op === '>=' ? 'true' : 'maybe'
  if ((op === '>=' || op === '>') && provesRunningSumMinusTrailingGapAtLeastStart(left.expr, right.expr, assumptions)) return op === '>=' ? 'true' : 'maybe'
  if (provesPositiveMonotone(left.expr, op, right.expr, assumptions)) return 'true'
  return 'maybe'
}

function provesChoiceOperandBound(leftExpr: string, op: ComparisonOperator, rightExpr: string) {
  if (op === '<=') {
    if (choiceHasOperand(leftExpr, 'min', rightExpr)) return true
    if (choiceHasOperand(rightExpr, 'max', leftExpr)) return true
  }
  if (op === '>=') {
    if (choiceHasOperand(leftExpr, 'max', rightExpr)) return true
    if (choiceHasOperand(rightExpr, 'min', leftExpr)) return true
  }
  return false
}

function choiceHasOperand(choiceExpr: string, choiceName: 'min' | 'max', operandExpr: string) {
  const args = callArgs(choiceExpr, choiceName)
  return args != null && args.some(arg => sameExpressionText(arg, operandExpr))
}

function provesRoundingFact(leftExpr: string, op: ComparisonOperator, rightExpr: string) {
  const leftCeil = callArg(leftExpr, 'ceil')
  if ((op === '>=' || op === '>') && leftCeil != null && sameExpressionText(leftCeil, rightExpr)) return op === '>='
  const leftFloor = callArg(leftExpr, 'floor')
  if ((op === '<=' || op === '<') && leftFloor != null && sameExpressionText(leftFloor, rightExpr)) return op === '<='
  const rightCeil = callArg(rightExpr, 'ceil')
  if ((op === '<=' || op === '<') && rightCeil != null && sameExpressionText(leftExpr, rightCeil)) return op === '<='
  const rightFloor = callArg(rightExpr, 'floor')
  if ((op === '>=' || op === '>') && rightFloor != null && sameExpressionText(leftExpr, rightFloor)) return op === '>='
  return false
}

function provesCeilDivisionCovers(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const shape = ceilDivisionProduct(leftExpr)
  if (shape == null) return false
  const {total, count} = shape
  if (!sameExpressionText(total, rightExpr)) return false
  return provesExprNonNegative(total, false, assumptions) && provesExprNonNegative(count, true, assumptions)
}

function provesFloorDivisionBelowCount(leftExpr: string, right: NumberValue, assumptions: LinearConstraint[]) {
  if (right.expr == null || !right.isInteger) return false
  const shape = floorDivision(leftExpr)
  if (shape == null) return false
  const {left: pointer, right: cell} = shape
  if (!provesExprNonNegative(cell, true, assumptions)) return false
  return hasComparisonFact(pointer, '<', `(${right.expr} * ${cell})`, assumptions) || hasComparisonFact(pointer, '<', `(${cell} * ${right.expr})`, assumptions)
}

function provesModuloBelowDivisor(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const shape = moduloExpression(leftExpr)
  if (shape == null || !sameExpressionText(shape.right, rightExpr)) return false
  return provesExprNonNegative(shape.left, false, assumptions) && provesExprNonNegative(shape.right, true, assumptions)
}

function provesRunningSumAtLeastStart(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const args = callArgs(leftExpr, 'runningSum')
  if (args == null || args.length !== 3 || !sameExpressionText(args[0]!, rightExpr)) return false
  return provesExprNonNegative(args[1]!, false, assumptions) && provesExprNonNegative(args[2]!, false, assumptions)
}

function provesRunningSumMinusTrailingGapAtLeastStart(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const trailingGap = binaryExpression(leftExpr, '-')
  if (trailingGap == null) return false
  const args = callArgs(trailingGap.left, 'runningSum')
  if (args == null || args.length !== 3 || !sameExpressionText(args[0]!, rightExpr)) return false
  const count = args[1]!
  const increment = args[2]!
  const gap = trailingGap.right
  if (!hasComparisonFact(count, '>=', '1', assumptions)) return false
  if (!provesExprNonNegative(gap, false, assumptions)) return false
  if (sameExpressionText(increment, gap)) return true
  const incrementSum = binaryExpression(increment, '+')
  if (incrementSum == null) return false
  const base =
    sameExpressionText(incrementSum.left, gap) ? incrementSum.right
      : sameExpressionText(incrementSum.right, gap) ? incrementSum.left
        : null
  return base != null && provesExprNonNegative(base, false, assumptions)
}

function provesPositiveMonotone(leftExpr: string, op: ComparisonOperator, rightExpr: string, assumptions: LinearConstraint[]) {
  if (op === '<=' || op === '<') return provesPositiveMonotoneLess(leftExpr, op, rightExpr, assumptions)
  if (op === '>=') return provesPositiveMonotoneLess(rightExpr, '<=', leftExpr, assumptions)
  if (op === '>') return provesPositiveMonotoneLess(rightExpr, '<', leftExpr, assumptions)
  return false
}

function provesPositiveMonotoneLess(leftExpr: string, op: '<=' | '<', rightExpr: string, assumptions: LinearConstraint[]) {
  return positiveMonotoneObligations(leftExpr, op, rightExpr, assumptions)
    .some(obligation => obligation.factorProven && obligation.baseProven)
}

function provesExprNonNegative(expression: string, strict: boolean, assumptions: LinearConstraint[]) {
  const linear = linearFromExpressionText(expression)
  return linear != null && provesNonNegative(linear, strict, assumptions)
}

function hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string, assumptions: LinearConstraint[]) {
  for (const assumption of assumptions) {
    if (assumption.leftExpr == null || assumption.rightExpr == null) continue
    if (sameExpressionText(assumption.leftExpr, leftExpr) && sameExpressionText(assumption.rightExpr, rightExpr) && comparisonImplies(assumption.op, op)) return true
    if (sameExpressionText(assumption.leftExpr, rightExpr) && sameExpressionText(assumption.rightExpr, leftExpr) && comparisonImplies(flipComparison(assumption.op), op)) return true
  }

  const leftLinear = linearFromExpressionText(leftExpr)
  const rightLinear = linearFromExpressionText(rightExpr)
  if (leftLinear == null || rightLinear == null) return false
  return compareLinear(
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, leftExpr, leftLinear),
    op,
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, rightExpr, rightLinear),
    assumptions,
  ) === 'true'
}

function comparisonImplies(actual: ComparisonOperator, needed: ComparisonOperator) {
  if (actual === needed) return true
  if (actual === '==') return needed === '>=' || needed === '<='
  if (actual === '>') return needed === '>='
  if (actual === '<') return needed === '<='
  return false
}

export function flipComparison(op: ComparisonOperator): ComparisonOperator {
  switch (op) {
    case '==':
      return '=='
    case '>=':
      return '<='
    case '<=':
      return '>='
    case '>':
      return '<'
    case '<':
      return '>'
  }
}

function missingComparisonFact(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]) {
  const strictSelf = strictSelfComparisonMissing(left, op, right)
  if (strictSelf != null) return strictSelf
  const missingMonotone = missingPositiveMonotoneFact(left, op, right, assumptions)
  if (missingMonotone != null) return missingMonotone
  const missingLinear = missingLinearFact(left, op, right, assumptions)
  if (missingLinear != null) return missingLinear
  return `given ${comparisonNeed(left, op, right)}`
}

function strictSelfComparisonMissing(left: NumberValue, op: ComparisonOperator, right: NumberValue) {
  if (op !== '>' && op !== '<') return null
  const leftName = left.expr ?? formatRange(left)
  const rightName = right.expr ?? formatRange(right)
  if (left.expr != null && right.expr != null && sameExpressionText(left.expr, right.expr)) {
    return `strict comparison cannot hold when both sides are ${leftName}`
  }
  if (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear)) {
    return `strict comparison cannot hold because ${leftName} and ${rightName} are equal by exact linear facts`
  }
  return null
}

function missingLinearFact(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]) {
  const diff = comparisonDiff(left, op, right)
  if (diff == null) return null
  const target = cleanLinear(diff)
  for (const fact of assumptions.filter(assumption => assumption.rangeFact !== true).flatMap(nonNegativeFacts)) {
    for (const scale of reductionScales(target, fact.diff)) {
      const scaledFact = linearScaleExact(fact.diff, scale)
      const remainder = linearSubtract(target, scaledFact)
      if (remainder == null || sameLinear(remainder, target)) continue
      const missing = singleLinearBound(remainder)
      if (missing != null) return missing
    }
  }
  return null
}

function missingPositiveMonotoneFact(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]) {
  if (left.expr == null || right.expr == null) return null
  if (op === '<=' || op === '<') return missingPositiveMonotoneLess(left.expr, op, right.expr, assumptions)
  if (op === '>=') return missingPositiveMonotoneLess(right.expr, '<=', left.expr, assumptions)
  if (op === '>') return missingPositiveMonotoneLess(right.expr, '<', left.expr, assumptions)
  return null
}

function missingPositiveMonotoneLess(leftExpr: string, op: '<=' | '<', rightExpr: string, assumptions: LinearConstraint[]) {
  for (const obligation of positiveMonotoneObligations(leftExpr, op, rightExpr, assumptions)) {
    const missing = monotoneMissing(obligation)
    if (missing != null) return missing
  }
  return null
}

type PositiveMonotoneObligation = {
  factorNeed: string
  factorProven: boolean
  baseNeed: string
  baseProven: boolean
}

function positiveMonotoneObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, assumptions: LinearConstraint[]) {
  return [
    ...positiveDivisionObligations(leftExpr, op, rightExpr, assumptions),
    ...positiveProductObligations(leftExpr, op, rightExpr, assumptions),
  ]
}

function positiveDivisionObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, assumptions: LinearConstraint[]): PositiveMonotoneObligation[] {
  const leftDivision = binaryExpression(leftExpr, '/')
  const rightDivision = binaryExpression(rightExpr, '/')
  if (leftDivision == null || rightDivision == null || !sameExpressionText(leftDivision.right, rightDivision.right)) return []
  return [{
    factorNeed: `${leftDivision.right} > 0`,
    factorProven: provesExprNonNegative(leftDivision.right, true, assumptions),
    baseNeed: `${leftDivision.left} ${op} ${rightDivision.left}`,
    baseProven: hasComparisonFact(leftDivision.left, op, rightDivision.left, assumptions),
  }]
}

function positiveProductObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, assumptions: LinearConstraint[]): PositiveMonotoneObligation[] {
  const leftProduct = productFactors(leftExpr)
  const rightProduct = productFactors(rightExpr)
  if (leftProduct == null || rightProduct == null) return []
  const obligations: PositiveMonotoneObligation[] = []
  for (let leftIndex = 0; leftIndex < leftProduct.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < rightProduct.length; rightIndex++) {
      const leftFactor = leftProduct[leftIndex]!
      const rightFactor = rightProduct[rightIndex]!
      if (!sameExpressionText(leftFactor, rightFactor)) continue
      const leftBase = productText(leftProduct.filter((_, index) => index !== leftIndex))
      const rightBase = productText(rightProduct.filter((_, index) => index !== rightIndex))
      obligations.push({
        factorNeed: `${leftFactor} ${op === '<' ? '>' : '>='} 0`,
        factorProven: provesExprNonNegative(leftFactor, op === '<', assumptions),
        baseNeed: `${leftBase} ${op} ${rightBase}`,
        baseProven: hasComparisonFact(leftBase, op, rightBase, assumptions),
      })
    }
  }
  return obligations
}

function monotoneMissing(obligation: PositiveMonotoneObligation) {
  if (obligation.factorProven && obligation.baseProven) return null
  if (obligation.baseProven) return obligation.factorNeed
  if (obligation.factorProven) return obligation.baseNeed
  return `${obligation.factorNeed} and ${obligation.baseNeed}`
}

function comparisonDiff(left: NumberValue, op: ComparisonOperator, right: NumberValue): LinearExpr | null {
  switch (op) {
    case '==':
      return null
    case '>=':
    case '>':
      return linearSubtract(left.linear, right.linear)
    case '<=':
    case '<':
      return linearSubtract(right.linear, left.linear)
  }
}

function singleLinearBound(linear: LinearExpr) {
  const clean = cleanLinear(linear)
  if (clean.constant !== 0 || clean.terms.size !== 1) return null
  const first = [...clean.terms.entries()][0]
  if (first == null) return null
  const [name, coefficient] = first
  if (coefficient === 0) return null
  return coefficient > 0 ? `${name} >= 0` : `${name} <= 0`
}

export function comparisonConstraint(left: NumberValue, op: ComparisonOperator, right: NumberValue, text?: string, source: FactSource = 'code'): LinearConstraint | null {
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null && left.expr == null && right.expr == null && text == null) return null
  return {
    diff,
    op,
    source,
    ...(left.expr == null ? {} : {leftExpr: left.expr}),
    ...(right.expr == null ? {} : {rightExpr: right.expr}),
    ...(text == null ? {} : {text}),
  }
}

export function rangeFactsFromValue(value: Value, min: number, max: number, text: string, source: FactSource): LinearConstraint[] {
  if (value.kind !== 'number') return []
  const minDiff = linearSubtract(value.linear, linearConstant(min))
  const maxDiff = linearSubtract(linearConstant(max), value.linear)
  const facts: LinearConstraint[] = []
  if (minDiff != null) facts.push({diff: minDiff, op: '>=', text, source, rangeFact: true})
  if (maxDiff != null) facts.push({diff: maxDiff, op: '>=', text, source, rangeFact: true})
  return facts
}

function compareLinear(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): Truth {
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null) return 'maybe'

  switch (op) {
    case '==':
      if (isZeroLinear(diff)) return 'true'
      return provesNonNegative(diff, false, assumptions) && provesNonNegative(linearScaleExact(diff, -1), false, assumptions) ? 'true' : 'maybe'
    case '>=':
      return provesNonNegative(diff, false, assumptions) ? 'true' : 'maybe'
    case '<=':
      return provesNonNegative(linearScaleExact(diff, -1), false, assumptions) ? 'true' : 'maybe'
    case '>':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(diff, true, assumptions) ? 'true' : 'maybe'
    case '<':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(linearScaleExact(diff, -1), true, assumptions) ? 'true' : 'maybe'
  }
}

function provesNonNegative(diff: LinearExpr, strict: boolean, assumptions: LinearConstraint[]) {
  const facts = assumptions.flatMap(nonNegativeFacts)
  return proveNonNegativeFromFacts(diff, strict, facts)
}

export function proveNonNegativeFromFacts(diff: LinearExpr, strict: boolean, facts: NonNegativeFact[]) {
  return reduceToNonNegative(diff, strict, facts, maxLinearReductionDepth, new Set())
}

function reduceToNonNegative(
  diff: LinearExpr,
  strict: boolean,
  facts: NonNegativeFact[],
  depth: number,
  seen: Set<string>,
): boolean {
  const cleanDiff = cleanLinear(diff)
  if (linearConstantStatus(cleanDiff, strict)) return true
  for (const fact of facts) {
    const scale = positiveScaleMultiple(cleanDiff, fact.diff)
    if (scale != null && (!strict || fact.strict)) return true
  }
  if (depth === 0) return false

  const key = `${strict ? 'strict' : 'loose'}:${linearKey(cleanDiff)}`
  if (seen.has(key)) return false
  seen.add(key)

  for (const fact of facts) {
    for (const scale of reductionScales(cleanDiff, fact.diff)) {
      const scaledFact = linearScaleExact(fact.diff, scale)
      const remainder = linearSubtract(cleanDiff, scaledFact)
      if (remainder == null || sameLinear(remainder, cleanDiff)) continue
      if (reduceToNonNegative(remainder, strict && !fact.strict, facts, depth - 1, new Set(seen))) return true
    }
  }
  return false
}

export function nonNegativeFacts(assumption: LinearConstraint): NonNegativeFact[] {
  if (assumption.diff == null) return []
  switch (assumption.op) {
    case '==':
      return [
        nonNegativeFact(assumption.diff, false, assumption.text),
        nonNegativeFact(linearScaleExact(assumption.diff, -1), false, assumption.text == null ? undefined : `${assumption.text} reversed`),
      ]
    case '>=':
      return [nonNegativeFact(assumption.diff, false, assumption.text)]
    case '<=':
      return [nonNegativeFact(linearScaleExact(assumption.diff, -1), false, assumption.text)]
    case '>':
      return [nonNegativeFact(assumption.diff, true, assumption.text)]
    case '<':
      return [nonNegativeFact(linearScaleExact(assumption.diff, -1), true, assumption.text)]
  }
}

function nonNegativeFact(diff: LinearExpr, strict: boolean, text?: string): NonNegativeFact {
  return {diff, strict, ...(text == null ? {} : {text})}
}

function nonNumberReason(value: ObjectValue | ArrayValue | UnknownValue) {
  if (value.kind === 'unknown') return value.reason
  return value.kind === 'array' ? 'Expected a number, got an array' : 'Expected a number, got an object'
}

export function conditionalRunningSumFacts(value: NumberValue, start: NumberValue, count: NumberValue, increment: NumberValue): LinearConstraint[] {
  const facts: LinearConstraint[] = []
  if (increment.min >= 0) {
    const lower = comparisonConstraint(value, '>=', start, `${value.expr ?? formatRange(value)} >= ${start.expr ?? formatRange(start)}`)
    if (lower != null) facts.push(lower)
  }
  if (increment.max <= 0) {
    const upper = comparisonConstraint(value, '<=', start, `${value.expr ?? formatRange(value)} <= ${start.expr ?? formatRange(start)}`)
    if (upper != null) facts.push(upper)
  }
  if (start.min === 0 && start.max === 0 && increment.min === 1 && increment.max === 1) {
    const upper = comparisonConstraint(value, '<=', count, `${value.expr ?? formatRange(value)} <= ${count.expr ?? formatRange(count)}`)
    if (upper != null) facts.push(upper)
  }
  return facts
}
