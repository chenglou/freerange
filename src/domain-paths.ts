import * as ts from 'typescript'
import {
  publicFitText,
  type FitDomainPath,
  type FitDomainPathSegment,
} from './parser.ts'
import {
  unknown,
  unknownArray,
  unknownObject,
  type Value,
} from './domain.ts'
import {
  numericLiteralValue,
  unwrapExpression,
} from './linear.ts'
import {expressionRootName} from './source-expressions.ts'

export function parsePrintedNumber(text: string): number | null {
  if (text === 'Infinity') return Number.POSITIVE_INFINITY
  if (text === '-Infinity') return Number.NEGATIVE_INFINITY
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

// Caller must already have checked the path with TypeScript or a proven helper contract.
export function setCheckedDomainPathValue(current: Value | undefined, expr: string, segments: FitDomainPathSegment[], value: Value): Value {
  const segment = segments[0]
  if (segment == null) return value

  if (segment.kind === 'prop') {
    if (current?.kind === 'array' && segment.name === 'length') {
      const length = setCheckedDomainPathValue(current.length, `${expr}.length`, segments.slice(1), value)
      return length.kind === 'number' ? {...current, length} : current
    }
    const base = current?.kind === 'object' ? current : unknownObject(expr)
    const props = new Map(base.props)
    const propExpr = `${expr}.${segment.name}`
    props.set(segment.name, setCheckedDomainPathValue(props.get(segment.name), propExpr, segments.slice(1), value))
    return {...base, props}
  }

  const objectLength = current?.kind === 'object' ? current.props.get('length') : null
  const base = current?.kind === 'array'
    ? current
    : unknownArray(expr, objectLength?.kind === 'number' ? objectLength : undefined)
  return {
    ...base,
    element: setCheckedDomainPathValue(base.element ?? undefined, `${expr}[]`, segments.slice(1), value),
  }
}

export function evaluateDomainPathValue(domainPath: FitDomainPath, env: Map<string, Value>): Value {
  const root = env.get(domainPath.root) ?? unknown(`Unknown identifier ${domainPath.root}`)
  return evaluateDomainPathSegments(root, domainPath.root, domainPath.segments)
}

function evaluateDomainPathSegments(current: Value, expr: string, segments: FitDomainPathSegment[]): Value {
  const segment = segments[0]
  if (segment == null) return current

  if (segment.kind === 'item') {
    if (current.kind !== 'array') return unknown(`${expr} expected an array`)
    const item = current.element ?? unknown(`${expr}[] was not inferred`)
    return evaluateDomainPathSegments(item, `${expr}[]`, segments.slice(1))
  }

  if (current.kind === 'array' && segment.name === 'length') {
    return evaluateDomainPathSegments(current.length, `${expr}.length`, segments.slice(1))
  }
  if (current.kind === 'object') {
    const prop = current.props.get(segment.name) ?? unknown(`${expr}.${segment.name} was not inferred`)
    return evaluateDomainPathSegments(prop, `${expr}.${segment.name}`, segments.slice(1))
  }
  return unknown(`${publicFitText(`${expr}.${segment.name}`)} expected an object`)
}

export function finiteElementAccessRoot(expression: ts.Expression): {root: string; index: number} | null {
  const current = unwrapExpression(expression)
  if (!ts.isElementAccessExpression(current)) return null
  const index = numericLiteralValue(current.argumentExpression)
  if (index == null || !Number.isInteger(index) || index < 0) return null
  const root = expressionRootName(current.expression)
  return root == null ? null : {root, index}
}

// Caller must already have checked the finite element path with TypeScript or a proven helper contract.
export function setCheckedFiniteArrayElementValue(current: Value | undefined, expr: string, index: number, value: Value): Value {
  const base = current?.kind === 'array' ? current : unknownArray(expr)
  const elements = base.elements == null ? [] : [...base.elements]
  while (elements.length <= index) {
    elements.push(base.element ?? unknown(`${expr}[${elements.length}] was not inferred`))
  }
  elements[index] = value
  return {...base, layout: 'tuple', elements}
}
