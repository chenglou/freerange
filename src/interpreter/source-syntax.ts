import * as ts from 'typescript'
import {numericLiteralValue} from '../linear.ts'
import {isFunctionImplementation} from '../function-shape.ts'

export type IndexedForLoopShape = {
  indexName: string
  source: IndexedForLoopSource
}

export type IndexedForLoopSource =
  | {kind: 'limit'; expression: ts.Expression}
  | {kind: 'array'; expression: ts.Expression; lengthExpression: ts.Expression}

export function indexedForLoopShape(statement: ts.ForStatement): IndexedForLoopShape | null {
  if (statement.initializer == null || !ts.isVariableDeclarationList(statement.initializer)) return null
  if (statement.initializer.declarations.length !== 1) return null
  const declaration = statement.initializer.declarations[0]
  if (declaration == null || !ts.isIdentifier(declaration.name) || declaration.initializer == null) return null
  if (numericLiteralValue(declaration.initializer) !== 0) return null
  const indexName = declaration.name.text
  if (statement.condition == null || statement.incrementor == null) return null
  const condition = unwrapExpression(statement.condition)
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null
  if (!isIdentifierNamed(condition.left, indexName)) return null
  if (!indexedLoopIncrements(statement.incrementor, indexName)) return null
  return {indexName, source: indexedForLoopSource(condition.right)}
}

// One signed addend of a scalar update. `{constant}` covers the implicit 1 of `++`/`--`.
export type ScalarUpdateTerm =
  | {expression: ts.Expression; negate: boolean}
  | {constant: number}

export type ScalarUpdate = {
  targetName: string
  terms: ScalarUpdateTerm[]
  operation:
    | {kind: 'increment'; amount: number}
    | {kind: 'compound'; op: '+' | '-'; expression: ts.Expression}
    | {kind: 'assignment'; expression: ts.Expression}
}

// Recognizes every expression whose effect is "add a target-free amount to a scalar local":
// `x += e`, `x -= e`, `x++`, `--x`, and `x = <sum>` where the sum mentions x exactly once,
// positively, at the top level of a +/- chain (`x = a + x - b` included). The target may not
// appear inside any other addend; updates that scale or replace the target are not additions.
export function scalarUpdateFromExpression(expression: ts.Expression): ScalarUpdate | null {
  const current = unwrapExpression(expression)
  if (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) {
    if (current.operator !== ts.SyntaxKind.PlusPlusToken && current.operator !== ts.SyntaxKind.MinusMinusToken) return null
    const targetName = identifierTargetName(current.operand)
    if (targetName == null) return null
    const amount = current.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1
    return {targetName, terms: [{constant: amount}], operation: {kind: 'increment', amount}}
  }
  if (!ts.isBinaryExpression(current)) return null
  const targetName = identifierTargetName(current.left)
  if (targetName == null) return null
  switch (current.operatorToken.kind) {
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken: {
      if (referencesIdentifier(current.right, targetName)) return null
      const negate = current.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken
      return {
        targetName,
        terms: [{expression: current.right, negate}],
        operation: {kind: 'compound', op: negate ? '-' : '+', expression: current.right},
      }
    }
    case ts.SyntaxKind.EqualsToken: {
      const leaves: {expression: ts.Expression; negate: boolean}[] = []
      flattenSignedSum(current.right, false, leaves)
      const targetLeaves = leaves.filter(leaf => isIdentifierNamed(leaf.expression, targetName))
      if (targetLeaves.length !== 1 || targetLeaves[0]!.negate) return null
      const terms = leaves.filter(leaf => leaf !== targetLeaves[0])
      if (terms.some(term => referencesIdentifier(term.expression, targetName))) return null
      return {targetName, terms, operation: {kind: 'assignment', expression: current.right}}
    }
    default:
      return null
  }
}

export function flattenSignedSum(expression: ts.Expression, negate: boolean, out: {expression: ts.Expression; negate: boolean}[]) {
  const current = unwrapExpression(expression)
  if (ts.isBinaryExpression(current)
    && (current.operatorToken.kind === ts.SyntaxKind.PlusToken || current.operatorToken.kind === ts.SyntaxKind.MinusToken)) {
    flattenSignedSum(current.left, negate, out)
    flattenSignedSum(current.right, current.operatorToken.kind === ts.SyntaxKind.MinusToken ? !negate : negate, out)
    return
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    flattenSignedSum(current.operand, !negate, out)
    return
  }
  out.push({expression: current, negate})
}

export function identifierTargetName(expression: ts.Expression): string | null {
  const target = unwrapExpression(expression)
  return ts.isIdentifier(target) ? target.text : null
}

export function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const target = unwrapExpression(expression)
  return ts.isIdentifier(target) && target.text === name
}

export function referencesIdentifier(node: ts.Node, name: string): boolean {
  let found = false
  const visit = (current: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(current) && current.text === name) {
      found = true
      return
    }
    if (current !== node && isFunctionImplementation(current)) return
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

export function isPushCallExpression(expression: ts.Expression): expression is ts.CallExpression & {expression: ts.PropertyAccessExpression} {
  return ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'push'
}

export function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isNonNullExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) return unwrapExpression(expression.expression)
  return expression
}


// All assignment operators, by TypeScript's own enumeration: =, the arithmetic/bitwise
// compounds, and the logical compounds (&&=, ||=, ??=).
export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

// The binary operator a compound assignment desugars to: `a op= b` writes `a op b`.
// Logical compounds assign conditionally, so they map to 'conditional' and callers
// must join the old and new values instead of computing one result.
export function compoundAssignmentOperator(kind: ts.SyntaxKind): ts.SyntaxKind | 'conditional' | null {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken:
      return ts.SyntaxKind.PlusToken
    case ts.SyntaxKind.MinusEqualsToken:
      return ts.SyntaxKind.MinusToken
    case ts.SyntaxKind.AsteriskEqualsToken:
      return ts.SyntaxKind.AsteriskToken
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
      return ts.SyntaxKind.AsteriskAsteriskToken
    case ts.SyntaxKind.SlashEqualsToken:
      return ts.SyntaxKind.SlashToken
    case ts.SyntaxKind.PercentEqualsToken:
      return ts.SyntaxKind.PercentToken
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
      return ts.SyntaxKind.LessThanLessThanToken
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanToken
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
    case ts.SyntaxKind.AmpersandEqualsToken:
      return ts.SyntaxKind.AmpersandToken
    case ts.SyntaxKind.BarEqualsToken:
      return ts.SyntaxKind.BarToken
    case ts.SyntaxKind.CaretEqualsToken:
      return ts.SyntaxKind.CaretToken
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return 'conditional'
    default:
      return null
  }
}

function indexedForLoopSource(expression: ts.Expression): IndexedForLoopSource {
  const current = unwrapExpression(expression)
  return ts.isPropertyAccessExpression(current) && current.name.text === 'length'
    ? {kind: 'array', expression: current.expression, lengthExpression: current}
    : {kind: 'limit', expression}
}

// Accepts every spelling whose effect is "add exactly 1 to the index":
// i++, ++i, i += 1, i = i + 1, i = 1 + i, ...
function indexedLoopIncrements(expression: ts.Expression, indexName: string): boolean {
  const update = scalarUpdateFromExpression(expression)
  if (update == null || update.targetName !== indexName) return false
  return scalarUpdateLiteralTotal(update) === 1
}

function scalarUpdateLiteralTotal(update: ScalarUpdate): number | null {
  let total = 0
  for (const term of update.terms) {
    if ('constant' in term) {
      total += term.constant
      continue
    }
    const literal = numericLiteralValue(term.expression)
    if (literal == null) return null
    total += term.negate ? -literal : literal
  }
  return total
}
