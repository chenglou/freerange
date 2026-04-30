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
  numericLiteralValue,
  sameExpressionText,
  isFixedElementPathExpression,
  type LinearExpr,
} from './linear.ts'
import {
  parseDomainPathText,
  parseExpression,
  publicFitText,
  type FitSpec,
} from './parser.ts'
import {
  comparisonConstraint,
  nonNegativeFacts,
  proveComparison,
  proveNonNegativeFromFacts,
  rangeFactsFromBounds,
  type NonNegativeFact,
} from './proof.ts'
import {
  arrayLengthRoot,
  expressionRootNamesFromText,
} from './source-expressions.ts'
import {formatRangeSpec} from './reporting.ts'

export type GivenEvaluators = {
  evaluateRangeBound(text: string, context: EvalContext): Value
  evaluateSpecExpression(text: string, context: EvalContext): Value
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
      checks.push(invalidGivenCheck(file, functionName, spec, `given can only describe inputs; ${publicFitText(badRoot)} is not an input here`))
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
        ...expressionRootNamesFromText(spec.expression),
        ...rangeBoundRootNames(spec.range.lower),
        ...rangeBoundRootNames(spec.range.upper),
      ])]
    case 'given-comparison':
      return [...new Set([...expressionRootNamesFromText(spec.left), ...expressionRootNamesFromText(spec.right)])]
  }
}

function rangeBoundRootNames(text: string) {
  return parsePrintedNumber(text) == null ? expressionRootNamesFromText(text) : []
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
  const roots = givenRootNames(spec)
  if (roots.length === 0) return 'given must mention an input'

  if (spec.kind === 'given-range') {
    if (parseDomainPathText(spec.expression) == null) {
      const expression = parseExpression(spec.expression)
      if (!isGivenRangeExpression(expression)) return 'given range must name one input path, not a derived expression'
    }
    const lower = givenComparisonExpressionProblem(spec.range.lower)
    if (lower != null) return lower
    return givenComparisonExpressionProblem(spec.range.upper)
  }

  const left = givenComparisonExpressionProblem(spec.left)
  if (left != null) return left
  return givenComparisonExpressionProblem(spec.right)
}

function givenComparisonExpressionProblem(text: string): string | null {
  if (parsePrintedNumber(text) != null) return null
  return isGivenComparisonExpression(parseExpression(text))
    ? null
    : 'given comparisons only support input paths, numbers, and simple arithmetic'
}

function isGivenRangeExpression(expression: ts.Expression): boolean {
  if (isFixedElementPathExpression(expression)) return true
  if (ts.isParenthesizedExpression(expression)) return isGivenRangeExpression(expression.expression)
  return false
}

function isGivenComparisonExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return true
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return true
  if (numericLiteralValue(expression) != null) return true
  if (ts.isPropertyAccessExpression(expression)) return isGivenComparisonExpression(expression.expression)
  if (ts.isElementAccessExpression(expression)) return isFixedElementPathExpression(expression)
  if (ts.isParenthesizedExpression(expression)) return isGivenComparisonExpression(expression.expression)
  if (ts.isPrefixUnaryExpression(expression)) {
    return (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
      && isGivenComparisonExpression(expression.operand)
  }
  if (ts.isBinaryExpression(expression) && isGivenArithmeticOperator(expression.operatorToken.kind)) {
    return isGivenComparisonExpression(expression.left)
      && isGivenComparisonExpression(expression.right)
  }
  return false
}

function isGivenArithmeticOperator(kind: ts.SyntaxKind) {
  return kind === ts.SyntaxKind.PlusToken
    || kind === ts.SyntaxKind.MinusToken
    || kind === ts.SyntaxKind.AsteriskToken
    || kind === ts.SyntaxKind.SlashToken
    || kind === ts.SyntaxKind.PercentToken
    || kind === ts.SyntaxKind.AsteriskAsteriskToken
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
      const value = evaluators.evaluateSpecExpression(spec.expression, context)
      if (value.kind !== 'number') continue
      const lower = evaluators.evaluateRangeBound(spec.range.lower, context)
      const upper = evaluators.evaluateRangeBound(spec.range.upper, context)
      if (lower.kind !== 'number' || upper.kind !== 'number') continue
      const facts = rangeFactsFromBounds(value, lower, spec.range.lowerInclusive, upper, spec.range.upperInclusive, spec.text, given.source)
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
    const left = evaluators.evaluateSpecExpression(spec.left, context)
    const right = evaluators.evaluateSpecExpression(spec.right, context)
    if (left.kind === 'number' && right.kind === 'number') {
      const status = proveComparison(left, spec.op, right, assumptions)
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
    }
    const fact = comparisonFactFromSpec(spec, context, given.source, evaluators)
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

function givenRangeContradictionReason(facts: LinearConstraint[], assumptions: LinearConstraint[]): string | null {
  for (const fact of facts) {
    const contradiction = givenComparisonContradictionReason(fact, assumptions)
    if (contradiction != null) return contradiction
  }
  return null
}

function comparisonFactFromSpec(
  spec: Extract<FitSpec, {kind: 'given-comparison'}>,
  context: EvalContext,
  source: FactSource,
  evaluators: GivenEvaluators,
): LinearConstraint | null {
  const left = evaluators.evaluateSpecExpression(spec.left, context)
  const right = evaluators.evaluateSpecExpression(spec.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') return null
  return comparisonConstraint(left, spec.op, right, spec.text, source)
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
  const value = spec.range.finiteValues == null
    ? numberValue(
      closed?.min ?? Number.NEGATIVE_INFINITY,
      closed?.max ?? Number.POSITIVE_INFINITY,
      spec.range.valueKind === 'int',
      spec.expression,
      linearVariable(linearNameForExpression(spec.expression)),
    )
    : finiteNumberValue(spec.range.finiteValues, spec.expression, linearVariable(linearNameForExpression(spec.expression)))
  if (spec.expression.includes('[]')) {
    const domainPath = parseDomainPathText(spec.expression)
    if (domainPath != null && domainPath.segments.length > 0) {
      env.set(domainPath.root, setDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
    }
    return
  }

  const expression = parseExpression(spec.expression)
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

  const domainPath = parseDomainPathText(spec.expression)
  if (domainPath == null || domainPath.segments.length === 0) return
  env.set(domainPath.root, setDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
}
