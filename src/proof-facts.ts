import {
  publicFitText,
  type ComparisonOperator,
} from './parser.ts'
import {
  formatExpectedRange,
  formatLinearConstraint,
  formatRange,
} from './reporting.ts'
import type {
  LinearConstraint,
  LiteralValue,
  NumberValue,
  Value,
} from './domain.ts'

export function proofFactsFromValues(values: Value[], assumptions: LinearConstraint[]) {
  const facts: string[] = []
  for (const value of values) facts.push(...proofFactsFromValue(value))
  for (const assumption of assumptions) facts.push(formatAssumptionFact(assumption))
  return [...new Set(facts)]
}

function proofFactsFromValue(value: Value): string[] {
  if (value.kind === 'number') return proofFactsFromNumber(value)
  if (value.kind === 'literal') return proofFactsFromLiteral(value)
  if (value.kind === 'array') {
    return [
      ...proofFactsFromNumber(value.length),
      ...(value.element == null ? [] : proofFactsFromValue(value.element)),
    ]
  }
  if (value.kind === 'object') return [...value.props.values()].flatMap(proofFactsFromValue)
  if (value.kind === 'nullable') return proofFactsFromValue(value.present)
  return []
}

function proofFactsFromNumber(value: NumberValue) {
  const facts = [...proofFactsFromProvenance(value.provenance)]
  const fact = knownNumberFact(value)
  if (fact != null) facts.unshift(fact)
  return facts
}

function proofFactsFromLiteral(value: LiteralValue) {
  const facts = [...proofFactsFromProvenance(value.provenance)]
  if (value.expr != null) facts.unshift(`${publicFitText(value.expr)}: ${value.values.map(String).join(' | ')}`)
  return facts
}

function proofFactsFromProvenance(provenance: string[]) {
  return provenance.map(publicFitText)
}

function knownNumberFact(value: NumberValue) {
  const expr = value.expr == null ? null : publicFitText(value.expr)
  if (expr != null && value.min === value.max && Number.isFinite(value.min) && expr === String(value.min)) return null
  if (expr == null) return formatRange(value)
  return `${expr}: ${formatExpectedRange(value.min, value.max, value.isInteger)}`
}

function formatAssumptionFact(assumption: LinearConstraint): string {
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

export function proofFactForComparison(left: NumberValue, op: ComparisonOperator, right: NumberValue) {
  return `${publicFitText(left.expr ?? formatRange(left))} ${op} ${publicFitText(right.expr ?? formatRange(right))}`
}
