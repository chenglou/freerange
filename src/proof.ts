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
  type ReductionOffsets,
} from './proof-rules.ts'
import type {FitCheck} from './check-types.ts'
import {
  proofTraceForStatus,
  type FitObligation,
  type FitProofStep,
} from './obligations.ts'
import {
  additionIsExact,
  gridJoin,
  integerValued,
  possiblyNaN,
  linearNameForExpression,
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
  binaryExpression,
  cleanLinear,
  isZeroLinear,
  linearConstantStatus,
  linearAdd,
  linearConstant,
  linearFromExpressionText,
  linearFromTopOperation,
  linearScaleExact,
  linearSubtract,
  linearVariable,
  sameExpressionText,
  sameLinear,
  singleUnitAtom,
  type LinearExpr,
} from './linear.ts'
import {farkasProvesNonNegative, linearMaximum} from './farkas.ts'
import {
  rationalCompare,
  rationalDivide,
  rationalIsPositive,
  rationalIsZero,
  rationalNegate,
  rationalOne,
  rationalToNumberCeil,
  rationalToNumberFloor,
  rationalZero,
  type Rational,
} from './rational.ts'

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
  // Same-expression == needs NaN excluded: NaN !== NaN, and a value is
  // NaN-free once anything constrains it (NaN fails every comparison, so a
  // recorded fact about it is a non-NaN certificate).
  if (op === '==' && left.expr != null && right.expr != null && left.expr === right.expr && !admitsNaN(left, assumptions)) return {status: 'pass'}
  const mathTruth = proveMathLemma(left, op, right, assumptions)
  if (mathTruth === 'true') return {status: 'pass'}
  const truth = compareRanges(left, op, right, admitsNaN(left, assumptions) || admitsNaN(right, assumptions))
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

  const truth = compareRanges(left, op, right, admitsNaN(left, assumptions) || admitsNaN(right, assumptions))
  if (truth !== 'maybe') return {domain: 'numeric', rule: 'range-comparison', message: 'checked comparison from interval bounds'}

  const linearTruth = compareLinear(left, op, right, assumptions)
  if (linearTruth !== 'maybe') return {domain: 'numeric', rule: 'linear-comparison', message: 'checked comparison from exact linear facts'}

  if (ruleResult != null) return {domain: 'numeric', rule: ruleResult.rule, message: ruleResult.message}

  return {domain: 'numeric', rule: 'comparison', message: 'checked comparison claim'}
}

// NaN has no representation in the domain: any recorded comparison fact
// mentioning a value is false of NaN at runtime, so it certifies non-NaN the
// same way a finite hull bound does.
export function admitsNaN(value: NumberValue, assumptions: LinearConstraint[]): boolean {
  if (!possiblyNaN(value)) return false
  const atom = singleUnitAtom(value.linear) ?? value.expr
  if (atom == null) return true
  for (const assumption of assumptions) {
    // Only trusted or observed facts certify: a given is caller-checked and a
    // branch fact was tested at runtime, both false of NaN. A 'code' fact
    // (e.g. a published rounding bracket) may itself have assumed too much.
    if (assumption.source === 'code') continue
    if (assumption.leftExpr != null && sameExpressionText(assumption.leftExpr, atom)) return false
    if (assumption.rightExpr != null && sameExpressionText(assumption.rightExpr, atom)) return false
    if (assumption.diff != null && assumption.diff.terms.has(atom)) return false
  }
  return true
}

function compareRanges(left: NumberValue, op: ComparisonOperator, right: NumberValue, nanHazard: boolean): Truth {
  // A hull-decided 'true' against an infinite endpoint (x <= Infinity) is
  // false for NaN; 'false' verdicts stay sound since NaN fails every
  // comparison too.
  if (nanHazard && compareRangesPlain(left, op, right) === 'true') return 'maybe'
  return compareRangesPlain(left, op, right)
}

function compareRangesPlain(left: NumberValue, op: ComparisonOperator, right: NumberValue): Truth {
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

function provesExprNonNegative(expression: string, strict: boolean, assumptions: LinearConstraint[]): boolean {
  if (hasComparisonFact(expression, strict ? '>' : '>=', '0', assumptions)) return true
  const linear = linearFromExpressionText(expression)
  if (linear != null && provesNonNegative(linear, strict, assumptions)) return true
  return roundedSignNonNegative(expression, strict, assumptions)
}

// Sign survives rounding op-by-op. A real sum or difference of doubles that
// is positive is at least 2^-1074 (every double sits on that grid), which
// rounding to nearest cannot cross, so even strict sign carries through + and
// -; products and quotients keep >= 0 but can underflow a strict sign to
// zero.
function roundedSignNonNegative(expression: string, strict: boolean, assumptions: LinearConstraint[]): boolean {
  const sum = binaryExpression(expression, '+')
  const difference = binaryExpression(expression, '-')
  if (sum != null || difference != null) {
    const top = linearFromTopOperation(expression)
    if (top != null && provesNonNegative(top, strict, assumptions)) return true
    if (sum != null) {
      return (provesExprNonNegative(sum.left, strict, assumptions) && provesExprNonNegative(sum.right, false, assumptions))
        || (provesExprNonNegative(sum.left, false, assumptions) && provesExprNonNegative(sum.right, strict, assumptions))
    }
    return difference != null && hasComparisonFact(difference.left, strict ? '>' : '>=', difference.right, assumptions)
  }
  if (strict) return false
  const product = binaryExpression(expression, '*')
  if (product != null) {
    return provesExprNonNegative(product.left, false, assumptions) && provesExprNonNegative(product.right, false, assumptions)
  }
  const quotient = binaryExpression(expression, '/')
  if (quotient != null) {
    return provesExprNonNegative(quotient.left, false, assumptions) && provesExprNonNegative(quotient.right, true, assumptions)
  }
  return false
}

function proofRulesContext(assumptions: LinearConstraint[]): ProofRulesContext {
  return {
    assumptions,
    hasComparisonFact: (leftExpr, op, rightExpr, offsets) => hasComparisonFact(leftExpr, op, rightExpr, assumptions, offsets),
    provesExprNonNegative: (expression, strict) => provesExprNonNegative(expression, strict, assumptions),
    provesLinearNonNegative: (diff, strict) => provesNonNegative(diff, strict, assumptions),
  }
}

function hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string, assumptions: LinearConstraint[], offsets?: ReductionOffsets) {
  const leftOffset = offsets?.left ?? 0
  const rightOffset = offsets?.right ?? 0
  if (leftOffset === 0 && rightOffset === 0) {
    for (const assumption of assumptions) {
      if (assumption.leftExpr == null || assumption.rightExpr == null) continue
      if (sameExpressionText(assumption.leftExpr, leftExpr) && sameExpressionText(assumption.rightExpr, rightExpr) && comparisonImplies(assumption.op, op)) return true
      if (sameExpressionText(assumption.leftExpr, rightExpr) && sameExpressionText(assumption.rightExpr, leftExpr) && comparisonImplies(flipComparison(assumption.op), op)) return true
    }
    if (symbolicComparisonProves(leftExpr, op, rightExpr, assumptions)) return true
  }

  const leftLinear = offsetLinear(linearFromExpressionText(leftExpr), leftOffset)
  const rightLinear = offsetLinear(linearFromExpressionText(rightExpr), rightOffset)
  if (leftLinear == null || rightLinear == null) return false
  return compareLinear(
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, null, leftExpr, leftLinear),
    op,
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, null, rightExpr, rightLinear),
    assumptions,
  ) === 'true'
}

// A reduction offset is the prover's real arithmetic over the named double,
// never a program op.
function offsetLinear(linear: LinearExpr | null, offset: number): LinearExpr | null {
  if (linear == null || offset === 0) return linear
  return linearAdd(linear, linearConstant(offset))
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
    for (const scale of singleFactScales(target, fact.diff)) {
      const scaledFact = linearScaleExact(fact.diff, scale)
      const remainder = linearSubtract(target, scaledFact)
      if (remainder == null || sameLinear(remainder, target)) continue
      const missing = singleLinearBound(remainder)
      if (missing != null) return missing
    }
  }
  return null
}

// Candidate positive multiples that align one coefficient of the fact with the
// target — only used to suggest the smaller missing fact in reports; the
// prover itself decides by Farkas combination.
function singleFactScales(target: LinearExpr, fact: LinearExpr): Rational[] {
  const scales: Rational[] = []
  for (const [name, targetCoefficient] of target.terms) {
    const factCoefficient = fact.terms.get(name)
    if (factCoefficient == null || rationalIsZero(factCoefficient)) continue
    const scale = rationalDivide(targetCoefficient, factCoefficient)
    if (scale == null || !rationalIsPositive(scale)) continue
    if (!scales.some(existing => rationalIsZero(rationalSubtractLocal(existing, scale)))) scales.push(scale)
  }
  return scales
}

function rationalSubtractLocal(left: Rational, right: Rational): Rational {
  return {num: left.num * right.den - right.num * left.den, den: left.den * right.den}
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
  if (!rationalIsZero(clean.constant) || clean.terms.size !== 1) return null
  const first = [...clean.terms.entries()][0]
  if (first == null) return null
  const [name, coefficient] = first
  if (rationalIsZero(coefficient)) return null
  return rationalIsPositive(coefficient) ? `${name} >= 0` : `${name} <= 0`
}

export function comparisonConstraint(left: NumberValue, op: ComparisonOperator, right: NumberValue, text?: string, source: ConstraintSource = 'code'): LinearConstraint | null {
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null && left.expr == null && right.expr == null && text == null) return null
  if (diff == null && text == null && (left.expr == null || right.expr == null)) return null
  const integerStrict = diff != null && (op === '>' || op === '<') && integerValued(left) && integerValued(right)
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

  // A zero diff with no fact in play is self-comparison; only a fully
  // unconstrained value can be NaN, and NaN fails even x == x. The strict
  // 'false' verdicts below stay sound: NaN fails those comparisons too.
  if (isZeroLinear(diff) && (admitsNaN(left, assumptions) || admitsNaN(right, assumptions)) && op !== '>' && op !== '<') return 'maybe'

  switch (op) {
    case '==':
      if (isZeroLinear(diff)) return 'true'
      return provesNonNegative(diff, false, assumptions) && provesNonNegative(linearScaleExact(diff, rationalNegate(rationalOne)), false, assumptions) ? 'true' : 'maybe'
    case '>=':
      return provesNonNegative(diff, false, assumptions) ? 'true' : 'maybe'
    case '<=':
      return provesNonNegative(linearScaleExact(diff, rationalNegate(rationalOne)), false, assumptions) ? 'true' : 'maybe'
    case '>':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(diff, true, assumptions) ? 'true' : 'maybe'
    case '<':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(linearScaleExact(diff, rationalNegate(rationalOne)), true, assumptions) ? 'true' : 'maybe'
  }
}

function provesNonNegative(diff: LinearExpr, strict: boolean, assumptions: LinearConstraint[]) {
  const facts = assumptions.flatMap(nonNegativeConstraints)
  return proveNonNegativeFromConstraints(diff, strict, facts)
}

// Complete for linear consequences over the rationals: a nonnegative
// combination exists if and only if the claim follows (Farkas), so there is no
// depth cap to tune and no restatement that flips the verdict.
export function proveNonNegativeFromConstraints(diff: LinearExpr, strict: boolean, facts: NonNegativeConstraint[]) {
  const cleanDiff = cleanLinear(diff)
  if (linearConstantStatus(cleanDiff, strict)) return true
  return farkasProvesNonNegative(cleanDiff, strict, facts)
}

export type FactCounterexample =
  | {kind: 'point'; point: Map<string, Rational>}
  | {kind: 'unbounded'}

// A valuation the recorded facts admit under which `left op right` is false —
// the facts themselves disprove the claim, contract-modularly. Two guards keep
// this honest: every variable of the claim must be mentioned by some fact (a
// value the analyzer forgot has no facts, and the absence of constraints is
// not evidence), and only all-integer vertices are reported (a fractional
// assignment may not be a real input when parameters are integers).
export function comparisonCounterexample(
  left: NumberValue,
  op: ComparisonOperator,
  right: NumberValue,
  assumptions: LinearConstraint[],
): FactCounterexample | null {
  // A value without a linear form still has a name and an interval; for the
  // search it acts as one bounded variable.
  const leftLinear = left.linear ?? (left.expr == null ? null : linearVariable(linearNameForExpression(left.expr)))
  const rightLinear = right.linear ?? (right.expr == null ? null : linearVariable(linearNameForExpression(right.expr)))
  if (leftLinear == null || rightLinear == null) return null
  const satisfied = op === '<=' || op === '<'
    ? linearSubtract(rightLinear, leftLinear)
    : linearSubtract(leftLinear, rightLinear)
  if (satisfied == null || op === '==') return null
  const violation = cleanLinear(linearScaleExact(satisfied, rationalNegate(rationalOne)))
  if (violation.terms.size === 0) return null
  const facts = [
    ...assumptions.flatMap(nonNegativeConstraints),
    ...intervalConstraints({...left, linear: leftLinear}),
    ...intervalConstraints({...right, linear: rightLinear}),
  ]
  // Anchoring needs interface facts — givens and checked contracts: a vertex
  // is a contract-modular witness only when the variables are pinned down by
  // what the caller asserted, not by a derived hull (a loop accumulator's
  // interval over-approximates its trajectory, so a point inside it need not
  // be reachable).
  const anchored = new Set<string>()
  for (const assumption of assumptions) {
    if (assumption.source === 'code' || assumption.source === 'branch') continue
    for (const fact of nonNegativeConstraints(assumption)) {
      for (const name of fact.diff.terms.keys()) anchored.add(name)
    }
  }
  for (const name of violation.terms.keys()) {
    if (!anchored.has(name)) return null
  }
  const extremum = linearMaximum(violation, facts)
  if (extremum.kind === 'infeasible') return null
  if (extremum.kind === 'unbounded') return {kind: 'unbounded'}
  const sign = rationalCompare(extremum.value, rationalZero)
  const strictClaim = op === '>' || op === '<'
  if (!(strictClaim ? sign >= 0 : sign > 0)) return null
  for (const value of extremum.point.values()) {
    if (value.den !== 1n) return null
  }
  // Report the claim's own variables; the rest of the assignment is real but
  // not informative.
  const point = new Map<string, Rational>()
  for (const name of violation.terms.keys()) {
    const assigned = extremum.point.get(name)
    if (assigned != null) point.set(name, assigned)
  }
  return {kind: 'point', point}
}

// The best constant bounds the published facts prove for a value, found with
// the same simplex the counterexample search uses: the interval the polytope
// projects onto, intersected with the value's own interval.
export function provableBounds(value: NumberValue, assumptions: LinearConstraint[]): {min: number; max: number} {
  if (value.linear == null || value.linear.terms.size === 0) return {min: value.min, max: value.max}
  const facts = assumptions.flatMap(nonNegativeConstraints)
  const anchored = new Set<string>()
  for (const fact of facts) for (const name of fact.diff.terms.keys()) anchored.add(name)
  for (const name of value.linear.terms.keys()) {
    if (!anchored.has(name)) return {min: value.min, max: value.max}
  }
  // The optima are exact rationals; published endpoints round outward so the
  // hull never tightens past the polytope.
  let min = value.min
  let max = value.max
  const upper = linearMaximum(value.linear, facts)
  if (upper.kind === 'optimum') max = Math.min(max, rationalToNumberCeil(upper.value))
  const lower = linearMaximum(linearScaleExact(value.linear, rationalNegate(rationalOne)), facts)
  if (lower.kind === 'optimum') min = Math.max(min, rationalToNumberFloor(rationalNegate(lower.value)))
  return min <= max ? {min, max} : {min: value.min, max: value.max}
}

// The value's own interval is sound knowledge the fact set may not spell out.
function intervalConstraints(value: NumberValue): NonNegativeConstraint[] {
  if (value.linear == null) return []
  const facts: NonNegativeConstraint[] = []
  const lower = linearConstant(value.min)
  if (lower != null) {
    const diff = linearSubtract(value.linear, lower)
    if (diff != null) facts.push({diff, strict: false})
  }
  const upper = linearConstant(value.max)
  if (upper != null) {
    const diff = linearSubtract(upper, value.linear)
    if (diff != null) facts.push({diff, strict: false})
  }
  return facts
}

export function nonNegativeConstraints(assumption: LinearConstraint): NonNegativeConstraint[] {
  if (assumption.diff == null) return []
  switch (assumption.op) {
    case '==':
      return [
        nonNegativeConstraint(assumption.diff, false, assumption.text),
        nonNegativeConstraint(linearScaleExact(assumption.diff, rationalNegate(rationalOne)), false, assumption.text == null ? undefined : `${assumption.text} reversed`),
      ]
    case '>=':
      return [nonNegativeConstraint(assumption.diff, false, assumption.text)]
    case '<=':
      return [nonNegativeConstraint(linearScaleExact(assumption.diff, rationalNegate(rationalOne)), false, assumption.text)]
    case '>':
      return strictNonNegativeConstraints(assumption.diff, assumption)
    case '<':
      return strictNonNegativeConstraints(linearScaleExact(assumption.diff, rationalNegate(rationalOne)), assumption)
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
  // The one-iteration fact compares the runtime accumulator against the REAL
  // sum start + increment, which a rounded first addition can undershoot;
  // only an exact addition supports it.
  if (count.min >= 1 && start.linear != null && increment.linear != null && additionIsExact(start, increment)) {
    const oneIterEnd = numberValue(
      start.min + increment.min,
      start.max + increment.max,
      gridJoin(start.grid, increment.grid),
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
