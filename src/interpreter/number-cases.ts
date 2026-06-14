import {
  joinValues,
  unknown,
  valueWithAssumptions,
  withNumberCaseLoss,
  type Assumption,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {
  reachableNumberCasePairs,
  reachableNumberCases,
} from '../proof.ts'

export function evaluateNumberCases(
  value: NumberValue,
  assumptions: Assumption[],
  evaluate: (value: NumberValue, assumptions: Assumption[]) => Value,
): Value | null {
  if (value.cases == null) return null
  let result: Value | null = null
  for (const current of reachableNumberCases(value, assumptions)) {
    const evaluated = valueWithAssumptions(
      evaluate(current.value, current.assumptions),
      current.caseAssumptions,
      current.caseBranches,
    )
    result = result == null ? evaluated : joinValues(result, evaluated)
  }
  return result ?? unknown('No reachable numeric alternatives were available')
}

export function evaluateNumberCasePairs(
  left: NumberValue,
  right: NumberValue,
  assumptions: Assumption[],
  evaluate: (
    left: NumberValue,
    right: NumberValue,
    assumptions: Assumption[],
  ) => Value,
): Value | null {
  if (left.cases == null && right.cases == null) return null
  let result: Value | null = null
  let separateBranches = false
  for (const pair of reachableNumberCasePairs(left, right, assumptions)) {
    separateBranches ||= pair.separateBranches
    const evaluated = valueWithAssumptions(
      evaluate(pair.left, pair.right, pair.assumptions),
      pair.caseAssumptions,
      pair.caseBranches,
    )
    result = result == null ? evaluated : joinValues(result, evaluated)
  }
  if (result == null) return unknown('No reachable numeric alternatives were available')
  return separateBranches && result.kind === 'number'
    ? withNumberCaseLoss(result, {kind: 'separate-branches'})
    : result
}
