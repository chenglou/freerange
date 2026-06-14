import * as ts from 'typescript'
import {
  literalValue,
  unknown,
  type ArrayValue,
  type NumberValue,
  type Value,
} from './domain.ts'
import {sameExpressionText} from './linear.ts'
import {parseExpression, publicFitText} from './parser.ts'
import {formatArraySummary, formatRange} from './reporting.ts'
import {ambiguousRowAxes, hasNondecreasingProp, isRowExtentShape, provedSpacing, rowAxes, spacedShapesFromRelations, type AddendResolver} from './sequence-facts.ts'

export type BuiltinContext = {
  expression: ts.CallExpression
  evaluateExpression: (expression: ts.Expression) => Value
  expressionText: (expression: ts.Expression) => string
}

// The catalog name a bare call would dispatch to. Callers must check that the
// name does not resolve to a user binding first: these are ordinary
// identifiers, not real platform globals, and the user's own function wins.
export function builtinCallName(expression: ts.CallExpression): string | null {
  const name = ambientCallName(expression)
  return name != null && builtinCallNames.has(name) ? name : null
}

const builtinCallNames = new Set(['nondecreasing', 'spaced', 'lastEnd', 'extentEnd', 'noOverlap'])

export function evaluateBuiltinCall(context: BuiltinContext): Value | null {
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
    case 'noOverlap':
      return evaluateNoOverlapCall(context)
    default:
      return null
  }
}

export function extentEndSummaryValue(array: ArrayValue, emptyExpr: string): NumberValue | null {
  const extentEnds = array.summary?.extentEnds ?? []
  const fact = extentEnds.find(candidate => sameExpressionText(candidate.emptyExpr, emptyExpr))
  return fact == null ? null : blessedRowEnd(fact)
}

// The recorded loop end means "final position + size" only when the fields its
// recurrence ran over form one of the catalog's axes; rename through map to
// get there from other field vocabularies.
function blessedRowEnd(end: {value: NumberValue; positionPath: string[]; sizePath: string[]} | null): NumberValue | null {
  if (end == null) return null
  const blessed = rowAxes.some(axis =>
    end.positionPath.length === 1 && end.positionPath[0] === axis.position
    && end.sizePath.length === 1 && (end.sizePath[0] === axis.size || end.sizePath[0] === axis.end))
  return blessed ? end.value : null
}

function evaluateNondecreasingCall(context: BuiltinContext): Value {
  const text = context.expressionText(context.expression)
  const target = sequencePropArgument(context.expression.arguments, context.evaluateExpression)
  if (target == null) return unknown('nondecreasing expects return.rows.top')
  if (hasNondecreasingProp(target.array, target.prop)) {
    return literalValue([true], text, [`sequence facts: ${formatArraySummary(target.array)}`])
  }
  return unknown(nondecreasingFailureReason(text, target))
}

const ambiguousAxesReason = 'elements carry both y/height and x/width; map to one axis first'

function evaluateSpacedCall(context: BuiltinContext): Value {
  const text = context.expressionText(context.expression)
  const args = context.expression.arguments
  if (args.length !== 2) return unknown('spaced expects spaced(rows, gap)')
  const rows = context.evaluateExpression(args[0]!)
  const gap = context.evaluateExpression(args[1]!)
  if (rows.kind !== 'array') return unknown('spaced expected an array')
  if (ambiguousRowAxes(rows)) return unknown(`spaced(...) is ambiguous: ${ambiguousAxesReason}`)
  if (gap.kind !== 'number' || gap.expr == null) return unknown('spaced expected a known gap expression')
  if (provedSpacing(rows, gap.expr, addendResolver(context)) != null) {
    return literalValue([true], text, [`sequence facts: ${formatArraySummary(rows)}`])
  }
  return unknown(spacedFailureReason(text, rows, gap.expr))
}

function evaluateLastEndCall(context: BuiltinContext): Value {
  const targetExpression = context.expression.arguments[0]
  if (targetExpression == null || context.expression.arguments.length !== 1) return unknown('lastEnd expects one array')
  const target = context.evaluateExpression(targetExpression)
  if (target.kind !== 'array') return unknown('lastEnd expected an array')
  if (ambiguousRowAxes(target)) return unknown(`lastEnd(...) is ambiguous: ${ambiguousAxesReason}`)
  const lastEnd = blessedRowEnd(target.summary?.lastEnd ?? null)
  return lastEnd ?? unknown(lastEndFailureReason(context.expressionText(targetExpression), target))
}

function evaluateNoOverlapCall(context: BuiltinContext): Value {
  const text = context.expressionText(context.expression)
  const args = context.expression.arguments
  if (args.length !== 1) return unknown('noOverlap expects noOverlap(arr)')
  const arr = context.evaluateExpression(args[0]!)
  if (arr.kind !== 'array') return unknown('noOverlap expected an array')
  if (ambiguousRowAxes(arr)) return unknown(`noOverlap(...) is ambiguous: ${ambiguousAxesReason}`)
  const summary = arr.summary
  if (summary == null) return unknown(noOverlapFailureReason(text, arr, null))
  const rowExtentShapes = spacedShapesFromRelations(summary.relations).filter(isRowExtentShape)
  for (const shape of rowExtentShapes) {
    if (gapIsNonnegative(shape.gapExpr, context)) {
      return literalValue([true], text, [`lifted from spaced(${shape.gapExpr}): ${formatArraySummary(arr)}`])
    }
  }
  return unknown(noOverlapFailureReason(text, arr, rowExtentShapes[0] ?? null))
}

function addendResolver(context: BuiltinContext): AddendResolver {
  return text => {
    try {
      const value = context.evaluateExpression(parseExpression(text))
      return value.kind === 'number' ? value : null
    } catch {
      return null
    }
  }
}

function gapIsNonnegative(gapExpr: string, context: BuiltinContext): boolean {
  if (gapExpr === '0') return true
  try {
    const expr = parseExpression(gapExpr)
    const value = context.evaluateExpression(expr)
    if (value.kind === 'number' && value.min >= 0) return true
  } catch {}
  return false
}

function noOverlapFailureReason(text: string, arr: ArrayValue, spacing: {gapExpr: string; heightExpr: string; advanceExpr: string} | null): string {
  const lines = [
    `${publicFitText(text)} was not inferred`,
    'need: adjacent items separated by a non-negative gap',
    `known: sequence facts: ${formatArraySummary(arr)}`,
  ]
  if (spacing != null) {
    lines.push(`missing: given ${publicFitText(spacing.gapExpr)} >= 0`)
  } else {
    lines.push('missing: recognized adjacent row spacing')
  }
  return lines.join('\n')
}

function evaluateExtentEndCall(context: BuiltinContext): Value {
  const targetExpression = context.expression.arguments[0]
  const emptyExpression = context.expression.arguments[1]
  if (targetExpression == null || emptyExpression == null || context.expression.arguments.length !== 2) {
    return unknown('extentEnd expects extentEnd(rows, emptyValue)')
  }
  const target = context.evaluateExpression(targetExpression)
  if (target.kind !== 'array') return unknown('extentEnd expected an array')
  if (ambiguousRowAxes(target)) return unknown(`extentEnd(...) is ambiguous: ${ambiguousAxesReason}`)
  const empty = context.evaluateExpression(emptyExpression)
  if (empty.kind !== 'number' || empty.expr == null) return unknown('extentEnd expected a known empty value')

  if (target.length.max === 0) return empty
  const lastEnd = blessedRowEnd(target.summary?.lastEnd ?? null)
  if (target.length.min >= 1 && lastEnd != null) return lastEnd
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
  const direct = evaluateExpression(expression)
  if (direct.kind === 'array') return {array: direct, prop: ''}
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
  const spacing = rows.summary == null ? null : spacedShapesFromRelations(rows.summary.relations)[0] ?? null
  if (spacing != null) {
    const advance = publicFitText(spacing.advanceExpr)
    const size = publicFitText(spacing.heightExpr)
    const gap = publicFitText(spacing.gapExpr)
    if (advance.length === 0) {
      known.push(`loop proved: next = previous + ${gap}`)
    } else if (size === rowAxes.find(axis => axis.position === spacing.advanceExpr)?.end) {
      known.push(`loop proved: next.${advance} = previous.${size} + ${gap}`)
    } else {
      known.push(`loop proved: next.${advance} = previous.${advance} + previous.${size} + ${gap}`)
    }
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
