import * as ts from 'typescript'
import {
  fitExpressionParsed,
  fitRangeCases,
  fitValueSpecExpressions,
  publicFitText,
  type FitComparisonCheckSpec,
  type FitDomainPath,
  type FitExpressionLike,
  type FitRangeCheckSpec,
  type FitSpec,
} from './parser.ts'
import {
  arrayLength,
  type ArrayValue,
  type Assumption,
  type SequenceAddition,
  type SequenceExpression,
  type SequenceTerm,
  type Value,
} from './domain.ts'
import {flipComparison, proveComparison} from './proof.ts'
import {type AdjacentComparison} from './sequence-facts.ts'

type BoundIndexStatus = 'pass' | 'fail' | 'unknown'

type BoundIndexUse = {
  label: string
  offset: number
  collectionPath: FitDomainPath
  nested: boolean
}

type BoundIndexRelationship =
  | {kind: 'none'}
  | {kind: 'same-index'; uses: BoundIndexUse[]}
  | {kind: 'adjacent'; relation: AdjacentComparisonParse}
  | {kind: 'unsupported'; reason: string}

type BoundIndexAnalysis = {
  uses: BoundIndexUse[]
  hasAnonymousItem: boolean
}

export type BoundIndexContext = {
  assumptions: Assumption[]
  evaluateDomainPath: (domainPath: FitDomainPath) => Value
  evaluateSpecExpression: (text: FitExpressionLike) => Value
  nondecreasingFailureReason: (text: string, target: {array: ArrayValue; prop: string}) => string
  proveAdjacentComparison: (collectionPath: FitDomainPath, comparison: AdjacentComparison) => {status: BoundIndexStatus; reason?: string}
}

export function unsupportedNamedIndexSpecReason(spec: FitSpec): string | null {
  const analysis = analyzeBoundIndexesInSpec(spec)
  const uses = analysis.uses
  if (uses.length === 0) return null
  if (spec.role === 'assume') {
    return 'Named indexes are unsupported in given contracts because their matching-position relationship is not carried into the function; use [] for per-item input bounds'
  }
  if (spec.kind === 'expression' || spec.kind === 'value') {
    return 'Named indexes are supported only in direct range and comparison contracts'
  }
  if (spec.kind === 'pure') return null
  const relationship = classifyBoundIndexRelationship(spec, analysis)
  if (relationship.kind === 'unsupported') return relationship.reason
  return null
}

export function proveBoundIndexRangeSpec(
  spec: FitRangeCheckSpec,
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} | null {
  const relationship = classifyBoundIndexRelationship(spec, analyzeBoundIndexesInSpec(spec))
  if (relationship.kind === 'none') return null
  if (relationship.kind === 'unsupported') return {status: 'unknown', reason: relationship.reason}
  if (relationship.kind === 'adjacent') {
    return {status: 'unknown', reason: 'Adjacent named indexes are unsupported in range contracts'}
  }
  return proveSameIndexCollectionLengths(relationship.uses, context)
}

export function proveBoundIndexComparisonSpec(
  spec: FitComparisonCheckSpec,
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} | null {
  const relationship = classifyBoundIndexRelationship(spec, analyzeBoundIndexesInSpec(spec))
  if (relationship.kind === 'none') return null
  if (relationship.kind === 'unsupported') return {status: 'unknown', reason: relationship.reason}
  if (relationship.kind === 'adjacent') {
    return proveAdjacentBoundIndexComparison(spec.text, relationship.relation, context)
  }

  const lengthStatus = proveSameIndexCollectionLengths(relationship.uses, context)
  if (lengthStatus.status !== 'pass') return lengthStatus

  const left = context.evaluateSpecExpression(spec.left)
  const right = context.evaluateSpecExpression(spec.right)
  const status = proveComparison(left, spec.op, right, context.assumptions)
  const reason = status.status === 'pass' || status.reason == null
    ? status.reason
    : `bound index comparison means every matching item must satisfy: ${spec.text}\n${status.reason}`
  return {
    status: status.status,
    ...(reason == null ? {} : {reason}),
  }
}

function classifyBoundIndexRelationship(
  spec: FitRangeCheckSpec | FitComparisonCheckSpec,
  analysis: BoundIndexAnalysis,
): BoundIndexRelationship {
  const {uses} = analysis
  if (uses.length === 0) return {kind: 'none'}
  if (analysis.hasAnonymousItem) {
    return {
      kind: 'unsupported',
      reason: 'Named index contracts cannot mix a named position such as $i with [] in the same contract',
    }
  }
  const nested = uses.find(use => use.nested)
  if (nested != null) {
    return {
      kind: 'unsupported',
      reason: `Named index ${nested.label} is nested with another collection item; named index contracts currently support one collection level`,
    }
  }
  const labels = [...new Set(uses.map(use => use.label))]
  if (labels.length !== 1) {
    return {
      kind: 'unsupported',
      reason: `Named index contracts support one label at a time; ${labels.join(' and ')} would require a relationship the checker does not model`,
    }
  }
  const label = labels[0]!
  if (uses.every(use => use.offset === 0)) return {kind: 'same-index', uses}
  if (spec.kind === 'range') {
    return {
      kind: 'unsupported',
      reason: `Named index range contracts support matching ${label} positions without offsets`,
    }
  }
  const offsets = new Set(uses.map(use => use.offset))
  const collectionPath = uses[0]!.collectionPath
  if (
    offsets.size === 2
    && offsets.has(0)
    && offsets.has(1)
    && uses.every(use => sameDomainPath(use.collectionPath, collectionPath))
  ) {
    const relation = adjacentComparisonFromSpec(spec)
    return relation == null
      ? {
          kind: 'unsupported',
          reason: 'Adjacent named index contracts must directly compare $i + 1 with an expression over $i from the same collection',
        }
      : {kind: 'adjacent', relation}
  }
  return {
    kind: 'unsupported',
    reason: `Named index comparisons support matching ${label} positions, or ${label} and ${label} + 1 in one collection`,
  }
}

function proveAdjacentBoundIndexComparison(
  specText: string,
  adjacent: AdjacentComparisonParse,
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} {
  const collection = context.evaluateDomainPath(adjacent.collectionPath)
  if (collection.kind !== 'array' || collection.layout !== 'collection') {
    return {
      status: 'unknown',
      reason: `Named index collection ${domainPathText(adjacent.collectionPath)} expected a homogeneous array; fixed tuples use numeric positions`,
    }
  }
  let firstFailure: {status: BoundIndexStatus; reason?: string} | null = null
  for (const comparison of adjacent.comparisons) {
    const result = context.proveAdjacentComparison(adjacent.collectionPath, comparison)
    if (result.status === 'pass') return result
    firstFailure ??= result
  }
  if (adjacent.nondecreasingProp != null) {
    return {status: 'unknown', reason: context.nondecreasingFailureReason(specText, {array: collection, prop: adjacent.nondecreasingProp})}
  }
  return firstFailure ?? {status: 'unknown', reason: 'Adjacent relationship was not inferred'}
}

type AdjacentComparisonParse = {
  collectionPath: FitDomainPath
  comparisons: AdjacentComparison[]
  nondecreasingProp: string | null
}

type BoundSequenceTerm = {
  label: string
  collectionPath: FitDomainPath
  term: SequenceTerm
}

function adjacentComparisonFromSpec(spec: FitComparisonCheckSpec): AdjacentComparisonParse | null {
  const left = sequenceSideFromText(spec.left)
  const right = sequenceSideFromText(spec.right)
  if (left == null || right == null) return null

  const allTerms = [...left.expression.terms, ...right.expression.terms]
  if (allTerms.length === 0) return null

  const nextLeft = singleTermExpression(left.expression)
  if (nextLeft?.term.item === 'next' && expressionHasOnlyPreviousTerms(right.expression)) {
    const collectionPath = matchingCollectionPath([...left.boundTerms, ...right.boundTerms])
    return collectionPath == null ? null : {
      collectionPath,
      comparisons: [
        {kind: 'adjacent-addition', left: nextLeft.term, op: spec.op, right: right.addition},
        {kind: 'adjacent-comparison', left: nextLeft.term, op: spec.op, right: right.expression},
      ],
      nondecreasingProp: nondecreasingProp(nextLeft.term, spec.op, right.expression),
    }
  }

  const nextRight = singleTermExpression(right.expression)
  if (nextRight?.term.item === 'next' && expressionHasOnlyPreviousTerms(left.expression)) {
    const collectionPath = matchingCollectionPath([...left.boundTerms, ...right.boundTerms])
    const op = flipComparison(spec.op)
    return collectionPath == null ? null : {
      collectionPath,
      comparisons: [
        {kind: 'adjacent-addition', left: nextRight.term, op, right: left.addition},
        {kind: 'adjacent-comparison', left: nextRight.term, op, right: left.expression},
      ],
      nondecreasingProp: nondecreasingProp(nextRight.term, op, left.expression),
    }
  }

  return null
}

function nondecreasingProp(next: SequenceTerm, op: FitComparisonCheckSpec['op'], previous: SequenceExpression): string | null {
  if (op !== '>=' || next.path.length !== 1) return null
  const previousTerm = singleTermExpression(previous)?.term
  if (previousTerm == null || previousTerm.item !== 'previous') return null
  return previousTerm.path.length === 1 && previousTerm.path[0] === next.path[0] ? next.path[0]! : null
}

function sequenceSideFromText(text: FitExpressionLike): {
  expression: SequenceExpression
  addition: SequenceAddition
  boundTerms: BoundSequenceTerm[]
} | null {
  const parsed = fitExpressionParsed(text)
  const result = sequenceExpressionFromExpression(parsed.expression, parsed.domainPaths)
  if (result == null) return null
  return result.boundTerms.length === 0 ? null : result
}

function sequenceExpressionFromExpression(
  expression: ts.Expression,
  domainPaths: Map<string, FitDomainPath>,
): {expression: SequenceExpression; addition: SequenceAddition; boundTerms: BoundSequenceTerm[]} | null {
  const unwrapped = unwrapParentheses(expression)
  const boundTerm = boundSequenceTermFromExpression(unwrapped, domainPaths)
  if (boundTerm != null) {
    return {
      expression: {terms: [boundTerm.term], addends: []},
      addition: {kind: 'term', term: boundTerm.term},
      boundTerms: [boundTerm],
    }
  }
  if (!expressionMentionsDomainPath(unwrapped, domainPaths)) {
    const invariant = unwrapped.getText()
    return {
      expression: {terms: [], addends: [invariant]},
      addition: {kind: 'invariant', text: invariant},
      boundTerms: [],
    }
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sequenceExpressionFromExpression(unwrapped.left, domainPaths)
    const right = sequenceExpressionFromExpression(unwrapped.right, domainPaths)
    if (left == null || right == null) return null
    return {
      expression: {
        terms: [...left.expression.terms, ...right.expression.terms],
        addends: [...left.expression.addends, ...right.expression.addends],
      },
      addition: {kind: 'add', left: left.addition, right: right.addition},
      boundTerms: [...left.boundTerms, ...right.boundTerms],
    }
  }

  return null
}

function boundSequenceTermFromExpression(expression: ts.Expression, domainPaths: Map<string, FitDomainPath>): BoundSequenceTerm | null {
  if (!ts.isIdentifier(expression)) return null
  const domainPath = domainPaths.get(expression.text)
  if (domainPath == null) return null
  const lastItemIndex = domainPath.segments.findLastIndex(segment => segment.kind === 'item')
  if (lastItemIndex < 0) return null
  const item = domainPath.segments[lastItemIndex]!
  if (item.kind !== 'item' || item.label == null) return null
  const earlierLabeledItem = domainPath.segments.slice(0, lastItemIndex).find(segment => segment.kind === 'item' && segment.label != null)
  if (earlierLabeledItem != null) return null
  const itemKind = item.offset == null || item.offset === 0 ? 'previous' : item.offset === 1 ? 'next' : null
  if (itemKind == null) return null
  const tail = domainPath.segments.slice(lastItemIndex + 1)
  const path: string[] = []
  for (const segment of tail) {
    if (segment.kind !== 'prop') return null
    path.push(segment.name)
  }
  const collectionPath = {root: domainPath.root, segments: domainPath.segments.slice(0, lastItemIndex)}
  return {
    label: item.label,
    collectionPath,
    term: {item: itemKind, path},
  }
}

function expressionMentionsDomainPath(expression: ts.Expression, domainPaths: Map<string, FitDomainPath>): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(node) && domainPaths.has(node.text)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return found
}

function singleTermExpression(expression: SequenceExpression): {term: SequenceTerm} | null {
  return expression.terms.length === 1 && expression.addends.length === 0 ? {term: expression.terms[0]!} : null
}

function expressionHasOnlyPreviousTerms(expression: SequenceExpression) {
  return expression.terms.every(term => term.item === 'previous')
}

function matchingCollectionPath(terms: BoundSequenceTerm[]): FitDomainPath | null {
  if (terms.length === 0) return null
  const first = terms[0]!
  if (!terms.every(term => term.label === first.label && sameDomainPath(term.collectionPath, first.collectionPath))) return null
  return first.collectionPath
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function proveSameIndexCollectionLengths(
  uses: BoundIndexUse[],
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} {
  const label = uses[0]!.label
  const collections = uniqueBoundCollections(uses)
  const first = collections[0]!
  const firstText = domainPathText(first.collectionPath)
  const firstArray = context.evaluateDomainPath(first.collectionPath)
  if (firstArray.kind !== 'array' || firstArray.layout !== 'collection') {
    return {status: 'unknown', reason: `Named index collection ${firstText} expected a homogeneous array; fixed tuples use numeric positions`}
  }
  for (const other of collections.slice(1)) {
    const otherText = domainPathText(other.collectionPath)
    const otherArray = context.evaluateDomainPath(other.collectionPath)
    if (otherArray.kind !== 'array' || otherArray.layout !== 'collection') {
      return {status: 'unknown', reason: `Named index collection ${otherText} expected a homogeneous array; fixed tuples use numeric positions`}
    }
    const status = proveComparison(arrayLength(firstArray), '==', arrayLength(otherArray), context.assumptions)
    if (status.status !== 'pass') {
      return {
        status: 'unknown',
        reason: `Bound index label ${label} needs matching lengths for ${firstText} and ${otherText}\n${status.reason ?? `missing: ${firstText}.length == ${otherText}.length`}`,
      }
    }
  }
  return {status: 'pass'}
}

function uniqueBoundCollections(uses: BoundIndexUse[]) {
  const collections: BoundIndexUse[] = []
  for (const use of uses) {
    if (!collections.some(collection => sameDomainPath(collection.collectionPath, use.collectionPath))) collections.push(use)
  }
  return collections
}

function analyzeBoundIndexesInSpec(spec: FitSpec): BoundIndexAnalysis {
  const expressions: FitExpressionLike[] = (() => {
    switch (spec.kind) {
      case 'range':
        return [
          spec.expression,
          ...fitRangeCases(spec.range).flatMap(rangeCase => [rangeCase.lower, rangeCase.upper]),
        ]
      case 'comparison':
        return [spec.left, spec.right]
      case 'expression':
        return [spec.expression]
      case 'value':
        return [spec.expression, ...fitValueSpecExpressions(spec.value)]
      case 'pure':
        return []
    }
  })()
  const paths = expressions.flatMap(expression => [...fitExpressionParsed(expression).domainPaths.values()])
  return {
    uses: paths.flatMap(boundIndexUsesInDomainPath),
    hasAnonymousItem: paths.some(domainPath =>
      domainPath.segments.some(segment => segment.kind === 'item' && segment.label == null)),
  }
}

function boundIndexUsesInDomainPath(domainPath: FitDomainPath): BoundIndexUse[] {
  const uses: BoundIndexUse[] = []
  const itemCount = domainPath.segments.filter(segment => segment.kind === 'item').length
  for (let index = 0; index < domainPath.segments.length; index++) {
    const segment = domainPath.segments[index]!
    if (segment.kind !== 'item' || segment.label == null) continue
    const collectionSegments = domainPath.segments.slice(0, index)
    const collectionPath = {root: domainPath.root, segments: collectionSegments}
    uses.push({
      label: segment.label,
      offset: segment.offset ?? 0,
      collectionPath,
      nested: itemCount > 1,
    })
  }
  return uses
}

function sameDomainPath(left: FitDomainPath, right: FitDomainPath) {
  if (left.root !== right.root || left.segments.length !== right.segments.length) return false
  return left.segments.every((segment, index) => {
    const other = right.segments[index]!
    if (segment.kind !== other.kind) return false
    if (segment.kind === 'prop' && other.kind === 'prop') return segment.name === other.name
    if (segment.kind === 'item' && other.kind === 'item') {
      return segment.label === other.label && (segment.offset ?? 0) === (other.offset ?? 0)
    }
    return false
  })
}

function domainPathText(domainPath: FitDomainPath) {
  let text = domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') {
      text += `.${segment.name}`
      continue
    }
    if (segment.label == null) {
      text += '[]'
      continue
    }
    const offset = segment.offset ?? 0
    text += `[${segment.label}${offset === 0 ? '' : offset > 0 ? ` + ${offset}` : ` - ${Math.abs(offset)}`}]`
  }
  return publicFitText(text)
}
