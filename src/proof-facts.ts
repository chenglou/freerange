import {
  publicFitText,
  type ComparisonOperator,
} from './parser.ts'
import {
  formatRange,
  formatKnownProofFact,
  knownValueFacts,
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
  return knownValueFacts(value)
}

function proofFactsFromLiteral(value: LiteralValue) {
  const facts = [...proofFactsFromProvenance(value.provenance)]
  if (value.expr != null) facts.unshift(`${publicFitText(value.expr)}: ${value.values.map(String).join(' | ')}`)
  return facts
}

function proofFactsFromProvenance(provenance: string[]) {
  return provenance.map(publicFitText)
}

function formatAssumptionFact(assumption: LinearConstraint): string {
  return formatKnownProofFact(assumption)
}

export function proofFactForComparison(left: NumberValue, op: ComparisonOperator, right: NumberValue) {
  return `${publicFitText(left.expr ?? formatRange(left))} ${op} ${publicFitText(right.expr ?? formatRange(right))}`
}
