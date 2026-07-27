import type {ValueID} from '../ir/ids.ts'

export type ValueIdentityOwner = {
  kind: 'valueIdentityOwner'
  parent: ValueIdentityOwner | null
}

export type ValueIdentity =
  | {kind: 'local'; owner: ValueIdentityOwner; value: ValueID}
  | {kind: 'property'; object: ValueIdentity; property: string}
  | {kind: 'arrayIndex'; array: ValueIdentity; index: ValueIdentity}

export function createValueIdentityOwner(
  parent: ValueIdentityOwner | null = null,
): ValueIdentityOwner {
  return {kind: 'valueIdentityOwner', parent}
}

export function sameValueIdentity(left: ValueIdentity, right: ValueIdentity): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'local':
      return right.kind === 'local'
        && left.owner === right.owner
        && left.value === right.value
    case 'property':
      return right.kind === 'property'
        && left.property === right.property
        && sameValueIdentity(left.object, right.object)
    case 'arrayIndex':
      return right.kind === 'arrayIndex'
        && sameValueIdentity(left.array, right.array)
        && sameValueIdentity(left.index, right.index)
  }
}

export function valueIdentityUsesOwner(
  identity: ValueIdentity,
  owner: ValueIdentityOwner,
): boolean {
  switch (identity.kind) {
    case 'local': {
      let current: ValueIdentityOwner | null = identity.owner
      while (current != null) {
        if (current === owner) return true
        current = current.parent
      }
      return false
    }
    case 'property': return valueIdentityUsesOwner(identity.object, owner)
    case 'arrayIndex':
      return valueIdentityUsesOwner(identity.array, owner)
        || valueIdentityUsesOwner(identity.index, owner)
  }
}
