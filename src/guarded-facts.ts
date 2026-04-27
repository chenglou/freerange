import {type ComparisonOperator} from './parser.ts'
import {
  maxNumberCases,
  mergeAssumptions,
  numberBranches,
  plainNumber,
  withNumberCases,
  type LinearConstraint,
  type NumberCase,
  type NumberValue,
  type Value,
} from './domain.ts'
import {sameLinear} from './linear.ts'
import {
  comparisonConstraint,
  proveComparisonPlain,
  type Truth,
} from './proof.ts'

export type ConditionFacts = {
  truth: Truth
  trueAssumptions: LinearConstraint[]
  falseAssumptions: LinearConstraint[]
}

export function comparisonConditionFacts(
  left: NumberValue,
  op: ComparisonOperator,
  right: NumberValue,
  assumptions: LinearConstraint[],
): ConditionFacts {
  const trueFact = comparisonConstraint(left, op, right, undefined, 'branch')
  const falseComparison = negatedComparison(op)
  const falseFact = falseComparison == null ? null : comparisonConstraint(left, falseComparison, right, undefined, 'branch')
  return {
    truth: conditionComparisonTruth(left, op, right, assumptions),
    trueAssumptions: trueFact == null ? [] : [trueFact],
    falseAssumptions: falseFact == null ? [] : [falseFact],
  }
}

export function conditionComparisonTruth(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): Truth {
  if (left.cases == null && right.cases == null) {
    const status = proveComparisonPlain(left, op, right, assumptions)
    if (status.status === 'pass') return 'true'
    if (status.status === 'fail') return 'false'
    return 'maybe'
  }

  let sawPass = false
  let sawFail = false
  let sawUnknown = false
  for (const leftCase of numberBranches(left)) {
    for (const rightCase of numberBranches(right)) {
      const status = proveComparisonPlain(
        leftCase.value,
        op,
        rightCase.value,
        mergeAssumptions(assumptions, leftCase.assumptions, rightCase.assumptions),
      )
      if (status.status === 'pass') sawPass = true
      if (status.status === 'fail') sawFail = true
      if (status.status === 'unknown') sawUnknown = true
    }
  }
  if (sawPass && !sawFail && !sawUnknown) return 'true'
  if (sawFail && !sawPass && !sawUnknown) return 'false'
  return 'maybe'
}

export function refineNumberCasesForComparison(
  value: NumberValue,
  op: ComparisonOperator,
  other: NumberValue,
  assumptions: LinearConstraint[],
): NumberValue | null {
  const cases: NumberCase[] = []
  for (const valueCase of numberBranches(value)) {
    const caseAssumptions = mergeAssumptions(assumptions, valueCase.assumptions)
    const status = proveComparisonPlain(valueCase.value, op, other, caseAssumptions)
    if (status.status === 'fail') continue
    if (status.status === 'pass') {
      cases.push(valueCase)
    } else {
      const fact = comparisonConstraint(valueCase.value, op, other, undefined, 'branch')
      if (fact == null) return null
      cases.push({
        value: valueCase.value,
        assumptions: mergeAssumptions(valueCase.assumptions, [fact]),
      })
    }
    if (cases.length > maxNumberCases) return null
  }
  if (cases.length === 0) return null
  return withNumberCases(value, cases)
}

export function stablePlainConditionOperand(value: NumberValue): NumberValue | null {
  if (value.cases == null) return plainNumber(value)
  const branches = numberBranches(value)
  const first = branches[0]?.value
  if (first == null) return null
  return branches.every(branch => sameNumberShell(branch.value, first)) ? plainNumber(first) : null
}

export function sameNumberShell(left: NumberValue, right: NumberValue) {
  return left.min === right.min
    && left.max === right.max
    && left.isInteger === right.isInteger
    && (left.expr ?? null) === (right.expr ?? null)
    && (
      (left.linear == null && right.linear == null)
      || (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear))
    )
}

export function combineNumberCases(
  left: NumberValue,
  right: NumberValue,
  evaluate: (left: NumberValue, right: NumberValue) => Value,
): NumberCase[] | null {
  if (left.cases == null && right.cases == null) return null
  const cases: NumberCase[] = []
  for (const leftCase of numberBranches(left)) {
    for (const rightCase of numberBranches(right)) {
      const value = evaluate(leftCase.value, rightCase.value)
      if (value.kind !== 'number') return null
      cases.push({
        value,
        assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions),
      })
      if (cases.length > maxNumberCases) return null
    }
  }
  return cases
}

export function negatedComparison(op: ComparisonOperator): ComparisonOperator | null {
  switch (op) {
    case '==':
      return null
    case '>=':
      return '<'
    case '<=':
      return '>'
    case '>':
      return '<='
    case '<':
      return '>='
  }
}
