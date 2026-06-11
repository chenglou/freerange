import * as ts from 'typescript'
import {
  fitExpressionParsed,
  fitExpressionText,
  publicParsedExpressionText,
  type FitExpressionLike,
  type ParsedFitExpression,
} from './parser.ts'
import {
  rationalAdd,
  rationalCompare,
  rationalDivide,
  rationalFromNumber,
  rationalIsZero,
  rationalKey,
  rationalMultiply,
  rationalNegate,
  rationalOne,
  rationalZero,
  type Rational,
} from './rational.ts'

// Coefficients are exact rationals. A proof layer must never drop or blur a
// term by magnitude: 1e-10 * x over x: ±1e12 is ±100, not 0.
export type LinearExpr = {
  constant: Rational
  terms: Map<string, Rational>
}

export function numericLiteralValue(expression: ts.Expression): number | null {
  if (ts.isNumericLiteral(expression)) return Number(expression.text)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text)
  }
  return null
}

// Infinity and NaN have no linear form.
export function linearConstant(value: number): LinearExpr | null {
  const constant = rationalFromNumber(value)
  return constant == null ? null : {constant, terms: new Map()}
}

export function linearVariable(name: string): LinearExpr {
  return {constant: rationalZero, terms: new Map([[name, rationalOne]])}
}

export function linearFromExpressionText(text: FitExpressionLike): LinearExpr | null {
  try {
    return linearFromExpression(fitExpressionParsed(text).expression)
  } catch {
    return null
  }
}

export function linearFromExpression(expression: ts.Expression): LinearExpr | null {
  if (ts.isNumericLiteral(expression)) return linearConstant(Number(expression.text))
  if (ts.isIdentifier(expression)) return linearVariable(expression.text)
  if (ts.isPropertyAccessExpression(expression)) return linearVariable(expression.getText())
  if (ts.isElementAccessExpression(expression) && isFixedElementPathExpression(expression)) return linearVariable(expression.getText())
  if (ts.isParenthesizedExpression(expression)) return linearFromExpression(expression.expression)
  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = linearFromExpression(expression.operand)
    if (operand == null) return null
    if (expression.operator === ts.SyntaxKind.MinusToken) return linearScaleExact(operand, rationalNegate(rationalOne))
    if (expression.operator === ts.SyntaxKind.PlusToken) return operand
    return null
  }
  if (!ts.isBinaryExpression(expression)) return null
  const left = linearFromExpression(expression.left)
  const right = linearFromExpression(expression.right)
  switch (expression.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return linearAdd(left, right)
    case ts.SyntaxKind.MinusToken:
      return linearSubtract(left, right)
    case ts.SyntaxKind.AsteriskToken: {
      const leftValue = numericLiteralValue(expression.left)
      const rightValue = numericLiteralValue(expression.right)
      if (leftValue != null) return linearScale(right, leftValue)
      if (rightValue != null) return linearScale(left, rightValue)
      return null
    }
    case ts.SyntaxKind.SlashToken: {
      const rightValue = numericLiteralValue(expression.right)
      return rightValue == null || rightValue === 0 ? null : linearDivide(left, rightValue)
    }
    default:
      return null
  }
}

export function isFixedElementPathExpression(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword) return true
  if (ts.isPropertyAccessExpression(current)) return isFixedElementPathExpression(current.expression)
  if (ts.isElementAccessExpression(current)) {
    return numericLiteralValue(current.argumentExpression) != null && isFixedElementPathExpression(current.expression)
  }
  return false
}

export function linearAdd(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  if (left == null || right == null) return null
  const terms = new Map(left.terms)
  for (const [name, coefficient] of right.terms) {
    terms.set(name, rationalAdd(terms.get(name) ?? rationalZero, coefficient))
  }
  return cleanLinear({constant: rationalAdd(left.constant, right.constant), terms})
}

export function linearSubtract(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  if (left == null || right == null) return null
  return linearAdd(left, linearScaleExact(right, rationalNegate(rationalOne)))
}

export function linearScale(linear: LinearExpr | null, factor: number): LinearExpr | null {
  if (linear == null) return null
  const rationalFactor = rationalFromNumber(factor)
  return rationalFactor == null ? null : linearScaleExact(linear, rationalFactor)
}

export function linearDivide(linear: LinearExpr | null, divisor: number): LinearExpr | null {
  if (linear == null) return null
  const rationalDivisor = rationalFromNumber(divisor)
  if (rationalDivisor == null || rationalIsZero(rationalDivisor)) return null
  const inverse = rationalDivide(rationalOne, rationalDivisor)
  return inverse == null ? null : linearScaleExact(linear, inverse)
}

export function linearScaleExact(linear: LinearExpr, factor: Rational): LinearExpr {
  const terms = new Map<string, Rational>()
  for (const [name, coefficient] of linear.terms) terms.set(name, rationalMultiply(coefficient, factor))
  return cleanLinear({constant: rationalMultiply(linear.constant, factor), terms})
}

export function sameLinear(left: LinearExpr, right: LinearExpr) {
  const diff = linearSubtract(left, right)
  return diff != null && isZeroLinear(diff)
}

// Removes exactly-zero terms; nothing else is droppable.
export function cleanLinear(linear: LinearExpr): LinearExpr {
  const terms = new Map<string, Rational>()
  for (const [name, coefficient] of linear.terms) {
    if (!rationalIsZero(coefficient)) terms.set(name, coefficient)
  }
  return {constant: linear.constant, terms}
}

export function isZeroLinear(linear: LinearExpr) {
  return rationalIsZero(linear.constant) && linear.terms.size === 0
}

export function linearConstantStatus(linear: LinearExpr, strict: boolean) {
  if (linear.terms.size > 0) return false
  const sign = rationalCompare(linear.constant, rationalZero)
  return strict ? sign > 0 : sign >= 0
}

export function linearKey(linear: LinearExpr) {
  const parts = [rationalKey(linear.constant)]
  for (const [name, coefficient] of [...linear.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`${name}:${rationalKey(coefficient)}`)
  }
  return parts.join('|')
}

export function sameExpressionText(left: FitExpressionLike, right: FitExpressionLike) {
  if (fitExpressionText(left) === fitExpressionText(right)) return true
  return expressionKeyFromText(left) === expressionKeyFromText(right)
}

export function expressionKeyFromText(text: FitExpressionLike): string {
  try {
    return expressionKey(fitExpressionParsed(text).expression)
  } catch {
    return `text:${fitExpressionText(text)}`
  }
}

export function expressionKey(expression: ts.Expression): string {
  const current = unwrapExpression(expression)
  if (containsElementAccess(current)) return structuralExpressionKey(current)
  const linear = linearFromExpression(current)
  if (linear != null) return `linear:${linearKey(linear)}`
  return structuralExpressionKey(current)
}

function structuralExpressionKey(current: ts.Expression): string {
  if (ts.isIdentifier(current)) return `id:${current.text}`
  if (ts.isNumericLiteral(current)) return `number:${Number(current.text)}`
  if (ts.isPropertyAccessExpression(current)) return `prop:${expressionKey(current.expression)}.${current.name.text}`
  if (ts.isElementAccessExpression(current) && current.argumentExpression != null) return `element:${expressionKey(current.expression)}[${expressionKey(current.argumentExpression)}]`
  if (ts.isCallExpression(current)) return `call:${callName(current.expression)}(${current.arguments.map(argument => expressionKey(argument)).join(',')})`
  if (ts.isPrefixUnaryExpression(current)) return `prefix:${current.operator}:${expressionKey(current.operand)}`
  if (ts.isBinaryExpression(current)) {
    const op = current.operatorToken.kind
    if (op === ts.SyntaxKind.AsteriskToken) return `product:${productFactorExpressions(current).map(expressionKey).sort().join('*')}`
    return `binary:${ts.SyntaxKind[op]}:${expressionKey(current.left)}:${expressionKey(current.right)}`
  }
  return `text:${current.getText()}`
}

function containsElementAccess(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isElementAccessExpression(current)) return true
  if (ts.isPropertyAccessExpression(current)) return containsElementAccess(current.expression)
  if (ts.isParenthesizedExpression(current)) return containsElementAccess(current.expression)
  if (ts.isPrefixUnaryExpression(current)) return containsElementAccess(current.operand)
  if (ts.isBinaryExpression(current)) return containsElementAccess(current.left) || containsElementAccess(current.right)
  if (ts.isCallExpression(current)) {
    if (containsElementAccess(current.expression)) return true
    return current.arguments.some(argument => containsElementAccess(argument))
  }
  return false
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

export function callName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`
  return expression.getText()
}

export function callArgs(text: FitExpressionLike, name: string): string[] | null {
  const parsed = parseFitExpressionOrNull(text)
  if (parsed == null) return null
  const expression = unwrapExpression(parsed.expression)
  if (!ts.isCallExpression(expression) || callName(expression.expression) !== name) return null
  return expression.arguments.map(argument => publicParsedExpressionText(parsed, argument))
}

export function callArg(text: FitExpressionLike, name: string): string | null {
  const args = callArgs(text, name)
  return args != null && args.length === 1 ? args[0]! : null
}

export function ceilDivisionProduct(text: FitExpressionLike): {total: string; count: string} | null {
  const product = binaryExpression(text, '*')
  if (product == null) return null
  for (const [maybeCeil, maybeCount] of [[product.left, product.right], [product.right, product.left]] as const) {
    const ceilArg = callArg(maybeCeil, 'ceil')
    if (ceilArg == null) continue
    const division = binaryExpression(ceilArg, '/')
    if (division != null && sameExpressionText(division.right, maybeCount)) return {total: division.left, count: division.right}
  }
  return null
}

export function floorDivision(text: FitExpressionLike): {left: string; right: string} | null {
  const floorArg = callArg(text, 'floor')
  return floorArg == null ? null : binaryExpression(floorArg, '/')
}

export function binaryExpression(text: FitExpressionLike, op: '*' | '/' | '%' | '+' | '-'): {left: string; right: string} | null {
  const parsed = parseFitExpressionOrNull(text)
  if (parsed == null) return null
  const expression = unwrapExpression(parsed.expression)
  if (!ts.isBinaryExpression(expression)) return null
  const expected = op === '*'
    ? ts.SyntaxKind.AsteriskToken
    : op === '/'
      ? ts.SyntaxKind.SlashToken
      : op === '%'
        ? ts.SyntaxKind.PercentToken
        : op === '+'
          ? ts.SyntaxKind.PlusToken
          : ts.SyntaxKind.MinusToken
  if (expression.operatorToken.kind !== expected) return null
  return {left: publicParsedExpressionText(parsed, expression.left), right: publicParsedExpressionText(parsed, expression.right)}
}

export function productFactors(text: FitExpressionLike): string[] | null {
  const parsed = parseFitExpressionOrNull(text)
  if (parsed == null) return null
  const expression = unwrapExpression(parsed.expression)
  const factors = productFactorExpressions(expression).map(factor => publicParsedExpressionText(parsed, factor))
  return factors.length <= 1 ? null : factors
}

function parseFitExpressionOrNull(text: FitExpressionLike): ParsedFitExpression | null {
  try {
    return fitExpressionParsed(text)
  } catch {
    return null
  }
}

function productFactorExpressions(expression: ts.Expression): ts.Expression[] {
  const current = unwrapExpression(expression)
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return [current]
  return [...productFactorExpressions(current.left), ...productFactorExpressions(current.right)]
}

export function productText(factors: string[]) {
  if (factors.length === 0) return '1'
  if (factors.length === 1) return factors[0]!
  return factors.map(factor => `(${factor})`).join(' * ')
}
