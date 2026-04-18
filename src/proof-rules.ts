import {type ComparisonOperator} from './parser.ts'
import {type NumberValue} from './domain.ts'
import {
  binaryExpression,
  floorDivision,
  productFactors,
  productText,
  sameExpressionText,
} from './linear.ts'

export type ComparisonGoal = {
  left: NumberValue
  op: ComparisonOperator
  right: NumberValue
}

export type ComparisonRuleContext = {
  hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string): boolean
  provesExprNonNegative(expression: string, strict: boolean): boolean
}

export type ComparisonRuleResult =
  | {status: 'pass'}
  | {status: 'blocked'; missing: string}

export type ComparisonProofRule = {
  name: string
  evaluate(goal: ComparisonGoal, context: ComparisonRuleContext): ComparisonRuleResult | null
}

export const comparisonProofRules: ComparisonProofRule[] = [
  {
    name: 'positive-scale-monotonicity',
    evaluate: evaluatePositiveScaleMonotonicity,
  },
  {
    name: 'floor-division-below-count',
    evaluate: evaluateFloorDivisionBelowCount,
  },
]

function evaluatePositiveScaleMonotonicity(goal: ComparisonGoal, context: ComparisonRuleContext): ComparisonRuleResult | null {
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

function evaluateFloorDivisionBelowCount(goal: ComparisonGoal, context: ComparisonRuleContext): ComparisonRuleResult | null {
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

type PositiveMonotoneObligation = {
  factorNeed: string
  factorProven: boolean
  baseNeed: string
  baseProven: boolean
}

function positiveMonotoneObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ComparisonRuleContext) {
  return [
    ...positiveDivisionObligations(leftExpr, op, rightExpr, context),
    ...positiveProductObligations(leftExpr, op, rightExpr, context),
  ]
}

function positiveDivisionObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ComparisonRuleContext): PositiveMonotoneObligation[] {
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

function positiveProductObligations(leftExpr: string, op: '<=' | '<', rightExpr: string, context: ComparisonRuleContext): PositiveMonotoneObligation[] {
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
