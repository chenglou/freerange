import {type ComparisonOperator} from './parser.ts'
import {mergeAssumptions} from './assumptions.ts'
import {assumptionsAreReachable} from './constraint-reachability.ts'
import {
  maxNumberCases,
  numberBranches,
  type LinearConstraint,
  type NumberCase,
  type NumberValue,
  type Value,
} from './domain.ts'
import {sameLinear} from './linear.ts'
import {
  proveComparisonPlain,
  type Truth,
} from './proof.ts'

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
      const assumptions = mergeAssumptions(leftCase.assumptions, rightCase.assumptions)
      if (!assumptionsAreReachable(assumptions)) continue
      cases.push({
        value,
        assumptions,
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
