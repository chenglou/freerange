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

export type SharedState = {
  // Indexed by ModuleBindingID, fixed length per program. Flows through calls, so a
  // callee's module writes are visible to the caller after a completed call.
  modules: ModuleSlot[]
}

export type ExecutionState = {
  frame: FunctionFrame
  shared: SharedState
  // The one relational fact the analysis carries: "this value is a valid index into
  // that array" — established by the bounds-check guard `i >= 0 && i < arr.length`
  // (the lower bound and integrality live on the value's own interval; the set records
  // only the below-length half, keyed by canonical value names so repeated property
  // reads of the same record match, and seeded across calls for argument pairs).
  // Parameter- and value-rooted pairs never invalidate (immutable values); module-rooted
  // pairs drop at module writes, havocs, and calls — see dropModuleRootedPairs. Sound to keep for the
  // whole evaluation: IR values never change and arrays are immutable after construction,
  // so the fact cannot be invalidated — joins still intersect, since a fact must hold on
  // every incoming path. Deliberately not a general relational domain: one relation kind,
  // no transitivity, no arithmetic over it.
  validIndexPairs: Set<string>
}

export function validIndexKey(indexKey: string, arrayKey: string): string {
  return `${indexKey}<${arrayKey}`
}

// Canonical keys rooted at a module binding (m3, m3.sizes) name the binding, not the
// value it currently holds — and rebinding the module root is the subset's one blessed
// update idiom, so a pair proven against the old value must not survive a write. Called
// at moduleWrite and moduleHavoc with the written binding, and after a completed call
// with null (the callee may have written any binding; parameter- and value-rooted pairs
// survive, since those name immutable values the callee cannot swap out).
export function dropModuleRootedPairs(pairs: Set<string>, binding: number | null): void {
  const root = binding == null ? null : `m${binding}`
  const affected = (key: string): boolean => root == null
    ? /^m\d/.test(key)
    : key === root || key.startsWith(`${root}.`) || key.startsWith(`${root}<`)
  for (const pair of [...pairs]) {
    const separator = pair.indexOf('<')
    const indexKey = pair.slice(0, separator)
    const arrayKey = pair.slice(separator + 1)
    if (affected(indexKey) || affected(arrayKey)) pairs.delete(pair)
  }
}

export function emptySharedState(moduleCount: number): SharedState {
  const modules: ModuleSlot[] = []
  for (let index = 0; index < moduleCount; index++) modules.push({kind: 'uninitialized'})
  return {modules}
}

export function cloneSharedState(state: SharedState): SharedState {
  // Slots are replaced whole on write, never mutated, so a shallow copy suffices.
  return {modules: state.modules.slice()}
}

export function cloneState(state: ExecutionState): ExecutionState {
  return {
    frame: {values: state.frame.values.slice()},
    shared: cloneSharedState(state.shared),
    validIndexPairs: new Set(state.validIndexPairs),
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
  const validIndexPairs = new Set<string>()
  for (const pair of left.validIndexPairs) {
    if (right.validIndexPairs.has(pair)) validIndexPairs.add(pair)
  }
  return {
    frame: {values},
    shared: {
      modules: joinModuleSlots(left.shared.modules, right.shared.modules),
    },
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

export function sameState(left: ExecutionState, right: ExecutionState): boolean {
  if (left.frame.values.length !== right.frame.values.length) return false
  for (let index = 0; index < left.frame.values.length; index++) {
    const leftValue = left.frame.values[index]
    const rightValue = right.frame.values[index]
    if (leftValue == null || rightValue == null) {
      if (leftValue !== rightValue) return false
    } else if (!sameValues(leftValue, rightValue)) return false
  }
  for (let index = 0; index < left.shared.modules.length; index++) {
    const leftSlot = left.shared.modules[index]!
    const rightSlot = right.shared.modules[index]!
    if (leftSlot.kind !== rightSlot.kind) return false
    if (leftSlot.kind === 'value' && rightSlot.kind === 'value' && !sameValues(leftSlot.value, rightSlot.value)) {
      return false
    }
  }
  if (left.validIndexPairs.size !== right.validIndexPairs.size) return false
  for (const pair of left.validIndexPairs) {
    if (!right.validIndexPairs.has(pair)) return false
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
  for (let index = 0; index < widened.shared.modules.length; index++) {
    const previousSlot = previous.shared.modules[index]!
    const slot = widened.shared.modules[index]!
    if (previousSlot.kind === 'value' && slot.kind === 'value') {
      widened.shared.modules[index] = {kind: 'value', value: widenValue(previousSlot.value, slot.value)}
    }
  }
  return widened
}
