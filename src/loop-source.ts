import * as ts from 'typescript'
import {
  runningExtremumNumber,
  unknownNumber,
  type NumberValue,
  type Value,
} from './domain.ts'
import {
  linearAdd,
  numericLiteralValue,
  sameLinear,
  unwrapExpression,
} from './linear.ts'
import {
  type GuardedLoopPush,
  type LoopExtremum,
  type LoopPush,
  type SegmentedStackPush,
} from './loop-summary.ts'

export type LoopSourceContext = {
  env: Map<string, Value>
  sourceFile: ts.SourceFile
  evaluateExpression: (expression: ts.Expression, env: Map<string, Value>) => Value
  bindVariableStatement: (statement: ts.VariableStatement, env: Map<string, Value>) => void
  isSideEffectFreeExpression: (expression: ts.Expression) => boolean
}

export type LoopScalarAdd = {
  targetName: string
  increment: NumberValue
}

export type IndexedLoopShape = {
  indexName: string
  sourceExpression: ts.Expression
  sourceKind: 'array' | 'limit'
}

export function readLoopPush(expression: ts.CallExpression, context: LoopSourceContext): Omit<LoopPush, 'arrayName' | 'length'> {
  const row = expression.arguments[0]
  if (row == null) return {element: null, topName: null, height: null, cursorPaths: []}
  if (!ts.isObjectLiteralExpression(row)) {
    return {
      element: context.evaluateExpression(row, context.env),
      topName: null,
      height: null,
      cursorPaths: ts.isIdentifier(row) ? [{path: [], targetName: row.text}] : [],
    }
  }
  const topExpression = objectPropertyExpression(row, 'top')
  const heightExpression = objectPropertyExpression(row, 'height')
  const topName = topExpression != null && ts.isIdentifier(topExpression) ? topExpression.text : null
  const height = heightExpression == null ? null : context.evaluateExpression(heightExpression, context.env)
  return {element: context.evaluateExpression(row, context.env), topName, height: height?.kind === 'number' ? height : null, cursorPaths: objectIdentifierPropertyPaths(row)}
}

export function readGuardedLoopPushes(
  statement: ts.Statement,
  context: LoopSourceContext,
  length: NumberValue,
  resettableExtrema: Map<string, LoopExtremum>,
): GuardedLoopPush[] | null {
  if (!ts.isIfStatement(statement) || statement.elseStatement != null || !context.isSideEffectFreeExpression(statement.expression)) return null
  const children = ts.isBlock(statement.thenStatement) ? [...statement.thenStatement.statements] : [statement.thenStatement]
  const guardContext: LoopSourceContext = {...context, env: new Map(context.env)}
  const localInitializers = new Map<string, ts.Expression>()
  const identifierAliases = new Map<string, string>()
  const pushes: GuardedLoopPush[] = []
  for (const child of children) {
    if (ts.isVariableStatement(child)) {
      context.bindVariableStatement(child, guardContext.env)
      for (const declaration of child.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) continue
        localInitializers.set(declaration.name.text, declaration.initializer)
        if (ts.isIdentifier(declaration.initializer)) identifierAliases.set(declaration.name.text, declaration.initializer.text)
      }
      continue
    }

    const push = pushCallFromStatement(child)
    if (push != null) {
      const targetName = push.expression.expression.text
      const target = context.env.get(targetName)
      if (target == null || target.kind !== 'array') return null
      pushes.push({...readLoopPush(push, guardContext), arrayName: targetName, length, segmentedStack: null})
      continue
    }
    const stackAdvance = pushes.length === 1 ? readSegmentedStackAdvance(child, pushes[0]!, guardContext, localInitializers, identifierAliases) : null
    if (stackAdvance != null) {
      pushes[0] = {...pushes[0]!, segmentedStack: stackAdvance}
      continue
    }
    if (isResettableScalarAssignment(child, guardContext, resettableExtrema, length)) continue
    return null
  }
  return pushes.length === 0 ? null : pushes
}

export function readConditionalLoopAdd(statement: ts.Statement, context: LoopSourceContext): LoopScalarAdd | null {
  if (!ts.isIfStatement(statement) || statement.elseStatement != null) return null
  return readLoopScalarAdd(statement.thenStatement, context)
}

export function readLoopScalarAdd(statement: ts.Statement, context: LoopSourceContext): LoopScalarAdd | null {
  const add = scalarAddFromStatement(statement)
  if (add == null) return null
  const increment = context.evaluateExpression(add.incrementExpression, context.env)
  if (increment.kind !== 'number') return null
  return {targetName: add.targetName, increment}
}

export function readLoopExtremumAssignment(statement: ts.Statement, context: LoopSourceContext): LoopExtremum | null {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return null
  const assignment = statement.expression
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.left)) return null
  if (!ts.isCallExpression(assignment.right) || !ts.isPropertyAccessExpression(assignment.right.expression)) return null

  const callTarget = assignment.right.expression
  if (!ts.isIdentifier(callTarget.expression) || callTarget.expression.text !== 'Math') return null
  if (callTarget.name.text !== 'min' && callTarget.name.text !== 'max') return null
  if (assignment.right.arguments.length !== 2) return null

  const targetName = assignment.left.text
  const left = assignment.right.arguments[0]!
  const right = assignment.right.arguments[1]!
  const candidateExpression =
    ts.isIdentifier(left) && left.text === targetName ? right
      : ts.isIdentifier(right) && right.text === targetName ? left
        : null
  if (candidateExpression == null) return null

  const candidateValue = context.evaluateExpression(candidateExpression, context.env)
  const candidate = candidateValue.kind === 'number'
    ? candidateValue
    : candidateValue.kind === 'unknown'
      ? unknownNumber(candidateExpression.getText(context.sourceFile))
      : null
  if (candidate == null) return null
  return {targetName, kind: callTarget.name.text, candidate}
}

export function pushCallFromStatement(statement: ts.Statement): (ts.CallExpression & {expression: ts.PropertyAccessExpression & {expression: ts.Identifier}}) | null {
  if (ts.isExpressionStatement(statement) && isPushCall(statement.expression)) return statement.expression
  if (!ts.isBlock(statement) || statement.statements.length !== 1) return null
  const child = statement.statements[0]
  return child != null && ts.isExpressionStatement(child) && isPushCall(child.expression) ? child.expression : null
}

export function indexedLoopShape(statement: ts.ForStatement): IndexedLoopShape | null {
  if (statement.initializer == null || !ts.isVariableDeclarationList(statement.initializer)) return null
  if (statement.initializer.declarations.length !== 1) return null
  const declaration = statement.initializer.declarations[0]
  if (declaration == null || !ts.isIdentifier(declaration.name)) return null
  if (declaration.initializer == null || numericLiteralValue(declaration.initializer) !== 0) return null

  const indexName = declaration.name.text
  if (statement.condition == null || statement.incrementor == null) return null
  const source = indexedLoopSource(statement.condition, indexName)
  if (source == null) return null
  if (!indexedLoopIncrements(statement.incrementor, indexName)) return null
  return {indexName, sourceExpression: source.expression, sourceKind: source.kind}
}

export function isPushCall(expression: ts.Expression): expression is ts.CallExpression & {expression: ts.PropertyAccessExpression & {expression: ts.Identifier}} {
  return ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.name.text === 'push'
}

function readSegmentedStackAdvance(
  statement: ts.Statement,
  push: LoopPush,
  context: LoopSourceContext,
  localInitializers: Map<string, ts.Expression>,
  identifierAliases: Map<string, string>,
): SegmentedStackPush | null {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return null
  const assignment = statement.expression
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.left)) return null

  const cursorName = assignment.left.text
  if (push.topName == null) return null
  const topSourceName = identifierAliases.get(push.topName) ?? push.topName
  if (topSourceName !== cursorName) return null

  const heightName = pushPropertyIdentifier(push, 'height')
  const bottomName = pushPropertyIdentifier(push, 'bottom')
  if (heightName == null) return null

  const bottomInitializer = bottomName == null ? null : localInitializers.get(bottomName)
  const bottomMatches = bottomInitializer == null
    ? pushedBottomMatchesTopPlusHeight(push)
    : expressionIsIdentifierSum(bottomInitializer, push.topName, heightName) || expressionIsIdentifierSum(bottomInitializer, topSourceName, heightName)
  if (!bottomMatches) return null

  const gapExpression = (bottomName == null ? null : otherSideOfIdentifierSum(assignment.right, bottomName))
    ?? gapAfterTopAndHeight(assignment.right, [push.topName, topSourceName], heightName)
  if (gapExpression == null) return null
  const gap = context.evaluateExpression(gapExpression, context.env)
  if (gap.kind !== 'number' || gap.expr == null) return null
  return {cursorName, topName: push.topName, gap}
}

function pushPropertyIdentifier(push: LoopPush, prop: string): string | null {
  return push.cursorPaths.find(cursorPath => cursorPath.path.length === 1 && cursorPath.path[0] === prop)?.targetName ?? null
}

function pushedBottomMatchesTopPlusHeight(push: LoopPush) {
  if (push.element?.kind !== 'object') return false
  const top = push.element.props.get('top')
  const height = push.element.props.get('height')
  const bottom = push.element.props.get('bottom')
  if (top?.kind !== 'number' || height?.kind !== 'number' || bottom?.kind !== 'number') return false
  if (top.linear == null || height.linear == null || bottom.linear == null) return false
  const expectedBottom = linearAdd(top.linear, height.linear)
  return expectedBottom != null && sameLinear(bottom.linear, expectedBottom)
}

function expressionIsIdentifierSum(expression: ts.Expression, leftName: string, rightName: string) {
  const left = otherSideOfIdentifierSum(expression, leftName)
  return left != null && ts.isIdentifier(left) && left.text === rightName
}

function otherSideOfIdentifierSum(expression: ts.Expression, name: string): ts.Expression | null {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isBinaryExpression(unwrapped) || unwrapped.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
  if (ts.isIdentifier(unwrapped.left) && unwrapped.left.text === name) return unwrapped.right
  if (ts.isIdentifier(unwrapped.right) && unwrapped.right.text === name) return unwrapped.left
  return null
}

function gapAfterTopAndHeight(expression: ts.Expression, topNames: string[], heightName: string): ts.Expression | null {
  const terms = plusTerms(expression)
  const remaining = [...terms]
  const topIndex = remaining.findIndex(term => ts.isIdentifier(term) && topNames.includes(term.text))
  if (topIndex < 0) return null
  remaining.splice(topIndex, 1)
  const heightIndex = remaining.findIndex(term => ts.isIdentifier(term) && term.text === heightName)
  if (heightIndex < 0) return null
  remaining.splice(heightIndex, 1)
  return remaining.length === 1 ? remaining[0]! : null
}

function plusTerms(expression: ts.Expression): ts.Expression[] {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isBinaryExpression(unwrapped) || unwrapped.operatorToken.kind !== ts.SyntaxKind.PlusToken) return [unwrapped]
  return [...plusTerms(unwrapped.left), ...plusTerms(unwrapped.right)]
}

function isResettableScalarAssignment(
  statement: ts.Statement,
  context: LoopSourceContext,
  resettableExtrema: Map<string, LoopExtremum>,
  length: NumberValue,
) {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false
  const assignment = statement.expression
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.left) || !context.isSideEffectFreeExpression(assignment.right)) return false
  const extremum = resettableExtrema.get(assignment.left.text)
  const start = context.env.get(assignment.left.text)
  const reset = context.evaluateExpression(assignment.right, context.env)
  if (extremum == null || start?.kind !== 'number' || reset.kind !== 'number') return false
  const tracked = runningExtremumNumber(extremum.kind, assignment.left.text, start, length, extremum.candidate)
  return reset.min >= tracked.min && reset.max <= tracked.max
}

function scalarAddFromStatement(statement: ts.Statement): {targetName: string; incrementExpression: ts.Expression} | null {
  if (ts.isExpressionStatement(statement)) return scalarAddFromExpression(statement.expression)
  if (!ts.isBlock(statement) || statement.statements.length !== 1) return null
  const child = statement.statements[0]
  return child != null && ts.isExpressionStatement(child) ? scalarAddFromExpression(child.expression) : null
}

function scalarAddFromExpression(expression: ts.Expression): {targetName: string; incrementExpression: ts.Expression} | null {
  if (!ts.isBinaryExpression(expression)) return null
  const targetName = identifierName(expression.left)
  if (targetName == null) return null

  if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    return expressionReferencesIdentifier(expression.right, targetName) ? null : {targetName, incrementExpression: expression.right}
  }

  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const incrementExpression = selfAddIncrementExpression(expression.right, targetName)
  if (incrementExpression == null || expressionReferencesIdentifier(incrementExpression, targetName)) return null
  return {targetName, incrementExpression}
}

function selfAddIncrementExpression(expression: ts.Expression, targetName: string): ts.Expression | null {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isBinaryExpression(unwrapped) || unwrapped.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
  if (identifierName(unwrapped.left) === targetName) return unwrapped.right
  if (identifierName(unwrapped.right) === targetName) return unwrapped.left
  return null
}

function identifierName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression)
  return ts.isIdentifier(unwrapped) ? unwrapped.text : null
}

function expressionReferencesIdentifier(expression: ts.Expression, name: string) {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression)
      return
    }
    if (ts.isPropertyAssignment(node)) {
      visit(node.initializer)
      return
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      found = node.name.text === name
      return
    }
    if (ts.isIdentifier(node) && node.text === name) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return found
}

function indexedLoopSource(expression: ts.Expression, indexName: string): {kind: 'array' | 'limit'; expression: ts.Expression} | null {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null
  if (!ts.isIdentifier(expression.left) || expression.left.text !== indexName) return null
  if (ts.isPropertyAccessExpression(expression.right) && expression.right.name.text === 'length') {
    return {kind: 'array', expression: expression.right.expression}
  }
  return {kind: 'limit', expression: expression.right}
}

function indexedLoopIncrements(expression: ts.Expression, indexName: string) {
  if ((ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression))
    && expression.operator === ts.SyntaxKind.PlusPlusToken
    && ts.isIdentifier(expression.operand)
    && expression.operand.text === indexName) return true

  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken) return false
  return ts.isIdentifier(expression.left)
    && expression.left.text === indexName
    && numericLiteralValue(expression.right) === 1
}

function objectPropertyExpression(expression: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    if (property.name.text === name) return property.initializer
  }
  return null
}

function objectIdentifierPropertyPaths(expression: ts.ObjectLiteralExpression, prefix: string[] = []): {path: string[]; targetName: string}[] {
  const paths: {path: string[]; targetName: string}[] = []
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      paths.push({path: [...prefix, property.name.text], targetName: property.name.text})
      continue
    }
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    const path = [...prefix, property.name.text]
    if (ts.isIdentifier(property.initializer)) {
      paths.push({path, targetName: property.initializer.text})
      continue
    }
    if (ts.isObjectLiteralExpression(property.initializer)) paths.push(...objectIdentifierPropertyPaths(property.initializer, path))
  }
  return paths
}
