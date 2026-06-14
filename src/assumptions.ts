import type {
  Assumption,
  LinearConstraint,
} from './domain-types.ts'
import {
  expressionKeyFromText,
  linearKey,
} from './linear.ts'

export function mergeAssumptions(...groups: Assumption[][]): Assumption[] {
  const seen = new Set<string>()
  const assumptions: Assumption[] = []
  for (const group of groups) {
    for (const assumption of group) {
      const key = assumptionKey(assumption)
      if (seen.has(key)) continue
      seen.add(key)
      assumptions.push(assumption)
    }
  }
  return assumptions
}

export function additionalAssumptions(
  base: Assumption[],
  combined: Assumption[],
): Assumption[] {
  const baseKeys = new Set(base.map(assumptionKey))
  return combined.filter(assumption => !baseKeys.has(assumptionKey(assumption)))
}

export function sharedAssumptions(groups: Assumption[][]): Assumption[] {
  const [first, ...rest] = groups
  if (first == null) return []
  return first.filter(assumption => {
    const key = assumptionKey(assumption)
    return rest.every(group => group.some(item => assumptionKey(item) === key))
  })
}

export function assumptionsKey(assumptions: Assumption[]) {
  return JSON.stringify(assumptions.map(assumptionKey).sort())
}

export function assumptionMentionsRoot(
  assumption: Assumption,
  mentionsRoot: RegExp,
): boolean {
  if (assumption.diff != null) {
    for (const name of assumption.diff.terms.keys()) {
      if (mentionsRoot.test(name)) return true
    }
  }
  if (assumption.leftExpr != null && mentionsRoot.test(assumption.leftExpr)) return true
  if (assumption.rightExpr != null && mentionsRoot.test(assumption.rightExpr)) return true
  return false
}

export function linearConstraints(assumptions: Assumption[]): LinearConstraint[] {
  return assumptions
}

function assumptionKey(assumption: Assumption) {
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
