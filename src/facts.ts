// Naming split: `*Constraint*` is internal proof state (LinearConstraint, NonNegativeConstraint, ConstraintSource); `*Fact*` is user-facing inference output that `fr infer` shows. They live on different sides of the checker and should not be confused.
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
import {formatRange} from './reporting.ts'
import {
  nondecreasingPropsFromRelations,
  sequenceRelationText,
  spacedShapesFromRelations,
} from './sequence-facts.ts'

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

export type FitFactOrigin =
  | {kind: 'source'; label?: string}
  | {kind: 'given'; label?: string}
  | {kind: 'branch'; label?: string}
  | {kind: 'contract'; label?: string}
  | {kind: 'loop-summary'; label?: string}
  | {kind: 'ambient'; label?: string}

export type PublishedFact = FitInferFact & {
  id: string
  origin: FitFactOrigin
  subject?: string
}

export class FactInventory {
  readonly facts: PublishedFact[] = []
  readonly byKind = new Map<FitInferFact['kind'], PublishedFact[]>()
  readonly bySubject = new Map<string, PublishedFact[]>()

  add(fact: FitInferFact, origin: FitFactOrigin, subject?: string): PublishedFact {
    const published: PublishedFact = {
      ...fact,
      id: factId(fact, origin, subject),
      origin,
      ...(subject == null ? {} : {subject}),
    }
    if (this.facts.some(existing => existing.id === published.id)) return published
    this.facts.push(published)
    const kindFacts = this.byKind.get(published.kind) ?? []
    kindFacts.push(published)
    this.byKind.set(published.kind, kindFacts)
    if (subject != null) {
      const subjectFacts = this.bySubject.get(subject) ?? []
      subjectFacts.push(published)
      this.bySubject.set(subject, subjectFacts)
    }
    return published
  }

  addMany(facts: FitInferFact[], origin: FitFactOrigin, subject?: string) {
    for (const fact of facts) this.add(fact, origin, subject)
  }

  inferFacts(): FitInferFact[] {
    return this.facts.map(stripPublishedFact)
  }
}

export function createFactInventory() {
  return new FactInventory()
}

export function uniqueInferFacts(facts: FitInferFact[]): FitInferFact[] {
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

function stripPublishedFact(fact: PublishedFact): FitInferFact {
  const {id: _id, origin: _origin, subject: _subject, ...inferFact} = fact
  return inferFact
}

function factId(fact: FitInferFact, origin: FitFactOrigin, subject: string | undefined) {
  return [
    fact.kind,
    fact.source,
    subject ?? '',
    origin.kind,
    origin.label ?? '',
    fact.text,
  ].join('\0')
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
  return factInventoryFromValue(path, value).inferFacts()
}

export function factInventoryFromValue(path: string, value: Value): FactInventory {
  const inventory = createFactInventory()
  addFactsFromValue(inventory, path, value)
  return inventory
}

function addFactsFromValue(inventory: FactInventory, path: string, value: Value) {
  if (value.kind === 'unknown') return
  if (value.kind === 'null' || value.kind === 'nullable') return
  if (value.kind === 'literal') return
  if (value.kind === 'number') {
    inventory.addMany(numberFacts(path, value), {kind: 'source'}, publicFitText(path))
    return
  }
  if (value.kind === 'object') {
    for (const [name, prop] of [...value.props.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      addFactsFromValue(inventory, `${path}.${name}`, prop)
    }
    return
  }

  inventory.addMany(numberFacts(`${path}.length`, value.length), {kind: 'source'}, publicFitText(`${path}.length`))
  if (value.element != null) addFactsFromValue(inventory, `${path}[]`, value.element)
  if (value.summary != null) {
    if (value.summary.origin != null) {
      const sourcePath = publicFitText(value.summary.origin.sourceExpr)
      inventory.add({
        kind: 'origin',
        source: 'origin',
        text: value.summary.origin.kind === 'identity'
          ? `${publicFitText(path)} follows ${sourcePath} by index`
          : `${publicFitText(path)} is an order-preserving subset of ${sourcePath}`,
        fact: {kind: value.summary.origin.kind, path: publicFitText(path), sourcePath},
      }, {kind: 'loop-summary'}, publicFitText(path))
    }
    for (const prop of nondecreasingPropsFromRelations(value.summary.relations)) {
      inventory.add({
        kind: 'sequence',
        source: 'sequence',
        text: publicFitText(`nondecreasing(${path}.${prop})`),
        fact: {kind: 'nondecreasing', path, prop},
      }, {kind: 'loop-summary'}, publicFitText(path))
    }
    for (const fact of spacedShapesFromRelations(value.summary.relations)) {
      inventory.add({
        kind: 'sequence',
        source: 'sequence',
        text: publicFitText(`spaced(${path}, ${fact.gapExpr})`),
        fact: {kind: 'spaced', path, gapExpr: fact.gapExpr, heightExpr: fact.heightExpr, advanceExpr: fact.advanceExpr},
      }, {kind: 'loop-summary'}, publicFitText(path))
    }
    for (const relation of value.summary.relations) {
      if (relation.op !== '==') continue
      inventory.add({
        kind: 'sequence',
        source: 'sequence',
        text: publicFitText(sequenceRelationText(path, relation)),
        fact: {kind: 'adjacent-comparison'},
      }, {kind: 'loop-summary'}, publicFitText(path))
    }
    if (value.summary.lastEnd != null) {
      inventory.addMany(numberFacts(`lastEnd(${path})`, value.summary.lastEnd), {kind: 'loop-summary'}, publicFitText(path))
    }
    for (const fact of value.summary.extentEnds) {
      inventory.addMany(numberFacts(`extentEnd(${path}, ${fact.emptyExpr})`, fact.value), {kind: 'loop-summary'}, publicFitText(path))
    }
  }
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
      text: publicFitText(`${path}: ${formatRange({...value, expr: null})}`),
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
  return uniqueInferFacts(facts)
}

function isInterestingNumberRange(value: NumberValue) {
  if (value.min === Number.NEGATIVE_INFINITY && value.max === Number.POSITIVE_INFINITY) return false
  return true
}
