import {
  isFiniteNumber,
  numericInputSource,
  singleNumericInputSource,
  unknownNumber,
  type AbstractNumber,
  type NumericInputSourceSet,
} from '../domain/number.ts'
import type {AbstractValue, TaggedVariant} from '../domain/value.ts'
import type {DeclaredKind} from '../ir/program.ts'
import type {NumericInputCondition, NumericExpression} from './model.ts'

export type NumericInputSources = {
  entries: Array<{expression: NumericExpression; sources: NumericInputSourceSet}>
  idsByExpression: Map<string, number>
}

export function createNumericInputSources(): NumericInputSources {
  return {entries: [], idsByExpression: new Map()}
}

export type NumericInputNeeds = {
  nan: boolean
  infinity: boolean
}

export function seedNumericInputSources(
  value: AbstractValue,
  declared: DeclaredKind,
  expression: NumericExpression | null,
  sources: NumericInputSources,
): AbstractValue {
  switch (declared.kind) {
    case 'number': {
      if (value.kind !== 'number'
        || expression == null
        || declared.interval != null) return value
      const id = internSource(sources, expression)
      return {
        ...value,
        inputSources: {
          sources: sources.entries[id]!.sources,
          coverNaN: true,
          coverInfinity: true,
        },
      }
    }
    case 'record': {
      if (value.kind !== 'record') return value
      return {
        kind: 'record',
        properties: value.properties.map(property => {
          const field = declared.properties.find(candidate => candidate.name === property.name)
          if (field == null) return property
          return {
            name: property.name,
            value: seedNumericInputSources(
              property.value,
              field.declared,
              expression == null
                ? null
                : {kind: 'property', base: expression, name: property.name},
              sources,
            ),
          }
        }),
      }
    }
    case 'tuple': {
      if (value.kind !== 'tuple') return value
      return {
        kind: 'tuple',
        elements: value.elements.map((element, index) => {
          const position = declared.elements[index]
          return position == null
            ? element
            : seedNumericInputSources(
                element,
                position,
                expression == null
                  ? null
                  : {kind: 'tupleElement', base: expression, index},
                sources,
              )
        }),
      }
    }
    // One unconditional requirement cannot describe every array element or only the
    // present arm of a nullable or tagged-union value. Those positions keep their printed
    // assumptions instead.
    case 'array':
    case 'nullish':
    case 'taggedUnion': return stripNumericInputSources(value)
    case 'boolean':
    case 'opaque': return value
  }
}

export function numericInputCondition(
  value: AbstractNumber,
  needs: NumericInputNeeds,
): NumericInputCondition | null {
  const nan = needs.nan && value.mayBeNaN && value.inputSources?.coverNaN === true
  const infinity = needs.infinity
    && !isFiniteNumber(value)
    && value.inputSources?.coverInfinity === true
  if (!nan && !infinity) return null
  if (nan && infinity) return 'finite'
  return nan ? 'notNaN' : 'notInfinite'
}

export function applyNumericInputCondition(
  value: AbstractNumber,
  condition: NumericInputCondition,
): AbstractNumber | null {
  switch (condition) {
    case 'finite': {
      if (Number.isNaN(value.lower) || Number.isNaN(value.upper)) return null
      const lower = Math.max(value.lower, -Number.MAX_VALUE)
      const upper = Math.min(value.upper, Number.MAX_VALUE)
      return lower > upper ? null : {...value, lower, upper, mayBeNaN: false}
    }
    case 'notNaN': return Number.isNaN(value.lower) || Number.isNaN(value.upper)
      ? null
      : {...value, mayBeNaN: false}
    case 'notInfinite': {
      const lower = Math.max(value.lower, -Number.MAX_VALUE)
      const upper = Math.min(value.upper, Number.MAX_VALUE)
      if (lower <= upper) return {...value, lower, upper}
      return value.mayBeNaN
        ? withInputSources({
            kind: 'number',
            lower: -Number.MAX_VALUE,
            upper: Number.MAX_VALUE,
            integer: false,
            mayBeNaN: true,
          }, value.inputSources)
        : null
    }
  }
}

// Rounding, abs, min, and max do not turn an infinity into NaN or a NaN into infinity.
// Re-evaluating one of those operations after removing the exceptional possibilities
// attributed to its input tells us whether the same input still accounts for the result's
// exceptional values. Ordinary arithmetic and sqrt deliberately do not use this helper:
// they can change which input condition is needed, so carrying the marker would require
// richer condition tracking.
export function withoutInputExceptions(value: AbstractNumber): AbstractNumber | null {
  const markers = value.inputSources
  if (markers == null) return value
  let lower = value.lower
  let upper = value.upper
  if (markers.coverInfinity) {
    lower = Math.max(lower, -Number.MAX_VALUE)
    upper = Math.min(upper, Number.MAX_VALUE)
  }
  const mayBeNaN = markers.coverNaN ? false : value.mayBeNaN
  if (lower <= upper) return {...value, lower, upper, mayBeNaN}
  return mayBeNaN ? unknownNumber() : null
}

export function carryNumericInputSources(
  result: AbstractNumber,
  operands: AbstractNumber[],
  withoutInputExceptionsResult: AbstractNumber | null,
): AbstractNumber {
  let sourceID: number | null = null
  let sourceSet: NumericInputSourceSet | null = null
  for (const operand of operands) {
    const sources = operand.inputSources?.sources
    if (sources == null) continue
    const id = singleNumericInputSource(sources)
    if (id == null) return result
    if (sourceID == null) {
      sourceID = id
      sourceSet = sources
    } else if (sourceID !== id) return result
  }
  // More than one source can require alternative conditions or a needlessly strong
  // condition on every source. Keep carrying only when one input explains the whole
  // exceptional result.
  if (sourceID == null || sourceSet == null
    || (isFiniteNumber(result) && !result.mayBeNaN)) return result
  const coverNaN = result.mayBeNaN
    && (withoutInputExceptionsResult == null || !withoutInputExceptionsResult.mayBeNaN)
  const coverInfinity = !isFiniteNumber(result)
    && (withoutInputExceptionsResult == null || isFiniteNumber(withoutInputExceptionsResult))
  return coverNaN || coverInfinity
    ? {...result, inputSources: {sources: sourceSet, coverNaN, coverInfinity}}
    : result
}

function withInputSources(
  value: AbstractNumber,
  inputSources: AbstractNumber['inputSources'],
): AbstractNumber {
  return inputSources == null ? value : {...value, inputSources}
}

export function stripNumericInputSources(value: AbstractValue): AbstractValue {
  switch (value.kind) {
    case 'number': {
      if (value.inputSources == null) return value
      const {inputSources: _, ...plain} = value
      return plain
    }
    case 'record': return {
      kind: 'record',
      properties: value.properties.map(property => ({
        name: property.name,
        value: stripNumericInputSources(property.value),
      })),
    }
    case 'tuple': return {kind: 'tuple', elements: value.elements.map(stripNumericInputSources)}
    case 'array': return {
      ...value,
      element: value.element == null ? null : stripNumericInputSources(value.element),
    }
    case 'maybeNullish': return {...value, inner: stripNumericInputSources(value.inner)}
    case 'taggedUnion': return {...value, variants: stripVariants(value.variants)}
    case 'boolean':
    case 'void':
    case 'nullish':
    case 'opaque': return value
  }
}

function internSource(sources: NumericInputSources, expression: NumericExpression): number {
  const key = numericExpressionKey(expression)
  const existing = sources.idsByExpression.get(key)
  if (existing != null) return existing
  const id = sources.entries.length
  sources.entries.push({expression, sources: numericInputSource(id)})
  sources.idsByExpression.set(key, id)
  return id
}

export function numericExpressionKey(expression: NumericExpression): string {
  return JSON.stringify(expression, (_key, value: unknown) => {
    if (typeof value !== 'number') return value
    if (Number.isNaN(value)) return 'number:NaN'
    if (value === Infinity) return 'number:Infinity'
    if (value === -Infinity) return 'number:-Infinity'
    return `number:${String(value)}`
  })
}

function stripVariants(
  variants: [TaggedVariant, ...TaggedVariant[]],
): [TaggedVariant, ...TaggedVariant[]] {
  const [first, ...rest] = variants
  return [stripVariant(first), ...rest.map(stripVariant)]
}

function stripVariant(variant: TaggedVariant): TaggedVariant {
  const record = stripNumericInputSources(variant.record)
  if (record.kind !== 'record') throw new Error('Expected a tagged-union record')
  return {...variant, record}
}
