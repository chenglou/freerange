import * as ts from 'typescript'
import {
  publicFitText,
  type FitDomainPath,
  type FitDomainPathSegment,
} from './parser.ts'
import {
  arrayElement,
  arrayLength,
  unknown,
  unknownArray,
  unknownObject,
  type FixedTupleValue,
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
export function setCheckedDomainPathValue(
  current: Value | undefined,
  expr: string,
  segments: FitDomainPathSegment[],
  value: Value,
  preserveNullable = false,
): Value {
  if (preserveNullable && current?.kind === 'nullable') {
    return {
      ...current,
      present: setCheckedDomainPathValue(current.present, expr, segments, value, true),
    }
  }
  const segment = segments[0]
  if (segment == null) {
    return preserveNullable && current?.kind === 'nullable'
      ? {...current, present: value}
      : value
  }

  if (segment.kind === 'prop') {
    if (current?.kind === 'array' && segment.name === 'length') {
      if (current.layout === 'tuple') return current
      const length = setCheckedDomainPathValue(current.length, `${expr}.length`, segments.slice(1), value, preserveNullable)
      return length.kind === 'number' ? {...current, length} : current
    }
    const base = current?.kind === 'object' ? current : unknownObject(expr)
    const props = new Map(base.props)
    const propExpr = `${expr}.${segment.name}`
    props.set(segment.name, setCheckedDomainPathValue(props.get(segment.name), propExpr, segments.slice(1), value, preserveNullable))
    return {...base, props}
  }

  const objectLength = current?.kind === 'object' ? current.props.get('length') : null
  const base = current?.kind === 'array'
    ? current
    : unknownArray(expr, objectLength?.kind === 'number' ? objectLength : undefined)
  if (base.layout === 'tuple') {
    return {
      ...base,
      elements: base.elements.map((element, index) =>
        setCheckedDomainPathValue(element, `${expr}[${index}]`, segments.slice(1), value, preserveNullable)),
    }
  }
  return {...base, element: setCheckedDomainPathValue(base.element ?? undefined, `${expr}[]`, segments.slice(1), value, preserveNullable)}
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
    const item = arrayElement(current) ?? unknown(`${expr}[] was not inferred`)
    return evaluateDomainPathSegments(item, `${expr}[]`, segments.slice(1))
  }

  if (current.kind === 'array' && segment.name === 'length') {
    return evaluateDomainPathSegments(arrayLength(current), `${expr}.length`, segments.slice(1))
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

export function directFiniteElementAccess(expression: ts.Expression): {root: string; index: number} | null {
  const current = unwrapExpression(expression)
  if (!ts.isElementAccessExpression(current) || !ts.isIdentifier(unwrapExpression(current.expression))) return null
  return finiteElementAccessRoot(current)
}

// Caller must already have checked the finite element path with TypeScript or a proven helper contract.
export function setCheckedFiniteArrayElementValue(current: Value | undefined, expr: string, index: number, value: Value): Value {
  const checked = fixedArrayElementContractCheck(current, expr, index)
  if ('reason' in checked) return unknown(checked.reason)
  const elements = [...checked.tuple.elements]
  elements[index] = value
  return {...checked.tuple, elements}
}

export function fixedArrayElementContractCheck(
  current: Value | undefined,
  expr: string,
  index: number,
): {tuple: FixedTupleValue} | {reason: string} {
  if (current?.kind !== 'array' || current.layout !== 'tuple') {
    return {reason: `Fixed index contract ${expr}[${index}] requires a fixed tuple type`}
  }
  return index >= current.elements.length
    ? {reason: `Fixed tuple ${expr} has no element at index ${index}`}
    : {tuple: current}
}
