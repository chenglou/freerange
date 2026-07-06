import type {AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'

export type FunctionFrame = {
  values: Array<AbstractValue | undefined>
  // For each ValueID produced by a moduleRead: the slot version the read observed (see
  // ModuleSlot.version). A refinement of the read's result may narrow the slot only while
  // the slot still carries that version.
  readVersions: Array<number | undefined>
}

// One module binding's storage. Uninitialized is a distinct state (not just an unknown
// value) so runtime import-cycle support can be added later; reading an uninitialized slot
// stops the path.
//
// version stamps the last write: every moduleWrite, moduleHavoc, and seeding draws a fresh
// number, and a join keeps the version only when every joined path agrees (mixedSlotVersion
// otherwise). "slot.version equals the version a read observed" therefore means no write
// came between the read and now, on every path the state covers — the condition under
// which a fact about the read's result also describes the slot's current content. An
// earlier design compared object identity (slot.value === the read's frame value) instead;
// a review round defeated it with a merge whose join kept one path's identities for a
// state that also covers the other path.
export type ModuleSlot =
  | {kind: 'uninitialized'}
  | {kind: 'value'; value: AbstractValue; version: number}

export const mixedSlotVersion = -1
let slotVersionCounter = 0
export function freshSlotVersion(): number {
  slotVersionCounter += 1
  return slotVersionCounter
}

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
  // (the lower bound and integrality live on the value's own interval; the list records
  // only the below-length half, named by canonical value keys so repeated property
  // reads of the same record match, and seeded across calls for argument pairs).
  // Parameter- and value-rooted pairs never invalidate (immutable values); module-rooted
  // pairs drop at module writes, havocs, and calls — see dropModuleRootedPairs. Sound to keep for the
  // whole evaluation: IR values never change and arrays are immutable after construction,
  // so the fact cannot be invalidated — joins still intersect, since a fact must hold on
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

// Canonical keys rooted at a module binding (m3, m3.sizes) name the binding, not the
// value it currently holds — and rebinding the module root is the subset's one blessed
// update idiom, so a pair proven against the old value must not survive a write. Called
// at moduleWrite and moduleHavoc with the written binding, and after a completed call
// with null (the callee may have written any binding; parameter- and value-rooted pairs
// survive, since those name immutable values the callee cannot swap out).
export function dropModuleRootedPairs(pairs: ValidIndexPair[], binding: number | null): ValidIndexPair[] {
  const root = binding == null ? null : `m${binding}`
  const affected = (key: string): boolean => root == null
    ? /^m\d/.test(key)
    : key === root || key.startsWith(`${root}.`)
  return pairs.filter(pair => !affected(pair.index) && !affected(pair.array))
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
    frame: {values: state.frame.values.slice(), readVersions: state.frame.readVersions.slice()},
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
  // A read version survives the join only when both sides observed the same one — if any
  // joined path saw a different slot state (or never ran the read), the fact is dropped
  // and the read's refinements stop narrowing the slot.
  const readVersions: FunctionFrame['readVersions'] = []
  const readLength = Math.max(left.frame.readVersions.length, right.frame.readVersions.length)
  for (let index = 0; index < readLength; index++) {
    const leftVersion = left.frame.readVersions[index]
    if (leftVersion != null && leftVersion === right.frame.readVersions[index]) {
      readVersions[index] = leftVersion
    }
  }
  const validIndexPairs = left.validIndexPairs.filter(pair =>
    hasValidIndexPair(right.validIndexPairs, pair.index, pair.array))
  return {
    frame: {values, readVersions},
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
        : {
          kind: 'value',
          value: joinValues(leftSlot.value, rightSlot.value),
          version: leftSlot.version === rightSlot.version ? leftSlot.version : mixedSlotVersion,
        },
    )
  }
  return joined
}

// The completeness check for sameState: every ExecutionState field must be listed here,
// and the comparison below must actually compare it. A field added to the type breaks
// compilation on this record until sameState handles it — a fact the equality skips is a
// fact the propagate fast-path can silently absorb across paths, which was a review-caught
// unsoundness (slot versions missing from the comparison). cloneState and joinStates need
// no such check: their returned object literals already fail to compile on a missing field.
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
  // Versions are part of the state: two states with equal values but different write
  // histories license different slot narrowings, so absorbing one into the other (the
  // propagate fast-path keeps the stored state when the join changes nothing) would let a
  // narrowing licensed on one path fire on a merged state covering both.
  const readLength = Math.max(left.frame.readVersions.length, right.frame.readVersions.length)
  for (let index = 0; index < readLength; index++) {
    if (left.frame.readVersions[index] !== right.frame.readVersions[index]) return false
  }
  for (let index = 0; index < left.shared.modules.length; index++) {
    const leftSlot = left.shared.modules[index]!
    const rightSlot = right.shared.modules[index]!
    if (leftSlot.kind !== rightSlot.kind) return false
    if (leftSlot.kind === 'value' && rightSlot.kind === 'value') {
      if (leftSlot.version !== rightSlot.version) return false
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
  for (let index = 0; index < widened.shared.modules.length; index++) {
    const previousSlot = previous.shared.modules[index]!
    const slot = widened.shared.modules[index]!
    if (previousSlot.kind === 'value' && slot.kind === 'value') {
      // The version stays the joined one: widening loosens the value cover, it is not a write.
      widened.shared.modules[index] = {kind: 'value', value: widenValue(previousSlot.value, slot.value), version: slot.version}
    }
  }
  return widened
}
