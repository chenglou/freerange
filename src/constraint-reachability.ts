import type {LinearConstraint} from './domain.ts'
import {comparisonFactContradictedByAssumptions} from './proof.ts'

export function assumptionsAreReachable(assumptions: LinearConstraint[]) {
  const earlier: LinearConstraint[] = []
  for (const assumption of assumptions) {
    if (comparisonFactContradictedByAssumptions(assumption, earlier)) return false
    earlier.push(assumption)
  }
  return true
}
