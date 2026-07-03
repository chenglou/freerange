import type {AllocationIdentity} from '../heap/model.ts'
import {compareIdentity, sameIdentity} from '../heap/model.ts'
import {finiteInputNumber, joinNumbers, sameNumbers, widenNumber, type AbstractNumber} from './number.ts'

export type AbstractBoolean = {
  kind: 'boolean'
  canBeTrue: boolean
  canBeFalse: boolean
}

// The addressed object's representative is one of these targets. Nonempty, sorted by
// compareIdentity, deduplicated — construct only through singletonReference/unionTargets so
// equality stays elementwise. Disjoint target sets prove two references differ; overlap
// proves nothing.
export type AbstractReference = {
  kind: 'reference'
  targets: AllocationIdentity[]
}

type AbstractVoid = {
  kind: 'void'
}

export type AbstractValue = AbstractNumber | AbstractBoolean | AbstractReference | AbstractVoid

export function unknownBoolean(): AbstractBoolean {
  return {kind: 'boolean', canBeTrue: true, canBeFalse: true}
}

// The abstract value a declared kind seeds: any finite number, or any boolean.
export function declaredKindValue(kind: 'number' | 'boolean'): AbstractValue {
  return kind === 'number' ? finiteInputNumber() : unknownBoolean()
}

export function singletonReference(identity: AllocationIdentity): AbstractReference {
  return {kind: 'reference', targets: [identity]}
}

export function unionTargets(left: AllocationIdentity[], right: AllocationIdentity[]): AllocationIdentity[] {
  const merged: AllocationIdentity[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftIdentity = left[leftIndex]
    const rightIdentity = right[rightIndex]
    if (leftIdentity == null) {
      merged.push(rightIdentity!)
      rightIndex++
      continue
    }
    if (rightIdentity == null) {
      merged.push(leftIdentity)
      leftIndex++
      continue
    }
    const order = compareIdentity(leftIdentity, rightIdentity)
    if (order < 0) {
      merged.push(leftIdentity)
      leftIndex++
    } else if (order > 0) {
      merged.push(rightIdentity)
      rightIndex++
    } else {
      merged.push(leftIdentity)
      leftIndex++
      rightIndex++
    }
  }
  return merged
}

export function joinValues(left: AbstractValue, right: AbstractValue): AbstractValue {
  // Kind mismatches stay a crash: union-typed bindings are outside the accepted subset and
  // belong to a lowering gate, not to the join.
  if (left.kind !== right.kind) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'reference': {
      return {kind: 'reference', targets: unionTargets(left.targets, (right as AbstractReference).targets)}
    }
    case 'void': return left
  }
}

export function sameValues(left: AbstractValue, right: AbstractValue): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'number': return sameNumbers(left, right as AbstractNumber)
    case 'boolean': {
      const other = right as AbstractBoolean
      return left.canBeTrue === other.canBeTrue && left.canBeFalse === other.canBeFalse
    }
    case 'reference': {
      const other = right as AbstractReference
      return left.targets.length === other.targets.length
        && left.targets.every((target, index) => sameIdentity(target, other.targets[index]!))
    }
    case 'void': return true
  }
}

// Widening exists to bound the lattice height at loop headers; every kind must decide its
// own story here, so a future kind cannot silently fall into an unbounded default and spin
// fixed points into the round limit.
export function widenValue(previous: AbstractValue, next: AbstractValue): AbstractValue {
  switch (next.kind) {
    // Numbers are the one unbounded lattice; bounds that grew jump to their extreme.
    case 'number': return previous.kind === 'number' ? widenNumber(previous, next) : next
    // Bounded lattices need no widening: booleans have height two, a reference's possible
    // targets are fixed by the program text, void is a point.
    case 'boolean':
    case 'reference':
    case 'void':
      return next
  }
}

function joinBooleans(left: AbstractBoolean, right: AbstractBoolean): AbstractBoolean {
  return {
    kind: 'boolean',
    canBeTrue: left.canBeTrue || right.canBeTrue,
    canBeFalse: left.canBeFalse || right.canBeFalse,
  }
}
