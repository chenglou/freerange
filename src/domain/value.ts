import {joinNumbers, sameNumbers, widenNumber, type AbstractNumber} from './number.ts'

export type AbstractBoolean = {
  kind: 'boolean'
  canBeTrue: boolean
  canBeFalse: boolean
}

export type AbstractReference = {
  kind: 'reference'
  allocation: number
}

type AbstractVoid = {
  kind: 'void'
}

export type AbstractValue = AbstractNumber | AbstractBoolean | AbstractReference | AbstractVoid

export function joinValues(left: AbstractValue, right: AbstractValue): AbstractValue {
  if (left.kind !== right.kind) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'reference': return joinReferences(left, right as AbstractReference)
    case 'void': return left
  }
}

export function sameValues(left: AbstractValue, right: AbstractValue): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'number': return sameNumbers(left, right as AbstractNumber)
    case 'boolean': {
      const other = right as AbstractBoolean
      return left.canBeTrue === other.canBeTrue && left.canBeFalse === other.canBeFalse
    }
    case 'reference': return left.allocation === (right as AbstractReference).allocation
    case 'void': return true
  }
}

export function widenValue(previous: AbstractValue, next: AbstractValue): AbstractValue {
  return previous.kind === 'number' && next.kind === 'number'
    ? widenNumber(previous, next)
    : next
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
