import * as ts from 'typescript'

export function expressionRootNames(expression: ts.Expression, ignored: string[]): string[] {
  if (ts.isIdentifier(expression)) return ignored.includes(expression.text) ? [] : [expression.text]
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ignored.includes('this') ? [] : ['this']
  if (ts.isPropertyAccessExpression(expression)) return expressionRootNames(expression.expression, ignored)
  if (ts.isElementAccessExpression(expression)) {
    const roots = expressionRootNames(expression.expression, ignored)
    roots.push(...expressionRootNames(expression.argumentExpression, ignored))
    return roots
  }
  if (ts.isCallExpression(expression)) {
    const roots = expressionRootNames(expression.expression, ignored)
    for (const argument of expression.arguments) roots.push(...expressionRootNames(argument, ignored))
    return roots
  }

  const roots: string[] = []
  for (const child of expression.getChildren()) {
    if (ts.isExpression(child)) roots.push(...expressionRootNames(child, ignored))
  }
  return roots
}

export function expressionMentionsArrayParam(expression: ts.Expression, name: string): boolean {
  const lengthRoot = arrayLengthRoot(expression)
  if (lengthRoot === name) return true
  if (ts.isElementAccessExpression(expression) && expressionRootName(expression.expression) === name) return true

  for (const child of expression.getChildren()) {
    if (ts.isExpression(child) && expressionMentionsArrayParam(child, name)) return true
  }
  return false
}

export function expressionMentionsObjectParam(expression: ts.Expression, name: string): boolean {
  if (ts.isPropertyAccessExpression(expression) && expressionRootNameDeep(expression.expression) === name) return true

  for (const child of expression.getChildren()) {
    if (ts.isExpression(child) && expressionMentionsObjectParam(child, name)) return true
  }
  return false
}

export function arrayLengthRoot(expression: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(expression)) return null
  if (expression.name.text !== 'length') return null
  return expressionRootName(expression.expression)
}

export function expressionRootName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isParenthesizedExpression(expression)) return expressionRootName(expression.expression)
  return null
}

export function expressionRootNameDeep(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isParenthesizedExpression(expression)) return expressionRootNameDeep(expression.expression)
  if (ts.isPropertyAccessExpression(expression)) return expressionRootNameDeep(expression.expression)
  return null
}
