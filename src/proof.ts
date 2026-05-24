import {type ComparisonOperator} from './parser.ts'
import {
  comparisonFailureReason,
  comparisonNeed,
  formatRange,
} from './reporting.ts'
import {
  comparisonRulesMissing,
  evaluateComparisonRules,
  symbolicComparisonProves,
  type ProofRulesContext,
} from './proof-rules.ts'
import type {FitCheck} from './check-types.ts'
import {
  proofTraceForStatus,
  type FitObligation,
  type FitProofStep,
} from './obligations.ts'
import {
  literalKey,
  numberBranches,
  numberValue,
  unknownNumber,
  type ConstraintSource,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from './domain.ts'
import {mergeAssumptions} from './assumptions.ts'
import {
  cleanLinear,
  isZeroLinear,
  linearConstantStatus,
  linearAdd,
  linearConstant,
  linearFromExpressionText,
  linearKey,
  linearScaleExact,
  linearSubtract,
  positiveScaleMultiple,
  reductionScales,
  sameExpressionText,
  sameLinear,
  type LinearExpr,
} from './linear.ts'

export type Truth = 'true' | 'false' | 'maybe'

export type NonNegativeConstraint = {
  diff: LinearExpr
  strict: boolean
  text?: string
}

export type ComparisonProofStep = {
  domain: string
  rule: string
  message: string
}

export type ComparisonProof = {
  status: 'pass' | 'fail' | 'unknown'
  reason?: string
  step: ComparisonProofStep
}

const maxLinearReductionDepth = 4

export function proveComparison(left: Value, op: ComparisonOperator, right: Value, assumptions: LinearConstraint[]): {status: 'pass' | 'fail' | 'unknown'; reason?: string} {
  return proofStatus(proveComparisonWithStep(left, op, right, assumptions))
}

export function proveComparisonWithStep(left: Value, op: ComparisonOperator, right: Value, assumptions: LinearConstraint[]): ComparisonProof {
  const literalEquality = proveLiteralEquality(left, op, right)
  if (literalEquality != null) return literalEquality
  const structuralEquality = proveStructuralEquality(left, op, right)
  if (structuralEquality != null) return {...structuralEquality, step: structuralEqualityProofStep(left, op, right)!}
  if (left.kind !== 'number') {
    return {status: 'unknown', reason: nonNumberReason(left), step: nonNumberComparisonStep()}
  }
  if (right.kind !== 'number') {
    return {status: 'unknown', reason: nonNumberReason(right), step: nonNumberComparisonStep()}
  }
  if (left.cases != null || right.cases != null) {
    const joinedStatus = proveComparisonPlain(left, op, right, assumptions)
    if (joinedStatus.status === 'pass') return {...joinedStatus, step: comparisonProofStepPlain(left, op, right, assumptions)}
    let unknownStatus: {status: 'pass' | 'fail' | 'unknown'; reason?: string} | null = null
    for (const leftCase of numberBranches(left)) {
      for (const rightCase of numberBranches(right)) {
        const status = proveComparisonPlain(
          leftCase.value,
          op,
          rightCase.value,
          mergeAssumptions(assumptions, leftCase.assumptions, rightCase.assumptions),
        )
        if (status.status === 'fail') return {...status, step: branchComparisonStep()}
        if (status.status === 'unknown') unknownStatus = status
      }
    }
    return {...(unknownStatus ?? {status: 'pass'}), step: branchComparisonStep()}
  }
  return {...proveComparisonPlain(left, op, right, assumptions), step: comparisonProofStepPlain(left, op, right, assumptions)}
}

function proofStatus(proof: ComparisonProof): {status: 'pass' | 'fail' | 'unknown'; reason?: string} {
  return proof.reason == null ? {status: proof.status} : {status: proof.status, reason: proof.reason}
}

function nonNumberComparisonStep(): ComparisonProofStep {
  return {domain: 'shape', rule: 'non-number-comparison', message: 'checked comparison shape'}
}

function branchComparisonStep(): ComparisonProofStep {
  return {domain: 'numeric', rule: 'branch-comparison', message: 'checked comparison across finite numeric branches'}
}

function proveLiteralEquality(left: Value, op: ComparisonOperator, right: Value): ComparisonProof | null {
  if (op !== '==') return null
  if (left.kind !== 'literal' || right.kind !== 'literal') return null
  const leftKeys = new Set(left.values.map(literalKey))
  const rightKeys = new Set(right.values.map(literalKey))
  const overlap = [...leftKeys].some(key => rightKeys.has(key))
  const equalSets = leftKeys.size === rightKeys.size && [...leftKeys].every(key => rightKeys.has(key))
  const step: ComparisonProofStep = {domain: 'literal', rule: 'literal-equality', message: 'checked literal equality'}
  if (equalSets && leftKeys.size === 1) return {status: 'pass', step}
  if (!overlap) {
    const leftText = formatLiteralSet(left.values)
    const rightText = formatLiteralSet(right.values)
    return {status: 'fail', reason: `${leftText} cannot equal ${rightText}`, step}
  }
  return {status: 'unknown', reason: 'literal values overlap but are not equal', step}
}

function formatLiteralSet(values: ReadonlyArray<string | boolean>) {
  return values.length === 1 ? String(values[0]) : `{${values.map(String).join(', ')}}`
}

function proveStructuralEquality(left: Value, op: ComparisonOperator, right: Value): {status: 'pass' | 'unknown'; reason?: string} | null {
  if (left.kind === 'number' && right.kind === 'number') return null
  if (op !== '==') return null

  const leftExpr = structuralExpr(left)
  const rightExpr = structuralExpr(right)
  if (leftExpr != null && rightExpr != null && sameExpressionText(leftExpr, rightExpr)) return {status: 'pass'}
  if (left.kind === 'unknown') return {status: 'unknown', reason: left.reason}
  if (right.kind === 'unknown') return {status: 'unknown', reason: right.reason}
  return {status: 'unknown', reason: 'Non-number equality is only proven for the same source expression'}
}

function structuralEqualityProofStep(left: Value, op: ComparisonOperator, right: Value): ComparisonProofStep | null {
  if (left.kind === 'number' && right.kind === 'number') return null
  if (op !== '==') return null
  const leftExpr = structuralExpr(left)
  const rightExpr = structuralExpr(right)
  if (leftExpr != null && rightExpr != null && sameExpressionText(leftExpr, rightExpr)) {
    return {domain: 'shape', rule: 'structural-equality', message: 'matched the same source expression'}
  }
  return {domain: 'shape', rule: 'structural-equality', message: 'checked equality by source identity'}
}

function structuralExpr(value: Value): string | null {
  if (value.kind === 'number' || value.kind === 'unknown') return null
  return value.expr
}

export function proveComparisonPlain(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): {status: 'pass' | 'fail' | 'unknown'; reason?: string} {
  if (op === '==' && left.expr != null && right.expr != null && left.expr === right.expr) return {status: 'pass'}
  const mathTruth = proveMathLemma(left, op, right, assumptions)
  if (mathTruth === 'true') return {status: 'pass'}
  const truth = compareRanges(left, op, right)
  if (truth === 'true') return {status: 'pass'}
  if (truth === 'false') return {status: 'fail', reason: comparisonFailureReason(left, right, assumptions, 'is false', missingComparisonFact(left, op, right, assumptions))}
  const linearTruth = compareLinear(left, op, right, assumptions)
  if (linearTruth === 'true') return {status: 'pass'}
  if (linearTruth === 'false') return {status: 'fail', reason: comparisonFailureReason(left, right, assumptions, 'is false by exact linear facts', missingComparisonFact(left, op, right, assumptions))}
  return {status: 'unknown', reason: comparisonFailureReason(left, right, assumptions, 'was not proven', missingComparisonFact(left, op, right, assumptions))}
}

function comparisonProofStepPlain(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): ComparisonProofStep {
  if (op === '==' && left.expr != null && right.expr != null && left.expr === right.expr) {
    return {domain: 'source', rule: 'same-expression', message: 'matched the same source expression'}
  }
  const ruleResult = evaluateComparisonRules({left, op, right}, proofRulesContext(assumptions))
  if (ruleResult?.status === 'pass') return {domain: 'numeric', rule: ruleResult.rule, message: ruleResult.message}

  const truth = compareRanges(left, op, right)
  if (truth !== 'maybe') return {domain: 'numeric', rule: 'range-comparison', message: 'checked comparison from interval bounds'}

  const linearTruth = compareLinear(left, op, right, assumptions)
  if (linearTruth !== 'maybe') return {domain: 'numeric', rule: 'linear-comparison', message: 'checked comparison from exact linear facts'}

  if (ruleResult != null) return {domain: 'numeric', rule: ruleResult.rule, message: ruleResult.message}

  return {domain: 'numeric', rule: 'comparison', message: 'checked comparison claim'}
}

function compareRanges(left: NumberValue, op: ComparisonOperator, right: NumberValue): Truth {
  switch (op) {
    case '==':
      if (left.min === left.max && right.min === right.max && left.min === right.min) return 'true'
      if (left.max < right.min || right.max < left.min) return 'false'
      return 'maybe'
    case '>=':
      if (left.min >= right.max) return 'true'
      if (left.max < right.min) return 'false'
      return 'maybe'
    case '<=':
      if (left.max <= right.min) return 'true'
      if (left.min > right.max) return 'false'
      return 'maybe'
    case '>':
      if (left.min > right.max) return 'true'
      if (left.max <= right.min) return 'false'
      return 'maybe'
    case '<':
      if (left.max < right.min) return 'true'
      if (left.min >= right.max) return 'false'
      return 'maybe'
  }
}

function proveMathLemma(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): Truth {
  return evaluateComparisonRules({left, op, right}, proofRulesContext(assumptions))?.status === 'pass' ? 'true' : 'maybe'
}

function provesExprNonNegative(expression: string, strict: boolean, assumptions: LinearConstraint[]) {
  if (hasComparisonFact(expression, strict ? '>' : '>=', '0', assumptions)) return true
  const linear = linearFromExpressionText(expression)
  return linear != null && provesNonNegative(linear, strict, assumptions)
}

function proofRulesContext(assumptions: LinearConstraint[]): ProofRulesContext {
  return {
    assumptions,
    hasComparisonFact: (leftExpr, op, rightExpr) => hasComparisonFact(leftExpr, op, rightExpr, assumptions),
    provesExprNonNegative: (expression, strict) => provesExprNonNegative(expression, strict, assumptions),
  }
}

function hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string, assumptions: LinearConstraint[]) {
  for (const assumption of assumptions) {
    if (assumption.leftExpr == null || assumption.rightExpr == null) continue
    if (sameExpressionText(assumption.leftExpr, leftExpr) && sameExpressionText(assumption.rightExpr, rightExpr) && comparisonImplies(assumption.op, op)) return true
    if (sameExpressionText(assumption.leftExpr, rightExpr) && sameExpressionText(assumption.rightExpr, leftExpr) && comparisonImplies(flipComparison(assumption.op), op)) return true
  }
  if (symbolicComparisonProves(leftExpr, op, rightExpr, assumptions)) return true

  const leftLinear = linearFromExpressionText(leftExpr)
  const rightLinear = linearFromExpressionText(rightExpr)
  if (leftLinear == null || rightLinear == null) return false
  return compareLinear(
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, leftExpr, leftLinear),
    op,
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, rightExpr, rightLinear),
    assumptions,
  ) === 'true'
}

function comparisonImplies(actual: ComparisonOperator, needed: ComparisonOperator) {
  if (actual === needed) return true
  if (actual === '==') return needed === '>=' || needed === '<='
  if (actual === '>') return needed === '>='
  if (actual === '<') return needed === '<='
  return false
}

export function flipComparison(op: ComparisonOperator): ComparisonOperator {
  switch (op) {
    case '==':
      return '=='
    case '>=':
      return '<='
    case '<=':
      return '>='
    case '>':
      return '<'
    case '<':
      return '>'
  }
}

function missingComparisonFact(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]) {
  const strictSelf = strictSelfComparisonMissing(left, op, right)
  if (strictSelf != null) return strictSelf
  const rulesMissing = comparisonRulesMissing({left, op, right}, proofRulesContext(assumptions))
  if (rulesMissing != null) return rulesMissing
  const missingLinear = missingLinearFact(left, op, right, assumptions)
  if (missingLinear != null) return missingLinear
  return `given ${comparisonNeed(left, op, right)}`
}

function strictSelfComparisonMissing(left: NumberValue, op: ComparisonOperator, right: NumberValue) {
  if (op !== '>' && op !== '<') return null
  const leftName = left.expr ?? formatRange(left)
  const rightName = right.expr ?? formatRange(right)
  if (left.expr != null && right.expr != null && sameExpressionText(left.expr, right.expr)) {
    return `strict comparison cannot hold when both sides are ${leftName}`
  }
  if (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear)) {
    return `strict comparison cannot hold because ${leftName} and ${rightName} are equal by exact linear facts`
  }
  return null
}

function missingLinearFact(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]) {
  const diff = comparisonDiff(left, op, right)
  if (diff == null) return null
  const target = cleanLinear(diff)
  for (const fact of assumptions.filter(assumption => assumption.fromRange !== true).flatMap(nonNegativeConstraints)) {
    for (const scale of reductionScales(target, fact.diff)) {
      const scaledFact = linearScaleExact(fact.diff, scale)
      const remainder = linearSubtract(target, scaledFact)
      if (remainder == null || sameLinear(remainder, target)) continue
      const missing = singleLinearBound(remainder)
      if (missing != null) return missing
    }
  }
  return null
}

function comparisonDiff(left: NumberValue, op: ComparisonOperator, right: NumberValue): LinearExpr | null {
  switch (op) {
    case '==':
      return null
    case '>=':
    case '>':
      return linearSubtract(left.linear, right.linear)
    case '<=':
    case '<':
      return linearSubtract(right.linear, left.linear)
  }
}

function singleLinearBound(linear: LinearExpr) {
  const clean = cleanLinear(linear)
  if (clean.constant !== 0 || clean.terms.size !== 1) return null
  const first = [...clean.terms.entries()][0]
  if (first == null) return null
  const [name, coefficient] = first
  if (coefficient === 0) return null
  return coefficient > 0 ? `${name} >= 0` : `${name} <= 0`
}

export function comparisonConstraint(left: NumberValue, op: ComparisonOperator, right: NumberValue, text?: string, source: ConstraintSource = 'code'): LinearConstraint | null {
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null && left.expr == null && right.expr == null && text == null) return null
  if (diff == null && text == null && (left.expr == null || right.expr == null)) return null
  const integerStrict = diff != null && (op === '>' || op === '<') && left.isInteger && right.isInteger
  return {
    diff,
    op,
    source,
    ...(left.expr == null ? {} : {leftExpr: left.expr}),
    ...(right.expr == null ? {} : {rightExpr: right.expr}),
    ...(text == null ? {} : {text}),
    ...(integerStrict ? {integerStrict: true as const} : {}),
  }
}

export function comparisonFactContradictedByAssumptions(fact: LinearConstraint, assumptions: LinearConstraint[]) {
  if (fact.leftExpr == null || fact.rightExpr == null) return false
  const left = unknownNumber(fact.leftExpr)
  const right = unknownNumber(fact.rightExpr)
  return contradictoryComparisons(fact.op).some(op => proveComparisonPlain(left, op, right, assumptions).status === 'pass')
}

function contradictoryComparisons(op: ComparisonOperator): ComparisonOperator[] {
  switch (op) {
    case '==':
      return ['<', '>']
    case '>=':
      return ['<']
    case '<=':
      return ['>']
    case '>':
      return ['<=']
    case '<':
      return ['>=']
  }
}

export function constraintsFromRange(
  value: NumberValue,
  lower: NumberValue,
  lowerInclusive: boolean,
  upper: NumberValue,
  upperInclusive: boolean,
  text: string,
  source: ConstraintSource,
): LinearConstraint[] {
  return [
    comparisonConstraint(value, lowerInclusive ? '>=' : '>', lower, text, source),
    comparisonConstraint(value, upperInclusive ? '<=' : '<', upper, text, source),
  ].filter(fact => fact != null).map(fact => ({...fact, fromRange: true}))
}

function compareLinear(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): Truth {
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null) return 'maybe'

  switch (op) {
    case '==':
      if (isZeroLinear(diff)) return 'true'
      return provesNonNegative(diff, false, assumptions) && provesNonNegative(linearScaleExact(diff, -1), false, assumptions) ? 'true' : 'maybe'
    case '>=':
      return provesNonNegative(diff, false, assumptions) ? 'true' : 'maybe'
    case '<=':
      return provesNonNegative(linearScaleExact(diff, -1), false, assumptions) ? 'true' : 'maybe'
    case '>':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(diff, true, assumptions) ? 'true' : 'maybe'
    case '<':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(linearScaleExact(diff, -1), true, assumptions) ? 'true' : 'maybe'
  }
}

function provesNonNegative(diff: LinearExpr, strict: boolean, assumptions: LinearConstraint[]) {
  const facts = assumptions.flatMap(nonNegativeConstraints)
  return proveNonNegativeFromConstraints(diff, strict, facts)
}

export function proveNonNegativeFromConstraints(diff: LinearExpr, strict: boolean, facts: NonNegativeConstraint[]) {
  return reduceToNonNegative(diff, strict, facts, maxLinearReductionDepth, new Set())
}

function reduceToNonNegative(
  diff: LinearExpr,
  strict: boolean,
  facts: NonNegativeConstraint[],
  depth: number,
  seen: Set<string>,
): boolean {
  const cleanDiff = cleanLinear(diff)
  if (linearConstantStatus(cleanDiff, strict)) return true
  for (const fact of facts) {
    const scale = positiveScaleMultiple(cleanDiff, fact.diff)
    if (scale != null && (!strict || fact.strict)) return true
  }
  if (depth === 0) return false

  const key = `${strict ? 'strict' : 'loose'}:${linearKey(cleanDiff)}`
  if (seen.has(key)) return false
  seen.add(key)

  for (const fact of facts) {
    for (const scale of reductionScales(cleanDiff, fact.diff)) {
      const scaledFact = linearScaleExact(fact.diff, scale)
      const remainder = linearSubtract(cleanDiff, scaledFact)
      if (remainder == null || sameLinear(remainder, cleanDiff)) continue
      if (reduceToNonNegative(remainder, strict && !fact.strict, facts, depth - 1, new Set(seen))) return true
    }
  }
  return false
}

export function nonNegativeConstraints(assumption: LinearConstraint): NonNegativeConstraint[] {
  if (assumption.diff == null) return []
  switch (assumption.op) {
    case '==':
      return [
        nonNegativeConstraint(assumption.diff, false, assumption.text),
        nonNegativeConstraint(linearScaleExact(assumption.diff, -1), false, assumption.text == null ? undefined : `${assumption.text} reversed`),
      ]
    case '>=':
      return [nonNegativeConstraint(assumption.diff, false, assumption.text)]
    case '<=':
      return [nonNegativeConstraint(linearScaleExact(assumption.diff, -1), false, assumption.text)]
    case '>':
      return strictNonNegativeConstraints(assumption.diff, assumption)
    case '<':
      return strictNonNegativeConstraints(linearScaleExact(assumption.diff, -1), assumption)
  }
}

function strictNonNegativeConstraints(diff: LinearExpr, assumption: LinearConstraint): NonNegativeConstraint[] {
  const facts = [nonNegativeConstraint(diff, true, assumption.text)]
  if (assumption.integerStrict === true) {
    const stepped = linearAdd(diff, linearConstant(-1))
    if (stepped != null) facts.push(nonNegativeConstraint(stepped, false, assumption.text))
  }
  return facts
}

function nonNegativeConstraint(diff: LinearExpr, strict: boolean, text?: string): NonNegativeConstraint {
  return {diff, strict, ...(text == null ? {} : {text})}
}

function nonNumberReason(value: Exclude<Value, NumberValue>) {
  if (value.kind === 'unknown') return value.reason
  if (value.kind === 'nullable') return `Nullable value ${value.expr ?? '<value>'} was not proven present`
  if (value.kind === 'null') return 'Expected a number, got null'
  if (value.kind === 'literal') return 'Expected a number, got a literal value'
  return value.kind === 'array' ? 'Expected a number, got an array' : 'Expected a number, got an object'
}

export function runningSumFacts(value: NumberValue, start: NumberValue, count: NumberValue, increment: NumberValue): LinearConstraint[] {
  const facts: LinearConstraint[] = []
  if (increment.min >= 0) {
    const lower = comparisonConstraint(value, '>=', start, `${value.expr ?? formatRange(value)} >= ${start.expr ?? formatRange(start)}`)
    if (lower != null) facts.push(lower)
  }
  if (increment.max <= 0) {
    const upper = comparisonConstraint(value, '<=', start, `${value.expr ?? formatRange(value)} <= ${start.expr ?? formatRange(start)}`)
    if (upper != null) facts.push(upper)
  }
  if (count.min >= 1 && start.linear != null && increment.linear != null) {
    const oneIterEnd = numberValue(
      start.min + increment.min,
      start.max + increment.max,
      start.isInteger && increment.isInteger,
      null,
      linearAdd(start.linear, increment.linear),
    )
    if (increment.min >= 0) {
      const lower = comparisonConstraint(value, '>=', oneIterEnd, `${value.expr ?? formatRange(value)} >= start + increment`)
      if (lower != null) facts.push(lower)
    }
    if (increment.max <= 0) {
      const upper = comparisonConstraint(value, '<=', oneIterEnd, `${value.expr ?? formatRange(value)} <= start + increment`)
      if (upper != null) facts.push(upper)
    }
  }
  if (start.min === 0 && start.max === 0 && increment.min === 1 && increment.max === 1) {
    const upper = comparisonConstraint(value, '<=', count, `${value.expr ?? formatRange(value)} <= ${count.expr ?? formatRange(count)}`)
    if (upper != null) facts.push(upper)
  }
  return facts
}

export type ProveObligationOptions = {
  obligation: FitObligation
  step: FitProofStep
  usedFacts?: string[]
  prove: () => FitCheck
}

export function proveObligation(options: ProveObligationOptions): FitCheck {
  const check = options.prove()
  return {
    ...check,
    obligation: options.obligation,
    trace: proofTraceForStatus(options.obligation, check.status, [options.step], options.usedFacts),
  }
}
