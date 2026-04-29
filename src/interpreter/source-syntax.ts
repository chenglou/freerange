import * as ts from 'typescript'
import {numericLiteralValue} from '../linear.ts'

export type IndexedForLoopShape = {
  indexName: string
  source: IndexedForLoopSource
}

export type IndexedForLoopSource =
  | {kind: 'limit'; expression: ts.Expression}
  | {kind: 'array'; expression: ts.Expression; lengthExpression: ts.Expression}

export type CursorPath = {
  path: string[]
  targetName: string
}

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

export function expressionIndexPaths(expression: ts.Expression | undefined, indexName: string, path: string[] = []): string[][] {
  if (expression == null) return []
  const unwrapped = unwrapExpression(expression)
  if (isIdentifierNamed(unwrapped, indexName)) return [path]
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const paths: string[][] = []
    for (const property of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text === indexName) paths.push([...path, property.name.text])
        continue
      }
      if (!ts.isPropertyAssignment(property)) continue
      const name = propertyNameText(property.name)
      if (name == null) continue
      paths.push(...expressionIndexPaths(property.initializer, indexName, [...path, name]))
    }
    return paths
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap(element => ts.isSpreadElement(element)
      ? expressionIndexPaths(element.expression, indexName, [...path, '[]'])
      : expressionIndexPaths(element, indexName, [...path, '[]']))
  }
  return []
}

export function expressionCursorPaths(expression: ts.Expression | undefined, path: string[] = []): CursorPath[] {
  if (expression == null) return []
  const unwrapped = unwrapExpression(expression)
  if (ts.isIdentifier(unwrapped)) return [{path, targetName: unwrapped.text}]
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const paths: CursorPath[] = []
    for (const property of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        paths.push({path: [...path, property.name.text], targetName: property.name.text})
        continue
      }
      if (!ts.isPropertyAssignment(property)) continue
      const name = propertyNameText(property.name)
      if (name == null) continue
      paths.push(...expressionCursorPaths(property.initializer, [...path, name]))
    }
    return paths
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap(element => ts.isSpreadElement(element)
      ? expressionCursorPaths(element.expression, [...path, '[]'])
      : expressionCursorPaths(element, [...path, '[]']))
  }
  return []
}

export function scalarIncrementExpression(expression: ts.BinaryExpression, targetName: string): ts.Expression | null {
  if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) return expression.right
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const right = unwrapExpression(expression.right)
  if (!ts.isBinaryExpression(right) || right.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
  if (isIdentifierNamed(right.left, targetName)) return right.right
  if (isIdentifierNamed(right.right, targetName)) return right.left
  return null
}

export function identifierTargetName(expression: ts.Expression): string | null {
  const target = unwrapExpression(expression)
  return ts.isIdentifier(target) ? target.text : null
}

export function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const target = unwrapExpression(expression)
  return ts.isIdentifier(target) && target.text === name
}

export function referencesAnyIdentifier(expression: ts.Expression, names: Set<string>): boolean {
  for (const name of names) {
    if (referencesIdentifier(expression, name)) return true
  }
  return false
}

export function referencesIdentifier(node: ts.Node, name: string): boolean {
  let found = false
  const visit = (current: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(current) && current.text === name) {
      found = true
      return
    }
    if (current !== node && isFunctionLikeWithBody(current)) return
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

export function isSideEffectFreeExpression(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return true
  if (ts.isPropertyAccessExpression(current)) return isSideEffectFreeExpression(current.expression)
  if (ts.isElementAccessExpression(current)) return current.argumentExpression != null
    && isSideEffectFreeExpression(current.expression)
    && isSideEffectFreeExpression(current.argumentExpression)
  if (ts.isNumericLiteral(current) || ts.isStringLiteral(current) || current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isPrefixUnaryExpression(current)) return isSideEffectFreeExpression(current.operand)
  if (ts.isBinaryExpression(current)) return !isAssignmentOperator(current.operatorToken.kind)
    && isSideEffectFreeExpression(current.left)
    && isSideEffectFreeExpression(current.right)
  if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) return isSideEffectFreeExpression(current.expression)
  return false
}

export function symbolicForOfBranchSupported(statement: ts.Statement): boolean {
  if (ts.isBlock(statement)) return statement.statements.every(symbolicForOfBranchSupported)
  if (ts.isVariableStatement(statement)) return true
  if (ts.isExpressionStatement(statement)) return isPushCallExpression(statement.expression)
  if (ts.isIfStatement(statement)) {
    return symbolicForOfBranchSupported(statement.thenStatement)
      && (statement.elseStatement == null || symbolicForOfBranchSupported(statement.elseStatement))
  }
  return false
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

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsToken || kind === ts.SyntaxKind.PlusEqualsToken
}

function indexedForLoopSource(expression: ts.Expression): IndexedForLoopSource {
  const current = unwrapExpression(expression)
  return ts.isPropertyAccessExpression(current) && current.name.text === 'length'
    ? {kind: 'array', expression: current.expression, lengthExpression: current}
    : {kind: 'limit', expression}
}

function indexedLoopIncrements(expression: ts.Expression, indexName: string): boolean {
  const current = unwrapExpression(expression)
  if ((ts.isPostfixUnaryExpression(current) || ts.isPrefixUnaryExpression(current))
    && current.operator === ts.SyntaxKind.PlusPlusToken
    && ts.isIdentifier(current.operand)
    && current.operand.text === indexName) return true
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken) return false
  return isIdentifierNamed(current.left, indexName) && numericLiteralValue(current.right) === 1
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node))
    && node.body != null
}
