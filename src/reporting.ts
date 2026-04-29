import {publicFitText, type ComparisonOperator, type FitRange} from './parser.ts'

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

export type ReportFactSource = 'function-given' | 'loop-given' | 'code' | 'branch' | 'contract'

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

export function comparisonFailureReason(
  left: ReportNumberValue,
  right: ReportNumberValue,
  assumptions: ReportLinearConstraint[],
  result: string,
  missing: string,
) {
  const lines: string[] = []
  if (result !== 'was not proven') lines.push(`result: ${result}`)
  const known = knownProofContext(left, right, assumptions)
  if (known.length > 0) lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)
  lines.push(formatMissingComparison(missing))
  return lines.join('\n')
}

export function rangeSpecFailureReason(
  value: ReportNumberValue,
  range: FitRange,
  lower: ReportNumberValue,
  upper: ReportNumberValue,
  assumptions: ReportLinearConstraint[],
  missing: {lower: boolean; upper: boolean; integer: boolean},
) {
  const expectedRange = formatRangeSpec(range)
  const lines = [
    `range was ${formatRange(value)}, expected inside ${expectedRange}`,
  ]
  const known = knownProofContextMany([value, lower, upper], assumptions)
  if (known.length > 0) lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)
  lines.push(...rangeSpecMissingBounds(value, range, lower, upper, missing))
  return lines.join('\n')
}

export function rangeSpecMissingBounds(
  value: ReportNumberValue,
  range: FitRange,
  lower: ReportNumberValue,
  upper: ReportNumberValue,
  missing: {lower: boolean; upper: boolean; integer: boolean},
) {
  const name = exprText(value)
  const lines: string[] = []
  if (missing.lower) lines.push(`missing: ${name} ${range.lowerInclusive ? '>=' : '>'} ${exprText(lower)}`)
  if (missing.upper) lines.push(`missing: ${name} ${range.upperInclusive ? '<=' : '<'} ${exprText(upper)}`)
  if (missing.integer) lines.push(`missing: ${name} is an integer`)
  return lines
}

export function finiteRangeSpecFailureReason(
  value: ReportNumberValue,
  range: FitRange,
  producedValues: number[] | null,
) {
  const expectedRange = formatRangeSpec(range)
  const lines = [
    `value was ${formatRange(value)}, expected one of ${expectedRange}`,
  ]
  if (producedValues != null) lines.push(`branches produced ${producedValues.map(formatNumber).join(', ')}`)
  lines.push(`missing: ${exprText(value)} in {${(range.finiteValues ?? []).map(formatNumber).join(', ')}}`)
  return lines.join('\n')
}

export function comparisonNeed(left: ReportNumberValue, op: ComparisonOperator, right: ReportNumberValue) {
  return `${exprText(left)} ${op} ${exprText(right)}`
}

export function formatArraySummary(value: ReportArrayValue) {
  if (value.summary == null) return 'no sequence facts'
  const lines: string[] = []
  for (const prop of value.summary.nondecreasingProps) lines.push(`nondecreasing(.${prop})`)
  for (const fact of value.summary.spaced) lines.push(`spaced(${publicFitText(fact.gapExpr)})`)
  if (value.summary.lastEnd != null) lines.push(`lastEnd = ${formatRange(value.summary.lastEnd)}`)
  return lines.length === 0 ? 'no sequence facts' : lines.join(', ')
}

export function formatRange(value: ReportNumberValue) {
  const expr = value.expr == null ? null : publicFitText(value.expr)
  if (expr != null && value.min === value.max && Number.isFinite(value.min) && expr === formatNumber(value.min)) return expr
  const range = formatExpectedRange(value.min, value.max, value.isInteger)
  return expr == null ? range : `${range} as ${expr}`
}

function exprText(value: ReportNumberValue) {
  return value.expr == null ? formatRange(value) : publicFitText(value.expr)
}

export function formatExpectedRange(min: number, max: number, isInteger: boolean) {
  if (min === -Infinity && max === Infinity) return isInteger ? 'any integer' : 'any number'
  const prefix = isInteger ? 'int ' : ''
  return `${prefix}${formatNumber(min)}..${formatNumber(max)}`
}

export function formatRangeSpec(range: FitRange) {
  if (range.finiteValues != null) return publicFitText(range.text)
  const prefix = range.valueKind === 'int' ? 'int ' : ''
  return publicFitText(`${prefix}${range.lower}${range.upperInclusive ? '..' : '..<'}${range.upper}`)
}

export function formatLinearConstraint(constraint: ReportLinearConstraint): string {
  if (constraint.diff == null) {
    const left = constraint.leftExpr == null ? '?' : publicFitText(constraint.leftExpr)
    const right = constraint.rightExpr == null ? '?' : publicFitText(constraint.rightExpr)
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
    parts.push(formatLinearTerm(coefficient, publicFitText(name), parts.length === 0))
  }
  if (clean.constant !== 0 || parts.length === 0) parts.push(formatLinearTerm(clean.constant, '', parts.length === 0))
  return parts.join(' ')
}

function knownProofContext(left: ReportNumberValue, right: ReportNumberValue, assumptions: ReportLinearConstraint[]) {
  return knownProofContextMany([left, right], assumptions)
}

function knownProofContextMany(values: ReportNumberValue[], assumptions: ReportLinearConstraint[]) {
  const lines = values.flatMap(knownValueFacts)
  for (const assumption of assumptions) {
    lines.push(formatKnownFact(assumption))
  }
  return [...new Set(lines)]
}

function knownValueFacts(value: ReportNumberValue) {
  const fact = knownValueFact(value)
  return [...(fact == null ? [] : [fact]), ...(value.provenance ?? [])]
}

function knownValueFact(value: ReportNumberValue) {
  const expr = value.expr == null ? null : publicFitText(value.expr)
  if (expr != null && value.min === value.max && Number.isFinite(value.min) && expr === formatNumber(value.min)) return null
  if (expr == null) return formatRange(value)
  return `${expr}: ${formatExpectedRange(value.min, value.max, value.isInteger)}`
}

function formatMissingComparison(missing: string) {
  return missing.startsWith('given ')
    ? `missing fact: ${missing.slice('given '.length)}`
    : `missing: ${missing}`
}

function formatKnownFact(assumption: ReportLinearConstraint): string {
  const fact = publicFitText(assumption.text ?? formatLinearConstraint(assumption))
  switch (assumption.source) {
    case 'function-given':
      return `assumed from input: ${fact}`
    case 'loop-given':
      return `assumed from loop @fit: ${fact}`
    case 'code':
      return `inferred from code: ${fact}`
    case 'branch':
      return `inferred from branch: ${fact}`
    case 'contract':
      return fact
  }
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
