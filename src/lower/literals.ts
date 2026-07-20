import * as ts from 'typescript'
import type {DeclaredKind} from '../ir/program.ts'

export type ParameterDefaultLiteral =
  | {kind: 'number'; value: number}
  | {kind: 'boolean'; value: boolean}
  | {kind: 'opaque'; content: string}
  | {kind: 'nullish'; sentinel: 'null' | 'undefined'}

// Reads a numeric literal by runtime value, without trusting its TypeScript type. Parentheses
// and type assertions do not change that value, so `40 as unknown as number` still resolves
// to 40. Arithmetic, identifiers, Infinity, and NaN remain outside this literal rule.
export function numericLiteralValue(expression: ts.Expression): number | null {
  const current = unwrapLiteral(expression)
  if (ts.isNumericLiteral(current)) return Number(current.text)
  if (ts.isPrefixUnaryExpression(current)
    && (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)) {
    const operand = unwrapLiteral(current.operand)
    if (!ts.isNumericLiteral(operand)) return null
    return Number(operand.text) * (current.operator === ts.SyntaxKind.MinusToken ? -1 : 1)
  }
  return null
}

export function parameterDefaultLiteral(
  initializer: ts.Expression,
  checker: ts.TypeChecker,
): ParameterDefaultLiteral | null {
  const current = unwrapLiteral(initializer)
  const number = numericLiteralValue(current)
  if (number != null) return Number.isFinite(number) ? {kind: 'number', value: number} : null
  if (current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) {
    return {kind: 'boolean', value: current.kind === ts.SyntaxKind.TrueKeyword}
  }
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return {kind: 'opaque', content: current.text}
  }
  if (current.kind === ts.SyntaxKind.NullKeyword) return {kind: 'nullish', sentinel: 'null'}
  if (isUndefinedGlobal(current, checker)) {
    return {kind: 'nullish', sentinel: 'undefined'}
  }
  return null
}

export function isUndefinedGlobal(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'undefined') return false
  const symbol = checker.getSymbolAtLocation(expression)
  const global = checker.resolveName('undefined', undefined, ts.SymbolFlags.Value, false)
  return symbol != null && symbol === global
}

export function parameterDefaultFits(default_: ParameterDefaultLiteral, declared: DeclaredKind): boolean {
  if (declared.kind === 'nullish') {
    if (default_.kind === 'nullish') {
      return default_.sentinel === 'null'
        ? declared.sentinels === 'null' || declared.sentinels === 'both'
        : declared.sentinels === 'undefined' || declared.sentinels === 'both'
    }
    return parameterDefaultFits(default_, declared.inner)
  }
  switch (declared.kind) {
    case 'number': {
      if (default_.kind !== 'number') return false
      return declared.interval == null
        || (default_.value >= declared.interval.lower
          && default_.value <= declared.interval.upper
          && (!declared.interval.integer || Number.isInteger(default_.value)))
    }
    case 'boolean': return default_.kind === 'boolean'
    case 'opaque': return default_.kind === 'opaque'
    case 'record':
    case 'tuple':
    case 'array':
    case 'taggedUnion': return false
  }
}

function unwrapLiteral(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)) current = current.expression
  return current
}
