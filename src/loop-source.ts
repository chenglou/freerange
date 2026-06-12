import * as ts from 'typescript'
import {
  type NumberValue,
  type Value,
} from './domain.ts'
import {
  linearAdd,
  sameLinear,
  unwrapExpression,
} from './linear.ts'
import {
  runningExtremumNumber,
  type GuardedLoopPush,
  type LoopExtremum,
  type LoopPush,
  type SegmentedStackPush,
} from './loop-summary.ts'
import {rowAxes, type RowAxis} from './sequence-facts.ts'

export type LoopSourceContext = {
  env: Map<string, Value>
  sourceFile: ts.SourceFile
  evaluateExpression: (expression: ts.Expression, env: Map<string, Value>) => Value
  bindVariableStatement: (statement: ts.VariableStatement, env: Map<string, Value>) => void
  isSideEffectFreeExpression: (expression: ts.Expression) => boolean
}

export function readLoopPush(expression: ts.CallExpression, context: LoopSourceContext): Omit<LoopPush, 'arrayName' | 'length'> {
  const row = expression.arguments[0]
  if (row == null) return {element: null, source: null, topName: null, topPath: null, height: null, cursorPaths: []}
  if (!ts.isObjectLiteralExpression(row)) {
    return {
      element: context.evaluateExpression(row, context.env),
      source: row,
      topName: null,
      topPath: null,
      height: null,
      cursorPaths: ts.isIdentifier(row) ? [{path: [], targetName: row.text}] : [],
    }
  }
  const stackShape = readRowStackShape(row, context)
  const fallback = readBarePositionCursor(row)
  return {
    element: context.evaluateExpression(row, context.env),
    source: row,
    topName: stackShape?.topName ?? fallback?.topName ?? null,
    topPath: stackShape?.topPath ?? fallback?.topPath ?? null,
    height: stackShape?.height ?? null,
    cursorPaths: objectIdentifierPropertyPaths(row),
  }
}

function readBarePositionCursor(row: ts.ObjectLiteralExpression): {topName: string; topPath: string[]} | null {
  for (const axis of rowAxes) {
    const expression = objectPropertyExpression(row, axis.position)
    if (expression != null && ts.isIdentifier(expression)) return {topName: expression.text, topPath: [axis.position]}
  }
  return null
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


export function pushCallFromStatement(statement: ts.Statement): (ts.CallExpression & {expression: ts.PropertyAccessExpression & {expression: ts.Identifier}}) | null {
  if (ts.isExpressionStatement(statement) && isPushCall(statement.expression)) return statement.expression
  if (!ts.isBlock(statement) || statement.statements.length !== 1) return null
  const child = statement.statements[0]
  return child != null && ts.isExpressionStatement(child) && isPushCall(child.expression) ? child.expression : null
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
  if (push.topName == null || push.topPath == null) return null
  const axis = rowAxes.find(candidate => push.topPath?.at(-1) === candidate.position)
  if (axis == null) return null
  const topSourceName = identifierAliases.get(push.topName) ?? push.topName
  if (topSourceName !== cursorName) return null

  const sizeName = pushPropertyIdentifier(push, axis.size)
  const endName = pushPropertyIdentifier(push, axis.end)
  if (sizeName == null) return null

  const endInitializer = endName == null ? null : localInitializers.get(endName)
  const endMatches = endInitializer == null
    ? pushedEndMatchesPositionPlusSize(push, axis)
    : expressionIsIdentifierSum(endInitializer, push.topName, sizeName) || expressionIsIdentifierSum(endInitializer, topSourceName, sizeName)
  if (!endMatches) return null

  const gapExpression = (endName == null ? null : otherSideOfIdentifierSum(assignment.right, endName))
    ?? gapAfterTopAndHeight(assignment.right, [push.topName, topSourceName], sizeName)
  if (gapExpression == null) return null
  const gap = context.evaluateExpression(gapExpression, context.env)
  if (gap.kind !== 'number' || gap.expr == null) return null
  return {cursorName, topName: push.topName, axis, gap}
}

function pushPropertyIdentifier(push: LoopPush, prop: string): string | null {
  return push.cursorPaths.find(cursorPath => cursorPath.path.length === 1 && cursorPath.path[0] === prop)?.targetName ?? null
}

function pushedEndMatchesPositionPlusSize(push: LoopPush, axis: RowAxis) {
  if (push.element?.kind !== 'object') return false
  const position = push.element.props.get(axis.position)
  const size = push.element.props.get(axis.size)
  const end = push.element.props.get(axis.end)
  if (position?.kind !== 'number' || size?.kind !== 'number' || end?.kind !== 'number') return false
  if (position.linear == null || size.linear == null || end.linear == null) return false
  const expectedEnd = linearAdd(position.linear, size.linear)
  return expectedEnd != null && sameLinear(end.linear, expectedEnd)
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


function objectPropertyExpression(expression: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    if (property.name.text === name) return property.initializer
  }
  return null
}

function readRowStackShape(
  expression: ts.ObjectLiteralExpression,
  context: LoopSourceContext,
): {topName: string; topPath: string[]; height: NumberValue} | null {
  for (const axis of rowAxes) {
    const candidates = objectPropertyCandidates(expression, axis.position)
      .filter(candidate => ts.isIdentifier(candidate.expression))
      .sort((left, right) => left.path.length - right.path.length)

    for (const candidate of candidates) {
      const sizeExpression = objectPropertyExpression(candidate.container, axis.size)
      if (sizeExpression == null) continue
      const size = context.evaluateExpression(sizeExpression, context.env)
      if (size.kind === 'number') return {topName: (candidate.expression as ts.Identifier).text, topPath: candidate.path, height: size}
    }
  }
  return null
}

function objectPropertyCandidates(
  expression: ts.ObjectLiteralExpression,
  name: string,
  prefix: string[] = [],
): {path: string[]; expression: ts.Expression; container: ts.ObjectLiteralExpression}[] {
  const candidates: {path: string[]; expression: ts.Expression; container: ts.ObjectLiteralExpression}[] = []
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === name) candidates.push({path: [...prefix, property.name.text], expression: property.name, container: expression})
      continue
    }
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    const path = [...prefix, property.name.text]
    if (property.name.text === name) candidates.push({path, expression: property.initializer, container: expression})
    if (ts.isObjectLiteralExpression(property.initializer)) candidates.push(...objectPropertyCandidates(property.initializer, name, path))
  }
  return candidates
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
