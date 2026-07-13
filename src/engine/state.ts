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
  // The one relational fact the analysis carries: "this value is a valid index into
  // that array" — established by the bounds-check guard `i >= 0 && i < arr.length`
  // (the lower bound and integrality live on the value's own interval; the list records
  // only the below-length half, named by canonical value keys so repeated property
  // reads of the same record match, and seeded across calls for argument pairs).
  // Sound to keep for the whole evaluation: IR values never change and arrays are
  // immutable after construction, so the fact cannot be invalidated. Joins still
  // intersect, since a fact must hold on
  // every incoming path. Deliberately not a general relational domain: one relation kind,
  // no transitivity, no arithmetic over it. A handful of pairs per state at most, so a
  // plain deduplicated array with linear scans.
  validIndexPairs: ValidIndexPair[]
}

export type ValidIndexPair = {index: string; array: string}

export function hasValidIndexPair(pairs: ValidIndexPair[], index: string, array: string): boolean {
  return pairs.some(pair => pair.index === index && pair.array === array)
}

export function addValidIndexPair(pairs: ValidIndexPair[], index: string, array: string): void {
  if (!hasValidIndexPair(pairs, index, array)) pairs.push({index, array})
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
    // Pair objects are never mutated, only appended or filtered, so a shallow copy suffices.
    validIndexPairs: state.validIndexPairs.slice(),
  }
}

// A new state field must participate in both the merged value and `changed`. Listing the
// fields here makes that review mandatory when ExecutionState grows.
const mergedStateFields: Record<keyof ExecutionState, true> = {frame: true, shared: true, validIndexPairs: true}

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
  const validIndexPairs = previous.validIndexPairs.filter(pair =>
    hasValidIndexPair(candidate.validIndexPairs, pair.index, pair.array))
  if (validIndexPairs.length !== previous.validIndexPairs.length) changed = true
  const state: ExecutionState = {
    frame: {values},
    shared,
    validIndexPairs,
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
