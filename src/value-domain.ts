import {linearConstant, linearVariable} from './linear.ts'
import {joinArraySummary} from './array-summary.ts'
import {mergeAssumptions} from './assumptions.ts'
import {mergeBranchArms} from './branch-context.ts'
import {
  joinNumberValues,
  linearNameForExpression,
  maxNumberCases,
  mergeOrigin,
  numberBranches,
  numberValue,
  withNumberCases,
} from './number-domain.ts'
import type {
  Assumption,
  ArraySummary,
  ArrayValue,
  BranchArm,
  CollectionValue,
  FixedTupleValue,
  LiteralPrimitive,
  LiteralValue,
  NullableValue,
  NullishKind,
  NullValue,
  NumberValue,
  ObjectValue,
  ReferenceIds,
  UnknownValue,
  Value,
} from './domain-types.ts'

let nextReference = 1

export function freshReferenceIds(): ReferenceIds {
  return [nextReference++]
}

export function mergedReferenceIds(left: ReferenceIds, right: ReferenceIds): ReferenceIds {
  const merged = [...left]
  for (const referenceId of right) {
    if (!merged.includes(referenceId)) merged.push(referenceId)
  }
  return merged
}

export function referenceIdsOverlap(left: ReferenceIds, right: ReferenceIds): boolean {
  for (const referenceId of left) if (right.includes(referenceId)) return true
  return false
}

export function literalValue(values: LiteralPrimitive[], expr: string | null, origin: string[] = []): LiteralValue | UnknownValue {
  const finiteValues = finiteLiteralSetValues(values)
  if (finiteValues.length === 0) return unknown(`Empty finite literal set: ${expr ?? '<literal>'}`)
  if (finiteValues.length > maxNumberCases) return unknown(`Finite literal set exceeded ${maxNumberCases} choices: ${expr ?? '<literal>'}`)
  return {kind: 'literal', values: finiteValues, expr, origin: [...new Set(origin)]}
}

export function finiteLiteralSetValues(values: LiteralPrimitive[]) {
  const seen = new Set<string>()
  const result: LiteralPrimitive[] = []
  for (const value of values) {
    const key = literalKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result.sort((left, right) => literalKey(left).localeCompare(literalKey(right)))
}

export function literalKey(value: LiteralPrimitive) {
  return `${typeof value}:${String(value)}`
}

export function unknownObject(name: string): ObjectValue {
  return {
    kind: 'object',
    referenceIds: freshReferenceIds(),
    props: new Map(),
    expr: name,
  }
}

// A JS array length is spec-bounded by 2^32 - 1, which keeps length
// arithmetic inside the exact-integer window even with no written given.
export const maxArrayLength = 4294967295

export function unknownArrayLength(name: string): NumberValue {
  const expr = `${name}.length`
  return numberValue(0, maxArrayLength, 0, expr, linearVariable(linearNameForExpression(expr)))
}

export function unknownArray(name: string, length: NumberValue = unknownArrayLength(name), element: Value | null = null): ArrayValue {
  return {
    kind: 'array',
    referenceIds: freshReferenceIds(),
    layout: 'collection',
    length,
    element,
    expr: name,
    summary: null,
  }
}

export function fixedTupleValue(
  elements: Value[],
  expr: string | null,
  referenceIds: ReferenceIds = freshReferenceIds(),
): FixedTupleValue {
  return {
    kind: 'array',
    referenceIds,
    layout: 'tuple',
    elements,
    expr,
  }
}

export function collectionValue(
  length: NumberValue,
  element: Value | null,
  expr: string | null,
  referenceIds: ReferenceIds = freshReferenceIds(),
  summary: ArraySummary | null = null,
): CollectionValue {
  return {
    kind: 'array',
    referenceIds,
    layout: 'collection',
    length,
    element,
    expr,
    summary,
  }
}

export function arrayLength(value: ArrayValue): NumberValue {
  if (value.layout === 'collection') return value.length
  const length = value.elements.length
  return numberValue(length, length, 0, String(length), linearConstant(length))
}

export function arrayElement(value: ArrayValue): Value | null {
  if (value.layout === 'collection') return value.element
  let element: Value | null = null
  for (const item of value.elements) element = mergeElementValue(element, item)
  return element
}

export function arrayValueAtKnownIndex(value: ArrayValue, index: number, expr: string): Value {
  if (value.layout === 'tuple') {
    return value.elements[index] ?? unknown(`${expr} was not inferred`)
  }
  if (index < 0 || index >= maxArrayLength) {
    return unknown(`Array index ${index} is not a JavaScript array index`)
  }
  if (index >= value.length.max) return nullValue('undefined')
  if (value.element == null) return unknown(`${expr} was not inferred`)
  return index < value.length.min
    ? value.element
    : nullableValue(value.element, expr, 'undefined')
}

export function tupleElements(value: ArrayValue): Value[] | null {
  return value.layout === 'tuple' ? value.elements : null
}

export function arraySummary(value: ArrayValue): ArraySummary | null {
  return value.layout === 'collection' ? value.summary : null
}

export function arrayAsCollection(value: ArrayValue): CollectionValue {
  return collectionValue(
    arrayLength(value),
    arrayElement(value),
    value.expr,
    value.referenceIds,
    arraySummary(value),
  )
}

export function nullValue(expr: string | null = 'null'): NullValue {
  return {kind: 'null', expr}
}

export function nullableValue(present: Value, expr: string | null = null, absent: NullishKind = 'null'): NullableValue | UnknownValue {
  if (present.kind === 'unknown') return present
  if (present.kind === 'null') return unknown('Nullable value had no present branch')
  if (present.kind === 'nullable') return {...present, absent: mergeNullishKind(present.absent, absent), expr: expr ?? present.expr}
  return {kind: 'nullable', present, absent, expr}
}

export function valueWithDefaultedUndefined(value: Value, fallback: Value): Value {
  if (value.kind === 'nullable' && value.absent === 'undefined') return joinValues(value.present, fallback)
  if (value.kind === 'nullable' && value.absent === 'nullish') return nullableValue(joinValues(value.present, fallback), value.expr, 'null')
  if (value.kind === 'null' && value.expr === 'undefined') return fallback
  return value
}

export function mergeNullishKind(left: NullishKind, right: NullishKind): NullishKind {
  return left === right ? left : 'nullish'
}

export function unknown(reason: string): UnknownValue {
  return {kind: 'unknown', reason}
}

export function valueWithAssumptions(
  value: Value,
  assumptions: Assumption[],
  branches: BranchArm[] = [],
): Value {
  if (assumptions.length === 0 && branches.length === 0) return value
  if (value.kind === 'number') {
    return withNumberCases(value, numberBranches(value).map(branch => ({
      value: branch.value,
      assumptions: mergeAssumptions(branch.assumptions, assumptions),
      branches: mergeBranchArms(branch.branches, branches),
    })))
  }
  if (value.kind === 'literal') return value
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, valueWithAssumptions(prop, assumptions, branches))
    return {...value, props}
  }
  if (value.kind === 'array') {
    if (value.layout === 'tuple') {
      return {
        ...value,
        elements: value.elements.map(element => valueWithAssumptions(element, assumptions, branches)),
      }
    }
    const summary = value.summary == null ? null : {
      ...value.summary,
      advances: value.summary.advances.map(fact => ({...fact, value: valueWithAssumptions(fact.value, assumptions, branches) as NumberValue})),
      lastEnd: value.summary.lastEnd == null ? null : {...value.summary.lastEnd, value: valueWithAssumptions(value.summary.lastEnd.value, assumptions, branches) as NumberValue},
      extentEnds: value.summary.extentEnds.map(fact => ({...fact, value: valueWithAssumptions(fact.value, assumptions, branches) as NumberValue})),
    }
    return {
      ...value,
      length: valueWithAssumptions(value.length, assumptions, branches) as NumberValue,
      element: value.element == null ? null : valueWithAssumptions(value.element, assumptions, branches),
      summary,
    }
  }
  if (value.kind === 'nullable') {
    return {...value, present: valueWithAssumptions(value.present, assumptions, branches)}
  }
  return value
}

export function mergeElementValue(left: Value | null, right: Value | null): Value | null {
  if (left == null) return right
  if (right == null) return left
  return joinValues(left, right)
}

export function joinValues(left: Value, right: Value): Value {
  if (left.kind === 'unknown') return left
  if (right.kind === 'unknown') return right
  if (left.kind === 'number' && right.kind === 'number') return joinNumberValues(left, right)
  if (left.kind === 'literal' && right.kind === 'literal') {
    return literalValue(
      [...left.values, ...right.values],
      left.expr != null && right.expr != null && left.expr === right.expr ? left.expr : null,
      mergeOrigin(left, right),
    )
  }
  if (left.kind === 'object' && right.kind === 'object') {
    const keys = new Set([...left.props.keys(), ...right.props.keys()])
    const props = new Map<string, Value>()
    for (const key of keys) {
      const leftProp = left.props.get(key)
      const rightProp = right.props.get(key)
      props.set(key, leftProp == null || rightProp == null ? unknown(`Property ${key} only exists on one branch`) : joinValues(leftProp, rightProp))
    }
    return {
      kind: 'object',
      referenceIds: mergedReferenceIds(left.referenceIds, right.referenceIds),
      props,
      expr: left.expr != null && left.expr === right.expr ? left.expr : null,
    }
  }
  if (left.kind === 'array' && right.kind === 'array') {
    const length = joinValues(arrayLength(left), arrayLength(right))
    if (length.kind !== 'number') return unknown('Array branches had incompatible lengths')
    const elements = left.layout === 'tuple'
      && right.layout === 'tuple'
      && left.elements.length === right.elements.length
      ? left.elements.map((leftElement, index) => joinValues(leftElement, right.elements![index]!))
      : null
    const referenceIds = mergedReferenceIds(left.referenceIds, right.referenceIds)
    const expr = left.expr != null && left.expr === right.expr ? left.expr : null
    const summary = joinArraySummary(left, right)
    return elements == null
      ? collectionValue(length, mergeElementValue(arrayElement(left), arrayElement(right)), expr, referenceIds, summary)
      : fixedTupleValue(elements, expr, referenceIds)
  }
  if (left.kind === 'null' && right.kind === 'null') return nullValue(left.expr ?? right.expr)
  if (left.kind === 'nullable' && right.kind === 'null') return {...left, absent: mergeNullishKind(left.absent, 'null')}
  if (left.kind === 'null' && right.kind === 'nullable') return {...right, absent: mergeNullishKind('null', right.absent)}
  if (left.kind === 'nullable' && right.kind === 'nullable') {
    const present = joinValues(left.present, right.present)
    return nullableValue(present, left.expr != null && left.expr === right.expr ? left.expr : null, mergeNullishKind(left.absent, right.absent))
  }
  if (left.kind === 'nullable') {
    const present = joinValues(left.present, right)
    return nullableValue(present, left.expr != null && left.expr === right.expr ? left.expr : null, left.absent)
  }
  if (right.kind === 'nullable') {
    const present = joinValues(left, right.present)
    return nullableValue(present, left.expr != null && left.expr === right.expr ? left.expr : null, right.absent)
  }
  if (left.kind === 'null') return nullableValue(right, right.expr)
  if (right.kind === 'null') return nullableValue(left, left.expr)
  return unknown('Branches returned incompatible value shapes')
}
