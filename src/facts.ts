import {
  type NumberValue,
  type Value,
} from './domain.ts'
import {sameExpressionText} from './linear.ts'
import {formatExpectedRange} from './reporting.ts'

export type FitInferFact = FitRangeFact | FitEqualityFact | FitSequenceFact

export type FitRangeFact = {
  kind: 'range'
  source: 'range'
  text: string
  path: string
  min: number
  max: number
  isInteger: boolean
}

export type FitEqualityFact = {
  kind: 'equality'
  source: 'equality'
  text: string
  path: string
  expression: string
}

export type FitSequenceFact = {
  kind: 'sequence'
  source: 'sequence'
  text: string
  fact:
    | {kind: 'nondecreasing'; path: string; prop: string}
    | {kind: 'spaced'; path: string; gapExpr: string; heightExpr: string; advanceExpr: string}
}

export function localFactsFromEnv(baseEnv: Map<string, Value>, finalEnv: Map<string, Value>): FitInferFact[] {
  const facts: FitInferFact[] = []
  for (const [name, value] of finalEnv) {
    if (baseEnv.has(name) || name === 'result') continue
    facts.push(...factsFromValue(name, value))
  }
  return facts
}

export function factsFromValue(path: string, value: Value): FitInferFact[] {
  if (value.kind === 'unknown') return []
  if (value.kind === 'number') return numberFacts(path, value)
  if (value.kind === 'object') {
    const facts: FitInferFact[] = []
    for (const [name, prop] of [...value.props.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      facts.push(...factsFromValue(`${path}.${name}`, prop))
    }
    return facts
  }

  const facts = numberFacts(`${path}.length`, value.length)
  if (value.element != null) facts.push(...factsFromValue(`${path}[]`, value.element))
  if (value.summary != null) {
    for (const prop of value.summary.nondecreasingProps) {
      facts.push({
        kind: 'sequence',
        source: 'sequence',
        text: `nondecreasing(${path}.${prop})`,
        fact: {kind: 'nondecreasing', path, prop},
      })
    }
    for (const fact of value.summary.spaced) {
      facts.push({
        kind: 'sequence',
        source: 'sequence',
        text: `spaced(${path}, ${fact.gapExpr})`,
        fact: {kind: 'spaced', path, gapExpr: fact.gapExpr, heightExpr: fact.heightExpr, advanceExpr: fact.advanceExpr},
      })
    }
    if (value.summary.lastEnd != null) {
      facts.push(...numberFacts(`lastEnd(${path})`, value.summary.lastEnd))
    }
    for (const fact of value.summary.extentEnds) {
      facts.push(...numberFacts(`extentEnd(${path}, ${fact.emptyExpr})`, fact.value))
    }
  }
  return facts
}

export function factsFromEnvRoots(env: Map<string, Value>, roots: Set<string>): FitInferFact[] {
  const facts: FitInferFact[] = []
  for (const name of [...roots].sort()) {
    const value = env.get(name)
    if (value == null) continue
    facts.push(...factsFromValue(name, value))
  }
  return uniqueFacts(facts)
}

export function numberFacts(path: string, value: NumberValue): FitInferFact[] {
  const facts: FitInferFact[] = []
  if (value.expr != null && !sameExpressionText(path, value.expr)) {
    facts.push({kind: 'equality', source: 'equality', text: `${path} == ${value.expr}`, path, expression: value.expr})
  }
  if (isInterestingNumberRange(value)) {
    facts.push({
      kind: 'range',
      source: 'range',
      text: `${path}: ${formatExpectedRange(value.min, value.max, value.isInteger)}`,
      path,
      min: value.min,
      max: value.max,
      isInteger: value.isInteger,
    })
  }
  return facts
}

export function uniqueFacts(facts: FitInferFact[]): FitInferFact[] {
  const seen = new Set<string>()
  const unique: FitInferFact[] = []
  for (const fact of facts) {
    const key = `${fact.source}:${fact.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(fact)
  }
  return unique
}

function isInterestingNumberRange(value: NumberValue) {
  if (value.min === Number.NEGATIVE_INFINITY && value.max === Number.POSITIVE_INFINITY) return false
  return true
}
