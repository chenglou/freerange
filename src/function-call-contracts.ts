import * as ts from 'typescript'
import {
  callSiteText,
  valueWithCallSiteText,
  type CallSiteBindings,
} from './call-site-text.ts'
import type {
  EvalContext,
  FitCheckStatus,
  FunctionContractProof,
  FunctionContractSource,
  ImportedBinding,
  Program,
} from './check-types.ts'
import {
  finiteNumberValue,
  linearNameForExpression,
  mergeAssumptions,
  mergeProvenance,
  numberBranches,
  numberValue,
  unknown,
  withNumberCases,
  type NumberValue,
  type Value,
} from './domain.ts'
import {
  closedRangeApprox,
  finiteElementAccessRoot,
  parsePrintedNumber,
  setDomainPathValue,
  setFiniteArrayElementValue,
} from './domain-paths.ts'
import {
  bindFunctionCallInputs,
} from './function-inputs.ts'
import {functionContractSpecs} from './function-contracts.ts'
import {functionInputRoots} from './function-shape.ts'
import {
  linearConstant,
  linearVariable,
  unwrapExpression,
} from './linear.ts'
import type {FitFunction} from './modules.ts'
import {
  fitReturnInternalRoot,
  parseDomainPathText,
  parseExpression,
  parseFitExpression,
  type ComparisonOperator,
  type FitRange,
  type FitSpec,
} from './parser.ts'
import {programGlobalEnv} from './program-env.ts'
import {
  comparisonConstraint,
  flipComparison,
  proveComparison,
} from './proof.ts'
import {
  comparisonNeed,
  formatExpectedRange,
  formatRange,
  formatRangeSpec,
  rangeSpecMissingBounds,
} from './reporting.ts'
import {expressionRootNameDeep} from './source-expressions.ts'

export type CallContractEvaluators = {
  evaluateSpecExpression(text: string, context: EvalContext): Value
  proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string}
}

export function verifyCallGivenSpecs(
  calleeProgram: Program,
  fn: FitFunction,
  callText: string,
  argumentValues: Value[],
  context: EvalContext,
  options: {record: boolean; callLine?: number | undefined; thisValue?: Value | undefined; callSiteBindings?: CallSiteBindings | undefined},
  evaluators: CallContractEvaluators,
) {
  const specs = functionContractSpecs(calleeProgram, fn)
  const env = programGlobalEnv(calleeProgram)
  let statusSummary: FitCheckStatus = 'pass'
  bindFunctionCallInputs(fn, argumentValues, env, calleeProgram, options.thisValue)
  const calleeContext: EvalContext = {...context, program: calleeProgram, env, inputRoots: functionInputRoots(calleeProgram, fn)}

  for (const spec of specs) {
    let status: {status: FitCheckStatus; reason?: string} | null = null
    if (spec.kind === 'given-range') {
      const value = evaluators.evaluateSpecExpression(spec.expression, calleeContext)
      status = evaluators.proveRangeSpec(value, spec.range, calleeContext)
      if (status.status !== 'pass') status = withCallRangeReason(status, value, spec, options.callSiteBindings)
    }
    if (spec.kind === 'given-comparison') {
      const left = evaluators.evaluateSpecExpression(spec.left, calleeContext)
      const right = evaluators.evaluateSpecExpression(spec.right, calleeContext)
      status = proveComparison(left, spec.op, right, calleeContext.assumptions)
      if (status.status !== 'pass') status = withCallComparisonReason(status, left, right, spec, options.callSiteBindings)
    }
    if (status == null) continue
    if (options.record) {
      context.checks.push({
        file: context.file,
        ...(options.callLine == null ? {} : {line: options.callLine}),
        functionName: context.stack.join(' > '),
        text: `call ${callText}: ${callRequirementText(spec)}`,
        status: status.status,
        ...(status.reason == null ? {} : {reason: status.reason}),
      })
    }
    if (status.status === 'fail') statusSummary = 'fail'
    else if (status.status === 'unknown' && statusSummary === 'pass') statusSummary = 'unknown'
  }
  return statusSummary
}

function callRequirementText(spec: FitSpec) {
  return spec.text.startsWith('given ') ? `requires ${spec.text.slice('given '.length)}` : spec.text
}

function withCallRangeReason(
  status: {status: FitCheckStatus; reason?: string},
  value: Value,
  spec: Extract<FitSpec, {kind: 'given-range'}>,
  callSiteBindings: CallSiteBindings | undefined,
): {status: FitCheckStatus; reason?: string} {
  if (value.kind !== 'number') return status
  return {
    ...status,
    reason: [
      `called function requires ${spec.expression}: ${formatRangeSpec(spec.range)}`,
      `this call passes ${formatCallBinding(spec.expression, value)}`,
      ...missingBoundsForRange(value, spec.range, callSiteBindings),
    ].join('\n'),
  }
}

function missingBoundsForRange(value: NumberValue, range: FitRange, callSiteBindings: CallSiteBindings | undefined) {
  if (range.finiteValues != null) {
    return [callSiteMissingLine(`${value.expr ?? formatRange(value)} in {${range.finiteValues.join(', ')}}`, callSiteBindings)]
  }
  const lower = range.lowerValue == null ? null : numberValue(range.lowerValue, range.lowerValue, Number.isInteger(range.lowerValue), range.lower, Number.isFinite(range.lowerValue) ? linearConstant(range.lowerValue) : null)
  const upper = range.upperValue == null ? null : numberValue(range.upperValue, range.upperValue, Number.isInteger(range.upperValue), range.upper, Number.isFinite(range.upperValue) ? linearConstant(range.upperValue) : null)
  return rangeSpecMissingBounds(
    value,
    range,
    lower ?? numberValue(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, false, range.lower, null),
    upper ?? numberValue(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false, range.upper, null),
    {
      lower: range.lowerValue != null && (range.lowerInclusive ? value.min < range.lowerValue : value.min <= range.lowerValue),
      upper: range.upperValue != null && (range.upperInclusive ? value.max > range.upperValue : value.max >= range.upperValue),
      integer: false,
    },
  ).map(line => callSiteMissingLineFromReportLine(line, callSiteBindings))
}

function withCallComparisonReason(
  status: {status: FitCheckStatus; reason?: string},
  left: Value,
  right: Value,
  spec: Extract<FitSpec, {kind: 'given-comparison'}>,
  callSiteBindings: CallSiteBindings | undefined,
): {status: FitCheckStatus; reason?: string} {
  if (left.kind !== 'number' || right.kind !== 'number') return status
  const missing = comparisonNeed(left, spec.op, right)
  const callSiteMissing = callSiteText(missing, callSiteBindings)
  const lines = [
    `called function requires ${spec.left} ${spec.op} ${spec.right}`,
    `this call passes ${formatCallComparisonBinding(spec, left, right)}`,
  ]
  if (status.status === 'unknown') lines.push(`could not prove ${callSiteMissing}`)
  lines.push(callSiteMissingLine(missing, callSiteBindings))
  return {
    ...status,
    reason: lines.join('\n'),
  }
}

function callSiteMissingLineFromReportLine(line: string, callSiteBindings: CallSiteBindings | undefined) {
  const prefix = 'missing: '
  if (!line.startsWith(prefix)) return line
  return callSiteMissingLine(line.slice(prefix.length), callSiteBindings)
}

function callSiteMissingLine(missing: string, callSiteBindings: CallSiteBindings | undefined) {
  const callSite = callSiteText(missing, callSiteBindings)
  return callSite === missing ? `missing: ${missing}` : `missing at call site: ${callSite}`
}

function formatCallBinding(name: string, value: NumberValue) {
  if (value.min === value.max) return `${name} = ${value.min}`
  const range = formatExpectedRange(value.min, value.max, value.isInteger)
  return value.expr == null || value.expr === name ? `${name} is ${range}` : `${name} is ${range} from ${value.expr}`
}

function formatCallComparisonBinding(spec: Extract<FitSpec, {kind: 'given-comparison'}>, left: NumberValue, right: NumberValue) {
  const leftText = formatCallBinding(spec.left, left)
  const rightText = formatCallBinding(spec.right, right)
  if (parsePrintedNumber(spec.left) != null) return rightText
  if (parsePrintedNumber(spec.right) != null) return leftText
  return `${leftText} and ${rightText}`
}

export function importedContractUnavailableReason(localName: string, binding: ImportedBinding, detail: string) {
  return [
    'imported helper contract was not available',
    `helper: ${importedHelperLabel(localName, binding)}`,
    `reason: ${detail}`,
  ].join('\n')
}

export function importedContractFailureReason(localName: string, binding: Extract<ImportedBinding, {kind: 'resolved'}>, proof: FunctionContractProof) {
  if (proof.status === 'verifying') return importedContractUnavailableReason(localName, binding, 'contract is already being verified')
  const failed = proof.checks.find(check => check.status !== 'pass')
  const head = proof.status === 'fail' ? 'imported helper contract failed in source before this call could use it' : 'imported helper contract was not proven in source before this call could use it'
  if (failed == null) {
    return [
      head,
      `helper: ${importedHelperLabel(localName, binding)}`,
    ].join('\n')
  }
  const reason = failed.reason == null ? '' : `\n${failed.reason}`
  return [
    head,
    `helper: ${importedHelperLabel(localName, binding)}`,
    `failed check: ${failed.file}:${failed.functionName}: ${failed.text}${reason}`,
  ].join('\n')
}

function importedHelperLabel(localName: string, binding: ImportedBinding) {
  const importedName = binding.exportedName === '*'
    ? `${localName} (namespace)`
    : binding.exportedName === localName || localName.endsWith(`.${binding.exportedName}`) ? localName : `${localName} (${binding.exportedName})`
  return `${importedName} from ${binding.specifier}`
}

export function valueWithFunctionContractSummary(
  functionName: string,
  program: Program,
  fn: FitFunction,
  specs: FitSpec[],
  argumentValues: Value[],
  contractCache: Map<string, FunctionContractProof>,
  source: FunctionContractSource,
  result: Value,
  thisValue: Value | undefined,
  callSiteBindings: CallSiteBindings | undefined,
  evaluators: CallContractEvaluators,
): Value {
  const env = programGlobalEnv(program)
  bindFunctionCallInputs(fn, argumentValues, env, program, thisValue)
  env.set(fitReturnInternalRoot, result)

  const context: EvalContext = {
    program,
    file: program.file,
    env,
    inputRoots: [...functionInputRoots(program, fn), fitReturnInternalRoot],
    stack: [functionName],
    checks: [],
    assumptions: [],
    contractCache,
  }

  for (const spec of specs) {
    if (spec.kind === 'check-range') applySummaryRangeSpec(env, spec, context, source, evaluators)
  }
  for (const spec of specs) {
    if (spec.kind === 'check-comparison') applySummaryComparisonSpec(env, spec, context, source, evaluators)
  }

  const summary = env.get(fitReturnInternalRoot) ?? unknown(`Imported function ${functionName} contract did not describe return`)
  return valueWithCallSiteText(summary, callSiteBindings)
}

function applySummaryRangeSpec(
  env: Map<string, Value>,
  spec: Extract<FitSpec, {kind: 'check-range'}>,
  context: EvalContext,
  source: FunctionContractSource,
  evaluators: CallContractEvaluators,
) {
  if (simpleResultPathText(spec.expression) == null) return
  const closed = closedRangeApprox(spec.range)
  if (closed == null) return
  const current = evaluators.evaluateSpecExpression(spec.expression, context)
  setSummaryPathValue(
    env,
    spec.expression,
    summaryRangeValue(current, spec, closed, source),
  )
}

function summaryRangeValue(
  current: Value,
  spec: Extract<FitSpec, {kind: 'check-range'}>,
  closed: {min: number; max: number},
  source: FunctionContractSource,
): NumberValue {
  const provenance = [checkedContractFact(source, spec.text)]
  if (current.kind !== 'number') {
    return spec.range.finiteValues == null
      ? numberValue(
        closed.min,
        closed.max,
        spec.range.valueKind === 'int',
        spec.expression,
        linearVariable(linearNameForExpression(spec.expression)),
        null,
        provenance,
      )
      : finiteNumberValue(spec.range.finiteValues, spec.expression, linearVariable(linearNameForExpression(spec.expression)), provenance)
  }

  const expr = current.expr ?? spec.expression
  const linear = current.linear ?? linearVariable(linearNameForExpression(expr))
  if (spec.range.finiteValues != null) return finiteNumberValue(spec.range.finiteValues, expr, linear, mergeProvenance(current, provenance))
  return numberValue(
    Math.max(current.min, closed.min),
    Math.min(current.max, closed.max),
    current.isInteger || spec.range.valueKind === 'int',
    expr,
    linear,
    null,
    mergeProvenance(current, provenance),
  )
}

function applySummaryComparisonSpec(
  env: Map<string, Value>,
  spec: Extract<FitSpec, {kind: 'check-comparison'}>,
  context: EvalContext,
  source: FunctionContractSource,
  evaluators: CallContractEvaluators,
) {
  const leftPath = simpleResultPathText(spec.left)
  const rightPath = simpleResultPathText(spec.right)
  const fact = checkedContractFact(source, spec.text)
  if (leftPath != null && rightPath == null) {
    const right = evaluators.evaluateSpecExpression(spec.right, context)
    if (right.kind === 'number') applySummaryComparisonToPath(env, context, leftPath, spec.op, right, fact, evaluators)
    return
  }
  if (rightPath != null && leftPath == null) {
    const left = evaluators.evaluateSpecExpression(spec.left, context)
    if (left.kind === 'number') applySummaryComparisonToPath(env, context, rightPath, flipComparison(spec.op), left, fact, evaluators)
  }
}

function applySummaryComparisonToPath(
  env: Map<string, Value>,
  context: EvalContext,
  path: string,
  op: ComparisonOperator,
  other: NumberValue,
  fact: string,
  evaluators: CallContractEvaluators,
) {
  const current = evaluators.evaluateSpecExpression(path, context)
  if (current.kind !== 'number') return
  const provenance = mergeProvenance(current, other, [fact])
  const withSummaryFact = (value: NumberValue): NumberValue => {
    const summaryFact = comparisonConstraint(value, op, other, fact, 'contract')
    if (summaryFact == null) return value
    return withNumberCases(value, numberBranches(value).map(branch => ({
      value: branch.value,
      assumptions: mergeAssumptions(branch.assumptions, [summaryFact]),
    })))
  }

  switch (op) {
    case '==':
      setSummaryPathValue(env, path, withSummaryFact(numberValue(other.min, other.max, other.isInteger, other.expr, other.linear, null, provenance)))
      return
    case '>=':
    case '>':
      setSummaryPathValue(env, path, withSummaryFact(numberValue(Math.max(current.min, other.min), current.max, current.isInteger, current.expr, current.linear, current.cases, provenance)))
      return
    case '<=':
    case '<':
      setSummaryPathValue(env, path, withSummaryFact(numberValue(current.min, Math.min(current.max, other.max), current.isInteger, current.expr, current.linear, current.cases, provenance)))
      return
  }
}

function checkedContractFact(source: FunctionContractSource, text: string) {
  const kind = source.kind === 'local' ? 'checked helper contract' : 'checked imported contract'
  return `${kind}: ${source.sourceFile}#${source.sourceFunctionName}: ${text}`
}

function simpleResultPathText(text: string): string | null {
  const parsed = parseFitExpression(text)
  const domainPaths = [...parsed.domainPaths.values()]
  if (domainPaths.length === 1 && domainPaths[0]!.root === fitReturnInternalRoot && ts.isIdentifier(parsed.expression)) return text
  if (domainPaths.length > 0) return null

  const expression = unwrapExpression(parsed.expression)
  if (ts.isIdentifier(expression) && expression.text === fitReturnInternalRoot) return text
  if (ts.isPropertyAccessExpression(expression) && expressionRootNameDeep(expression.expression) === fitReturnInternalRoot) return text
  const finiteElement = finiteElementAccessRoot(expression)
  if (finiteElement?.root === fitReturnInternalRoot) return text
  return null
}

function setSummaryPathValue(env: Map<string, Value>, path: string, value: Value) {
  const domainPath = parseDomainPathText(path)
  if (domainPath != null && domainPath.segments.length > 0) {
    env.set(domainPath.root, setDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
    return
  }

  const expression = parseExpression(path)
  if (ts.isIdentifier(expression)) {
    env.set(expression.text, value)
    return
  }

  const finiteElement = finiteElementAccessRoot(expression)
  if (finiteElement != null) {
    env.set(finiteElement.root, setFiniteArrayElementValue(env.get(finiteElement.root), finiteElement.root, finiteElement.index, value))
  }
}
