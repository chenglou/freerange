import type {
  AbstractBoolean,
  AbstractHeap,
  AbstractNumber,
  AbstractObject,
  AbstractReference,
  AbstractValue,
} from './domain.ts'

export type State = {
  values: Array<AbstractValue | undefined>
  heap: AbstractHeap
}

export function cloneState(state: State): State {
  return {values: state.values.slice(), heap: cloneHeap(state.heap)}
}

export function cloneHeap(heap: AbstractHeap): AbstractHeap {
  return heap.map(cloneObject)
}

export function joinStates(left: State, right: State): State {
  const values: State['values'] = []
  const length = Math.max(left.values.length, right.values.length)
  for (let index = 0; index < length; index++) {
    const leftValue = left.values[index]
    const rightValue = right.values[index]
    if (leftValue == null) values[index] = rightValue
    else if (rightValue == null) values[index] = leftValue
    else values[index] = joinValues(leftValue, rightValue)
  }
  return {values, heap: joinHeaps(left.heap, right.heap)}
}

export function joinValues(left: AbstractValue, right: AbstractValue): AbstractValue {
  if (left.kind !== right.kind) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'reference': return joinReferences(left, right as AbstractReference)
    case 'void': return left
  }
}

export function joinHeaps(left: AbstractHeap, right: AbstractHeap): AbstractHeap {
  const heap: AbstractHeap = []
  const length = Math.max(left.length, right.length)
  for (let allocation = 0; allocation < length; allocation++) {
    const leftObject = left[allocation]
    const rightObject = right[allocation]
    if (leftObject == null) heap.push(cloneObject(rightObject!))
    else if (rightObject == null) heap.push(cloneObject(leftObject))
    else heap.push(joinObjects(leftObject, rightObject))
  }
  return heap
}

export function sameState(left: State, right: State): boolean {
  if (left.values.length !== right.values.length || left.heap.length !== right.heap.length) return false
  for (let index = 0; index < left.values.length; index++) {
    const leftValue = left.values[index]
    const rightValue = right.values[index]
    if (leftValue == null || rightValue == null) {
      if (leftValue !== rightValue) return false
    } else if (!sameValue(leftValue, rightValue)) return false
  }
  for (let allocation = 0; allocation < left.heap.length; allocation++) {
    const leftObject = left.heap[allocation]!
    const rightObject = right.heap[allocation]!
    if (leftObject.properties.length !== rightObject.properties.length) return false
    for (let index = 0; index < leftObject.properties.length; index++) {
      const leftProperty = leftObject.properties[index]!
      const rightProperty = rightObject.properties[index]!
      if (leftProperty.name !== rightProperty.name || !sameValue(leftProperty.value, rightProperty.value)) return false
    }
  }
  return true
}

export function widenState(previous: State, next: State): State {
  const widened = joinStates(previous, next)
  for (let index = 0; index < widened.values.length; index++) {
    const previousValue = previous.values[index]
    const nextValue = widened.values[index]
    if (previousValue != null && nextValue != null) widened.values[index] = widenValue(previousValue, nextValue)
  }
  for (let allocation = 0; allocation < widened.heap.length; allocation++) {
    const previousObject = previous.heap[allocation]
    const nextObject = widened.heap[allocation]
    if (previousObject == null || nextObject == null) continue
    for (let index = 0; index < nextObject.properties.length; index++) {
      const previousProperty = previousObject.properties[index]
      const nextProperty = nextObject.properties[index]
      if (previousProperty == null || nextProperty == null || previousProperty.name !== nextProperty.name) continue
      nextProperty.value = widenValue(previousProperty.value, nextProperty.value)
    }
  }
  return widened
}

function joinNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return {
    kind: 'number',
    lower: Math.min(left.lower, right.lower),
    upper: Math.max(left.upper, right.upper),
    integer: left.integer && right.integer,
    finite: left.finite && right.finite,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN,
  }
}

function joinBooleans(left: AbstractBoolean, right: AbstractBoolean): AbstractBoolean {
  return {
    kind: 'boolean',
    canBeTrue: left.canBeTrue || right.canBeTrue,
    canBeFalse: left.canBeFalse || right.canBeFalse,
  }
}

function joinReferences(left: AbstractReference, right: AbstractReference): AbstractReference {
  if (left.allocation !== right.allocation) throw new Error('Joining different object allocations is unsupported')
  return left
}

function joinObjects(left: AbstractObject, right: AbstractObject): AbstractObject {
  if (left.properties.length !== right.properties.length) throw new Error('Cannot join objects with different properties')
  const properties: AbstractObject['properties'] = []
  for (let index = 0; index < left.properties.length; index++) {
    const property = left.properties[index]!
    const other = right.properties[index]!
    if (property.name !== other.name) throw new Error('Cannot join objects with different properties')
    properties.push({name: property.name, value: joinValues(property.value, other.value)})
  }
  return {properties}
}

function cloneObject(object: AbstractObject): AbstractObject {
  return {properties: object.properties.map(property => ({...property}))}
}

function sameValue(left: AbstractValue, right: AbstractValue): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'number': {
      const other = right as AbstractNumber
      return left.lower === other.lower
        && left.upper === other.upper
        && left.integer === other.integer
        && left.finite === other.finite
        && left.mayBeNaN === other.mayBeNaN
    }
    case 'boolean': {
      const other = right as AbstractBoolean
      return left.canBeTrue === other.canBeTrue && left.canBeFalse === other.canBeFalse
    }
    case 'reference': return left.allocation === (right as AbstractReference).allocation
    case 'void': return true
  }
}

function widenValue(previous: AbstractValue, next: AbstractValue): AbstractValue {
  if (previous.kind !== 'number' || next.kind !== 'number') return next
  const finite = previous.finite && next.finite
  return {
    ...next,
    lower: next.lower < previous.lower
      ? finite ? -Number.MAX_VALUE : Number.NEGATIVE_INFINITY
      : next.lower,
    upper: next.upper > previous.upper
      ? finite ? Number.MAX_VALUE : Number.POSITIVE_INFINITY
      : next.upper,
  }
}
