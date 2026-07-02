import type {AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'
import type {AbstractHeap} from '../heap/model.ts'
import {cloneHeap, joinHeaps, sameHeaps, widenHeap} from '../heap/operations.ts'

export type FunctionFrame = {
  values: Array<AbstractValue | undefined>
}

export type SharedState = {
  heap: AbstractHeap
}

export type ExecutionState = {
  frame: FunctionFrame
  shared: SharedState
}

export function emptySharedState(): SharedState {
  return {heap: []}
}

export function cloneSharedState(state: SharedState): SharedState {
  return {heap: cloneHeap(state.heap)}
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
    shared: {heap: joinHeaps(left.shared.heap, right.shared.heap)},
  }
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
  return sameHeaps(left.shared.heap, right.shared.heap)
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
  return widened
}
