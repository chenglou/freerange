import type {
  ArrayOrigin,
  ArraySummary,
  ArrayValue,
} from './domain.ts'

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
