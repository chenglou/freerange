import {
  linearNameForExpression,
  numberValue,
  unknownNumber,
  unknownObject,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {linearConstant, linearVariable} from '../linear.ts'
import {
  indexedElementPathValue,
  type LoopPush as LoopSummaryPush,
  type LoopScalarUpdate,
} from '../loop-summary.ts'
import {comparisonConstraint} from '../proof.ts'
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
  const topPath = cursorPaths[0]?.path ?? null
  return {
    arrayName: append.arrayName,
    length: append.length,
    element: append.element,
    topName: cursorPaths[0]?.targetName ?? null,
    topPath,
    height: topPath == null ? null : heightValueForTopPath(append.element, topPath),
    cursorPaths,
  }
}

export function loopAppendElementWithCursorUpdates(append: LoopAppend, updates: Map<string, LoopScalarUpdate>): Value | null {
  let element = append.element
  for (const cursorPath of append.cursorPaths) {
    const update = updates.get(cursorPath.targetName)
    if (update == null || element == null) continue
    const expr = loopElementPathExpression(append.arrayName, cursorPath.path)
    element = setLoopElementPathValue(element, cursorPath.path, loopCursorElementValue(update, expr))
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
  props.set(head, setLoopElementPathValue(props.get(head) ?? unknownObject(head), tail, replacement))
  return {...value, props}
}

function heightValueForTopPath(value: Value | null, topPath: string[]): NumberValue | null {
  if (topPath.at(-1) !== 'top') return null
  const heightPath = [...topPath.slice(0, -1), 'height']
  const height = valueAtObjectPath(value, heightPath)
  return height?.kind === 'number' ? height : null
}

function valueAtObjectPath(value: Value | null, path: string[]): Value | null {
  if (value == null) return null
  const [head, ...tail] = path
  if (head == null) return value
  if (value.kind !== 'object') return null
  return valueAtObjectPath(value.props.get(head) ?? null, tail)
}

function loopCursorElementValue(update: LoopScalarUpdate, expr: string): NumberValue {
  if (update.increment.min < 0) return unknownNumber(expr)
  return numberValue(
    update.start.min,
    update.end.max,
    update.start.isInteger && update.increment.isInteger,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}
