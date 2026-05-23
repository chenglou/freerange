import type {LinearConstraint} from './domain-types.ts'
import {
  expressionKeyFromText,
  linearKey,
} from './linear.ts'

export function mergeAssumptions(...groups: LinearConstraint[][]): LinearConstraint[] {
  const seen = new Set<string>()
  const assumptions: LinearConstraint[] = []
  for (const assumption of groups.flat()) {
    const key = assumptionKey(assumption)
    if (seen.has(key)) continue
    seen.add(key)
    assumptions.push(assumption)
  }
  return assumptions
}

function assumptionKey(assumption: LinearConstraint) {
  const hasExpressionPair = assumption.leftExpr != null && assumption.rightExpr != null
  return [
    assumption.op,
    assumption.source,
    assumption.text ?? '',
    hasExpressionPair || assumption.diff == null ? '' : linearKey(assumption.diff),
    expressionKeyOrEmpty(assumption.leftExpr),
    expressionKeyOrEmpty(assumption.rightExpr),
    assumption.fromRange === true ? 'range' : '',
    assumption.integerStrict === true ? 'integer-strict' : '',
  ].join('\0')
}

function expressionKeyOrEmpty(expression: string | undefined) {
  return expression == null ? '' : expressionKeyFromText(expression)
}
