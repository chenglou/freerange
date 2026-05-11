import {
  domainPathSyntheticName,
  parseDomainPathText,
  type ComparisonOperator,
} from './parser.ts'
import {
  cleanLinear,
  expressionKeyFromText,
  linearAdd,
  linearConstant,
  linearKey,
  linearScale,
  linearSubtract,
  linearVariable,
  sameLinear,
  type LinearExpr,
} from './linear.ts'
import {joinArraySummary} from './array-summary.ts'

export {
  isDefinitelyEmptyArray,
  mergeArraySummary,
} from './array-summary.ts'

export const maxNumberCases = 8

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
  const cleanMin = Number.isNaN(min) ? Number.NEGATIVE_INFINITY : min
  const cleanMax = Number.isNaN(max) ? Number.POSITIVE_INFINITY : max
  if (clean != null && clean.terms.size === 0 && Number.isFinite(clean.constant)) {
    return {kind: 'number', min: clean.constant, max: clean.constant, isInteger: Number.isInteger(clean.constant), expr, linear: clean, cases, provenance: cleanProvenance}
  }
  if (cleanMin > cleanMax) {
    return {kind: 'number', min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY, isInteger: false, expr, linear: clean, cases, provenance: cleanProvenance}
  }
  return {kind: 'number', min: cleanMin, max: cleanMax, isInteger, expr, linear: clean, cases, provenance: cleanProvenance}
}

export function finiteNumberValue(
  values: number[],
  expr: string | null,
  linear: LinearExpr | null = expr == null ? null : linearVariable(linearNameForExpression(expr)),
  provenance: string[] = [],
): NumberValue {
  const finiteValues = finiteNumberSetValues(values)
  if (finiteValues.length === 0) return unknownNumber(expr ?? '<empty finite set>')
  const min = finiteValues[0]!
  const max = finiteValues[finiteValues.length - 1]!
  const isInteger = finiteValues.every(Number.isInteger)
  const value = numberValue(min, max, isInteger, expr, linear, null, provenance)
  return withNumberCases(value, finiteValues.map(choice => ({
    value: numberValue(choice, choice, Number.isInteger(choice), String(choice), linearConstant(choice), null, provenance),
    assumptions: [],
  })))
}

export function finiteNumberSet(value: NumberValue): number[] | null {
  const branches = value.cases == null ? [plainNumber(value)] : value.cases.map(branch => branch.value)
  const values: number[] = []
  for (const branch of branches) {
    if (branch.min !== branch.max || !Number.isFinite(branch.min)) return null
    values.push(branch.min)
  }
  return finiteNumberSetValues(values)
}

function finiteNumberSetValues(values: number[]) {
  return [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right)
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

export function mergeProvenance(...items: (NumberValue | LiteralValue | string[])[]) {
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

export function mergeAssumptions(...groups: LinearConstraint[][]): LinearConstraint[] {
  const seen = new Set<string>()
  const assumptions: LinearConstraint[] = []
  for (const assumption of groups.flat()) {
    const key = assumptionKey(assumption)
    if (seen.has(key)) continue
    seen.add(key)
    assumptions.push(assumption)
  }
  return assumptions
}

function assumptionKey(assumption: LinearConstraint) {
  const hasExpressionPair = assumption.leftExpr != null && assumption.rightExpr != null
  return [
    assumption.op,
    assumption.source,
    assumption.text ?? '',
    hasExpressionPair || assumption.diff == null ? '' : linearKey(assumption.diff),
    expressionKeyOrEmpty(assumption.leftExpr),
    expressionKeyOrEmpty(assumption.rightExpr),
    assumption.rangeFact === true ? 'range' : '',
    assumption.integerStrict === true ? 'integer-strict' : '',
  ].join('\0')
}

function expressionKeyOrEmpty(expression: string | undefined) {
  return expression == null ? '' : expressionKeyFromText(expression)
}

export function mergeElementValue(left: Value | null, right: Value | null): Value | null {
  if (left == null) return right
  if (right == null) return left
  return joinValues(left, right)
}

function linearMultiply(left: NumberValue, right: NumberValue): LinearExpr | null {
  if (left.min === left.max) return linearScale(right.linear, left.min)
  if (right.min === right.max) return linearScale(left.linear, right.min)
  return null
}

function nonNanExtrema(values: number[], fallbackMin = Number.NEGATIVE_INFINITY, fallbackMax = Number.POSITIVE_INFINITY) {
  const cleanValues = values.filter(value => !Number.isNaN(value))
  if (cleanValues.length === 0) return {min: fallbackMin, max: fallbackMax}
  return {min: Math.min(...cleanValues), max: Math.max(...cleanValues)}
}

export function addNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const min = left.min + right.min
  const max = left.max + right.max
  return numberValue(
    Number.isNaN(min) ? Number.NEGATIVE_INFINITY : min,
    Number.isNaN(max) ? Number.POSITIVE_INFINITY : max,
    left.isInteger && right.isInteger,
    binaryExpr(left, '+', right),
    linearAdd(left.linear, right.linear),
    null,
    mergeProvenance(left, right),
  )
}

export function subtractNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const min = left.min - right.max
  const max = left.max - right.min
  return numberValue(
    Number.isNaN(min) ? Number.NEGATIVE_INFINITY : min,
    Number.isNaN(max) ? Number.POSITIVE_INFINITY : max,
    left.isInteger && right.isInteger,
    binaryExpr(left, '-', right),
    linearSubtract(left.linear, right.linear),
    null,
    mergeProvenance(left, right),
  )
}

export function multiplyNumbers(left: NumberValue, right: NumberValue): NumberValue {
  if (left.min === 0 && left.max === 0) {
    return numberValue(0, 0, left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeProvenance(left, right))
  }
  if (right.min === 0 && right.max === 0) {
    return numberValue(0, 0, left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeProvenance(left, right))
  }
  const products = nonNanExtrema([
    left.min * right.min,
    left.min * right.max,
    left.max * right.min,
    left.max * right.max,
  ])
  return numberValue(products.min, products.max, left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeProvenance(left, right))
}

export function divideNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 && right.max >= 0) return unknown('Division by a range containing zero is unsupported')
  const quotients = nonNanExtrema([
    left.min / right.min,
    left.min / right.max,
    left.max / right.min,
    left.max / right.max,
  ])
  return numberValue(quotients.min, quotients.max, false, binaryExpr(left, '/', right), right.min === right.max ? linearScale(left.linear, 1 / right.min) : null, null, mergeProvenance(left, right))
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
  const delta = multiplyNumbers(count, increment)
  const result = addNumbers(start, delta)
  return numberValue(
    result.min,
    result.max,
    start.isInteger && count.isInteger && increment.isInteger,
    start.expr != null && count.expr != null && increment.expr != null ? `runningSum(${start.expr}, ${count.expr}, ${increment.expr})` : null,
    linear,
    null,
    mergeProvenance(start, count, increment),
  )
}

export function conditionalRunningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const deltaBounds = nonNanExtrema([
    0,
    count.max * increment.min,
    count.max * increment.max,
  ])
  const delta = numberValue(deltaBounds.min, deltaBounds.max, count.isInteger && increment.isInteger, null, null, null, mergeProvenance(count, increment))
  const result = addNumbers(start, delta)
  return numberValue(
    result.min,
    result.max,
    start.isInteger && count.isInteger && increment.isInteger,
    targetName,
    linearVariable(targetName),
    null,
    mergeProvenance(start, count, increment),
  )
}

export function runningExtremumNumber(kind: 'min' | 'max', targetName: string, start: NumberValue, count: NumberValue, candidate: NumberValue): NumberValue {
  if (count.max <= 0) {
    return numberValue(start.min, start.max, start.isInteger, targetName, linearVariable(linearNameForExpression(targetName)), null, start.provenance)
  }

  const hasItem = count.min >= 1
  const min = kind === 'max'
    ? hasItem ? Math.max(start.min, candidate.min) : start.min
    : Math.min(start.min, candidate.min)
  const max = kind === 'max'
    ? Math.max(start.max, candidate.max)
    : hasItem ? Math.min(start.max, candidate.max) : start.max

  return numberValue(
    min,
    max,
    start.isInteger && candidate.isInteger,
    targetName,
    linearVariable(linearNameForExpression(targetName)),
    null,
    mergeProvenance(start, count, candidate),
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
