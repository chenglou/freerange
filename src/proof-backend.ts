import {
  publicFitText,
  type ComparisonOperator,
} from './parser.ts'
import {
  type LinearConstraint,
  type NumberValue,
} from './domain.ts'
import {
  binaryExpression,
  callArg,
  callArgs,
  ceilDivisionProduct,
  expressionKeyFromText,
  floorDivision,
  moduloExpression,
  productFactors,
  productText,
  sameExpressionText,
} from './linear.ts'

export type ComparisonGoal = {
  left: NumberValue
  op: ComparisonOperator
  right: NumberValue
}

export type ProofBackendContext = {
  assumptions: LinearConstraint[]
  hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string): boolean
  provesExprNonNegative(expression: string, strict: boolean): boolean
}

export type ProofBackendResult =
  | {status: 'pass'; rule: string; message: string}
  | {status: 'blocked'; rule: string; message: string; missing: string}

type ComparisonGraphEdge = {
  to: string
  strict: boolean
}

export function evaluateBackendComparison(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  if (context.hasComparisonFact(goal.left.expr, goal.op, goal.right.expr)) return pass('comparison-fact', 'matched a known comparison fact')

  let blockedResult: ProofBackendResult | null = null
  for (const rule of comparisonProofRules) {
    const result = rule(goal, context)
    if (result?.status === 'pass') return result
    if (result?.status === 'blocked' && blockedResult == null) blockedResult = result
  }

  return blockedResult
}

export function backendComparisonMissing(goal: ComparisonGoal, context: ProofBackendContext): string | null {
  const result = evaluateBackendComparison(goal, context)
  return result?.status === 'blocked' ? result.missing : null
}

export function symbolicComparisonProves(leftExpr: string, op: ComparisonOperator, rightExpr: string, assumptions: LinearConstraint[]) {
  const graph = comparisonGraph(assumptions)
  if (op === '==') {
    return comparisonGraphPath(graph, leftExpr, rightExpr, false)
      && comparisonGraphPath(graph, rightExpr, leftExpr, false)
  }
  if (op === '<=' || op === '<') return comparisonGraphPath(graph, leftExpr, rightExpr, op === '<')
  return comparisonGraphPath(graph, rightExpr, leftExpr, op === '>')
}

function comparisonGraphPath(graph: Map<string, ComparisonGraphEdge[]>, fromExpr: string, toExpr: string, needsStrict: boolean) {
  if (sameExpressionText(fromExpr, toExpr)) return !needsStrict
  const start = expressionKeyFromText(fromExpr)
  const target = expressionKeyFromText(toExpr)
  const queue: {key: string; strict: boolean}[] = [{key: start, strict: false}]
  const seen = new Set<string>()

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!
    const seenKey = `${current.key}:${current.strict ? 'strict' : 'loose'}`
    if (seen.has(seenKey)) continue
    seen.add(seenKey)
    for (const edge of graph.get(current.key) ?? []) {
      const strict = current.strict || edge.strict
      if (edge.to === target && (!needsStrict || strict)) return true
      queue.push({key: edge.to, strict})
    }
  }
  return false
}

function comparisonGraph(assumptions: LinearConstraint[]) {
  const graph = new Map<string, ComparisonGraphEdge[]>()
  for (const assumption of assumptions) {
    if (assumption.leftExpr == null || assumption.rightExpr == null) continue
    addComparisonGraphEdges(graph, assumption.leftExpr, assumption.op, assumption.rightExpr)
  }
  return graph
}

function addComparisonGraphEdges(graph: Map<string, ComparisonGraphEdge[]>, leftExpr: string, op: ComparisonOperator, rightExpr: string) {
  switch (op) {
    case '==':
      addComparisonGraphEdge(graph, leftExpr, rightExpr, false)
      addComparisonGraphEdge(graph, rightExpr, leftExpr, false)
      return
    case '<=':
      addComparisonGraphEdge(graph, leftExpr, rightExpr, false)
      return
    case '<':
      addComparisonGraphEdge(graph, leftExpr, rightExpr, true)
      return
    case '>=':
    case '>':
      addComparisonGraphEdges(graph, rightExpr, reverseComparison(op), leftExpr)
      return
  }
}

function reverseComparison(op: '>=' | '>'): '<=' | '<' {
  return op === '>=' ? '<=' : '<'
}

function addComparisonGraphEdge(graph: Map<string, ComparisonGraphEdge[]>, fromExpr: string, toExpr: string, strict: boolean) {
  const from = expressionKeyFromText(fromExpr)
  const to = expressionKeyFromText(toExpr)
  if (from === to) return
  const edges = graph.get(from) ?? []
  if (!edges.some(edge => edge.to === to && edge.strict === strict)) edges.push({to, strict})
  graph.set(from, edges)
}

type ComparisonProofRule = (goal: ComparisonGoal, context: ProofBackendContext) => ProofBackendResult | null

const comparisonProofRules: ComparisonProofRule[] = [
  evaluateChoiceOperandBound,
  evaluateRoundingLossBound,
  evaluateRoundingMonotonicity,
  evaluateModuloBelowDivisor,
  evaluateScaleMonotonicity,
  evaluateFloorDivisionBelowCount,
  evaluateCeilDivisionCoversTotal,
  evaluateSimplifiedComparison,
]

type LessComparisonGoal = {
  left: NumberValue
  leftExpr: string
  op: '<=' | '<'
  right: NumberValue
  rightExpr: string
}

type ComparisonReduction = {
  left: string
  op: '<=' | '<'
  right: string
  reason: string
  rule: string
}

type RoundingFunctionName = 'floor' | 'ceil' | 'round' | 'trunc'
type RoundingCall = {name: RoundingFunctionName; arg: string}
type RoundingCallWithOffset = RoundingCall & {offset: number}

function evaluateSimplifiedComparison(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  const lessGoal = comparisonLessGoal(goal)
  if (lessGoal == null) return null

  const reductions = comparisonReductions(lessGoal)
  if (reductions.length === 0) return null

  for (const reduction of reductions) {
    if (context.hasComparisonFact(reduction.left, reduction.op, reduction.right)) {
      return pass(reduction.rule, reduction.reason)
    }
  }

  const first = reductions[0]!
  return blocked(first.rule, `${publicFitText(first.left)} ${first.op} ${publicFitText(first.right)}`, first.reason)
}

function comparisonReductions(goal: LessComparisonGoal): ComparisonReduction[] {
  return [
    ...lowerRoundingReductions(goal),
    ...upperRoundingReductions(goal),
  ]
}

function lowerRoundingReductions(goal: LessComparisonGoal): ComparisonReduction[] {
  const lower = roundingCall(goal.leftExpr)
  if (lower == null) return []
  const right = goal.rightExpr

  switch (lower.name) {
    case 'floor':
      return goal.right.isInteger
        ? [{left: lower.arg, op: '<', right: goal.op === '<' ? right : offsetExpression(right, 1), rule: 'rounding-simplification', reason: 'simplified comparison through floor bounds'}]
        : [{left: lower.arg, op: goal.op, right, rule: 'rounding-simplification', reason: 'simplified comparison through floor bounds'}]
    case 'ceil':
      return goal.right.isInteger
        ? [{left: lower.arg, op: '<=', right: goal.op === '<' ? offsetExpression(right, -1) : right, rule: 'rounding-simplification', reason: 'simplified comparison through integer ceil bounds'}]
        : []
    case 'round':
      return goal.right.isInteger
        ? [{left: lower.arg, op: '<', right: offsetExpression(right, goal.op === '<' ? -0.5 : 0.5), rule: 'rounding-simplification', reason: 'simplified comparison through round half-unit bounds'}]
        : []
    case 'trunc':
      return []
  }
}

function upperRoundingReductions(goal: LessComparisonGoal): ComparisonReduction[] {
  if (!goal.left.isInteger) return []
  const upper = roundingCall(goal.rightExpr)
  if (upper == null) return []
  const left = goal.leftExpr

  switch (upper.name) {
    case 'floor':
      return [{left: goal.op === '<' ? offsetExpression(left, 1) : left, op: '<=', right: upper.arg, rule: 'rounding-simplification', reason: 'simplified comparison through integer floor bounds'}]
    case 'ceil':
      return [{left: goal.op === '<' ? left : offsetExpression(left, -1), op: '<', right: upper.arg, rule: 'rounding-simplification', reason: 'simplified comparison through ceil bounds'}]
    case 'round':
      return [{left: offsetExpression(left, goal.op === '<' ? 0.5 : -0.5), op: '<=', right: upper.arg, rule: 'rounding-simplification', reason: 'simplified comparison through round half-unit bounds'}]
    case 'trunc':
      return []
  }
}

function roundingCall(expression: string): RoundingCall | null {
  for (const name of roundingFunctionNames) {
    const arg = callArg(expression, name)
    if (arg != null) return {name, arg}
  }
  return null
}

const roundingFunctionNames = ['floor', 'ceil', 'round', 'trunc'] as const

function evaluateChoiceOperandBound(goal: ComparisonGoal): ProofBackendResult | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  if (goal.op === '<=') {
    if (choiceHasOperand(goal.left.expr, 'min', goal.right.expr)) return pass('choice-operand-bound', 'choice result is bounded by a selected operand')
    if (choiceHasOperand(goal.right.expr, 'max', goal.left.expr)) return pass('choice-operand-bound', 'choice result is bounded by a selected operand')
  }
  if (goal.op === '>=') {
    if (choiceHasOperand(goal.left.expr, 'max', goal.right.expr)) return pass('choice-operand-bound', 'choice result is bounded by a selected operand')
    if (choiceHasOperand(goal.right.expr, 'min', goal.left.expr)) return pass('choice-operand-bound', 'choice result is bounded by a selected operand')
  }
  return null
}

function choiceHasOperand(choiceExpr: string, choiceName: 'min' | 'max', operandExpr: string) {
  const args = callArgs(choiceExpr, choiceName)
  return args != null && args.some(arg => sameExpressionText(arg, operandExpr))
}

function evaluateRoundingLossBound(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  const lessGoal = comparisonLessGoal(goal)
  return lessGoal == null ? null : roundingLossDirectStatus(lessGoal, context)
}

function roundingLossDirectStatus(goal: LessComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  const offsetStatus = roundingOffsetLossStatus(goal, context)
  if (offsetStatus != null) return offsetStatus

  const left = roundingCall(goal.leftExpr)
  if (left != null) {
    if (roundingUpperLossProves(left, goal.op, goal.rightExpr, context)) return passRoundingLossBound()
    const missing = roundingUpperLossMissing(left, goal.rightExpr, context)
    if (missing != null) return blockedRoundingLossBound(missing)
  }

  const right = roundingCall(goal.rightExpr)
  if (right != null) {
    if (roundingLowerLossProves(goal.leftExpr, goal.op, right, context)) return passRoundingLossBound()
    const missing = roundingLowerLossMissing(goal.leftExpr, right, context)
    if (missing != null) return blockedRoundingLossBound(missing)
  }

  return null
}

function roundingOffsetLossStatus(goal: LessComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  const right = roundingCallWithOffset(goal.rightExpr)
  if (right != null) {
    if (right.name === 'floor' && right.offset === 1 && sameExpressionText(goal.leftExpr, right.arg)) {
      return passRoundingLossBound()
    }
    if (right.name === 'round' && right.offset === 0.5 && sameExpressionText(goal.leftExpr, right.arg)) {
      return passRoundingLossBound()
    }
    if (right.name === 'trunc' && right.offset === 1 && sameExpressionText(goal.leftExpr, right.arg)) {
      return context.provesExprNonNegative(right.arg, false)
        ? passRoundingLossBound()
        : blockedRoundingLossBound(`${publicFitText(right.arg)} >= 0`)
    }
  }

  const left = roundingCallWithOffset(goal.leftExpr)
  if (left != null && left.name === 'ceil' && left.offset === -1 && sameExpressionText(goal.rightExpr, left.arg)) {
    return passRoundingLossBound()
  }
  if (left != null && left.name === 'round' && left.offset === -0.5 && sameExpressionText(goal.rightExpr, left.arg) && goal.op === '<=') {
    return passRoundingLossBound()
  }

  return null
}

function roundingCallWithOffset(expression: string): RoundingCallWithOffset | null {
  const shape = expressionWithConstantOffset(expression)
  const call = roundingCall(shape.base)
  return call == null ? null : {...call, offset: shape.offset}
}

function roundingUpperLossProves(rounding: RoundingCall, op: '<=' | '<', rightExpr: string, context: ProofBackendContext) {
  switch (rounding.name) {
    case 'floor':
      return nonStrictLawProvesGoal(op) && sameExpressionText(rightExpr, rounding.arg)
        || strictLawProvesGoal(op) && sameExpressionWithOffset(rightExpr, roundingCallText(rounding), 1)
    case 'ceil':
      return strictLawProvesGoal(op) && sameExpressionWithOffset(rightExpr, rounding.arg, 1)
    case 'round':
      return nonStrictLawProvesGoal(op) && sameExpressionWithOffset(rightExpr, rounding.arg, 0.5)
    case 'trunc':
      if (nonStrictLawProvesGoal(op) && sameExpressionText(rightExpr, rounding.arg)) return context.provesExprNonNegative(rounding.arg, false)
      if (strictLawProvesGoal(op) && sameExpressionWithOffset(rightExpr, rounding.arg, 1)) return context.hasComparisonFact(rounding.arg, '<=', '0')
      if (nonStrictLawProvesGoal(op) && sameExpressionText(rightExpr, '0')) return context.hasComparisonFact(rounding.arg, '<=', '0')
      return false
  }
}

function roundingUpperLossMissing(rounding: RoundingCall, rightExpr: string, context: ProofBackendContext) {
  if (rounding.name !== 'trunc') return null
  if (sameExpressionText(rightExpr, rounding.arg) && !context.provesExprNonNegative(rounding.arg, false)) return `${publicFitText(rounding.arg)} >= 0`
  if (sameExpressionWithOffset(rightExpr, rounding.arg, 1) && !context.hasComparisonFact(rounding.arg, '<=', '0')) return `${publicFitText(rounding.arg)} <= 0`
  if (sameExpressionText(rightExpr, '0') && !context.hasComparisonFact(rounding.arg, '<=', '0')) return `${publicFitText(rounding.arg)} <= 0`
  return null
}

function roundingLowerLossProves(leftExpr: string, op: '<=' | '<', rounding: RoundingCall, context: ProofBackendContext) {
  switch (rounding.name) {
    case 'floor':
      return strictLawProvesGoal(op) && sameExpressionWithOffset(leftExpr, rounding.arg, -1)
    case 'ceil':
      return nonStrictLawProvesGoal(op) && sameExpressionText(leftExpr, rounding.arg)
    case 'round':
      return nonStrictLawProvesGoal(op) && sameExpressionWithOffset(leftExpr, rounding.arg, -0.5)
    case 'trunc':
      if (nonStrictLawProvesGoal(op) && sameExpressionText(leftExpr, rounding.arg)) return context.hasComparisonFact(rounding.arg, '<=', '0')
      if (strictLawProvesGoal(op) && sameExpressionWithOffset(leftExpr, rounding.arg, -1)) return context.provesExprNonNegative(rounding.arg, false)
      if (nonStrictLawProvesGoal(op) && sameExpressionText(leftExpr, '0')) return context.provesExprNonNegative(rounding.arg, false)
      return false
  }
}

function roundingLowerLossMissing(leftExpr: string, rounding: RoundingCall, context: ProofBackendContext) {
  if (rounding.name !== 'trunc') return null
  if (sameExpressionText(leftExpr, rounding.arg) && !context.hasComparisonFact(rounding.arg, '<=', '0')) return `${publicFitText(rounding.arg)} <= 0`
  if (sameExpressionWithOffset(leftExpr, rounding.arg, -1) && !context.provesExprNonNegative(rounding.arg, false)) return `${publicFitText(rounding.arg)} >= 0`
  if (sameExpressionText(leftExpr, '0') && !context.provesExprNonNegative(rounding.arg, false)) return `${publicFitText(rounding.arg)} >= 0`
  return null
}

function roundingCallText(rounding: RoundingCall) {
  return `${rounding.name}(${rounding.arg})`
}

function passRoundingLossBound() {
  return pass('rounding-loss-bound', 'rounding result stays within its source-side loss bound')
}

function blockedRoundingLossBound(missing: string) {
  return blocked('rounding-loss-bound', missing, 'rounding result stays within its source-side loss bound')
}

function nonStrictLawProvesGoal(op: '<=' | '<') {
  return op === '<='
}

function strictLawProvesGoal(op: '<=' | '<') {
  return op === '<' || op === '<='
}

function sameExpressionWithOffset(expression: string, base: string, offset: number) {
  const shape = expressionWithConstantOffset(expression)
  return shape.offset === offset && sameExpressionText(shape.base, base)
}

function expressionWithConstantOffset(expression: string): {base: string; offset: number} {
  const plus = binaryExpression(expression, '+')
  if (plus != null) {
    const right = numericTextValue(plus.right)
    if (right != null) return {base: plus.left, offset: right}
    const left = numericTextValue(plus.left)
    if (left != null) return {base: plus.right, offset: left}
  }

  const minus = binaryExpression(expression, '-')
  if (minus != null) {
    const right = numericTextValue(minus.right)
    if (right != null) return {base: minus.left, offset: -right}
  }

  return {base: expression, offset: 0}
}

function numericTextValue(text: string) {
  const trimmed = text.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null
  return Number(trimmed)
}

function offsetExpression(expression: string, offset: number) {
  if (offset === 0) return expression
  return offset > 0 ? `(${expression} + ${offset})` : `(${expression} - ${Math.abs(offset)})`
}

function evaluateRoundingMonotonicity(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  const lessGoal = comparisonLessGoal(goal)
  if (lessGoal == null || lessGoal.op !== '<=') return null
  const shape = matchingRoundingCall(lessGoal.leftExpr, lessGoal.rightExpr)
  if (shape == null) return null
  if (context.hasComparisonFact(shape.left, '<=', shape.right)) return pass('rounding-monotonicity', 'rounding preserves non-strict order')
  return blocked('rounding-monotonicity', `${publicFitText(shape.left)} <= ${publicFitText(shape.right)}`, 'rounding preserves non-strict order')
}

function matchingRoundingCall(leftExpr: string, rightExpr: string): {left: string; right: string} | null {
  const left = roundingCall(leftExpr)
  const right = roundingCall(rightExpr)
  return left == null || right == null || left.name !== right.name ? null : {left: left.arg, right: right.arg}
}

function evaluateModuloBelowDivisor(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.op !== '<' && goal.op !== '<=') return null
  if (goal.left.expr == null || goal.right.expr == null) return null
  const shape = moduloExpression(goal.left.expr)
  if (shape == null || !sameExpressionText(shape.right, goal.right.expr)) return null
  const dividendNeed = `${publicFitText(shape.left)} >= 0`
  const divisorNeed = `${publicFitText(shape.right)} > 0`
  const dividendProven = context.provesExprNonNegative(shape.left, false)
  const divisorProven = context.provesExprNonNegative(shape.right, true)
  if (dividendProven && divisorProven) return pass('modulo-below-divisor', 'modulo result stays below a positive divisor')
  const missing = [
    ...(dividendProven ? [] : [dividendNeed]),
    ...(divisorProven ? [] : [divisorNeed]),
  ]
  return blocked('modulo-below-divisor', missing.join(' and '), 'modulo result stays below a positive divisor')
}

function evaluateScaleMonotonicity(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  const lessGoal = comparisonLessGoal(goal)
  if (lessGoal == null) return null
  const obligations = [
    ...positiveMonotoneObligations(lessGoal.leftExpr, lessGoal.op, lessGoal.rightExpr, context),
    ...negativeProductObligations(lessGoal.leftExpr, lessGoal.op, lessGoal.rightExpr, context),
  ]
  if (obligations.length === 0) return null
  const passing = obligations.find(obligation => obligation.factorProven && obligation.baseProven)
  if (passing != null) return pass('scale-monotonicity', 'shared scale preserves the comparison under known sign facts')
  return blocked('scale-monotonicity', monotoneMissing(obligations.find(obligation => obligation.baseProven || obligation.factorProven) ?? obligations[0]!), 'shared scale preserves the comparison under known sign facts')
}

function comparisonLessGoal(goal: ComparisonGoal): LessComparisonGoal | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  if (goal.op === '<=' || goal.op === '<') return {left: goal.left, leftExpr: goal.left.expr, op: goal.op, right: goal.right, rightExpr: goal.right.expr}
  if (goal.op === '>=') return {left: goal.right, leftExpr: goal.right.expr, op: '<=', right: goal.left, rightExpr: goal.left.expr}
  if (goal.op === '>') return {left: goal.right, leftExpr: goal.right.expr, op: '<', right: goal.left, rightExpr: goal.left.expr}
  return null
}

function evaluateFloorDivisionBelowCount(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.op !== '<' && goal.op !== '<=') return null
  if (goal.left.expr == null || goal.right.expr == null || !goal.right.isInteger) return null
  const shape = floorDivision(goal.left.expr)
  if (shape == null) return null
  const divisorNeed = `${shape.right} > 0`
  const boundNeed = `${shape.left} < ${goal.right.expr} * ${shape.right}`
  const divisorProven = context.provesExprNonNegative(shape.right, true)
  const boundProven = context.hasComparisonFact(shape.left, '<', `(${goal.right.expr} * ${shape.right})`)
    || context.hasComparisonFact(shape.left, '<', `(${shape.right} * ${goal.right.expr})`)
  if (divisorProven && boundProven) return pass('floor-division-below-count', 'floor division stays below count from its product bound')
  if (boundProven) return blocked('floor-division-below-count', divisorNeed, 'floor division stays below count from its product bound')
  if (divisorProven) return blocked('floor-division-below-count', boundNeed, 'floor division stays below count from its product bound')
  return blocked('floor-division-below-count', `${divisorNeed} and ${boundNeed}`, 'floor division stays below count from its product bound')
}

function evaluateCeilDivisionCoversTotal(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.op !== '>=') return null
  if (goal.left.expr == null || goal.right.expr == null) return null
  const shape = ceilDivisionProduct(goal.left.expr)
  if (shape == null || !sameExpressionText(shape.total, goal.right.expr)) return null
  if (context.provesExprNonNegative(shape.count, true)) return pass('ceil-division-covers-total', 'ceil division product covers the total')
  return blocked('ceil-division-covers-total', `${shape.count} > 0`, 'ceil division product covers the total')
}

type ScaleMonotoneObligation = {
  factorNeed: string
  factorProven: boolean
  baseNeed: string
  baseProven: boolean
}

function positiveMonotoneObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofBackendContext) {
  return [
    ...positiveDivisionObligations(leftExpr, op, rightExpr, context),
    ...positiveProductObligations(leftExpr, op, rightExpr, context),
  ]
}

function positiveDivisionObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofBackendContext): ScaleMonotoneObligation[] {
  const leftDivision = binaryExpression(leftExpr, '/')
  const rightDivision = binaryExpression(rightExpr, '/')
  if (leftDivision == null || rightDivision == null || !sameExpressionText(leftDivision.right, rightDivision.right)) return []
  if (context.hasComparisonFact(leftDivision.right, '<', '0')) return []
  return [{
    factorNeed: `${leftDivision.right} > 0`,
    factorProven: context.provesExprNonNegative(leftDivision.right, true),
    baseNeed: `${leftDivision.left} ${op} ${rightDivision.left}`,
    baseProven: context.hasComparisonFact(leftDivision.left, op, rightDivision.left),
  }]
}

function positiveProductObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofBackendContext): ScaleMonotoneObligation[] {
  const leftProduct = productFactors(leftExpr)
  const rightProduct = productFactors(rightExpr)
  if (leftProduct == null || rightProduct == null) return []
  const obligations: ScaleMonotoneObligation[] = []
  for (let leftIndex = 0; leftIndex < leftProduct.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < rightProduct.length; rightIndex++) {
      const leftFactor = leftProduct[leftIndex]!
      const rightFactor = rightProduct[rightIndex]!
      if (!sameExpressionText(leftFactor, rightFactor)) continue
      if (context.hasComparisonFact(leftFactor, '<', '0')) continue
      const leftBase = productText(leftProduct.filter((_, index) => index !== leftIndex))
      const rightBase = productText(rightProduct.filter((_, index) => index !== rightIndex))
      obligations.push({
        factorNeed: `${leftFactor} ${op === '<' ? '>' : '>='} 0`,
        factorProven: context.provesExprNonNegative(leftFactor, op === '<'),
        baseNeed: `${leftBase} ${op} ${rightBase}`,
        baseProven: context.hasComparisonFact(leftBase, op, rightBase),
      })
    }
  }
  return obligations
}

function negativeProductObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofBackendContext): ScaleMonotoneObligation[] {
  const leftProduct = productFactors(leftExpr)
  const rightProduct = productFactors(rightExpr)
  if (leftProduct == null || rightProduct == null) return []
  const obligations: ScaleMonotoneObligation[] = []
  for (let leftIndex = 0; leftIndex < leftProduct.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < rightProduct.length; rightIndex++) {
      const leftFactor = leftProduct[leftIndex]!
      const rightFactor = rightProduct[rightIndex]!
      if (!sameExpressionText(leftFactor, rightFactor)) continue
      if (context.hasComparisonFact(leftFactor, '>=', '0')) continue
      const leftBase = productText(leftProduct.filter((_, index) => index !== leftIndex))
      const rightBase = productText(rightProduct.filter((_, index) => index !== rightIndex))
      obligations.push({
        factorNeed: `${leftFactor} < 0`,
        factorProven: context.hasComparisonFact(leftFactor, '<', '0'),
        baseNeed: `${rightBase} ${op} ${leftBase}`,
        baseProven: context.hasComparisonFact(rightBase, op, leftBase),
      })
    }
  }
  return obligations
}

function monotoneMissing(obligation: ScaleMonotoneObligation) {
  if (obligation.baseProven) return obligation.factorNeed
  if (obligation.factorProven) return obligation.baseNeed
  return `${obligation.factorNeed} and ${obligation.baseNeed}`
}

function pass(rule: string, message: string): ProofBackendResult {
  return {status: 'pass', rule, message}
}

function blocked(rule: string, missing: string, message: string): ProofBackendResult {
  return {status: 'blocked', rule, message, missing}
}
