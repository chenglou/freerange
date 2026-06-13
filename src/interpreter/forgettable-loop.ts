import * as ts from 'typescript'
import {
  unknown,
  unknownArrayLength,
  unknownNumber,
  unknownObject,
  type Value,
} from '../domain.ts'
import {expressionRootName, expressionRootNames} from '../source-expressions.ts'
import {isAssignmentOperator, unwrapExpression} from './source-syntax.ts'
import {replaceRootValueEverywhere} from './value-path.ts'

export function isForgettableForStatement(statement: ts.ForStatement) {
  const indexName = forgettableForIndexName(statement.initializer)
  return indexName != null
    && statement.condition != null
    && statement.incrementor != null
    && isForgettableReadExpression(statement.condition)
    && incrementorOnlyTouchesIndex(statement.incrementor, indexName)
}

export function isForgettableReadExpression(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword) return true
  if (ts.isNumericLiteral(current) || ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return true
  if (current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword || current.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isTemplateExpression(current)) return current.templateSpans.every(span => isForgettableReadExpression(span.expression))
  if (ts.isPropertyAccessExpression(current)) return isForgettableReadExpression(current.expression)
  if (ts.isElementAccessExpression(current)) return isForgettableReadExpression(current.expression)
    && (current.argumentExpression == null || isForgettableReadExpression(current.argumentExpression))
  if (ts.isPrefixUnaryExpression(current)) {
    return current.operator !== ts.SyntaxKind.PlusPlusToken
      && current.operator !== ts.SyntaxKind.MinusMinusToken
      && isForgettableReadExpression(current.operand)
  }
  if (ts.isPostfixUnaryExpression(current)) return false
  if (ts.isBinaryExpression(current)) return !isAssignmentOperator(current.operatorToken.kind)
    && isForgettableReadExpression(current.left)
    && isForgettableReadExpression(current.right)
  if (ts.isConditionalExpression(current)) return isForgettableReadExpression(current.condition)
    && isForgettableReadExpression(current.whenTrue)
    && isForgettableReadExpression(current.whenFalse)
  if (ts.isCallExpression(current)) return isKnownPureReadCall(current)
  if (ts.isObjectLiteralExpression(current)) return current.properties.every(property => {
    if (ts.isSpreadAssignment(property)) return isForgettableReadExpression(property.expression)
    if (ts.isShorthandPropertyAssignment(property)) return true
    return ts.isPropertyAssignment(property) && isForgettableReadExpression(property.initializer)
  })
  if (ts.isArrayLiteralExpression(current)) return current.elements.every(element => ts.isSpreadElement(element)
    ? isForgettableReadExpression(element.expression)
    : isForgettableReadExpression(element))
  return false
}

export function forgettableMutationRoots(statement: ts.Statement, env: Map<string, Value>): string[] | null {
  if (ts.isBlock(statement)) {
    const roots: string[] = []
    for (const child of statement.statements) {
      const childRoots = forgettableMutationRoots(child, env)
      if (childRoots == null) return null
      roots.push(...childRoots)
    }
    return [...new Set(roots)]
  }
  if (ts.isIfStatement(statement) && statement.elseStatement == null && isForgettableReadExpression(statement.expression)) {
    return forgettableMutationRoots(statement.thenStatement, env)
  }
  if (!ts.isExpressionStatement(statement)) return null

  const expression = unwrapExpression(statement.expression)
  if ((ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression))
    && (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isIdentifier(expression.operand)) return knownMutationRoots([expression.operand.text], env)
  if (ts.isCallExpression(expression)) {
    const roots = forgettableCallMutationRoots(expression, env)
    return roots == null ? null : knownMutationRoots(roots, env)
  }
  if (!ts.isBinaryExpression(expression)) return null
  const root = assignmentRootName(expression.left)
  if (root == null || !isForgettableReadExpression(expression.right)) return null
  if (!isForgettableAssignmentOperator(expression.operatorToken.kind)) return null
  return knownMutationRoots(mutationTargetRoots(expression.left, env), env)
}

export function forgetRoots(env: Map<string, Value>, roots: string[]) {
  for (const root of roots) forgetRoot(env, root)
}

function forgettableForIndexName(initializer: ts.ForInitializer | undefined): string | null {
  if (initializer == null || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return null
  const declaration = initializer.declarations[0]!
  if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) return null
  return isForgettableReadExpression(declaration.initializer) ? declaration.name.text : null
}

function incrementorOnlyTouchesIndex(expression: ts.Expression, indexName: string): boolean {
  const current = unwrapExpression(expression)
  if (ts.isPostfixUnaryExpression(current) || ts.isPrefixUnaryExpression(current)) {
    return (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isIdentifier(current.operand)
      && current.operand.text === indexName
  }
  if (!ts.isBinaryExpression(current) || !ts.isIdentifier(current.left) || current.left.text !== indexName) return false
  if (current.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || current.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) {
    return isForgettableReadExpression(current.right)
  }
  return current.operatorToken.kind === ts.SyntaxKind.EqualsToken && isForgettableReadExpression(current.right)
}

function forgettableCallMutationRoots(expression: ts.CallExpression, env: Map<string, Value>): string[] | null {
  if (!expression.arguments.every(isForgettableReadExpression)) return null
  const target = unwrapExpression(expression.expression)
  if (!ts.isPropertyAccessExpression(target)) return null
  const roots = mutationTargetRoots(target.expression, env)
  if (roots.length === 0) return null
  for (const argument of expression.arguments) roots.push(...expressionRootNames(argument, []))
  return [...new Set(roots)]
}

function assignmentRootName(expression: ts.Expression): string | null {
  return expressionRootName(expression) ?? mutationTargetRoot(expression)
}

function mutationTargetRoot(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression)
  if (ts.isElementAccessExpression(current)) return expressionRootName(current.expression) ?? mutationTargetRoot(current.expression)
  if (ts.isPropertyAccessExpression(current)) return expressionRootName(current.expression) ?? mutationTargetRoot(current.expression)
  return null
}

function mutationTargetRoots(expression: ts.Expression, env: Map<string, Value>): string[] {
  const root = expressionRootName(expression) ?? mutationTargetRoot(expression)
  if (root == null) return []
  const roots = [root]
  const alias = referenceRootName(env.get(root))
  if (alias != null && alias !== root) roots.push(alias)
  return [...new Set(roots)]
}

function knownMutationRoots(roots: string[], env: Map<string, Value>): string[] | null {
  return roots.length > 0 && roots.every(root => env.has(root)) ? roots : null
}

function referenceRootName(value: Value | undefined): string | null {
  if (value == null || (value.kind !== 'object' && value.kind !== 'array')) return null
  if (value.expr == null) return null
  return /^(?:this|[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)/u.exec(value.expr)?.[0] ?? null
}

export function forgetRoot(env: Map<string, Value>, root: string) {
  const current = env.get(root)
  if (current?.kind === 'array') {
    replaceRootValueEverywhere(env, root, {...current, length: unknownArrayLength(current.expr ?? root), elements: null, element: null, summary: null})
  } else if (current?.kind === 'object') {
    replaceRootValueEverywhere(env, root, unknownObject(root))
  } else if (current?.kind === 'number') {
    env.set(root, unknownNumber(root))
  } else {
    env.set(root, unknown(`Unsupported mutation changed ${root}`))
  }
  forgetSymbolicReferences(env, root)
}

// A regex matching the root as a standalone identifier inside an expression
// text, so a path or computation reading through it is recognized: `box`,
// `box.v`, and `Math.min(box, y)` all match `box`, but `boxes` and `mybox` do
// not. Build once per root and reuse across a forget, not once per lookup.
export function rootMentionPattern(root: string): RegExp {
  return new RegExp(`(?<![\\p{ID_Continue}$])${root}(?![\\p{ID_Continue}$])`, 'u')
}

// A value read before a mutation keeps the mutated path's symbolic identity:
// `const a = box.v` stays both linearly and by expression text `box.v`. Once
// `box` is forgotten that identity is stale — a later read of `box.v` is a
// different value — so the snapshot must not still prove `a == box.v` (by text)
// or `a - box.v == 0` (by linear form). Drop the symbolic identity from any
// other value naming a path under the root, keeping its proven numeric range.
function forgetSymbolicReferences(env: Map<string, Value>, root: string) {
  const mentionsRoot = rootMentionPattern(root)
  for (const [name, value] of env) {
    if (name === root || value.kind !== 'number') continue
    let linearStale = false
    if (value.linear != null) {
      for (const term of value.linear.terms.keys()) {
        if (mentionsRoot.test(term)) {
          linearStale = true
          break
        }
      }
    }
    const exprStale = value.expr != null && mentionsRoot.test(value.expr)
    if (linearStale || exprStale) env.set(name, {...value, linear: null, expr: null})
  }
}

// Any assignment whose target root is known and whose right side is a pure read
// is coverable by forgetting the target root, regardless of the operator.
function isForgettableAssignmentOperator(kind: ts.SyntaxKind) {
  return isAssignmentOperator(kind)
}

function isKnownPureReadCall(expression: ts.CallExpression): boolean {
  if (!expression.arguments.every(isForgettableReadExpression)) return false
  const target = unwrapExpression(expression.expression)
  if (ts.isIdentifier(target)) return true
  if (!ts.isPropertyAccessExpression(target)) return false
  if (ts.isIdentifier(target.expression) && target.expression.text === 'Math') return true
  return target.name.text === 'at' && isForgettableReadExpression(target.expression)
}

