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

export function joinStates(left: ExecutionState, right: ExecutionState): ExecutionState {
  const values: FunctionFrame['values'] = []
  const length = Math.max(left.frame.values.length, right.frame.values.length)
  for (let index = 0; index < length; index++) {
    const leftValue = left.frame.values[index]
    const rightValue = right.frame.values[index]
    if (leftValue == null) values[index] = rightValue
    else if (rightValue == null) values[index] = leftValue
    else values[index] = joinValues(leftValue, rightValue)
  }
  const validIndexPairs = left.validIndexPairs.filter(pair =>
    hasValidIndexPair(right.validIndexPairs, pair.index, pair.array))
  return {
    frame: {values},
    shared: joinModuleSlots(left.shared, right.shared),
    validIndexPairs,
  }
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

// The completeness check for sameState: every ExecutionState field must be listed here,
// and the comparison below must actually compare it. A field added to the type breaks
// compilation on this record until sameState handles it — a fact the equality skips is a
// fact the propagate fast-path can silently absorb across paths. cloneState and joinStates
// need no such check: their returned object literals already fail to compile on a missing
// field.
const comparedStateFields: Record<keyof ExecutionState, true> = {frame: true, shared: true, validIndexPairs: true}

export function sameState(left: ExecutionState, right: ExecutionState): boolean {
  void comparedStateFields
  if (left.frame.values.length !== right.frame.values.length) return false
  for (let index = 0; index < left.frame.values.length; index++) {
    const leftValue = left.frame.values[index]
    const rightValue = right.frame.values[index]
    if (leftValue == null || rightValue == null) {
      if (leftValue !== rightValue) return false
    } else if (!sameValues(leftValue, rightValue)) return false
  }
  for (let index = 0; index < left.shared.length; index++) {
    const leftSlot = left.shared[index]!
    const rightSlot = right.shared[index]!
    if (leftSlot.kind !== rightSlot.kind) return false
    if (leftSlot.kind === 'value' && rightSlot.kind === 'value') {
      if (!sameValues(leftSlot.value, rightSlot.value)) return false
    }
  }
  if (left.validIndexPairs.length !== right.validIndexPairs.length) return false
  for (const pair of left.validIndexPairs) {
    if (!hasValidIndexPair(right.validIndexPairs, pair.index, pair.array)) return false
  }
  return true
}

export function widenState(previous: ExecutionState, next: ExecutionState): ExecutionState {
  const widened = joinStates(previous, next)
  for (let index = 0; index < widened.frame.values.length; index++) {
    const previousValue = previous.frame.values[index]
    const nextValue = widened.frame.values[index]
    if (previousValue != null && nextValue != null) {
      widened.frame.values[index] = widenValue(previousValue, nextValue)
    }
  }
  for (let index = 0; index < widened.shared.length; index++) {
    const previousSlot = previous.shared[index]!
    const slot = widened.shared[index]!
    if (previousSlot.kind === 'value' && slot.kind === 'value') {
      widened.shared[index] = {kind: 'value', value: widenValue(previousSlot.value, slot.value)}
    }
  }
  return widened
}
