import type {AbstractReference, AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, widenValue} from '../domain/value.ts'
import type {AbstractHeap, AbstractObject} from './model.ts'

export function cloneHeap(heap: AbstractHeap): AbstractHeap {
  return heap.map(cloneObject)
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

export function widenHeap(previous: AbstractHeap, next: AbstractHeap): AbstractHeap {
  const widened = joinHeaps(previous, next)
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
  properties: AbstractObject['properties'],
): AbstractReference {
  const allocation = heap.length
  heap.push({properties})
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
