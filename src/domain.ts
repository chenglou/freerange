import {
  domainPathSyntheticName,
  parseDomainPathText,
  type ComparisonOperator,
} from './parser.ts'
import {
  cleanLinear,
  linearAdd,
  linearScale,
  linearVariable,
  sameExpressionText,
  sameLinear,
  type LinearExpr,
} from './linear.ts'

export const maxNumberCases = 8

export type LinearConstraint = {
  diff: LinearExpr | null
  op: ComparisonOperator
  text?: string
  leftExpr?: string
  rightExpr?: string
  source: FactSource
  rangeFact?: true
}

export type FactSource = 'function-given' | 'loop-given' | 'code'

export type Value = NumberValue | ObjectValue | ArrayValue | UnknownValue

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

export type ObjectValue = {
  kind: 'object'
  props: Map<string, Value>
  expr: string | null
}

export type ArrayValue = {
  kind: 'array'
  length: NumberValue
  elements: Value[] | null
  element: Value | null
  expr: string | null
  summary: ArraySummary | null
}

export type ArraySummary = {
  nondecreasingProps: string[]
  advances: {prop: string; value: NumberValue}[]
  spaced: {gapExpr: string; heightExpr: string; advanceExpr: string}[]
  lastEnd: NumberValue | null
  extentEnds: {emptyExpr: string; nonEmptyExpr: string; value: NumberValue}[]
}

export type UnknownValue = {
  kind: 'unknown'
  reason: string
}

export type NumberCase = {
  value: NumberValue
  assumptions: LinearConstraint[]
}

export function linearNameForExpression(text: string) {
  const domainPath = parseDomainPathText(text)
  return domainPath?.segments.some(segment => segment.kind === 'item') === true ? domainPathSyntheticName(text) : text
}

export function numberValue(
  min: number,
  max: number,
  isInteger: boolean,
  expr: string | null,
  linear: LinearExpr | null = null,
  cases: NumberCase[] | null = null,
  provenance: string[] = [],
): NumberValue {
  const clean = linear == null ? null : cleanLinear(linear)
  const cleanProvenance = [...new Set(provenance)]
  if (clean != null && clean.terms.size === 0 && Number.isFinite(clean.constant)) {
    return {kind: 'number', min: clean.constant, max: clean.constant, isInteger: Number.isInteger(clean.constant), expr, linear: clean, cases, provenance: cleanProvenance}
  }
  return {kind: 'number', min, max, isInteger, expr, linear: clean, cases, provenance: cleanProvenance}
}

export function unknownNumber(name: string): NumberValue {
  return {
    kind: 'number',
    min: Number.NEGATIVE_INFINITY,
    max: Number.POSITIVE_INFINITY,
    isInteger: false,
    expr: name,
    linear: linearVariable(linearNameForExpression(name)),
    cases: null,
    provenance: [],
  }
}

export function mergeProvenance(...items: (NumberValue | string[])[]) {
  const lines: string[] = []
  for (const item of items) {
    lines.push(...(Array.isArray(item) ? item : item.provenance))
  }
  return [...new Set(lines)]
}

export function unknownObject(name: string): ObjectValue {
  return {
    kind: 'object',
    props: new Map(),
    expr: name,
  }
}

export function unknownArray(name: string, length: NumberValue = unknownNumber(`${name}.length`), element: Value | null = null): ArrayValue {
  return {
    kind: 'array',
    length,
    elements: null,
    element,
    expr: name,
    summary: null,
  }
}

export function unknown(reason: string): UnknownValue {
  return {kind: 'unknown', reason}
}

export function plainNumber(value: NumberValue): NumberValue {
  return value.cases == null ? value : {...value, cases: null}
}

export function numberBranches(value: NumberValue): NumberCase[] {
  return value.cases ?? [{value: plainNumber(value), assumptions: []}]
}

export function withNumberCases(value: NumberValue, cases: NumberCase[] | null): NumberValue {
  if (cases == null || cases.length === 0 || cases.length > maxNumberCases) return value
  return {...value, cases: cases.map(choice => ({value: plainNumber(choice.value), assumptions: choice.assumptions}))}
}

export function valueWithAssumptions(value: Value, assumptions: LinearConstraint[]): Value {
  if (assumptions.length === 0) return value
  if (value.kind === 'number') {
    return withNumberCases(value, numberBranches(value).map(branch => ({
      value: branch.value,
      assumptions: mergeAssumptions(branch.assumptions, assumptions),
    })))
  }
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
  return value
}

export function mergeAssumptions(...groups: LinearConstraint[][]): LinearConstraint[] {
  return groups.flat()
}

export function mergeArraySummary(left: ArraySummary | null, right: ArraySummary | null): ArraySummary | null {
  if (left == null) return right
  if (right == null) return left
  return {
    nondecreasingProps: [...new Set([...left.nondecreasingProps, ...right.nondecreasingProps])],
    advances: [...left.advances, ...right.advances].filter((fact, index, facts) => facts.findIndex(other => sameAdvanceFact(other, fact)) === index),
    spaced: [...left.spaced, ...right.spaced].filter((fact, index, facts) => facts.findIndex(other => sameSpacedFact(other, fact)) === index),
    lastEnd: right.lastEnd ?? left.lastEnd,
    extentEnds: [...left.extentEnds, ...right.extentEnds].filter((fact, index, facts) => facts.findIndex(other => sameExtentEndFact(other, fact)) === index),
  }
}

export function mergeElementValue(left: Value | null, right: Value | null): Value | null {
  if (left == null) return right
  if (right == null) return left
  return joinValues(left, right)
}

function sameArraySummary(left: ArraySummary | null, right: ArraySummary | null) {
  if (left === right) return true
  if (left == null || right == null) return false
  if ((left.lastEnd?.expr ?? null) !== (right.lastEnd?.expr ?? null)) return false
  if (left.nondecreasingProps.join('|') !== right.nondecreasingProps.join('|')) return false
  if (left.advances.length !== right.advances.length) return false
  if (!left.advances.every((fact, index) => sameAdvanceFact(fact, right.advances[index]!))) return false
  if (left.spaced.length !== right.spaced.length) return false
  if (!left.spaced.every((fact, index) => sameSpacedFact(fact, right.spaced[index]!))) return false
  if (left.extentEnds.length !== right.extentEnds.length) return false
  return left.extentEnds.every((fact, index) => sameExtentEndFact(fact, right.extentEnds[index]!))
}

function sameAdvanceFact(left: ArraySummary['advances'][number], right: ArraySummary['advances'][number]) {
  return left.prop === right.prop && (left.value.expr ?? null) === (right.value.expr ?? null)
}

function sameSpacedFact(left: ArraySummary['spaced'][number], right: ArraySummary['spaced'][number]) {
  return sameExpressionText(left.gapExpr, right.gapExpr)
    && sameExpressionText(left.heightExpr, right.heightExpr)
    && sameExpressionText(left.advanceExpr, right.advanceExpr)
}

function sameExtentEndFact(left: ArraySummary['extentEnds'][number], right: ArraySummary['extentEnds'][number]) {
  return sameExpressionText(left.emptyExpr, right.emptyExpr)
    && sameExpressionText(left.nonEmptyExpr, right.nonEmptyExpr)
    && (left.value.expr ?? null) === (right.value.expr ?? null)
}

function linearMultiply(left: NumberValue, right: NumberValue): LinearExpr | null {
  if (left.min === left.max) return linearScale(right.linear, left.min)
  if (right.min === right.max) return linearScale(left.linear, right.min)
  return null
}

export function multiplyNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const products = [
    left.min * right.min,
    left.min * right.max,
    left.max * right.min,
    left.max * right.max,
  ]
  return numberValue(Math.min(...products), Math.max(...products), left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeProvenance(left, right))
}

export function divideNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 && right.max >= 0) return unknown('Division by a range containing zero is unsupported')
  const quotients = [
    left.min / right.min,
    left.min / right.max,
    left.max / right.min,
    left.max / right.max,
  ]
  return numberValue(Math.min(...quotients), Math.max(...quotients), false, binaryExpr(left, '/', right), right.min === right.max ? linearScale(left.linear, 1 / right.min) : null, null, mergeProvenance(left, right))
}

export function moduloNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 || left.min < 0) return unknown('Modulo is only supported for non-negative values and positive divisors')
  const max = left.isInteger && right.isInteger ? Math.max(0, Math.ceil(right.max) - 1) : right.max
  return numberValue(0, max, left.isInteger && right.isInteger, binaryExpr(left, '%', right), null, null, mergeProvenance(left, right))
}

export function runningSumNumber(start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const exactIncrement = increment.min === increment.max ? increment.min : null
  const linear = exactIncrement == null || start.linear == null || count.linear == null
    ? null
    : linearAdd(start.linear, linearScale(count.linear, exactIncrement))
  if (count.min < 0 || increment.min < 0) return numberValue(
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    false,
    start.expr != null && count.expr != null && increment.expr != null ? `runningSum(${start.expr}, ${count.expr}, ${increment.expr})` : null,
    linear,
    null,
    mergeProvenance(start, count, increment),
  )
  const deltas = [
    count.min * increment.min,
    count.min * increment.max,
    count.max * increment.min,
    count.max * increment.max,
  ]
  return numberValue(
    start.min + Math.min(...deltas),
    start.max + Math.max(...deltas),
    start.isInteger && count.isInteger && increment.isInteger,
    start.expr != null && count.expr != null && increment.expr != null ? `runningSum(${start.expr}, ${count.expr}, ${increment.expr})` : null,
    linear,
    null,
    mergeProvenance(start, count, increment),
  )
}

export function conditionalRunningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const deltas = [
    0,
    count.max * increment.min,
    count.max * increment.max,
  ]
  return numberValue(
    start.min + Math.min(...deltas),
    start.max + Math.max(...deltas),
    start.isInteger && count.isInteger && increment.isInteger,
    targetName,
    linearVariable(targetName),
    null,
    mergeProvenance(start, count, increment),
  )
}

export function powerNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min !== right.max) return unknown('Non-constant exponent is unsupported')
  if (right.min === 2 && left.min >= 0) return numberValue(left.min ** 2, left.max ** 2, left.isInteger, binaryExpr(left, '**', right), null, null, mergeProvenance(left, right))
  if (left.min === left.max) return numberValue(left.min ** right.min, left.min ** right.min, Number.isInteger(left.min ** right.min), binaryExpr(left, '**', right), null, null, mergeProvenance(left, right))
  return unknown('Only square of non-negative ranges is supported')
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
    if (left.cases == null && right.cases == null) return joined
    return withNumberCases(joined, [...numberBranches(left), ...numberBranches(right)])
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
    return {
      kind: 'array',
      length,
      elements: left.elements != null && right.elements != null && left.elements.length === right.elements.length
        ? left.elements.map((leftElement, index) => joinValues(leftElement, right.elements![index]!))
        : null,
      element: mergeElementValue(left.element, right.element),
      expr: left.expr != null && left.expr === right.expr ? left.expr : null,
      summary: sameArraySummary(left.summary, right.summary) ? left.summary : null,
    }
  }
  return unknown('Branches returned incompatible value shapes')
}

export function binaryExpr(left: NumberValue, op: string, right: NumberValue) {
  if (left.expr == null || right.expr == null) return null
  return `(${left.expr} ${op} ${right.expr})`
}

export function callExpr(name: string, values: NumberValue[]) {
  const parts: string[] = []
  for (const value of values) {
    if (value.expr == null) return null
    parts.push(value.expr)
  }
  return `${name}(${parts.join(', ')})`
}
