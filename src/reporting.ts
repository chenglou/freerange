import {type ComparisonOperator} from './parser.ts'

export type ReportNumberValue = {
  min: number
  max: number
  isInteger: boolean
  expr: string | null
  linear: ReportLinearExpr | null
  provenance?: string[]
}

export type ReportLinearExpr = {
  constant: number
  terms: Map<string, number>
}

export type ReportLinearConstraint = {
  diff: ReportLinearExpr | null
  op: ComparisonOperator
  text?: string
  leftExpr?: string
  rightExpr?: string
  source: ReportFactSource
  rangeFact?: true
}

export type ReportFactSource = 'function-given' | 'loop-given' | 'code'

export type ReportArrayValue = {
  summary: {
    nondecreasingProps: string[]
    advances: {prop: string; value: ReportNumberValue}[]
    spaced: {gapExpr: string; heightExpr: string; advanceExpr: string}[]
    lastEnd: ReportNumberValue | null
    extentEnds: {emptyExpr: string; nonEmptyExpr: string; value: ReportNumberValue}[]
  } | null
}

const linearEpsilon = 1e-9

export function rangeFailureReason(
  value: ReportNumberValue,
  min: number,
  max: number,
  requireInteger: boolean,
  assumptions: ReportLinearConstraint[],
) {
  const expectedRange = formatExpectedRange(min, max, requireInteger)
  const lines = [
    `range was ${formatRange(value)}, expected inside ${expectedRange}`,
    `need: ${value.expr ?? formatRange(value)} inside ${expectedRange}`,
  ]
  const known = knownProofContext(value, rangeValue(min, max, requireInteger), assumptions)
  if (known.length > 0) lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)
  lines.push(...missingRangeBounds(value, min, max))
  return lines.join('\n')
}

export function missingRangeBounds(value: ReportNumberValue, min: number, max: number) {
  const name = value.expr ?? formatRange(value)
  const missing: string[] = []
  if (value.min < min) missing.push(`missing: ${name} >= ${min}`)
  if (value.max > max) missing.push(`missing: ${name} <= ${max}`)
  return missing
}

export function comparisonFailureReason(
  left: ReportNumberValue,
  op: ComparisonOperator,
  right: ReportNumberValue,
  assumptions: ReportLinearConstraint[],
  result: string,
  missing: string,
) {
  const lines = [
    `${formatRange(left)} ${op} ${formatRange(right)} ${result}`,
    `need: ${comparisonNeed(left, op, right)}`,
  ]
  const known = knownProofContext(left, right, assumptions)
  if (known.length > 0) lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)
  lines.push(`missing: ${missing}`)
  return lines.join('\n')
}

export function comparisonNeed(left: ReportNumberValue, op: ComparisonOperator, right: ReportNumberValue) {
  return `${left.expr ?? formatRange(left)} ${op} ${right.expr ?? formatRange(right)}`
}

export function formatArraySummary(value: ReportArrayValue) {
  if (value.summary == null) return 'no sequence facts'
  const lines: string[] = []
  for (const prop of value.summary.nondecreasingProps) lines.push(`nondecreasing(.${prop})`)
  for (const fact of value.summary.spaced) lines.push(`spaced(${fact.gapExpr})`)
  if (value.summary.lastEnd != null) lines.push(`lastEnd = ${formatRange(value.summary.lastEnd)}`)
  return lines.length === 0 ? 'no sequence facts' : lines.join(', ')
}

export function formatRange(value: ReportNumberValue) {
  const range = formatExpectedRange(value.min, value.max, value.isInteger)
  const expr = value.expr == null ? '' : ` as ${value.expr}`
  return `${range}${expr}`
}

export function formatExpectedRange(min: number, max: number, isInteger: boolean) {
  const prefix = isInteger ? 'int ' : ''
  return `${prefix}${formatNumber(min)}..${formatNumber(max)}`
}

export function formatLinearConstraint(constraint: ReportLinearConstraint): string {
  if (constraint.diff == null) {
    const left = constraint.leftExpr ?? '?'
    const right = constraint.rightExpr ?? '?'
    return `${left} ${constraint.op} ${right}`
  }
  switch (constraint.op) {
    case '>=':
      return `${formatLinear(constraint.diff)} >= 0`
    case '>':
      return `${formatLinear(constraint.diff)} > 0`
    case '<=':
      return `${formatLinear(constraint.diff)} <= 0`
    case '<':
      return `${formatLinear(constraint.diff)} < 0`
    case '==':
      return `${formatLinear(constraint.diff)} == 0`
  }
}

export function formatLinear(linear: ReportLinearExpr | null) {
  if (linear == null) return '<nonlinear>'
  const clean = cleanReportLinear(linear)
  const parts: string[] = []
  for (const [name, coefficient] of [...clean.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(formatLinearTerm(coefficient, name, parts.length === 0))
  }
  if (clean.constant !== 0 || parts.length === 0) parts.push(formatLinearTerm(clean.constant, '', parts.length === 0))
  return parts.join(' ')
}

function knownProofContext(left: ReportNumberValue, right: ReportNumberValue, assumptions: ReportLinearConstraint[]) {
  const lines = [...knownValueFacts(left), ...knownValueFacts(right)]
  for (const assumption of assumptions) {
    lines.push(formatKnownFact(assumption))
    if (lines.length >= 12) break
  }
  return [...new Set(lines)]
}

function knownValueFacts(value: ReportNumberValue) {
  return [formatRange(value), ...(value.provenance ?? [])]
}

function formatKnownFact(assumption: ReportLinearConstraint): string {
  const fact = assumption.text ?? formatLinearConstraint(assumption)
  switch (assumption.source) {
    case 'function-given':
      return `trusted from function @fit: ${fact}`
    case 'loop-given':
      return `trusted from loop @fit: ${fact}`
    case 'code':
      return `read from code: ${fact}`
  }
}

function rangeValue(min: number, max: number, isInteger: boolean): ReportNumberValue {
  return {min, max, isInteger, expr: null, linear: null}
}

function cleanReportLinear(linear: ReportLinearExpr): ReportLinearExpr {
  const terms = new Map<string, number>()
  for (const [name, coefficient] of linear.terms) {
    if (Math.abs(coefficient) > linearEpsilon) terms.set(name, coefficient)
  }
  return {
    constant: Math.abs(linear.constant) > linearEpsilon ? linear.constant : 0,
    terms,
  }
}

function formatLinearTerm(coefficient: number, name: string, first: boolean) {
  const sign = coefficient < 0 ? '-' : '+'
  const amount = Math.abs(coefficient)
  const body = name.length === 0 ? formatNumber(amount) : amount === 1 ? name : `${formatNumber(amount)} * ${name}`
  return first ? (sign === '-' ? `-${body}` : body) : `${sign} ${body}`
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? `${value}` : `${value}`
}
