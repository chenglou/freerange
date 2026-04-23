import {
  type ArrayValue,
  type SequenceExpression,
  type SequenceRelation,
  type SequenceTerm,
} from './domain.ts'
import {sameExpressionText} from './linear.ts'
import {type ComparisonOperator} from './parser.ts'

export type AdjacentComparison = {
  left: SequenceTerm
  op: ComparisonOperator
  right: SequenceExpression
}

export function proveAdjacentComparison(array: ArrayValue, target: AdjacentComparison) {
  return array.summary?.relations.some(relation => relationImplies(relation, target)) === true
}

export function hasNondecreasingProp(array: ArrayValue, prop: string) {
  return proveAdjacentComparison(array, {
    left: {item: 'next', path: [prop]},
    op: '>=',
    right: {terms: [{item: 'previous', path: [prop]}], addends: []},
  })
}

export function provedSpacing(array: ArrayValue, gapExpr: string) {
  return array.summary?.relations.find(relation => {
    if (relation.kind !== 'adjacent-comparison') return false
    if (relation.op !== '==') return false
    if (!sameSequenceTerm(relation.left, {item: 'next', path: ['top']})) return false
    if (!sameAddends(relation.right.addends, gapExpr === '0' ? [] : [gapExpr])) return false
    return sameSequenceTerms(relation.right.terms, [
      {item: 'previous', path: ['top']},
      {item: 'previous', path: ['height']},
    ]) || sameSequenceTerms(relation.right.terms, [
      {item: 'previous', path: ['bottom']},
    ])
  }) ?? null
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
