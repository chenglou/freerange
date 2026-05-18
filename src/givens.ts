import * as ts from 'typescript'
import type {
  AssumedGivenSpec,
  EvalContext,
  FitCheck,
  FunctionContractProof,
  Program,
} from './check-types.ts'
import {
  finiteNumberValue,
  linearNameForExpression,
  numberValue,
  unknownArray,
  type FactSource,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from './domain.ts'
import {
  closedRangeApprox,
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
  fitExpressionParsed,
  fitExpressionText,
  parseDomainPathText,
  publicFitText,
  type FitExpressionLike,
  type FitSpec,
} from './parser.ts'
import {
  comparisonConstraint,
  comparisonFactContradictedByAssumptions,
  nonNegativeFacts,
  proveComparison,
  proveNonNegativeFromFacts,
  rangeFactsFromBounds,
  type NonNegativeFact,
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
  source: Extract<FactSource, 'function-given' | 'loop-given'>,
): {assumedGivens: AssumedGivenSpec[]; checks: FitCheck[]} {
  const assumedGivens: AssumedGivenSpec[] = []
  const checks: FitCheck[] = []
  const ranges: Extract<FitSpec, {kind: 'given-range'}>[] = []

  for (const spec of specs) {
    if (spec.kind !== 'given-range' && spec.kind !== 'given-comparison') continue
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

    if (spec.kind === 'given-range') {
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

function givenBadRoot(spec: Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>, allowedRoots: string[]): string | null {
  for (const root of givenRootNames(spec)) {
    if (!allowedRoots.includes(root)) return root
  }
  return null
}

function givenRootNames(spec: Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>): string[] {
  switch (spec.kind) {
    case 'given-range':
      return [...new Set([
        ...givenExpressionRootNamesFromText(spec.expression),
        ...rangeBoundRootNames(spec.range.lower),
        ...rangeBoundRootNames(spec.range.upper),
      ])]
    case 'given-comparison':
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

function givenRangeProblem(spec: Extract<FitSpec, {kind: 'given-range'}>, ranges: Extract<FitSpec, {kind: 'given-range'}>[]): string | null {
  const closed = closedRangeApprox(spec.range)
  if (closed != null && closed.min > closed.max) return `no input can satisfy this: empty range ${formatRangeSpec(spec.range)}`
  for (const range of ranges) {
    if (!sameExpressionText(range.expression, spec.expression)) continue
    if (spec.range.finiteValues != null && range.range.finiteValues != null) {
      const overlap = spec.range.finiteValues.some(value => range.range.finiteValues!.includes(value))
      if (!overlap) return `no input can satisfy both ${range.text} and ${spec.text}`
    }
    const earlier = closedRangeApprox(range.range)
    if (closed == null || earlier == null) continue
    if (closed.max < earlier.min || closed.min > earlier.max) {
      return `no input can satisfy both ${range.text} and ${spec.text}`
    }
  }
  return null
}

function givenShapeProblem(spec: Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>): string | null {
  if (spec.kind === 'given-range') {
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
): {assumptions: LinearConstraint[]; checks: FitCheck[]} {
  const assumptions: LinearConstraint[] = []
  const checks: FitCheck[] = []
  const context: EvalContext = {program, file, env, inputRoots, stack: [functionName], checks: [], assumptions, contractCache}
  for (const given of givens) {
    if (given.kind === 'range') {
      const spec = given.spec
      const value = evaluateGivenNumber(file, functionName, spec, spec.expression, context, evaluators)
      if (value.kind === 'invalid') {
        checks.push(value.check)
        continue
      }
      const lower = evaluateGivenNumber(file, functionName, spec, spec.range.lower, context, evaluators, 'range lower bound')
      if (lower.kind === 'invalid') {
        checks.push(lower.check)
        continue
      }
      const upper = evaluateGivenNumber(file, functionName, spec, spec.range.upper, context, evaluators, 'range upper bound')
      if (upper.kind === 'invalid') {
        checks.push(upper.check)
        continue
      }
      const facts = rangeFactsFromBounds(value.value, lower.value, spec.range.lowerInclusive, upper.value, spec.range.upperInclusive, spec.text, given.source)
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
  return {assumptions, checks}
}

type EvaluatedGivenNumber =
  | {kind: 'number'; value: NumberValue}
  | {kind: 'invalid'; check: FitCheck}

type GivenNumberRole = 'expression' | 'range lower bound' | 'range upper bound'

function evaluateGivenComparison(
  file: string,
  functionName: string,
  spec: Extract<FitSpec, {kind: 'given-comparison'}>,
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
  spec: Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>,
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
  const facts = nonNegativeFacts(fact)
  const earlierFacts = assumptions.flatMap(nonNegativeFacts)
  for (const next of facts) {
    if (nonNegativeFactIsImpossible(next)) return `no input can satisfy this: ${fact.text ?? 'given comparison'} is impossible`
    for (const earlier of earlierFacts) {
      if (!nonNegativeFactsConflict(next, earlier)) continue
      const earlierText = earlier.text ?? 'an earlier given line'
      const nextText = fact.text ?? 'this given line'
      return `no input can satisfy both ${earlierText} and ${nextText}`
    }
    if (nonNegativeFactConflictsWithEarlierFacts(next, earlierFacts)) {
      return `no input can satisfy this with the earlier given lines; they already rule out ${givenFactLabel(fact.text)}`
    }
  }
  if (comparisonFactContradictedByAssumptions(fact, assumptions)) {
    return `no input can satisfy this with the earlier given lines; they already rule out ${givenFactLabel(fact.text)}`
  }
  return null
}

function nonNegativeFactIsImpossible(fact: NonNegativeFact) {
  const clean = cleanLinear(fact.diff)
  if (clean.terms.size > 0) return false
  return fact.strict ? clean.constant <= linearEpsilon : clean.constant < -linearEpsilon
}

function nonNegativeFactsConflict(left: NonNegativeFact, right: NonNegativeFact) {
  const scale = positiveTermCancelScale(left.diff, right.diff)
  if (scale == null) return false
  const combined = linearAdd(left.diff, linearScaleExact(right.diff, scale))
  if (combined == null || combined.terms.size > 0) return false
  if (combined.constant < -linearEpsilon) return true
  return (left.strict || right.strict) && combined.constant <= linearEpsilon
}

function nonNegativeFactConflictsWithEarlierFacts(fact: NonNegativeFact, earlierFacts: NonNegativeFact[]) {
  return proveNonNegativeFromFacts(linearScaleExact(fact.diff, -1), !fact.strict, earlierFacts)
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

export function applyGivenRangeSpec(env: Map<string, Value>, spec: Extract<FitSpec, {kind: 'given-range'}>) {
  const closed = closedRangeApprox(spec.range)
  if (closed == null && spec.range.finiteValues == null) return
  const expressionText = spec.expression.text
  const value = spec.range.finiteValues == null
    ? numberValue(
      closed?.min ?? Number.NEGATIVE_INFINITY,
      closed?.max ?? Number.POSITIVE_INFINITY,
      spec.range.valueKind === 'int',
      expressionText,
      linearVariable(linearNameForExpression(expressionText)),
    )
    : finiteNumberValue(spec.range.finiteValues, expressionText, linearVariable(linearNameForExpression(expressionText)))
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
