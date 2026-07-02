import type {AbstractValue} from '../domain/value.ts'
import type {SiteID} from '../ir/ids.ts'

// Where an abstract object comes from. Display data for stop messages only: joins and
// widening ignore it, so it cannot affect convergence.
export type AllocationOrigin =
  | {kind: 'site'; site: SiteID}
  | {kind: 'parameter'; name: string}
  // Two same-shaped objects from different origins merged at a join.
  | {kind: 'merged'}

// Two objects a join cannot merge, returned as data so the engine records a stop instead
// of crashing the whole file. 'allocations': two references to different allocations met
// at a join. 'objectShapes': two objects with different property sets met in one heap slot.
export type JoinConflict = {
  kind: 'joinConflict'
  conflict: 'allocations' | 'objectShapes'
  left: AllocationOrigin
  right: AllocationOrigin
}

type AbstractObjectProperty = {
  name: string
  value: AbstractValue
}

export type AbstractObject = {
  origin: AllocationOrigin
  properties: AbstractObjectProperty[]
}

export type AbstractHeap = AbstractObject[]
