import * as ts from 'typescript'
import type {
  SequenceAddition,
  SequenceExpression,
  SequenceRelation,
  SequenceTerm,
} from './domain-types.ts'
import {expressionKeyFromText, sameExpressionText} from './linear.ts'
import {parseExpression} from './parser.ts'

export function sameSequenceRelation(left: SequenceRelation, right: SequenceRelation): boolean {
  if (left.kind !== right.kind || !sameSequenceTerm(left.left, right.left) || left.op !== right.op) return false
  return left.kind === 'adjacent-comparison' && right.kind === 'adjacent-comparison'
    ? sameSequenceExpression(left.right, right.right)
    : left.kind === 'adjacent-addition' && right.kind === 'adjacent-addition'
      && sameSequenceAddition(left.right, right.right)
}

export function sameSequenceExpression(left: SequenceExpression, right: SequenceExpression): boolean {
  return sameUnordered(left.terms, right.terms, sameSequenceTerm)
    && sameUnordered(left.addends, right.addends, sameExpressionText)
}

export function sameSequenceAddition(
  left: SequenceAddition,
  right: SequenceAddition,
  sameInvariant: (left: string, right: string) => boolean = sameExpressionText,
): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'term':
      return right.kind === 'term' && sameSequenceTerm(left.term, right.term)
    case 'invariant':
      return right.kind === 'invariant' && sameInvariant(left.text, right.text)
    case 'add':
      if (right.kind !== 'add') return false
      return (
        sameSequenceAddition(left.left, right.left, sameInvariant)
        && sameSequenceAddition(left.right, right.right, sameInvariant)
      ) || (
        sameSequenceAddition(left.left, right.right, sameInvariant)
        && sameSequenceAddition(left.right, right.left, sameInvariant)
      )
  }
}

export function mapSequenceAddition(
  addition: SequenceAddition,
  mapTerm: (term: SequenceTerm) => SequenceTerm | null,
  mapInvariant: (text: string) => string = text => text,
): SequenceAddition | null {
  switch (addition.kind) {
    case 'term': {
      const term = mapTerm(addition.term)
      return term == null ? null : {kind: 'term', term}
    }
    case 'invariant':
      return {kind: 'invariant', text: mapInvariant(addition.text)}
    case 'add': {
      const left = mapSequenceAddition(addition.left, mapTerm, mapInvariant)
      const right = mapSequenceAddition(addition.right, mapTerm, mapInvariant)
      return left == null || right == null ? null : {kind: 'add', left, right}
    }
  }
}

export function sequenceAdditionTerms(addition: SequenceAddition): SequenceTerm[] {
  switch (addition.kind) {
    case 'term':
      return [addition.term]
    case 'invariant':
      return []
    case 'add':
      return [...sequenceAdditionTerms(addition.left), ...sequenceAdditionTerms(addition.right)]
  }
}

export function sequenceAdditionInvariants(addition: SequenceAddition): string[] {
  switch (addition.kind) {
    case 'term':
      return []
    case 'invariant':
      return [addition.text]
    case 'add':
      return [...sequenceAdditionInvariants(addition.left), ...sequenceAdditionInvariants(addition.right)]
  }
}

export function sequenceAdditionText(
  addition: SequenceAddition,
  termText: (term: SequenceTerm) => string,
  nested = false,
): string {
  switch (addition.kind) {
    case 'term':
      return termText(addition.term)
    case 'invariant':
      return groupedInvariantText(addition.text)
    case 'add': {
      const text = `${sequenceAdditionText(addition.left, termText, true)} + ${sequenceAdditionText(addition.right, termText, true)}`
      return nested ? `(${text})` : text
    }
  }
}

export function sameSequenceTerm(left: SequenceTerm, right: SequenceTerm): boolean {
  return left.item === right.item
    && samePath(left.path, right.path)
}

export function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

export function canonicalSequenceRelation(relation: SequenceRelation): SequenceRelation {
  if (relation.kind === 'adjacent-comparison') {
    return {
      ...relation,
      right: {
        terms: [...relation.right.terms].sort((left, right) => sequenceTermKey(left).localeCompare(sequenceTermKey(right))),
        addends: [...relation.right.addends].sort((left, right) => expressionKeyFromText(left).localeCompare(expressionKeyFromText(right))),
      },
    }
  }
  return relation
}

export function sequenceRelationKey(relation: SequenceRelation): string {
  const canonical = canonicalSequenceRelation(relation)
  const left = sequenceTermKey(canonical.left)
  if (canonical.kind === 'adjacent-comparison') {
    const terms = canonical.right.terms.map(sequenceTermKey).join(',')
    const addends = canonical.right.addends.map(expressionKeyFromText).join(',')
    return `${canonical.kind}|${left}|${canonical.op}|${terms}|${addends}`
  }
  return `${canonical.kind}|${left}|${canonical.op}|${sequenceAdditionKey(canonical.right)}`
}

export function preferredEquivalentExpression(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? left : right
}

export function mergeEquivalentSequenceAddition(
  left: SequenceAddition,
  right: SequenceAddition,
): SequenceAddition | null {
  if (left.kind !== right.kind) return null
  switch (left.kind) {
    case 'term':
      return right.kind === 'term' && sameSequenceTerm(left.term, right.term)
        ? left
        : null
    case 'invariant':
      return right.kind === 'invariant' && sameExpressionText(left.text, right.text)
        ? {kind: 'invariant', text: preferredEquivalentExpression(left.text, right.text)}
        : null
    case 'add': {
      if (right.kind !== 'add') return null
      const directLeft = mergeEquivalentSequenceAddition(left.left, right.left)
      const directRight = mergeEquivalentSequenceAddition(left.right, right.right)
      if (directLeft != null && directRight != null) {
        return canonicalSequenceAddition({kind: 'add', left: directLeft, right: directRight})
      }
      const swappedLeft = mergeEquivalentSequenceAddition(left.left, right.right)
      const swappedRight = mergeEquivalentSequenceAddition(left.right, right.left)
      return swappedLeft == null || swappedRight == null
        ? null
        : canonicalSequenceAddition({kind: 'add', left: swappedLeft, right: swappedRight})
    }
  }
}

function canonicalSequenceAddition(addition: SequenceAddition): SequenceAddition {
  if (addition.kind !== 'add') return addition
  const left = canonicalSequenceAddition(addition.left)
  const right = canonicalSequenceAddition(addition.right)
  return sequenceAdditionKey(left).localeCompare(sequenceAdditionKey(right)) <= 0
    ? {kind: 'add', left, right}
    : {kind: 'add', left: right, right: left}
}

function sequenceAdditionKey(addition: SequenceAddition): string {
  switch (addition.kind) {
    case 'term':
      return `term:${sequenceTermKey(addition.term)}`
    case 'invariant':
      return `invariant:${expressionKeyFromText(addition.text)}`
    case 'add': {
      const left = sequenceAdditionKey(addition.left)
      const right = sequenceAdditionKey(addition.right)
      return left.localeCompare(right) <= 0
        ? `add:${left}+${right}`
        : `add:${right}+${left}`
    }
  }
}

function sequenceTermKey(term: SequenceTerm): string {
  return `${term.item}:${term.path.join('.')}`
}

function groupedInvariantText(text: string): string {
  try {
    const expression = parseExpression(text)
    return ts.isBinaryExpression(expression) || ts.isConditionalExpression(expression)
      ? `(${text})`
      : text
  } catch {
    return text
  }
}

function sameUnordered<T>(left: T[], right: T[], same: (left: T, right: T) => boolean): boolean {
  if (left.length !== right.length) return false
  const unmatched = [...right]
  for (const item of left) {
    const index = unmatched.findIndex(candidate => same(item, candidate))
    if (index < 0) return false
    unmatched.splice(index, 1)
  }
  return true
}
