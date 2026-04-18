import * as ts from 'typescript'
import {parseExpression} from './parser.ts'

export const linearEpsilon = 1e-9

export type LinearExpr = {
  constant: number
  terms: Map<string, number>
}

export function numericLiteralValue(expression: ts.Expression): number | null {
  if (ts.isNumericLiteral(expression)) return Number(expression.text)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text)
  }
  return null
}

export function linearConstant(value: number): LinearExpr {
  return {constant: value, terms: new Map()}
}

export function linearVariable(name: string): LinearExpr {
  return {constant: 0, terms: new Map([[name, 1]])}
}

export function linearFromExpressionText(text: string): LinearExpr | null {
  try {
    return linearFromExpression(parseExpression(text))
  } catch {
    return null
  }
}

export function linearFromExpression(expression: ts.Expression): LinearExpr | null {
  if (ts.isNumericLiteral(expression)) return linearConstant(Number(expression.text))
  if (ts.isIdentifier(expression)) return linearVariable(expression.text)
  if (ts.isPropertyAccessExpression(expression)) return linearVariable(expression.getText())
  if (ts.isParenthesizedExpression(expression)) return linearFromExpression(expression.expression)
  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = linearFromExpression(expression.operand)
    if (operand == null) return null
    if (expression.operator === ts.SyntaxKind.MinusToken) return linearScaleExact(operand, -1)
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
      return rightValue == null || rightValue === 0 ? null : linearScale(left, 1 / rightValue)
    }
    default:
      return null
  }
}

export function linearAdd(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  if (left == null || right == null) return null
  const terms = new Map(left.terms)
  for (const [name, coefficient] of right.terms) {
    terms.set(name, (terms.get(name) ?? 0) + coefficient)
  }
  return cleanLinear({constant: left.constant + right.constant, terms})
}

export function linearSubtract(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  if (left == null || right == null) return null
  return linearAdd(left, linearScaleExact(right, -1))
}

export function linearScale(linear: LinearExpr | null, factor: number): LinearExpr | null {
  return linear == null ? null : linearScaleExact(linear, factor)
}

export function linearScaleExact(linear: LinearExpr, factor: number): LinearExpr {
  const terms = new Map<string, number>()
  for (const [name, coefficient] of linear.terms) terms.set(name, coefficient * factor)
  return cleanLinear({constant: linear.constant * factor, terms})
}

export function sameLinear(left: LinearExpr, right: LinearExpr) {
  const diff = linearSubtract(left, right)
  return diff != null && isZeroLinear(diff)
}

export function cleanLinear(linear: LinearExpr): LinearExpr {
  const terms = new Map<string, number>()
  for (const [name, coefficient] of linear.terms) {
    if (Math.abs(coefficient) > linearEpsilon) terms.set(name, coefficient)
  }
  return {
    constant: Math.abs(linear.constant) > linearEpsilon ? linear.constant : 0,
    terms,
  }
}

export function isZeroLinear(linear: LinearExpr) {
  return linear.constant === 0 && linear.terms.size === 0
}

export function linearConstantStatus(linear: LinearExpr, strict: boolean) {
  if (linear.terms.size > 0) return false
  return strict ? linear.constant > linearEpsilon : linear.constant >= -linearEpsilon
}

export function linearKey(linear: LinearExpr) {
  const parts = [`${linear.constant}`]
  for (const [name, coefficient] of [...linear.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`${name}:${coefficient}`)
  }
  return parts.join('|')
}

export function reductionScales(target: LinearExpr, fact: LinearExpr): number[] {
  const scales: number[] = []
  const names = new Set([...target.terms.keys(), ...fact.terms.keys()])
  for (const name of names) addReductionScale(scales, target.terms.get(name) ?? 0, fact.terms.get(name) ?? 0)
  addReductionScale(scales, target.constant, fact.constant)
  return scales
}

function addReductionScale(scales: number[], targetCoefficient: number, factCoefficient: number) {
  if (Math.abs(targetCoefficient) <= linearEpsilon || Math.abs(factCoefficient) <= linearEpsilon) return
  const scale = targetCoefficient / factCoefficient
  if (scale <= linearEpsilon) return
  if (!scales.some(existing => Math.abs(existing - scale) <= linearEpsilon)) scales.push(scale)
}

export function positiveScaleMultiple(target: LinearExpr, fact: LinearExpr): number | null {
  let scale: number | null = null
  const names = new Set([...target.terms.keys(), ...fact.terms.keys()])
  for (const name of names) {
    const nextScale = coefficientScale(target.terms.get(name) ?? 0, fact.terms.get(name) ?? 0)
    if (nextScale === false) return null
    if (nextScale != null) scale = mergeScale(scale, nextScale)
    if (scale === Number.NEGATIVE_INFINITY) return null
  }

  const constantScale = coefficientScale(target.constant, fact.constant)
  if (constantScale === false) return null
  if (constantScale != null) scale = mergeScale(scale, constantScale)
  if (scale == null || scale === Number.NEGATIVE_INFINITY || scale <= 0) return null
  return scale
}

function coefficientScale(target: number, fact: number): number | null | false {
  if (Math.abs(fact) <= linearEpsilon) return Math.abs(target) <= linearEpsilon ? null : false
  return target / fact
}

export function mergeScale(current: number | null, next: number): number {
  if (current == null) return next
  return Math.abs(current - next) <= linearEpsilon ? current : Number.NEGATIVE_INFINITY
}

export function sameExpressionText(left: string, right: string) {
  return expressionKeyFromText(left) === expressionKeyFromText(right)
}

export function expressionKeyFromText(text: string): string {
  try {
    return expressionKey(parseExpression(text))
  } catch {
    return `text:${text}`
  }
}

export function expressionKey(expression: ts.Expression): string {
  const current = unwrapExpression(expression)
  const linear = linearFromExpression(current)
  if (linear != null) return `linear:${linearKey(linear)}`
  if (ts.isIdentifier(current)) return `id:${current.text}`
  if (ts.isNumericLiteral(current)) return `number:${Number(current.text)}`
  if (ts.isPropertyAccessExpression(current)) return `prop:${expressionKey(current.expression)}.${current.name.text}`
  if (ts.isCallExpression(current)) return `call:${callName(current.expression)}(${current.arguments.map(argument => expressionKey(argument)).join(',')})`
  if (ts.isPrefixUnaryExpression(current)) return `prefix:${current.operator}:${expressionKey(current.operand)}`
  if (ts.isBinaryExpression(current)) {
    const op = current.operatorToken.kind
    if (op === ts.SyntaxKind.AsteriskToken) return `product:${productFactorsFromExpression(current).map(text => expressionKeyFromText(text)).sort().join('*')}`
    return `binary:${ts.SyntaxKind[op]}:${expressionKey(current.left)}:${expressionKey(current.right)}`
  }
  return `text:${current.getText()}`
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

export function callArgs(text: string, name: string): string[] | null {
  const expression = unwrapExpression(parseExpression(text))
  if (!ts.isCallExpression(expression) || callName(expression.expression) !== name) return null
  return expression.arguments.map(argument => argument.getText())
}

export function callArg(text: string, name: string): string | null {
  const args = callArgs(text, name)
  return args != null && args.length === 1 ? args[0]! : null
}

export function ceilDivisionProduct(text: string): {total: string; count: string} | null {
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

export function floorDivision(text: string): {left: string; right: string} | null {
  const floorArg = callArg(text, 'floor')
  return floorArg == null ? null : binaryExpression(floorArg, '/')
}

export function moduloExpression(text: string): {left: string; right: string} | null {
  return binaryExpression(text, '%')
}

export function binaryExpression(text: string, op: '*' | '/' | '%' | '+' | '-'): {left: string; right: string} | null {
  const expression = unwrapExpression(parseExpression(text))
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
  return {left: expression.left.getText(), right: expression.right.getText()}
}

export function productFactors(text: string): string[] | null {
  const expression = unwrapExpression(parseExpression(text))
  const factors = productFactorsFromExpression(expression)
  return factors.length <= 1 ? null : factors
}

function productFactorsFromExpression(expression: ts.Expression): string[] {
  const current = unwrapExpression(expression)
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return [current.getText()]
  return [...productFactorsFromExpression(current.left), ...productFactorsFromExpression(current.right)]
}

export function productText(factors: string[]) {
  if (factors.length === 0) return '1'
  if (factors.length === 1) return factors[0]!
  return factors.map(factor => `(${factor})`).join(' * ')
}
