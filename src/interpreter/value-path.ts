import * as ts from 'typescript'
import {
  arrayElement,
  arrayLength,
  arrayValueAtKnownIndex,
  collectionValue,
  joinValues,
  maxArrayLength,
  referenceIdsOverlap,
  unknown,
  type Value,
  integerValued,
} from '../domain.ts'
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

export function writePath(path: ValuePath, value: Value, frame: InterpreterFrame, node?: ts.Node) {
  if (path.segments.length === 0) {
    frame.env.set(path.root, value)
    return
  }
  const current = frame.env.get(path.root)
  if (current == null) {
    frame.env.set(path.root, unknown(`Unknown assignment root ${path.root}`))
    return
  }
  const containerPath = path.segments.slice(0, -1)
  const oldContainer = readPathSegments(current, containerPath)
  const updated = setPathSegments(current, path.segments, value, path.root)
  if (updated.kind === 'unknown' && node != null) noteUnsupported(frame, updated.reason, node)
  const newContainer = readPathSegments(updated, containerPath)
  if (oldContainer.kind === 'object' || oldContainer.kind === 'array') {
    for (const [name, envValue] of frame.env) {
      frame.env.set(name, replaceSharedValue(envValue, oldContainer, newContainer))
    }
  }
  frame.env.set(path.root, updated)
}

// Mutating a value in place (push, sort, a forgotten root) must show through
// every alias of that value; rebinding a name must not. writePath covers
// nested writes by repairing the shared container; this covers writes that
// replace the root's own value.
export function writeMutationPath(path: ValuePath, value: Value, frame: InterpreterFrame) {
  if (path.segments.length > 0) {
    writePath(path, value, frame)
    return
  }
  replaceRootValueEverywhere(frame.env, path.root, value)
}

export function replaceRootValueEverywhere(env: Map<string, Value>, root: string, next: Value) {
  const current = env.get(root)
  if (current != null) replaceValueEverywhere(env, current, next)
  env.set(root, next)
}

export function replaceValueEverywhere(env: Map<string, Value>, current: Value, next: Value) {
  if (
    (current.kind !== 'object' && current.kind !== 'array')
    || (next.kind !== 'object' && next.kind !== 'array')
  ) return
  for (const [name, envValue] of env) {
    env.set(name, replaceSharedValue(envValue, current, next))
  }
}

export function readPropertyValue(target: Value, name: string, expr: string): Value {
  if (target.kind === 'object') return target.props.get(name) ?? unknown(`${expr} was not inferred`)
  if (target.kind === 'array' && name === 'length') return arrayLength(target)
  if (target.kind === 'nullable') return readPropertyValue(target.present, name, expr)
  return unknown(`${expr} expected an object`)
}

export function readArrayIndexValue(target: Value, index: number, expr: string): Value {
  if (target.kind === 'array') return arrayValueAtKnownIndex(target, index, expr)
  if (target.kind === 'nullable') return readArrayIndexValue(target.present, index, expr)
  return unknown(`${expr} expected an array`)
}

export function exactInteger(value: Value): number | null {
  return value.kind === 'number' && value.min === value.max && integerValued(value) ? value.min : null
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

function setPathSegments(current: Value, segments: PathSegment[], value: Value, expr: string): Value {
  const segment = segments[0]
  if (segment == null) return value
  if (segment.kind === 'prop') {
    if (current.kind === 'array' && segment.name === 'length' && value.kind === 'number') {
      return collectionValue(value, null, current.expr, current.referenceIds, null)
    }
    if (current.kind !== 'object') return unknown(`${expr}.${segment.name} expected an object`)
    const props = new Map(current.props)
    const nextExpr = `${expr}.${segment.name}`
    const existing = props.get(segment.name)
    props.set(segment.name, existing == null && segments.length > 1
      ? unknown(`${nextExpr} was not inferred before nested assignment`)
      : setPathSegments(existing ?? value, segments.slice(1), value, nextExpr))
    return {...current, props}
  }
  if (current.kind !== 'array') return unknown(`${expr}[${segment.index}] expected an array`)
  const nextExpr = `${expr}[${segment.index}]`
  if (segment.index < 0 || segment.index >= maxArrayLength) {
    return unknown(`Array index ${segment.index} is not a JavaScript array index`)
  }
  if (current.layout === 'collection') {
    return unknown(`Indexed writes to collections are unsupported: ${nextExpr}`)
  }
  if (segment.index >= current.elements.length) {
    return unknown(`Fixed tuple ${expr} has no element at index ${segment.index}`)
  }
  const elements = [...current.elements]
  elements[segment.index] = setPathSegments(elements[segment.index]!, segments.slice(1), value, nextExpr)
  return {...current, elements}
}

function replaceSharedValue(value: Value, from: Value, to: Value): Value {
  if (
    (value.kind === 'object' || value.kind === 'array')
    && (from.kind === 'object' || from.kind === 'array')
    && referenceIdsOverlap(value.referenceIds, from.referenceIds)
  ) {
    const sameReferences = value.referenceIds.length === from.referenceIds.length
      && value.referenceIds.every(referenceId => from.referenceIds.includes(referenceId))
    if (!sameReferences) return joinValues(value, to)
    if (value.kind === 'array' && value.layout === 'collection' && to.kind === 'array' && to.layout === 'tuple') {
      return collectionValue(
        arrayLength(to),
        arrayElement(to),
        value.expr,
        value.referenceIds,
      )
    }
    return to
  }
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
    if (value.layout === 'tuple') {
      const elements = value.elements.map(element => replaceSharedValue(element, from, to))
      return elements.some((item, index) => item !== value.elements[index])
        ? {...value, elements}
        : value
    }
    const element = value.element == null ? null : replaceSharedValue(value.element, from, to)
    return element === value.element ? value : {...value, element}
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
