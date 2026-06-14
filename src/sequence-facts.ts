import {
  addNumbers,
  arrayElement,
  arraySummary,
  numberValue,
  type ArrayValue,
  type NumberValue,
  type SequenceAddition,
  type SequenceExpression,
  type SequenceRelation,
  type SequenceTerm,
} from './domain.ts'
import {linearConstant, sameExpressionText, sameLinear} from './linear.ts'
import {type ComparisonOperator} from './parser.ts'
import {
  samePath,
  sameSequenceAddition,
  sameSequenceExpression,
  sameSequenceTerm,
  sequenceAdditionInvariants,
  sequenceAdditionTerms,
  sequenceAdditionText,
} from './sequence-relation.ts'

// Resolves an addend's text to its abstract value, so written gaps and loop
// residues compare by value: a claim's `boxesGapY` matches a relation's `8`
// when the constant is exactly 8.
export type AddendResolver = (text: string) => NumberValue | null

export type SpacedShape = {gapExpr: string; heightExpr: string; advanceExpr: string}

// The field vocabularies the row catalog accepts. Other names reach the
// catalog by mapping into one of these.
export type RowAxis = {position: string; size: string; end: string}

export const rowAxes: RowAxis[] = [
  {position: 'y', size: 'height', end: 'bottom'},
  {position: 'x', size: 'width', end: 'right'},
  {position: 'top', size: 'height', end: 'bottom'},
  {position: 'start', size: 'size', end: 'end'},
]

export function rowAxisUnionTypeText(): string {
  return rowAxes.map(axis => `{${axis.position}: number; ${axis.size}: number}`).join(' | ')
}

// An element carrying both vocabularies makes spaced/lastEnd/extentEnd/
// noOverlap ambiguous; the caller should map to a single axis first.
export function ambiguousRowAxes(array: ArrayValue): boolean {
  const element = arrayElement(array)
  if (element == null || element.kind !== 'object') return false
  const present = rowAxes.filter(axis =>
    element.props.has(axis.position) && (element.props.has(axis.size) || element.props.has(axis.end)))
  return present.length > 1
}

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
  if (relation.op !== '==') return null
  if (relation.left.item !== 'next') return null
  const terms = relation.kind === 'adjacent-comparison'
    ? relation.right.terms
    : sequenceAdditionTerms(relation.right)
  if (terms.length === 0 || !terms.every(term => term.item === 'previous')) return null
  const addends = relation.kind === 'adjacent-comparison'
    ? relation.right.addends
    : sequenceAdditionInvariants(relation.right)
  if (addends.length > 1) return null
  const gapExpr = addends[0] ?? '0'
  if (relation.left.path.length === 0
    && terms.length === 1
    && terms[0]!.path.length === 0) {
    return {gapExpr, heightExpr: '', advanceExpr: ''}
  }
  for (const axis of rowAxes) {
    if (!samePath(relation.left.path, [axis.position])) continue
    if (terms.length === 1 && samePath(terms[0]!.path, [axis.end])) {
      return {gapExpr, heightExpr: axis.end, advanceExpr: axis.position}
    }
    if (terms.length === 2
      && terms.some(term => samePath(term.path, [axis.position]))
      && terms.some(term => samePath(term.path, [axis.size]))) {
      return {gapExpr, heightExpr: axis.size, advanceExpr: axis.position}
    }
  }
  return null
}

export type AdjacentComparison =
  | {
      kind: 'adjacent-comparison'
      left: SequenceTerm
      op: ComparisonOperator
      right: SequenceExpression
    }
  | {
      kind: 'adjacent-addition'
      left: SequenceTerm
      op: ComparisonOperator
      right: SequenceAddition
    }

export function proveAdjacentComparison(array: ArrayValue, target: AdjacentComparison, resolve: AddendResolver | null = null) {
  return arraySummary(array)?.relations.some(relation => relationImplies(relation, target, resolve)) === true
}

export function hasNondecreasingProp(array: ArrayValue, prop: string) {
  const path = propPath(prop)
  return proveAdjacentComparison(array, {
    kind: 'adjacent-comparison',
    left: {item: 'next', path},
    op: '>=',
    right: {terms: [{item: 'previous', path}], addends: []},
  })
}

// Object rows use one of the axis vocabularies; scalar arrays use
// next == previous + gap. A recurrence on any other object field pair says
// nothing about row spacing.
export function provedSpacing(array: ArrayValue, gapExpr: string, resolve: AddendResolver | null = null) {
  return arraySummary(array)?.relations.find(relation => {
    const shape = spacedShapeFromRelation(relation)
    return shape != null && addendSumsEqual(shape.gapExpr === '0' ? [] : [shape.gapExpr], gapExpr === '0' ? [] : [gapExpr], resolve)
  }) ?? null
}

// noOverlap lifts from any spacing whose fields really are the row extent.
export function isRowExtentShape(shape: SpacedShape): boolean {
  return rowAxes.some(axis => shape.advanceExpr === axis.position && (shape.heightExpr === axis.size || shape.heightExpr === axis.end))
}

export function adjacentComparisonText(collection: string, comparison: AdjacentComparison) {
  const right = comparison.kind === 'adjacent-comparison'
    ? sequenceExpressionText(collection, comparison.right)
    : sequenceAdditionText(comparison.right, term => sequenceTermText(collection, term))
  return `${sequenceTermText(collection, comparison.left)} ${comparison.op} ${right}`
}

export function sequenceRelationText(collection: string, relation: SequenceRelation) {
  return adjacentComparisonText(collection, relation)
}

function relationImplies(relation: SequenceRelation, target: AdjacentComparison, resolve: AddendResolver | null) {
  if (relation.kind !== target.kind
    || !sameSequenceTerm(relation.left, target.left)
    || !comparisonImplies(relation.op, target.op)) return false
  if (relation.kind === 'adjacent-comparison' && target.kind === 'adjacent-comparison') {
    return sameAlgebraicSequenceExpression(relation.right, target.right, resolve)
  }
  return relation.kind === 'adjacent-addition' && target.kind === 'adjacent-addition'
    && sameSequenceAddition(relation.right, target.right, (left, right) => invariantValuesEqual(left, right, resolve))
}

function comparisonImplies(known: ComparisonOperator, target: ComparisonOperator) {
  if (known === target) return true
  if (known === '==') return target === '>=' || target === '<='
  return false
}

function sameAlgebraicSequenceExpression(left: SequenceExpression, right: SequenceExpression, resolve: AddendResolver | null) {
  return sameSequenceExpression(left, right) || (
    sameSequenceTerms(left.terms, right.terms)
    && addendSumsEqual(left.addends, right.addends, resolve)
  )
}

function sameSequenceTerms(left: SequenceTerm[], right: SequenceTerm[]) {
  if (left.length !== right.length) return false
  const unmatched = [...right]
  for (const term of left) {
    const index = unmatched.findIndex(candidate => sameSequenceTerm(term, candidate))
    if (index < 0) return false
    unmatched.splice(index, 1)
  }
  return true
}

function invariantValuesEqual(left: string, right: string, resolve: AddendResolver | null) {
  return sameExpressionText(left, right) || addendSumsEqual([left], [right], resolve)
}

function sameAddends(left: string[], right: string[]) {
  return left.length === right.length && left.every((addend, index) => sameExpressionText(addend, right[index]!))
}

// Addend lists compare as sums: by text first, then by resolved value when
// both sides settle to the same exact number or the same linear form.
function addendSumsEqual(left: string[], right: string[], resolve: AddendResolver | null) {
  if (sameAddends(left, right)) return true
  if (resolve == null) return false
  const leftTotal = addendsTotal(left, resolve)
  const rightTotal = addendsTotal(right, resolve)
  if (leftTotal == null || rightTotal == null) return false
  if (leftTotal.min === leftTotal.max && rightTotal.min === rightTotal.max) return leftTotal.min === rightTotal.min
  return leftTotal.linear != null && rightTotal.linear != null && sameLinear(leftTotal.linear, rightTotal.linear)
}

function addendsTotal(addends: string[], resolve: AddendResolver): NumberValue | null {
  let total: NumberValue | null = null
  for (const addend of addends) {
    const value = resolve(addend)
    if (value == null) return null
    total = total == null ? value : addNumbers(total, value)
  }
  return total ?? numberValue(0, 0, 0, '0', linearConstant(0))
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
