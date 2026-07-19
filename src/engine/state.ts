import type {AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'
import type {NumericInputCondition} from '../requirements/model.ts'

// Indexed by ModuleBindingID, fixed length per program. Flows through calls, so a
// callee's module writes are visible to the caller after a completed call. Null means the
// binding is not initialized; reading it stops the path.
export type SharedState = Array<AbstractValue | null>

export type ExecutionState = {
  values: Array<AbstractValue | undefined>
  shared: SharedState
  // Conditions established by a guard or by a requirement/assumption already recorded
  // on this path. Value keys name immutable runtime values, so assignment naturally uses
  // a new key. Joins intersect the set. This is deliberately a closed set of seven facts,
  // with no transitivity or arithmetic.
  valueFacts: ValueFacts
}

export type ValueFact =
  | {kind: 'nonzero'; value: string}
  // A caller requirement, or a completed helper's normal return, established one of the
  // numeric conditions understood by input requirements.
  | {kind: 'numericCondition'; value: string; condition: NumericInputCondition}
  // Number.isNaN's true branch. The interval domain has no NaN-only value, so this fact
  // lets later checks and operations recognize that exact case.
  | {kind: 'nan'; value: string}
  // A finite/integer guard that dominates one source block. The scope lets block entry
  // replace this function's guard facts without discarding a caller's guard during a call.
  | {kind: 'guardFinite'; value: string; scope: string}
  // The strict `index < array.length` half of a bounds guard. The index's own abstract
  // number must still prove integer, non-NaN, and nonnegative.
  | {kind: 'belowLength'; index: string; array: string}
  // The numeric part of a complete index condition, retained independently of which
  // array established it.
  | {kind: 'validArrayIndex'; value: string}
  // A requirement or assumption for an asserted read proves the complete condition.
  | {kind: 'validIndex'; index: string; array: string}

export type ValueFacts = Map<string, ValueFact>

export function hasNonzeroFact(facts: ValueFacts, value: string): boolean {
  return facts.has(singleValueFactKey('nonzero', value))
}

export function hasFiniteFact(facts: ValueFacts, value: string): boolean {
  return hasGuardFiniteFact(facts, value)
    || hasValidArrayIndexFact(facts, value)
    || hasNumericCondition(facts, value, 'finite')
    || (hasNumericCondition(facts, value, 'notNaN')
      && hasNumericCondition(facts, value, 'notInfinite'))
}

export function hasNotNaNFact(facts: ValueFacts, value: string): boolean {
  return hasGuardFiniteFact(facts, value)
    || hasValidArrayIndexFact(facts, value)
    || hasNumericCondition(facts, value, 'finite')
    || hasNumericCondition(facts, value, 'notNaN')
}

export function hasNaNFact(facts: ValueFacts, value: string): boolean {
  return facts.has(singleValueFactKey('nan', value))
}

export function hasNotInfiniteFact(facts: ValueFacts, value: string): boolean {
  return hasNaNFact(facts, value)
    || hasGuardFiniteFact(facts, value)
    || hasValidArrayIndexFact(facts, value)
    || hasNumericCondition(facts, value, 'finite')
    || hasNumericCondition(facts, value, 'notInfinite')
}

export function hasIndexFact(
  facts: ValueFacts,
  kind: 'belowLength' | 'validIndex',
  index: string,
  array: string,
): boolean {
  return facts.has(indexFactKey(kind, index, array))
}

export function hasValidArrayIndexFact(facts: ValueFacts, value: string): boolean {
  return facts.has(singleValueFactKey('validArrayIndex', value))
}

export function addValueFact(facts: ValueFacts, candidate: ValueFact): void {
  const key = valueFactKey(candidate)
  if (!facts.has(key)) facts.set(key, candidate)
}

export function intersectValueFacts(left: ValueFacts, right: ValueFacts): ValueFacts {
  const intersection: ValueFacts = new Map()
  const numericValues = new Set<string>()
  for (const [key, leftFact] of left) {
    const numericValue = valueWithNumericCondition(leftFact)
    if (numericValue != null) numericValues.add(numericValue)
    if (right.has(key)) {
      intersection.set(key, leftFact)
      continue
    }
    if (leftFact.kind !== 'belowLength' && leftFact.kind !== 'validIndex') continue
    const counterpart = leftFact.kind === 'belowLength' ? 'validIndex' : 'belowLength'
    const belowLength = indexFactKey('belowLength', leftFact.index, leftFact.array)
    if (right.has(indexFactKey(counterpart, leftFact.index, leftFact.array))) {
      intersection.set(belowLength, {
        kind: 'belowLength',
        index: leftFact.index,
        array: leftFact.array,
      })
    }
  }
  // The same condition can arrive in different forms: an inline guard carries a scoped
  // finite fact, a completed helper carries a numeric condition, and a valid array index
  // is finite by construction. Keep what both paths actually prove instead of requiring
  // their storage form to match.
  for (const value of numericValues) {
    if (hasFiniteFact(left, value) && hasFiniteFact(right, value)) {
      addValueFact(intersection, {kind: 'numericCondition', value, condition: 'finite'})
      continue
    }
    if (hasNotNaNFact(left, value) && hasNotNaNFact(right, value)) {
      addValueFact(intersection, {kind: 'numericCondition', value, condition: 'notNaN'})
    }
    if (hasNotInfiniteFact(left, value) && hasNotInfiniteFact(right, value)) {
      addValueFact(intersection, {kind: 'numericCondition', value, condition: 'notInfinite'})
    }
  }
  return intersection
}

function valueWithNumericCondition(fact: ValueFact): string | null {
  switch (fact.kind) {
    case 'numericCondition':
    case 'nan':
    case 'guardFinite':
    case 'validArrayIndex': return fact.value
    case 'nonzero':
    case 'belowLength':
    case 'validIndex': return null
  }
}

function hasGuardFiniteFact(facts: ValueFacts, value: string): boolean {
  return facts.has(guardFiniteFactKey(value))
}

function hasNumericCondition(
  facts: ValueFacts,
  value: string,
  condition: NumericInputCondition,
): boolean {
  return facts.has(numericConditionFactKey(value, condition))
}

function valueFactKey(fact: ValueFact): string {
  switch (fact.kind) {
    case 'nonzero': return singleValueFactKey('nonzero', fact.value)
    case 'numericCondition': return numericConditionFactKey(fact.value, fact.condition)
    case 'nan': return singleValueFactKey('nan', fact.value)
    // An outer guard already dominates an inner guard for the same immutable value. The
    // first scope therefore owns the fact until it leaves; a nested scope adds nothing.
    case 'guardFinite': return guardFiniteFactKey(fact.value)
    case 'belowLength': return indexFactKey('belowLength', fact.index, fact.array)
    case 'validArrayIndex': return singleValueFactKey('validArrayIndex', fact.value)
    case 'validIndex': return indexFactKey('validIndex', fact.index, fact.array)
  }
}

function singleValueFactKey(kind: 'nonzero' | 'nan' | 'validArrayIndex', value: string): string {
  return JSON.stringify([kind, value])
}

function numericConditionFactKey(value: string, condition: NumericInputCondition): string {
  return JSON.stringify(['numericCondition', value, condition])
}

function guardFiniteFactKey(value: string): string {
  return JSON.stringify(['guardFinite', value])
}

function indexFactKey(
  kind: 'belowLength' | 'validIndex',
  index: string,
  array: string,
): string {
  return JSON.stringify([kind, index, array])
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
    valueFacts: new Map(state.valueFacts),
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
  if (valueFacts.size !== previous.valueFacts.size) changed = true
  else {
    for (const key of valueFacts.keys()) {
      if (!previous.valueFacts.has(key)) {
        changed = true
        break
      }
    }
  }
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
