import * as ts from 'typescript'
import {
  parseFitExpression,
  type FitDomainPath,
  type FitSpec,
} from './parser.ts'
import {
  type ArrayValue,
  type LinearConstraint,
  type Value,
} from './domain.ts'
import {proveComparison} from './proof.ts'

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
  evaluateSpecExpression: (text: string) => Value
  nondecreasingFailureReason: (text: string, target: {array: ArrayValue; prop: string}) => string
}

export function proveBoundIndexRangeSpec(
  spec: Extract<FitSpec, {kind: 'check-range'}>,
  context: BoundIndexContext,
): {status: BoundIndexStatus; reason?: string} | null {
  const uses = [
    ...boundIndexUses(spec.expression),
    ...boundIndexUses(spec.range.lower),
    ...boundIndexUses(spec.range.upper),
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
      reason: `Bound index label ${nonZeroOffset.label} currently supports same-index ${nonZeroOffset.label} comparisons and adjacent monotone ${nonZeroOffset.label} + 1 comparisons`,
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
  if (left == null || right == null) return null
  if (left.label !== right.label || left.collectionKey !== right.collectionKey || left.prop !== right.prop) return null
  const offsetDiff = right.offset - left.offset
  const forward =
    offsetDiff === 1 && spec.op === '<=' ? {previous: left, next: right}
      : offsetDiff === -1 && spec.op === '>=' ? {previous: right, next: left}
        : null
  if (forward == null) return null

  const array = context.evaluateDomainPath(forward.previous.collectionPath)
  if (array.kind !== 'array') return {status: 'unknown', reason: `${forward.previous.collectionText} expected an array`}
  if (array.summary?.nondecreasingProps.some(prop => prop === forward.previous.prop) === true) return {status: 'pass'}
  return {status: 'unknown', reason: context.nondecreasingFailureReason(spec.text, {array, prop: forward.previous.prop})}
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

function boundIndexUses(text: string): BoundIndexUse[] {
  return [...parseFitExpression(text).domainPaths.values()].flatMap(domainPath => boundIndexUsesInDomainPath(domainPath))
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

function singleBoundPathExpression(text: string): BoundPathExpression | null {
  const parsed = parseFitExpression(text)
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
  return text
}
