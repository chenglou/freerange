import * as ts from 'typescript'
import {
  literalValue,
  unknown,
  type ArrayValue,
  type NumberValue,
  type Value,
} from './domain.ts'
import {sameExpressionText} from './linear.ts'
import {publicFitText} from './parser.ts'
import {formatArraySummary, formatRange} from './reporting.ts'
import {hasNondecreasingProp, provedSpacing} from './sequence-facts.ts'

export type AmbientBuiltinContext = {
  expression: ts.CallExpression
  evaluateExpression: (expression: ts.Expression) => Value
  expressionText: (expression: ts.Expression) => string
}

export function evaluateAmbientBuiltinCall(context: AmbientBuiltinContext): Value | null {
  const name = ambientCallName(context.expression)
  if (name == null) return null
  switch (name) {
    case 'nondecreasing':
      return evaluateNondecreasingCall(context)
    case 'spaced':
      return evaluateSpacedCall(context)
    case 'lastEnd':
      return evaluateLastEndCall(context)
    case 'extentEnd':
      return evaluateExtentEndCall(context)
    default:
      return null
  }
}

export function extentEndSummaryValue(array: ArrayValue, emptyExpr: string, nonEmptyExpr?: string): NumberValue | null {
  const extentEnds = array.summary?.extentEnds ?? []
  return extentEnds.find(fact =>
    sameExpressionText(fact.emptyExpr, emptyExpr)
    && (nonEmptyExpr == null || sameExpressionText(fact.nonEmptyExpr, nonEmptyExpr))
  )?.value ?? null
}

function evaluateNondecreasingCall(context: AmbientBuiltinContext): Value {
  const text = context.expressionText(context.expression)
  const target = sequencePropArgument(context.expression.arguments, context.evaluateExpression)
  if (target == null) return unknown('nondecreasing expects return.rows.top')
  if (hasNondecreasingProp(target.array, target.prop)) {
    return literalValue([true], text, [`sequence facts: ${formatArraySummary(target.array)}`])
  }
  return unknown(nondecreasingFailureReason(text, target))
}

function evaluateSpacedCall(context: AmbientBuiltinContext): Value {
  const text = context.expressionText(context.expression)
  const args = context.expression.arguments
  if (args.length !== 2) return unknown('spaced expects spaced(rows, gap)')
  const rows = context.evaluateExpression(args[0]!)
  const gap = context.evaluateExpression(args[1]!)
  if (rows.kind !== 'array') return unknown('spaced expected an array')
  if (gap.kind !== 'number' || gap.expr == null) return unknown('spaced expected a known gap expression')
  if (provedSpacing(rows, gap.expr) != null) {
    return literalValue([true], text, [`sequence facts: ${formatArraySummary(rows)}`])
  }
  return unknown(spacedFailureReason(text, rows, gap.expr))
}

function evaluateLastEndCall(context: AmbientBuiltinContext): Value {
  const targetExpression = context.expression.arguments[0]
  if (targetExpression == null || context.expression.arguments.length !== 1) return unknown('lastEnd expects one array')
  const target = context.evaluateExpression(targetExpression)
  if (target.kind !== 'array') return unknown('lastEnd expected an array')
  return target.summary?.lastEnd ?? unknown(lastEndFailureReason(context.expressionText(targetExpression), target))
}

function evaluateExtentEndCall(context: AmbientBuiltinContext): Value {
  const targetExpression = context.expression.arguments[0]
  const emptyExpression = context.expression.arguments[1]
  if (targetExpression == null || emptyExpression == null || context.expression.arguments.length !== 2) {
    return unknown('extentEnd expects extentEnd(rows, emptyValue)')
  }
  const target = context.evaluateExpression(targetExpression)
  if (target.kind !== 'array') return unknown('extentEnd expected an array')
  const empty = context.evaluateExpression(emptyExpression)
  if (empty.kind !== 'number' || empty.expr == null) return unknown('extentEnd expected a known empty value')

  if (target.length.max === 0) return empty
  if (target.length.min >= 1 && target.summary?.lastEnd != null) return target.summary.lastEnd
  return extentEndSummaryValue(target, empty.expr) ?? unknown(extentEndFailureReason(context.expressionText(targetExpression), empty.expr, target))
}

function ambientCallName(expression: ts.CallExpression): string | null {
  const target = unwrapExpression(expression.expression)
  return ts.isIdentifier(target) ? target.text : null
}

function sequencePropArgument(args: ts.NodeArray<ts.Expression>, evaluateExpression: (expression: ts.Expression) => Value): {array: ArrayValue; prop: string} | null {
  if (args.length !== 1) return null
  let expression = unwrapExpression(args[0]!)
  const path: string[] = []
  while (ts.isPropertyAccessExpression(expression)) {
    path.unshift(expression.name.text)
    const array = evaluateExpression(expression.expression)
    if (array.kind === 'array') return {array, prop: path.join('.')}
    expression = unwrapExpression(expression.expression)
  }
  return null
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

export function nondecreasingFailureReason(text: string, target: {array: ArrayValue; prop: string}) {
  const lines = [
    `${publicFitText(text)} was not inferred`,
    `need: every next .${target.prop} >= previous .${target.prop}`,
  ]
  const known: string[] = []
  const advance = target.array.summary?.advances.find(fact => fact.prop === target.prop)
  if (advance != null) known.push(`row advance for .${target.prop}: ${formatRange(advance.value)}`)
  known.push(`sequence facts: ${formatArraySummary(target.array)}`)
  lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)

  if (advance?.value.expr != null) {
    lines.push(`missing: given ${publicFitText(advance.value.expr)} >= 0`)
  } else {
    lines.push(`missing: sequence facts for .${target.prop}`)
  }
  return lines.join('\n')
}

function spacedFailureReason(text: string, rows: ArrayValue, gapExpr: string) {
  const publicGapExpr = publicFitText(gapExpr)
  const lines = [
    `${publicFitText(text)} was not inferred`,
    `need: every next row top == previous top + previous height + ${publicGapExpr}`,
  ]
  const known: string[] = []
  const spacing = rows.summary?.spaced[0]
  if (spacing != null) {
    known.push(`loop proved: row advance ${publicFitText(spacing.advanceExpr)} = previous height ${publicFitText(spacing.heightExpr)} + ${publicFitText(spacing.gapExpr)}`)
  }
  known.push(`sequence facts: ${formatArraySummary(rows)}`)
  lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)

  if (spacing != null) {
    lines.push(`missing: given ${publicFitText(spacing.gapExpr)} == ${publicGapExpr}`)
  } else {
    lines.push('missing: recognized adjacent row spacing')
  }
  return lines.join('\n')
}

function lastEndFailureReason(targetText: string, target: ArrayValue) {
  const missing = target.length.min >= 1 ? 'pushed row height for lastEnd' : 'row height and non-empty length for lastEnd'
  const publicTargetText = publicFitText(targetText)
  const lines = [
    `lastEnd(${publicTargetText}) was not inferred`,
    'need: a non-empty append-only row loop that pushes height',
    `known:\n  rows length: ${formatRange(target.length)}\n  sequence facts: ${formatArraySummary(target)}`,
  ]
  lines.push(`missing: ${missing}`)
  return lines.join('\n')
}

function extentEndFailureReason(targetText: string, emptyExpr: string, target: ArrayValue) {
  const publicTargetText = publicFitText(targetText)
  const publicEmptyExpr = publicFitText(emptyExpr)
  const lines = [
    `extentEnd(${publicTargetText}, ${publicEmptyExpr}) was not inferred`,
    'need: an append-only row loop plus the empty fallback used by the source',
    `known:\n  rows length: ${formatRange(target.length)}\n  sequence facts: ${formatArraySummary(target)}`,
  ]
  lines.push('missing: empty-safe row end')
  return lines.join('\n')
}
