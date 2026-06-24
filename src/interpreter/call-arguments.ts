import * as ts from 'typescript'
import {unwrapExpression} from './source-syntax.ts'

export type StructuredArgument<T> =
  | {kind: 'single'; value: T}
  | {kind: 'spread'; element: T; elements: readonly T[] | null}

export type ParameterValues<T> = {
  values: readonly T[]
  inexactSpread: boolean
}

export function structuredCallArguments<T>(
  arguments_: readonly ts.Expression[],
  valueFor: (expression: ts.Expression) => T,
  spreadElementFor: (expression: ts.Expression) => T,
  empty: () => T,
): StructuredArgument<T>[] {
  return arguments_.map(argument => {
    if (!ts.isSpreadElement(argument)) {
      return {kind: 'single', value: valueFor(argument)}
    }
    const exact = exactSpreadElements(argument.expression)
    return {
      kind: 'spread',
      element: spreadElementFor(argument.expression),
      elements: exact?.map(expression => expression == null ? empty() : valueFor(expression)) ?? null,
    }
  })
}

export function parameterValues<T>(
  rest: boolean,
  index: number,
  arguments_: readonly StructuredArgument<T>[],
): ParameterValues<T> {
  const exactPrefix: T[] = []
  const uncertainSuffix: T[] = []
  let inexactSpread = false
  for (const argument of arguments_) {
    let exact: readonly T[]
    if (argument.kind === 'single') {
      exact = [argument.value]
    } else {
      if (argument.elements == null) {
        inexactSpread = true
        uncertainSuffix.push(argument.element)
        continue
      }
      exact = argument.elements
    }
    if (inexactSpread) uncertainSuffix.push(...exact)
    else exactPrefix.push(...exact)
  }

  if (rest) {
    return {
      values: [...exactPrefix.slice(index), ...uncertainSuffix],
      inexactSpread,
    }
  }
  if (index < exactPrefix.length) {
    return {values: [exactPrefix[index]!], inexactSpread: false}
  }
  return {
    values: uncertainSuffix,
    inexactSpread,
  }
}

export function callExpressionsForPosition(
  arguments_: readonly ts.Expression[],
  index: number,
  rest = false,
): {expressions: ts.Expression[]; inexactSpread: boolean} {
  const structured = structuredCallArguments<ts.Expression | null>(
    arguments_,
    expression => expression,
    expression => expression,
    () => null,
  )
  const mapped = parameterValues(rest, index, structured)
  return {
    expressions: mapped.values.filter(expression => expression != null),
    inexactSpread: mapped.inexactSpread,
  }
}

function exactSpreadElements(expression: ts.Expression): (ts.Expression | null)[] | null {
  const current = unwrapExpression(expression)
  if (!ts.isArrayLiteralExpression(current)) return null
  const elements: (ts.Expression | null)[] = []
  for (const element of current.elements) {
    if (ts.isOmittedExpression(element)) {
      elements.push(null)
      continue
    }
    if (!ts.isSpreadElement(element)) {
      elements.push(element)
      continue
    }
    const nested = exactSpreadElements(element.expression)
    if (nested == null) return null
    elements.push(...nested)
  }
  return elements
}
