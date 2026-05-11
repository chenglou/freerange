import * as ts from 'typescript'
import {
  proveBoundIndexComparisonSpec,
  proveBoundIndexRangeSpec,
  type BoundIndexContext,
} from './bound-index.ts'
import {
  finiteNumberSet,
  numberValue,
  type ArrayValue,
  type NumberValue,
  type Value,
} from './domain.ts'
import {linearConstant, unwrapExpression} from './linear.ts'
import {
  fitExpressionParsed,
  fitExpressionText,
  fitReturnInternalRoot,
  publicFitText,
  type FitDomainPath,
  type FitExpressionLike,
  type FitRange,
  type FitSpec,
} from './parser.ts'
import {comparisonProofStep, proveComparison} from './proof.ts'
import {
  finiteRangeSpecFailureReason,
  formatArraySummary,
  formatRange,
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
  const status = proveComparison(left, spec.op, right, context.assumptions)
  const reason = wildcardCheck.kind === 'one' && status.status !== 'pass' && status.reason != null
    ? `applies to: every item in ${wildcardCollectionLabel(wildcardCheck.collection)}\n${status.reason}`
    : status.reason
  const step = comparisonProofStep(left, spec.op, right, context.assumptions)
  return checkProofWithStep({
    file,
    ...(spec.line == null ? {} : {line: spec.line}),
    functionName,
    text: spec.text,
    status: status.status,
    ...(reason == null ? {} : {reason}),
  }, step, [left, right], context.assumptions)
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
  if (range.finiteValues != null) return proveFiniteRangeSpec(value, range)
  if (staticRangeInside(value, range)) return {status: 'pass'}
  const lower = evaluateRangeBound(range.lower, context, hooks)
  if (lower.kind !== 'number') return {status: 'unknown', reason: `Range lower bound is not a number: ${range.lower.text}`}
  const upper = evaluateRangeBound(range.upper, context, hooks)
  if (upper.kind !== 'number') return {status: 'unknown', reason: `Range upper bound is not a number: ${range.upper.text}`}

  const lowerStatus = proveComparison(value, range.lowerInclusive ? '>=' : '>', lower, context.assumptions)
  const upperStatus = proveComparison(value, range.upperInclusive ? '<=' : '<', upper, context.assumptions)
  const integerStatus: {status: FitCheckStatus; reason?: string} = range.valueKind === 'int' && !value.isInteger
    ? {status: 'fail', reason: `need: ${value.expr ?? formatRange(value)} to be integer`}
    : {status: 'pass'}

  if (lowerStatus.status === 'pass' && upperStatus.status === 'pass' && integerStatus.status === 'pass') return {status: 'pass'}
  const missing = {
    lower: lowerStatus.status !== 'pass',
    upper: upperStatus.status !== 'pass',
    integer: integerStatus.status !== 'pass',
  }
  const definitelyOutsideLower = range.lowerValue != null
    && lowerStatus.status !== 'pass'
    && (range.lowerInclusive ? value.min < range.lowerValue : value.min <= range.lowerValue)
  const definitelyOutsideUpper = range.upperValue != null
    && upperStatus.status !== 'pass'
    && (range.upperInclusive ? value.max > range.upperValue : value.max >= range.upperValue)
  const status: FitCheckStatus = lowerStatus.status === 'fail'
    || upperStatus.status === 'fail'
    || integerStatus.status === 'fail'
    || definitelyOutsideLower
    || definitelyOutsideUpper
    ? 'fail'
    : 'unknown'
  return {
    status,
    reason: rangeSpecFailureReason(value, range, lower, upper, context.assumptions, missing),
  }
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

function staticRangeInside(value: NumberValue, range: FitRange) {
  if (range.finiteValues != null) {
    const produced = finiteNumberSet(value)
    return produced != null && produced.every(choice => range.finiteValues!.includes(choice))
  }
  if (range.valueKind === 'int' && !value.isInteger) return false
  if (range.lowerValue == null || range.upperValue == null) return false
  const lowerOk = range.lowerInclusive ? value.min >= range.lowerValue : value.min > range.lowerValue
  const upperOk = range.upperInclusive ? value.max <= range.upperValue : value.max < range.upperValue
  return lowerOk && upperOk
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
  if (parsed.domainPaths.size === 0) return hooks.evaluateExpression(parsed.expression, context)

  const env = new Map(context.env)
  for (const [name, domainPath] of parsed.domainPaths) env.set(name, hooks.evaluateDomainPath(domainPath, context))
  return hooks.evaluateExpression(parsed.expression, {...context, env})
}

type AtomProof = {
  status: FitCheckStatus
  reason?: string
  values: Value[]
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
  }, 'sequence', `atom-${spec.name}`, 'checked layout atom claim', status.values, context.assumptions)
}

function proveAtomSpec(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): AtomProof {
  switch (spec.name) {
    case 'nondecreasing':
      return proveNondecreasingAtom(spec, context, hooks)
    case 'spaced':
      return proveSpacedAtom(spec, context, hooks)
    default:
      return {status: 'unknown', reason: `Unknown layout atom ${spec.name}`, values: []}
  }
}

function proveNondecreasingAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): AtomProof {
  const target = sequencePropArgument(spec.args, context, hooks)
  if (target == null) return {status: 'unknown', reason: 'nondecreasing expects return.rows.top', values: []}
  if (hasNondecreasingProp(target.array, target.prop)) return {status: 'pass', values: [target.array]}
  return {status: 'unknown', reason: nondecreasingFailureReason(spec.text, target), values: [target.array]}
}

function proveSpacedAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext, hooks: CheckSpecHooks): AtomProof {
  if (spec.args.length !== 2) return {status: 'unknown', reason: 'spaced expects spaced(rows, gap)', values: []}
  const rows = evaluateSpecExpression(spec.args[0]!, context, hooks)
  const gap = evaluateSpecExpression(spec.args[1]!, context, hooks)
  const values = [rows, gap]
  if (rows.kind !== 'array') return {status: 'unknown', reason: 'spaced expected an array', values}
  if (gap.kind !== 'number' || gap.expr == null) return {status: 'unknown', reason: 'spaced expected a known gap expression', values}
  if (provedSpacing(rows, gap.expr) != null) return {status: 'pass', values}
  return {status: 'unknown', reason: spacedFailureReason(spec.text, rows, gap.expr), values}
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
