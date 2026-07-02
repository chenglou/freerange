import type {AbstractReference, AbstractValue} from '../domain/value.ts'
import {joinValues, sameValues, singletonReference, unionTargets, widenValue} from '../domain/value.ts'
import type {SiteID} from '../ir/ids.ts'
import type {AbstractHeap, AbstractObject, AllocationContext, AllocationIdentity} from './model.ts'
import {compareIdentity, sameIdentity} from './model.ts'

export function cloneHeap(heap: AbstractHeap): AbstractHeap {
  return heap.map(cloneObject)
}

// Identity-keyed and total: same identity means same allocation site (or parameter), so the
// property lists agree and entries join pointwise; a one-sided entry copies over, since the
// absent side's executions never created it and hold no references to it.
export function joinHeaps(left: AbstractHeap, right: AbstractHeap): AbstractHeap {
  const heap: AbstractHeap = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftObject = left[leftIndex]
    const rightObject = right[rightIndex]
    if (leftObject == null) {
      heap.push(cloneObject(rightObject!))
      rightIndex++
      continue
    }
    if (rightObject == null) {
      heap.push(cloneObject(leftObject))
      leftIndex++
      continue
    }
    const order = compareIdentity(leftObject.identity, rightObject.identity)
    if (order < 0) {
      heap.push(cloneObject(leftObject))
      leftIndex++
    } else if (order > 0) {
      heap.push(cloneObject(rightObject))
      rightIndex++
    } else {
      heap.push(joinObjects(leftObject, rightObject))
      leftIndex++
      rightIndex++
    }
  }
  return heap
}

export function sameHeaps(left: AbstractHeap, right: AbstractHeap): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const leftObject = left[index]!
    const rightObject = right[index]!
    if (!sameIdentity(leftObject.identity, rightObject.identity)) return false
    if (leftObject.properties.length !== rightObject.properties.length) return false
    for (let property = 0; property < leftObject.properties.length; property++) {
      const leftProperty = leftObject.properties[property]!
      const rightProperty = rightObject.properties[property]!
      if (leftProperty.name !== rightProperty.name || !sameValues(leftProperty.value, rightProperty.value)) return false
    }
  }
  return true
}

export function widenHeap(previous: AbstractHeap, next: AbstractHeap): AbstractHeap {
  const widened = joinHeaps(previous, next)
  for (const object of widened) {
    const previousObject = findObject(previous, object.identity)
    if (previousObject == null) continue
    for (let index = 0; index < object.properties.length; index++) {
      const previousProperty = previousObject.properties[index]
      const property = object.properties[index]!
      if (previousProperty == null || previousProperty.name !== property.name) continue
      property.value = widenValue(previousProperty.value, property.value)
    }
  }
  return widened
}

// Executes an object literal. First execution installs a known singleton. Re-execution
// demotes the previous object — joins it into the site's summary, repoints every reference
// in the frame and the heap from the known identity to the summary — then installs the
// fresh object in the vacated known slot. The fresh singleton describes a different, newly
// created runtime object, never an upgrade of the summary.
export function allocateAtSite(
  frameValues: Array<AbstractValue | undefined>,
  heap: AbstractHeap,
  site: SiteID,
  context: AllocationContext,
  properties: AbstractObject['properties'],
): AbstractReference {
  const known: AllocationIdentity = {kind: 'site', site, context, slot: 'known'}
  const existing = findObject(heap, known)
  if (existing == null) {
    insertObject(heap, {identity: known, properties})
    return singletonReference(known)
  }
  const summary: AllocationIdentity = {kind: 'site', site, context, slot: 'summary'}
  const existingSummary = findObject(heap, summary)
  if (existingSummary == null) {
    insertObject(heap, {
      identity: summary,
      properties: existing.properties.map(property => ({...property})),
    })
  } else {
    for (let index = 0; index < existingSummary.properties.length; index++) {
      const summaryProperty = existingSummary.properties[index]!
      const displaced = existing.properties[index]
      if (displaced == null || displaced.name !== summaryProperty.name) {
        throw new Error('Summary and known objects of one site disagree on properties')
      }
      summaryProperty.value = joinValues(summaryProperty.value, displaced.value)
    }
  }
  renameTargets(frameValues, heap, known, summary)
  // The fresh property values were read from the frame before this demotion, so they are
  // one more reference-carrying location the repoint must cover: a property referencing
  // this same site's previous object must target the summary, not the fresh object.
  for (const property of properties) {
    if (property.value.kind === 'reference') property.value = renameReference(property.value, known, summary)
  }
  existing.properties = properties
  return singletonReference(known)
}

export function allocateParameter(
  heap: AbstractHeap,
  parameterIndex: number,
  properties: AbstractObject['properties'],
): AbstractReference {
  const identity: AllocationIdentity = {kind: 'parameter', parameterIndex}
  insertObject(heap, {identity, properties})
  return singletonReference(identity)
}

// After adopting a completed callee's heap, a caller-frame reference to a known slot may
// denote an object the callee displaced (the same call instruction re-executed, e.g. in a
// loop). The callee repointed its own frame and the heap's stored references but cannot see
// this frame, so any known target whose site now has a summary gains that summary as an
// extra target. Union, never replacement: extra targets only weaken reads and writes, so
// this stays sound even when the summary predates the call.
export function adoptCalleeHeap(frameValues: Array<AbstractValue | undefined>, heap: AbstractHeap): void {
  for (let index = 0; index < frameValues.length; index++) {
    const value = frameValues[index]
    if (value == null || value.kind !== 'reference') continue
    let targets = value.targets
    for (const target of value.targets) {
      if (target.kind !== 'site' || target.slot !== 'known') continue
      const summary: AllocationIdentity = {kind: 'site', site: target.site, context: target.context, slot: 'summary'}
      if (findObject(heap, summary) != null) targets = unionTargets(targets, [summary])
    }
    if (targets !== value.targets) frameValues[index] = {kind: 'reference', targets}
  }
}

export function readProperty(heap: AbstractHeap, reference: AbstractReference, name: string): AbstractValue {
  let joined: AbstractValue | null = null
  for (const target of reference.targets) {
    joined = joined == null
      ? propertyValue(heap, target, name)
      : joinValues(joined, propertyValue(heap, target, name))
  }
  if (joined == null) throw new Error('Reference with no targets')
  return joined
}

// Strong only when the reference addresses exactly one known runtime object; otherwise the
// write joins old and new values into every target — skipping any target would be a silent
// mutation no-op. A single parameter target counts as one known object only because the
// lowering rejects a second object parameter (multipleObjectParameters); with two object
// parameters, one runtime object could enter under two identities and a strong write
// through one would silently miss the other.
export function writeProperty(
  heap: AbstractHeap,
  reference: AbstractReference,
  name: string,
  value: AbstractValue,
): void {
  const single = reference.targets.length === 1 ? reference.targets[0]! : null
  const strong = single != null && (single.kind === 'parameter' || single.slot === 'known')
  for (const target of reference.targets) {
    const object = findObject(heap, target)
    if (object == null) throw new Error('Reference target is missing from the heap')
    const property = object.properties.find(candidate => candidate.name === name)
    if (property == null) throw new Error(`Abstract object has no property ${name}`)
    property.value = strong ? value : joinValues(property.value, value)
  }
}

// The property list a reference presents: the names present in EVERY target, values joined
// across all targets. Targets can disagree on shape even in type-correct code — TypeScript
// reduces an inferred union like {x} | {x, y} to plain {x} by width subtyping — and the
// static type only ever permits reading the shared properties, so the intersection is
// exactly what the reference can observe.
export function referenceProperties(heap: AbstractHeap, reference: AbstractReference): AbstractObject['properties'] {
  const firstTarget = reference.targets[0]
  if (firstTarget == null) throw new Error('Reference with no targets')
  const first = findObject(heap, firstTarget)
  if (first == null) throw new Error('Reference target is missing from the heap')
  const shared = first.properties.filter(property => reference.targets.every(target => {
    const object = findObject(heap, target)
    if (object == null) throw new Error('Reference target is missing from the heap')
    return object.properties.some(candidate => candidate.name === property.name)
  }))
  return shared.map(property => ({
    name: property.name,
    value: readProperty(heap, reference, property.name),
  }))
}

function propertyValue(heap: AbstractHeap, target: AllocationIdentity, name: string): AbstractValue {
  const object = findObject(heap, target)
  if (object == null) throw new Error('Reference target is missing from the heap')
  const property = object.properties.find(candidate => candidate.name === name)
  if (property == null) throw new Error(`Abstract object has no property ${name}`)
  return property.value
}

function renameTargets(
  frameValues: Array<AbstractValue | undefined>,
  heap: AbstractHeap,
  from: AllocationIdentity,
  to: AllocationIdentity,
): void {
  for (let index = 0; index < frameValues.length; index++) {
    const value = frameValues[index]
    if (value != null && value.kind === 'reference') frameValues[index] = renameReference(value, from, to)
  }
  for (const object of heap) {
    for (const property of object.properties) {
      if (property.value.kind === 'reference') property.value = renameReference(property.value, from, to)
    }
  }
}

function renameReference(
  reference: AbstractReference,
  from: AllocationIdentity,
  to: AllocationIdentity,
): AbstractReference {
  if (!reference.targets.some(target => sameIdentity(target, from))) return reference
  const remaining = reference.targets.filter(target => !sameIdentity(target, from))
  return {kind: 'reference', targets: unionTargets(remaining, [to])}
}

function joinObjects(left: AbstractObject, right: AbstractObject): AbstractObject {
  if (left.properties.length !== right.properties.length) {
    throw new Error('Cannot join objects with different properties')
  }
  const properties: AbstractObject['properties'] = []
  for (let index = 0; index < left.properties.length; index++) {
    const property = left.properties[index]!
    const other = right.properties[index]!
    if (property.name !== other.name) throw new Error('Cannot join objects with different properties')
    properties.push({name: property.name, value: joinValues(property.value, other.value)})
  }
  return {identity: left.identity, properties}
}

function findObject(heap: AbstractHeap, identity: AllocationIdentity): AbstractObject | null {
  for (const object of heap) {
    if (sameIdentity(object.identity, identity)) return object
  }
  return null
}

function insertObject(heap: AbstractHeap, object: AbstractObject): void {
  let index = 0
  while (index < heap.length && compareIdentity(heap[index]!.identity, object.identity) < 0) index++
  heap.splice(index, 0, object)
}

function cloneObject(object: AbstractObject): AbstractObject {
  return {identity: object.identity, properties: object.properties.map(property => ({...property}))}
}
