import type {
  ArrayOrigin,
  ArraySummary,
  ArrayValue,
  SequenceExpression,
  SequenceRelation,
  SequenceTerm,
} from './domain-types.ts'
import {sameExpressionText} from './linear.ts'

export function mapOrigin(source: ArrayValue, sourceExpr: string): ArrayOrigin {
  const origin = source.summary?.origin
  if (origin?.kind === 'subsequence') return {kind: 'subsequence', sourceExpr: origin.sourceExpr}
  if (origin?.kind === 'identity') return {kind: 'identity', sourceExpr: origin.sourceExpr}
  return {kind: 'identity', sourceExpr}
}

export function filterOrigin(source: ArrayValue, sourceExpr: string): ArrayOrigin {
  return {kind: 'subsequence', sourceExpr: source.summary?.origin?.sourceExpr ?? sourceExpr}
}

export function emptyArraySummary(origin: ArrayOrigin | null): ArraySummary {
  return {
    origin,
    relations: [],
    nondecreasingProps: [],
    advances: [],
    spaced: [],
    lastEnd: null,
    extentEnds: [],
  }
}

export function mergeArraySummary(left: ArraySummary | null, right: ArraySummary | null): ArraySummary | null {
  if (left == null) return right
  if (right == null) return left
  return {
    origin: sameArrayOrigin(left.origin ?? null, right.origin ?? null) ? left.origin ?? right.origin ?? null : null,
    relations: [...left.relations, ...right.relations].filter((fact, index, facts) => facts.findIndex(other => sameSequenceRelation(other, fact)) === index),
    nondecreasingProps: [...new Set([...left.nondecreasingProps, ...right.nondecreasingProps])],
    advances: [...left.advances, ...right.advances].filter((fact, index, facts) => facts.findIndex(other => sameAdvanceFact(other, fact)) === index),
    spaced: [...left.spaced, ...right.spaced].filter((fact, index, facts) => facts.findIndex(other => sameSpacedFact(other, fact)) === index),
    lastEnd: right.lastEnd ?? left.lastEnd,
    extentEnds: [...left.extentEnds, ...right.extentEnds].filter((fact, index, facts) => facts.findIndex(other => sameExtentEndFact(other, fact)) === index),
  }
}

export function joinArraySummary(left: ArrayValue, right: ArrayValue): ArraySummary | null {
  if (sameArraySummary(left.summary, right.summary)) return left.summary
  return originSummaryFromEmptyBranch(left, right) ?? originSummaryFromEmptyBranch(right, left)
}

export function isDefinitelyEmptyArray(value: ArrayValue) {
  return value.length.max === 0
    && value.element == null
    && (value.elements == null || value.elements.length === 0)
}

function originSummaryFromEmptyBranch(emptyCandidate: ArrayValue, other: ArrayValue): ArraySummary | null {
  const origin = other.summary?.origin
  if (origin == null || !isDefinitelyEmptyArray(emptyCandidate)) return null
  return emptyArraySummary(origin)
}

function sameArraySummary(left: ArraySummary | null, right: ArraySummary | null) {
  if (left === right) return true
  if (left == null || right == null) return false
  if ((left.lastEnd?.expr ?? null) !== (right.lastEnd?.expr ?? null)) return false
  if (!sameArrayOrigin(left.origin ?? null, right.origin ?? null)) return false
  if (left.relations.length !== right.relations.length) return false
  if (!left.relations.every((fact, index) => sameSequenceRelation(fact, right.relations[index]!))) return false
  if (left.nondecreasingProps.join('|') !== right.nondecreasingProps.join('|')) return false
  if (left.advances.length !== right.advances.length) return false
  if (!left.advances.every((fact, index) => sameAdvanceFact(fact, right.advances[index]!))) return false
  if (left.spaced.length !== right.spaced.length) return false
  if (!left.spaced.every((fact, index) => sameSpacedFact(fact, right.spaced[index]!))) return false
  if (left.extentEnds.length !== right.extentEnds.length) return false
  return left.extentEnds.every((fact, index) => sameExtentEndFact(fact, right.extentEnds[index]!))
}

function sameArrayOrigin(left: ArrayOrigin | null, right: ArrayOrigin | null) {
  if (left === right) return true
  if (left == null || right == null) return false
  return left.kind === right.kind && sameExpressionText(left.sourceExpr, right.sourceExpr)
}

function sameAdvanceFact(left: ArraySummary['advances'][number], right: ArraySummary['advances'][number]) {
  return left.prop === right.prop && (left.value.expr ?? null) === (right.value.expr ?? null)
}

function sameSpacedFact(left: ArraySummary['spaced'][number], right: ArraySummary['spaced'][number]) {
  return sameExpressionText(left.gapExpr, right.gapExpr)
    && sameExpressionText(left.heightExpr, right.heightExpr)
    && sameExpressionText(left.advanceExpr, right.advanceExpr)
}

function sameExtentEndFact(left: ArraySummary['extentEnds'][number], right: ArraySummary['extentEnds'][number]) {
  return sameExpressionText(left.emptyExpr, right.emptyExpr)
    && sameExpressionText(left.nonEmptyExpr, right.nonEmptyExpr)
    && (left.value.expr ?? null) === (right.value.expr ?? null)
}

function sameSequenceRelation(left: SequenceRelation, right: SequenceRelation) {
  return left.kind === right.kind
    && sameSequenceTerm(left.left, right.left)
    && left.op === right.op
    && sameSequenceExpression(left.right, right.right)
}

function sameSequenceExpression(left: SequenceExpression, right: SequenceExpression) {
  return left.terms.length === right.terms.length
    && left.terms.every((term, index) => sameSequenceTerm(term, right.terms[index]!))
    && left.addends.length === right.addends.length
    && left.addends.every((addend, index) => sameExpressionText(addend, right.addends[index]!))
}

function sameSequenceTerm(left: SequenceTerm, right: SequenceTerm) {
  return left.item === right.item
    && left.path.length === right.path.length
    && left.path.every((part, index) => part === right.path[index])
}
