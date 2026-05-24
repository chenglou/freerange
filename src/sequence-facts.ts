import {
  type ArrayValue,
  type SequenceExpression,
  type SequenceRelation,
  type SequenceTerm,
} from './domain.ts'
import {sameExpressionText} from './linear.ts'
import {type ComparisonOperator} from './parser.ts'

export type SpacedShape = {gapExpr: string; heightExpr: string; advanceExpr: string}

export function nondecreasingPropsFromRelations(relations: SequenceRelation[]): string[] {
  const props = new Set<string>()
  for (const relation of relations) {
    if (relation.kind !== 'adjacent-comparison') continue
    if (relation.op !== '>=' && relation.op !== '==') continue
    if (relation.left.item !== 'next') continue
    if (relation.right.addends.length > 0) continue
    if (relation.right.terms.length !== 1) continue
    const term = relation.right.terms[0]!
    if (term.item !== 'previous') continue
    if (!samePath(relation.left.path, term.path)) continue
    props.add(relation.left.path.join('.'))
  }
  return [...props].sort()
}

export function spacedShapesFromRelations(relations: SequenceRelation[]): SpacedShape[] {
  const shapes: SpacedShape[] = []
  const seen = new Set<string>()
  for (const relation of relations) {
    const shape = spacedShapeFromRelation(relation)
    if (shape == null) continue
    const key = `${shape.advanceExpr}|${shape.gapExpr}`
    if (seen.has(key)) continue
    seen.add(key)
    shapes.push(shape)
  }
  return shapes
}

function spacedShapeFromRelation(relation: SequenceRelation): SpacedShape | null {
  if (relation.kind !== 'adjacent-comparison') return null
  if (relation.op !== '==') return null
  if (relation.left.item !== 'next') return null
  const terms = relation.right.terms
  if (terms.length === 0 || !terms.every(term => term.item === 'previous')) return null
  if (terms.length === 1) {
    const heightPath = terms[0]!.path
    const heightExpr = heightPath.join('.')
    const gapExpr = relation.right.addends.length === 0 ? '0' : relation.right.addends.join(' + ')
    const advanceExpr = relation.left.path.join('.')
    return {gapExpr, heightExpr, advanceExpr}
  }
  if (terms.length === 2) {
    const match = terms.find(term => samePath(term.path, relation.left.path))
    const other = terms.find(term => !samePath(term.path, relation.left.path))
    if (match == null || other == null) return null
    const heightExpr = other.path.join('.')
    const gapExpr = relation.right.addends.length === 0 ? '0' : relation.right.addends.join(' + ')
    const advanceExpr = relation.left.path.join('.')
    return {gapExpr, heightExpr, advanceExpr}
  }
  return null
}

export type AdjacentComparison = {
  left: SequenceTerm
  op: ComparisonOperator
  right: SequenceExpression
}

export function proveAdjacentComparison(array: ArrayValue, target: AdjacentComparison) {
  return array.summary?.relations.some(relation => relationImplies(relation, target)) === true
}

export function hasNondecreasingProp(array: ArrayValue, prop: string) {
  const path = propPath(prop)
  return proveAdjacentComparison(array, {
    left: {item: 'next', path},
    op: '>=',
    right: {terms: [{item: 'previous', path}], addends: []},
  })
}

export function provedSpacing(array: ArrayValue, gapExpr: string) {
  return array.summary?.relations.find(relation => {
    if (relation.kind !== 'adjacent-comparison') return false
    if (relation.op !== '==') return false
    if (relation.left.item !== 'next') return false
    if (!sameAddends(relation.right.addends, gapExpr === '0' ? [] : [gapExpr])) return false
    const terms = relation.right.terms
    if (!terms.every(term => term.item === 'previous')) return false
    if (terms.length === 1) return true
    if (terms.length === 2) return terms.some(term => samePath(term.path, relation.left.path))
    return false
  }) ?? null
}

function samePath(left: string[], right: string[]) {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

export function adjacentComparisonText(collection: string, comparison: AdjacentComparison) {
  return `${sequenceTermText(collection, comparison.left)} ${comparison.op} ${sequenceExpressionText(collection, comparison.right)}`
}

export function sequenceRelationText(collection: string, relation: SequenceRelation) {
  return adjacentComparisonText(collection, relation)
}

function relationImplies(relation: SequenceRelation, target: AdjacentComparison) {
  return relation.kind === 'adjacent-comparison'
    && sameSequenceTerm(relation.left, target.left)
    && comparisonImplies(relation.op, target.op)
    && sameSequenceExpression(relation.right, target.right)
}

function comparisonImplies(known: ComparisonOperator, target: ComparisonOperator) {
  if (known === target) return true
  if (known === '==') return target === '>=' || target === '<='
  return false
}

function sameSequenceExpression(left: SequenceExpression, right: SequenceExpression) {
  return sameSequenceTerms(left.terms, right.terms) && sameAddends(left.addends, right.addends)
}

function sameSequenceTerms(left: SequenceTerm[], right: SequenceTerm[]) {
  return left.length === right.length && left.every((term, index) => sameSequenceTerm(term, right[index]!))
}

function sameSequenceTerm(left: SequenceTerm, right: SequenceTerm) {
  return left.item === right.item
    && left.path.length === right.path.length
    && left.path.every((part, index) => part === right.path[index])
}

function sameAddends(left: string[], right: string[]) {
  return left.length === right.length && left.every((addend, index) => sameExpressionText(addend, right[index]!))
}

function sequenceExpressionText(collection: string, expression: SequenceExpression) {
  const parts = [
    ...expression.terms.map(term => sequenceTermText(collection, term)),
    ...expression.addends,
  ]
  return parts.length === 0 ? '0' : parts.join(' + ')
}

function sequenceTermText(collection: string, term: SequenceTerm) {
  const suffix = term.path.length === 0 ? '' : `.${term.path.join('.')}`
  return `${collection}[${term.item === 'next' ? '$i + 1' : '$i'}]${suffix}`
}

function propPath(prop: string) {
  return prop.split('.').filter(part => part.length > 0)
}
