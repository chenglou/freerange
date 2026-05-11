import {
  type ComparisonOperator,
} from './parser.ts'
import {
  linearVariable,
  sameLinear,
  type LinearExpr,
} from './linear.ts'
import {joinArraySummary} from './array-summary.ts'
import {mergeAssumptions} from './assumptions.ts'
import {
  linearNameForExpression,
  maxNumberCases,
  mergeProvenance,
  numberBranches,
  numberValue,
  withNumberCases,
} from './number-domain.ts'

export {
  isDefinitelyEmptyArray,
  mergeArraySummary,
} from './array-summary.ts'
export {mergeAssumptions} from './assumptions.ts'
export {
  addNumbers,
  binaryExpr,
  callExpr,
  conditionalRunningSumNumber,
  divideNumbers,
  finiteNumberSet,
  finiteNumberValue,
  linearNameForExpression,
  maxNumberCases,
  mergeProvenance,
  moduloNumbers,
  multiplyNumbers,
  numberBranches,
  numberValue,
  plainNumber,
  powerNumbers,
  runningExtremumNumber,
  runningSumNumber,
  subtractNumbers,
  unknownNumber,
  withNumberCases,
} from './number-domain.ts'

export type LinearConstraint = {
  diff: LinearExpr | null
  op: ComparisonOperator
  text?: string
  leftExpr?: string
  rightExpr?: string
  source: FactSource
  rangeFact?: true
  integerStrict?: true
}

export type FactSource = 'function-given' | 'loop-given' | 'code' | 'branch' | 'contract'

export type Value = NumberValue | LiteralValue | ObjectValue | ArrayValue | NullValue | NullableValue | UnknownValue

export type NullishKind = 'null' | 'undefined' | 'nullish'
export type LiteralPrimitive = string | boolean

export type NumberValue = {
  kind: 'number'
  min: number
  max: number
  isInteger: boolean
  expr: string | null
  linear: LinearExpr | null
  cases: NumberCase[] | null
  provenance: string[]
}

export type LiteralValue = {
  kind: 'literal'
  values: LiteralPrimitive[]
  expr: string | null
  provenance: string[]
}

export type ObjectValue = {
  kind: 'object'
  props: Map<string, Value>
  expr: string | null
}

export type ArrayLayout = 'collection' | 'tuple'

export type ArrayValue = {
  kind: 'array'
  layout: ArrayLayout
  length: NumberValue
  elements: Value[] | null
  element: Value | null
  expr: string | null
  summary: ArraySummary | null
}

export type NullValue = {
  kind: 'null'
  expr: string | null
}

export type NullableValue = {
  kind: 'nullable'
  present: Value
  absent: NullishKind
  expr: string | null
}

export type ArraySummary = {
  origin?: ArrayOrigin | null
  relations: SequenceRelation[]
  nondecreasingProps: string[]
  advances: {prop: string; value: NumberValue}[]
  spaced: {gapExpr: string; heightExpr: string; advanceExpr: string}[]
  lastEnd: NumberValue | null
  extentEnds: {emptyExpr: string; nonEmptyExpr: string; value: NumberValue}[]
}

export type ArrayOrigin =
  | {kind: 'identity'; sourceExpr: string}
  | {kind: 'subsequence'; sourceExpr: string}

export type SequenceRelation = {
  kind: 'adjacent-comparison'
  left: SequenceTerm
  op: ComparisonOperator
  right: SequenceExpression
}

export type SequenceTerm = {
  item: 'previous' | 'next'
  path: string[]
}

export type SequenceExpression = {
  terms: SequenceTerm[]
  addends: string[]
}

export type UnknownValue = {
  kind: 'unknown'
  reason: string
}

export type NumberCase = {
  value: NumberValue
  assumptions: LinearConstraint[]
}

export function literalValue(values: LiteralPrimitive[], expr: string | null, provenance: string[] = []): LiteralValue | UnknownValue {
  const finiteValues = finiteLiteralSetValues(values)
  if (finiteValues.length === 0) return unknown(`Empty finite literal set: ${expr ?? '<literal>'}`)
  if (finiteValues.length > maxNumberCases) return unknown(`Finite literal set exceeded ${maxNumberCases} choices: ${expr ?? '<literal>'}`)
  return {kind: 'literal', values: finiteValues, expr, provenance: [...new Set(provenance)]}
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
    props: new Map(),
    expr: name,
  }
}

export function unknownArrayLength(name: string): NumberValue {
  const expr = `${name}.length`
  return numberValue(0, Number.POSITIVE_INFINITY, true, expr, linearVariable(linearNameForExpression(expr)))
}

export function unknownArray(name: string, length: NumberValue = unknownArrayLength(name), element: Value | null = null): ArrayValue {
  return {
    kind: 'array',
    layout: 'collection',
    length,
    elements: null,
    element,
    expr: name,
    summary: null,
  }
}

export function tupleArray(
  expr: string | null,
  length: NumberValue,
  elements: Value[] | null,
  element: Value | null,
  summary: ArraySummary | null = null,
): ArrayValue {
  return {
    kind: 'array',
    layout: 'tuple',
    length,
    elements,
    element,
    expr,
    summary,
  }
}

export function tupleElements(value: ArrayValue): Value[] | null {
  return value.layout === 'tuple' ? value.elements : null
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

export function valueWithAssumptions(value: Value, assumptions: LinearConstraint[]): Value {
  if (assumptions.length === 0) return value
  if (value.kind === 'number') {
    return withNumberCases(value, numberBranches(value).map(branch => ({
      value: branch.value,
      assumptions: mergeAssumptions(branch.assumptions, assumptions),
    })))
  }
  if (value.kind === 'literal') return value
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, valueWithAssumptions(prop, assumptions))
    return {...value, props}
  }
  if (value.kind === 'array') {
    return {
      ...value,
      length: valueWithAssumptions(value.length, assumptions) as NumberValue,
      elements: value.elements == null ? null : value.elements.map(element => valueWithAssumptions(element, assumptions)),
      element: value.element == null ? null : valueWithAssumptions(value.element, assumptions),
      summary: value.summary == null ? null : {
        ...value.summary,
        advances: value.summary.advances.map(fact => ({...fact, value: valueWithAssumptions(fact.value, assumptions) as NumberValue})),
        lastEnd: value.summary.lastEnd == null ? null : valueWithAssumptions(value.summary.lastEnd, assumptions) as NumberValue,
        extentEnds: value.summary.extentEnds.map(fact => ({...fact, value: valueWithAssumptions(fact.value, assumptions) as NumberValue})),
      },
    }
  }
  if (value.kind === 'nullable') {
    return {...value, present: valueWithAssumptions(value.present, assumptions)}
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
  if (left.kind === 'number' && right.kind === 'number') {
    const joined = numberValue(
      Math.min(left.min, right.min),
      Math.max(left.max, right.max),
      left.isInteger && right.isInteger,
      left.expr != null && right.expr != null && left.expr === right.expr ? left.expr : null,
      left.linear != null && right.linear != null && sameLinear(left.linear, right.linear) ? left.linear : null,
      null,
      mergeProvenance(left, right),
    )
    if (!shouldKeepJoinedNumberCases(left, right, joined)) return joined
    return withNumberCases(joined, [...numberBranches(left), ...numberBranches(right)])
  }
  if (left.kind === 'literal' && right.kind === 'literal') {
    return literalValue(
      [...left.values, ...right.values],
      left.expr != null && right.expr != null && left.expr === right.expr ? left.expr : null,
      mergeProvenance(left, right),
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
    return {kind: 'object', props, expr: left.expr != null && left.expr === right.expr ? left.expr : null}
  }
  if (left.kind === 'array' && right.kind === 'array') {
    const length = joinValues(left.length, right.length)
    if (length.kind !== 'number') return unknown('Array branches had incompatible lengths')
    const elements = left.layout === 'tuple'
      && right.layout === 'tuple'
      && left.elements != null
      && right.elements != null
      && left.elements.length === right.elements.length
      ? left.elements.map((leftElement, index) => joinValues(leftElement, right.elements![index]!))
      : null
    return {
      kind: 'array',
      layout: elements == null ? 'collection' : 'tuple',
      length,
      elements,
      element: mergeElementValue(left.element, right.element),
      expr: left.expr != null && left.expr === right.expr ? left.expr : null,
      summary: joinArraySummary(left, right),
    }
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

function shouldKeepJoinedNumberCases(left: NumberValue, right: NumberValue, joined: NumberValue) {
  if (left.cases != null || right.cases != null) return true
  const sameRange = left.min === right.min && left.max === right.max && left.isInteger === right.isInteger
  const sameExpr = (left.expr ?? null) === (right.expr ?? null)
  const sameLinearity = (left.linear == null && right.linear == null)
    || (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear))
  if (sameRange && sameExpr && sameLinearity) return false
  return isUsefulNumberCase(left) && isUsefulNumberCase(right) && isUsefulNumberCase(joined)
}

function isUsefulNumberCase(value: NumberValue) {
  return value.expr != null
    || value.linear != null
    || value.min !== Number.NEGATIVE_INFINITY
    || value.max !== Number.POSITIVE_INFINITY
}
