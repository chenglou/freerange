import * as ts from 'typescript'
import type {FitCheckStatus, EvalContext} from './check-types.ts'
import type {Value} from './domain.ts'
import {
  fitExpressionParsed,
  publicParsedExpressionText,
  type FitExpressionLike,
} from './parser.ts'

type BooleanExpressionClaim = {
  key: string
  expected: boolean
}

export function assumeBooleanExpression(context: EvalContext, expression: FitExpressionLike) {
  const claim = booleanExpressionClaim(expression)
  context.booleanAssumptions ??= new Map()
  context.booleanAssumptions.set(claim.key, claim.expected)
}

export function booleanExpressionIsAssumed(context: EvalContext, expression: FitExpressionLike) {
  const claim = booleanExpressionClaim(expression)
  return context.booleanAssumptions?.get(claim.key) === claim.expected
}

export function conflictingBooleanExpressionAssumption(context: EvalContext, expression: FitExpressionLike): string | null {
  const claim = booleanExpressionClaim(expression)
  if (context.booleanAssumptions?.has(claim.key) !== true) return null
  const existing = context.booleanAssumptions.get(claim.key)!
  return existing === claim.expected
    ? null
    : `given ${booleanClaimText({key: claim.key, expected: existing})} and given ${booleanClaimText(claim)}`
}

export function proveBooleanTrue(text: string, value: Value): {status: FitCheckStatus; reason?: string} {
  if (value.kind === 'unknown') return {status: 'unknown', reason: value.reason}
  if (value.kind !== 'literal') return {status: 'unknown', reason: `${text} expected a boolean result`}
  const booleans = value.values.filter(item => typeof item === 'boolean')
  if (booleans.length !== value.values.length) return {status: 'unknown', reason: `${text} expected a boolean result`}
  if (booleans.every(item => item === true)) return {status: 'pass'}
  if (booleans.every(item => item === false)) return {status: 'fail', reason: `${text} returned false`}
  return {status: 'unknown', reason: `${text} was not proven true`}
}

function booleanExpressionClaim(expression: FitExpressionLike): BooleanExpressionClaim {
  const parsed = fitExpressionParsed(expression)
  let node = parsed.expression
  let expected = true
  while (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    expected = !expected
    node = node.operand
  }
  return {
    key: publicParsedExpressionText(parsed, node),
    expected,
  }
}

function booleanClaimText(claim: BooleanExpressionClaim) {
  return claim.expected ? claim.key : `!${claim.key}`
}
