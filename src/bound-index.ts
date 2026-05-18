import * as ts from 'typescript'
import {
  fitExpressionParsed,
  fitRangeCases,
  publicFitText,
  type FitDomainPath,
  type FitExpressionLike,
  type FitSpec,
} from './parser.ts'
import {
  type ArrayValue,
  type LinearConstraint,
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
  collectionKey: string
  collectionText: string
  collectionPath: FitDomainPath
}

type BoundPathExpression = BoundIndexUse & {
  prop: string
}

export type BoundIndexContext = {
  assumptions: LinearConstraint[]
  evaluateDomainPath: (domainPath: FitDomainPath) => Value
  evaluateSpecExpression: (text: FitExpressionLike) => Value
  nondecreasingFailureReason: (text: string, target: {array: ArrayValue; prop: string}) => string
  proveAdjacentComparison: (collectionPath: FitDomainPath, comparison: AdjacentComparison) => {status: BoundIndexStatus; reason?: string}
}

export function proveBoundIndexRangeSpec(
  spec: Extract<FitSpec, {kind: 'check-range'}>,
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} | null {
  const uses = [
    ...boundIndexUses(spec.expression),
    ...fitRangeCases(spec.range).flatMap(rangeCase => [
      ...boundIndexUses(rangeCase.lower),
      ...boundIndexUses(rangeCase.upper),
    ]),
  ]
  if (uses.length === 0) return null
  const nonZeroOffset = uses.find(use => use.offset !== 0)
  if (nonZeroOffset != null) {
    return {
      status: 'unknown',
      reason: `Bound index label ${nonZeroOffset.label} in range specs currently supports same-index labels without offsets`,
    }
  }
  return proveSameIndexCollectionLengths(uses, context)
}

export function proveBoundIndexComparisonSpec(
  spec: Extract<FitSpec, {kind: 'check-comparison'}>,
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} | null {
  const uses = [...boundIndexUses(spec.left), ...boundIndexUses(spec.right)]
  if (uses.length === 0) return null

  const adjacent = proveAdjacentBoundIndexComparison(spec, context)
  if (adjacent != null) return adjacent

  const nonZeroOffset = uses.find(use => use.offset !== 0)
  if (nonZeroOffset != null) {
    return {
      status: 'unknown',
      reason: `Bound index label ${nonZeroOffset.label} currently supports same-index ${nonZeroOffset.label} comparisons and adjacent ${nonZeroOffset.label} + 1 comparisons backed by inferred sequence facts`,
    }
  }

  const lengthStatus = proveSameIndexCollectionLengths(uses, context)
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

function proveAdjacentBoundIndexComparison(
  spec: Extract<FitSpec, {kind: 'check-comparison'}>,
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} | null {
  const left = singleBoundPathExpression(spec.left)
  const right = singleBoundPathExpression(spec.right)
  if (left != null && right != null && left.label === right.label && left.collectionKey === right.collectionKey && left.prop === right.prop) {
    const offsetDiff = right.offset - left.offset
    const forward =
      offsetDiff === 1 && spec.op === '<=' ? {previous: left, next: right}
        : offsetDiff === -1 && spec.op === '>=' ? {previous: right, next: left}
          : null
    if (forward != null) {
      const array = context.evaluateDomainPath(forward.previous.collectionPath)
      if (array.kind !== 'array') return {status: 'unknown', reason: `${forward.previous.collectionText} expected an array`}
      const generic = context.proveAdjacentComparison(forward.previous.collectionPath, {
        left: {item: 'next', path: [forward.previous.prop]},
        op: '>=',
        right: {terms: [{item: 'previous', path: [forward.previous.prop]}], addends: []},
      })
      if (generic.status === 'pass') return generic
      return {status: 'unknown', reason: context.nondecreasingFailureReason(spec.text, {array, prop: forward.previous.prop})}
    }
  }

  const adjacent = adjacentComparisonFromSpec(spec)
  if (adjacent != null) return context.proveAdjacentComparison(adjacent.collectionPath, adjacent.comparison)
  return null
}

type AdjacentComparisonParse = {
  collectionPath: FitDomainPath
  comparison: AdjacentComparison
}

type BoundSequenceTerm = {
  label: string
  collectionKey: string
  collectionPath: FitDomainPath
  term: SequenceTerm
}

function adjacentComparisonFromSpec(spec: Extract<FitSpec, {kind: 'check-comparison'}>): AdjacentComparisonParse | null {
  const left = sequenceSideFromText(spec.left)
  const right = sequenceSideFromText(spec.right)
  if (left == null || right == null) return null

  const allTerms = [...left.expression.terms, ...right.expression.terms]
  if (allTerms.length === 0) return null

  const nextLeft = singleTermExpression(left.expression)
  if (nextLeft?.term.item === 'next' && expressionHasOnlyPreviousTerms(right.expression)) {
    const collectionPath = matchingCollectionPath([...left.boundTerms, ...right.boundTerms])
    return collectionPath == null ? null : {collectionPath, comparison: {left: nextLeft.term, op: spec.op, right: right.expression}}
  }

  const nextRight = singleTermExpression(right.expression)
  if (nextRight?.term.item === 'next' && expressionHasOnlyPreviousTerms(left.expression)) {
    const collectionPath = matchingCollectionPath([...left.boundTerms, ...right.boundTerms])
    return collectionPath == null ? null : {collectionPath, comparison: {left: nextRight.term, op: flipComparison(spec.op), right: left.expression}}
  }

  return null
}

function sequenceSideFromText(text: FitExpressionLike): {expression: SequenceExpression; boundTerms: BoundSequenceTerm[]} | null {
  const parsed = fitExpressionParsed(text)
  const result = sequenceExpressionFromExpression(parsed.expression, parsed.domainPaths)
  if (result == null) return null
  return result.boundTerms.length === 0 ? null : result
}

function sequenceExpressionFromExpression(
  expression: ts.Expression,
  domainPaths: Map<string, FitDomainPath>,
): {expression: SequenceExpression; boundTerms: BoundSequenceTerm[]} | null {
  const unwrapped = unwrapParentheses(expression)
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sequenceExpressionFromExpression(unwrapped.left, domainPaths)
    const right = sequenceExpressionFromExpression(unwrapped.right, domainPaths)
    if (left == null || right == null) return null
    return {
      expression: {
        terms: [...left.expression.terms, ...right.expression.terms],
        addends: [...left.expression.addends, ...right.expression.addends],
      },
      boundTerms: [...left.boundTerms, ...right.boundTerms],
    }
  }

  const boundTerm = boundSequenceTermFromExpression(unwrapped, domainPaths)
  if (boundTerm != null) {
    return {expression: {terms: [boundTerm.term], addends: []}, boundTerms: [boundTerm]}
  }
  if (expressionMentionsDomainPath(unwrapped, domainPaths)) return null
  return {expression: {terms: [], addends: [unwrapped.getText()]}, boundTerms: []}
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
    collectionKey: domainPathKey(collectionPath),
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
  if (!terms.every(term => term.label === first.label && term.collectionKey === first.collectionKey)) return null
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
  const byLabel = new Map<string, BoundIndexUse[]>()
  for (const use of uses) {
    const group = byLabel.get(use.label) ?? []
    group.push(use)
    byLabel.set(use.label, group)
  }

  for (const [label, group] of byLabel) {
    const collections = uniqueBoundCollections(group)
    if (collections.length <= 1) continue
    const first = collections[0]!
    const firstArray = context.evaluateDomainPath(first.collectionPath)
    if (firstArray.kind !== 'array') return {status: 'unknown', reason: `${first.collectionText} expected an array`}
    for (const other of collections.slice(1)) {
      const otherArray = context.evaluateDomainPath(other.collectionPath)
      if (otherArray.kind !== 'array') return {status: 'unknown', reason: `${other.collectionText} expected an array`}
      const status = proveComparison(firstArray.length, '==', otherArray.length, context.assumptions)
      if (status.status !== 'pass') {
        return {
          status: 'unknown',
          reason: `Bound index label ${label} needs matching lengths for ${first.collectionText} and ${other.collectionText}\n${status.reason ?? `missing: ${first.collectionText}.length == ${other.collectionText}.length`}`,
        }
      }
    }
  }
  return {status: 'pass'}
}

function uniqueBoundCollections(uses: BoundIndexUse[]) {
  const byKey = new Map<string, BoundIndexUse>()
  for (const use of uses) {
    if (!byKey.has(use.collectionKey)) byKey.set(use.collectionKey, use)
  }
  return [...byKey.values()]
}

function boundIndexUses(text: FitExpressionLike): BoundIndexUse[] {
  return [...fitExpressionParsed(text).domainPaths.values()].flatMap(domainPath => boundIndexUsesInDomainPath(domainPath))
}

function boundIndexUsesInDomainPath(domainPath: FitDomainPath): BoundIndexUse[] {
  const uses: BoundIndexUse[] = []
  for (let index = 0; index < domainPath.segments.length; index++) {
    const segment = domainPath.segments[index]!
    if (segment.kind !== 'item' || segment.label == null) continue
    const collectionSegments = domainPath.segments.slice(0, index)
    const collectionPath = {root: domainPath.root, segments: collectionSegments}
    uses.push({
      label: segment.label,
      offset: segment.offset ?? 0,
      collectionKey: domainPathKey(collectionPath),
      collectionText: domainPathText(collectionPath),
      collectionPath,
    })
  }
  return uses
}

function singleBoundPathExpression(text: FitExpressionLike): BoundPathExpression | null {
  const parsed = fitExpressionParsed(text)
  if (!ts.isIdentifier(parsed.expression)) return null
  const domainPath = parsed.domainPaths.get(parsed.expression.text)
  if (domainPath == null) return null
  const lastItemIndex = domainPath.segments.findLastIndex(segment => segment.kind === 'item')
  if (lastItemIndex < 0) return null
  const lastItem = domainPath.segments[lastItemIndex]!
  if (lastItem.kind !== 'item' || lastItem.label == null) return null
  const tail = domainPath.segments.slice(lastItemIndex + 1)
  if (tail.length !== 1 || tail[0]!.kind !== 'prop') return null
  const earlierLabeledItem = domainPath.segments.slice(0, lastItemIndex).find(segment => segment.kind === 'item' && segment.label != null)
  if (earlierLabeledItem != null) return null
  const collectionSegments = domainPath.segments.slice(0, lastItemIndex)
  const collectionPath = {root: domainPath.root, segments: collectionSegments}
  return {
    label: lastItem.label,
    offset: lastItem.offset ?? 0,
    collectionKey: domainPathKey(collectionPath),
    collectionText: domainPathText(collectionPath),
    collectionPath,
    prop: tail[0]!.name,
  }
}

function domainPathKey(domainPath: FitDomainPath) {
  return domainPathText(domainPath, false)
}

function domainPathText(domainPath: FitDomainPath, includeLabels = true) {
  let text = domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') {
      text += `.${segment.name}`
      continue
    }
    if (segment.label == null || !includeLabels) {
      text += '[]'
      continue
    }
    const offset = segment.offset ?? 0
    text += `[${segment.label}${offset === 0 ? '' : offset > 0 ? ` + ${offset}` : ` - ${Math.abs(offset)}`}]`
  }
  return publicFitText(text)
}
