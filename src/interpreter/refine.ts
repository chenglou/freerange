import * as ts from 'typescript'
import {
  literalValue,
  numberBranches,
  numberValue,
  withNumberCases,
  type NullishKind,
  type NumberCase,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {mergeAssumptions} from '../assumptions.ts'
import type {ComparisonOperator} from '../parser.ts'
import {comparisonConstraint, proveComparisonPlain} from '../proof.ts'
import {childFrame, type InterpreterFrame} from './context.ts'
import {unwrapExpression} from './source-syntax.ts'
import {
  pathFromExpression as pathFromSourceExpression,
  readPath,
  writePath,
  type ValuePath,
} from './value-path.ts'

export type EvaluateRefinementExpression = (expression: ts.Expression, frame: InterpreterFrame) => Value

type PresenceGuard = {
  target: ts.Expression
  nullish: NullishKind
  presentWhenTrue: boolean
}

export function branchFrame(
  frame: InterpreterFrame,
  condition: ts.Expression,
  truth: boolean,
  name: string,
  evaluateExpression: EvaluateRefinementExpression,
): InterpreterFrame {
  const branch = childFrame(frame, new Map(frame.env), name)
  refineCondition(branch, condition, truth, evaluateExpression)
  return branch
}

export function isComparisonOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken
    || kind === ts.SyntaxKind.LessThanToken
    || kind === ts.SyntaxKind.LessThanEqualsToken
    || kind === ts.SyntaxKind.GreaterThanToken
    || kind === ts.SyntaxKind.GreaterThanEqualsToken
}

export function compareNumbers(left: number, kind: ts.SyntaxKind, right: number): boolean {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return left === right
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return left !== right
    case ts.SyntaxKind.LessThanToken:
      return left < right
    case ts.SyntaxKind.LessThanEqualsToken:
      return left <= right
    case ts.SyntaxKind.GreaterThanToken:
      return left > right
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return left >= right
    default:
      return false
  }
}

function refineCondition(frame: InterpreterFrame, condition: ts.Expression, truth: boolean, evaluateExpression: EvaluateRefinementExpression) {
  const current = unwrapExpression(condition)
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    refineCondition(frame, current.operand, !truth, evaluateExpression)
    return
  }
  if (ts.isBinaryExpression(current)) {
    if (refineLogicalCondition(frame, current, truth, evaluateExpression)) return
    refineBinaryCondition(frame, current, truth, evaluateExpression)
    return
  }
  refineLiteralTruthiness(frame, current, truth, evaluateExpression)
}

function refineLogicalCondition(frame: InterpreterFrame, expression: ts.BinaryExpression, truth: boolean, evaluateExpression: EvaluateRefinementExpression): boolean {
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && truth) {
    refineCondition(frame, expression.left, true, evaluateExpression)
    refineCondition(frame, expression.right, true, evaluateExpression)
    return true
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken && !truth) {
    refineCondition(frame, expression.left, false, evaluateExpression)
    refineCondition(frame, expression.right, false, evaluateExpression)
    return true
  }
  return false
}

function refineBinaryCondition(frame: InterpreterFrame, expression: ts.BinaryExpression, truth: boolean, evaluateExpression: EvaluateRefinementExpression) {
  if (refinePresenceGuard(frame, expression, truth, evaluateExpression)) return
  const comparison = comparisonForSyntax(expression.operatorToken.kind, truth)
  if (comparison != null) {
    addNumberComparisonAssumption(frame, expression.left, comparison, expression.right, evaluateExpression)
    if (refineNumberPath(frame, expression.left, comparison, expression.right, evaluateExpression)) return
    if (refineNumberPathCases(frame, expression.left, comparison, expression.right, evaluateExpression)) return
    refineNumberPath(frame, expression.right, flipComparison(comparison), expression.left, evaluateExpression)
    refineNumberPathCases(frame, expression.right, flipComparison(comparison), expression.left, evaluateExpression)
  }
  const equalityTruth = equalityTruthForSyntax(expression.operatorToken.kind, truth)
  if (equalityTruth != null) {
    if (refineLiteralEquality(frame, expression.left, expression.right, equalityTruth, evaluateExpression)) return
    refineLiteralEquality(frame, expression.right, expression.left, equalityTruth, evaluateExpression)
  }
}

function refinePresenceGuard(
  frame: InterpreterFrame,
  expression: ts.BinaryExpression,
  truth: boolean,
  evaluateExpression: EvaluateRefinementExpression,
): boolean {
  const guard = presenceGuardForCondition(expression)
  if (guard == null || truth !== guard.presentWhenTrue) return false
  const path = pathFromExpression(guard.target, frame, evaluateExpression)
  if (path == null) return false
  const current = readPath(path, frame)
  if (current.kind !== 'nullable' || !presenceGuardExcludesAbsent(current.absent, guard.nullish)) return false
  writePath(path, current.present, frame)
  return true
}

function presenceGuardForCondition(expression: ts.BinaryExpression): PresenceGuard | null {
  if (!isNullishComparisonSyntax(expression.operatorToken.kind)) return null
  return typeofUndefinedPresenceGuard(expression) ?? nullishPresenceGuard(expression)
}

function typeofUndefinedPresenceGuard(expression: ts.BinaryExpression): PresenceGuard | null {
  const target = typeofUndefinedSide(expression.left, expression.right) ?? typeofUndefinedSide(expression.right, expression.left)
  if (target == null) return null
  return {
    target,
    nullish: 'undefined',
    presentWhenTrue: expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken,
  }
}

function typeofUndefinedSide(typeofExpression: ts.Expression, literalExpression: ts.Expression): ts.Expression | null {
  const literal = unwrapExpression(literalExpression)
  if (!ts.isStringLiteral(literal) || literal.text !== 'undefined') return null
  const current = unwrapExpression(typeofExpression)
  return ts.isTypeOfExpression(current) ? current.expression : null
}

function nullishPresenceGuard(expression: ts.BinaryExpression): PresenceGuard | null {
  const left = nullishLiteralKind(expression.left)
  const right = nullishLiteralKind(expression.right)
  const target = left != null ? expression.right : right != null ? expression.left : null
  const literal = left ?? right
  if (target == null || literal == null) return null
  const loose = expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
    || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
  return {
    target,
    nullish: loose ? 'nullish' : literal,
    presentWhenTrue: expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken,
  }
}

function nullishLiteralKind(expression: ts.Expression): NullishKind | null {
  const current = unwrapExpression(expression)
  if (current.kind === ts.SyntaxKind.NullKeyword) return 'null'
  return ts.isIdentifier(current) && current.text === 'undefined' ? 'undefined' : null
}

function presenceGuardExcludesAbsent(absent: NullishKind, guard: NullishKind): boolean {
  return guard === 'nullish' || absent === guard
}

function isNullishComparisonSyntax(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken
}

function addNumberComparisonAssumption(
  frame: InterpreterFrame,
  leftExpression: ts.Expression,
  op: ComparisonOperator,
  rightExpression: ts.Expression,
  evaluateExpression: EvaluateRefinementExpression,
) {
  const left = evaluateExpression(leftExpression, frame)
  const right = evaluateExpression(rightExpression, frame)
  if (left.kind !== 'number' || right.kind !== 'number') return
  const fact = comparisonConstraint(left, op, right, undefined, 'branch')
  if (fact == null) return
  frame.assumptions = mergeAssumptions(frame.assumptions, [fact])
}

function refineNumberPath(
  frame: InterpreterFrame,
  targetExpression: ts.Expression,
  op: ComparisonOperator,
  otherExpression: ts.Expression,
  evaluateExpression: EvaluateRefinementExpression,
): boolean {
  const path = pathFromExpression(targetExpression, frame, evaluateExpression)
  if (path == null) return false
  const current = readPath(path, frame)
  if (current.kind !== 'number') return false
  const other = evaluateExpression(otherExpression, frame)
  if (other.kind !== 'number' || other.min !== other.max) return false
  const next = narrowNumber(current, op, other.min)
  if (next === current) return false
  writePath(path, next, frame)
  return true
}

function refineNumberPathCases(
  frame: InterpreterFrame,
  targetExpression: ts.Expression,
  op: ComparisonOperator,
  otherExpression: ts.Expression,
  evaluateExpression: EvaluateRefinementExpression,
): boolean {
  const path = pathFromExpression(targetExpression, frame, evaluateExpression)
  if (path == null) return false
  const current = readPath(path, frame)
  if (current.kind !== 'number' || current.cases == null) return false
  const other = evaluateExpression(otherExpression, frame)
  if (other.kind !== 'number') return false

  const cases: NumberCase[] = []
  for (const currentCase of numberBranches(current)) {
    for (const otherCase of numberBranches(other)) {
      const assumptions = mergeAssumptions(frame.assumptions, currentCase.assumptions, otherCase.assumptions)
      const proof = proveComparisonPlain(currentCase.value, op, otherCase.value, assumptions)
      if (proof.status === 'fail') continue
      const fact = proof.status === 'pass' ? null : comparisonConstraint(currentCase.value, op, otherCase.value, undefined, 'branch')
      cases.push({
        value: currentCase.value,
        assumptions: mergeAssumptions(currentCase.assumptions, otherCase.assumptions, fact == null ? [] : [fact]),
      })
    }
  }
  if (cases.length === 0) return false
  writePath(path, withNumberCases(current, cases), frame)
  return true
}

function narrowNumber(value: NumberValue, op: ComparisonOperator, other: number): NumberValue {
  switch (op) {
    case '==':
      return numberValue(other, other, Number.isInteger(other), value.expr, value.linear, null, value.provenance)
    case '>=':
      return numberValue(Math.max(value.min, other), value.max, value.isInteger, value.expr, value.linear, value.cases, value.provenance)
    case '>':
      return numberValue(Math.max(value.min, value.isInteger ? Math.floor(other) + 1 : other), value.max, value.isInteger, value.expr, value.linear, value.cases, value.provenance)
    case '<=':
      return numberValue(value.min, Math.min(value.max, other), value.isInteger, value.expr, value.linear, value.cases, value.provenance)
    case '<':
      return numberValue(value.min, Math.min(value.max, value.isInteger ? Math.ceil(other) - 1 : other), value.isInteger, value.expr, value.linear, value.cases, value.provenance)
  }
}

function refineLiteralTruthiness(frame: InterpreterFrame, expression: ts.Expression, truth: boolean, evaluateExpression: EvaluateRefinementExpression) {
  const path = pathFromExpression(expression, frame, evaluateExpression)
  if (path == null) return
  const current = readPath(path, frame)
  if (current.kind !== 'literal') return
  writeLiteralFilter(frame, path, current, value => Boolean(value) === truth)
}

function refineLiteralEquality(
  frame: InterpreterFrame,
  targetExpression: ts.Expression,
  otherExpression: ts.Expression,
  equal: boolean,
  evaluateExpression: EvaluateRefinementExpression,
): boolean {
  const path = pathFromExpression(targetExpression, frame, evaluateExpression)
  if (path == null) return false
  const current = readPath(path, frame)
  if (current.kind !== 'literal') return false
  const other = evaluateExpression(otherExpression, frame)
  if (other.kind !== 'literal') return false
  const keys = new Set(other.values.map(value => `${typeof value}:${String(value)}`))
  writeLiteralFilter(frame, path, current, value => keys.has(`${typeof value}:${String(value)}`) === equal)
  return true
}

function writeLiteralFilter(frame: InterpreterFrame, path: ValuePath, current: Extract<Value, {kind: 'literal'}>, keep: (value: string | boolean) => boolean) {
  const values = current.values.filter(keep)
  if (values.length === 0 || values.length === current.values.length) return
  const next = literalValue(values, current.expr, current.provenance)
  if (next.kind !== 'literal') return
  writePath(path, next, frame)
}

function comparisonForSyntax(kind: ts.SyntaxKind, truth: boolean): ComparisonOperator | null {
  const comparison = comparisonForSyntaxWhenTrue(kind)
  if (comparison == null) return null
  return truth ? comparison : negatedComparison(comparison)
}

function comparisonForSyntaxWhenTrue(kind: ts.SyntaxKind): ComparisonOperator | null {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return '=='
    case ts.SyntaxKind.LessThanToken:
      return '<'
    case ts.SyntaxKind.LessThanEqualsToken:
      return '<='
    case ts.SyntaxKind.GreaterThanToken:
      return '>'
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return '>='
    default:
      return null
  }
}

function negatedComparison(op: ComparisonOperator): ComparisonOperator | null {
  switch (op) {
    case '==':
      return null
    case '>=':
      return '<'
    case '>':
      return '<='
    case '<=':
      return '>'
    case '<':
      return '>='
  }
}

function flipComparison(op: ComparisonOperator): ComparisonOperator {
  switch (op) {
    case '==':
      return '=='
    case '>=':
      return '<='
    case '>':
      return '<'
    case '<=':
      return '>='
    case '<':
      return '>'
  }
}

function equalityTruthForSyntax(kind: ts.SyntaxKind, truth: boolean): boolean | null {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return truth
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return !truth
    default:
      return null
  }
}

function pathFromExpression(
  expression: ts.Expression,
  frame: InterpreterFrame,
  evaluateExpression: EvaluateRefinementExpression,
): ValuePath | null {
  return pathFromSourceExpression(expression, indexExpression => evaluateExpression(indexExpression, frame))
}
