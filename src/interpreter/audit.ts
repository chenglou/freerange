import * as ts from 'typescript'
import {
  type NumberValue,
  type Value,
} from '../domain.ts'
import {sameExpressionText} from '../linear.ts'
import {type ComparisonOperator} from '../parser.ts'
import {proveComparison} from '../proof.ts'
import {
  isSideEffectFreeExpression,
  unwrapExpression,
} from './source-syntax.ts'
import {
  noteAudit,
  type InterpreterFrame,
} from './context.ts'

type OrderComparisonOperator = Exclude<ComparisonOperator, '=='>

type SelectorOperand = {
  text: string
  value: NumberValue
}

export function auditMathSelector(kind: 'min' | 'max', values: NumberValue[], frame: InterpreterFrame, expression: ts.CallExpression) {
  if (values.length < 2) return
  const operands = values.map((value, index) => ({
    text: expression.arguments[index]?.getText(frame.program.sourceFile) ?? `arg${index}`,
    value,
  }))
  auditCoveredOperands(`Math.${kind}`, kind === 'max' ? '>=' : '<=', operands, frame, expression)
}

export function auditConditionalSelector(
  expression: ts.ConditionalExpression,
  frame: InterpreterFrame,
  evaluateExpression: (expression: ts.Expression, frame: InterpreterFrame) => Value,
) {
  const condition = unwrapExpression(expression.condition)
  if (!ts.isBinaryExpression(condition)) return
  const op = comparisonOperator(condition.operatorToken.kind)
  if (op == null) return
  if (!isSideEffectFreeExpression(condition.left)
    || !isSideEffectFreeExpression(condition.right)
    || !isSideEffectFreeExpression(expression.whenTrue)
    || !isSideEffectFreeExpression(expression.whenFalse)) return

  const shape = conditionalSelectorShape(condition.left, condition.right, expression.whenTrue, expression.whenFalse, frame.program.sourceFile)
  if (shape == null) return

  const left = evaluateExpression(condition.left, frame)
  const right = evaluateExpression(condition.right, frame)
  if (left.kind !== 'number' || right.kind !== 'number') return

  const trueStatus = proveComparison(left, op, right, frame.assumptions)
  if (trueStatus.status === 'pass') {
    const skipped = shape.trueBranch === 'left' ? shape.rightText : shape.leftText
    noteAudit(
      frame,
      `${expression.getText(frame.program.sourceFile)}: ${skipped} does not affect the result`,
      `${comparisonText(shape.leftText, op, shape.rightText)} is already known`,
      expression,
    )
    return
  }

  const falseOp = negateComparison(op)
  const falseStatus = proveComparison(left, falseOp, right, frame.assumptions)
  if (falseStatus.status !== 'pass') return
  const skipped = shape.trueBranch === 'left' ? shape.leftText : shape.rightText
  noteAudit(
    frame,
    `${expression.getText(frame.program.sourceFile)}: ${skipped} does not affect the result`,
    `${comparisonText(shape.leftText, falseOp, shape.rightText)} is already known`,
    expression,
  )
}

export function auditBranchCondition(
  expression: ts.Expression,
  frame: InterpreterFrame,
  evaluateExpression: (expression: ts.Expression, frame: InterpreterFrame) => Value,
) {
  const condition = unwrapExpression(expression)
  if (!ts.isBinaryExpression(condition)) return
  const op = comparisonOperator(condition.operatorToken.kind)
  if (op == null) return
  if (!isSideEffectFreeExpression(condition.left) || !isSideEffectFreeExpression(condition.right)) return

  const left = evaluateExpression(condition.left, frame)
  const right = evaluateExpression(condition.right, frame)
  if (left.kind !== 'number' || right.kind !== 'number') return

  const trueStatus = proveComparison(left, op, right, frame.assumptions)
  if (trueStatus.status === 'pass') {
    noteAudit(
      frame,
      `if (${expression.getText(frame.program.sourceFile)}): condition is always true`,
      `${comparisonText(condition.left.getText(frame.program.sourceFile), op, condition.right.getText(frame.program.sourceFile))} is already known`,
      expression,
    )
    return
  }

  const falseOp = negateComparison(op)
  const falseStatus = proveComparison(left, falseOp, right, frame.assumptions)
  if (falseStatus.status !== 'pass') return
  noteAudit(
    frame,
    `if (${expression.getText(frame.program.sourceFile)}): condition is always false`,
    `${comparisonText(condition.left.getText(frame.program.sourceFile), falseOp, condition.right.getText(frame.program.sourceFile))} is already known`,
    expression,
  )
}

export function auditNullishFallback(expression: ts.BinaryExpression, left: Value, frame: InterpreterFrame) {
  if (left.kind === 'nullable' || left.kind === 'null' || left.kind === 'unknown') return
  noteAudit(
    frame,
    `${expression.getText(frame.program.sourceFile)}: fallback does not affect the result`,
    `${expression.left.getText(frame.program.sourceFile)} is proven present`,
    expression,
  )
}

function auditCoveredOperands(
  label: string,
  coveringOp: '>=' | '<=',
  operands: SelectorOperand[],
  frame: InterpreterFrame,
  expression: ts.Expression,
) {
  for (let index = 0; index < operands.length; index++) {
    const operand = operands[index]!
    const covering = operands.find((candidate, candidateIndex) =>
      candidateIndex !== index
      && proveComparison(candidate.value, coveringOp, operand.value, frame.assumptions).status === 'pass')
    if (covering == null) continue
    noteAudit(
      frame,
      `${expression.getText(frame.program.sourceFile)}: ${operand.text} does not affect the result`,
      `${label} already has ${covering.text}, and ${comparisonText(covering.text, coveringOp, operand.text)} is known`,
      expression,
    )
  }
}

type ConditionalSelectorShape = {
  leftText: string
  rightText: string
  trueBranch: 'left' | 'right'
}

function conditionalSelectorShape(
  left: ts.Expression,
  right: ts.Expression,
  whenTrue: ts.Expression,
  whenFalse: ts.Expression,
  sourceFile: ts.SourceFile,
): ConditionalSelectorShape | null {
  const leftText = left.getText(sourceFile)
  const rightText = right.getText(sourceFile)
  const trueText = whenTrue.getText(sourceFile)
  const falseText = whenFalse.getText(sourceFile)
  if (sameExpressionText(trueText, leftText) && sameExpressionText(falseText, rightText)) {
    return {leftText, rightText, trueBranch: 'left'}
  }
  if (sameExpressionText(trueText, rightText) && sameExpressionText(falseText, leftText)) {
    return {leftText, rightText, trueBranch: 'right'}
  }
  return null
}

function comparisonOperator(kind: ts.SyntaxKind): OrderComparisonOperator | null {
  switch (kind) {
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return '>='
    case ts.SyntaxKind.GreaterThanToken:
      return '>'
    case ts.SyntaxKind.LessThanEqualsToken:
      return '<='
    case ts.SyntaxKind.LessThanToken:
      return '<'
    default:
      return null
  }
}

function negateComparison(op: OrderComparisonOperator): OrderComparisonOperator {
  switch (op) {
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

function comparisonText(left: string, op: ComparisonOperator, right: string) {
  return `${left} ${op} ${right}`
}
