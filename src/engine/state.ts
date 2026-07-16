import type {AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'

export type FunctionFrame = {
  values: Array<AbstractValue | undefined>
}

// One module binding's storage. Uninitialized is a distinct state (not just an unknown
// value) so runtime import-cycle support can be added later; reading an uninitialized slot
// stops the path.
export type ModuleSlot =
  | {kind: 'uninitialized'}
  | {kind: 'value'; value: AbstractValue}

// Indexed by ModuleBindingID, fixed length per program. Flows through calls, so a
// callee's module writes are visible to the caller after a completed call.
export type SharedState = ModuleSlot[]

export type ExecutionState = {
  frame: FunctionFrame
  shared: SharedState
  // Conditions established by a guard or by a requirement/assumption already recorded
  // on this path. Value keys name immutable runtime values, so assignment naturally uses
  // a new key. Joins intersect the list. This is deliberately a closed set of three facts,
  // with no transitivity or arithmetic, stored as a small deduplicated array.
  valueFacts: ValueFact[]
}

export type ValueFact =
  | {kind: 'nonzero'; value: string}
  // The strict `index < array.length` half of a bounds guard. The index's own abstract
  // number must still prove integer, non-NaN, and nonnegative.
  | {kind: 'belowLength'; index: string; array: string}
  // A requirement or assumption for an asserted read proves the complete condition.
  | {kind: 'validIndex'; index: string; array: string}

export function hasNonzeroFact(facts: ValueFact[], value: string): boolean {
  return facts.some(fact => fact.kind === 'nonzero' && fact.value === value)
}

export function hasIndexFact(
  facts: ValueFact[],
  kind: 'belowLength' | 'validIndex',
  index: string,
  array: string,
): boolean {
  return facts.some(fact => fact.kind === kind && fact.index === index && fact.array === array)
}

export function addValueFact(facts: ValueFact[], candidate: ValueFact): void {
  if (!facts.some(fact => sameValueFact(fact, candidate))) facts.push(candidate)
}

export function intersectValueFacts(left: ValueFact[], right: ValueFact[]): ValueFact[] {
  return left.filter(fact => right.some(other => sameValueFact(fact, other)))
}

function sameValueFact(left: ValueFact, right: ValueFact): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'nonzero' && right.kind === 'nonzero') return left.value === right.value
  if (left.kind === 'nonzero' || right.kind === 'nonzero') return false
  return left.index === right.index && left.array === right.array
}

export function emptySharedState(moduleCount: number): SharedState {
  const modules: ModuleSlot[] = []
  for (let index = 0; index < moduleCount; index++) modules.push({kind: 'uninitialized'})
  return modules
}

export function cloneSharedState(state: SharedState): SharedState {
  // Slots are replaced whole on write, never mutated, so a shallow copy suffices.
  return state.slice()
}

export function cloneState(state: ExecutionState): ExecutionState {
  return {
    frame: {values: state.frame.values.slice()},
    shared: cloneSharedState(state.shared),
    // Facts are never mutated, only appended or filtered, so a shallow copy suffices.
    valueFacts: state.valueFacts.slice(),
  }
}

// A new state field must participate in both the merged value and `changed`. Listing the
// fields here makes that review mandatory when ExecutionState grows.
const mergedStateFields: Record<keyof ExecutionState, true> = {frame: true, shared: true, valueFacts: true}

// Joins one incoming state into the block's previous state and reports whether the block
// must run again. The comparison happens while each joined value is already in hand, so
// propagation does not walk the complete historical frame a second time.
export function mergeStates(previous: ExecutionState, candidate: ExecutionState, widen: boolean): {state: ExecutionState; changed: boolean} {
  void mergedStateFields
  const values: FunctionFrame['values'] = []
  const length = Math.max(previous.frame.values.length, candidate.frame.values.length)
  let changed = previous.frame.values.length !== length
  for (let index = 0; index < length; index++) {
    const previousValue = previous.frame.values[index]
    const candidateValue = candidate.frame.values[index]
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
    const previousSlot = previous.shared[index]!
    const candidateSlot = candidate.shared[index]!
    if (previousSlot.kind === 'uninitialized' || candidateSlot.kind === 'uninitialized') {
      shared.push({kind: 'uninitialized'})
      if (previousSlot.kind !== 'uninitialized') changed = true
    } else {
      const joined = joinValues(previousSlot.value, candidateSlot.value)
      const merged = widen ? widenValue(previousSlot.value, joined) : joined
      shared.push({kind: 'value', value: merged})
      if (!sameValues(previousSlot.value, merged)) changed = true
    }
  }
  const valueFacts = intersectValueFacts(previous.valueFacts, candidate.valueFacts)
  if (valueFacts.length !== previous.valueFacts.length) changed = true
  const state: ExecutionState = {
    frame: {values},
    shared,
    valueFacts,
  }
  return {state, changed}
}

// Uninitialized dominates: a binding is only initialized when every joined path
// initialized it.
export function joinModuleSlots(left: ModuleSlot[], right: ModuleSlot[]): ModuleSlot[] {
  const joined: ModuleSlot[] = []
  for (let index = 0; index < left.length; index++) {
    const leftSlot = left[index]!
    const rightSlot = right[index]!
    joined.push(
      leftSlot.kind === 'uninitialized' || rightSlot.kind === 'uninitialized'
        ? {kind: 'uninitialized'}
        : {kind: 'value', value: joinValues(leftSlot.value, rightSlot.value)},
    )
  }
  return joined
}
