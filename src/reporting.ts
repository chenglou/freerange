import * as ts from 'typescript'
import {parseExpression, publicFitText, publicLinearName, type ComparisonOperator, type FitRange} from './parser.ts'
import {rationalIsNegative, rationalIsZero, rationalToNumber, type Rational} from './numeric/rational.ts'
import type {SequenceRelation} from './domain-types.ts'
import {
  nondecreasingPropsFromRelations,
  spacedShapesFromRelations,
} from './sequence-facts.ts'

export type ReportNumberValue = {
  min: number
  max: number
  grid: number | null
  nan?: 'excluded' | 'possible'
  expr: string | null
  linear: ReportLinearExpr | null
  cases?: {value: ReportNumberValue; assumptions: unknown[]; branches?: unknown[]}[] | null
  origin?: string[]
}

export type ReportLinearExpr = {
  constant: Rational
  terms: Map<string, Rational>
}

export type ReportLinearConstraint = {
  diff: ReportLinearExpr | null
  op: ComparisonOperator
  text?: string
  leftExpr?: string
  rightExpr?: string
  source: ConstraintSource
  fromRange?: true
}

export type ConstraintSource = 'function-given' | 'loop-given' | 'code' | 'branch' | 'contract'

export type ReportArrayValue = {
  kind?: 'array'
  summary?: {
    relations: SequenceRelation[]
    advances: {prop: string; value: ReportNumberValue}[]
    lastEnd: {value: ReportNumberValue} | null
    extentEnds: {emptyExpr: string; value: ReportNumberValue}[]
  } | null
}

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
  const lines = new Set<string>()
  for (const prop of nondecreasingPropsFromRelations(value.summary.relations)) {
    lines.add(prop.length === 0 ? 'nondecreasing(values)' : `nondecreasing(.${prop})`)
  }
  for (const fact of spacedShapesFromRelations(value.summary.relations)) lines.add(`spaced(${publicFitText(fact.gapExpr)})`)
  if (value.summary.lastEnd != null) lines.add(`lastEnd = ${formatRange(value.summary.lastEnd.value)}`)
  return lines.size === 0 ? 'no sequence facts' : [...lines].join(', ')
}

export function formatRange(value: ReportNumberValue) {
  const expr = value.expr == null ? null : publicFitText(value.expr)
  if (expr != null && value.min === value.max && Number.isFinite(value.min) && expr === formatNumber(value.min)) return expr
  const range = formatNumberValueRange(value)
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

function formatNumberValueRange(value: ReportNumberValue) {
  const cases = value.cases ?? []
  // Cases are honest alternatives only when no assumption distinguishes
  // them: function-level givens land on every case alike, while a
  // branch-specific condition on one case makes the plain `a | b` listing
  // misleading. Compare by identity — tagging shares the constraint objects.
  const sharedByAll = (assumption: unknown) => cases.every(item => item.assumptions.includes(assumption))
  const structuralAlternatives = cases.every(item =>
    (item.branches?.length ?? 0) > 0
    && item.value.min === item.value.max)
  if (
    cases.length > 1
    && (structuralAlternatives || cases.every(item => item.assumptions.every(sharedByAll)))
  ) {
    const alternatives = cases
      .map(item => item.value)
      .filter((candidate, index, values) =>
        !values.some((other, otherIndex) =>
          otherIndex !== index
          && numberRangeContains(other, candidate)
          && (!numberRangeContains(candidate, other) || otherIndex < index)))
      .sort((left, right) => left.min - right.min || left.max - right.max)
    return [...new Set(alternatives.map(formatNumberRangePart))].join(' | ')
  }
  if (value.min === -Infinity && value.max === Infinity && value.nan === 'excluded') {
    return value.grid != null && value.grid >= 0 ? 'any non-NaN integer' : 'any non-NaN number'
  }
  return formatExpectedRange(value.min, value.max, value.grid != null && value.grid >= 0)
}

function numberRangeContains(container: ReportNumberValue, contained: ReportNumberValue) {
  if (container.min > contained.min || container.max < contained.max) return false
  if (container.grid == null) return true
  return contained.grid != null && contained.grid >= container.grid
}

function formatNumberRangePart(value: ReportNumberValue) {
  if (value.min === -Infinity && value.max === Infinity && value.nan === 'excluded') {
    return value.grid != null && value.grid >= 0 ? 'any non-NaN integer' : 'any non-NaN number'
  }
  return value.min === value.max && Number.isFinite(value.min)
    ? formatNumber(value.min)
    : formatExpectedRange(value.min, value.max, value.grid != null && value.grid >= 0)
}

export function formatRangeSpec(range: FitRange) {
  return publicFitText(range.text)
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
  const parts: string[] = []
  for (const [name, coefficient] of [...linear.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (rationalIsZero(coefficient)) continue
    parts.push(formatLinearTerm(coefficient, publicFitText(name), parts.length === 0))
  }
  if (!rationalIsZero(linear.constant) || parts.length === 0) parts.push(formatLinearTerm(linear.constant, '', parts.length === 0))
  return parts.join(' ')
}

function knownProofContext(left: ReportNumberValue, right: ReportNumberValue, assumptions: ReportLinearConstraint[]) {
  return knownProofContextMany([left, right], assumptions)
}

export function knownProofContextMany(values: ReportNumberValue[], assumptions: ReportLinearConstraint[]) {
  const lines = values.flatMap(knownValueFacts)
  for (const assumption of assumptions) {
    lines.push(formatKnownProofFact(assumption))
  }
  return [...new Set(lines)]
}

export function knownValueFacts(value: ReportNumberValue) {
  const fact = knownValueFact(value)
  return [...(fact == null ? [] : [fact]), ...(value.origin ?? [])]
}

function knownValueFact(value: ReportNumberValue) {
  const expr = value.expr == null ? null : publicFitText(value.expr)
  if (expr != null && value.min === value.max && Number.isFinite(value.min) && expr === formatNumber(value.min)) return null
  if (expr == null) return formatRange(value)
  return `${expr}: ${formatNumberValueRange(value)}`
}

function formatMissingComparison(missing: string) {
  return missing.startsWith('given ')
    ? `missing fact: ${missing.slice('given '.length)}`
    : `missing: ${missing}`
}

export function formatKnownProofFact(assumption: ReportLinearConstraint): string {
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

function formatLinearTerm(coefficient: Rational, name: string, first: boolean) {
  const sign = rationalIsNegative(coefficient) ? '-' : '+'
  // Display rounds; proofs never do.
  const amount = Math.abs(rationalToNumber(coefficient))
  const formattedName = formattedLinearName(name)
  const body = name.length === 0 ? formatNumber(amount) : amount === 1 ? formattedName : `${formatNumber(amount)} * ${formattedName}`
  return first ? (sign === '-' ? `-${body}` : body) : `${sign} ${body}`
}

function formattedLinearName(name: string): string {
  const publicName = publicLinearName(name)
  const text = publicFitText(publicName)
  if (publicName.length === 0) return text
  try {
    const expression = parseExpression(publicName)
    return ts.isBinaryExpression(expression) || ts.isConditionalExpression(expression)
      ? `(${text})`
      : text
  } catch {
    return text
  }
}

export function formatNumber(value: number) {
  return Number.isInteger(value) ? `${value}` : `${value}`
}
