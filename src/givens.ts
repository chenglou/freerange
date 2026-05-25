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
  numberValue,
  unknownArray,
  withNumberCases,
  type ArraySummary,
  type ArrayValue,
  type ConstraintSource,
  type LinearConstraint,
  type NumberValue,
  type SequenceRelation,
  type Value,
} from './domain.ts'
import {
  parsePrintedNumber,
  setDomainPathValue,
} from './domain-paths.ts'
import {
  cleanLinear,
  linearAdd,
  linearEpsilon,
  linearScaleExact,
  linearVariable,
  mergeScale,
  sameExpressionText,
  isFixedElementPathExpression,
  type LinearExpr,
} from './linear.ts'
import {
  fitSpecIsAssumption,
  fitExpressionParsed,
  fitExpressionText,
  fitRangeCases,
  parseDomainPathText,
  publicFitText,
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
  if (ts.isIdentifier(expression)) return ignored.includes(expression.text) ? [] : [expression.text]
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
): {assumptions: LinearConstraint[]; booleanAssumptions: Map<string, boolean>; checks: FitCheck[]} {
  const assumptions: LinearConstraint[] = []
  const booleanAssumptions = new Map<string, boolean>()
  const checks: FitCheck[] = []
  const context: EvalContext = {program, file, env, inputRoots, stack: [functionName], checks: [], assumptions, booleanAssumptions, contractCache}
  for (const given of givens) {
    if (given.kind === 'range') {
      const spec = given.spec
      const value = evaluateGivenNumber(file, functionName, spec, spec.expression, context, evaluators)
      if (value.kind === 'invalid') {
        checks.push(value.check)
        continue
      }
      const rangeCases = fitRangeCases(spec.range)
      if (rangeCases.length !== 1) {
        let invalid = false
        for (const rangeCase of rangeCases) {
          const lower = evaluateGivenNumber(file, functionName, spec, rangeCase.lower, context, evaluators, 'range lower bound')
          const upper = evaluateGivenNumber(file, functionName, spec, rangeCase.upper, context, evaluators, 'range upper bound')
          if (lower.kind === 'invalid') {
            checks.push(lower.check)
            invalid = true
          }
          if (upper.kind === 'invalid') {
            checks.push(upper.check)
            invalid = true
          }
        }
        if (invalid) continue
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
      const contradiction = givenRangeContradictionReason(facts, assumptions)
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
      const contradiction = givenComparisonContradictionReason(fact, assumptions)
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
  const projectReason = projectGivenExpression(context.env, spec)
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
  const match = /^([A-Za-z_$][\w$]*)/.exec(text)
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
  return fact.strict ? clean.constant <= linearEpsilon : clean.constant < -linearEpsilon
}

function nonNegativeConstraintsConflict(left: NonNegativeConstraint, right: NonNegativeConstraint) {
  const scale = positiveTermCancelScale(left.diff, right.diff)
  if (scale == null) return false
  const combined = linearAdd(left.diff, linearScaleExact(right.diff, scale))
  if (combined == null || combined.terms.size > 0) return false
  if (combined.constant < -linearEpsilon) return true
  return (left.strict || right.strict) && combined.constant <= linearEpsilon
}

function nonNegativeConstraintConflictsWithEarlier(fact: NonNegativeConstraint, earlierConstraints: NonNegativeConstraint[]) {
  return proveNonNegativeFromConstraints(linearScaleExact(fact.diff, -1), !fact.strict, earlierConstraints)
}

function givenFactLabel(text: string | undefined) {
  return text?.startsWith('given ') === true ? text.slice('given '.length) : text ?? 'this comparison'
}

function positiveTermCancelScale(left: LinearExpr, right: LinearExpr): number | null {
  let scale: number | null = null
  const names = new Set([...left.terms.keys(), ...right.terms.keys()])
  for (const name of names) {
    const leftCoefficient = left.terms.get(name) ?? 0
    const rightCoefficient = right.terms.get(name) ?? 0
    if (Math.abs(leftCoefficient) <= linearEpsilon && Math.abs(rightCoefficient) <= linearEpsilon) continue
    if (Math.abs(rightCoefficient) <= linearEpsilon) return null
    const nextScale = -leftCoefficient / rightCoefficient
    if (nextScale <= linearEpsilon) return null
    scale = scale == null ? nextScale : mergeScale(scale, nextScale)
    if (scale === Number.NEGATIVE_INFINITY) return null
  }
  return scale
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

function arrayWithSpacedRelation(array: ArrayValue, gapText: string): ArrayValue {
  const relation: SequenceRelation = {
    kind: 'adjacent-comparison',
    left: {item: 'next', path: ['top']},
    op: '==',
    right: {
      terms: [{item: 'previous', path: ['bottom']}],
      addends: gapText === '0' ? [] : [gapText],
    },
  }
  return {...array, summary: appendRelation(array.summary, relation)}
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

export function applyGivenRangeSpec(env: Map<string, Value>, spec: FitRangeGivenSpec) {
  const expressionText = spec.expression.text
  const value = staticRangeValue(spec.range, expressionText)
  if (value == null) return
  if (expressionText.includes('[]')) {
    const domainPath = parseDomainPathText(expressionText)
    if (domainPath != null && domainPath.segments.length > 0) {
      env.set(domainPath.root, setDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
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
    env.set(lengthRoot, target?.kind === 'array' ? {...target, length: value} : unknownArray(lengthRoot, value))
    return
  }

  const domainPath = parseDomainPathText(expressionText)
  if (domainPath == null || domainPath.segments.length === 0) return
  env.set(domainPath.root, setDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
}

function staticRangeValue(range: FitRange, expressionText: string): NumberValue | null {
  if (range.finiteValues != null) return finiteNumberValue(range.finiteValues, expressionText, linearVariable(linearNameForExpression(expressionText)))
  const cases = fitRangeCases(range).map(rangeCase => staticRangeCaseApprox(range, rangeCase))
  if (cases.every(rangeCase => rangeCase == null)) return null
  const approximatedCases = cases.map(rangeCase => rangeCase ?? {min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY})
  return rangeCasesValue(range, expressionText, approximatedCases)
}

function staticRangeCaseApprox(range: FitRange, rangeCase: FitRangeCase): {min: number; max: number} | null {
  if (rangeCase.lowerValue == null && rangeCase.upperValue == null && range.valueKind !== 'int') return null
  const min = rangeCase.lowerValue == null
    ? Number.NEGATIVE_INFINITY
    : range.valueKind === 'int' && !rangeCase.lowerInclusive
      ? Math.floor(rangeCase.lowerValue) + 1
      : rangeCase.lowerValue
  const max = rangeCase.upperValue == null
    ? Number.POSITIVE_INFINITY
    : range.valueKind === 'int' && !rangeCase.upperInclusive
      ? Math.ceil(rangeCase.upperValue) - 1
      : rangeCase.upperValue
  return {min, max}
}

function rangeCasesValue(range: FitRange, expressionText: string, cases: {min: number; max: number}[]): NumberValue {
  const linear = linearVariable(linearNameForExpression(expressionText))
  const value = numberValue(
    Math.min(...cases.map(rangeCase => rangeCase.min)),
    Math.max(...cases.map(rangeCase => rangeCase.max)),
    range.valueKind === 'int',
    expressionText,
    linear,
  )
  return cases.length === 1
    ? value
    : withNumberCases(value, cases.map(rangeCase => ({
      value: numberValue(rangeCase.min, rangeCase.max, range.valueKind === 'int', expressionText, linear),
      assumptions: [],
    })))
}
