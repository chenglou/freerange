import type {
  ArrayOrigin,
  ArraySummary,
  ArrayValue,
  SequenceRelation,
} from './domain-types.ts'
import {expressionKeyFromText, sameExpressionText} from './linear.ts'
import {joinNumberValues} from './number-domain.ts'
import type {ComparisonOperator} from './parser.ts'
import {
  canonicalSequenceRelation,
  mergeEquivalentSequenceAddition,
  preferredEquivalentExpression,
  samePath,
  sameSequenceExpression,
  sameSequenceRelation,
  sameSequenceTerm,
  sequenceRelationKey,
} from './sequence-relation.ts'

export function mapOrigin(source: ArrayValue, sourceExpr: string): ArrayOrigin {
  const origin = source.layout === 'collection' ? source.summary?.origin : null
  if (origin?.kind === 'subsequence') return {kind: 'subsequence', sourceExpr: origin.sourceExpr}
  if (origin?.kind === 'identity') return {kind: 'identity', sourceExpr: origin.sourceExpr}
  return {kind: 'identity', sourceExpr}
}

export function filterOrigin(source: ArrayValue, sourceExpr: string): ArrayOrigin {
  return {
    kind: 'subsequence',
    sourceExpr: source.layout === 'collection' ? source.summary?.origin?.sourceExpr ?? sourceExpr : sourceExpr,
  }
}

export function emptyArraySummary(origin: ArrayOrigin | null): ArraySummary {
  return {
    origin,
    relations: [],
    advances: [],
    lastEnd: null,
    extentEnds: [],
  }
}

export function mergeArraySummary(left: ArraySummary | null, right: ArraySummary | null): ArraySummary | null {
  if (left == null) return right == null ? null : canonicalArraySummary(right)
  if (right == null) return canonicalArraySummary(left)
  return canonicalArraySummary({
    origin: commonArrayOrigin(left.origin ?? null, right.origin ?? null),
    relations: unionRelations(left.relations, right.relations),
    advances: unionAdvances(left.advances, right.advances),
    lastEnd: mergeRowEnd(left.lastEnd, right.lastEnd),
    extentEnds: unionExtentEnds(left.extentEnds, right.extentEnds),
  })
}

export function joinArraySummary(left: ArrayValue, right: ArrayValue): ArraySummary | null {
  if (left.layout !== 'collection' || right.layout !== 'collection') return null
  const emptySummary = summaryWithEmptyBranch(left, right) ?? summaryWithEmptyBranch(right, left)
  if (emptySummary != null) return emptySummary
  if (left.summary == null || right.summary == null) return null
  return canonicalArraySummary({
    origin: commonArrayOrigin(left.summary.origin ?? null, right.summary.origin ?? null),
    relations: commonRelations(left.summary.relations, right.summary.relations),
    advances: commonAdvances(left.summary.advances, right.summary.advances),
    lastEnd: joinRowEnd(left.summary.lastEnd, right.summary.lastEnd),
    extentEnds: commonExtentEnds(left.summary.extentEnds, right.summary.extentEnds),
  })
}

export function isDefinitelyEmptyArray(value: ArrayValue) {
  return value.layout === 'tuple'
    ? value.elements.length === 0
    : value.length.max === 0
}

function summaryWithEmptyBranch(emptyCandidate: ArrayValue, other: ArrayValue): ArraySummary | null {
  if (emptyCandidate.layout !== 'collection' || other.layout !== 'collection') return null
  if (!isDefinitelyEmptyArray(emptyCandidate) || isDefinitelyEmptyArray(other) || other.summary == null) return null
  return canonicalArraySummary({
    ...other.summary,
    lastEnd: null,
    extentEnds: [],
  })
}

function sameArrayOrigin(left: ArrayOrigin | null, right: ArrayOrigin | null) {
  if (left === right) return true
  if (left == null || right == null) return false
  return left.kind === right.kind && sameExpressionText(left.sourceExpr, right.sourceExpr)
}

function commonArrayOrigin(left: ArrayOrigin | null, right: ArrayOrigin | null): ArrayOrigin | null {
  if (!sameArrayOrigin(left, right) || left == null || right == null) return null
  return {
    kind: left.kind,
    sourceExpr: preferredEquivalentExpression(left.sourceExpr, right.sourceExpr),
  }
}

function sameAdvanceIdentity(left: ArraySummary['advances'][number], right: ArraySummary['advances'][number]) {
  return left.prop === right.prop
}

function sameExtentEndIdentity(left: ArraySummary['extentEnds'][number], right: ArraySummary['extentEnds'][number]) {
  return sameExpressionText(left.emptyExpr, right.emptyExpr)
    && samePath(left.positionPath, right.positionPath)
    && samePath(left.sizePath, right.sizePath)
}

function sameRowEndIdentity(
  left: NonNullable<ArraySummary['lastEnd']>,
  right: NonNullable<ArraySummary['lastEnd']>,
) {
  return samePath(left.positionPath, right.positionPath)
    && samePath(left.sizePath, right.sizePath)
}

function unionRelations(left: SequenceRelation[], right: SequenceRelation[]): SequenceRelation[] {
  const result = left.map(canonicalSequenceRelation)
  for (const relation of right) {
    if (!result.some(candidate => sameSequenceRelation(candidate, relation))) {
      result.push(canonicalSequenceRelation(relation))
    }
  }
  return result.sort((first, second) => sequenceRelationKey(first).localeCompare(sequenceRelationKey(second)))
}

function commonRelations(left: SequenceRelation[], right: SequenceRelation[]): SequenceRelation[] {
  const result: SequenceRelation[] = []
  for (const relation of left) {
    for (const candidate of right) {
      const shared = sharedRelation(relation, candidate)
      if (shared == null || result.some(existing => sameSequenceRelation(existing, shared))) continue
      result.push(shared)
    }
  }
  return result.sort((first, second) => sequenceRelationKey(first).localeCompare(sequenceRelationKey(second)))
}

function unionAdvances(left: ArraySummary['advances'], right: ArraySummary['advances']) {
  const result = [...left]
  for (const advance of right) {
    const index = result.findIndex(candidate => sameAdvanceIdentity(candidate, advance))
    if (index < 0) result.push(advance)
    else result[index] = {...advance, value: joinNumberValues(result[index]!.value, advance.value)}
  }
  return result
}

function commonAdvances(left: ArraySummary['advances'], right: ArraySummary['advances']) {
  const result: ArraySummary['advances'] = []
  for (const advance of left) {
    const match = right.find(candidate => sameAdvanceIdentity(advance, candidate))
    if (match != null) result.push({...advance, value: joinNumberValues(advance.value, match.value)})
  }
  return result
}

function mergeRowEnd(left: ArraySummary['lastEnd'], right: ArraySummary['lastEnd']) {
  if (left == null) return right
  if (right == null) return left
  return sameRowEndIdentity(left, right)
    ? {...left, value: joinNumberValues(left.value, right.value)}
    : null
}

function joinRowEnd(left: ArraySummary['lastEnd'], right: ArraySummary['lastEnd']) {
  if (left == null || right == null || !sameRowEndIdentity(left, right)) return null
  return {...left, value: joinNumberValues(left.value, right.value)}
}

function unionExtentEnds(left: ArraySummary['extentEnds'], right: ArraySummary['extentEnds']) {
  const result = [...left]
  for (const fact of right) {
    const index = result.findIndex(candidate => sameExtentEndIdentity(candidate, fact))
    if (index < 0) result.push(fact)
    else {
      result[index] = {
        ...fact,
        emptyExpr: preferredEquivalentExpression(result[index]!.emptyExpr, fact.emptyExpr),
        value: joinNumberValues(result[index]!.value, fact.value),
      }
    }
  }
  return result
}

function commonExtentEnds(left: ArraySummary['extentEnds'], right: ArraySummary['extentEnds']) {
  const result: ArraySummary['extentEnds'] = []
  for (const fact of left) {
    const match = right.find(candidate => sameExtentEndIdentity(fact, candidate))
    if (match != null) {
      result.push({
        ...fact,
        emptyExpr: preferredEquivalentExpression(fact.emptyExpr, match.emptyExpr),
        value: joinNumberValues(fact.value, match.value),
      })
    }
  }
  return result
}

function sharedRelation(left: SequenceRelation, right: SequenceRelation): SequenceRelation | null {
  if (left.kind !== right.kind || !sameSequenceTerm(left.left, right.left)) return null
  if (left.kind === 'adjacent-addition' && right.kind === 'adjacent-addition') {
    const addition = mergeEquivalentSequenceAddition(left.right, right.right)
    return addition == null ? null : canonicalSequenceRelation({...left, right: addition})
  }
  if (left.kind !== 'adjacent-comparison' || right.kind !== 'adjacent-comparison') return null
  if (!sameSequenceExpression(left.right, right.right)) return null
  const op = sharedComparisonOperator(left.op, right.op)
  if (op == null) return null
  const canonicalLeft = canonicalSequenceRelation(left)
  const canonicalRight = canonicalSequenceRelation(right)
  if (canonicalLeft.kind !== 'adjacent-comparison' || canonicalRight.kind !== 'adjacent-comparison') return null
  return {
    ...canonicalLeft,
    op,
    right: {
      terms: canonicalLeft.right.terms,
      addends: canonicalLeft.right.addends.map((addend, index) =>
        preferredEquivalentExpression(addend, canonicalRight.right.addends[index]!)),
    },
  }
}

function sharedComparisonOperator(left: ComparisonOperator, right: ComparisonOperator): ComparisonOperator | null {
  if (left === right) return left
  if (lowerBoundOperator(left) && lowerBoundOperator(right)) return '>='
  if (upperBoundOperator(left) && upperBoundOperator(right)) return '<='
  return null
}

function lowerBoundOperator(op: ComparisonOperator) {
  return op === '==' || op === '>=' || op === '>'
}

function upperBoundOperator(op: ComparisonOperator) {
  return op === '==' || op === '<=' || op === '<'
}

function canonicalArraySummary(summary: ArraySummary): ArraySummary {
  return {
    ...summary,
    relations: summary.relations
      .map(canonicalSequenceRelation)
      .sort((left, right) => sequenceRelationKey(left).localeCompare(sequenceRelationKey(right))),
    advances: [...summary.advances].sort((left, right) => left.prop.localeCompare(right.prop)),
    extentEnds: [...summary.extentEnds].sort((left, right) => {
      const leftKey = `${left.positionPath.join('.')}|${left.sizePath.join('.')}|${expressionKeyFromText(left.emptyExpr)}`
      const rightKey = `${right.positionPath.join('.')}|${right.sizePath.join('.')}|${expressionKeyFromText(right.emptyExpr)}`
      return leftKey.localeCompare(rightKey)
    }),
  }
}
