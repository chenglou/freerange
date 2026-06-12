import {
  publicFitText,
  type ComparisonOperator,
} from './parser.ts'
import {
  type LinearConstraint,
  type NumberValue,
  integerValued,
  possiblyNaN,
} from './domain.ts'
import {
  binaryExpression,
  callArg,
  expressionKeyFromText,
  linearFromExpressionText,
  linearFromTopOperation,
  linearSubtract,
  productFactors,
  productText,
  sameExpressionText,
  singleUnitAtom,
  type LinearExpr,
} from './linear.ts'

export type ComparisonGoal = {
  left: NumberValue
  op: ComparisonOperator
  right: NumberValue
}

// Offsets are the prover's own real arithmetic over the named doubles (the
// floor bracketing lemma needs `x < r + 1` with a real `+ 1`), never a claim
// that the program computed them; they stay out of the expression text so
// text lowering cannot mistake them for program ops.
export type ReductionOffsets = {left?: number; right?: number}

export type ProofRulesContext = {
  assumptions: LinearConstraint[]
  hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string, offsets?: ReductionOffsets): boolean
  provesExprNonNegative(expression: string, strict: boolean): boolean
  provesLinearNonNegative(diff: LinearExpr, strict: boolean): boolean
}

export type ProofRuleResult =
  | {status: 'pass'; rule: string; message: string}
  | {status: 'blocked'; rule: string; message: string; missing: string}

type ComparisonGraphEdge = {
  to: string
  strict: boolean
}

export function evaluateComparisonRules(goal: ComparisonGoal, context: ProofRulesContext): ProofRuleResult | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  // An identity fact (return == x from a copy) is true of NaN, but the ==
  // claim is not. A hull bound or any recorded comparison fact about the
  // value certifies non-NaN; an alias pair with neither stays unproven.
  const nanEquality = goal.op === '==' && possiblyNaN(goal.left) && possiblyNaN(goal.right)
    && !context.assumptions.some(assumption => assumption.leftExpr != null && assumption.rightExpr != null
      && (sameExpressionText(assumption.leftExpr, goal.left.expr!) || sameExpressionText(assumption.rightExpr, goal.left.expr!)
        || sameExpressionText(assumption.leftExpr, goal.right.expr!) || sameExpressionText(assumption.rightExpr, goal.right.expr!)))
  if (!nanEquality && context.hasComparisonFact(goal.left.expr, goal.op, goal.right.expr)) return pass('comparison-fact', 'matched a known comparison fact')

  let blockedResult: ProofRuleResult | null = null
  for (const rule of comparisonProofRules) {
    const result = rule(goal, context)
    if (result?.status === 'pass') return result
    if (result?.status === 'blocked' && blockedResult == null) blockedResult = result
  }

  return blockedResult
}

export function comparisonRulesMissing(goal: ComparisonGoal, context: ProofRulesContext): string | null {
  const result = evaluateComparisonRules(goal, context)
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

type ComparisonProofRule = (goal: ComparisonGoal, context: ProofRulesContext) => ProofRuleResult | null

// The former floor-division-below-count and ceil-division-covers-total rules
// are gone: both reason through a float division whose quotient can round
// across the integer boundary (pointer < count * cellSize admits
// floor(pointer / cellSize) == count at ordinary layout magnitudes). Sound
// versions need the divisor's integrality and a magnitude window, which these
// expression-text rules cannot resolve to values yet.
const comparisonProofRules: ComparisonProofRule[] = [
  evaluateRoundingMonotonicity,
  evaluateRoundedOpMonotonicity,
  evaluateSignRecovery,
  evaluateScaleMonotonicity,
  evaluateSimplifiedComparison,
]

// Sign goals recurse op-by-op (provesExprNonNegative walks the expression),
// so `x1 + ... + x8 >= 0` from eight sign givens survives the nested
// roundings one monotone step at a time. A relabeled value (a callee
// parameter bound to a caller argument) recurses through its atom, which
// still names the caller's computation.
function evaluateSignRecovery(goal: ComparisonGoal, context: ProofRulesContext): ProofRuleResult | null {
  const lessGoal = comparisonLessGoal(goal)
  if (lessGoal == null) return null
  if (lessGoal.left.min !== 0 || lessGoal.left.max !== 0) return null
  const strict = lessGoal.op === '<'
  if (context.provesExprNonNegative(lessGoal.rightExpr, strict)) {
    return pass('sign-recovery', 'sign survives rounding one operation at a time')
  }
  const atom = singleUnitAtom(lessGoal.right.linear)
  if (atom != null && atom !== lessGoal.rightExpr && context.provesExprNonNegative(atom, strict)) {
    return pass('sign-recovery', 'sign survives rounding one operation at a time')
  }
  return null
}

// fl is monotone and each side rounds once: a non-strict comparison of two
// computed results follows from the same comparison of their exact real
// values, with operands kept as opaque atoms. Covers `y + gapTop >= y` from
// gapTop >= 0 and `(cols - w) >= 0` from `w <= cols` without granting the
// rounded results any algebra. Strict goals stay out: two real values that
// differ can round to the same double.
function evaluateRoundedOpMonotonicity(goal: ComparisonGoal, context: ProofRulesContext): ProofRuleResult | null {
  const lessGoal = comparisonLessGoal(goal)
  if (lessGoal == null || lessGoal.op !== '<=') return null
  const leftTop = linearFromTopOperation(lessGoal.leftExpr)
  const rightTop = linearFromTopOperation(lessGoal.rightExpr)
  if (leftTop == null && rightTop == null) return null
  // The non-expanded side keeps its value's own gated form (a floor result's
  // atom carries the recorded bracketing facts; call text has no lowering).
  const left = leftTop ?? lessGoal.left.linear ?? linearFromExpressionText(lessGoal.leftExpr)
  const right = rightTop ?? lessGoal.right.linear ?? linearFromExpressionText(lessGoal.rightExpr)
  const diff = linearSubtract(right, left)
  if (diff == null) return null
  if (context.provesLinearNonNegative(diff, false)) {
    return pass('rounded-op-monotonicity', 'rounding preserves non-strict order through one operation per side')
  }
  return null
}

type LessComparisonGoal = {
  left: NumberValue
  leftExpr: string
  op: '<=' | '<'
  right: NumberValue
  rightExpr: string
}

type ComparisonReduction = {
  left: string
  leftOffset: number
  op: '<=' | '<'
  right: string
  rightOffset: number
  reason: string
  rule: string
}

type RoundingFunctionName = 'floor' | 'ceil' | 'round' | 'trunc'
type RoundingCall = {name: RoundingFunctionName; arg: string}

function evaluateSimplifiedComparison(goal: ComparisonGoal, context: ProofRulesContext): ProofRuleResult | null {
  const lessGoal = comparisonLessGoal(goal)
  if (lessGoal == null) return null

  const reductions = comparisonReductions(lessGoal)
  if (reductions.length === 0) return null

  for (const reduction of reductions) {
    if (context.hasComparisonFact(reduction.left, reduction.op, reduction.right, {left: reduction.leftOffset, right: reduction.rightOffset})) {
      return pass(reduction.rule, reduction.reason)
    }
  }

  const first = reductions[0]!
  return blocked(first.rule, `${offsetText(publicFitText(first.left), first.leftOffset)} ${first.op} ${offsetText(publicFitText(first.right), first.rightOffset)}`, first.reason)
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
      return integerValued(goal.right)
        ? [{left: lower.arg, leftOffset: 0, op: '<', right, rightOffset: goal.op === '<' ? 0 : 1, rule: 'rounding-simplification', reason: 'simplified comparison through floor bounds'}]
        : [{left: lower.arg, leftOffset: 0, op: goal.op, right, rightOffset: 0, rule: 'rounding-simplification', reason: 'simplified comparison through floor bounds'}]
    case 'ceil':
      return integerValued(goal.right)
        ? [{left: lower.arg, leftOffset: 0, op: '<=', right, rightOffset: goal.op === '<' ? -1 : 0, rule: 'rounding-simplification', reason: 'simplified comparison through integer ceil bounds'}]
        : []
    case 'round':
      return integerValued(goal.right)
        ? [{left: lower.arg, leftOffset: 0, op: '<', right, rightOffset: goal.op === '<' ? -0.5 : 0.5, rule: 'rounding-simplification', reason: 'simplified comparison through round half-unit bounds'}]
        : []
    case 'trunc':
      return []
  }
}

function upperRoundingReductions(goal: LessComparisonGoal): ComparisonReduction[] {
  if (!integerValued(goal.left)) return []
  const upper = roundingCall(goal.rightExpr)
  if (upper == null) return []
  const left = goal.leftExpr

  switch (upper.name) {
    case 'floor':
      return [{left, leftOffset: goal.op === '<' ? 1 : 0, op: '<=', right: upper.arg, rightOffset: 0, rule: 'rounding-simplification', reason: 'simplified comparison through integer floor bounds'}]
    case 'ceil':
      return [{left, leftOffset: goal.op === '<' ? 0 : -1, op: '<', right: upper.arg, rightOffset: 0, rule: 'rounding-simplification', reason: 'simplified comparison through ceil bounds'}]
    case 'round':
      return [{left, leftOffset: goal.op === '<' ? 0.5 : -0.5, op: '<=', right: upper.arg, rightOffset: 0, rule: 'rounding-simplification', reason: 'simplified comparison through round half-unit bounds'}]
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

function offsetText(expression: string, offset: number) {
  if (offset === 0) return expression
  return offset > 0 ? `(${expression} + ${offset})` : `(${expression} - ${Math.abs(offset)})`
}

function evaluateRoundingMonotonicity(goal: ComparisonGoal, context: ProofRulesContext): ProofRuleResult | null {
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

function evaluateScaleMonotonicity(goal: ComparisonGoal, context: ProofRulesContext): ProofRuleResult | null {
  const lessGoal = comparisonLessGoal(goal)
  // Strict goals are out: two scaled values that differ over the reals can
  // round to the same double.
  if (lessGoal == null || lessGoal.op !== '<=') return null
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

type ScaleMonotoneObligation = {
  factorNeed: string
  factorProven: boolean
  baseNeed: string
  baseProven: boolean
}

function positiveMonotoneObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofRulesContext) {
  return [
    ...positiveDivisionObligations(leftExpr, op, rightExpr, context),
    ...positiveProductObligations(leftExpr, op, rightExpr, context),
  ]
}

function positiveDivisionObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofRulesContext): ScaleMonotoneObligation[] {
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

function positiveProductObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofRulesContext): ScaleMonotoneObligation[] {
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

function negativeProductObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofRulesContext): ScaleMonotoneObligation[] {
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

function pass(rule: string, message: string): ProofRuleResult {
  return {status: 'pass', rule, message}
}

function blocked(rule: string, missing: string, message: string): ProofRuleResult {
  return {status: 'blocked', rule, message, missing}
}
