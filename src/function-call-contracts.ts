import * as ts from 'typescript'
import {
  callSiteText,
  valueWithCallSiteText,
  type CallSiteBindings,
} from './call-site-text.ts'
import type {
  EvalContext,
  FitCheckDetail,
  FitCheckStatus,
  FunctionContractProof,
  FunctionContractSource,
  ImportedBinding,
  Program,
} from './check-types.ts'
import {
  linearNameForExpression,
  joinValues,
  mergeProvenance,
  numberBranches,
  numberValue,
  unknown,
  withNumberCases,
  type NumberValue,
  type Value,
} from './domain.ts'
import {mergeAssumptions} from './assumptions.ts'
import {
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
  linearVariable,
  unwrapExpression,
} from './linear.ts'
import type {FitFunction} from './modules.ts'
import {
  fitExpressionParsed,
  fitExpressionText,
  fitValueSpecNumberLiteralValue,
  fitRangeCases,
  fitValueSpecPropertyName,
  fitValueSpecRangeForTypeNode,
  fitReturnInternalRoot,
  parseDomainPathText,
  parseExpression,
  parseFitRangeText,
  type ComparisonOperator,
  type FitExpressionLike,
  type FitRange,
  type FitSpec,
  type FitValueSpec,
} from './parser.ts'
import {
  createFitValueSpecTypeEnv,
  fitValueSpecTupleElementType,
  withResolvedFitValueSpecTypeReference,
  type FitValueSpecTypeEnv,
} from './value-specs.ts'
import {
  callPreconditionObligation,
} from './obligations.ts'
import {proveObligation} from './proof-broker.ts'
import {programGlobalEnv} from './program-env.ts'
import {
  comparisonConstraint,
  flipComparison,
  proveComparison,
} from './proof.ts'
import {proofFactsFromValues} from './proof-facts.ts'
import {
  comparisonNeed,
  formatExpectedRange,
  formatNumber,
  formatRange,
  formatRangeSpec,
} from './reporting.ts'
import {expressionRootNameDeep} from './source-expressions.ts'

export type CallContractEvaluators = {
  evaluateSpecExpression(text: FitExpressionLike, context: EvalContext): Value
  evaluateRangeValue(range: FitRange, context: EvalContext, expr: string | null, provenance?: string[]): Value
  proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string}
}

type CallPreconditionStatus = {
  status: FitCheckStatus
  reason?: string
  detail?: FitCheckDetail
}

type SummaryComparisonFact = NonNullable<ReturnType<typeof comparisonConstraint>>

export function verifyCallGivenSpecs(
  calleeProgram: Program,
  fn: FitFunction,
  callText: string,
  argumentValues: Value[],
  context: EvalContext,
  options: {record: boolean; callLine?: number | undefined; thisValue?: Value | undefined; callSiteBindings?: CallSiteBindings | undefined},
  evaluators: CallContractEvaluators,
) {
  const contractSpecs = functionContractSpecs(calleeProgram, fn)
  const env = programGlobalEnv(calleeProgram)
  let statusSummary: FitCheckStatus = 'pass'
  bindFunctionCallInputs(fn, argumentValues, env, calleeProgram, options.thisValue)
  const calleeContext: EvalContext = {...context, program: calleeProgram, env, inputRoots: functionInputRoots(calleeProgram, fn)}

  for (const spec of contractSpecs) {
    let status: CallPreconditionStatus | null = null
    let usedFacts: string[] = []
    if (spec.kind === 'given-range') {
      const value = evaluators.evaluateSpecExpression(spec.expression, calleeContext)
      usedFacts = proofFactsFromValues([value], calleeContext.assumptions)
      status = evaluators.proveRangeSpec(value, spec.range, calleeContext)
      status = withCallRangeDetail(status, callText, value, spec, options.callSiteBindings)
    }
    if (spec.kind === 'given-comparison') {
      const left = evaluators.evaluateSpecExpression(spec.left, calleeContext)
      const right = evaluators.evaluateSpecExpression(spec.right, calleeContext)
      usedFacts = proofFactsFromValues([left, right], calleeContext.assumptions)
      status = proveComparison(left, spec.op, right, calleeContext.assumptions)
      status = withCallComparisonDetail(status, callText, left, right, spec, options.callSiteBindings)
    }
    if (status == null) continue
    if (options.record) {
      const text = `${callText}: ${callRequirementText(spec)}`
      const obligation = callPreconditionObligation({
        file: context.file,
        functionName: context.stack.join(' > '),
        text,
        requirement: callRequirementText(spec),
        ...(options.callLine == null ? {} : {callLine: options.callLine}),
      })
      context.checks.push(proveObligation({
        obligation,
        step: {
          domain: 'helper-contract',
          rule: 'given-precondition',
          message: 'checked callee given at the caller',
        },
        usedFacts,
        prove: () => ({
          file: context.file,
          ...(options.callLine == null ? {} : {line: options.callLine}),
          functionName: context.stack.join(' > '),
          text,
          status: status.status,
          ...(status.reason == null ? {} : {reason: status.reason}),
          ...(status.detail == null ? {} : {detail: status.detail}),
        }),
      }))
    }
    if (status.status === 'fail') statusSummary = 'fail'
    else if (status.status === 'unknown' && statusSummary === 'pass') statusSummary = 'unknown'
  }
  return statusSummary
}

function callRequirementText(spec: FitSpec) {
  return spec.text.startsWith('given ') ? `requires ${spec.text.slice('given '.length)}` : spec.text
}

function withCallRangeDetail(
  status: CallPreconditionStatus,
  callText: string,
  value: Value,
  spec: Extract<FitSpec, {kind: 'given-range'}>,
  callSiteBindings: CallSiteBindings | undefined,
): CallPreconditionStatus {
  if (value.kind !== 'number') return withUnsupportedCallDetail(status, callText, callRequirementText(spec), formatCallBinding(spec.expression.text, value), [
    `${callSiteText(spec.expression.text, callSiteBindings)}: ${callSiteText(formatRangeSpec(spec.range), callSiteBindings)}`,
  ])
  const missing = status.status === 'pass' ? [] : missingBoundsForRange(value, spec.range, callSiteBindings)
  return withCallDetail(status, {
    kind: 'call-precondition',
    callText,
    requirement: callRequirementText(spec),
    callerPassed: formatCallBinding(spec.expression.text, value),
    missing,
    definiteFailure: status.status === 'fail' && exactNumber(value) != null,
    unsupported: false,
  })
}

function missingBoundsForRange(value: NumberValue, range: FitRange, callSiteBindings: CallSiteBindings | undefined) {
  const valueText = callSiteText(value.expr ?? formatRange(value), callSiteBindings)
  const rangeText = callSiteText(formatRangeSpec(range), callSiteBindings)
  if (range.finiteValues != null) {
    return [`${valueText} in {${range.finiteValues.join(', ')}}`]
  }
  if (fitRangeCases(range).length > 1) return [`${valueText}: ${rangeText}`]
  const missing = {
    lower: range.lowerValue != null && (range.lowerInclusive ? value.min < range.lowerValue : value.min <= range.lowerValue),
    upper: range.upperValue != null && (range.upperInclusive ? value.max > range.upperValue : value.max >= range.upperValue),
    integer: range.valueKind === 'int' && !value.isInteger,
  }
  if ((missing.lower && missing.upper) || (missing.integer && (missing.lower || missing.upper))) {
    return [`${valueText}: ${rangeText}`]
  }

  const lines: string[] = []
  if (missing.lower) lines.push(`${valueText} ${range.lowerInclusive ? '>=' : '>'} ${callSiteText(range.lower.text, callSiteBindings)}`)
  if (missing.upper) lines.push(`${valueText} ${range.upperInclusive ? '<=' : '<'} ${callSiteText(range.upper.text, callSiteBindings)}`)
  if (missing.integer) lines.push(`${valueText} is an integer`)
  return lines.length === 0 ? [`${valueText}: ${rangeText}`] : lines
}

function withCallComparisonDetail(
  status: CallPreconditionStatus,
  callText: string,
  left: Value,
  right: Value,
  spec: Extract<FitSpec, {kind: 'given-comparison'}>,
  callSiteBindings: CallSiteBindings | undefined,
): CallPreconditionStatus {
  if (left.kind !== 'number' || right.kind !== 'number') {
    return withUnsupportedCallDetail(status, callText, callRequirementText(spec), formatCallComparisonBinding(spec, left, right), [
      callSiteText(`${spec.left.text} ${spec.op} ${spec.right.text}`, callSiteBindings),
    ])
  }
  const missing = status.status === 'pass' ? [] : [callSiteText(comparisonNeed(left, spec.op, right), callSiteBindings)]
  return withCallDetail(status, {
    kind: 'call-precondition',
    callText,
    requirement: callRequirementText(spec),
    callerPassed: formatCallComparisonBinding(spec, left, right),
    missing,
    definiteFailure: status.status === 'fail' && exactNumber(left) != null && exactNumber(right) != null,
    unsupported: false,
  })
}

function callPreconditionReason(detail: FitCheckDetail) {
  return [
    `caller passed: ${detail.callerPassed}`,
    ...detail.missing.map(missing => `missing: ${missing}`),
  ].join('\n')
}

function withUnsupportedCallDetail(
  status: CallPreconditionStatus,
  callText: string,
  requirement: string,
  callerPassed: string,
  missing: string[],
): CallPreconditionStatus {
  return withCallDetail(status, {
    kind: 'call-precondition',
    callText,
    requirement,
    callerPassed,
    missing,
    definiteFailure: false,
    unsupported: true,
  })
}

function withCallDetail(status: CallPreconditionStatus, detail: FitCheckDetail): CallPreconditionStatus {
  return {
    ...status,
    ...(status.status === 'pass' ? {} : {reason: callPreconditionReason(detail)}),
    detail,
  }
}

function formatCallBinding(name: string, value: Value) {
  return `${name}: ${formatCallValue(value)}`
}

function formatCallValue(value: Value) {
  if (value.kind === 'number') {
    const exact = exactNumber(value)
    if (exact != null) return formatNumber(exact)
    return formatExpectedRange(value.min, value.max, value.isInteger)
  }
  if (value.kind === 'literal') return value.values.map(String).join(' | ')
  if (value.kind === 'unknown') return `unknown (${value.reason})`
  return value.kind
}

function formatCallComparisonBinding(spec: Extract<FitSpec, {kind: 'given-comparison'}>, left: Value, right: Value) {
  const leftText = formatCallBinding(spec.left.text, left)
  const rightText = formatCallBinding(spec.right.text, right)
  if (parsePrintedNumber(spec.left.text) != null) return rightText
  if (parsePrintedNumber(spec.right.text) != null) return leftText
  return `${leftText}, ${rightText}`
}

function exactNumber(value: NumberValue) {
  return value.min === value.max && Number.isFinite(value.min) ? value.min : null
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
  const bindingName = binding.kind === 'unresolved' ? binding.exportedName : binding.importedName
  const importedName = bindingName === '*'
    ? `${localName} (namespace)`
    : bindingName === localName || localName.endsWith(`.${bindingName}`) ? localName : `${localName} (${bindingName})`
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
    if (spec.kind === 'check-value') applySummaryValueSpec(env, spec.value, spec.expression, spec.text, context, source, evaluators)
  }
  for (const spec of specs) {
    if (spec.kind === 'check-comparison') applySummaryComparisonSpec(env, spec, context, source, evaluators)
  }

  const summary = env.get(fitReturnInternalRoot) ?? unknown(`Imported function ${functionName} contract did not describe return`)
  return valueWithCallSiteText(summary, callSiteBindings)
}

function applySummaryValueSpec(
  env: Map<string, Value>,
  valueSpec: FitValueSpec,
  expression: FitExpressionLike,
  text: string,
  context: EvalContext,
  source: FunctionContractSource,
  evaluators: CallContractEvaluators,
) {
  const rootPath = simpleResultPathText(expression)
  if (rootPath == null) return
  const ranges = valueSpecRangeValues(valueSpec.typeNode, createFitValueSpecTypeEnv(context.program, valueSpec), rootPath, text, context, source, evaluators)
  for (const [path, value] of ranges) {
    if (value.kind !== 'number') continue
    const current = evaluators.evaluateSpecExpression(path, context)
    setSummaryPathValue(env, path, summaryRangeValue(current, value, source, text))
  }
}

function valueSpecRangeValues(
  node: ts.TypeNode,
  env: FitValueSpecTypeEnv,
  path: string,
  text: string,
  context: EvalContext,
  source: FunctionContractSource,
  evaluators: CallContractEvaluators,
): Map<string, Value> {
  if (ts.isParenthesizedTypeNode(node)) return valueSpecRangeValues(node.type, env, path, text, context, source, evaluators)
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return valueSpecRangeValues(node.type, env, path, text, context, source, evaluators)
  if (ts.isUnionTypeNode(node)) {
    const caseMaps = node.types.map(current => valueSpecRangeValues(current, env, path, text, context, source, evaluators))
    const sharedPaths = caseMaps[0] == null ? [] : [...caseMaps[0].keys()].filter(key => caseMaps.every(caseMap => caseMap.has(key)))
    const result = new Map<string, Value>()
    for (const sharedPath of sharedPaths) {
      let value: Value | null = null
      for (const caseMap of caseMaps) {
        const next = caseMap.get(sharedPath)
        if (next == null) continue
        value = value == null ? next : joinValues(value, next)
      }
      if (value != null) result.set(sharedPath, value)
    }
    return result
  }
  if (ts.isIntersectionTypeNode(node)) {
    return intersectValueSpecRangeMaps(node.types.map(current => valueSpecRangeValues(current, env, path, text, context, source, evaluators)))
  }
  const range = fitValueSpecRangeForTypeNode(node, env.spec.ranges)
  if (range != null) {
    const value = evaluators.evaluateRangeValue(range, context, path, [checkedContractFact(source, text)])
    return new Map([[path, value]])
  }
  if (ts.isLiteralTypeNode(node)) {
    const value = fitValueSpecNumberLiteralValue(node)
    if (value == null) return new Map()
    const range = parseFitRangeText(String(value))
    return range == null ? new Map() : new Map([[path, evaluators.evaluateRangeValue(range, context, path, [checkedContractFact(source, text)])]])
  }
  if (ts.isTypeLiteralNode(node)) {
    return valueSpecMemberRangeValues(node.members, env, path, text, context, source, evaluators)
  }
  if (ts.isArrayTypeNode(node)) return valueSpecRangeValues(node.elementType, env, `${path}[]`, text, context, source, evaluators)
  if (ts.isTupleTypeNode(node)) {
    return mergeValueSpecRangeMaps(node.elements.map((element, index) => {
      const type = fitValueSpecTupleElementType(element)
      return type == null ? new Map() : valueSpecRangeValues(type, env, `${path}[${index}]`, text, context, source, evaluators)
    }))
  }
  if (ts.isTypeReferenceNode(node)) {
    return withResolvedFitValueSpecTypeReference(node, env, current => {
      switch (current.kind) {
        case 'node':
          return valueSpecRangeValues(current.node, current.env, path, text, context, source, evaluators)
        case 'members':
          return valueSpecMemberRangeValues(current.members, current.env, path, text, context, source, evaluators)
        case 'array':
          return valueSpecRangeValues(current.element, current.env, `${path}[]`, text, context, source, evaluators)
      }
    }) ?? new Map()
  }
  return new Map()
}

function valueSpecMemberRangeValues(
  members: ts.NodeArray<ts.TypeElement>,
  env: FitValueSpecTypeEnv,
  path: string,
  text: string,
  context: EvalContext,
  source: FunctionContractSource,
  evaluators: CallContractEvaluators,
) {
  return mergeValueSpecRangeMaps(members.map(member => {
    if (!ts.isPropertySignature(member) || member.questionToken != null || member.type == null) return new Map()
    const name = fitValueSpecPropertyName(member.name)
    return name == null ? new Map() : valueSpecRangeValues(member.type, env, `${path}.${name}`, text, context, source, evaluators)
  }))
}

function mergeValueSpecRangeMaps(maps: Map<string, Value>[]): Map<string, Value> {
  const result = new Map<string, Value>()
  for (const map of maps) {
    for (const [path, value] of map) {
      const current = result.get(path)
      result.set(path, current == null ? value : joinValues(current, value))
    }
  }
  return result
}

function intersectValueSpecRangeMaps(maps: Map<string, Value>[]): Map<string, Value> {
  const result = new Map<string, Value>()
  for (const map of maps) {
    for (const [path, value] of map) {
      const current = result.get(path)
      result.set(path, current == null ? value : summaryIntersectionValue(current, value))
    }
  }
  return result
}

function summaryIntersectionValue(left: Value, right: Value): Value {
  if (left.kind !== 'number' || right.kind !== 'number') return joinValues(left, right)
  return numberValue(
    Math.max(left.min, right.min),
    Math.min(left.max, right.max),
    left.isInteger || right.isInteger,
    left.expr ?? right.expr,
    left.linear ?? right.linear,
    null,
    mergeProvenance(left, right),
  )
}

function applySummaryRangeSpec(
  env: Map<string, Value>,
  spec: Extract<FitSpec, {kind: 'check-range'}>,
  context: EvalContext,
  source: FunctionContractSource,
  evaluators: CallContractEvaluators,
) {
  if (simpleResultPathText(spec.expression) == null) return
  const current = evaluators.evaluateSpecExpression(spec.expression, context)
  const rangeValue = evaluators.evaluateRangeValue(spec.range, context, current.kind === 'number' ? current.expr : spec.expression.text, [checkedContractFact(source, spec.text)])
  if (rangeValue.kind !== 'number') return
  setSummaryPathValue(
    env,
    spec.expression.text,
    summaryRangeValue(current, rangeValue, source, spec.text),
  )
}

function summaryRangeValue(
  current: Value,
  rangeValue: NumberValue,
  source: FunctionContractSource,
  text: string,
): NumberValue {
  const provenance = [checkedContractFact(source, text)]
  if (current.kind !== 'number') return {...rangeValue, provenance: mergeProvenance(rangeValue, provenance)}

  const expr = current.expr ?? rangeValue.expr
  const linear = current.linear ?? (expr == null ? rangeValue.linear : linearVariable(linearNameForExpression(expr)))
  if (rangeValue.cases != null) {
    return withNumberCases(
      numberValue(
        Math.max(current.min, rangeValue.min),
        Math.min(current.max, rangeValue.max),
        current.isInteger || rangeValue.isInteger,
        expr,
        linear,
        null,
        mergeProvenance(current, rangeValue, provenance),
      ),
      numberBranches(rangeValue).map(branch => ({
        value: numberValue(
          Math.max(current.min, branch.value.min),
          Math.min(current.max, branch.value.max),
          current.isInteger || branch.value.isInteger,
          expr,
          linear,
          null,
          mergeProvenance(current, branch.value, provenance),
        ),
        assumptions: branch.assumptions,
      })),
    )
  }
  return numberValue(
    Math.max(current.min, rangeValue.min),
    Math.min(current.max, rangeValue.max),
    current.isInteger || rangeValue.isInteger,
    expr,
    linear,
    null,
    mergeProvenance(current, rangeValue, provenance),
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
  if (leftPath != null && rightPath != null) {
    const left = evaluators.evaluateSpecExpression(spec.left, context)
    const right = evaluators.evaluateSpecExpression(spec.right, context)
    if (left.kind !== 'number' || right.kind !== 'number') return
    const summaryFact = comparisonConstraint(left, spec.op, right, fact, 'contract')
    if (summaryFact == null) return
    applySummaryFactToPath(env, context, leftPath, summaryFact, fact, evaluators)
    applySummaryFactToPath(env, context, rightPath, summaryFact, fact, evaluators)
    return
  }
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

function applySummaryFactToPath(
  env: Map<string, Value>,
  context: EvalContext,
  path: string,
  summaryFact: SummaryComparisonFact,
  fact: string,
  evaluators: CallContractEvaluators,
) {
  const current = evaluators.evaluateSpecExpression(path, context)
  if (current.kind !== 'number') return
  setSummaryPathValue(env, path, numberWithSummaryFact({...current, provenance: mergeProvenance(current, [fact])}, summaryFact))
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
    return numberWithSummaryFact(value, summaryFact)
  }

  switch (op) {
    case '==':
      setSummaryPathValue(env, path, withSummaryFact(numberValue(other.min, other.max, other.isInteger, other.expr, other.linear, other.cases, provenance)))
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

function numberWithSummaryFact(value: NumberValue, summaryFact: SummaryComparisonFact): NumberValue {
  return withNumberCases(value, numberBranches(value).map(branch => ({
    value: branch.value,
    assumptions: mergeAssumptions(branch.assumptions, [summaryFact]),
  })))
}

function checkedContractFact(source: FunctionContractSource, text: string) {
  const kind = source.kind === 'local' ? 'checked helper contract' : 'checked imported contract'
  return `${kind}: ${source.sourceFile}#${source.sourceFunctionName}: ${text}`
}

function simpleResultPathText(text: FitExpressionLike): string | null {
  const sourceText = fitExpressionText(text)
  const parsed = fitExpressionParsed(text)
  const domainPaths = [...parsed.domainPaths.values()]
  if (domainPaths.length === 1 && domainPaths[0]!.root === fitReturnInternalRoot && ts.isIdentifier(parsed.expression)) return sourceText
  if (domainPaths.length > 0) return null

  const expression = unwrapExpression(parsed.expression)
  if (ts.isIdentifier(expression) && expression.text === fitReturnInternalRoot) return sourceText
  if (ts.isPropertyAccessExpression(expression) && expressionRootNameDeep(expression.expression) === fitReturnInternalRoot) return sourceText
  const finiteElement = finiteElementAccessRoot(expression)
  if (finiteElement?.root === fitReturnInternalRoot) return sourceText
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
