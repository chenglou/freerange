import type {AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'
import {
  sameValueIdentity,
  type ValueIdentity,
} from '../domain/value-identity.ts'

// Indexed by ModuleBindingID, fixed length per program. Flows through calls, so a
// callee's module writes are visible to the caller after a completed call. Null means the
// binding is not initialized; reading it stops the path.
export type SharedState = Array<AbstractValue | null>

export type ExecutionState = {
  values: Array<AbstractValue | undefined>
  shared: SharedState
  // Conditions established by a guard or by a requirement/assumption already recorded
  // on this path. Value keys name immutable runtime values, so assignment naturally uses
  // a new key. Joins intersect the list. This is deliberately a closed set of facts, with
  // no transitive closure, stored as a small deduplicated array.
  valueFacts: ValueFact[]
}

export type ValueFact =
  | {kind: 'nonzero'; value: ValueIdentity}
  // A comparison that held on every path reaching this state. Strict order weakens to
  // non-strict order when joined with a path that established only <=.
  | {kind: 'order'; left: ValueIdentity; right: ValueIdentity; strict: boolean}
  // The strict `index < array.length` half of a bounds guard. The index's own abstract
  // number must still prove integer, non-NaN, and nonnegative.
  | {kind: 'belowLength'; index: ValueIdentity; array: ValueIdentity}
  // A requirement or assumption for an asserted read proves the complete condition.
  | {kind: 'validIndex'; index: ValueIdentity; array: ValueIdentity}

export function hasNonzeroFact(facts: ValueFact[], value: ValueIdentity): boolean {
  return facts.some(fact =>
    fact.kind === 'nonzero' && sameValueIdentity(fact.value, value))
}

export function hasIndexFact(
  facts: ValueFact[],
  kind: 'belowLength' | 'validIndex',
  index: ValueIdentity,
  array: ValueIdentity,
): boolean {
  return facts.some(fact =>
    fact.kind === kind
    && sameValueIdentity(fact.index, index)
    && sameValueIdentity(fact.array, array))
}

export function addValueFact(facts: ValueFact[], candidate: ValueFact): void {
  if (candidate.kind === 'order') {
    const existingIndex = facts.findIndex(fact =>
      fact.kind === 'order'
      && sameValueIdentity(fact.left, candidate.left)
      && sameValueIdentity(fact.right, candidate.right))
    if (existingIndex < 0) {
      facts.push(candidate)
    } else if (candidate.strict && facts[existingIndex]?.kind === 'order') {
      facts[existingIndex] = candidate
    }
    return
  }
  if (!facts.some(fact => sameValueFact(fact, candidate))) facts.push(candidate)
}

export function intersectValueFacts(left: ValueFact[], right: ValueFact[]): ValueFact[] {
  const intersection: ValueFact[] = []
  for (const leftFact of left) {
    for (const rightFact of right) {
      const shared = intersectValueFact(leftFact, rightFact)
      if (shared != null) addValueFact(intersection, shared)
    }
  }
  return intersection
}

function intersectValueFact(left: ValueFact, right: ValueFact): ValueFact | null {
  if (sameValueFact(left, right)) return left
  if (left.kind === 'order' || right.kind === 'order') {
    if (left.kind !== 'order' || right.kind !== 'order'
      || !sameValueIdentity(left.left, right.left)
      || !sameValueIdentity(left.right, right.right)) return null
    return {...left, strict: left.strict && right.strict}
  }
  if (left.kind === 'nonzero' || right.kind === 'nonzero') return null
  if (!sameValueIdentity(left.index, right.index)
    || !sameValueIdentity(left.array, right.array)) return null
  return {kind: 'belowLength', index: left.index, array: left.array}
}

function sameValueFact(left: ValueFact, right: ValueFact): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'nonzero' && right.kind === 'nonzero') {
    return sameValueIdentity(left.value, right.value)
  }
  if (left.kind === 'order' && right.kind === 'order') {
    return left.strict === right.strict
      && sameValueIdentity(left.left, right.left)
      && sameValueIdentity(left.right, right.right)
  }
  if (left.kind === 'nonzero' || right.kind === 'nonzero') return false
  if (left.kind === 'order' || right.kind === 'order') return false
  return sameValueIdentity(left.index, right.index)
    && sameValueIdentity(left.array, right.array)
}

export function emptySharedState(moduleCount: number): SharedState {
  return Array.from({length: moduleCount}, () => null)
}

export function cloneSharedState(state: SharedState): SharedState {
  // Slots are replaced whole on write, never mutated, so a shallow copy suffices.
  return state.slice()
}

export function cloneState(state: ExecutionState): ExecutionState {
  return {
    values: state.values.slice(),
    shared: cloneSharedState(state.shared),
    // Fact objects are never mutated; entries may be replaced whole, so a shallow copy
    // of the array is sufficient.
    valueFacts: state.valueFacts.slice(),
  }
}

// A new state field must participate in both the merged value and `changed`. Listing the
// fields here makes that review mandatory when ExecutionState grows.
const mergedStateFields: Record<keyof ExecutionState, true> = {values: true, shared: true, valueFacts: true}

// Joins one incoming state into the block's previous state and reports whether the block
// must run again. The comparison happens while each joined value is already in hand, so
// propagation does not walk the complete historical frame a second time.
export function mergeStates(previous: ExecutionState, candidate: ExecutionState, widen: boolean): {state: ExecutionState; changed: boolean} {
  void mergedStateFields
  const values: ExecutionState['values'] = []
  const length = Math.max(previous.values.length, candidate.values.length)
  let changed = previous.values.length !== length
  for (let index = 0; index < length; index++) {
    const previousValue = previous.values[index]
    const candidateValue = candidate.values[index]
    if (previousValue == null) {
      values[index] = candidateValue
      if (candidateValue != null) changed = true
    } else if (candidateValue == null) {
      values[index] = previousValue
    } else {
      const joined = joinValues(previousValue, candidateValue)
      const merged = widen ? widenValue(previousValue, joined) : joined
      values[index] = merged
      if (!sameValues(previousValue, merged)) changed = true
    }
  }
  const shared: SharedState = []
  for (let index = 0; index < previous.shared.length; index++) {
    const previousValue = previous.shared[index]
    const candidateValue = candidate.shared[index]
    if (previousValue == null || candidateValue == null) {
      shared.push(null)
      if (previousValue != null) changed = true
    } else {
      const joined = joinValues(previousValue, candidateValue)
      const merged = widen ? widenValue(previousValue, joined) : joined
      shared.push(merged)
      if (!sameValues(previousValue, merged)) changed = true
    }
  }
  const valueFacts = intersectValueFacts(previous.valueFacts, candidate.valueFacts)
  if (
    valueFacts.length !== previous.valueFacts.length
    || valueFacts.some(fact => !previous.valueFacts.some(previousFact => sameValueFact(fact, previousFact)))
  ) changed = true
  const state: ExecutionState = {
    values,
    shared,
    valueFacts,
  }
  return {state, changed}
}

// Uninitialized dominates: a binding is only initialized when every joined path
// initialized it.
export function joinModuleSlots(left: SharedState, right: SharedState): SharedState {
  const joined: SharedState = []
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index]
    const rightValue = right[index]
    joined.push(
      leftValue == null || rightValue == null
        ? null
        : joinValues(leftValue, rightValue),
    )
  }
  return joined
}
