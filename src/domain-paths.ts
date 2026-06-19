import {
  formatFitDomainPath,
  publicFitText,
  type FitDomainPath,
  type FitDomainPathSegment,
} from './parser.ts'
import {
  arrayElement,
  arrayLength,
  arrayValueAtKnownIndex,
  gridMeet,
  numberWithBounds,
  unknown,
  unknownArray,
  unknownObject,
  type FixedTupleValue,
  type Value,
} from './domain.ts'

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
      return length.kind === 'number'
        ? {...current, length: numberWithBounds(length, length.min, length.max, gridMeet(length.grid, current.length.grid))}
        : current
    }
    if (current?.kind === 'array') return current
    const base = current?.kind === 'object' ? current : unknownObject(expr)
    const props = new Map(base.props)
    const propExpr = `${expr}.${segment.name}`
    props.set(segment.name, setCheckedDomainPathValue(props.get(segment.name), propExpr, segments.slice(1), value, preserveNullable))
    return {...base, props}
  }

  if (segment.kind === 'index') {
    if (current?.kind === 'object') {
      const props = new Map(current.props)
      const name = String(segment.index)
      props.set(name, setCheckedDomainPathValue(props.get(name), `${expr}[${segment.index}]`, segments.slice(1), value, preserveNullable))
      return {...current, props}
    }
    if (current?.kind !== 'array' || current.layout !== 'tuple' || segment.index >= current.elements.length) return current ?? unknownArray(expr)
    const elements = [...current.elements]
    elements[segment.index] = setCheckedDomainPathValue(elements[segment.index], `${expr}[${segment.index}]`, segments.slice(1), value, preserveNullable)
    return {...current, elements}
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

export function checkedDomainPathProblem(domainPath: FitDomainPath, current: Value | undefined): string | null {
  let value = current
  const traversed: FitDomainPath = {root: domainPath.root, segments: []}
  for (const segment of domainPath.segments) {
    traversed.segments.push(segment)
    if (value?.kind === 'nullable') value = value.present
    if (value == null || value.kind === 'unknown') continue

    if (segment.kind === 'item') {
      if (value.kind === 'array') {
        value = arrayElement(value) ?? undefined
        continue
      }
      const objectLength = value.kind === 'object' ? value.props.get('length') : null
      if (objectLength?.kind === 'number') {
        value = undefined
        continue
      }
      return `${formatFitDomainPath(traversed)} expected an array`
    }

    if (segment.kind === 'index') {
      if (value.kind === 'object') {
        value = value.props.get(String(segment.index))
        continue
      }
      const parent = {...traversed, segments: traversed.segments.slice(0, -1)}
      const checked = fixedArrayElementContractCheck(value, formatFitDomainPath(parent), segment.index)
      if ('reason' in checked) return checked.reason
      value = checked.tuple.elements[segment.index]
      continue
    }

    if (value.kind === 'array') {
      if (segment.name !== 'length') {
        return `Static property contract ${formatFitDomainPath(traversed)} requires an object, not an array`
      }
      value = arrayLength(value)
      continue
    }
    if (value.kind !== 'object') return `${formatFitDomainPath(traversed)} expected an object`
    value = value.props.get(segment.name)
  }
  return null
}

function evaluateDomainPathSegments(current: Value, expr: string, segments: FitDomainPathSegment[]): Value {
  const segment = segments[0]
  if (segment == null) return current

  if (segment.kind === 'item') {
    if (current.kind !== 'array') return unknown(`${expr} expected an array`)
    const item = arrayElement(current) ?? unknown(`${expr}[] was not inferred`)
    return evaluateDomainPathSegments(item, `${expr}[]`, segments.slice(1))
  }

  if (segment.kind === 'index') {
    if (current.kind === 'object') {
      const name = String(segment.index)
      const prop = current.props.get(name) ?? unknown(`${expr}[${segment.index}] was not inferred`)
      return evaluateDomainPathSegments(prop, `${expr}[${segment.index}]`, segments.slice(1))
    }
    if (current.kind === 'array') {
      return evaluateDomainPathSegments(arrayValueAtKnownIndex(current, segment.index, `${expr}[${segment.index}]`), `${expr}[${segment.index}]`, segments.slice(1))
    }
    return unknown(`${expr}[${segment.index}] expected an object or fixed tuple`)
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
