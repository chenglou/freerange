import {
  linearNameForExpression,
  numberValue,
  unknownNumber,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {linearConstant, linearEpsilon, linearSubtract, linearVariable, sameExpressionText} from '../linear.ts'
import {
  indexedElementPathValue,
  type LoopPush as LoopSummaryPush,
  type LoopScalarUpdate,
} from '../loop-summary.ts'
import {comparisonConstraint, proveComparison} from '../proof.ts'
import type {LoopAppend} from './context.ts'

export function indexedLoopValue(value: Value, indexName: string, arrayExpr: string, path: string[], length: NumberValue): Value {
  if (value.kind === 'number' && value.expr === indexName) return indexedElementPathValue(loopElementPathExpression(arrayExpr, path), length)
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, indexedLoopValue(prop, indexName, arrayExpr, [...path, name], length))
    return {...value, props}
  }
  if (value.kind === 'array') {
    return {
      ...value,
      elements: value.elements == null ? null : value.elements.map(element => indexedLoopValue(element, indexName, arrayExpr, [...path, '[]'], length)),
      element: value.element == null ? null : indexedLoopValue(value.element, indexName, arrayExpr, [...path, '[]'], length),
    }
  }
  if (value.kind === 'nullable') return {...value, present: indexedLoopValue(value.present, indexName, arrayExpr, path, length)}
  return value
}

export function indexedElementAssumptions(value: NumberValue, length: NumberValue): LinearConstraint[] {
  const lower = comparisonConstraint(value, '>=', numberValue(0, 0, true, '0', linearConstant(0)))
  const upper = comparisonConstraint(value, '<', length)
  return [lower, upper].filter((fact): fact is LinearConstraint => fact != null)
}

export function loopAppendShapeWithCursorUpdates(append: LoopAppend, updates: Map<string, LoopScalarUpdate>): LoopSummaryPush {
  const cursorPaths = append.cursorPaths.filter(cursorPath => updates.has(cursorPath.targetName))
  const cursorPath = cursorPaths[0]
  const cursorName = cursorPath?.targetName ?? null
  const topPath = cursorPath?.path ?? null
  const increment = cursorName == null ? null : updates.get(cursorName)?.increment ?? null
  return {
    arrayName: append.arrayName,
    length: append.length,
    element: append.element,
    topName: cursorName,
    topPath,
    height: topPath == null || increment == null ? null : siblingSizeValue(append.element, topPath, increment),
    cursorPaths,
  }
}

export function loopAppendElementWithCursorUpdates(append: LoopAppend, updates: Map<string, LoopScalarUpdate>, assumptions: LinearConstraint[]): Value | null {
  let element = append.element
  for (const cursorPath of append.cursorPaths) {
    const update = updates.get(cursorPath.targetName)
    if (update == null || element == null) continue
    const expr = loopElementPathExpression(append.arrayName, cursorPath.path)
    element = setLoopElementPathValue(element, cursorPath.path, loopCursorElementValue(update, expr, assumptions))
  }
  return element
}

export function loopElementPathExpression(arrayName: string, path: string[]): string {
  let expr = `${arrayName}[]`
  for (const part of path) expr += part === '[]' ? '[]' : `.${part}`
  return expr
}

function setLoopElementPathValue(value: Value, path: string[], replacement: Value): Value {
  const [head, ...tail] = path
  if (head == null) return replacement
  if (head === '[]' && value.kind === 'array') {
    return {
      ...value,
      elements: value.elements == null ? null : value.elements.map(element => setLoopElementPathValue(element, tail, replacement)),
      element: value.element == null ? replacement : setLoopElementPathValue(value.element, tail, replacement),
    }
  }
  if (value.kind !== 'object') return value
  const props = new Map(value.props)
  const current = props.get(head)
  if (tail.length === 0) props.set(head, replacement)
  else if (current != null) props.set(head, setLoopElementPathValue(current, tail, replacement))
  return {...value, props}
}

function siblingSizeValue(value: Value | null, cursorPath: string[], increment: NumberValue): NumberValue | null {
  if (cursorPath.length === 0) return null
  const parent = valueAtObjectPath(value, cursorPath.slice(0, -1))
  if (parent?.kind !== 'object') return null
  const cursorField = cursorPath.at(-1)!
  for (const [name, prop] of parent.props) {
    if (name === cursorField) continue
    if (prop.kind !== 'number') continue
    if (incrementSizeMatch(increment, prop)) return prop
  }
  return null
}

function incrementSizeMatch(increment: NumberValue, size: NumberValue): boolean {
  if (increment.linear != null && size.linear != null) {
    const remainder = linearSubtract(increment.linear, size.linear)
    if (remainder == null) return false
    if (remainder.constant < -linearEpsilon) return false
    for (const coef of remainder.terms.values()) if (coef < -linearEpsilon) return false
    return true
  }
  if (increment.expr != null && size.expr != null) {
    return sameExpressionText(increment.expr, size.expr) || incrementExprIncludesSize(increment.expr, size.expr)
  }
  return false
}

function incrementExprIncludesSize(incrementExpr: string, sizeExpr: string): boolean {
  if (sameExpressionText(incrementExpr, sizeExpr)) return true
  const stripped = incrementExpr.replace(/^\(|\)$/g, '')
  const parts = stripped.split('+').map(part => part.trim())
  return parts.some(part => sameExpressionText(part, sizeExpr))
}

function valueAtObjectPath(value: Value | null, path: string[]): Value | null {
  if (value == null) return null
  const [head, ...tail] = path
  if (head == null) return value
  if (value.kind !== 'object') return null
  return valueAtObjectPath(value.props.get(head) ?? null, tail)
}

function loopCursorElementValue(update: LoopScalarUpdate, expr: string, assumptions: LinearConstraint[]): NumberValue {
  if (update.increment.min < 0) return unknownNumber(expr)
  const startMin = proveComparison(update.start, '>=', numberValue(0, 0, true, '0', linearConstant(0)), assumptions).status === 'pass'
    ? Math.max(0, update.start.min)
    : update.start.min
  return numberValue(
    startMin,
    update.end.max,
    update.start.isInteger && update.increment.isInteger,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}
