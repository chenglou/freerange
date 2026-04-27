import {
  fitReturnInternalRoot,
  publicFitText,
} from './parser.ts'
import {
  finiteNumberSet,
  type NumberValue,
  type Value,
} from './domain.ts'
import {sameExpressionText} from './linear.ts'
import {formatExpectedRange} from './reporting.ts'
import {sequenceRelationText} from './sequence-facts.ts'

export type FitInferFact = FitRangeFact | FitEqualityFact | FitSequenceFact | FitOriginFact

export type FitRangeFact = {
  kind: 'range'
  source: 'range'
  text: string
  path: string
  min: number
  max: number
  isInteger: boolean
  values?: number[]
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
    | {kind: 'adjacent-comparison'}
}

export type FitOriginFact = {
  kind: 'origin'
  source: 'origin'
  text: string
  fact:
    | {kind: 'identity'; path: string; sourcePath: string}
    | {kind: 'subsequence'; path: string; sourcePath: string}
}

export function localFactsFromEnv(baseEnv: Map<string, Value>, finalEnv: Map<string, Value>): FitInferFact[] {
  const facts: FitInferFact[] = []
  for (const [name, value] of finalEnv) {
    if (baseEnv.has(name) || name === fitReturnInternalRoot) continue
    facts.push(...factsFromValue(name, value))
  }
  return facts
}

export function factsFromValue(path: string, value: Value): FitInferFact[] {
  if (value.kind === 'unknown') return []
  if (value.kind === 'null' || value.kind === 'nullable') return []
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
    if (value.summary.origin != null) {
      const sourcePath = publicFitText(value.summary.origin.sourceExpr)
      facts.push({
        kind: 'origin',
        source: 'origin',
        text: value.summary.origin.kind === 'identity'
          ? `${publicFitText(path)} follows ${sourcePath} by index`
          : `${publicFitText(path)} is an order-preserving subset of ${sourcePath}`,
        fact: {kind: value.summary.origin.kind, path: publicFitText(path), sourcePath},
      })
    }
    for (const prop of value.summary.nondecreasingProps) {
      facts.push({
        kind: 'sequence',
        source: 'sequence',
        text: publicFitText(`nondecreasing(${path}.${prop})`),
        fact: {kind: 'nondecreasing', path, prop},
      })
    }
    for (const fact of value.summary.spaced) {
      facts.push({
        kind: 'sequence',
        source: 'sequence',
        text: publicFitText(`spaced(${path}, ${fact.gapExpr})`),
        fact: {kind: 'spaced', path, gapExpr: fact.gapExpr, heightExpr: fact.heightExpr, advanceExpr: fact.advanceExpr},
      })
    }
    for (const relation of value.summary.relations) {
      if (relation.op !== '==') continue
      facts.push({
        kind: 'sequence',
        source: 'sequence',
        text: publicFitText(sequenceRelationText(path, relation)),
        fact: {kind: 'adjacent-comparison'},
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
    facts.push({kind: 'equality', source: 'equality', text: publicFitText(`${path} == ${value.expr}`), path: publicFitText(path), expression: publicFitText(value.expr)})
  }
  const finite = finiteNumberSet(value)
  if (finite != null && finite.length > 1) {
    facts.push({
      kind: 'range',
      source: 'range',
      text: publicFitText(`${path}: ${finite.map(formatNumber).join(' | ')}`),
      path: publicFitText(path),
      min: finite[0]!,
      max: finite[finite.length - 1]!,
      isInteger: finite.every(Number.isInteger),
      values: finite,
    })
    return facts
  }
  if (isInterestingNumberRange(value)) {
    facts.push({
      kind: 'range',
      source: 'range',
      text: publicFitText(`${path}: ${formatExpectedRange(value.min, value.max, value.isInteger)}`),
      path: publicFitText(path),
      min: value.min,
      max: value.max,
      isInteger: value.isInteger,
    })
  }
  return facts
}

function formatNumber(value: number) {
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  return String(value)
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
