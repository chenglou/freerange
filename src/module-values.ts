import * as ts from 'typescript'
import {
  freshReferenceIds,
  literalValue,
  mergeElementValue,
  nullValue,
  numberValue,
  type NumberValue,
  type Value,
  gridOfNumber,
} from './domain.ts'
import {
  linearConstant,
  numericLiteralValue,
} from './linear.ts'
import {localizeValue} from './value-localize.ts'

export function readTopLevelGlobal(declaration: ts.VariableDeclaration): {name: string; value: Value} | null {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) return null
  if ((ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0) return null
  const value = topLevelLiteralValue(declaration.initializer, declaration.name.text)
  if (value == null) return null
  return {
    name: declaration.name.text,
    value,
  }
}

function topLevelLiteralValue(expression: ts.Expression, expr: string): Value | null {
  if (ts.isParenthesizedExpression(expression)) return topLevelLiteralValue(expression.expression, expr)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return topLevelLiteralValue(expression.expression, expr)
  }
  const numeric = numericLiteralValue(expression)
  if (numeric != null) return numberValue(numeric, numeric, gridOfNumber(numeric), expr, linearConstant(numeric))
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return literalValue([expression.text], expr)
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return literalValue([true], expr)
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return literalValue([false], expr)
  if (expression.kind === ts.SyntaxKind.NullKeyword) return nullValue(expr)
  if (ts.isObjectLiteralExpression(expression)) return topLevelObjectLiteralValue(expression, expr)
  if (ts.isArrayLiteralExpression(expression)) return topLevelArrayLiteralValue(expression, expr)
  return null
}

function topLevelObjectLiteralValue(expression: ts.ObjectLiteralExpression, expr: string): Value | null {
  const props = new Map<string, Value>()
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) return null
    const name = propertyNameText(property.name)
    if (name == null) return null
    const value = topLevelLiteralValue(property.initializer, `${expr}.${name}`)
    if (value == null) return null
    props.set(name, value)
  }
  return {kind: 'object', referenceIds: freshReferenceIds(), props, expr}
}

function topLevelArrayLiteralValue(expression: ts.ArrayLiteralExpression, expr: string): Value | null {
  let elementValue: Value | null = null
  const elements: Value[] = []
  for (let index = 0; index < expression.elements.length; index++) {
    const element = expression.elements[index]!
    if (ts.isSpreadElement(element)) return null
    const value = topLevelLiteralValue(element, `${expr}[${index}]`)
    if (value == null) return null
    elements.push(value)
    elementValue = mergeElementValue(elementValue, localizeValue(value, `${expr}[]`, {preserveLinear: true}))
  }
  const length = numberValue(expression.elements.length, expression.elements.length, 0, `${expr}.length`, linearConstant(expression.elements.length))
  return {
    kind: 'array',
    referenceIds: freshReferenceIds(),
    layout: 'collection',
    length,
    elements,
    element: elementValue == null ? null : valueWithoutNumberCases(elementValue),
    expr,
    summary: null,
  }
}

function valueWithoutNumberCases(value: Value): Value {
  if (value.kind === 'number') return {...value, cases: null}
  if (value.kind === 'array') {
    return {
      ...value,
      length: valueWithoutNumberCases(value.length) as NumberValue,
      elements: value.elements == null ? null : value.elements.map(valueWithoutNumberCases),
      element: value.element == null ? null : valueWithoutNumberCases(value.element),
    }
  }
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, valueWithoutNumberCases(prop))
    return {...value, props}
  }
  if (value.kind === 'nullable') return {...value, present: valueWithoutNumberCases(value.present)}
  return value
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}
