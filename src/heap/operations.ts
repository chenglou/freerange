import type {AbstractReference, AbstractValue, ReferenceJoinConflict} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'
import type {AbstractHeap, AbstractObject, AllocationOrigin, JoinConflict} from './model.ts'

export function cloneHeap(heap: AbstractHeap): AbstractHeap {
  return heap.map(cloneObject)
}

export function joinHeaps(left: AbstractHeap, right: AbstractHeap): AbstractHeap | JoinConflict {
  const heap: AbstractHeap = []
  const length = Math.max(left.length, right.length)
  for (let allocation = 0; allocation < length; allocation++) {
    const leftObject = left[allocation]
    const rightObject = right[allocation]
    if (leftObject == null) heap.push(cloneObject(rightObject!))
    else if (rightObject == null) heap.push(cloneObject(leftObject))
    else {
      const joined = joinObjects(leftObject, rightObject, left, right)
      if ('kind' in joined) return joined
      heap.push(joined)
    }
  }
  return heap
}

// Origins are display data and deliberately not compared: two heaps with identical
// properties are the same heap, so origin differences cannot keep a loop from converging.
export function sameHeaps(left: AbstractHeap, right: AbstractHeap): boolean {
  if (left.length !== right.length) return false
  for (let allocation = 0; allocation < left.length; allocation++) {
    const leftObject = left[allocation]!
    const rightObject = right[allocation]!
    if (leftObject.properties.length !== rightObject.properties.length) return false
    for (let index = 0; index < leftObject.properties.length; index++) {
      const leftProperty = leftObject.properties[index]!
      const rightProperty = rightObject.properties[index]!
      if (leftProperty.name !== rightProperty.name || !sameValues(leftProperty.value, rightProperty.value)) return false
    }
  }
  return true
}

export function widenHeap(previous: AbstractHeap, next: AbstractHeap): AbstractHeap | JoinConflict {
  const widened = joinHeaps(previous, next)
  if ('kind' in widened) return widened
  for (let allocation = 0; allocation < widened.length; allocation++) {
    const previousObject = previous[allocation]
    const nextObject = widened[allocation]
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

export function allocateObject(
  heap: AbstractHeap,
  origin: AllocationOrigin,
  properties: AbstractObject['properties'],
): AbstractReference {
  const allocation = heap.length
  heap.push({origin, properties})
  return {kind: 'reference', allocation}
}

export function readProperty(heap: AbstractHeap, reference: AbstractReference, name: string): AbstractValue {
  const object = heap[reference.allocation]
  if (object == null) throw new Error(`Missing heap allocation ${reference.allocation}`)
  const property = object.properties.find(candidate => candidate.name === name)
  if (property == null) throw new Error(`Abstract object has no property ${name}`)
  return property.value
}

export function writeProperty(
  heap: AbstractHeap,
  reference: AbstractReference,
  name: string,
  value: AbstractValue,
): void {
  const object = heap[reference.allocation]
  if (object == null) throw new Error(`Missing heap allocation ${reference.allocation}`)
  const property = object.properties.find(candidate => candidate.name === name)
  if (property == null) throw new Error(`Abstract object has no property ${name}`)
  property.value = value
}

// Resolves the allocation indices a value-level join reported into the origins the stop
// record displays. Each index belongs to the heap its side of the join came from.
export function resolveReferenceConflict(
  conflict: ReferenceJoinConflict,
  leftHeap: AbstractHeap,
  rightHeap: AbstractHeap,
): JoinConflict {
  const left = leftHeap[conflict.leftAllocation]
  const right = rightHeap[conflict.rightAllocation]
  if (left == null || right == null) throw new Error('Join conflict references a missing allocation')
  return {kind: 'joinConflict', conflict: 'allocations', left: left.origin, right: right.origin}
}

function joinObjects(
  left: AbstractObject,
  right: AbstractObject,
  leftHeap: AbstractHeap,
  rightHeap: AbstractHeap,
): AbstractObject | JoinConflict {
  if (left.properties.length !== right.properties.length) {
    return {kind: 'joinConflict', conflict: 'objectShapes', left: left.origin, right: right.origin}
  }
  const properties: AbstractObject['properties'] = []
  for (let index = 0; index < left.properties.length; index++) {
    const property = left.properties[index]!
    const other = right.properties[index]!
    if (property.name !== other.name) {
      return {kind: 'joinConflict', conflict: 'objectShapes', left: left.origin, right: right.origin}
    }
    const value = joinValues(property.value, other.value)
    if (value.kind === 'referenceConflict') return resolveReferenceConflict(value, leftHeap, rightHeap)
    properties.push({name: property.name, value})
  }
  return {origin: sameOrigin(left.origin, right.origin) ? left.origin : {kind: 'merged'}, properties}
}

function sameOrigin(left: AllocationOrigin, right: AllocationOrigin): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'site': return left.site === (right as Extract<AllocationOrigin, {kind: 'site'}>).site
    case 'parameter': return left.name === (right as Extract<AllocationOrigin, {kind: 'parameter'}>).name
    case 'merged': return true
  }
}

function cloneObject(object: AbstractObject): AbstractObject {
  return {origin: object.origin, properties: object.properties.map(property => ({...property}))}
}
