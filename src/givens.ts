import * as ts from 'typescript'
import type {
  AssumedGivenSpec,
  EvalContext,
  FitCheck,
  FitCheckStatus,
  FunctionContractProof,
  Program,
} from './check-types.ts'
import {
  assumeBooleanExpression,
  conflictingBooleanExpressionAssumption,
  proveBooleanTrue,
} from './boolean-claims.ts'
import {
  finiteNumberValue,
  linearNameForExpression,
  numberWithBounds,
  numberValue,
  withNumberCases,
  type ArraySummary,
  type ArrayValue,
  type Assumption,
  type ConstraintSource,
  type LinearConstraint,
  type NumberValue,
  type SequenceAddition,
  type SequenceRelation,
  type Value,
  gridMeet,
} from './domain.ts'
import {
  parsePrintedNumber,
  setCheckedDomainPathValue,
} from './domain-paths.ts'
import {linearConstraints} from './assumptions.ts'
import {
  cleanLinear,
  linearScaleExact,
  linearVariable,
  sameExpressionText,
  isFixedElementPathExpression,
} from './linear.ts'
import {rationalCompare, rationalNegate, rationalOne, rationalZero} from './rational.ts'
import {
  fitSpecIsAssumption,
  fitExpressionParsed,
  fitExpressionText,
  fitRangeCases,
  parseDomainPathText,
  publicFitText,
  type ComparisonOperator,
  type FitExpression,
  type FitExpressionLike,
  type FitComparisonGivenSpec,
  type FitExpressionGivenSpec,
  type FitRange,
  type FitRangeCase,
  type FitRangeGivenSpec,
  type FitSpec,
} from './parser.ts'
import {
  comparisonConstraint,
  comparisonFactContradictedByAssumptions,
  flipComparison,
  nonNegativeConstraints,
  proveComparison,
  proveNonNegativeFromConstraints,
  constraintsFromRange,
  type NonNegativeConstraint,
} from './proof.ts'
import {
  arrayLengthRoot,
} from './source-expressions.ts'
import {formatRangeSpec} from './reporting.ts'
import {ambiguousRowAxes, rowAxes, type RowAxis} from './sequence-facts.ts'

export type GivenEvaluators = {
  evaluateRangeBound(text: FitExpressionLike, context: EvalContext): Value
  evaluateSpecExpression(text: FitExpressionLike, context: EvalContext): Value
}

export function validateGivenSpecs(
  file: string,
  functionName: string,
  specs: FitSpec[],
  allowedRoots: string[],
  source: Extract<ConstraintSource, 'function-given' | 'loop-given'>,
): {assumedGivens: AssumedGivenSpec[]; checks: FitCheck[]} {
  const assumedGivens: AssumedGivenSpec[] = []
  const checks: FitCheck[] = []
  const ranges: FitRangeGivenSpec[] = []

  for (const spec of specs) {
    if (!fitSpecIsAssumption(spec)) continue
    if (spec.kind === 'expression') {
      const badRoot = givenExpressionBadRoot(spec.expression, allowedRoots)
      if (badRoot != null) {
        checks.push(invalidGivenCheck(file, functionName, spec, invalidGivenRootReason(badRoot, allowedRoots)))
        continue
      }
      assumedGivens.push({kind: 'expression', spec, source})
      continue
    }
    const badRoot = givenBadRoot(spec, allowedRoots)
    if (badRoot != null) {
      checks.push(invalidGivenCheck(file, functionName, spec, invalidGivenRootReason(badRoot, allowedRoots)))
      continue
    }
    const shapeProblem = givenShapeProblem(spec)
    if (shapeProblem != null) {
      checks.push(invalidGivenCheck(file, functionName, spec, shapeProblem))
      continue
    }

    if (spec.kind === 'range') {
      const rangeProblem = givenRangeProblem(spec, ranges)
      if (rangeProblem != null) {
        checks.push({file, functionName, ...(spec.line == null ? {} : {line: spec.line}), text: spec.text, status: 'fail', reason: rangeProblem})
        continue
      }
      ranges.push(spec)
      assumedGivens.push({kind: 'range', spec, source})
      continue
    }

    assumedGivens.push({kind: 'comparison', spec, source})
  }

  return {assumedGivens, checks}
}

function invalidGivenRootReason(root: string, allowedRoots: string[]) {
  const publicRoot = publicFitText(root)
  const suggestion = suggestedRootName(publicRoot, allowedRoots.map(publicFitText))
  return suggestion == null
    ? `${publicRoot} not found in this contract scope`
    : `${publicRoot} not found in this contract scope\ndid you mean ${suggestion}?`
}

function suggestedRootName(root: string, candidates: string[]): string | null {
  let best: {candidate: string; distance: number} | null = null
  let tied = false
  for (const candidate of new Set(candidates)) {
    if (candidate === root) continue
    const distance = editDistance(root.toLowerCase(), candidate.toLowerCase())
    if (distance > rootSuggestionDistanceLimit(root)) continue
    if (best == null || distance < best.distance) {
      best = {candidate, distance}
      tied = false
      continue
    }
    if (distance === best.distance) tied = true
  }
  return best != null && !tied ? best.candidate : null
}

function rootSuggestionDistanceLimit(root: string) {
  if (root.length <= 4) return 1
  if (root.length <= 12) return 2
  return 3
}

function editDistance(left: string, right: string) {
  let previous = Array.from({length: right.length + 1}, (_, index) => index)
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const current = [leftIndex + 1]
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
      current.push(Math.min(
        current[rightIndex]! + 1,
        previous[rightIndex + 1]! + 1,
        previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ))
    }
    previous = current
  }
  return previous[right.length]!
}

function givenBadRoot(spec: FitRangeGivenSpec | FitComparisonGivenSpec, allowedRoots: string[]): string | null {
  for (const root of givenRootNames(spec)) {
    if (!allowedRoots.includes(root)) return root
  }
  return null
}

function givenExpressionBadRoot(expression: FitExpressionLike, allowedRoots: string[]): string | null {
  for (const root of givenExpressionRootNamesFromText(expression)) {
    if (!allowedRoots.includes(root)) return root
  }
  return null
}

function givenRootNames(spec: FitRangeGivenSpec | FitComparisonGivenSpec): string[] {
  switch (spec.kind) {
    case 'range':
      return [...new Set([
        ...givenExpressionRootNamesFromText(spec.expression),
        ...fitRangeCases(spec.range).flatMap(rangeCase => [
          ...rangeBoundRootNames(rangeCase.lower),
          ...rangeBoundRootNames(rangeCase.upper),
        ]),
      ])]
    case 'comparison':
      return [...new Set([...givenExpressionRootNamesFromText(spec.left), ...givenExpressionRootNamesFromText(spec.right)])]
  }
}

function rangeBoundRootNames(text: FitExpressionLike) {
  return parsePrintedNumber(fitExpressionText(text)) == null ? givenExpressionRootNamesFromText(text) : []
}

function givenExpressionRootNamesFromText(text: FitExpressionLike) {
  const parsed = fitExpressionParsed(text)
  const ignored = [...parsed.domainPaths.keys()]
  const roots = [...parsed.domainPaths.values()].map(domainPath => domainPath.root)
  if (typeof text !== 'string' && text.scopeSourceId != null) return roots
  roots.push(...givenExpressionRootNames(parsed.expression, ignored))
  return roots
}

function givenExpressionRootNames(expression: ts.Expression, ignored: string[]): string[] {
  // Infinity and NaN are number constants, not scope roots, the same way
  // range bounds already treat them.
  if (ts.isIdentifier(expression)) {
    if (parsePrintedNumber(expression.text) != null) return []
    return ignored.includes(expression.text) ? [] : [expression.text]
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ignored.includes('this') ? [] : ['this']
  if (ts.isCallExpression(expression)) {
    const roots: string[] = []
    for (const argument of expression.arguments) roots.push(...givenExpressionRootNames(argument, ignored))
    return roots
  }
  if (ts.isPropertyAccessExpression(expression)) return givenExpressionRootNames(expression.expression, ignored)
  if (ts.isElementAccessExpression(expression)) {
    const roots = givenExpressionRootNames(expression.expression, ignored)
    if (expression.argumentExpression != null) roots.push(...givenExpressionRootNames(expression.argumentExpression, ignored))
    return roots
  }

  const roots: string[] = []
  for (const child of expression.getChildren()) {
    if (ts.isExpression(child)) roots.push(...givenExpressionRootNames(child, ignored))
  }
  return roots
}

function givenRangeProblem(
  spec: FitRangeGivenSpec,
  ranges: FitRangeGivenSpec[],
): string | null {
  const closed = closedRangeCases(spec.range)
  if (closed != null && closed.every(range => range.min > range.max)) return `no input can satisfy this: empty range ${formatRangeSpec(spec.range)}`
  for (const range of ranges) {
    if (!sameExpressionText(range.expression, spec.expression)) continue
    if (spec.range.finiteValues != null && range.range.finiteValues != null) {
      const overlap = spec.range.finiteValues.some(value => range.range.finiteValues!.includes(value))
      if (!overlap) return `no input can satisfy both ${range.text} and ${spec.text}`
    }
    const earlier = closedRangeCases(range.range)
    if (closed == null || earlier == null) continue
    if (!rangeCaseSetsOverlap(closed, earlier)) {
      return `no input can satisfy both ${range.text} and ${spec.text}`
    }
  }
  return null
}

function closedRangeCases(range: FitRange): {min: number; max: number}[] | null {
  const cases = fitRangeCases(range).map(rangeCase => closedStaticRangeCase(range, rangeCase))
  return cases.some(item => item == null) ? null : cases as {min: number; max: number}[]
}

function closedStaticRangeCase(range: FitRange, rangeCase: FitRangeCase): {min: number; max: number} | null {
  if (rangeCase.lowerValue == null || rangeCase.upperValue == null) return null
  const min = range.valueKind === 'int' && !rangeCase.lowerInclusive ? Math.floor(rangeCase.lowerValue) + 1 : rangeCase.lowerValue
  const max = range.valueKind === 'int' && !rangeCase.upperInclusive ? Math.ceil(rangeCase.upperValue) - 1 : rangeCase.upperValue
  return {min, max}
}

function rangeCaseSetsOverlap(left: {min: number; max: number}[], right: {min: number; max: number}[]) {
  for (const leftCase of left) {
    for (const rightCase of right) {
      if (leftCase.max >= rightCase.min && rightCase.max >= leftCase.min) return true
    }
  }
  return false
}

function givenShapeProblem(spec: FitRangeGivenSpec | FitComparisonGivenSpec): string | null {
  if (spec.kind === 'range') {
    if (parseDomainPathText(spec.expression.text) == null) {
      const expression = fitExpressionParsed(spec.expression).expression
      if (!isGivenRangeExpression(expression)) return 'given range must name one input path, not a derived expression'
    }
  }
  return null
}

function isGivenRangeExpression(expression: ts.Expression): boolean {
  if (isFixedElementPathExpression(expression)) return true
  if (ts.isParenthesizedExpression(expression)) return isGivenRangeExpression(expression.expression)
  return false
}

function invalidGivenCheck(file: string, functionName: string, spec: FitSpec, reason: string): FitCheck {
  return {file, functionName, text: spec.text, status: 'unknown', reason, ...(spec.line == null ? {} : {line: spec.line})}
}

export function collectGivenAssumptions(
  file: string,
  program: Program,
  functionName: string,
  env: Map<string, Value>,
  inputRoots: string[],
  givens: AssumedGivenSpec[],
  contractCache: Map<string, FunctionContractProof>,
  evaluators: GivenEvaluators,
  stack: string[] = [functionName],
): {assumptions: Assumption[]; booleanAssumptions: Map<string, boolean>; checks: FitCheck[]} {
  const assumptions: Assumption[] = []
  const booleanAssumptions = new Map<string, boolean>()
  const checks: FitCheck[] = []
  const context: EvalContext = {program, file, env, inputRoots, stack, checks: [], assumptions, booleanAssumptions, contractCache}
  // Evaluating a given's expression runs the interpreter, which publishes its
  // own facts (a rounded sum compares against its operands) by replacing
  // context.assumptions; fold those back so later givens and the returned
  // fact list keep them.
  const syncEvaluationFacts = () => {
    if (context.assumptions === assumptions) return
    for (const fact of context.assumptions) {
      if (!assumptions.includes(fact)) assumptions.push(fact)
    }
    context.assumptions = assumptions
  }
  for (const given of givens) {
    syncEvaluationFacts()
    if (given.kind === 'range') {
      const spec = given.spec
      const value = evaluateGivenNumber(file, functionName, spec, spec.expression, context, evaluators)
      if (value.kind === 'invalid') {
        checks.push(value.check)
        continue
      }
      const rangeCases = fitRangeCases(spec.range)
      if (rangeCases.length !== 1) {
        const evaluatedCases: EvaluatedRangeCase[] = []
        for (const rangeCase of rangeCases) {
          const lower = evaluateGivenNumber(file, functionName, spec, rangeCase.lower, context, evaluators, 'range lower bound')
          const upper = evaluateGivenNumber(file, functionName, spec, rangeCase.upper, context, evaluators, 'range upper bound')
          if (lower.kind === 'invalid') {
            checks.push(lower.check)
            continue
          }
          if (upper.kind === 'invalid') {
            checks.push(upper.check)
            continue
          }
          evaluatedCases.push({rangeCase, lower: lower.value, upper: upper.value})
        }
        if (evaluatedCases.length !== rangeCases.length) continue
        // A union admits any one of its cases, so only the envelope holds as
        // a fact: at least the smallest case lower, at most the largest case
        // upper, strict only when every case at that extremum excludes it.
        const facts = unionEnvelopeFacts(value.value, evaluatedCases, spec.text, given.source)
        const contradiction = givenRangeContradictionReason(facts, linearConstraints(assumptions))
        if (contradiction != null) {
          checks.push({
            file,
            ...(spec.line == null ? {} : {line: spec.line}),
            functionName,
            text: spec.text,
            status: 'fail',
            reason: contradiction,
          })
          continue
        }
        assumptions.push(...facts)
        applyGivenRangeSpec(env, spec, evaluatedRangeValue(spec.range, spec.expression.text, evaluatedCases))
        continue
      }
      const rangeCase = rangeCases[0]!
      const lower = evaluateGivenNumber(file, functionName, spec, rangeCase.lower, context, evaluators, 'range lower bound')
      if (lower.kind === 'invalid') {
        checks.push(lower.check)
        continue
      }
      const upper = evaluateGivenNumber(file, functionName, spec, rangeCase.upper, context, evaluators, 'range upper bound')
      if (upper.kind === 'invalid') {
        checks.push(upper.check)
        continue
      }
      const facts = constraintsFromRange(value.value, lower.value, rangeCase.lowerInclusive, upper.value, rangeCase.upperInclusive, spec.text, given.source)
      const contradiction = givenRangeContradictionReason(facts, linearConstraints(assumptions))
      if (contradiction != null) {
        checks.push({
          file,
          ...(spec.line == null ? {} : {line: spec.line}),
          functionName,
          text: spec.text,
          status: 'fail',
          reason: contradiction,
        })
        continue
      }
      assumptions.push(...facts)
      applyGivenRangeSpec(env, spec, evaluatedRangeValue(spec.range, spec.expression.text, [{rangeCase, lower: lower.value, upper: upper.value}]))
      continue
    }

    if (given.kind === 'expression') {
      const result = collectGivenExpressionAssumption(given.spec, context, evaluators)
      if (result.kind === 'invalid') {
        checks.push({
          file,
          ...(given.spec.line == null ? {} : {line: given.spec.line}),
          functionName,
          text: given.spec.text,
          status: result.status,
          reason: result.reason,
        })
      }
      continue
    }

    const spec = given.spec
    const comparison = evaluateGivenComparison(file, functionName, spec, context, evaluators)
    syncEvaluationFacts()
    if (comparison.kind === 'invalid') {
      checks.push(comparison.check)
      continue
    }
    if (!givenValuesMentionInput([comparison.left, comparison.right], inputRoots)) {
      checks.push(invalidGivenCheck(file, functionName, spec, 'given must mention an input'))
      continue
    }
    const status = proveComparison(comparison.left, spec.op, comparison.right, assumptions)
    if (status.status === 'fail') {
      checks.push({
        file,
        ...(spec.line == null ? {} : {line: spec.line}),
        functionName,
        text: spec.text,
        status: 'fail',
        reason: `no input can satisfy this with the earlier given lines\n${status.reason ?? ''}`.trimEnd(),
      })
      continue
    }

    const fact = comparisonConstraint(comparison.left, spec.op, comparison.right, spec.text, given.source)
    if (fact != null) {
      const contradiction = givenComparisonContradictionReason(fact, linearConstraints(assumptions))
      if (contradiction != null) {
        checks.push({
          file,
          ...(spec.line == null ? {} : {line: spec.line}),
          functionName,
          text: spec.text,
          status: 'fail',
          reason: contradiction,
        })
        continue
      }
      assumptions.push(fact)
    }
    applyGivenComparisonNarrowing(env, spec, comparison.left, comparison.right)
  }
  return {assumptions, booleanAssumptions, checks}
}

type GivenExpressionResult =
  | {kind: 'valid'}
  | {kind: 'invalid'; status: FitCheckStatus; reason: string}

function collectGivenExpressionAssumption(
  spec: FitExpressionGivenSpec,
  context: EvalContext,
  evaluators: GivenEvaluators,
): GivenExpressionResult {
  if (!givenExpressionMentionsInput(spec.expression, context.inputRoots)) {
    return {kind: 'invalid', status: 'unknown', reason: 'given must mention an input'}
  }
  const conflict = conflictingBooleanExpressionAssumption(context, spec.expression)
  if (conflict != null) {
    return {kind: 'invalid', status: 'fail', reason: `no input can satisfy both ${conflict}`}
  }
  // A user function sharing a catalog name keeps its own meaning: the given is
  // then an ordinary boolean expression, not the catalog projection.
  const projectReason = givenCatalogNameShadowedByUser(spec, context)
    ? `user function shadows the catalog name in ${publicFitText(spec.text)}`
    : projectGivenExpression(context.env, spec)
  if (projectReason == null) {
    assumeBooleanExpression(context, spec.expression)
    return {kind: 'valid'}
  }

  const value = evaluators.evaluateSpecExpression(spec.expression, context)
  const status = proveBooleanTrue(spec.text, value)
  if (status.status === 'pass' || (status.status === 'unknown' && status.reason === `${spec.text} was not proven true`)) {
    assumeBooleanExpression(context, spec.expression)
    return {kind: 'valid'}
  }
  if (status.status === 'fail') {
    return {
      kind: 'invalid',
      status: 'fail',
      reason: `no input can satisfy this with the earlier given lines\n${status.reason ?? ''}`.trimEnd(),
    }
  }
  return {kind: 'invalid', status: 'unknown', reason: status.reason ?? projectReason}
}

function givenExpressionMentionsInput(expression: FitExpressionLike, inputRoots: string[]) {
  return givenExpressionRootNamesFromText(expression).some(root => inputRoots.includes(root))
}

type EvaluatedGivenNumber =
  | {kind: 'number'; value: NumberValue}
  | {kind: 'invalid'; check: FitCheck}

type GivenNumberRole = 'expression' | 'range lower bound' | 'range upper bound'

type EvaluatedRangeCase = {
  rangeCase: FitRangeCase
  lower: NumberValue
  upper: NumberValue
}

function evaluateGivenComparison(
  file: string,
  functionName: string,
  spec: FitComparisonGivenSpec,
  context: EvalContext,
  evaluators: GivenEvaluators,
): {kind: 'comparison'; left: NumberValue; right: NumberValue} | {kind: 'invalid'; check: FitCheck} {
  const left = evaluateGivenNumber(file, functionName, spec, spec.left, context, evaluators)
  if (left.kind === 'invalid') return left
  const right = evaluateGivenNumber(file, functionName, spec, spec.right, context, evaluators)
  if (right.kind === 'invalid') return right
  return {kind: 'comparison', left: left.value, right: right.value}
}

function evaluateGivenNumber(
  file: string,
  functionName: string,
  spec: FitRangeGivenSpec | FitComparisonGivenSpec,
  expression: FitExpressionLike,
  context: EvalContext,
  evaluators: GivenEvaluators,
  role: GivenNumberRole = 'expression',
): EvaluatedGivenNumber {
  const value = role === 'expression'
    ? evaluators.evaluateSpecExpression(expression, context)
    : evaluators.evaluateRangeBound(expression, context)
  if (value.kind === 'number') return {kind: 'number', value}
  if (value.kind === 'nullable' && value.present.kind === 'number') return {kind: 'number', value: value.present}
  const text = publicFitText(fitExpressionText(expression))
  return {kind: 'invalid', check: invalidGivenCheck(file, functionName, spec, givenNonNumberReason(role, text, value))}
}

function givenNonNumberReason(role: string, text: string, value: Exclude<Value, NumberValue>) {
  return value.kind === 'unknown' ? value.reason : `given ${role} must evaluate to a number: ${text}`
}

function givenValuesMentionInput(values: NumberValue[], inputRoots: string[]) {
  return values.some(value => givenValueMentionsInput(value, inputRoots))
}

function givenValueMentionsInput(value: NumberValue, inputRoots: string[]) {
  if (value.linear?.terms != null) {
    for (const name of value.linear.terms.keys()) {
      if (inputRoots.includes(expressionBaseRoot(name))) return true
    }
  }
  if (value.expr != null) {
    return givenExpressionRootNamesFromText(value.expr).some(root => inputRoots.includes(root))
  }
  return false
}

function expressionBaseRoot(text: string) {
  if (text === 'this' || text.startsWith('this.')) return 'this'
  const match = /^([\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)/u.exec(text)
  return match?.[1] ?? text
}

function givenRangeContradictionReason(facts: LinearConstraint[], assumptions: LinearConstraint[]): string | null {
  for (const fact of facts) {
    const contradiction = givenComparisonContradictionReason(fact, assumptions)
    if (contradiction != null) return contradiction
  }
  return null
}

function givenComparisonContradictionReason(fact: LinearConstraint, assumptions: LinearConstraint[]): string | null {
  const facts = nonNegativeConstraints(fact)
  const earlierConstraints = assumptions.flatMap(nonNegativeConstraints)
  for (const next of facts) {
    if (nonNegativeConstraintIsImpossible(next)) return `no input can satisfy this: ${fact.text ?? 'given comparison'} is impossible`
    for (const earlier of earlierConstraints) {
      if (!nonNegativeConstraintsConflict(next, earlier)) continue
      const earlierText = earlier.text ?? 'an earlier given line'
      const nextText = fact.text ?? 'this given line'
      return `no input can satisfy both ${earlierText} and ${nextText}`
    }
    if (nonNegativeConstraintConflictsWithEarlier(next, earlierConstraints)) {
      return `no input can satisfy this with the earlier given lines; they already rule out ${givenFactLabel(fact.text)}`
    }
  }
  if (comparisonFactContradictedByAssumptions(fact, assumptions)) {
    return `no input can satisfy this with the earlier given lines; they already rule out ${givenFactLabel(fact.text)}`
  }
  return null
}

function nonNegativeConstraintIsImpossible(fact: NonNegativeConstraint) {
  const clean = cleanLinear(fact.diff)
  if (clean.terms.size > 0) return false
  const sign = rationalCompare(clean.constant, rationalZero)
  return fact.strict ? sign <= 0 : sign < 0
}

// Kept separate from the earlier-set check only to name the one conflicting
// line in the report.
function nonNegativeConstraintsConflict(left: NonNegativeConstraint, right: NonNegativeConstraint) {
  return nonNegativeConstraintConflictsWithEarlier(left, [right])
}

function nonNegativeConstraintConflictsWithEarlier(fact: NonNegativeConstraint, earlierConstraints: NonNegativeConstraint[]) {
  return proveNonNegativeFromConstraints(linearScaleExact(fact.diff, rationalNegate(rationalOne)), !fact.strict, earlierConstraints)
}

function givenFactLabel(text: string | undefined) {
  return text?.startsWith('given ') === true ? text.slice('given '.length) : text ?? 'this comparison'
}

function givenCatalogNameShadowedByUser(spec: FitExpressionGivenSpec, context: EvalContext): boolean {
  const parsed = fitExpressionParsed(spec.expression)
  if (!ts.isCallExpression(parsed.expression)) return false
  const target = parsed.expression.expression
  if (!ts.isIdentifier(target)) return false
  return context.program.functions.has(target.text) || context.env.has(target.text)
}

function projectGivenExpression(env: Map<string, Value>, spec: FitExpressionGivenSpec): string | null {
  const parsed = fitExpressionParsed(spec.expression)
  if (!ts.isCallExpression(parsed.expression)) return `Unsupported given expression shape: ${publicFitText(spec.text)}`
  const target = parsed.expression.expression
  if (!ts.isIdentifier(target)) return `Unsupported given expression shape: ${publicFitText(spec.text)}`
  const name = target.text
  const args = parsed.expression.arguments

  if (name === 'spaced' && args.length === 2) {
    const arrayRoot = identifierRoot(args[0]!)
    if (arrayRoot == null) return `Unsupported given expression target: ${publicFitText(spec.text)}`
    const array = env.get(arrayRoot)
    if (array == null || array.kind !== 'array') return `Given ${publicFitText(spec.text)} expected an array named ${arrayRoot}`
    const gapText = args[1]!.getText()
    const updated = arrayWithSpacedRelation(array, gapText)
    if (updated === 'ambiguous') return `Given ${publicFitText(spec.text)} is ambiguous: the elements carry both y/height and x/width; map to one axis first`
    env.set(arrayRoot, updated)
    return null
  }

  if (name === 'nondecreasing' && args.length === 1) {
    const propPath = nondecreasingPropPath(args[0]!)
    if (propPath == null) return `Unsupported given expression target: ${publicFitText(spec.text)}`
    const array = env.get(propPath.root)
    if (array == null || array.kind !== 'array') return `Given ${publicFitText(spec.text)} expected an array named ${propPath.root}`
    const updated = arrayWithNondecreasingRelation(array, propPath.path)
    env.set(propPath.root, updated)
    return null
  }

  return `Unsupported given expression: ${publicFitText(spec.text)}`
}

function identifierRoot(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  return null
}

function nondecreasingPropPath(expression: ts.Expression): {root: string; path: string[]} | null {
  if (ts.isIdentifier(expression)) return {root: expression.text, path: []}
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = nondecreasingPropPath(expression.expression)
    if (inner == null) return null
    return {root: inner.root, path: [...inner.path, expression.name.text]}
  }
  return null
}

function arrayWithSpacedRelation(array: ArrayValue, gapText: string): ArrayValue | 'ambiguous' {
  if (ambiguousRowAxes(array)) return 'ambiguous'
  if (array.element?.kind === 'number') {
    const previous: SequenceAddition = {kind: 'term', term: {item: 'previous', path: []}}
    const relation: SequenceRelation = {
      kind: 'adjacent-addition',
      left: {item: 'next', path: []},
      op: '==',
      right: gapText === '0'
        ? previous
        : {kind: 'add', left: previous, right: {kind: 'invariant', text: gapText}},
    }
    return {...array, summary: appendRelation(array.summary, relation)}
  }
  // Without element fields to look at, assert the relation for both axis
  // vocabularies; claims on fields the element does not have are rejected by
  // the type gate before they could use the spare relation.
  const axes = detectedRowAxes(array)
  let summary = array.summary
  for (const axis of axes) {
    const relation: SequenceRelation = {
      kind: 'adjacent-addition',
      left: {item: 'next', path: [axis.position]},
      op: '==',
      right: gapText === '0'
        ? {kind: 'term', term: {item: 'previous', path: [axis.end]}}
        : {
            kind: 'add',
            left: {kind: 'term', term: {item: 'previous', path: [axis.end]}},
            right: {kind: 'invariant', text: gapText},
          },
    }
    summary = appendRelation(summary, relation)
  }
  return {...array, summary}
}

function detectedRowAxes(array: ArrayValue): RowAxis[] {
  const element = array.element
  if (element == null || element.kind !== 'object') return rowAxes
  const present = rowAxes.filter(axis => element.props.has(axis.position))
  return present.length > 0 ? present : rowAxes
}

function arrayWithNondecreasingRelation(array: ArrayValue, path: string[]): ArrayValue {
  const relation: SequenceRelation = {
    kind: 'adjacent-comparison',
    left: {item: 'next', path},
    op: '>=',
    right: {terms: [{item: 'previous', path}], addends: []},
  }
  return {...array, summary: appendRelation(array.summary, relation)}
}

function appendRelation(summary: ArraySummary | null, relation: SequenceRelation): ArraySummary {
  const base: ArraySummary = summary ?? {
    origin: null,
    relations: [],
    advances: [],
    lastEnd: null,
    extentEnds: [],
  }
  return {...base, relations: [...base.relations, relation]}
}

export function applyGivenRangeSpec(env: Map<string, Value>, spec: FitRangeGivenSpec, value = staticRangeValue(spec.range, spec.expression.text)) {
  const expressionText = spec.expression.text
  if (value == null) return
  if (expressionText.includes('[]')) {
    const domainPath = parseDomainPathText(expressionText)
    if (domainPath != null && domainPath.segments.length > 0) {
      env.set(domainPath.root, setCheckedDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
    }
    return
  }

  const expression = spec.expression.parsed.expression
  if (ts.isIdentifier(expression)) {
    env.set(expression.text, value)
    return
  }

  const lengthRoot = arrayLengthRoot(expression)
  if (lengthRoot != null) {
    const target = env.get(lengthRoot)
    if (target?.kind === 'array') {
      // The given refines what the array already guarantees: a length is an
      // integer whether or not the range says `int`.
      const length = numberWithBounds(
        value,
        value.min,
        value.max,
        gridMeet(value.grid, target.length.grid),
      )
      env.set(lengthRoot, {...target, length})
      return
    }
  }

  const domainPath = parseDomainPathText(expressionText)
  if (domainPath == null || domainPath.segments.length === 0) return
  env.set(domainPath.root, setCheckedDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
}

function unionEnvelopeFacts(value: NumberValue, cases: EvaluatedRangeCase[], text: string, source: ConstraintSource): LinearConstraint[] {
  const facts: LinearConstraint[] = []
  const lower = envelopeBound(cases.map(c => ({bound: c.lower, inclusive: c.rangeCase.lowerInclusive})), 'lower')
  if (lower != null) {
    const fact = comparisonConstraint(value, lower.inclusive ? '>=' : '>', lower.bound, text, source)
    if (fact != null) facts.push({...fact, fromRange: true})
  }
  const upper = envelopeBound(cases.map(c => ({bound: c.upper, inclusive: c.rangeCase.upperInclusive})), 'upper')
  if (upper != null) {
    const fact = comparisonConstraint(value, upper.inclusive ? '<=' : '<', upper.bound, text, source)
    if (fact != null) facts.push({...fact, fromRange: true})
  }
  return facts
}

// The extremal bound across union cases. Only bounds that evaluated to one
// number compare; a bound spanning a range (a call returning 1..5) makes the
// extremum unknowable, so no fact. An endpoint admitted by any one case is
// admitted by the union, so on ties inclusive wins.
function envelopeBound(sides: {bound: NumberValue; inclusive: boolean}[], side: 'lower' | 'upper'): {bound: NumberValue; inclusive: boolean} | null {
  if (!sides.every(s => s.bound.min === s.bound.max)) return null
  const extremum = side === 'lower' ? Math.min(...sides.map(s => s.bound.min)) : Math.max(...sides.map(s => s.bound.min))
  const ties = sides.filter(s => s.bound.min === extremum)
  return {bound: ties[0]!.bound, inclusive: ties.some(s => s.inclusive)}
}

// A given comparison holds at runtime, and NaN compares false with
// everything, so a constant bound both records a fact and narrows the
// bounded side's hull: `given pos < Infinity` leaves pos in
// -Infinity..Number.MAX_VALUE, which also certifies pos is not NaN.
// Identifier and array-length sides narrow; other shapes keep the
// comparison as a pure fact.
function applyGivenComparisonNarrowing(env: Map<string, Value>, spec: FitComparisonGivenSpec, left: NumberValue, right: NumberValue) {
  narrowComparisonSide(env, spec.left, spec.op, right)
  narrowComparisonSide(env, spec.right, flipComparison(spec.op), left)
}

function narrowComparisonSide(env: Map<string, Value>, side: FitExpression, op: ComparisonOperator, bound: NumberValue) {
  if (bound.min !== bound.max) return
  const constant = bound.min
  const upper = op === '>' || op === '>='
    ? Number.POSITIVE_INFINITY
    : boundEndpoint('number', op !== '<', constant, 'upper')
  const lower = op === '<' || op === '<='
    ? Number.NEGATIVE_INFINITY
    : boundEndpoint('number', op !== '>', constant, 'lower')
  if (side.text.includes('[]')) return
  const expression = side.parsed.expression
  if (ts.isIdentifier(expression)) {
    const current = env.get(expression.text)
    if (current?.kind !== 'number') return
    const met = metNumber(current, lower, upper)
    if (met != null) env.set(expression.text, met)
    return
  }
  const lengthRoot = arrayLengthRoot(expression)
  if (lengthRoot != null) {
    const target = env.get(lengthRoot)
    if (target?.kind !== 'array') return
    const met = metNumber(target.length, lower, upper)
    if (met != null) env.set(lengthRoot, {...target, length: met})
  }
}

function metNumber(current: NumberValue, lower: number, upper: number): NumberValue | null {
  const min = Math.max(current.min, lower)
  const max = Math.min(current.max, upper)
  // An empty meet means the givens contradict; the fact-level check reports
  // that, so don't manufacture an inverted hull here.
  if (!(min <= max)) return null
  if (min === current.min && max === current.max) return current
  const cases = current.cases
    ?.map(numberCase => {
      const value = metNumber(numberCase.value, lower, upper)
      return value == null ? null : {...numberCase, value}
    })
    .filter((numberCase): numberCase is NonNullable<typeof numberCase> => numberCase != null)
  return numberWithBounds(current, min, max, current.grid, cases)
}

function staticRangeValue(range: FitRange, expressionText: string): NumberValue | null {
  if (range.finiteValues != null) return finiteNumberValue(range.finiteValues, expressionText, linearVariable(linearNameForExpression(expressionText)))
  const cases = fitRangeCases(range).map(rangeCase => staticRangeCaseApprox(range, rangeCase))
  if (cases.every(rangeCase => rangeCase == null)) return null
  const approximatedCases = cases.map(rangeCase => rangeCase ?? {min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY})
  return rangeCasesValue(range, expressionText, approximatedCases)
}

function evaluatedRangeValue(range: FitRange, expressionText: string, cases: EvaluatedRangeCase[]): NumberValue {
  if (range.finiteValues != null) return finiteNumberValue(range.finiteValues, expressionText, linearVariable(linearNameForExpression(expressionText)))
  return rangeCasesValue(range, expressionText, cases.map(({rangeCase, lower, upper}) => evaluatedRangeCaseApprox(range, rangeCase, lower, upper)))
}

// One endpoint of a bound over doubles. Excluding an infinite endpoint
// admits every finite double, so the bound becomes ±MAX_VALUE inclusive —
// MAX_VALUE is integral, so this holds for int ranges too and wins over the
// int adjustment. An exclusive int bound steps one whole number inward; an
// exclusive finite float bound keeps the constant (sound, just not tight).
function boundEndpoint(valueKind: 'int' | 'number', inclusive: boolean, bound: number, side: 'lower' | 'upper'): number {
  if (!inclusive && bound === (side === 'lower' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY)) {
    return side === 'lower' ? -Number.MAX_VALUE : Number.MAX_VALUE
  }
  if (valueKind === 'int' && !inclusive) return side === 'lower' ? Math.floor(bound) + 1 : Math.ceil(bound) - 1
  return bound
}

function evaluatedRangeCaseApprox(range: FitRange, rangeCase: FitRangeCase, lower: NumberValue, upper: NumberValue): {min: number; max: number} {
  return {
    min: boundEndpoint(range.valueKind, rangeCase.lowerInclusive, lower.min, 'lower'),
    max: boundEndpoint(range.valueKind, rangeCase.upperInclusive, upper.max, 'upper'),
  }
}

function staticRangeCaseApprox(range: FitRange, rangeCase: FitRangeCase): {min: number; max: number} | null {
  if (rangeCase.lowerValue == null && rangeCase.upperValue == null && range.valueKind !== 'int') return null
  return {
    min: rangeCase.lowerValue == null
      ? Number.NEGATIVE_INFINITY
      : boundEndpoint(range.valueKind, rangeCase.lowerInclusive, rangeCase.lowerValue, 'lower'),
    max: rangeCase.upperValue == null
      ? Number.POSITIVE_INFINITY
      : boundEndpoint(range.valueKind, rangeCase.upperInclusive, rangeCase.upperValue, 'upper'),
  }
}

function rangeCasesValue(range: FitRange, expressionText: string, cases: {min: number; max: number}[]): NumberValue {
  const linear = linearVariable(linearNameForExpression(expressionText))
  const value = numberValue(
    Math.min(...cases.map(rangeCase => rangeCase.min)),
    Math.max(...cases.map(rangeCase => rangeCase.max)),
    range.valueKind === 'int' ? 0 : null,
    expressionText,
    linear,
  )
  return cases.length === 1
    ? value
    : withNumberCases(value, cases.map(rangeCase => ({
      value: numberValue(rangeCase.min, rangeCase.max, range.valueKind === 'int' ? 0 : null, expressionText, linear),
      assumptions: [],
    })))
}
