import type {AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'
import type {AbstractHeap} from '../heap/model.ts'
import {cloneHeap, joinHeaps, sameHeaps, widenHeap} from '../heap/operations.ts'

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
  heap: AbstractHeap
  // Indexed by ModuleBindingID, fixed length per program. Flows through calls exactly like
  // the heap, so a callee's module writes are visible to the caller after a completed call.
  modules: ModuleSlot[]
}

export type ExecutionState = {
  frame: FunctionFrame
  shared: SharedState
}

export function emptySharedState(moduleCount: number): SharedState {
  const modules: ModuleSlot[] = []
  for (let index = 0; index < moduleCount; index++) modules.push({kind: 'uninitialized'})
  return {heap: [], modules}
}

export function cloneSharedState(state: SharedState): SharedState {
  // Slots are replaced whole on write, never mutated, so a shallow copy suffices.
  return {heap: cloneHeap(state.heap), modules: state.modules.slice()}
}

export function cloneState(state: ExecutionState): ExecutionState {
  return {
    frame: {values: state.frame.values.slice()},
    shared: cloneSharedState(state.shared),
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
  return {
    frame: {values},
    shared: {
      heap: joinHeaps(left.shared.heap, right.shared.heap),
      modules: joinModuleSlots(left.shared.modules, right.shared.modules),
    },
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
  if (!sameHeaps(left.shared.heap, right.shared.heap)) return false
  for (let index = 0; index < left.shared.modules.length; index++) {
    const leftSlot = left.shared.modules[index]!
    const rightSlot = right.shared.modules[index]!
    if (leftSlot.kind !== rightSlot.kind) return false
    if (leftSlot.kind === 'value' && rightSlot.kind === 'value' && !sameValues(leftSlot.value, rightSlot.value)) {
      return false
    }
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
  widened.shared.heap = widenHeap(previous.shared.heap, next.shared.heap)
  for (let index = 0; index < widened.shared.modules.length; index++) {
    const previousSlot = previous.shared.modules[index]!
    const slot = widened.shared.modules[index]!
    if (previousSlot.kind === 'value' && slot.kind === 'value') {
      widened.shared.modules[index] = {kind: 'value', value: widenValue(previousSlot.value, slot.value)}
    }
  }
  return widened
}
