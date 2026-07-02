import type {AbstractValue} from '../domain/value.ts'
import type {SiteID} from '../ir/ids.ts'

// The immediate call site that entered the allocating function, or null at the analysis
// root. This alias, the call site the call arm in engine/transfer.ts passes to the callee,
// and compareIdentity are the entire replaceable context policy: a deeper policy changes
// them and nothing else.
export type AllocationContext = SiteID | null

// Identity of one abstract allocation. 'known' is the single object created by the most
// recent execution of the site under this context — strong updates are sound. 'summary'
// stands for every object that site+context displaced — writes join old and new values,
// and a summary never becomes known again.
export type AllocationIdentity =
  | {kind: 'site'; site: SiteID; context: AllocationContext; slot: 'known' | 'summary'}
  // A root object parameter: one runtime object per analysis, never re-executed.
  | {kind: 'parameter'; parameterIndex: number}

export function sameIdentity(left: AllocationIdentity, right: AllocationIdentity): boolean {
  return compareIdentity(left, right) === 0
}

// Total order so heaps and reference target sets stay sorted and joins are linear merges.
export function compareIdentity(left: AllocationIdentity, right: AllocationIdentity): number {
  if (left.kind !== right.kind) return left.kind === 'parameter' ? -1 : 1
  if (left.kind === 'parameter') {
    return left.parameterIndex - (right as Extract<AllocationIdentity, {kind: 'parameter'}>).parameterIndex
  }
  const other = right as Extract<AllocationIdentity, {kind: 'site'}>
  if (left.site !== other.site) return left.site - other.site
  const leftContext = left.context ?? -1
  const rightContext = other.context ?? -1
  if (leftContext !== rightContext) return leftContext - rightContext
  if (left.slot === other.slot) return 0
  return left.slot === 'known' ? -1 : 1
}

type AbstractObjectProperty = {
  name: string
  value: AbstractValue
}

export type AbstractObject = {
  identity: AllocationIdentity
  properties: AbstractObjectProperty[]
}

// Sorted by compareIdentity; entries are found by identity, never by position.
export type AbstractHeap = AbstractObject[]
