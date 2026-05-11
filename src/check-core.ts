import * as ts from 'typescript'
import {
  loadFitProject,
  type FitFunction,
} from './modules.ts'
import {readTopLevelGlobal} from './module-values.ts'
export {readTopLevelGlobal} from './module-values.ts'
import {
  fitExpressionParsed,
  parseFitSpecs,
  parseInlineFitSpecsForExpression,
  parseLocalFitSpecs,
  hasFitComment,
  fitReturnInternalRoot,
  fitReturnPublicRoot,
  type FitCheckSpec,
  type FitExpressionLike,
  type FitRange,
  type FitSpec,
} from './parser.ts'
import {
  evaluateRangeBound as evaluateParsedRangeBound,
  evaluateSpecExpression as evaluateParsedSpecExpression,
  proveRangeSpec as proveParsedRangeSpec,
  verifyCheckSpecWithProof as verifyParsedCheckSpecWithProof,
  type CheckSpecHooks,
} from './check-specs.ts'
import {
  type EvalContext,
  type EvalFlow,
  type FitAudit,
  type FitCheck,
  type FitCheckStatus,
  type FitInferFunctionReport,
  type FitInferLoopReport,
  type FitInferLoopSpec,
  type FitInferReport,
  type FitInferSummary,
  type FitShapeInsight,
  type FitShapeOptions,
  type FitShapeReport,
  type FunctionContractProof,
  type Program,
  type ResolvedCallTarget,
} from './check-types.ts'
import {bindingElementPropertyName, forEachArrayBindingElement} from './binding-patterns.ts'
import {
  unknown,
  unknownNumber,
  valueWithDefaultedUndefined,
  type LinearConstraint,
  type Value,
} from './domain.ts'
import {mergeAssumptions} from './assumptions.ts'
import {proveComparison} from './proof.ts'
import {
  structuralShape,
  valueFromFunctionReturnShape,
  valueFromSyntaxTypeShape,
  valueWithStructuralFallback,
} from './shapes.ts'
import {
  factInventoryFromValue,
  factsFromEnvRoots,
  localFactsFromEnv,
  uniqueFacts,
} from './facts.ts'
import {
  inferFunctionSpecReports,
  redundantSpecs,
  topUnknownReason,
  uniqueUnsupported,
} from './infer-report.ts'
import {
  addInferFunctionToSummary,
  createInferSummary,
  finishInferSummary,
} from './infer-summary.ts'
import {
  callSiteBindingsFor,
  valueWithCallSiteText,
  type CallSiteBindings,
} from './call-site-text.ts'
import {
  importedContractFailureReason,
  importedContractUnavailableReason,
  valueWithFunctionContractSummary,
  verifyCallGivenSpecs,
} from './function-call-contracts.ts'
import {
  typeCheckContractForTypeNode,
  type TypeContractUnsupported,
} from './type-contracts.ts'
import {
  checkBoundaryForNode,
  lineNumberForNode,
  type CheckBoundary,
} from './source-boundary.ts'
import {programGlobalEnv} from './program-env.ts'
import {functionInputRoots} from './function-shape.ts'
import {
  emptyTypeContract,
  functionContractSpecs,
  functionHasBodyFitComment,
  functionHasBodyTypeBoundary,
  functionHasTypeContracts,
  functionTypeUnsupported,
  hasTypeContractWork,
  mergeTypeContracts,
  typeCheckContractForExpressionBoundary,
} from './function-contracts.ts'
import {
  arrayPatternElementValue,
  bindFunctionCallInputs,
  bindFunctionThisInput,
  bindPatternFromValue,
  parameterArgumentValue,
  unknownResultValue,
  valueWithBindingShapeFallback,
} from './function-inputs.ts'
import {
  functionEvalContext,
  prepareFunctionEvaluation,
} from './function-evaluation.ts'
import {
  applyGivenRangeSpec,
  collectGivenAssumptions,
  validateGivenSpecs,
} from './givens.ts'
import {
  evaluateDomainPathValue,
  parsePrintedNumber,
} from './domain-paths.ts'
import {
  inspectFunctionShapeInsights,
  type ShapeInspectState,
} from './shape-inspect.ts'
import {
  evaluateInterpreterExpression,
  evaluateInterpreterFunctionBody,
  evaluateInterpreterTopLevel,
} from './interpreter/evaluate.ts'
import {
  auditObligation,
  obligationForSpec,
  proofTraceForStatus,
  type FitObligationBoundary,
} from './obligations.ts'
import {proveObligation} from './proof-broker.ts'
import type {
  InterpreterAudit,
  InterpreterCall,
  InterpreterClaim,
  InterpreterFrame,
  InterpreterHooks,
  InterpreterLoopClaim,
} from './interpreter/context.ts'
import {formatInterpreterIssues} from './interpreter/format.ts'

export type {FitInferRedundantSpec, FitInferSpec, FitInferSpecStatus} from './infer-report.ts'
export type {
  FitCheck,
  FitAudit,
  FitCheckStatus,
  FitInferFunctionReport,
  FitInferLoopReport,
  FitInferLoopSpec,
  FitInferLoopSpecStatus,
  FitInferReport,
  FitShapeInsight,
  FitShapeOptions,
  FitShapeReport,
  FunctionContractProof,
} from './check-types.ts'

const maxInlineDepth = 12

function topLevelEvalContext(
  program: Program,
  contractCache: Map<string, FunctionContractProof>,
  callObligations: NonNullable<EvalContext['callObligations']> = 'silent',
): EvalContext {
  return {
    program,
    file: program.file,
    env: programGlobalEnv(program),
    inputRoots: [],
    stack: ['<top-level>'],
    checks: [],
    assumptions: [],
    contractCache,
    callObligations,
  }
}

export function inferFitFiles(paths: string[], options: {functionName?: string; all?: boolean} = {}): FitInferReport {
  const project = loadFitProject(paths, readTopLevelGlobal)
  const contractCache = new Map<string, FunctionContractProof>()
  const functions: FitInferFunctionReport[] = []
  for (const program of project.entries) {
    for (const [functionName, fn] of program.functions) {
      if (options.functionName != null && functionName !== options.functionName) continue
      if (options.functionName == null && options.all !== true && !program.fitFunctions.has(functionName) && !functionHasBodyFitComment(program, fn) && !functionHasTypeContracts(program, fn)) continue
      functions.push(inferFunctionFacts(program, fn, contractCache))
    }
  }
  return {files: paths, functions}
}

export function summarizeFitFiles(paths: string[]): FitInferSummary {
  const project = loadFitProject(paths, readTopLevelGlobal)
  const contractCache = new Map<string, FunctionContractProof>()
  const summary = createInferSummary(paths)
  for (const program of project.entries) {
    for (const fn of program.functions.values()) {
      addInferFunctionToSummary(summary, inferFunctionFacts(program, fn, contractCache))
    }
  }
  return finishInferSummary(summary)
}

export function inspectFitShapes(paths: string[], options: FitShapeOptions = {}): FitShapeReport {
  const project = loadFitProject(paths, readTopLevelGlobal)
  const contractCache = new Map<string, FunctionContractProof>()
  const insights: FitShapeInsight[] = []
  for (const program of project.entries) {
    for (const [functionName, fn] of program.functions) {
      if (options.functionName != null && functionName !== options.functionName) continue
      if (options.functionName == null && options.all !== true && !program.fitFunctions.has(functionName) && !functionHasBodyFitComment(program, fn) && !functionHasTypeContracts(program, fn)) continue
      const state = options.functionName != null || program.fitFunctions.has(functionName) || functionHasBodyFitComment(program, fn) || functionHasTypeContracts(program, fn)
        ? evaluateFunctionShapeState(program, fn, contractCache)
        : null
      insights.push(...inspectFunctionShapeInsights(program, fn, state, options))
    }
  }
  return {files: paths, insights}
}

export function createFunctionContractCache(): Map<string, FunctionContractProof> {
  return new Map<string, FunctionContractProof>()
}

export function verifyFitProgram(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const checks: FitCheck[] = []
  for (const fn of program.functions.values()) {
    const specs = program.specsByFunction.get(fn.name) ?? []
    if (specs.length === 0 && !functionHasBodyFitComment(program, fn) && !functionHasTypeContracts(program, fn)) continue
    checks.push(...verifyFunctionSpecs(program.file, program, fn, specs, contractCache))
  }
  checks.push(...verifyTopLevelInlineSpecs(program, contractCache))

  return checks
}

export function verifyFitProgramWithCallsites(
  program: Program,
  contractCache: Map<string, FunctionContractProof>,
): {annotationChecks: FitCheck[]; callsiteChecks: FitCheck[]} {
  const annotationChecks: FitCheck[] = []
  const rawCallsiteChecks: FitCheck[] = []
  const functionsWithRecordedCallsites = new Set<string>()

  for (const fn of program.functions.values()) {
    const specs = program.specsByFunction.get(fn.name) ?? []
    if (specs.length === 0 && !functionHasBodyFitComment(program, fn) && !functionHasTypeContracts(program, fn)) continue
    const result = verifyFunctionSpecsDetailed(program.file, program, fn, specs, contractCache)
    annotationChecks.push(...result.checks)
    if (result.recordedCallsites) {
      functionsWithRecordedCallsites.add(fn.name)
      rawCallsiteChecks.push(...result.callsiteChecks)
    }
  }
  annotationChecks.push(...verifyTopLevelInlineSpecs(program, contractCache))

  rawCallsiteChecks.push(...checkTopLevelCallsites(program, contractCache))
  for (const fn of program.functions.values()) {
    if (functionsWithRecordedCallsites.has(fn.name)) continue
    rawCallsiteChecks.push(...checkFunctionCallsites(program, fn, contractCache))
  }

  return {
    annotationChecks,
    callsiteChecks: dedupeCallsiteChecks(rawCallsiteChecks.map(toCallsiteCheck)),
  }
}

export function checkCallsitesInProgram(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const checks: FitCheck[] = []
  checks.push(...checkTopLevelCallsites(program, contractCache))
  for (const fn of program.functions.values()) checks.push(...checkFunctionCallsites(program, fn, contractCache))
  return dedupeCallsiteChecks(checks.map(toCallsiteCheck))
}

export function auditSelectorsInProgram(
  program: Program,
  contractCache: Map<string, FunctionContractProof>,
  options: {annotationsOnly?: boolean} = {},
): FitAudit[] {
  const audits: FitAudit[] = []
  if (options.annotationsOnly !== true) audits.push(...auditTopLevelSelectors(program, contractCache))
  for (const fn of program.functions.values()) {
    if (options.annotationsOnly === true && !functionHasAuditAnnotationSurface(program, fn)) continue
    audits.push(...auditFunctionSelectors(program, fn, contractCache))
  }
  return dedupeAudits(audits)
}

function functionHasAuditAnnotationSurface(program: Program, fn: FitFunction) {
  return program.fitFunctions.has(fn.name)
    || functionHasBodyFitComment(program, fn)
    || functionHasTypeContracts(program, fn)
}

function auditTopLevelSelectors(program: Program, contractCache: Map<string, FunctionContractProof>): FitAudit[] {
  const context = topLevelEvalContext(program, contractCache)
  const result = evaluateInterpreterTopLevel(program, context.env, context.stack, context.assumptions, interpreterHooks(context))
  return result.audits.map(audit => interpreterAuditToFitAudit(program.file, audit))
}

function auditFunctionSelectors(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FitAudit[] {
  const specs = program.specsByFunction.get(fn.name) ?? []
  const setup = prepareFunctionEvaluation(program, fn, specs, contractCache, givenEvaluators)
  const context = functionEvalContext(program, fn, setup, contractCache, {callObligations: 'silent'})
  const result = evaluateInterpreterFunctionBody(program, fn, context.env, context.stack, context.assumptions, interpreterHooks(context))
  return result.audits.map(audit => interpreterAuditToFitAudit(program.file, audit))
}

function interpreterAuditToFitAudit(file: string, audit: InterpreterAudit): FitAudit {
  const functionName = audit.stack.length === 0 ? '<top-level>' : audit.stack.join(' > ')
  const obligation = auditObligation({
    file,
    functionName,
    ...(audit.line == null ? {} : {line: audit.line}),
    text: audit.text,
  })
  return {
    file,
    ...(audit.line == null ? {} : {line: audit.line}),
    functionName,
    text: audit.text,
    reason: audit.reason,
    obligation,
    trace: proofTraceForStatus(obligation, 'pass', [{
      domain: 'audit',
      rule: 'selector-redundancy',
      message: 'checked redundant selector claim',
    }], [audit.reason]),
  }
}

function dedupeAudits(audits: FitAudit[]) {
  const seen = new Set<string>()
  const result: FitAudit[] = []
  for (const audit of audits) {
    const key = `${audit.file}\0${audit.line ?? ''}\0${audit.functionName}\0${audit.text}\0${audit.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(audit)
  }
  return result
}

function checkTopLevelCallsites(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const context = topLevelEvalContext(program, contractCache, 'record')
  evaluateInterpreterTopLevel(program, context.env, context.stack, context.assumptions, interpreterHooks(context))
  return callChecks(context)
}

function checkFunctionCallsites(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const functionName = fn.name
  const specs = program.specsByFunction.get(functionName) ?? []
  const setup = prepareFunctionEvaluation(program, fn, specs, contractCache, givenEvaluators)
  const context = functionEvalContext(program, fn, setup, contractCache, {callObligations: 'record'})
  evaluateFunctionBody(fn, context)
  return callChecks(context)
}

function isCallCheck(check: FitCheck) {
  return check.detail?.kind === 'call-precondition'
}

function callChecks(context: EvalContext) {
  return context.checks.filter(isCallCheck)
}

function toCallsiteCheck(check: FitCheck): FitCheck {
  const status = check.status === 'pass' ? 'pass'
    : check.status === 'unknown' ? 'unknown'
      : isDefiniteCallFailure(check) ? 'fail' : 'requires'
  return {
    file: check.file,
    ...(check.line == null ? {} : {line: check.line}),
    functionName: check.functionName,
    text: check.text,
    status,
    ...(check.reason == null ? {} : {reason: check.reason}),
    ...(check.detail == null ? {} : {detail: check.detail}),
  }
}

function isDefiniteCallFailure(check: FitCheck) {
  return check.detail?.kind === 'call-precondition' && check.detail.definiteFailure
}

function dedupeCallsiteChecks(checks: FitCheck[]) {
  const seen = new Set<string>()
  const result: FitCheck[] = []
  for (const check of checks) {
    const key = `${check.file}\0${check.functionName}\0${check.text}\0${check.status}\0${check.reason ?? ''}\0${JSON.stringify(check.detail ?? null)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(check)
  }
  return result
}

function verifyTopLevelInlineSpecs(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const context = topLevelEvalContext(program, contractCache)
  for (const statement of program.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    bindVariableStatement(statement, context)
  }
  return context.checks
}

function verifyFunctionSpecs(
  file: string,
  program: Program,
  fn: FitFunction,
  specs: FitSpec[],
  contractCache: Map<string, FunctionContractProof>,
): FitCheck[] {
  return verifyFunctionSpecsDetailed(file, program, fn, specs, contractCache).checks
}

function verifyFunctionSpecsDetailed(
  file: string,
  program: Program,
  fn: FitFunction,
  specs: FitSpec[],
  contractCache: Map<string, FunctionContractProof>,
): {checks: FitCheck[]; callsiteChecks: FitCheck[]; recordedCallsites: boolean} {
  const functionName = fn.name
  const setup = prepareFunctionEvaluation(program, fn, specs, contractCache, givenEvaluators)
  const {contractSpecs, env} = setup
  const checks = [...setup.givenChecks]
  checks.push(...typeUnsupportedChecks(file, functionName, functionTypeUnsupported(program, fn)))

  checks.push(...setup.assumptionChecks)
  const recordsCallsites = functionHasBodyClaims(contractSpecs)
  const hasBodyClaims = recordsCallsites || functionHasBodyFitComment(program, fn) || functionHasBodyTypeBoundary(program, fn)
  const context = functionEvalContext(program, fn, setup, contractCache, {
    callObligations: recordsCallsites ? 'record' : 'silent',
  })
  const result = hasBodyClaims ? evaluateFunctionBody(fn, context) : unknown('No body claim requested')
  if (hasBodyClaims) checks.push(...context.checks)

  for (const spec of contractSpecs) {
    if (spec.kind === 'given-range' || spec.kind === 'given-comparison') continue
    checks.push(verifyCheckSpec(file, program, functionName, env, result, spec, checks, context.assumptions, contractCache))
  }

  return {
    checks,
    callsiteChecks: recordsCallsites ? callChecks(context) : [],
    recordedCallsites: hasBodyClaims && recordsCallsites,
  }
}

function functionHasBodyClaims(specs: FitSpec[]) {
  return specs.some(spec => spec.kind !== 'given-range' && spec.kind !== 'given-comparison')
}

function inferFunctionFacts(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FitInferFunctionReport {
  const functionName = fn.name
  const specs = program.specsByFunction.get(functionName) ?? []
  const loops: FitInferLoopReport[] = []
  const setup = prepareFunctionEvaluation(program, fn, specs, contractCache, givenEvaluators)
  const {contractSpecs, env} = setup
  const typeContractChecks = typeUnsupportedChecks(program.file, functionName, functionTypeUnsupported(program, fn))
  const inferUnsupported: string[] = []
  const context = functionEvalContext(program, fn, setup, contractCache, {inferLoops: loops, inferUnsupported})
  const state = evaluateFunctionBodyState(fn, context)
  const resultFacts = factInventoryFromValue(fitReturnInternalRoot, state.result).inferFacts()
  const localFacts = localFactsFromEnv(env, state.env)
  const backgroundChecks = [
    ...setup.givenChecks,
    ...typeContractChecks,
    ...setup.assumptionChecks,
    ...context.checks,
  ]
  const specReports = inferFunctionSpecReports(contractSpecs, backgroundChecks, spec => verifyCheckSpec(
    program.file,
    program,
    functionName,
    env,
    state.result,
    spec,
    [...backgroundChecks],
    state.assumptions,
    contractCache,
  ))
  const unsupported = [
    ...setup.givenChecks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
    ...typeContractChecks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
    ...setup.assumptionChecks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
    ...context.checks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
    ...inferUnsupported,
    ...topUnknownReason(state.result),
  ]
  return {
    file: program.file,
    functionName,
    facts: uniqueFacts(resultFacts),
    locals: uniqueFacts(localFacts),
    specs: specReports,
    redundant: redundantSpecs(specReports, resultFacts),
    loops,
    unsupported: uniqueUnsupported(unsupported),
  }
}

function evaluateFunctionShapeState(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): ShapeInspectState {
  const specs = program.specsByFunction.get(fn.name) ?? []
  const setup = prepareFunctionEvaluation(program, fn, specs, contractCache, givenEvaluators)
  const context = functionEvalContext(program, fn, setup, contractCache)
  const env = setup.env
  const baseEnv = new Map(env)
  const state = evaluateFunctionBodyState(fn, context)
  return {baseEnv, env: state.env, result: state.result}
}

function typeUnsupportedChecks(file: string, functionName: string, unsupported: TypeContractUnsupported[], boundary?: CheckBoundary): FitCheck[] {
  return unsupported.map(problem => ({
    file,
    functionName,
    ...boundary,
    text: problem.text,
    status: 'unknown',
    reason: problem.reason,
    ...(problem.line == null ? {} : {line: problem.line}),
  }))
}

function pushTypeUnsupportedChecks(context: EvalContext, unsupported: TypeContractUnsupported[], boundary?: CheckBoundary) {
  context.checks.push(...typeUnsupportedChecks(context.file, context.stack.join(' > '), unsupported, boundary))
}

const checkSpecHooks: CheckSpecHooks = {
  evaluateExpression: (expression, context) => evaluateCheckedExpression(expression, context),
  evaluateDomainPath: (domainPath, context) => evaluateDomainPathValue(domainPath, context.env),
  parsePrintedNumber,
}

function evaluateCheckedExpression(expression: ts.Expression, context: EvalContext): Value {
  const originalEnv = context.env
  const result = evaluateInterpreterExpression(
    context.program,
    expression,
    context.env,
    context.stack,
    context.assumptions,
    interpreterHooks(context),
    context.objectPath,
  )
  replaceEnvEntries(originalEnv, result.env)
  context.env = originalEnv
  context.assumptions = result.assumptions
  return result.value
}

function evaluateInterpreterExpressionWithObjectPath(expression: ts.Expression, context: EvalContext, objectPath: string[]): Value {
  const previous = context.objectPath
  context.objectPath = objectPath
  try {
    return evaluateCheckedExpression(expression, context)
  } finally {
    if (previous == null) delete context.objectPath
    else context.objectPath = previous
  }
}

function replaceEnvEntries(target: Map<string, Value>, source: Map<string, Value>) {
  target.clear()
  for (const [name, value] of source) target.set(name, value)
}

function verifyCheckSpec(
  file: string,
  program: Program,
  functionName: string,
  baseEnv: Map<string, Value>,
  result: Value,
  spec: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'} | {kind: 'check-atom'}>,
  checks: FitCheck[],
  assumptions: LinearConstraint[],
  contractCache: Map<string, FunctionContractProof>,
  boundary?: CheckBoundary,
  obligationBoundary: FitObligationBoundary = 'function-contract',
): FitCheck {
  const obligation = obligationForSpec(file, functionName, spec, obligationBoundary, boundary)
  const proof = verifyParsedCheckSpecWithProof(file, program, functionName, baseEnv, result, spec, checks, assumptions, contractCache, checkSpecHooks)
  const check = boundary == null ? proof.check : {...proof.check, ...boundary}
  return proveObligation({
    obligation,
    step: proof.step,
    usedFacts: proof.usedFacts,
    prove: () => check,
  })
}

function proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  return proveParsedRangeSpec(value, range, context, checkSpecHooks)
}

function evaluateRangeBound(text: FitExpressionLike, context: EvalContext): Value {
  return evaluateParsedRangeBound(text, context, checkSpecHooks)
}

function evaluateSpecExpression(text: FitExpressionLike, context: EvalContext): Value {
  return evaluateParsedSpecExpression(text, context, checkSpecHooks)
}

const givenEvaluators = {
  evaluateRangeBound,
  evaluateSpecExpression,
}

const callContractEvaluators = {
  evaluateSpecExpression,
  proveRangeSpec,
}

function evaluateFunctionBody(fn: FitFunction, context: EvalContext): Value {
  return evaluateFunctionBodyState(fn, context).result
}

function evaluateFunctionBodyState(fn: FitFunction, context: EvalContext): {result: Value; env: Map<string, Value>; assumptions: LinearConstraint[]} {
  const hooks = interpreterHooks(context)
  const result = evaluateInterpreterFunctionBody(context.program, fn, context.env, context.stack, context.assumptions, hooks)
  context.assumptions = result.assumptions
  if (context.inferUnsupported != null) {
    context.inferUnsupported.push(...formatInterpreterIssues(result.issues))
  }
  return {result: result.value, env: result.env, assumptions: result.assumptions}
}

function interpreterHooks(context: EvalContext): InterpreterHooks {
  return {
    evaluateCall: (call, frame) => evaluateInterpreterCall(call, frame, context),
    evaluateClaim: (claim, frame, evaluate) => evaluateInterpreterClaim(claim, frame, context, evaluate),
    afterClaim: (claim, value, frame) => afterInterpreterClaim(claim, value, frame, context),
    evaluateLoop: (claim, frame, evaluate) => evaluateInterpreterLoop(claim, frame, context, evaluate),
  }
}

function evaluateInterpreterCall(call: InterpreterCall, frame: InterpreterFrame, rootContext: EvalContext): Value | null {
  if (rootContext.callObligations == null) return null
  const callContext = contextForInterpreterFrame(frame, rootContext, {
    checks: shouldRecordCallObligations(rootContext) ? rootContext.checks : [],
    includeObjectPath: false,
  })
  const callArgumentExpressions = ts.isCallExpression(call.expression) ? call.expression.arguments : ts.factory.createNodeArray<ts.Expression>([])
  const callArguments = evaluateFunctionCallArguments(call.fn, callArgumentExpressions, callContext, call.program, call.thisValue)
  if (callArguments.kind === 'invalid') return call.fallback ?? unknown(callArguments.reason)

  const callText = call.expression.getText(frame.program.sourceFile)
  const callLine = lineNumberForNode(frame.program.sourceFile, call.expression)
  const receiverText = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression.getText(frame.program.sourceFile) : undefined
  const callSiteBindings = callSiteBindingsFor(call.fn, callArgumentExpressions, frame.program.sourceFile, receiverText, callArguments.values, callArguments.texts)
  if (call.program === frame.program) {
    return evaluateLocalFunctionCall(call.functionName, call.fn, callArguments.values, callContext, {
      callText,
      callLine,
      fallback: call.fallback,
      thisValue: call.thisValue,
      callSiteBindings,
    })
  }
  if (call.imported == null) return null
  return evaluateImportedFunctionCall(call.callName, {
    kind: 'function',
    module: call.program,
    functionName: call.functionName,
    imported: call.imported,
  }, call.fn, callArguments.values, callText, callLine, callContext, call.fallback, callSiteBindings, call.thisValue)
}

function evaluateInterpreterClaim(claim: InterpreterClaim, frame: InterpreterFrame, rootContext: EvalContext, evaluate: () => Value): Value {
  if (!shouldRecordInterpreterClaim(frame, rootContext)) return evaluate()
  return withCallObligationRecordingWhen(rootContext, interpreterClaimRecordsCalls(claim, frame, rootContext), evaluate)
}

function afterInterpreterClaim(claim: InterpreterClaim, value: Value, frame: InterpreterFrame, rootContext: EvalContext) {
  if (!shouldRecordInterpreterClaim(frame, rootContext)) return
  const context = interpreterEvalContext(frame, rootContext)

  if (claim.kind === 'variable') {
    const localSpecs = ts.isVariableStatement(claim.statement) ? parseLocalFitSpecs(frame.program.sourceText, claim.statement) : []
    verifyLocalFitSpecs(localSpecs, context)
    if (!ts.isIdentifier(claim.declaration.name)) return
    const typeContract = mergeTypeContracts([
      typeCheckContractForTypeNode(frame.program, claim.declaration.type, claim.declaration.name.text),
      claim.declaration.initializer == null
        ? emptyTypeContract<FitCheckSpec>()
        : typeCheckContractForExpressionBoundary(frame.program, claim.declaration.initializer, claim.declaration.name.text),
    ])
    const boundary = checkBoundaryForNode(frame.program.sourceFile, claim.declaration)
    pushTypeUnsupportedChecks(context, typeContract.unsupported, boundary)
    verifyCheckSpecsWithResult(typeContract.specs, unknown('Inline @fit checks do not use return'), context, boundary, 'type-boundary')
    return
  }

  if (claim.kind === 'return') {
    const specs = parseInlineFitSpecsForExpression(frame.program.sourceText, claim.node, fitReturnPublicRoot)
    const typeContract = typeCheckContractForExpressionBoundary(frame.program, claim.expression, fitReturnPublicRoot)
    verifyInlineSpecsForValue(specs, value, context)
    const boundary = checkBoundaryForNode(frame.program.sourceFile, claim.node)
    pushTypeUnsupportedChecks(context, typeContract.unsupported, boundary)
    verifyCheckSpecsWithResult(typeContract.specs, value, context, boundary, 'type-boundary')
    return
  }

  const specs = parseInlineFitSpecsForExpression(frame.program.sourceText, claim.property, objectPathText(claim.path))
  verifyInlineSpecsForValue(specs, value, context)
}

function evaluateInterpreterLoop(
  claim: InterpreterLoopClaim,
  frame: InterpreterFrame,
  rootContext: EvalContext,
  evaluate: () => EvalFlow,
): EvalFlow {
  if (!shouldRecordInterpreterClaim(frame, rootContext)) return evaluate()
  const context = interpreterEvalContext(frame, rootContext)
  const checksStart = rootContext.checks.length
  const rawLocalSpecs = parseFitSpecs(frame.program.sourceText, claim.statement)
  const {validSpecs: localSpecs, resultSpecs} = splitLoopSpecs(rawLocalSpecs)
  reportLoopResultSpecs(resultSpecs, context)
  applyLocalGivenSpecs(localSpecs, context)
  frame.assumptions = context.assumptions
  const flow = withCallObligationRecordingWhen(rootContext, functionHasBodyClaims(localSpecs), evaluate)
  context.assumptions = frame.assumptions
  verifyLocalLoopSpecs(localSpecs, context)
  recordInferLoop(claim.statement, claim.kind, rawLocalSpecs, context, checksStart, claim.factRoots)
  frame.assumptions = context.assumptions
  return flow
}

function interpreterClaimRecordsCalls(claim: InterpreterClaim, frame: InterpreterFrame, rootContext: EvalContext) {
  if (rootContext.callObligations === 'record') return true
  if (claim.kind === 'variable') {
    if (parseLocalFitSpecs(frame.program.sourceText, claim.statement).length > 0) return true
    if (!ts.isIdentifier(claim.declaration.name)) return false
    return hasTypeContractWork(mergeTypeContracts([
      typeCheckContractForTypeNode(frame.program, claim.declaration.type, claim.declaration.name.text),
      claim.declaration.initializer == null
        ? emptyTypeContract<FitCheckSpec>()
        : typeCheckContractForExpressionBoundary(frame.program, claim.declaration.initializer, claim.declaration.name.text),
    ]))
  }
  if (claim.kind === 'return') {
    return parseInlineFitSpecsForExpression(frame.program.sourceText, claim.node, fitReturnPublicRoot).length > 0
      || hasTypeContractWork(typeCheckContractForExpressionBoundary(frame.program, claim.expression, fitReturnPublicRoot))
  }
  return parseInlineFitSpecsForExpression(frame.program.sourceText, claim.property, objectPathText(claim.path)).length > 0
}

function shouldRecordInterpreterClaim(frame: InterpreterFrame, rootContext: EvalContext) {
  return sameClaimBodyStack(frame.stack, rootContext.stack) || shouldRecordCallObligations(rootContext)
}

function sameStack(left: string[], right: string[]) {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function sameClaimBodyStack(left: string[], right: string[]) {
  return sameStack(left.filter(part => !isBranchStackPart(part)), right)
}

function isBranchStackPart(part: string) {
  return part === '<if-true>'
    || part === '<if-false>'
    || part === '<conditional-true>'
    || part === '<conditional-false>'
    || part === '<indexed-if-true>'
    || part === '<indexed-if-false>'
}

function interpreterEvalContext(frame: InterpreterFrame, rootContext: EvalContext): EvalContext {
  return contextForInterpreterFrame(frame, rootContext, {
    stack: sameClaimBodyStack(frame.stack, rootContext.stack) ? rootContext.stack : frame.stack,
  })
}

function contextForInterpreterFrame(
  frame: InterpreterFrame,
  rootContext: EvalContext,
  options: {stack?: string[]; checks?: FitCheck[]; includeObjectPath?: boolean} = {},
): EvalContext {
  const context: EvalContext = {
    ...rootContext,
    program: frame.program,
    file: frame.program.file,
    env: frame.env,
    stack: options.stack ?? frame.stack,
    checks: options.checks ?? rootContext.checks,
    assumptions: frame.assumptions,
  }
  if (options.includeObjectPath !== false && frame.objectPath != null) context.objectPath = frame.objectPath
  return context
}

function bindVariableDeclaration(declaration: ts.VariableDeclaration, context: EvalContext, options: {claim?: boolean} = {}) {
  if (declaration.initializer == null) {
    bindUninitializedName(declaration.name, context)
    return
  }
  const typeContract = ts.isIdentifier(declaration.name)
    ? mergeTypeContracts([
      typeCheckContractForTypeNode(context.program, declaration.type, declaration.name.text),
      typeCheckContractForExpressionBoundary(context.program, declaration.initializer, declaration.name.text),
    ])
    : emptyTypeContract<FitCheckSpec>()
  const typeSpecs = typeContract.specs
  const evaluate = () => ts.isIdentifier(declaration.name)
    ? evaluateInterpreterExpressionWithObjectPath(declaration.initializer!, context, [declaration.name.text])
    : evaluateCheckedExpression(declaration.initializer!, context)
  const value = options.claim === true || hasTypeContractWork(typeContract) ? withCallObligationRecording(context, evaluate) : evaluate()
  bindName(declaration.name, valueWithBindingShapeFallback(declaration.name, value, context.program), context)
  const boundary = checkBoundaryForNode(context.program.sourceFile, declaration)
  pushTypeUnsupportedChecks(context, typeContract.unsupported, boundary)
  verifyCheckSpecsWithResult(typeSpecs, unknown('Inline @fit checks do not use return'), context, boundary, 'type-boundary')
}

function bindVariableStatement(statement: ts.VariableStatement, context: EvalContext) {
  const specs = parseLocalFitSpecs(context.program.sourceText, statement)
  for (const declaration of statement.declarationList.declarations) {
    bindVariableDeclaration(declaration, context, {claim: specs.length > 0})
  }
  verifyLocalFitSpecs(specs, context)
}

function verifyLocalFitSpecs(specs: FitCheckSpec[], context: EvalContext) {
  verifyCheckSpecsWithResult(specs, unknown('Inline @fit checks do not use return'), context)
}

function verifyCheckSpecsWithResult(
  specs: FitCheckSpec[],
  result: Value,
  context: EvalContext,
  boundary?: CheckBoundary,
  obligationBoundary: FitObligationBoundary = 'inline-check',
) {
  if (specs.length === 0) return
  for (const spec of specs) {
    context.checks.push(verifyCheckSpec(
      context.file,
      context.program,
      context.stack.join(' > '),
      context.env,
      result,
      spec,
      [...context.checks],
      context.assumptions,
      context.contractCache,
      boundary,
      obligationBoundary,
    ))
  }
}

function bindUninitializedName(name: ts.BindingName, context: EvalContext) {
  if (ts.isIdentifier(name)) context.env.set(name.text, unknown(`Uninitialized local ${name.text}`))
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) bindUninitializedName(element.name, context)
  }
  if (ts.isArrayBindingPattern(name)) {
    forEachArrayBindingElement(name, elementName => bindUninitializedName(elementName, context))
  }
}

function bindName(name: ts.BindingName, value: Value, context: EvalContext) {
  if (ts.isIdentifier(name)) {
    context.env.set(name.text, value)
    return
  }
  if (ts.isObjectBindingPattern(name)) bindObjectPattern(name, value, context)
  if (ts.isArrayBindingPattern(name)) bindArrayPattern(name, value, context)
}

function bindObjectPattern(pattern: ts.ObjectBindingPattern, value: Value, context: EvalContext) {
  for (const element of pattern.elements) {
    if (element.dotDotDotToken != null) continue
    const propertyName = bindingElementPropertyName(element)
    if (propertyName == null) {
      bindUninitializedName(element.name, context)
      continue
    }
    const prop = value.kind === 'object'
      ? value.props.get(propertyName) ?? (value.expr == null ? unknown(`Unknown property ${propertyName}`) : unknownNumber(`${value.expr}.${propertyName}`))
      : unknown(`Destructuring property ${propertyName} expected an object`)
    bindName(element.name, prop, context)
  }
}

function bindArrayPattern(pattern: ts.ArrayBindingPattern, value: Value, context: EvalContext) {
  forEachArrayBindingElement(pattern, (elementName, index, isRest) => {
    if (isRest) {
      bindUninitializedName(elementName, context)
      return
    }
    bindName(elementName, arrayPatternElementValue(value, index), context)
  })
}

function recordInferLoop(
  statement: ts.ForOfStatement | ts.ForStatement,
  kind: FitInferLoopReport['kind'],
  specs: FitSpec[],
  context: EvalContext,
  checksStart: number,
  factRoots: Set<string>,
) {
  if (context.inferLoops == null) return
  if (!hasFitComment(context.program.sourceText, statement)) return

  const checks = context.checks.slice(checksStart)
  const specReports = inferLoopSpecReports(specs, checks)
  const facts = factsFromEnvRoots(context.env, factRoots)
  context.inferLoops.push({
    line: context.program.sourceFile.getLineAndCharacterOfPosition(statement.getStart(context.program.sourceFile)).line + 1,
    kind,
    header: loopHeaderText(statement, context.program.sourceFile),
    facts,
    specs: specReports,
    redundant: redundantSpecs(specReports, facts),
    unsupported: checks
      .filter(check => check.status !== 'pass' && !specs.some(spec => spec.text === check.text))
      .map(check => `${check.text}: ${check.reason ?? check.status}`),
  })
}

function inferLoopSpecReports(specs: FitSpec[], checks: FitCheck[]): FitInferLoopSpec[] {
  const checkByText = new Map<string, FitCheck>()
  for (const check of checks) {
    if (!checkByText.has(check.text)) checkByText.set(check.text, check)
  }

  return specs.map(spec => {
    const check = checkByText.get(spec.text)
    if (spec.kind === 'given-range' || spec.kind === 'given-comparison') {
      if (check == null || check.status === 'pass') return {text: spec.text, status: 'assumed'}
      return {text: spec.text, status: 'not-inferred', reason: check.reason ?? check.status}
    }
    if (check?.status === 'pass') return {text: spec.text, status: 'checked'}
    return {text: spec.text, status: 'not-inferred', reason: check?.reason ?? check?.status ?? 'not checked'}
  })
}

function loopHeaderText(statement: ts.ForOfStatement | ts.ForStatement | ts.WhileStatement | ts.DoStatement, sourceFile: ts.SourceFile) {
  const text = statement.getText(sourceFile)
  const bodyStart = text.indexOf('{')
  const header = bodyStart === -1 ? text : text.slice(0, bodyStart)
  return header.replace(/\s+/g, ' ').trim()
}

function splitLoopSpecs(specs: FitSpec[]): {validSpecs: FitSpec[]; resultSpecs: FitSpec[]} {
  const validSpecs: FitSpec[] = []
  const resultSpecs: FitSpec[] = []
  for (const spec of specs) {
    if (specMentionsRoot(spec, fitReturnInternalRoot)) resultSpecs.push(spec)
    else validSpecs.push(spec)
  }
  return {validSpecs, resultSpecs}
}

function reportLoopResultSpecs(specs: FitSpec[], context: EvalContext) {
  if (specs.length === 0) return
  const functionName = `${context.stack.at(-1) ?? '<unknown>'} > loop`
  for (const spec of specs) {
    context.checks.push({
      file: context.file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: 'unknown',
      reason: 'loop @fit specs do not have return; name local values directly',
    })
  }
}

function specMentionsRoot(spec: FitSpec, root: string) {
  return specExpressionTexts(spec).some(text => expressionTextMentionsRoot(text, root))
}

function specExpressionTexts(spec: FitSpec): FitExpressionLike[] {
  switch (spec.kind) {
    case 'given-range':
    case 'check-range':
      return [spec.expression]
    case 'given-comparison':
    case 'check-comparison':
      return [spec.left, spec.right]
    case 'check-atom':
      return [spec.name, ...spec.args]
  }
}

function expressionTextMentionsRoot(text: FitExpressionLike, root: string) {
  const parsed = fitExpressionParsed(text)
  if ([...parsed.domainPaths.values()].some(domainPath => domainPath.root === root)) return true
  return expressionMentionsIdentifier(parsed.expression, root)
}

function expressionMentionsIdentifier(expression: ts.Expression, name: string): boolean {
  if (ts.isIdentifier(expression) && expression.text === name) return true
  for (const child of expression.getChildren()) {
    if (ts.isExpression(child) && expressionMentionsIdentifier(child, name)) return true
  }
  return false
}

function applyLocalGivenSpecs(specs: FitSpec[], context: EvalContext) {
  const functionName = `${context.stack.at(-1) ?? '<unknown>'} > loop`
  const {assumedGivens, checks} = validateGivenSpecs(context.file, functionName, specs, context.inputRoots, 'loop-given')
  context.checks.push(...checks)

  for (const given of assumedGivens) {
    if (given.kind !== 'range') continue
    applyGivenRangeSpec(context.env, given.spec)
  }
  const {assumptions, checks: impossibleChecks} = collectGivenAssumptions(
    context.file,
    context.program,
    functionName,
    context.env,
    context.inputRoots,
    assumedGivens,
    context.contractCache,
    givenEvaluators,
  )
  context.checks.push(...impossibleChecks)
  context.assumptions = mergeAssumptions(context.assumptions, assumptions)
}

function verifyLocalLoopSpecs(specs: FitSpec[], context: EvalContext) {
  if (specs.length === 0) return
  const functionName = `${context.stack.at(-1) ?? '<unknown>'} > loop`
  const loopResult = unknown('Loop annotations do not have return; name local values directly')
  for (const spec of specs) {
    if (spec.kind === 'given-range' || spec.kind === 'given-comparison') continue
    context.checks.push(verifyCheckSpec(
      context.file,
      context.program,
      functionName,
      context.env,
      loopResult,
      spec,
      context.checks,
      context.assumptions,
      context.contractCache,
      undefined,
      'loop-contract',
    ))
  }
}

function evaluateLocalFunctionCall(
  functionName: string,
  fn: FitFunction,
  argumentValues: Value[],
  context: EvalContext,
  options: {
    callText: string
    callLine?: number | undefined
    fallback: Value | null
    thisValue?: Value | undefined
    callSiteBindings?: CallSiteBindings | undefined
  },
): Value {
  if (context.stack.length >= maxInlineDepth) return unknown(`Inline depth exceeded at ${functionName}`)
  if (fn.node.parameters.length !== argumentValues.length) return unknown(`Call arity mismatch for ${functionName}`)
  const obligations = verifyCallGivenSpecs(context.program, fn, options.callText, argumentValues, context, {
    record: shouldRecordCallObligations(context),
    callLine: options.callLine,
    thisValue: options.thisValue,
    callSiteBindings: options.callSiteBindings,
  }, callContractEvaluators)

  const env = programGlobalEnv(context.program)
  bindFunctionCallInputs(fn, argumentValues, env, context.program, options.thisValue)

  const result = evaluateFunctionBody(fn, {
    program: context.program,
    file: context.file,
    env,
    inputRoots: functionInputRoots(context.program, fn),
    stack: [...context.stack, functionName],
    checks: shouldRecordCallObligations(context) ? context.checks : [],
    assumptions: context.assumptions,
    contractCache: context.contractCache,
    ...(context.callObligations == null ? {} : {callObligations: context.callObligations}),
  })
  const fallbackShape = valueFromFunctionReturnShape(`${functionName}Result`, fn.node, context.program)
    ?? valueFromSyntaxTypeShape(`${functionName}Result`, fn.node.type, context.program, new Set())
    ?? options.fallback
  const fallbackResult = result.kind === 'unknown'
    ? fallbackShape ?? result
    : valueWithStructuralFallback(result, fallbackShape)
  const callSiteFallbackResult = valueWithCallSiteText(fallbackResult, options.callSiteBindings)
  const specs = context.program.specsByFunction.get(functionName) ?? []
  const contractSpecs = functionContractSpecs(context.program, fn, specs)
  if (contractSpecs.length === 0) return callSiteFallbackResult
  if (obligations !== 'pass') return callSiteFallbackResult

  const proof = verifyFunctionContract(context.program, functionName, context.contractCache)
  if (proof.status !== 'pass') return callSiteFallbackResult

  return valueWithFunctionContractSummary(functionName, context.program, fn, contractSpecs, argumentValues, context.contractCache, {
    kind: 'local',
    sourceFile: context.program.file,
    sourceFunctionName: functionName,
  }, fallbackResult, options.thisValue, options.callSiteBindings, callContractEvaluators)
}

type FunctionCallArguments =
  | {kind: 'valid'; values: Value[]; texts: string[]; env: Map<string, Value>}
  | {kind: 'invalid'; reason: string}

function evaluateFunctionCallArguments(
  fn: FitFunction,
  args: ts.NodeArray<ts.Expression>,
  callerContext: EvalContext,
  calleeProgram: Program,
  thisValue?: Value,
  baseEnv?: Map<string, Value>,
): FunctionCallArguments {
  if (args.length > fn.node.parameters.length) return {kind: 'invalid', reason: `Call arity mismatch for ${fn.name}`}

  const env = new Map(baseEnv ?? programGlobalEnv(calleeProgram))
  bindFunctionThisInput(fn, env, thisValue)

  const values: Value[] = []
  const texts: string[] = []
  for (let index = 0; index < fn.node.parameters.length; index++) {
    const param = fn.node.parameters[index]!
    const argument = args[index]
    if (argument == null && param.initializer == null) return {kind: 'invalid', reason: `Call arity mismatch for ${fn.name}`}
    const value = argument == null
      ? evaluateDefaultArgument(param, fn, env, callerContext, calleeProgram)
      : evaluateCallArgumentExpression(argument, callerContext)
    const defaultedValue = argument == null || param.initializer == null
      ? value
      : valueWithDefaultedUndefined(value, evaluateDefaultArgument(param, fn, env, callerContext, calleeProgram))
    values.push(defaultedValue)
    texts.push(argument == null ? param.initializer!.getText(calleeProgram.sourceFile) : argument.getText(callerContext.program.sourceFile))
    bindPatternFromValue(param.name, parameterArgumentValue(param, defaultedValue, calleeProgram), env, {preserveLinear: true})
  }

  return {kind: 'valid', values, texts, env}
}

function evaluateDefaultArgument(
  param: ts.ParameterDeclaration,
  fn: FitFunction,
  env: Map<string, Value>,
  callerContext: EvalContext,
  calleeProgram: Program,
): Value {
  const context = {
    program: calleeProgram,
    file: calleeProgram.file,
    env,
    inputRoots: functionInputRoots(calleeProgram, fn),
    stack: [...callerContext.stack, `${fn.name} default`],
    checks: shouldRecordCallObligations(callerContext) ? callerContext.checks : [],
    assumptions: callerContext.assumptions,
    contractCache: callerContext.contractCache,
    ...(callerContext.callObligations == null ? {} : {callObligations: callerContext.callObligations}),
  } satisfies EvalContext
  return evaluateCallArgumentExpression(param.initializer!, context)
}

function evaluateCallArgumentExpression(expression: ts.Expression, context: EvalContext): Value {
  return evaluateCheckedExpression(expression, context.callObligations == null ? {...context, callObligations: 'silent'} : context)
}

function evaluateImportedFunctionCall(
  callName: string,
  target: Extract<ResolvedCallTarget, {kind: 'function'}>,
  fn: FitFunction,
  argumentValues: Value[],
  callText: string,
  callLine: number,
  context: EvalContext,
  structuralFallback: Value | null,
  callSiteBindings: CallSiteBindings,
  thisValue?: Value,
): Value {
  const specs = target.module.specsByFunction.get(target.functionName) ?? []
  const contractSpecs = functionContractSpecs(target.module, fn, specs)
  const resolvedStructuralFallback = structuralFallback ?? structuralShape(valueFromFunctionReturnShape(`${target.functionName}Result`, fn.node, target.module))
  if (target.imported == null) return resolvedStructuralFallback ?? unknown(`Call target ${callName} resolved outside the current module without an import binding`)
  if (contractSpecs.length === 0) {
    return resolvedStructuralFallback ?? unknown(importedContractUnavailableReason(
      callName,
      target.imported.binding,
      `resolved to ${target.module.file}#${target.functionName}, but that function has no @fit contract`,
    ))
  }
  if (fn.node.parameters.length !== argumentValues.length) return unknown(`Call arity mismatch for imported function ${target.functionName}`)
  if (!shouldRecordCallObligations(context)) return resolvedStructuralFallback ?? unknown(`Imported call ${target.functionName} contract was not used outside a @fit claim`)

  const proof = verifyFunctionContract(target.module, target.functionName, context.contractCache)
  if (proof.status !== 'pass') return unknown(importedContractFailureReason(callName, target.imported.binding, proof))

  const obligations = verifyCallGivenSpecs(
    target.module,
    fn,
    callText,
    argumentValues,
    context,
    {record: true, callLine, thisValue, callSiteBindings},
    callContractEvaluators,
  )
  if (obligations !== 'pass') return unknown(`Imported call ${target.functionName} precondition was not proven`)

  return valueWithFunctionContractSummary(callName, target.module, fn, contractSpecs, argumentValues, context.contractCache, {
    kind: 'imported',
    sourceFile: target.module.file,
    sourceFunctionName: fn.name,
  }, resolvedStructuralFallback ?? unknownResultValue(contractSpecs, target.module), thisValue, callSiteBindings, callContractEvaluators)
}

function shouldRecordCallObligations(context: EvalContext) {
  return context.callObligations !== 'silent'
}

function withCallObligationRecording<T>(context: EvalContext, fn: () => T): T {
  return withCallObligationRecordingWhen(context, true, fn)
}

function withCallObligationRecordingWhen<T>(context: EvalContext, enabled: boolean, fn: () => T): T {
  if (!enabled || shouldRecordCallObligations(context)) return fn()
  const previous = context.callObligations
  context.callObligations = 'record'
  try {
    return fn()
  } finally {
    if (previous == null) delete context.callObligations
    else context.callObligations = previous
  }
}

function verifyFunctionContract(program: Program, functionName: string, contractCache: Map<string, FunctionContractProof>): FunctionContractProof {
  const key = `${program.sourceId}#${functionName}`
  const displayKey = `${program.file}#${functionName}`
  const cached = contractCache.get(key)
  if (cached != null) {
    if (cached.status === 'verifying') {
      return {
        status: 'unknown',
        checks: [{
          file: program.file,
          functionName,
          text: '@fit contract',
          status: 'unknown',
          reason: `cyclic imported contract dependency at ${displayKey}`,
        }],
      }
    }
    return cached
  }

  const fn = program.functions.get(functionName)
  const specs = program.specsByFunction.get(functionName) ?? []
  const contractSpecs = fn == null ? [] : functionContractSpecs(program, fn, specs)
  if (fn == null || contractSpecs.length === 0) {
    const proof: FunctionContractProof = {
      status: 'unknown',
      checks: [{
        file: program.file,
        functionName,
        text: '@fit contract',
        status: 'unknown',
        reason: `No @fit contract for ${functionName}`,
      }],
    }
    contractCache.set(key, proof)
    return proof
  }

  contractCache.set(key, {status: 'verifying'})
  const checks = verifyFunctionSpecs(program.file, program, fn, specs, contractCache)
  const status = checks.some(check => check.status === 'fail') ? 'fail'
    : checks.some(check => check.status === 'unknown' || check.status === 'requires') ? 'unknown'
      : 'pass'
  const proof: FunctionContractProof = {status, checks}
  contractCache.set(key, proof)
  return proof
}

function objectPathText(path: string[] | undefined) {
  return path == null || path.length === 0 ? '<property>' : path.join('.')
}

function verifyInlineSpecsForValue(specs: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'}>[], value: Value, context: EvalContext) {
  if (specs.length === 0) return
  for (const spec of specs) {
    const status = spec.kind === 'check-range'
      ? proveRangeSpec(value, spec.range, context)
      : proveInlineComparisonSpec(value, spec, context)
    context.checks.push({
      file: context.file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName: context.stack.join(' > '),
      text: spec.text,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    })
  }
}

function proveInlineComparisonSpec(value: Value, spec: Extract<FitSpec, {kind: 'check-comparison'}>, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  const right = evaluateSpecExpression(spec.right, context)
  return proveComparison(value, spec.op, right, context.assumptions)
}
