import * as ts from 'typescript'

export function expressionRootNames(expression: ts.Expression, ignored: string[]): string[] {
  if (ts.isIdentifier(expression)) return ignored.includes(expression.text) ? [] : [expression.text]
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ignored.includes('this') ? [] : ['this']
  if (ts.isObjectLiteralExpression(expression)) {
    const roots: string[] = []
    for (const property of expression.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        roots.push(...expressionRootNames(property.name, ignored))
      } else if (ts.isPropertyAssignment(property)) {
        roots.push(...expressionRootNames(property.initializer, ignored))
      } else if (ts.isSpreadAssignment(property)) {
        roots.push(...expressionRootNames(property.expression, ignored))
      }
    }
    return roots
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const roots: string[] = []
    for (const element of expression.elements) {
      if (ts.isOmittedExpression(element)) continue
      roots.push(...expressionRootNames(ts.isSpreadElement(element) ? element.expression : element, ignored))
    }
    return roots
  }
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
