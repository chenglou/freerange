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
  literalValue,
  mergeOrigin,
  numberBranches,
  numberValue,
  unknown,
  withNumberCases,
  type LiteralValue,
  type NumberCase,
  type NumberValue,
  type Value,
  gridMeet,
  integerValued,
} from './domain.ts'
import {mergeAssumptions} from './assumptions.ts'
import {assumptionsAreReachable} from './constraint-reachability.ts'
import {
  finiteElementAccessRoot,
  parsePrintedNumber,
  setCheckedDomainPathValue,
  setCheckedFiniteArrayElementValue,
} from './domain-paths.ts'
import {functionContractSpecs} from './function-contracts.ts'
import {filterTypeCheckedSpecs} from './contract-typecheck.ts'
import {functionInputRoots} from './function-shape.ts'
import {
  linearVariable,
  unwrapExpression,
  type LinearExpr,
} from './linear.ts'
import type {FitFunction} from './modules.ts'
import type {PreparedCall} from './prepared-call.ts'
import {
  fitSpecIsAssumption,
  fitSpecIsProof,
  fitExpressionParsed,
  fitExpressionText,
  type FitComparisonCheckSpec,
  type FitComparisonGivenSpec,
  type FitExpressionCheckSpec,
  type FitExpressionGivenSpec,
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
  type FitRangeCheckSpec,
  type FitRangeGivenSpec,
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
import {
  comparisonConstraint,
  flipComparison,
  proveComparison,
  proveObligation,
} from './proof.ts'
import {proofFactsFromValues} from './proof-facts.ts'
import {proveBooleanTrue} from './boolean-claims.ts'
import {
  comparisonNeed,
  formatNumber,
  formatRange,
  formatRangeSpec,
} from './reporting.ts'
import {expressionRootNameDeep} from './source-expressions.ts'

export type CallContractEvaluators = {
  evaluateSpecExpression(text: FitExpressionLike, context: EvalContext): Value
  evaluateRangeValue(range: FitRange, context: EvalContext, expr: string | null, origin?: string[]): Value
  proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string}
}

type CallPreconditionStatus = {
  status: FitCheckStatus
  reason?: string
  detail?: FitCheckDetail
}

type SummaryComparisonConstraint = NonNullable<ReturnType<typeof comparisonConstraint>>

export function verifyCallGivenSpecs(
  calleeProgram: Program,
  fn: FitFunction,
  callText: string,
  prepared: PreparedCall,
  context: EvalContext,
  options: {record: boolean; callLine?: number | undefined; callSiteBindings?: CallSiteBindings | undefined},
  evaluators: CallContractEvaluators,
) {
  const contractSpecs = filterTypeCheckedSpecs(calleeProgram, functionContractSpecs(calleeProgram, fn))
  const env = new Map(prepared.analysisEnv)
  let statusSummary: FitCheckStatus = 'pass'
  const calleeContext: EvalContext = {...context, program: calleeProgram, env, inputRoots: functionInputRoots(calleeProgram, fn)}

  for (const spec of contractSpecs) {
    let status: CallPreconditionStatus | null = null
    let usedFacts: string[] = []
    if (!fitSpecIsAssumption(spec)) continue
    if (spec.kind === 'range') {
      const value = evaluators.evaluateSpecExpression(spec.expression, calleeContext)
      usedFacts = proofFactsFromValues([value], calleeContext.assumptions)
      status = evaluators.proveRangeSpec(value, spec.range, calleeContext)
      status = withCallRangeDetail(status, callText, value, spec, options.callSiteBindings)
    }
    if (spec.kind === 'comparison') {
      const left = evaluators.evaluateSpecExpression(spec.left, calleeContext)
      const right = evaluators.evaluateSpecExpression(spec.right, calleeContext)
      usedFacts = proofFactsFromValues([left, right], calleeContext.assumptions)
      status = proveComparison(left, spec.op, right, calleeContext.assumptions)
      status = withCallComparisonDetail(status, callText, left, right, spec, options.callSiteBindings)
    }
    if (spec.kind === 'expression') {
      const value = evaluators.evaluateSpecExpression(spec.expression, calleeContext)
      usedFacts = proofFactsFromValues([value], calleeContext.assumptions)
      status = proveBooleanTrue(spec.text, value)
      status = withCallExpressionDetail(status, callText, value, spec, options.callSiteBindings)
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
  spec: FitRangeGivenSpec,
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
    integer: range.valueKind === 'int' && !integerValued(value),
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
  spec: FitComparisonGivenSpec,
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

function withCallExpressionDetail(
  status: CallPreconditionStatus,
  callText: string,
  value: Value,
  spec: FitExpressionGivenSpec,
  callSiteBindings: CallSiteBindings | undefined,
): CallPreconditionStatus {
  const expression = callSiteText(spec.expression.text, callSiteBindings)
  const missing = status.status === 'pass' ? [] : [status.reason ?? `${expression} must be true`]
  return withCallDetail(status, {
    kind: 'call-precondition',
    callText,
    requirement: callRequirementText(spec),
    callerPassed: formatCallBinding(spec.expression.text, value),
    missing,
    definiteFailure: status.status === 'fail',
    unsupported: value.kind === 'unknown',
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
    return formatRange({...value, expr: null})
  }
  if (value.kind === 'literal') return value.values.map(String).join(' | ')
  if (value.kind === 'unknown') return `unknown (${value.reason})`
  return value.kind
}

function formatCallComparisonBinding(spec: FitComparisonGivenSpec, left: Value, right: Value) {
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
  prepared: PreparedCall,
  contractCache: Map<string, FunctionContractProof>,
  source: FunctionContractSource,
  result: Value,
  callSiteBindings: CallSiteBindings | undefined,
  evaluators: CallContractEvaluators,
): Value {
  const env = new Map(prepared.analysisEnv)
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
    if (!fitSpecIsProof(spec)) continue
    if (spec.kind === 'range') applySummaryRangeSpec(env, spec, context, source, evaluators)
    if (spec.kind === 'value') applySummaryValueSpec(env, spec.value, spec.expression, spec.text, context, source, evaluators)
  }
  for (const spec of specs) {
    if (!fitSpecIsProof(spec)) continue
    if (spec.kind === 'comparison') applySummaryComparisonSpec(env, spec, context, source, evaluators)
    if (spec.kind === 'expression') applySummaryExpressionSpec(env, spec, source)
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
    gridMeet(left.grid, right.grid),
    left.expr ?? right.expr,
    left.linear ?? right.linear,
    null,
    mergeOrigin(left, right),
  )
}

function applySummaryRangeSpec(
  env: Map<string, Value>,
  spec: FitRangeCheckSpec,
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
  const origin = [checkedContractFact(source, text)]
  if (current.kind !== 'number') return {...rangeValue, origin: mergeOrigin(rangeValue, origin)}

  const expr = current.expr ?? rangeValue.expr
  const linear = current.linear ?? (expr == null ? rangeValue.linear : linearVariable(linearNameForExpression(expr)))
  if (current.cases != null || rangeValue.cases != null) {
    const envelope = numberValue(
      Math.max(current.min, rangeValue.min),
      Math.min(current.max, rangeValue.max),
      gridMeet(current.grid, rangeValue.grid),
      expr,
      linear,
      null,
      mergeOrigin(current, rangeValue, origin),
    )
    return withNumberCases(
      envelope,
      summaryRangeCases(current, rangeValue, expr, linear, origin),
    )
  }
  return numberValue(
    Math.max(current.min, rangeValue.min),
    Math.min(current.max, rangeValue.max),
    gridMeet(current.grid, rangeValue.grid),
    expr,
    linear,
    null,
    mergeOrigin(current, rangeValue, origin),
  )
}

function summaryRangeCases(
  current: NumberValue,
  rangeValue: NumberValue,
  expr: string | null,
  linear: LinearExpr | null,
  origin: string[],
) {
  const cases: NumberCase[] = []
  for (const currentBranch of numberBranches(current)) {
    for (const rangeBranch of numberBranches(rangeValue)) {
      const min = Math.max(currentBranch.value.min, rangeBranch.value.min)
      const max = Math.min(currentBranch.value.max, rangeBranch.value.max)
      if (min > max) continue
      const assumptions = mergeAssumptions(currentBranch.assumptions, rangeBranch.assumptions)
      if (!assumptionsAreReachable(assumptions)) continue
      cases.push({
        value: numberValue(
          min,
          max,
          gridMeet(currentBranch.value.grid, rangeBranch.value.grid),
          expr,
          linear,
          null,
          mergeOrigin(currentBranch.value, rangeBranch.value, origin),
        ),
        assumptions,
      })
    }
  }
  return cases
}

function applySummaryComparisonSpec(
  env: Map<string, Value>,
  spec: FitComparisonCheckSpec,
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
    const summaryConstraint = comparisonConstraint(left, spec.op, right, fact, 'contract')
    if (summaryConstraint == null) return
    applySummaryConstraintToPath(env, context, leftPath, summaryConstraint, fact, evaluators)
    applySummaryConstraintToPath(env, context, rightPath, summaryConstraint, fact, evaluators)
    return
  }
  if (leftPath != null && rightPath == null) {
    const right = evaluators.evaluateSpecExpression(spec.right, context)
    if (right.kind === 'number') applySummaryComparisonToPath(env, context, leftPath, spec.op, right, fact, evaluators)
    else if (right.kind === 'literal' && spec.op === '==') applySummaryLiteralEqualityToPath(env, leftPath, right, fact)
    return
  }
  if (rightPath != null && leftPath == null) {
    const left = evaluators.evaluateSpecExpression(spec.left, context)
    if (left.kind === 'number') applySummaryComparisonToPath(env, context, rightPath, flipComparison(spec.op), left, fact, evaluators)
    else if (left.kind === 'literal' && spec.op === '==') applySummaryLiteralEqualityToPath(env, rightPath, left, fact)
  }
}

function applySummaryLiteralEqualityToPath(
  env: Map<string, Value>,
  path: string,
  other: LiteralValue,
  fact: string,
) {
  const projected = literalValue(other.values, path, [...other.origin, fact])
  setSummaryPathValue(env, path, projected)
}

function applySummaryExpressionSpec(
  env: Map<string, Value>,
  spec: FitExpressionCheckSpec,
  source: FunctionContractSource,
) {
  const path = simpleResultPathText(spec.expression)
  if (path == null) return
  const parsed = fitExpressionParsed(spec.expression)
  if (parsed.domainPaths.size !== 0) return
  if (!ts.isIdentifier(parsed.expression)) return
  if (parsed.expression.text !== fitReturnInternalRoot) return
  setSummaryPathValue(env, path, literalValue([true], path, [checkedContractFact(source, spec.text)]))
}

function applySummaryConstraintToPath(
  env: Map<string, Value>,
  context: EvalContext,
  path: string,
  summaryConstraint: SummaryComparisonConstraint,
  fact: string,
  evaluators: CallContractEvaluators,
) {
  const current = evaluators.evaluateSpecExpression(path, context)
  if (current.kind !== 'number') return
  setSummaryPathValue(env, path, numberWithSummaryConstraint({...current, origin: mergeOrigin(current, [fact])}, summaryConstraint))
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
  const origin = mergeOrigin(current, other, [fact])
  const withSummaryFact = (value: NumberValue): NumberValue => {
    const summaryConstraint = comparisonConstraint(value, op, other, fact, 'contract')
    if (summaryConstraint == null) return value
    return numberWithSummaryConstraint(value, summaryConstraint)
  }

  switch (op) {
    case '==':
      setSummaryPathValue(env, path, withSummaryFact(numberValue(other.min, other.max, other.grid, other.expr, other.linear, other.cases, origin)))
      return
    case '>=':
    case '>':
      setSummaryPathValue(env, path, withSummaryFact(numberValue(Math.max(current.min, other.min), current.max, current.grid, current.expr, current.linear, current.cases, origin)))
      return
    case '<=':
    case '<':
      setSummaryPathValue(env, path, withSummaryFact(numberValue(current.min, Math.min(current.max, other.max), current.grid, current.expr, current.linear, current.cases, origin)))
      return
  }
}

function numberWithSummaryConstraint(value: NumberValue, summaryConstraint: SummaryComparisonConstraint): NumberValue {
  return withNumberCases(value, numberBranches(value).map(branch => ({
    value: branch.value,
    assumptions: mergeAssumptions(branch.assumptions, [summaryConstraint]),
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
    env.set(domainPath.root, setCheckedDomainPathValue(env.get(domainPath.root), domainPath.root, domainPath.segments, value))
    return
  }

  const expression = parseExpression(path)
  if (ts.isIdentifier(expression)) {
    env.set(expression.text, value)
    return
  }

  const finiteElement = finiteElementAccessRoot(expression)
  if (finiteElement != null) {
    env.set(finiteElement.root, setCheckedFiniteArrayElementValue(env.get(finiteElement.root), finiteElement.root, finiteElement.index, value))
  }
}
