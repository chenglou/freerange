import * as ts from 'typescript'
import {
  mergeElementValue,
  numberValue,
  tupleElements,
  unknown,
  unknownArray,
  unknownNumber,
  unknownObject,
  type Value,
} from '../domain.ts'
import {linearConstant} from '../linear.ts'
import {expressionRootName} from '../source-expressions.ts'
import {noteUnsupported, type InterpreterFrame} from './context.ts'

export type PathSegment =
  | {kind: 'prop'; name: string}
  | {kind: 'index'; index: number}

export type ValuePath = {
  root: string
  segments: PathSegment[]
}

export function pathFromExpression(expression: ts.Expression, evaluateIndex: (expression: ts.Expression) => Value): ValuePath | null {
  const unwrapped = unwrapPathExpression(expression)
  if (ts.isIdentifier(unwrapped)) return {root: unwrapped.text, segments: []}
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const parent = pathFromExpression(unwrapped.expression, evaluateIndex)
    return parent == null ? null : {...parent, segments: [...parent.segments, {kind: 'prop', name: unwrapped.name.text}]}
  }
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression != null) {
    const parent = pathFromExpression(unwrapped.expression, evaluateIndex)
    const index = exactInteger(evaluateIndex(unwrapped.argumentExpression))
    return parent == null || index == null ? null : {...parent, segments: [...parent.segments, {kind: 'index', index}]}
  }
  const root = expressionRootName(unwrapped)
  return root == null ? null : {root, segments: []}
}

export function valuePathExpression(path: ValuePath): string {
  let expr = path.root
  for (const segment of path.segments) {
    expr += segment.kind === 'prop' ? `.${segment.name}` : `[${segment.index}]`
  }
  return expr
}

export function readPath(path: ValuePath, frame: InterpreterFrame, node?: ts.Node): Value {
  const root = frame.env.get(path.root)
  if (root == null) return noteUnsupported(frame, `Unknown assignment root ${path.root}`, node)
  return readPathSegments(root, path.segments)
}

export function writePath(path: ValuePath, value: Value, frame: InterpreterFrame) {
  const current = frame.env.get(path.root) ?? unknownObject(path.root)
  if (path.segments.length === 0) {
    frame.env.set(path.root, value)
    return
  }
  const containerPath = path.segments.slice(0, -1)
  const oldContainer = readPathSegments(current, containerPath)
  const updated = setPathSegments(current, path.segments, value)
  const newContainer = readPathSegments(updated, containerPath)
  if (oldContainer.kind === 'object' || oldContainer.kind === 'array') {
    for (const [name, envValue] of frame.env) {
      frame.env.set(name, replaceSharedValue(envValue, oldContainer, newContainer))
    }
  }
  frame.env.set(path.root, updated)
}

export function readPropertyValue(target: Value, name: string, expr: string): Value {
  if (target.kind === 'object') return target.props.get(name) ?? unknown(`${expr} was not inferred`)
  if (target.kind === 'array' && name === 'length') return target.length
  if (target.kind === 'nullable') return readPropertyValue(target.present, name, expr)
  return unknown(`${expr} expected an object`)
}

export function readArrayIndexValue(target: Value, index: number, expr: string): Value {
  if (target.kind === 'array') return tupleElements(target)?.[index] ?? target.element ?? unknown(`${expr} was not inferred`)
  if (target.kind === 'nullable') return readArrayIndexValue(target.present, index, expr)
  return unknown(`${expr} expected an array`)
}

export function exactInteger(value: Value): number | null {
  return value.kind === 'number' && value.min === value.max && value.isInteger ? value.min : null
}

export function valueExpr(value: Value): string | null {
  switch (value.kind) {
    case 'number':
    case 'literal':
    case 'object':
    case 'array':
    case 'null':
    case 'nullable':
      return value.expr
    case 'unknown':
      return null
  }
}

function readPathSegments(value: Value, segments: PathSegment[]): Value {
  const segment = segments[0]
  if (segment == null) return value
  if (segment.kind === 'prop') return readPathSegments(readPropertyValue(value, segment.name, `${valueExpr(value) ?? 'value'}.${segment.name}`), segments.slice(1))
  return readPathSegments(readArrayIndexValue(value, segment.index, `${valueExpr(value) ?? 'value'}[${segment.index}]`), segments.slice(1))
}

function setPathSegments(current: Value, segments: PathSegment[], value: Value): Value {
  const segment = segments[0]
  if (segment == null) return value
  if (segment.kind === 'prop') {
    if (current.kind === 'array' && segment.name === 'length' && value.kind === 'number') return {...current, length: value}
    const base = current.kind === 'object' ? current : unknownObject(valueExpr(current) ?? 'object')
    const props = new Map(base.props)
    props.set(segment.name, setPathSegments(props.get(segment.name) ?? unknownObject(segment.name), segments.slice(1), value))
    return {...base, props}
  }
  const base = current.kind === 'array' ? current : unknownArray(valueExpr(current) ?? 'array')
  const elements = base.elements == null ? [] : [...base.elements]
  while (elements.length <= segment.index) elements.push(unknownNumber(`${base.expr ?? 'array'}[${elements.length}]`))
  elements[segment.index] = setPathSegments(elements[segment.index]!, segments.slice(1), value)
  let element: Value | null = null
  for (const item of elements) element = mergeElementValue(element, item)
  return {
    ...base,
    layout: 'tuple',
    elements,
    element,
    length: numberValue(elements.length, elements.length, true, `${base.expr ?? 'array'}.length`, linearConstant(elements.length)),
  }
}

function replaceSharedValue(value: Value, from: Value, to: Value): Value {
  if (value === from) return to
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    let changed = false
    for (const [name, prop] of value.props) {
      const next = replaceSharedValue(prop, from, to)
      if (next !== prop) changed = true
      props.set(name, next)
    }
    return changed ? {...value, props} : value
  }
  if (value.kind === 'array') {
    const elements = value.elements == null ? null : value.elements.map(element => replaceSharedValue(element, from, to))
    const element = value.element == null ? null : replaceSharedValue(value.element, from, to)
    const changed = element !== value.element
      || (elements != null && value.elements != null && elements.some((item, index) => item !== value.elements![index]))
    return changed ? {...value, elements, element} : value
  }
  if (value.kind === 'nullable') {
    const present = replaceSharedValue(value.present, from, to)
    return present === value.present ? value : {...value, present}
  }
  return value
}

function unwrapPathExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrapPathExpression(expression.expression)
  if (ts.isNonNullExpression(expression)) return unwrapPathExpression(expression.expression)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) return unwrapPathExpression(expression.expression)
  return expression
}
