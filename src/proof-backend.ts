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
  hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string): boolean
  provesExprNonNegative(expression: string, strict: boolean): boolean
}

export type ProofBackendResult =
  | {status: 'pass'}
  | {status: 'blocked'; missing: string}

type ComparisonGraphEdge = {
  to: string
  strict: boolean
}

export function evaluateBackendComparison(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  if (context.hasComparisonFact(goal.left.expr, goal.op, goal.right.expr)) return {status: 'pass'}

  for (const rule of comparisonProofRules) {
    const result = rule(goal, context)
    if (result != null) return result
  }

  return null
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
  evaluateRoundingBound,
  evaluateModuloBelowDivisor,
  evaluateRunningSumAtLeastStart,
  evaluateRunningSumMinusTrailingGapAtLeastStart,
  evaluatePositiveScaleMonotonicity,
  evaluateFlattenedGridIndexBelowCount,
  evaluateFloorDivisionBelowCount,
  evaluateCeilDivisionCoversTotal,
]

function evaluateChoiceOperandBound(goal: ComparisonGoal): ProofBackendResult | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  if (goal.op === '<=') {
    if (choiceHasOperand(goal.left.expr, 'min', goal.right.expr)) return {status: 'pass'}
    if (choiceHasOperand(goal.right.expr, 'max', goal.left.expr)) return {status: 'pass'}
  }
  if (goal.op === '>=') {
    if (choiceHasOperand(goal.left.expr, 'max', goal.right.expr)) return {status: 'pass'}
    if (choiceHasOperand(goal.right.expr, 'min', goal.left.expr)) return {status: 'pass'}
  }
  return null
}

function choiceHasOperand(choiceExpr: string, choiceName: 'min' | 'max', operandExpr: string) {
  const args = callArgs(choiceExpr, choiceName)
  return args != null && args.some(arg => sameExpressionText(arg, operandExpr))
}

function evaluateRoundingBound(goal: ComparisonGoal): ProofBackendResult | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  const leftCeil = callArg(goal.left.expr, 'ceil')
  if (goal.op === '>=' && leftCeil != null && sameExpressionText(leftCeil, goal.right.expr)) return {status: 'pass'}
  const leftFloor = callArg(goal.left.expr, 'floor')
  if (goal.op === '<=' && leftFloor != null && sameExpressionText(leftFloor, goal.right.expr)) return {status: 'pass'}
  const rightCeil = callArg(goal.right.expr, 'ceil')
  if (goal.op === '<=' && rightCeil != null && sameExpressionText(goal.left.expr, rightCeil)) return {status: 'pass'}
  const rightFloor = callArg(goal.right.expr, 'floor')
  if (goal.op === '>=' && rightFloor != null && sameExpressionText(goal.left.expr, rightFloor)) return {status: 'pass'}
  return null
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
  if (dividendProven && divisorProven) return {status: 'pass'}
  const missing = [
    ...(dividendProven ? [] : [dividendNeed]),
    ...(divisorProven ? [] : [divisorNeed]),
  ]
  return {status: 'blocked', missing: missing.join(' and ')}
}

function evaluateRunningSumAtLeastStart(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.op !== '>=' && goal.op !== '>') return null
  if (goal.left.expr == null || goal.right.expr == null) return null
  const args = callArgs(goal.left.expr, 'runningSum')
  if (args == null || args.length !== 3 || !sameExpressionText(args[0]!, goal.right.expr)) return null
  const missing = runningSumMissing(args[1]!, args[2]!, context)
  if (missing.length > 0) return {status: 'blocked', missing: missing.join(' and ')}
  return goal.op === '>=' ? {status: 'pass'} : null
}

function evaluateRunningSumMinusTrailingGapAtLeastStart(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.op !== '>=' && goal.op !== '>') return null
  if (goal.left.expr == null || goal.right.expr == null) return null
  const trailingGap = binaryExpression(goal.left.expr, '-')
  if (trailingGap == null) return null
  const args = callArgs(trailingGap.left, 'runningSum')
  if (args == null || args.length !== 3 || !sameExpressionText(args[0]!, goal.right.expr)) return null
  const count = args[1]!
  const increment = args[2]!
  const gap = trailingGap.right
  const missing = []
  if (!context.hasComparisonFact(count, '>=', '1')) missing.push(`${publicFitText(count)} >= 1`)
  if (!context.provesExprNonNegative(gap, false)) missing.push(`${publicFitText(gap)} >= 0`)
  const incrementCoversGap = sameExpressionText(increment, gap) || incrementHasNonNegativeRemainder(increment, gap, context)
  if (!incrementCoversGap) missing.push(`${publicFitText(increment)} >= ${publicFitText(gap)}`)
  if (missing.length > 0) return {status: 'blocked', missing: missing.join(' and ')}
  return goal.op === '>=' ? {status: 'pass'} : null
}

function runningSumMissing(count: string, increment: string, context: ProofBackendContext) {
  const missing = []
  if (!runningSumCountIsKnownNonNegative(count, context)) missing.push(`${publicFitText(count)} >= 0`)
  if (!context.provesExprNonNegative(increment, false)) missing.push(`${publicFitText(increment)} >= 0`)
  return missing
}

function runningSumCountIsKnownNonNegative(expression: string, context: ProofBackendContext) {
  return expression.endsWith('.length') || context.provesExprNonNegative(expression, false)
}

function incrementHasNonNegativeRemainder(increment: string, gap: string, context: ProofBackendContext) {
  const incrementSum = binaryExpression(increment, '+')
  if (incrementSum == null) return false
  const base =
    sameExpressionText(incrementSum.left, gap) ? incrementSum.right
      : sameExpressionText(incrementSum.right, gap) ? incrementSum.left
        : null
  return base != null && context.provesExprNonNegative(base, false)
}

function evaluatePositiveScaleMonotonicity(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  const lessGoal = comparisonLessGoal(goal)
  if (lessGoal == null) return null
  const obligations = positiveMonotoneObligations(lessGoal.leftExpr, lessGoal.op, lessGoal.rightExpr, context)
  if (obligations.length === 0) return null
  if (obligations.some(obligation => obligation.factorProven && obligation.baseProven)) return {status: 'pass'}
  return {status: 'blocked', missing: monotoneMissing(obligations[0]!)}
}

function comparisonLessGoal(goal: ComparisonGoal): {leftExpr: string; op: '<=' | '<'; rightExpr: string} | null {
  if (goal.left.expr == null || goal.right.expr == null) return null
  if (goal.op === '<=' || goal.op === '<') return {leftExpr: goal.left.expr, op: goal.op, rightExpr: goal.right.expr}
  if (goal.op === '>=') return {leftExpr: goal.right.expr, op: '<=', rightExpr: goal.left.expr}
  if (goal.op === '>') return {leftExpr: goal.right.expr, op: '<', rightExpr: goal.left.expr}
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
  if (divisorProven && boundProven) return {status: 'pass'}
  if (boundProven) return {status: 'blocked', missing: divisorNeed}
  if (divisorProven) return {status: 'blocked', missing: boundNeed}
  return {status: 'blocked', missing: `${divisorNeed} and ${boundNeed}`}
}

function evaluateFlattenedGridIndexBelowCount(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.op !== '<' && goal.op !== '<=') return null
  if (goal.left.expr == null || goal.right.expr == null || !goal.left.isInteger || !goal.right.isInteger) return null
  const sum = binaryExpression(goal.left.expr, '+')
  const rightFactors = productFactors(goal.right.expr)
  if (sum == null || rightFactors == null || rightFactors.length < 2) return null

  for (const [rowTerm, columnTerm] of [[sum.left, sum.right], [sum.right, sum.left]] as const) {
    const shape = flattenedGridIndexShape(rowTerm, columnTerm, rightFactors)
    if (shape == null) continue
    const obligations = [
      {need: `${shape.x.left} < ${shape.stride} * ${shape.x.right}`, proven: hasProductComparisonFact(shape.x.left, '<', shape.stride, shape.x.right, context)},
      {need: `${shape.y.left} < ${shape.rows} * ${shape.y.right}`, proven: hasProductComparisonFact(shape.y.left, '<', shape.rows, shape.y.right, context)},
      {need: `${shape.x.right} > 0`, proven: context.provesExprNonNegative(shape.x.right, true)},
      {need: `${shape.y.right} > 0`, proven: context.provesExprNonNegative(shape.y.right, true)},
      {need: `${shape.stride} > 0`, proven: context.provesExprNonNegative(shape.stride, true)},
    ]
    const missing = obligations.filter(obligation => !obligation.proven).map(obligation => obligation.need)
    return missing.length === 0 ? {status: 'pass'} : {status: 'blocked', missing: missing.join(' and ')}
  }

  return null
}

type FlattenedGridIndexShape = {
  stride: string
  rows: string
  x: {left: string; right: string}
  y: {left: string; right: string}
}

function flattenedGridIndexShape(rowTerm: string, columnTerm: string, rightFactors: string[]): FlattenedGridIndexShape | null {
  const row = floorDivisionProduct(rowTerm)
  const column = floorDivision(columnTerm)
  if (row == null || column == null) return null
  const rowCount = productWithoutFactor(rightFactors, row.factor)
  return rowCount == null ? null : {stride: row.factor, rows: rowCount, x: column, y: row.floor}
}

function floorDivisionProduct(text: string): {floor: {left: string; right: string}; factor: string} | null {
  const factors = productFactors(text)
  if (factors == null) return null
  for (let index = 0; index < factors.length; index++) {
    const floor = floorDivision(factors[index]!)
    if (floor == null) continue
    return {floor, factor: productText(factors.filter((_, factorIndex) => factorIndex !== index))}
  }
  return null
}

function productWithoutFactor(factors: string[], factor: string) {
  const index = factors.findIndex(item => sameExpressionText(item, factor))
  if (index < 0) return null
  return productText(factors.filter((_, factorIndex) => factorIndex !== index))
}

function hasProductComparisonFact(left: string, op: ComparisonOperator, factorA: string, factorB: string, context: ProofBackendContext) {
  return context.hasComparisonFact(left, op, productText([factorA, factorB]))
}

function evaluateCeilDivisionCoversTotal(goal: ComparisonGoal, context: ProofBackendContext): ProofBackendResult | null {
  if (goal.op !== '>=') return null
  if (goal.left.expr == null || goal.right.expr == null) return null
  const shape = ceilDivisionProduct(goal.left.expr)
  if (shape == null || !sameExpressionText(shape.total, goal.right.expr)) return null
  if (context.provesExprNonNegative(shape.count, true)) return {status: 'pass'}
  return {status: 'blocked', missing: `${shape.count} > 0`}
}

type PositiveMonotoneObligation = {
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

function positiveDivisionObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofBackendContext): PositiveMonotoneObligation[] {
  const leftDivision = binaryExpression(leftExpr, '/')
  const rightDivision = binaryExpression(rightExpr, '/')
  if (leftDivision == null || rightDivision == null || !sameExpressionText(leftDivision.right, rightDivision.right)) return []
  return [{
    factorNeed: `${leftDivision.right} > 0`,
    factorProven: context.provesExprNonNegative(leftDivision.right, true),
    baseNeed: `${leftDivision.left} ${op} ${rightDivision.left}`,
    baseProven: context.hasComparisonFact(leftDivision.left, op, rightDivision.left),
  }]
}

function positiveProductObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ProofBackendContext): PositiveMonotoneObligation[] {
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
        factorProven: context.provesExprNonNegative(leftFactor, op === '<'),
        baseNeed: `${leftBase} ${op} ${rightBase}`,
        baseProven: context.hasComparisonFact(leftBase, op, rightBase),
      })
    }
  }
  return obligations
}

function monotoneMissing(obligation: PositiveMonotoneObligation) {
  if (obligation.baseProven) return obligation.factorNeed
  if (obligation.factorProven) return obligation.baseNeed
  return `${obligation.factorNeed} and ${obligation.baseNeed}`
}
