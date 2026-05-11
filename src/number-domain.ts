import {
  domainPathSyntheticName,
  parseDomainPathText,
} from './parser.ts'
import {
  cleanLinear,
  linearAdd,
  linearConstant,
  linearScale,
  linearSubtract,
  linearVariable,
  type LinearExpr,
} from './linear.ts'
import type {
  LiteralValue,
  NumberCase,
  NumberValue,
  UnknownValue,
  Value,
} from './domain.ts'

export const maxNumberCases = 8

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
  if (right.min <= 0 && right.max >= 0) return unknownValue('Division by a range containing zero is unsupported')
  const quotients = nonNanExtrema([
    left.min / right.min,
    left.min / right.max,
    left.max / right.min,
    left.max / right.max,
  ])
  return numberValue(quotients.min, quotients.max, false, binaryExpr(left, '/', right), right.min === right.max ? linearScale(left.linear, 1 / right.min) : null, null, mergeProvenance(left, right))
}

export function moduloNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 || left.min < 0) return unknownValue('Modulo is only supported for non-negative values and positive divisors')
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
  if (right.min !== right.max) return unknownValue('Non-constant exponent is unsupported')
  if (right.min === 2 && left.min >= 0) return numberValue(left.min ** 2, left.max ** 2, left.isInteger, binaryExpr(left, '**', right), null, null, mergeProvenance(left, right))
  if (left.min === left.max) return numberValue(left.min ** right.min, left.min ** right.min, Number.isInteger(left.min ** right.min), binaryExpr(left, '**', right), null, null, mergeProvenance(left, right))
  return unknownValue('Only square of non-negative ranges is supported')
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

function unknownValue(reason: string): UnknownValue {
  return {kind: 'unknown', reason}
}
