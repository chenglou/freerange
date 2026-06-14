import {
  publicFitText,
} from './parser.ts'
import {
  formatArraySummary,
  formatKnownProofFact,
  knownValueFacts,
} from './reporting.ts'
import {
  arrayElement,
  arrayLength,
} from './domain.ts'
import type {
  Assumption,
  LinearConstraint,
  LiteralValue,
  NumberValue,
  Value,
} from './domain-types.ts'

export function proofFactsFromValues(values: Value[], assumptions: Assumption[]) {
  const facts: string[] = []
  for (const value of values) facts.push(...proofFactsFromValue(value))
  for (const assumption of assumptions) facts.push(formatAssumptionFact(assumption))
  return [...new Set(facts)]
}

function proofFactsFromValue(value: Value): string[] {
  if (value.kind === 'number') return proofFactsFromNumber(value)
  if (value.kind === 'literal') return proofFactsFromLiteral(value)
  if (value.kind === 'array') {
    const element = arrayElement(value)
    return [
      `sequence facts: ${formatArraySummary(value)}`,
      ...proofFactsFromNumber(arrayLength(value)),
      ...(element == null ? [] : proofFactsFromValue(element)),
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
  const facts = [...proofFactsFromOrigin(value.origin)]
  if (value.expr != null) facts.unshift(`${publicFitText(value.expr)}: ${value.values.map(String).join(' | ')}`)
  return facts
}

function proofFactsFromOrigin(origin: string[]) {
  return origin.map(publicFitText)
}

function formatAssumptionFact(assumption: LinearConstraint): string {
  return formatKnownProofFact(assumption)
}
