import type {BranchArm} from './domain-types.ts'

export type BranchRelationship = 'compatible' | 'separate' | 'conflict'

export function mergeBranchArms(...groups: BranchArm[][]): BranchArm[] {
  const result: BranchArm[] = []
  for (const group of groups) {
    for (const arm of group) {
      if (result.some(candidate => sameBranchArm(arm, candidate))) continue
      result.push(arm)
    }
  }
  return result
}

export function sharedBranchArms(groups: BranchArm[][]): BranchArm[] {
  const [first, ...rest] = groups
  if (first == null) return []
  return first.filter(arm =>
    rest.every(group => group.some(candidate => sameBranchArm(arm, candidate))))
}

export function branchRelationship(
  base: BranchArm[],
  left: BranchArm[],
  right: BranchArm[],
): BranchRelationship {
  const combined = mergeBranchArms(base, left, right)
  if (branchesConflict(combined)) return 'conflict'
  const leftHasOwn = left.some(arm =>
    !base.some(candidate => sameBranchDecision(arm, candidate))
    && !right.some(candidate => sameBranchDecision(arm, candidate)))
  const rightHasOwn = right.some(arm =>
    !base.some(candidate => sameBranchDecision(arm, candidate))
    && !left.some(candidate => sameBranchDecision(arm, candidate)))
  return leftHasOwn && rightHasOwn ? 'separate' : 'compatible'
}

export function branchesConflict(branches: BranchArm[]) {
  for (let leftIndex = 0; leftIndex < branches.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < branches.length; rightIndex++) {
      const left = branches[leftIndex]!
      const right = branches[rightIndex]!
      if (sameBranchDecision(left, right) && left.arm !== right.arm) return true
    }
  }
  return false
}

function sameBranchArm(left: BranchArm, right: BranchArm) {
  return sameBranchDecision(left, right) && left.arm === right.arm
}

function sameBranchDecision(left: BranchArm, right: BranchArm) {
  if (left.branchId !== right.branchId) return false
  const leftPath = left.path ?? []
  const rightPath = right.path ?? []
  return leftPath.length === rightPath.length
    && leftPath.every((part, index) => part === rightPath[index])
}
