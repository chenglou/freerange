import {rationalIsExactNumber, rationalToNumber} from './rational.ts'
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
  sameLinear,
  type LinearExpr,
} from './linear.ts'
import type {
  LiteralValue,
  NumberCase,
  NumberValue,
  UnknownValue,
  Value,
} from './domain-types.ts'

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
  origin: string[] = [],
): NumberValue {
  const clean = linear == null ? null : cleanLinear(linear)
  const cleanOrigin = [...new Set(origin)]
  const cleanMin = Number.isNaN(min) ? Number.NEGATIVE_INFINITY : min
  const cleanMax = Number.isNaN(max) ? Number.POSITIVE_INFINITY : max
  if (clean != null && clean.terms.size === 0 && rationalIsExactNumber(clean.constant)) {
    const exact = rationalToNumber(clean.constant)
    return {kind: 'number', min: exact, max: exact, isInteger: Number.isInteger(exact), expr, linear: clean, cases, origin: cleanOrigin}
  }
  if (cleanMin > cleanMax) {
    return {kind: 'number', min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY, isInteger: false, expr, linear: clean, cases, origin: cleanOrigin}
  }
  return {kind: 'number', min: cleanMin, max: cleanMax, isInteger, expr, linear: clean, cases, origin: cleanOrigin}
}

export function finiteNumberValue(
  values: number[],
  expr: string | null,
  linear: LinearExpr | null = expr == null ? null : linearVariable(linearNameForExpression(expr)),
  origin: string[] = [],
): NumberValue {
  const finiteValues = finiteNumberSetValues(values)
  if (finiteValues.length === 0) return unknownNumber(expr ?? '<empty finite set>')
  const min = finiteValues[0]!
  const max = finiteValues[finiteValues.length - 1]!
  const isInteger = finiteValues.every(Number.isInteger)
  const value = numberValue(min, max, isInteger, expr, linear, null, origin)
  return withNumberCases(value, finiteValues.map(choice => ({
    value: numberValue(choice, choice, Number.isInteger(choice), String(choice), linearConstant(choice), null, origin),
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
    origin: [],
  }
}

export function mergeOrigin(...items: (NumberValue | LiteralValue | string[])[]) {
  const lines: string[] = []
  for (const item of items) {
    lines.push(...(Array.isArray(item) ? item : item.origin))
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
  if (cases == null || cases.length === 0) return value
  const plainCases = cases.map(choice => ({value: plainNumber(choice.value), assumptions: choice.assumptions}))
  const normalized = normalizeNumberCases(plainCases)
  if (normalized.length === 1 && sameNumberShape(value, normalized[0]!.value) && normalized[0]!.assumptions.length === 0) return value
  if (normalized.length > maxNumberCases) return value
  return {...value, cases: normalized}
}

function normalizeNumberCases(cases: NumberCase[]): NumberCase[] {
  if (cases.some(choice => choice.assumptions.length > 0)) return cases
  const sorted = [...cases].sort((left, right) => left.value.min - right.value.min || left.value.max - right.value.max)
  const result: NumberCase[] = []
  for (const item of sorted) {
    const previous = result.at(-1)
    if (previous == null || !numberCasesCanMerge(previous.value, item.value)) {
      result.push(item)
      continue
    }
    result[result.length - 1] = {value: mergeNumberCaseValues(previous.value, item.value), assumptions: []}
  }
  return result
}

function numberCasesCanMerge(left: NumberValue, right: NumberValue) {
  if (numberValueContains(left, right) || numberValueContains(right, left)) return true
  if (left.isInteger !== right.isInteger) return false
  return left.isInteger ? left.max + 1 >= right.min : left.max >= right.min
}

function numberValueContains(container: NumberValue, item: NumberValue) {
  if (container.min > item.min || container.max < item.max) return false
  return !container.isInteger || item.isInteger
}

function mergeNumberCaseValues(left: NumberValue, right: NumberValue): NumberValue {
  if (numberValueContains(left, right)) return left
  if (numberValueContains(right, left)) return right
  const expr = left.expr != null && left.expr === right.expr ? left.expr : null
  const linear = left.linear != null && right.linear != null && sameLinear(left.linear, right.linear) ? left.linear : null
  return numberValue(
    Math.min(left.min, right.min),
    Math.max(left.max, right.max),
    left.isInteger && right.isInteger,
    expr,
    linear,
    null,
    mergeOrigin(left, right),
  )
}

function sameNumberShape(left: NumberValue, right: NumberValue) {
  return left.min === right.min
    && left.max === right.max
    && left.isInteger === right.isInteger
    && (left.expr ?? null) === (right.expr ?? null)
    && ((left.linear == null && right.linear == null) || (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear)))
}

function linearMultiply(left: NumberValue, right: NumberValue): LinearExpr | null {
  if (left.min === left.max) return linearScale(right.linear, left.min)
  if (right.min === right.max) return linearScale(left.linear, right.min)
  return null
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
    mergeOrigin(left, right),
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
    mergeOrigin(left, right),
  )
}

export function multiplyNumbers(left: NumberValue, right: NumberValue): NumberValue {
  if (left.min === 0 && left.max === 0) {
    return numberValue(0, 0, left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeOrigin(left, right))
  }
  if (right.min === 0 && right.max === 0) {
    return numberValue(0, 0, left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeOrigin(left, right))
  }
  const products = nonNanExtrema([
    left.min * right.min,
    left.min * right.max,
    left.max * right.min,
    left.max * right.max,
  ])
  return numberValue(products.min, products.max, left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeOrigin(left, right))
}

export function divideNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 && right.max >= 0) return unknownValue('Division by a range containing zero is unsupported')
  const quotients = nonNanExtrema([
    left.min / right.min,
    left.min / right.max,
    left.max / right.min,
    left.max / right.max,
  ])
  return numberValue(quotients.min, quotients.max, false, binaryExpr(left, '/', right), right.min === right.max ? linearScale(left.linear, 1 / right.min) : null, null, mergeOrigin(left, right))
}

export function moduloNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 || left.min < 0) return unknownValue('Modulo is only supported for non-negative values and positive divisors')
  const max = left.isInteger && right.isInteger ? Math.max(0, Math.ceil(right.max) - 1) : right.max
  const expr = binaryExpr(left, '%', right)
  const linear = expr == null ? null : linearVariable(linearNameForExpression(expr))
  return numberValue(0, max, left.isInteger && right.isInteger, expr, linear, null, mergeOrigin(left, right))
}

export function negateNumber(value: NumberValue, expr: string | null): NumberValue {
  const plain = numberValue(-value.max, -value.min, value.isInteger, expr, null, null, value.origin)
  if (value.cases == null) return plain
  return withNumberCases(plain, value.cases.map(branch => ({
    value: numberValue(
      -branch.value.max,
      -branch.value.min,
      branch.value.isInteger,
      expr,
      null,
      null,
      branch.value.origin,
    ),
    assumptions: branch.assumptions,
  })))
}

export function nonNanExtrema(values: number[], fallbackMin = Number.NEGATIVE_INFINITY, fallbackMax = Number.POSITIVE_INFINITY) {
  const cleanValues = values.filter(value => !Number.isNaN(value))
  if (cleanValues.length === 0) return {min: fallbackMin, max: fallbackMax}
  return {min: Math.min(...cleanValues), max: Math.max(...cleanValues)}
}

export function powerNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min !== right.max) return unknownValue('Non-constant exponent is unsupported')
  if (right.min === 2 && left.min >= 0) return numberValue(left.min ** 2, left.max ** 2, left.isInteger, binaryExpr(left, '**', right), null, null, mergeOrigin(left, right))
  if (left.min === left.max) return numberValue(left.min ** right.min, left.min ** right.min, Number.isInteger(left.min ** right.min), binaryExpr(left, '**', right), null, null, mergeOrigin(left, right))
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
