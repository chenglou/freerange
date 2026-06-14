import type {
  Assumption,
  BranchChoice,
  BranchChoiceOperand,
  LinearConstraint,
} from './domain-types.ts'
import {
  expressionKeyFromText,
  linearKey,
  sameExpressionText,
  sameLinear,
} from './linear.ts'

export function mergeAssumptions(...groups: Assumption[][]): Assumption[] {
  const seen = new Set<string>()
  const assumptions: Assumption[] = []
  for (const assumption of groups.flat()) {
    const key = assumptionKey(assumption)
    if (seen.has(key)) continue
    seen.add(key)
    assumptions.push(assumption)
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
  if (isBranchChoice(assumption)) {
    return branchChoiceOperandMentionsRoot(assumption.left, mentionsRoot)
      || branchChoiceOperandMentionsRoot(assumption.right, mentionsRoot)
  }
  if (assumption.diff != null) {
    for (const name of assumption.diff.terms.keys()) {
      if (mentionsRoot.test(name)) return true
    }
  }
  if (assumption.leftExpr != null && mentionsRoot.test(assumption.leftExpr)) return true
  if (assumption.rightExpr != null && mentionsRoot.test(assumption.rightExpr)) return true
  return false
}

export function isBranchChoice(assumption: Assumption): assumption is BranchChoice {
  return 'kind' in assumption && assumption.kind === 'branch-choice'
}

export function isLinearConstraint(assumption: Assumption): assumption is LinearConstraint {
  return !isBranchChoice(assumption)
}

export function linearConstraints(assumptions: Assumption[]): LinearConstraint[] {
  return assumptions.filter(isLinearConstraint)
}

export function branchChoicesConflict(left: BranchChoice, right: BranchChoice) {
  return sameBranchChoice(left, right) && left.outcome !== right.outcome
}

export function sameBranchChoice(left: BranchChoice, right: BranchChoice) {
  if (left.op !== right.op) return false
  if (
    sameBranchChoiceOperand(left.left, right.left)
    && sameBranchChoiceOperand(left.right, right.right)
  ) return true
  return left.op === '=='
    && sameBranchChoiceOperand(left.left, right.right)
    && sameBranchChoiceOperand(left.right, right.left)
}

export function branchChoiceKey(choice: BranchChoice) {
  const left = branchChoiceOperandKey(choice.left)
  const right = branchChoiceOperandKey(choice.right)
  const [first, second] = choice.op === '==' && left > right
    ? [right, left]
    : [left, right]
  return `${choice.op}\0${first}\0${second}`
}

function assumptionKey(assumption: Assumption) {
  if (isBranchChoice(assumption)) {
    return `branch-choice\0${branchChoiceKey(assumption)}\0${String(assumption.outcome)}`
  }
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

function branchChoiceOperandMentionsRoot(
  operand: BranchChoiceOperand,
  mentionsRoot: RegExp,
) {
  if (operand.kind === 'expression') return mentionsRoot.test(operand.text)
  if (operand.text != null && mentionsRoot.test(operand.text)) return true
  for (const name of operand.value.terms.keys()) {
    if (mentionsRoot.test(name)) return true
  }
  return false
}

function sameBranchChoiceOperand(
  left: BranchChoiceOperand,
  right: BranchChoiceOperand,
) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'linear' && right.kind === 'linear') {
    return sameLinear(left.value, right.value)
  }
  return left.kind === 'expression' && right.kind === 'expression'
    && sameExpressionText(left.text, right.text)
}

function branchChoiceOperandKey(operand: BranchChoiceOperand) {
  return operand.kind === 'linear'
    ? `linear\0${linearKey(operand.value)}`
    : `expression\0${expressionKeyFromText(operand.text)}`
}

function expressionKeyOrEmpty(expression: string | undefined) {
  return expression == null ? '' : expressionKeyFromText(expression)
}
