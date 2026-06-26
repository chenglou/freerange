import type {AbstractValue} from '../domain/value.ts'

type AbstractObjectProperty = {
  name: string
  value: AbstractValue
}

export type AbstractObject = {
  properties: AbstractObjectProperty[]
}

export type AbstractHeap = AbstractObject[]
