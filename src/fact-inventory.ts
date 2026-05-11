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
