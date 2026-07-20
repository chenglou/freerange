import {finiteNumberPart, isFiniteNumber} from '../domain/number.ts'
import {recordProperty, tryJoinValues, type AbstractRecord, type AbstractValue} from '../domain/value.ts'

export type FiniteInputStatus = 'proven' | 'refuted' | 'uncertain' | 'unavailable'

export function finiteInputStatus(value: AbstractValue, properties: string[]): FiniteInputStatus {
  const input = valueAtPath(value, properties)
  if (input?.kind !== 'number') return 'unavailable'
  if (isFiniteNumber(input) && !input.mayBeNaN) return 'proven'
  return finiteNumberPart(input) == null ? 'refuted' : 'uncertain'
}

export function refineFiniteInput(value: AbstractValue, properties: string[]): AbstractValue | null {
  if (properties.length === 0) return value.kind === 'number' ? finiteNumberPart(value) : null
  const [property, ...rest] = properties
  if (property == null) return null
  if (value.kind === 'record') return refineRecord(value, property, rest)
  if (value.kind !== 'taggedUnion') return null
  const variants = value.variants.map(variant => {
    const record = refineRecord(variant.record, property, rest)
    return record == null ? null : {...variant, record}
  })
  if (variants.some(variant => variant == null)) return null
  return {...value, variants: variants as typeof value.variants}
}

function valueAtPath(value: AbstractValue, properties: string[]): AbstractValue | null {
  if (properties.length === 0) return value
  const [property, ...rest] = properties
  if (property == null) return null
  if (value.kind === 'record') {
    const next = recordProperty(value, property)
    return next == null ? null : valueAtPath(next, rest)
  }
  if (value.kind !== 'taggedUnion') return null
  let result: AbstractValue | null = null
  for (const variant of value.variants) {
    const next = recordProperty(variant.record, property)
    if (next == null) return null
    const leaf = valueAtPath(next, rest)
    if (leaf == null) return null
    result = result == null ? leaf : tryJoinValues(result, leaf)
    if (result == null) return null
  }
  return result
}

function refineRecord(record: AbstractRecord, property: string, rest: string[]): AbstractRecord | null {
  const current = recordProperty(record, property)
  if (current == null) return null
  const refined = refineFiniteInput(current, rest)
  if (refined == null) return null
  return {
    kind: 'record',
    properties: record.properties.map(candidate =>
      candidate.name === property ? {...candidate, value: refined} : candidate),
  }
}
