import * as ts from 'typescript'
import {
  proveBoundIndexComparisonSpec,
  proveBoundIndexRangeSpec,
  type BoundIndexContext,
} from './bound-index.ts'
import {
  finiteNumberSet,
  numberValue,
  withNumberCases,
  numberBranches,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from './domain.ts'
import {linearConstant, unwrapExpression} from './linear.ts'
import {
  fitExpressionScopeSourceId,
  fitExpressionParsed,
  fitExpressionText,
  fitRangeCases,
  fitReturnInternalRoot,
  publicFitText,
  type FitDomainPath,
  type FitExpressionLike,
  type FitRange,
  type FitRangeCase,
  type FitSpec,
} from './parser.ts'
import {proveComparison, proveComparisonWithStep} from './proof.ts'
import {
  finiteRangeSpecFailureReason,
  formatArraySummary,
  formatRange,
  formatRangeSpec,
  knownProofContextMany,
  rangeSpecFailureReason,
} from './reporting.ts'
import {
  adjacentComparisonText,
  hasNondecreasingProp,
  provedSpacing,
  proveAdjacentComparison,
  sequenceRelationText,
} from './sequence-facts.ts'
import {
  type EvalContext,
  type FitCheck,
  type FitCheckStatus,
  type FunctionContractProof,
  type Program,
} from './check-types.ts'
import type {FitProofStep} from './obligations.ts'
import {proofFactsFromValues} from './proof-facts.ts'

export type CheckSpecHooks = {
  evaluateExpression: (expression: ts.Expression, context: EvalContext) => Value
  evaluateDomainPath: (domainPath: FitDomainPath, context: EvalContext) => Value
  contextForExpression?: (expression: FitExpressionLike, context: EvalContext) => EvalContext
  parsePrintedNumber: (text: string) => number | null
}

type WildcardUse =
  | {kind: 'none'}
  | {kind: 'one'; collection: string}
  | {kind: 'unsupported'; reason: string}

export type CheckSpecProof = {
  check: FitCheck
  step: FitProofStep
  usedFacts: string[]
}

export function verifyCheckSpec(
  file: string,
  program: Program,
  functionName: string,
  baseEnv: Map<string, Value>,
  result: Value,
  spec: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'} | {kind: 'check-atom'}>,
  checks: FitCheck[],
  assumptions: EvalContext['assumptions'],
  contractCache: Map<string, FunctionContractProof>,
  hooks: CheckSpecHooks,
): FitCheck {
  return verifyCheckSpecWithProof(file, program, functionName, baseEnv, result, spec, checks, assumptions, contractCache, hooks).check
}

export function verifyCheckSpecWithProof(
  file: string,
  program: Program,
  functionName: string,
  baseEnv: Map<string, Value>,
  result: Value,
  spec: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'} | {kind: 'check-atom'}>,
  checks: FitCheck[],
  assumptions: EvalContext['assumptions'],
  contractCache: Map<string, FunctionContractProof>,
  hooks: CheckSpecHooks,
): CheckSpecProof {
  const env = new Map(baseEnv)
  env.set(fitReturnInternalRoot, result)
  const inputRoots = [...baseEnv.keys(), fitReturnInternalRoot]
  const context: EvalContext = {program, file, env, inputRoots, stack: [functionName], checks, assumptions, contractCache}
  const boundIndexContext = specBoundIndexContext(context, hooks)

  if (spec.kind === 'check-range') {
    const boundIndexCheck = proveBoundIndexRangeSpec(spec, boundIndexContext)
    if (boundIndexCheck != null && boundIndexCheck.status !== 'pass') {
      return checkProof({
        file,
        ...(spec.line == null ? {} : {line: spec.line}),
        functionName,
        text: spec.text,
        status: boundIndexCheck.status,
        ...(boundIndexCheck.reason == null ? {} : {reason: boundIndexCheck.reason}),
      }, 'collection', 'bound-index-range', 'checked indexed range claim', [], context.assumptions)
    }
    const value = evaluateSpecExpression(spec.expression, context, hooks)
    const status = proveRangeSpec(value, spec.range, context, hooks)
    return checkProof({
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    }, 'numeric', 'range', 'checked numeric range claim', [value], context.assumptions)
  }

  if (spec.kind === 'check-atom') return verifyAtomSpec(file, functionName, spec, context, hooks)

  const boundIndexCheck = proveBoundIndexComparisonSpec(spec, boundIndexContext)
  if (boundIndexCheck != null) {
    return checkProof({
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: boundIndexCheck.status,
      ...(boundIndexCheck.reason == null ? {} : {reason: boundIndexCheck.reason}),
    }, 'collection', 'bound-index-comparison', 'checked indexed comparison claim', [], context.assumptions)
  }

  const wildcardCheck = checkWildcardComparisonShape(spec.left, spec.right)
  if (wildcardCheck.kind === 'unsupported') {
    return checkProof(
      {file, functionName, ...(spec.line == null ? {} : {line: spec.line}), text: spec.text, status: 'unknown', reason: wildcardCheck.reason},
      'kernel',
      'wildcard-shape',
      'checked wildcard claim shape',
      [],
      context.assumptions,
    )
  }

  const left = evaluateSpecExpression(spec.left, context, hooks)
  const right = evaluateSpecExpression(spec.right, context, hooks)
  const proof = proveComparisonWithStep(left, spec.op, right, context.assumptions)
  const reason = wildcardCheck.kind === 'one' && proof.status !== 'pass' && proof.reason != null
    ? `applies to: every item in ${wildcardCollectionLabel(wildcardCheck.collection)}\n${proof.reason}`
    : proof.reason
  return checkProofWithStep({
    file,
    ...(spec.line == null ? {} : {line: spec.line}),
    functionName,
    text: spec.text,
    status: proof.status,
    ...(reason == null ? {} : {reason}),
  }, proof.step, [left, right], context.assumptions)
}

function checkProof(
  check: FitCheck,
  domain: string,
  rule: string,
  message: string,
  values: Value[],
  assumptions: EvalContext['assumptions'],
): CheckSpecProof {
  return checkProofWithStep(check, {domain, rule, message}, values, assumptions)
}

function checkProofWithStep(
  check: FitCheck,
  step: FitProofStep,
  values: Value[],
  assumptions: EvalContext['assumptions'],
): CheckSpecProof {
  return {
    check,
    step,
    usedFacts: proofFactsFromValues(values, assumptions),
  }
}

function wildcardCollectionLabel(collection: string) {
  const text = publicFitText(collection)
  return text.endsWith('[]') ? text.slice(0, -2) : text
}

export function proveRangeSpec(value: Value, range: FitRange, context: EvalContext, hooks: CheckSpecHooks): {status: FitCheckStatus; reason?: string} {
  if (value.kind !== 'number') return {status: 'unknown', reason: expectedNumberReason(value)}
  const expected = evaluateRangeCases(range, context, hooks)
  if (expected.kind === 'invalid') return {status: 'unknown', reason: rangeBoundNumberReason(expected.bound, expected.value, expected.text)}
  return proveNumberInsideRangeCases(value, range, expected.cases, context.assumptions)
}

type EvaluatedRangeCase = {
  source: FitRangeCase
  lower: NumberValue
  upper: NumberValue
}

type EvaluatedRangeCases =
  | {kind: 'cases'; cases: EvaluatedRangeCase[]}
  | {kind: 'invalid'; bound: 'lower' | 'upper'; value: Exclude<Value, NumberValue>; text: string}

export function evaluateRangeValue(
  range: FitRange,
  context: EvalContext,
  hooks: CheckSpecHooks,
  expr: string | null,
  provenance: string[] = [],
): Value {
  const evaluated = evaluateRangeCases(range, context, hooks)
  if (evaluated.kind === 'invalid') return {kind: 'unknown', reason: rangeBoundNumberReason(evaluated.bound, evaluated.value, evaluated.text)}
  const cases = evaluated.cases.map(rangeCase => evaluatedRangeCaseValue(range, rangeCase, expr, provenance))
  const min = Math.min(...cases.map(item => item.min))
  const max = Math.max(...cases.map(item => item.max))
  const value = numberValue(min, max, range.valueKind === 'int' || cases.every(item => item.isInteger), expr, null, null, provenance)
  return withNumberCases(value, cases.map(item => ({value: item, assumptions: []})))
}

function evaluateRangeCases(range: FitRange, context: EvalContext, hooks: CheckSpecHooks): EvaluatedRangeCases {
  const cases: EvaluatedRangeCase[] = []
  for (const rangeCase of fitRangeCases(range)) {
    const lower = evaluateRangeBound(rangeCase.lower, context, hooks)
    if (lower.kind !== 'number') return {kind: 'invalid', bound: 'lower', value: lower, text: rangeCase.lower.text}
    const upper = evaluateRangeBound(rangeCase.upper, context, hooks)
    if (upper.kind !== 'number') return {kind: 'invalid', bound: 'upper', value: upper, text: rangeCase.upper.text}
    cases.push({source: rangeCase, lower, upper})
  }
  return {kind: 'cases', cases}
}

function evaluatedRangeCaseValue(range: FitRange, rangeCase: EvaluatedRangeCase, expr: string | null, provenance: string[]): NumberValue {
  const exactSameExpression = rangeCase.source.lowerInclusive
    && rangeCase.source.upperInclusive
    && rangeCase.source.lower.text === rangeCase.source.upper.text
  if (exactSameExpression) {
    const value = rangeCase.lower
    return numberValue(value.min, value.max, range.valueKind === 'int' || value.isInteger, expr ?? value.expr, value.linear, value.cases, mergeRangeProvenance(value, provenance))
  }
  return numberValue(
    rangeCase.lower.min,
    rangeCase.upper.max,
    range.valueKind === 'int',
    expr,
    null,
    null,
    mergeRangeProvenance(rangeCase.lower, rangeCase.upper, provenance),
  )
}

function mergeRangeProvenance(...items: (NumberValue | string[])[]) {
  const lines: string[] = []
  for (const item of items) lines.push(...(Array.isArray(item) ? item : item.provenance))
  return [...new Set(lines)]
}

function proveNumberInsideRangeCases(
  value: NumberValue,
  range: FitRange,
  cases: EvaluatedRangeCase[],
  assumptions: LinearConstraint[],
): {status: FitCheckStatus; reason?: string} {
  if (range.finiteValues != null) {
    const finite = proveFiniteRangeSpec(value, range)
    if (finite.status === 'pass' || cases.length === range.finiteValues.length) return finite
  }

  const joined = proveNumberInsideAnyRangeCase(value, range, cases, assumptions)
  if (joined.kind === 'pass') return {status: 'pass'}

  let unknown: {case: EvaluatedRangeCase; status: RangeCaseStatus} | null = null
  for (const branch of numberBranches(value)) {
    const branchAssumptions = [...assumptions, ...branch.assumptions]
    const branchProof = proveNumberInsideAnyRangeCase(branch.value, range, cases, branchAssumptions)
    if (branchProof.kind === 'pass') continue
    if (branchProof.kind === 'unknown') {
      unknown ??= {case: branchProof.case, status: branchProof.status}
      continue
    }
    return {status: 'fail', reason: rangeSpecFailureReasonForCases(branch.value, range, cases, branchAssumptions, branchProof.status, branchProof.case)}
  }
  if (unknown != null) return {status: 'unknown', reason: rangeSpecFailureReasonForCases(value, range, cases, assumptions, unknown.status, unknown.case)}
  return {status: 'pass'}
}

type RangeCasesProof =
  | {kind: 'pass'}
  | {kind: 'unknown'; case: EvaluatedRangeCase; status: RangeCaseStatus}
  | {kind: 'fail'; case: EvaluatedRangeCase; status: RangeCaseStatus}

function proveNumberInsideAnyRangeCase(
  value: NumberValue,
  range: FitRange,
  cases: EvaluatedRangeCase[],
  assumptions: LinearConstraint[],
): RangeCasesProof {
  let unknown: {case: EvaluatedRangeCase; status: RangeCaseStatus} | null = null
  for (const rangeCase of cases) {
    const status = proveNumberInsideRangeCase(value, range, rangeCase, assumptions)
    if (status.status === 'pass') return {kind: 'pass'}
    if (status.status === 'unknown' && unknown == null) unknown = {case: rangeCase, status}
  }
  if (unknown != null) return {kind: 'unknown', case: unknown.case, status: unknown.status}
  const first = cases[0]!
  return {kind: 'fail', case: first, status: proveNumberInsideRangeCase(value, range, first, assumptions)}
}

type RangeCaseStatus = {
  status: FitCheckStatus
  lower: ReturnType<typeof proveComparison>
  upper: ReturnType<typeof proveComparison>
  integer: {status: FitCheckStatus; reason?: string}
}

function proveNumberInsideRangeCase(
  value: NumberValue,
  range: FitRange,
  rangeCase: EvaluatedRangeCase,
  assumptions: LinearConstraint[],
): RangeCaseStatus {
  const lower = rangeBoundProofStatus(
    proveComparison(value, rangeCase.source.lowerInclusive ? '>=' : '>', rangeCase.lower, assumptions),
    staticLowerBoundExceeded(value, rangeCase.source),
  )
  const upper = rangeBoundProofStatus(
    proveComparison(value, rangeCase.source.upperInclusive ? '<=' : '<', rangeCase.upper, assumptions),
    staticUpperBoundExceeded(value, rangeCase.source),
  )
  const integer: {status: FitCheckStatus; reason?: string} = range.valueKind === 'int' && !value.isInteger
    ? {status: 'fail', reason: `need: ${value.expr ?? formatRange(value)} to be integer`}
    : {status: 'pass'}
  const status: FitCheckStatus = lower.status === 'pass' && upper.status === 'pass' && integer.status === 'pass'
    ? 'pass'
    : lower.status === 'fail' || upper.status === 'fail' || integer.status === 'fail'
      ? 'fail'
      : 'unknown'
  return {status, lower, upper, integer}
}

function rangeBoundProofStatus(proof: ReturnType<typeof proveComparison>, staticBoundExceeded: boolean): ReturnType<typeof proveComparison> {
  return proof.status === 'unknown' && staticBoundExceeded
    ? {...proof, status: 'fail'}
    : proof
}

function staticLowerBoundExceeded(value: NumberValue, rangeCase: FitRangeCase) {
  if (rangeCase.lowerValue == null) return false
  return rangeCase.lowerInclusive ? value.min < rangeCase.lowerValue : value.min <= rangeCase.lowerValue
}

function staticUpperBoundExceeded(value: NumberValue, rangeCase: FitRangeCase) {
  if (rangeCase.upperValue == null) return false
  return rangeCase.upperInclusive ? value.max > rangeCase.upperValue : value.max >= rangeCase.upperValue
}

function rangeSpecFailureReasonForCases(
  value: NumberValue,
  range: FitRange,
  cases: EvaluatedRangeCase[],
  assumptions: LinearConstraint[],
  status: RangeCaseStatus,
  rangeCase: EvaluatedRangeCase,
) {
  if (cases.length === 1) {
    return rangeSpecFailureReason(value, range, rangeCase.lower, rangeCase.upper, assumptions, {
      lower: status.lower.status !== 'pass',
      upper: status.upper.status !== 'pass',
      integer: status.integer.status !== 'pass',
    })
  }
  const lines = [`range was ${formatRange(value)}, expected inside ${formatRangeSpec(range)}`]
  const known = knownProofContextMany([value, ...cases.flatMap(item => [item.lower, item.upper])], assumptions)
  if (known.length > 0) lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)
  lines.push(`missing: ${value.expr ?? formatRange(value)} in ${formatRangeSpec(range)}`)
  return lines.join('\n')
}

function proveFiniteRangeSpec(value: NumberValue, range: FitRange): {status: FitCheckStatus; reason?: string} {
  const expected = range.finiteValues ?? []
  const produced = finiteNumberSet(value)
  if (produced != null && produced.every(choice => expected.includes(choice))) return {status: 'pass'}
  return {
    status: 'fail',
    reason: finiteRangeSpecFailureReason(value, range, produced),
  }
}

function rangeBoundNumberReason(bound: 'lower' | 'upper', value: Exclude<Value, NumberValue>, text: string) {
  return value.kind === 'unknown' ? value.reason : `Range ${bound} bound is not a number: ${text}`
}

function expectedNumberReason(value: Exclude<Value, NumberValue>) {
  if (value.kind === 'unknown') return value.reason
  if (value.kind === 'nullable') return `Nullable value ${value.expr ?? '<value>'} was not proven present`
  if (value.kind === 'null') return 'Expected a number, got null'
  if (value.kind === 'literal') return 'Expected a number, got a literal value'
  return value.kind === 'array' ? 'Expected a number, got an array' : 'Expected a number, got an object'
}

function specBoundIndexContext(context: EvalContext, hooks: CheckSpecHooks): BoundIndexContext {
  return {
    assumptions: context.assumptions,
    evaluateDomainPath: domainPath => hooks.evaluateDomainPath(domainPath, context),
    evaluateSpecExpression: text => evaluateSpecExpression(text, context, hooks),
    nondecreasingFailureReason,
    proveAdjacentComparison: (collectionPath, comparison) => {
      const collection = hooks.evaluateDomainPath(collectionPath, context)
      if (collection.kind !== 'array') return {status: 'unknown', reason: `${domainPathText(collectionPath)} expected an array`}
      if (proveAdjacentComparison(collection, comparison)) return {status: 'pass'}
      const collectionText = domainPathText(collectionPath)
      return {
        status: 'unknown',
        reason: adjacentComparisonFailureReason(adjacentComparisonText(collectionText, comparison), collectionText, collection),
      }
    },
  }
}

export function evaluateRangeBound(text: FitExpressionLike, context: EvalContext, hooks: CheckSpecHooks): Value {
  const sourceText = fitExpressionText(text)
  const printed = hooks.parsePrintedNumber(sourceText)
  if (printed != null) return numberValue(printed, printed, Number.isInteger(printed), sourceText, Number.isFinite(printed) ? linearConstant(printed) : null)
  return evaluateSpecExpression(text, context, hooks)
}

function checkWildcardComparisonShape(left: FitExpressionLike, right: FitExpressionLike): WildcardUse {
  const leftUse = wildcardUse(left)
  if (leftUse.kind === 'unsupported') return leftUse
  const rightUse = wildcardUse(right)
  if (rightUse.kind === 'unsupported') return rightUse

  if (leftUse.kind === 'one' && rightUse.kind === 'one') {
    if (leftUse.collection === rightUse.collection) return leftUse
    return {kind: 'unsupported', reason: 'Wildcard comparisons support one wildcard side and one scalar side'}
  }
  return leftUse.kind === 'one' ? leftUse : rightUse
}

function wildcardUse(text: FitExpressionLike): WildcardUse {
  const collections = new Set<string>()
  for (const domainPath of fitExpressionParsed(text).domainPaths.values()) {
    const itemCount = domainPath.segments.filter(segment => segment.kind === 'item').length
    if (itemCount === 0) continue
    collections.add(domainPathCollectionText(domainPath))
  }
  if (collections.size === 0) return {kind: 'none'}
  if (collections.size > 1) return {kind: 'unsupported', reason: `Wildcard comparisons support one collection at a time: ${fitExpressionText(text)}`}
  return {kind: 'one', collection: [...collections][0]!}
}

function domainPathCollectionText(domainPath: FitDomainPath) {
  const lastItemIndex = domainPath.segments.findLastIndex(segment => segment.kind === 'item')
  let collection = domainPath.root
  for (let index = 0; index <= lastItemIndex; index++) {
    const segment = domainPath.segments[index]!
    if (segment.kind === 'item') {
      collection = `${collection}[]`
      continue
    }
    collection = `${collection}.${segment.name}`
  }
  return publicFitText(collection)
}

function domainPathText(domainPath: FitDomainPath) {
  let text = domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') {
      text += `.${segment.name}`
      continue
    }
    text += '[]'
  }
  return publicFitText(text)
}

export function evaluateSpecExpression(text: FitExpressionLike, context: EvalContext, hooks: CheckSpecHooks): Value {
  const parsed = fitExpressionParsed(text)
  const scopedContext = fitExpressionScopeSourceId(text) == null ? context : hooks.contextForExpression?.(text, context) ?? context
  if (parsed.domainPaths.size === 0) return hooks.evaluateExpression(parsed.expression, scopedContext)

  const env = new Map(scopedContext.env)
  for (const [name, domainPath] of parsed.domainPaths) env.set(name, hooks.evaluateDomainPath(domainPath, context))
  return hooks.evaluateExpression(parsed.expression, {...scopedContext, env})
}

type AtomProof = {
  status: FitCheckStatus
  reason?: string
  values: Value[]
  domain: string
  rule: string
  message: string
}

function verifyAtomSpec(file: string, functionName: string, spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): CheckSpecProof {
  const status = proveAtomSpec(spec, context, hooks)
  return checkProof({
    file,
    ...(spec.line == null ? {} : {line: spec.line}),
    functionName,
    text: spec.text,
    status: status.status,
    ...(status.reason == null ? {} : {reason: status.reason}),
  }, status.domain, status.rule, status.message, status.values, context.assumptions)
}

function proveAtomSpec(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): AtomProof {
  switch (spec.name) {
    case 'nondecreasing':
      return proveNondecreasingAtom(spec, context, hooks)
    case 'spaced':
      return proveSpacedAtom(spec, context, hooks)
    default:
      return proveBooleanCallAtom(spec, context, hooks)
  }
}

function proveNondecreasingAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): AtomProof {
  const target = sequencePropArgument(spec.args, context, hooks)
  if (target == null) return sequenceAtomProof('nondecreasing', 'unknown', [], 'nondecreasing expects return.rows.top')
  if (hasNondecreasingProp(target.array, target.prop)) return sequenceAtomProof('nondecreasing', 'pass', [target.array])
  return sequenceAtomProof('nondecreasing', 'unknown', [target.array], nondecreasingFailureReason(spec.text, target))
}

function proveSpacedAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): AtomProof {
  if (spec.args.length !== 2) return sequenceAtomProof('spaced', 'unknown', [], 'spaced expects spaced(rows, gap)')
  const rows = evaluateSpecExpression(spec.args[0]!, context, hooks)
  const gap = evaluateSpecExpression(spec.args[1]!, context, hooks)
  const values = [rows, gap]
  if (rows.kind !== 'array') return sequenceAtomProof('spaced', 'unknown', values, 'spaced expected an array')
  if (gap.kind !== 'number' || gap.expr == null) return sequenceAtomProof('spaced', 'unknown', values, 'spaced expected a known gap expression')
  if (provedSpacing(rows, gap.expr) != null) return sequenceAtomProof('spaced', 'pass', values)
  return sequenceAtomProof('spaced', 'unknown', values, spacedFailureReason(spec.text, rows, gap.expr))
}

function sequenceAtomProof(name: string, status: FitCheckStatus, values: Value[], reason?: string): AtomProof {
  return {
    status,
    ...(reason == null ? {} : {reason}),
    values,
    domain: 'sequence',
    rule: `atom-${name}`,
    message: 'checked layout atom claim',
  }
}

function proveBooleanCallAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): AtomProof {
  const value = evaluateSpecExpression(spec.text, context, hooks)
  const result = proveBooleanTrue(spec.text, value)
  return {
    status: result.status,
    ...(result.reason == null ? {} : {reason: result.reason}),
    values: [value],
    domain: 'literal',
    rule: 'boolean-call',
    message: 'checked pure boolean call',
  }
}

function proveBooleanTrue(text: string, value: Value): {status: FitCheckStatus; reason?: string} {
  if (value.kind === 'unknown') return {status: 'unknown', reason: value.reason}
  if (value.kind !== 'literal') return {status: 'unknown', reason: `${text} expected a boolean result`}
  const booleans = value.values.filter(item => typeof item === 'boolean')
  if (booleans.length !== value.values.length) return {status: 'unknown', reason: `${text} expected a boolean result`}
  if (booleans.every(item => item === true)) return {status: 'pass'}
  if (booleans.every(item => item === false)) return {status: 'fail', reason: `${text} returned false`}
  return {status: 'unknown', reason: `${text} was not proven true`}
}

function nondecreasingFailureReason(text: string, target: {array: ArrayValue; prop: string}) {
  const lines = [
    `${text} was not inferred`,
    `need: every next .${target.prop} >= previous .${target.prop}`,
  ]
  const known: string[] = []
  const advance = target.array.summary?.advances.find(fact => fact.prop === target.prop)
  if (advance != null) known.push(`row advance for .${target.prop}: ${formatRange(advance.value)}`)
  known.push(`sequence facts: ${formatArraySummary(target.array)}`)
  lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)

  if (advance?.value.expr != null) {
    lines.push(`missing: given ${advance.value.expr} >= 0`)
  } else {
    lines.push(`missing: sequence facts for .${target.prop}`)
  }
  return lines.join('\n')
}

function spacedFailureReason(text: string, rows: ArrayValue, gapExpr: string) {
  const lines = [
    `${text} was not inferred`,
    `need: every next row top == previous top + previous height + ${gapExpr}`,
  ]
  const known: string[] = []
  const spacing = rows.summary?.spaced[0]
  if (spacing != null) {
    known.push(`loop proved: row advance ${spacing.advanceExpr} = previous height ${spacing.heightExpr} + ${spacing.gapExpr}`)
  }
  known.push(`sequence facts: ${formatArraySummary(rows)}`)
  lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)

  if (spacing != null) {
    lines.push(`missing: given ${spacing.gapExpr} == ${gapExpr}`)
  } else {
    lines.push('missing: recognized adjacent row spacing')
  }
  return lines.join('\n')
}

function adjacentComparisonFailureReason(text: string, collectionText: string, rows: ArrayValue) {
  const knownRelations = rows.summary?.relations
    .filter(relation => relation.op === '==')
    .map(relation => sequenceRelationText(collectionText, relation)) ?? []
  const known = [
    `sequence facts: ${formatArraySummary(rows)}`,
    ...knownRelations.map(relation => `adjacent: ${relation}`),
  ]
  return [
    `${text} was not inferred`,
    'need: a matching adjacent sequence relation',
    `known:\n${known.map(line => `  ${line}`).join('\n')}`,
    'missing: recognized adjacent row relation',
  ].join('\n')
}

function sequencePropArgument(args: FitExpressionLike[], context: EvalContext, hooks: CheckSpecHooks): {array: ArrayValue; prop: string} | null {
  if (args.length !== 1) return null
  let expression = unwrapExpression(fitExpressionParsed(args[0]!).expression)
  const path: string[] = []
  while (ts.isPropertyAccessExpression(expression)) {
    path.unshift(expression.name.text)
    const array = hooks.evaluateExpression(expression.expression, context)
    if (array.kind === 'array') return {array, prop: path.join('.')}
    expression = unwrapExpression(expression.expression)
  }
  return null
}
