import * as ts from 'typescript'
import {
  fitDomainPathKey,
  fitDomainPathFromExpression,
  fitExpressionParsed,
  fitExpressionText,
  domainPathLinearName,
  formatFitDomainPath,
  publicParsedExpressionText,
  type FitExpressionLike,
  type FitDomainPath,
  type ParsedFitExpression,
} from './parser.ts'
import {
  rationalDivide,
  rationalFromNumber,
  rationalIsZero,
  rationalKey,
  rationalNegate,
  rationalOne,
  rationalToExactNumber,
  type Rational,
} from './numeric/rational.ts'
import {
  isZeroLinear,
  linearAdd as numericLinearAdd,
  linearConstant as numericLinearConstant,
  linearConstantStatus,
  linearFromTerms as numericLinearFromTerms,
  linearScale as numericLinearScale,
  linearSubtract as numericLinearSubtract,
  linearVariable as numericLinearVariable,
  sameLinear,
  singleUnitAtom as numericSingleUnitAtom,
  type LinearExpr as NumericLinearExpr,
} from './numeric/linear.ts'

export {
  isZeroLinear,
  linearConstantStatus,
  sameLinear,
}

export type LinearExpr = NumericLinearExpr<string>
export const linearConstantExact = numericLinearConstant<string>
export const linearScaleExact = numericLinearScale<string>

export function linearFromTerms(constant: Rational, terms: ReadonlyMap<string, Rational>): LinearExpr {
  return numericLinearFromTerms(constant, terms)
}

export function linearConstant(value: number): LinearExpr | null {
  const rational = rationalFromNumber(value)
  return rational == null ? null : numericLinearConstant(rational)
}

export const linearVariable = numericLinearVariable<string>

export function linearAdd(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  return left == null || right == null ? null : numericLinearAdd(left, right)
}

export function linearSubtract(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  return left == null || right == null ? null : numericLinearSubtract(left, right)
}

export function linearScale(linear: LinearExpr | null, factor: number): LinearExpr | null {
  if (linear == null) return null
  const rational = rationalFromNumber(factor)
  return rational == null ? null : numericLinearScale(linear, rational)
}

export function linearDivide(linear: LinearExpr | null, divisor: number): LinearExpr | null {
  if (linear == null) return null
  const rationalDivisor = rationalFromNumber(divisor)
  if (rationalDivisor == null || rationalIsZero(rationalDivisor)) return null
  const inverse = rationalDivide(rationalOne, rationalDivisor)
  return inverse == null ? null : numericLinearScale(linear, inverse)
}

export function singleUnitAtom(linear: LinearExpr | null): string | null {
  return linear == null ? null : numericSingleUnitAtom(linear)?.atom ?? null
}

export function numericLiteralValue(expression: ts.Expression): number | null {
  if (ts.isNumericLiteral(expression)) return Number(expression.text)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text)
  }
  return null
}

export function linearFromExpressionText(text: FitExpressionLike): LinearExpr | null {
  try {
    const parsed = fitExpressionParsed(text)
    return linearFromExpression(parsed.expression, parsed.domainPaths)
  } catch {
    return null
  }
}

// Expression text follows JS evaluation, not real arithmetic: lowering
// `(x / 3) * 3` to the real form x would prove cancellations the runtime's
// rounding refutes. Arithmetic on known constants folds with exact IEEE
// semantics like source literals; everything else becomes one opaque atom,
// named like the evaluator names the same computation, so identical
// computations still connect through Farkas without claiming any algebra.
export function linearFromExpression(expression: ts.Expression, domainPaths: ReadonlyMap<string, FitDomainPath> = new Map()): LinearExpr | null {
  if (ts.isNumericLiteral(expression)) return linearConstant(Number(expression.text))
  const domainPath = fitDomainPathFromExpression(expression, domainPaths)
  if (domainPath != null) {
    const text = formatFitDomainPath(domainPath)
    return linearVariable(domainPath.segments.some(segment => segment.kind === 'item') ? domainPathLinearName(text) : text)
  }
  if (ts.isElementAccessExpression(expression) && isFixedElementPathExpression(expression)) return linearVariable(expression.getText())
  if (ts.isParenthesizedExpression(expression)) return linearFromExpression(expression.expression, domainPaths)
  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = linearFromExpression(expression.operand, domainPaths)
    if (operand == null) return null
    // Unary minus is a sign-bit flip: exact for every double.
    if (expression.operator === ts.SyntaxKind.MinusToken) return linearScaleExact(operand, rationalNegate(rationalOne))
    if (expression.operator === ts.SyntaxKind.PlusToken) return operand
    return null
  }
  if (!ts.isBinaryExpression(expression)) return null
  const op = expression.operatorToken.kind
  if (op !== ts.SyntaxKind.PlusToken && op !== ts.SyntaxKind.MinusToken && op !== ts.SyntaxKind.AsteriskToken && op !== ts.SyntaxKind.SlashToken) return null
  const left = linearFromExpression(expression.left, domainPaths)
  const right = linearFromExpression(expression.right, domainPaths)
  if (left == null || right == null) return null
  const leftConstant = constantOnlyValue(left)
  const rightConstant = constantOnlyValue(right)
  if (leftConstant != null && rightConstant != null) {
    const folded = foldArithmetic(op, leftConstant, rightConstant)
    return folded == null ? null : linearConstant(folded)
  }
  return linearVariable(canonicalArithmeticText(expression))
}

function constantOnlyValue(linear: LinearExpr): number | null {
  if (linear.terms.size > 0) return null
  return rationalToExactNumber(linear.constant)
}

function foldArithmetic(op: ts.SyntaxKind, left: number, right: number): number | null {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return left + right
    case ts.SyntaxKind.MinusToken:
      return left - right
    case ts.SyntaxKind.AsteriskToken:
      return left * right
    case ts.SyntaxKind.SlashToken:
      return right === 0 ? null : left / right
    default:
      return null
  }
}

// One real-arithmetic step over the named doubles: the outermost + - * /
// lowers algebraically, while its operands stay opaque atoms (or constants).
// The single rounding this ignores is the caller's to discharge — rounding is
// monotone, so `real(L) <= real(R)` carries `fl(L) <= fl(R)` for one op per
// side. Expanding deeper would stack roundings nobody discharges.
export function linearFromTopOperation(text: FitExpressionLike): LinearExpr | null {
  const parsed = parseFitExpressionOrNull(text)
  if (parsed == null) return null
  const expression = unwrapExpression(parsed.expression)
  if (!ts.isBinaryExpression(expression)) return null
  const op = expression.operatorToken.kind
  const left = operandLinear(expression.left)
  const right = operandLinear(expression.right)
  if (left == null || right == null) return null
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return linearAdd(left, right)
    case ts.SyntaxKind.MinusToken:
      return linearSubtract(left, right)
    case ts.SyntaxKind.AsteriskToken: {
      const leftConstant = constantOnlyValue(left)
      const rightConstant = constantOnlyValue(right)
      if (leftConstant != null) return linearScale(right, leftConstant)
      if (rightConstant != null) return linearScale(left, rightConstant)
      return null
    }
    case ts.SyntaxKind.SlashToken: {
      const rightConstant = constantOnlyValue(right)
      return rightConstant == null || rightConstant === 0 ? null : linearDivide(left, rightConstant)
    }
    default:
      return null
  }
}

function operandLinear(expression: ts.Expression): LinearExpr | null {
  const current = unwrapExpression(expression)
  if (ts.isNumericLiteral(current)) return linearConstant(Number(current.text))
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(current.operand)) {
    return linearConstant(-Number(current.operand.text))
  }
  return linearVariable(canonicalArithmeticText(current))
}

// One stable name per computation: parenthesized and spaced like the
// evaluator's result expressions, so a claim restating a computation reaches
// the same atom. Operand order stays as written; commutative matching lives
// in expressionKey.
function canonicalArithmeticText(expression: ts.Expression): string {
  const current = unwrapExpression(expression)
  if (ts.isBinaryExpression(current)) {
    const opText = current.operatorToken.getText()
    return `(${canonicalArithmeticText(current.left)} ${opText} ${canonicalArithmeticText(current.right)})`
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    return `-${canonicalArithmeticText(current.operand)}`
  }
  return current.getText()
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
    const parsed = fitExpressionParsed(text)
    return expressionKeyWithDomainPaths(parsed.expression, parsed.domainPaths)
  } catch {
    return `text:${fitExpressionText(text)}`
  }
}

export function expressionKeyWithDomainPaths(expression: ts.Expression, domainPaths: ReadonlyMap<string, FitDomainPath>): string {
  const domainPath = fitDomainPathFromExpression(expression, domainPaths)
  if (domainPath != null) return `path:${fitDomainPathKey(domainPath)}`
  return domainPaths.size === 0 ? expressionKey(expression) : structuralExpressionKey(unwrapExpression(expression), domainPaths)
}

export function expressionKey(expression: ts.Expression): string {
  const current = unwrapExpression(expression)
  if (containsElementAccess(current)) return structuralExpressionKey(current)
  const linear = linearFromExpression(current)
  if (linear != null) return `linear:${linearKey(linear)}`
  return structuralExpressionKey(current)
}

function structuralExpressionKey(current: ts.Expression, domainPaths: ReadonlyMap<string, FitDomainPath> = new Map()): string {
  if (ts.isIdentifier(current)) {
    const domainPath = domainPaths.get(current.text)
    return domainPath == null ? `id:${current.text}` : `path:${fitDomainPathKey(domainPath)}`
  }
  if (ts.isNumericLiteral(current)) return `number:${Number(current.text)}`
  if (ts.isStringLiteralLike(current)) return `string:${JSON.stringify(current.text)}`
  if (ts.isBigIntLiteral(current)) return `bigint:${current.text}`
  if (current.kind === ts.SyntaxKind.TrueKeyword) return 'boolean:true'
  if (current.kind === ts.SyntaxKind.FalseKeyword) return 'boolean:false'
  if (current.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isPropertyAccessExpression(current)) {
    return `prop:${structuralExpressionKey(unwrapExpression(current.expression), domainPaths)}.${current.name.text}`
  }
  if (ts.isElementAccessExpression(current)) {
    return `element:${structuralExpressionKey(unwrapExpression(current.expression), domainPaths)}[${structuralExpressionKey(unwrapExpression(current.argumentExpression), domainPaths)}]`
  }
  if (ts.isCallExpression(current)) {
    return `call:${structuralExpressionKey(unwrapExpression(current.expression), domainPaths)}(${current.arguments.map(argument => structuralExpressionKey(unwrapExpression(argument), domainPaths)).join(',')})`
  }
  if (ts.isPrefixUnaryExpression(current)) {
    return `prefix:${current.operator}:${structuralExpressionKey(unwrapExpression(current.operand), domainPaths)}`
  }
  if (ts.isTypeOfExpression(current) || ts.isVoidExpression(current) || ts.isDeleteExpression(current) || ts.isAwaitExpression(current)) {
    return `unary:${current.kind}:${structuralExpressionKey(unwrapExpression(current.expression), domainPaths)}`
  }
  if (ts.isPostfixUnaryExpression(current)) {
    return `postfix:${current.operator}:${structuralExpressionKey(unwrapExpression(current.operand), domainPaths)}`
  }
  if (ts.isConditionalExpression(current)) {
    return `conditional:${structuralExpressionKey(unwrapExpression(current.condition), domainPaths)}?${structuralExpressionKey(unwrapExpression(current.whenTrue), domainPaths)}:${structuralExpressionKey(unwrapExpression(current.whenFalse), domainPaths)}`
  }
  if (ts.isTemplateExpression(current)) {
    const spans = current.templateSpans.map(span =>
      `${structuralExpressionKey(unwrapExpression(span.expression), domainPaths)}:${JSON.stringify(span.literal.text)}`)
    return `template:${JSON.stringify(current.head.text)}:${spans.join(':')}`
  }
  if (ts.isBinaryExpression(current)) {
    const op = current.operatorToken.kind
    // + and * may swap their two operands (IEEE commutativity is bitwise) but
    // never regroup across nesting: a different association rounds
    // differently.
    if (op === ts.SyntaxKind.AsteriskToken || op === ts.SyntaxKind.PlusToken) {
      const operands = [
        structuralExpressionKey(unwrapExpression(current.left), domainPaths),
        structuralExpressionKey(unwrapExpression(current.right), domainPaths),
      ].sort()
      return `${op === ts.SyntaxKind.AsteriskToken ? 'product' : 'sum'}:${operands.join(op === ts.SyntaxKind.AsteriskToken ? '*' : '+')}`
    }
    return `binary:${ts.SyntaxKind[op]}:${structuralExpressionKey(unwrapExpression(current.left), domainPaths)}:${structuralExpressionKey(unwrapExpression(current.right), domainPaths)}`
  }
  return `syntax:${syntaxChildrenKey(current, domainPaths)}`
}

function syntaxChildrenKey(node: ts.Node, domainPaths: ReadonlyMap<string, FitDomainPath>): string {
  const children = node.getChildren()
  if (children.length === 0) return `token:${node.kind}`
  return `${node.kind}(${children.map(child =>
    ts.isExpression(child)
      ? structuralExpressionKey(unwrapExpression(child), domainPaths)
      : syntaxChildrenKey(child, domainPaths)).join(',')})`
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
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) current = current.expression
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

// One multiplication's two factors. Flattening nested products would let a
// rule cancel a factor across a regrouping the runtime never performed —
// float multiplication is commutative but not associative.
export function productFactors(text: FitExpressionLike): string[] | null {
  const parsed = parseFitExpressionOrNull(text)
  if (parsed == null) return null
  const expression = unwrapExpression(parsed.expression)
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return null
  return [publicParsedExpressionText(parsed, expression.left), publicParsedExpressionText(parsed, expression.right)]
}

function parseFitExpressionOrNull(text: FitExpressionLike): ParsedFitExpression | null {
  try {
    return fitExpressionParsed(text)
  } catch {
    return null
  }
}

export function productText(factors: string[]) {
  if (factors.length === 0) return '1'
  if (factors.length === 1) return factors[0]!
  return factors.map(factor => `(${factor})`).join(' * ')
}
