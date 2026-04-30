import * as ts from 'typescript'
import {
  publicFitText,
  type FitDomainPath,
  type FitDomainPathSegment,
  type FitRange,
} from './parser.ts'
import {
  unknown,
  unknownArray,
  unknownNumber,
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

export function closedRangeApprox(range: FitRange): {min: number; max: number} | null {
  const lower = range.lowerValue ?? Number.NEGATIVE_INFINITY
  const upper = range.upperValue ?? Number.POSITIVE_INFINITY
  const min = range.valueKind === 'int' && range.lowerValue != null && !range.lowerInclusive
    ? Math.floor(lower) + 1
    : lower
  const max = range.valueKind === 'int' && range.upperValue != null && !range.upperInclusive
    ? Math.ceil(upper) - 1
    : upper
  if (!Number.isFinite(min) && !Number.isFinite(max) && min === Number.NEGATIVE_INFINITY && max === Number.POSITIVE_INFINITY) return null
  return {min, max}
}

export function setDomainPathValue(current: Value | undefined, expr: string, segments: FitDomainPathSegment[], value: Value): Value {
  const segment = segments[0]
  if (segment == null) return value

  if (segment.kind === 'prop') {
    if (current?.kind === 'array' && segment.name === 'length') {
      const length = setDomainPathValue(current.length, `${expr}.length`, segments.slice(1), value)
      return length.kind === 'number' ? {...current, length} : current
    }
    const base = current?.kind === 'object' ? current : unknownObject(expr)
    const props = new Map(base.props)
    const propExpr = `${expr}.${segment.name}`
    props.set(segment.name, setDomainPathValue(props.get(segment.name), propExpr, segments.slice(1), value))
    return {...base, props}
  }

  const objectLength = current?.kind === 'object' ? current.props.get('length') : null
  const base = current?.kind === 'array'
    ? current
    : unknownArray(expr, objectLength?.kind === 'number' ? objectLength : undefined)
  return {
    ...base,
    element: setDomainPathValue(base.element ?? undefined, `${expr}[]`, segments.slice(1), value),
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
    const item = current.element ?? (segments[1]?.kind === 'prop' ? unknownObject(`${expr}[]`) : unknownNumber(`${expr}[]`))
    return evaluateDomainPathSegments(item, `${expr}[]`, segments.slice(1))
  }

  if (current.kind === 'array' && segment.name === 'length') {
    return evaluateDomainPathSegments(current.length, `${expr}.length`, segments.slice(1))
  }
  if (current.kind === 'object') {
    const prop = current.props.get(segment.name) ?? (current.expr == null ? unknown(`Unknown property ${segment.name}`) : unknownNumber(`${current.expr}.${segment.name}`))
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

export function setFiniteArrayElementValue(current: Value | undefined, expr: string, index: number, value: Value): Value {
  const base = current?.kind === 'array' ? current : unknownArray(expr)
  const elements = base.elements == null ? [] : [...base.elements]
  while (elements.length <= index) {
    elements.push(base.element ?? unknownNumber(`${expr}[${elements.length}]`))
  }
  elements[index] = value
  return {...base, layout: 'tuple', elements}
}
