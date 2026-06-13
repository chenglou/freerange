import * as ts from 'typescript'
import {
  buildFitSourceFile,
  loadFitProject,
  type FitFunction,
  type FitProjectFile,
} from './modules.ts'
import {readTopLevelGlobal} from './module-values.ts'
export {readTopLevelGlobal} from './module-values.ts'
import {
  fitSpecIsAssumption,
  fitSpecIsProof,
  fitExpressionScopeSourceId,
  fitExpressionParsed,
  fitValueSpecExpressions,
  fitReturnInternalRoot,
  fitReturnPublicRoot,
  instantiateInlineFitTemplates,
  parseExpression,
  publicFitText,
  type FitComparisonCheckSpec,
  type FitCheckSpec,
  type FitDomainPath,
  type FitExpressionLike,
  type FitInlineCheckSpec,
  type FitLoopSpec,
  type FitPureSpec,
  type FitRange,
  type FitSpec,
} from './parser.ts'
import {functionPurity} from './interpreter/function-effects.ts'
import {
  evaluateRangeValue as evaluateParsedRangeValue,
  evaluateRangeBound as evaluateParsedRangeBound,
  evaluateSpecExpression as evaluateParsedSpecExpression,
  proveRangeSpec as proveParsedRangeSpec,
  verifyCheckSpecWithProof as verifyParsedCheckSpecWithProof,
  type CheckSpecHooks,
} from './check-specs.ts'
import {
  type EvalContext,
  type FitAudit,
  type FitCheck,
  type FitCheckStatus,
  type FitInferFunctionReport,
  type FitInferLoopReport,
  type FitInferLoopSpec,
  type FitInferReport,
  type FitInferSummary,
  type FunctionContractProof,
  type Program,
  type ResolvedCallTarget,
} from './check-types.ts'
import {bindingElementPropertyName, forEachArrayBindingElement} from './binding-patterns.ts'
import {
  unknown,
  valueWithDefaultedUndefined,
  type LinearConstraint,
  type Value,
} from './domain.ts'
import {mergeAssumptions} from './assumptions.ts'
import {proveComparison, proveObligation} from './proof.ts'
import {
  valueFromFunctionReturnPath,
  valueFromFunctionReturnType,
  valueFromNodePath,
  valueFromNodeType,
  valueFromTypeNodePath,
  valueFromTypeNode,
  valueFromTypePath,
  type ShapePathSegment,
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
  functionHasExplicitSpecs,
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
  valueWithBindingTypeFallback,
} from './function-inputs.ts'
import {
  functionEvalContext,
  prepareFunctionEvaluation,
} from './function-evaluation.ts'
import {
  collectGivenAssumptions,
  validateGivenSpecs,
} from './givens.ts'
import {
  contractTypeChecksForTopLevel,
  filterTypeCheckedInlineTemplates,
  filterTypeCheckedSpecs,
} from './contract-typecheck.ts'
import {
  evaluateDomainPathValue,
  parsePrintedNumber,
} from './domain-paths.ts'
import {
  numericLiteralValue,
  unwrapExpression,
} from './linear.ts'
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
import type {
  InterpreterAudit,
  InterpreterCall,
  InterpreterClaim,
  InterpreterEffect,
  InterpreterFrame,
  InterpreterFlow,
  InterpreterHooks,
  InterpreterIssue,
  InterpreterLoopClaim,
  InterpreterReturnCase,
} from './interpreter/context.ts'
import {formatInterpreterEffects, formatInterpreterIssues} from './interpreter/format.ts'

export type {FitInferRedundantSpec, FitInferSpec, FitInferSpecStatus} from './infer-report.ts'
export type {
  FitCheck,
  FitAudit,
  FitCheckStatus,
  FitInferFunctionReport,
  FitInferLoopReport,
  FitInferLoopSpec,
  FitInferReport,
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
      if (options.functionName == null && options.all !== true && !functionHasExplicitSpecs(fn) && !functionHasBodyFitComment(fn) && !functionHasTypeContracts(program, fn)) continue
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

export function createFunctionContractCache(): Map<string, FunctionContractProof> {
  return new Map<string, FunctionContractProof>()
}

export function verifyFitProgram(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const checks: FitCheck[] = []
  for (const fn of program.functions.values()) {
    if (!functionHasExplicitSpecs(fn) && !functionHasBodyFitComment(fn) && !functionHasTypeContracts(program, fn)) continue
    checks.push(...verifyFunctionSpecs(program.file, program, fn, contractCache))
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
    if (!functionHasExplicitSpecs(fn) && !functionHasBodyFitComment(fn) && !functionHasTypeContracts(program, fn)) continue
    const result = verifyFunctionSpecsDetailed(program.file, program, fn, contractCache)
    annotationChecks.push(...result.checks)
    if (result.recordedCallsites) {
      functionsWithRecordedCallsites.add(fn.name)
      rawCallsiteChecks.push(...result.callsiteChecks)
    }
  }
  const topLevelAnnotationChecks = verifyTopLevelInlineSpecs(program, contractCache)
  annotationChecks.push(...topLevelAnnotationChecks)

  if (reachableProgramHasCallPreconditions(program)) {
    if (topLevelAnnotationChecks.every(check => check.status === 'pass')) {
      rawCallsiteChecks.push(...checkTopLevelCallsites(program, contractCache))
    }
    for (const fn of program.functions.values()) {
      if (functionsWithRecordedCallsites.has(fn.name)) continue
      rawCallsiteChecks.push(...checkFunctionCallsites(program, fn, contractCache))
    }
  }

  return {
    annotationChecks,
    callsiteChecks: dedupeCallsiteChecks(rawCallsiteChecks.map(toCallsiteCheck)),
  }
}

function reachableProgramHasCallPreconditions(program: Program, seen = new Set<string>()): boolean {
  if (seen.has(program.sourceId)) return false
  seen.add(program.sourceId)
  if ([...program.functions.values()].some(fn => functionHasCallPreconditionSpecs(program, fn))) return true
  for (const binding of program.imports.values()) {
    if (binding.kind === 'resolved' && reachableProgramHasCallPreconditions(binding.file, seen)) return true
    if (binding.kind === 'namespace' && reachableProgramHasCallPreconditions(binding.file, seen)) return true
  }
  return false
}

function functionHasCallPreconditionSpecs(program: Program, fn: FitFunction) {
  return filterTypeCheckedSpecs(program, functionContractSpecs(program, fn)).some(fitSpecIsAssumption)
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
  return functionHasExplicitSpecs(fn)
    || functionHasBodyFitComment(fn)
    || functionHasTypeContracts(program, fn)
}

function auditTopLevelSelectors(program: Program, contractCache: Map<string, FunctionContractProof>): FitAudit[] {
  const context = topLevelEvalContext(program, contractCache)
  const result = evaluateInterpreterTopLevel(program, context.env, context.stack, context.assumptions, interpreterHooks(context))
  return result.audits.map(audit => interpreterAuditToFitAudit(program.file, audit))
}

function auditFunctionSelectors(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FitAudit[] {
  const setup = prepareFunctionEvaluation(program, fn, contractCache, givenEvaluators)
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
  const setup = prepareFunctionEvaluation(program, fn, contractCache, givenEvaluators)
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
    : isUnsupportedCallRequirement(check) ? 'unknown'
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

function isUnsupportedCallRequirement(check: FitCheck) {
  return check.detail?.kind === 'call-precondition' && check.detail.unsupported
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
  const typeChecks = contractTypeChecksForTopLevel(program)
  context.checks.push(...typeChecks)
  const allowInlineSpecs = typeChecks.every(check => check.status === 'pass')
  for (const statement of program.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const statementChecksStart = context.checks.length
    const specs = allowInlineSpecs
      ? filterTypeCheckedSpecs(program, program.topLevelBodySpecs.localSpecsByStatement.get(statement) ?? [])
      : []
    bindVariableStatement(statement, context, specs)
    if (checksAddedNonPass(context.checks, statementChecksStart)) return context.checks
  }
  return context.checks
}

function checksAddedNonPass(checks: FitCheck[], start: number): boolean {
  for (let index = start; index < checks.length; index++) {
    if (checks[index]!.status !== 'pass') return true
  }
  return false
}

function verifyFunctionSpecs(
  file: string,
  program: Program,
  fn: FitFunction,
  contractCache: Map<string, FunctionContractProof>,
): FitCheck[] {
  return verifyFunctionSpecsDetailed(file, program, fn, contractCache).checks
}

function verifyFunctionSpecsDetailed(
  file: string,
  program: Program,
  fn: FitFunction,
  contractCache: Map<string, FunctionContractProof>,
): {checks: FitCheck[]; callsiteChecks: FitCheck[]; recordedCallsites: boolean} {
  const functionName = fn.name
  const setup = prepareFunctionEvaluation(program, fn, contractCache, givenEvaluators)
  const {contractSpecs, env} = setup
  const checks = [...setup.typeChecks, ...setup.givenChecks]
  for (const placement of fn.bodySpecs.unsupportedPlacements) {
    checks.push({
      file,
      functionName,
      line: placement.line,
      text: placement.text,
      status: 'unknown',
      reason: placement.reason,
    })
  }
  if (setup.typeChecks.some(check => check.status !== 'pass')) {
    return {checks, callsiteChecks: [], recordedCallsites: false}
  }
  checks.push(...typeUnsupportedChecks(file, functionName, functionTypeUnsupported(program, fn)))

  checks.push(...setup.assumptionChecks)
  const recordsCallsites = functionHasBodyClaims(contractSpecs)
  const hasBodyClaims = recordsCallsites || functionHasBodyFitComment(fn) || functionHasBodyTypeBoundary(program, fn)
  const context = functionEvalContext(program, fn, setup, contractCache, {
    callObligations: recordsCallsites ? 'record' : 'silent',
  })
  const state = hasBodyClaims
    ? evaluateFunctionBodyState(fn, context)
    : {result: unknown('No body claim requested'), env: context.env, assumptions: context.assumptions}
  const result = state.result
  if (hasBodyClaims) checks.push(...context.checks)

  for (const spec of contractSpecs) {
    if (!fitSpecIsProof(spec)) continue
    if (spec.kind === 'pure') {
      checks.push(verifyPureSpec(file, functionName, fn, program, spec))
      continue
    }
    checks.push(verifyCheckSpecForResultCases(file, program, functionName, env, result, state.returnCases, spec, checks, context.assumptions, context.booleanAssumptions, contractCache))
  }

  return {
    checks,
    callsiteChecks: recordsCallsites ? callChecks(context) : [],
    recordedCallsites: hasBodyClaims && recordsCallsites,
  }
}

function functionHasBodyClaims(specs: FitSpec[]) {
  return specs.some(fitSpecIsProof)
}

function inferFunctionFacts(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FitInferFunctionReport {
  const functionName = fn.name
  const loops: FitInferLoopReport[] = []
  const setup = prepareFunctionEvaluation(program, fn, contractCache, givenEvaluators)
  const {contractSpecs, env} = setup
  const typeContractChecks = typeUnsupportedChecks(program.file, functionName, functionTypeUnsupported(program, fn))
  const inferUnsupported: string[] = []
  const context = functionEvalContext(program, fn, setup, contractCache, {inferLoops: loops, inferUnsupported})
  const state = evaluateFunctionBodyState(fn, context)
  const resultFacts = factInventoryFromValue(fitReturnInternalRoot, state.result).inferFacts()
  const localFacts = localFactsFromEnv(env, state.env)
  const backgroundChecks = [
    ...setup.typeChecks,
    ...setup.givenChecks,
    ...typeContractChecks,
    ...setup.assumptionChecks,
    ...context.checks,
  ]
  const specReports = inferFunctionSpecReports(contractSpecs, backgroundChecks, spec => verifyCheckSpecForResultCases(
    program.file,
    program,
    functionName,
    env,
    state.result,
    state.returnCases,
    spec,
    [...backgroundChecks],
    state.assumptions,
    context.booleanAssumptions,
    contractCache,
  ))
  const unsupported = [
    ...setup.typeChecks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
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
  evaluateExpression: (expression, context) => evaluateContractExpression(expression, context),
  evaluateDomainPath: (domainPath, context) => evaluateDomainPathForContext(domainPath, context),
  contextForExpression: (expression, context) => contextForScopedFitExpression(expression, context),
  parsePrintedNumber,
}

function evaluateDomainPathForContext(domainPath: FitDomainPath, context: EvalContext): Value {
  const value = evaluateDomainPathValue(domainPath, context.env)
  if (value.kind !== 'unknown') return value
  return domainPathTypeValue(domainPath, context) ?? value
}

function domainPathTypeValue(domainPath: FitDomainPath, context: EvalContext): Value | null {
  return pathTypeValue(domainPath.root, domainPath.segments, context)
}

function pathTypeValue(root: string, segments: readonly ShapePathSegment[], context: EvalContext): Value | null {
  const fn = currentContextFunction(context)
  if (root === fitReturnInternalRoot && fn != null) {
    return valueFromFunctionReturnPath(fitReturnPublicRoot, fn.node, segments, context.program)
  }

  if (fn != null) {
    if (root === 'this') {
      const value = classInstancePathValue(fn, segments, context.program)
      if (value != null) return value
    }
    const param = fn.node.parameters.find(current => ts.isIdentifier(current.name) && current.name.text === root)
    if (param != null) {
      return valueFromTypeNodePath(root, param.type, segments, context.program)
        ?? valueFromNodePath(root, param.name, segments, context.program)
    }
    const local = findVariableDeclaration(fn.node.body, root)
    if (local != null) {
      return valueFromTypeNodePath(root, local.type, segments, context.program)
        ?? valueFromNodePath(root, local.name, segments, context.program)
    }
  }

  const topLevel = findVariableDeclaration(context.program.sourceFile, root)
  return topLevel == null
    ? null
    : valueFromTypeNodePath(root, topLevel.type, segments, context.program)
      ?? valueFromNodePath(root, topLevel.name, segments, context.program)
}

function currentContextFunction(context: EvalContext): FitFunction | null {
  for (let index = context.stack.length - 1; index >= 0; index--) {
    const fn = context.program.functions.get(context.stack[index]!)
    if (fn != null) return fn
  }
  return null
}

function classInstancePathValue(fn: FitFunction, segments: readonly ShapePathSegment[], program: Program): Value | null {
  const classNode = ts.isMethodDeclaration(fn.node) || ts.isGetAccessorDeclaration(fn.node) ? fn.node.parent : null
  if (classNode == null || !ts.isClassDeclaration(classNode) || classNode.name == null || program.typeChecker == null) return null
  const symbol = program.typeChecker.getSymbolAtLocation(classNode.name)
  return symbol == null
    ? null
    : valueFromTypePath('this', program.typeChecker.getDeclaredTypeOfSymbol(symbol), segments, program.typeChecker, classNode)
}

function findVariableDeclaration(node: ts.Node | undefined, name: string): ts.VariableDeclaration | null {
  if (node == null) return null
  let found: ts.VariableDeclaration | null = null
  const visit = (current: ts.Node) => {
    if (found != null) return
    if (current !== node && isFunctionLike(current)) return
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === name) {
      found = current
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function isFunctionLike(node: ts.Node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

function contextForScopedFitExpression(expression: FitExpressionLike, context: EvalContext): EvalContext {
  const scopeSourceId = fitExpressionScopeSourceId(expression)
  if (scopeSourceId == null || scopeSourceId === context.program.sourceId) {
    return scopeSourceId == null ? context : contextWithDeclarationScope(context.program, context)
  }
  const scopeProgram = programForSourceId(context.program, scopeSourceId)
  return scopeProgram == null ? context : contextWithDeclarationScope(scopeProgram, context)
}

function contextWithDeclarationScope(scopeProgram: Program, context: EvalContext): EvalContext {
  return {
    ...context,
    program: scopeProgram,
    file: scopeProgram.file,
    env: programGlobalEnv(scopeProgram),
  }
}

function programForSourceId(program: Program, sourceId: string): Program | null {
  let typeOnlyFile: FitProjectFile<Value> | null = null
  for (const file of program.project.files.values()) {
    if (file.sourceId !== sourceId) continue
    if (isLoadedProgram(file)) return file
    typeOnlyFile = file
  }
  return typeOnlyFile == null ? null : buildFitSourceFile(typeOnlyFile.sourceId, typeOnlyFile.sourceText, readTopLevelGlobal)
}

function isLoadedProgram(file: FitProjectFile<Value>): file is Program {
  return 'globals' in file && 'functions' in file && 'imports' in file
}

function evaluateCheckedExpression(expression: ts.Expression, context: EvalContext): Value {
  if (context.contractExpression === true) return evaluateContractExpression(expression, context)
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

function evaluateContractExpression(expression: ts.Expression, context: EvalContext): Value {
  const problems = context.contractExpressionProblems ?? []
  const problemStart = problems.length
  const previousContractExpression = context.contractExpression
  const previousContractExpressionProblems = context.contractExpressionProblems
  const previousCallObligations = context.callObligations
  context.contractExpression = true
  context.contractExpressionProblems = problems
  context.callObligations = 'record'

  const originalEnv = context.env
  try {
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
    problems.push(...formatContractExpressionProblems(result.issues, result.effects))

    const localProblems = problems.slice(problemStart)
    if (localProblems.length > 0) return unknown(contractExpressionUnsupportedReason(expression, localProblems))
    return result.value
  } finally {
    if (previousContractExpression == null) delete context.contractExpression
    else context.contractExpression = previousContractExpression
    if (previousContractExpressionProblems == null) delete context.contractExpressionProblems
    else context.contractExpressionProblems = previousContractExpressionProblems
    if (previousCallObligations == null) delete context.callObligations
    else context.callObligations = previousCallObligations
  }
}

function contractExpressionUnsupportedReason(expression: ts.Expression, problems: string[]) {
  return [
    `Unsupported @fit contract expression: ${publicFitText(expression.getText())}`,
    ...uniqueUnsupported(problems).map(line => `  ${line}`),
  ].join('\n')
}

function formatContractExpressionProblems(
  issues: InterpreterIssue[],
  effects: InterpreterEffect[],
) {
  return [
    ...formatInterpreterIssues(issues.filter(isHardContractExpressionIssue)),
    ...formatInterpreterEffects(effects),
  ]
}

function isHardContractExpressionIssue(issue: InterpreterIssue) {
  return /\bunsupported\b/i.test(issue.message)
    || issue.message.startsWith('Unknown function ')
    || issue.message.startsWith('Unknown identifier ')
    || issue.message.startsWith('Call arity mismatch')
    || issue.message.includes('mutable helper alias')
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

// `pure` is checked against the function's effect summary, not by evaluating a
// value: a definite effect disproves it (fail), an unanalyzable call leaves it
// unproven (unknown), and otherwise it passes.
function verifyPureSpec(file: string, functionName: string, fn: FitFunction, program: Program, spec: FitPureSpec): FitCheck {
  const purity = functionPurity(fn.node, program)
  const base = {file, functionName, text: spec.text, ...(spec.line == null ? {} : {line: spec.line})}
  switch (purity.kind) {
    case 'pure':
      return {...base, status: 'pass'}
    case 'impure':
      return {...base, status: 'fail', reason: `not pure: ${purity.reason}`}
    case 'unknown':
      return {...base, status: 'unknown', reason: `not pure: ${purity.reason}`}
  }
}

function verifyCheckSpec(
  file: string,
  program: Program,
  functionName: string,
  baseEnv: Map<string, Value>,
  result: Value,
  spec: FitCheckSpec,
  checks: FitCheck[],
  assumptions: LinearConstraint[],
  booleanAssumptions: Map<string, boolean> | undefined,
  contractCache: Map<string, FunctionContractProof>,
  boundary?: CheckBoundary,
  obligationBoundary: FitObligationBoundary = 'function-contract',
): FitCheck {
  const obligation = obligationForSpec(file, functionName, spec, obligationBoundary, boundary)
  const proof = verifyParsedCheckSpecWithProof(file, program, functionName, baseEnv, result, spec, checks, assumptions, booleanAssumptions, contractCache, checkSpecHooks)
  const check = boundary == null ? proof.check : {...proof.check, ...boundary}
  return proveObligation({
    obligation,
    step: proof.step,
    usedFacts: proof.usedFacts,
    prove: () => check,
  })
}

function verifyCheckSpecForResultCases(
  file: string,
  program: Program,
  functionName: string,
  baseEnv: Map<string, Value>,
  result: Value,
  returnCases: InterpreterReturnCase[] | undefined,
  spec: FitCheckSpec,
  checks: FitCheck[],
  assumptions: LinearConstraint[],
  booleanAssumptions: Map<string, boolean> | undefined,
  contractCache: Map<string, FunctionContractProof>,
): FitCheck {
  if (returnCases == null || returnCases.length <= 1) {
    return verifyCheckSpec(file, program, functionName, baseEnv, result, spec, checks, assumptions, booleanAssumptions, contractCache)
  }

  const joinedCheck = verifyCheckSpec(file, program, functionName, baseEnv, result, spec, checks, assumptions, booleanAssumptions, contractCache)
  if (joinedCheck.status === 'pass') return joinedCheck

  const caseChecks = returnCases.map(returnCase => verifyCheckSpec(
    file,
    program,
    functionName,
    baseEnv,
    returnCase.value,
    spec,
    checks,
    mergeAssumptions(assumptions, returnCase.assumptions),
    booleanAssumptions,
    contractCache,
  ))
  if (caseChecks.every(check => check.status === 'pass')) return {...caseChecks[0]!, status: 'pass'}
  return caseChecks.find(check => check.status === 'fail')
    ?? caseChecks.find(check => check.status === 'unknown')
    ?? caseChecks.find(check => check.status === 'requires')
    ?? caseChecks[0]!
}

function proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  return proveParsedRangeSpec(value, range, context, checkSpecHooks)
}

function evaluateRangeBound(text: FitExpressionLike, context: EvalContext): Value {
  return evaluateParsedRangeBound(text, context, checkSpecHooks)
}

function evaluateRangeValue(range: FitRange, context: EvalContext, expr: string | null, origin: string[] = []): Value {
  return evaluateParsedRangeValue(range, context, checkSpecHooks, expr, origin)
}

function evaluateSpecExpression(text: FitExpressionLike, context: EvalContext): Value {
  return evaluateParsedSpecExpression(text, context, checkSpecHooks)
}

const givenEvaluators = {
  evaluateRangeBound,
  evaluateSpecExpression,
}

const callContractEvaluators = {
  evaluateRangeValue,
  evaluateSpecExpression,
  proveRangeSpec,
}

function evaluateFunctionBody(fn: FitFunction, context: EvalContext): Value {
  return evaluateFunctionBodyState(fn, context).result
}

function evaluateFunctionBodyState(fn: FitFunction, context: EvalContext): {result: Value; env: Map<string, Value>; assumptions: LinearConstraint[]; returnCases?: InterpreterReturnCase[]} {
  const hooks = interpreterHooks(context)
  const result = evaluateInterpreterFunctionBody(context.program, fn, context.env, context.stack, context.assumptions, hooks)
  context.assumptions = result.assumptions
  if (context.inferUnsupported != null) {
    context.inferUnsupported.push(...formatInterpreterIssues(result.issues))
  }
  if (context.contractExpression === true && context.contractExpressionProblems != null) {
    context.contractExpressionProblems.push(...formatContractExpressionProblems(result.issues, result.effects))
  }
  return {
    result: result.value,
    env: result.env,
    assumptions: result.assumptions,
    ...(result.returnCases == null ? {} : {returnCases: result.returnCases}),
  }
}

function interpreterHooks(context: EvalContext): InterpreterHooks {
  return {
    evaluateCall: (call, frame) => evaluateInterpreterCall(call, frame, context),
    evaluatePath: (expression, frame) => evaluateInterpreterPathExpression(expression, frame, context),
    evaluateClaim: (claim, frame, evaluate) => evaluateInterpreterClaim(claim, frame, context, evaluate),
    afterClaim: (claim, value, frame) => afterInterpreterClaim(claim, value, frame, context),
    evaluateLoop: (claim, frame, evaluate) => evaluateInterpreterLoop(claim, frame, context, evaluate),
  }
}

type StaticPath = {
  root: string
  segments: ShapePathSegment[]
}

function evaluateInterpreterPathExpression(expression: ts.Expression, frame: InterpreterFrame, rootContext: EvalContext): Value | null {
  if (rootContext.contractExpression !== true) return null
  const path = staticPathFromExpression(expression)
  const context = contextForInterpreterFrame(frame, rootContext)
  if (path == null) return null
  if (frame.env.has(path.root)) {
    const rootValue = frame.env.get(path.root)!
    const envValue = evaluateStaticPathValue(rootValue, path)
    if (envValue.kind !== 'unknown') return envValue
    if (path.segments.length === 0) return envValue
    const aliasPath = staticAliasPath(rootValue, path.segments)
    if (aliasPath != null) {
      const aliasValue = pathTypeValue(aliasPath.root, aliasPath.segments, context)
      if (aliasValue != null) return aliasValue
    }
    return pathTypeValue(path.root, path.segments, context) ?? envValue
  }
  return path.segments.length === 0 ? null : pathTypeValue(path.root, path.segments, context)
}

function staticAliasPath(value: Value, segments: ShapePathSegment[]): StaticPath | null {
  const expr = valueExpressionText(value)
  if (expr == null) return null
  try {
    const rootPath = staticPathFromExpression(parseExpression(expr))
    return rootPath == null ? null : {...rootPath, segments: [...rootPath.segments, ...segments]}
  } catch {
    return null
  }
}

function valueExpressionText(value: Value): string | null {
  switch (value.kind) {
    case 'number':
    case 'literal':
    case 'object':
    case 'array':
    case 'null':
    case 'nullable':
      return value.expr
    case 'unknown':
      return null
  }
}

function staticPathFromExpression(expression: ts.Expression): StaticPath | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return {root: current.text, segments: []}
  if (current.kind === ts.SyntaxKind.ThisKeyword) return {root: 'this', segments: []}
  if (ts.isPropertyAccessExpression(current)) {
    const parent = staticPathFromExpression(current.expression)
    return parent == null ? null : {...parent, segments: [...parent.segments, {kind: 'prop', name: current.name.text}]}
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression != null) {
    const parent = staticPathFromExpression(current.expression)
    const index = numericLiteralValue(current.argumentExpression)
    return parent == null || index == null || !Number.isInteger(index) || index < 0
      ? null
      : {...parent, segments: [...parent.segments, {kind: 'index', index}]}
  }
  return null
}

function evaluateStaticPathValue(envValue: Value, path: StaticPath): Value {
  let value = envValue
  let expr = path.root
  for (const segment of path.segments) {
    if (value.kind === 'unknown') return value
    if (segment.kind === 'prop') {
      if (value.kind === 'array' && segment.name === 'length') {
        value = value.length
      } else if (value.kind === 'object') {
        value = value.props.get(segment.name) ?? unknown(`${expr}.${segment.name} was not inferred`)
      } else if (value.kind === 'nullable') {
        value = value.present
        if (value.kind === 'object') value = value.props.get(segment.name) ?? unknown(`${expr}.${segment.name} was not inferred`)
        else if (value.kind === 'array' && segment.name === 'length') value = value.length
        else return unknown(`${expr}.${segment.name} expected an object`)
      } else {
        return unknown(`${expr}.${segment.name} expected an object`)
      }
      expr += `.${segment.name}`
      continue
    }
    if (segment.kind === 'index') {
      if (value.kind !== 'array') return unknown(`${expr}[${segment.index}] expected an array`)
      value = value.elements?.[segment.index] ?? value.element ?? unknown(`${expr}[${segment.index}] was not inferred`)
      expr += `[${segment.index}]`
      continue
    }
    if (value.kind !== 'array') return unknown(`${expr}[] expected an array`)
    value = value.element ?? unknown(`${expr}[] was not inferred`)
    expr += '[]'
  }
  return value
}

function evaluateInterpreterCall(call: InterpreterCall, frame: InterpreterFrame, rootContext: EvalContext): Value | null {
  if (rootContext.callObligations == null) return null
  const callContext = contextForInterpreterFrame(frame, rootContext, {
    checks: shouldRecordCallObligations(rootContext) && frame.suppressChecks !== true ? rootContext.checks : [],
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
    program: call.program,
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
  const bodySpecs = bodySpecsForStack(frame.program, frame.stack)

  if (claim.kind === 'variable') {
    const localSpecs = filterTypeCheckedSpecs(frame.program, bodySpecs?.localSpecsByStatement.get(claim.statement) ?? [])
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
    const specs = filterTypeCheckedSpecs(frame.program, bodySpecs?.returnSpecsByNode.get(claim.node) ?? [])
    const typeContract = typeCheckContractForExpressionBoundary(frame.program, claim.expression, fitReturnPublicRoot)
    verifyInlineSpecsForValue(specs, value, context)
    const boundary = checkBoundaryForNode(frame.program.sourceFile, claim.node)
    pushTypeUnsupportedChecks(context, typeContract.unsupported, boundary)
    verifyCheckSpecsWithResult(typeContract.specs, value, context, boundary, 'type-boundary')
    return
  }

  const templates = filterTypeCheckedInlineTemplates(frame.program, bodySpecs?.objectPropertyTemplatesByNode.get(claim.property) ?? [])
  const specs = instantiateInlineFitTemplates(templates, objectPathText(claim.path), 'prove')
  verifyInlineSpecsForValue(specs, value, context)
}

function evaluateInterpreterLoop(
  claim: InterpreterLoopClaim,
  frame: InterpreterFrame,
  rootContext: EvalContext,
  evaluate: () => InterpreterFlow,
): InterpreterFlow {
  if (!shouldRecordInterpreterClaim(frame, rootContext)) return evaluate()
  const context = interpreterEvalContext(frame, rootContext)
  const checksStart = rootContext.checks.length
  const rawLocalSpecs = bodySpecsForStack(frame.program, frame.stack)?.loopSpecsByStatement.get(claim.statement) ?? []
  const checkedRawLocalSpecs = filterTypeCheckedSpecs(frame.program, rawLocalSpecs)
  const {validSpecs: localSpecs, resultSpecs} = splitLoopSpecs(checkedRawLocalSpecs)
  reportLoopResultSpecs(resultSpecs, context)
  applyLocalGivenSpecs(localSpecs, context)
  frame.assumptions = context.assumptions
  const flow = withCallObligationRecordingWhen(rootContext, functionHasBodyClaims(localSpecs), evaluate)
  context.assumptions = frame.assumptions
  verifyLocalLoopSpecs(localSpecs, context)
  recordInferLoop(claim.statement, claim.kind, checkedRawLocalSpecs, context, checksStart, claim.factRoots)
  frame.assumptions = context.assumptions
  return flow
}

function interpreterClaimRecordsCalls(claim: InterpreterClaim, frame: InterpreterFrame, rootContext: EvalContext) {
  if (rootContext.callObligations === 'record') return true
  const bodySpecs = bodySpecsForStack(frame.program, frame.stack)
  if (claim.kind === 'variable') {
    if ((bodySpecs?.localSpecsByStatement.get(claim.statement) ?? []).length > 0) return true
    if (!ts.isIdentifier(claim.declaration.name)) return false
    return hasTypeContractWork(mergeTypeContracts([
      typeCheckContractForTypeNode(frame.program, claim.declaration.type, claim.declaration.name.text),
      claim.declaration.initializer == null
        ? emptyTypeContract<FitCheckSpec>()
        : typeCheckContractForExpressionBoundary(frame.program, claim.declaration.initializer, claim.declaration.name.text),
    ]))
  }
  if (claim.kind === 'return') {
    return (bodySpecs?.returnSpecsByNode.get(claim.node) ?? []).length > 0
      || hasTypeContractWork(typeCheckContractForExpressionBoundary(frame.program, claim.expression, fitReturnPublicRoot))
  }
  return filterTypeCheckedInlineTemplates(frame.program, bodySpecs?.objectPropertyTemplatesByNode.get(claim.property) ?? []).length > 0
}

function bodySpecsForStack(program: Program, stack: string[]) {
  for (let index = stack.length - 1; index >= 0; index--) {
    const name = stack[index]!
    if (name === '<top-level>') return program.topLevelBodySpecs
    const bodySpecs = program.functions.get(name)?.bodySpecs
    if (bodySpecs != null) return bodySpecs
  }
  return undefined
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
  bindName(declaration.name, valueWithBindingTypeFallback(declaration.name, value, declaration.type, context.program), context)
  const boundary = checkBoundaryForNode(context.program.sourceFile, declaration)
  pushTypeUnsupportedChecks(context, typeContract.unsupported, boundary)
  verifyCheckSpecsWithResult(typeSpecs, unknown('Inline @fit checks do not use return'), context, boundary, 'type-boundary')
}

function bindVariableStatement(statement: ts.VariableStatement, context: EvalContext, specs: FitCheckSpec[]) {
  for (const declaration of statement.declarationList.declarations) {
    bindVariableDeclaration(declaration, context, {claim: specs.length > 0})
  }
  verifyLocalFitSpecs(filterTypeCheckedSpecs(context.program, specs), context)
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
  const checkedSpecs = filterTypeCheckedSpecs(context.program, specs)
  if (checkedSpecs.length === 0) return
  for (const spec of checkedSpecs) {
    context.checks.push(verifyCheckSpec(
      context.file,
      context.program,
      context.stack.join(' > '),
      context.env,
      result,
      spec,
      [...context.checks],
      context.assumptions,
      context.booleanAssumptions,
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
    const typed = valueFromNodeType(element.name.getText(context.program.sourceFile), element.name, context.program)
    const prop = value.kind === 'object'
      ? value.props.get(propertyName) ?? typed ?? unknown(`Property ${propertyName} was not inferred`)
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
    const typed = valueFromNodeType(elementName.getText(context.program.sourceFile), elementName, context.program)
    const item = arrayPatternElementValue(value, index)
    bindName(elementName, item.kind === 'unknown' && typed != null ? typed : item, context)
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
  if (specs.length === 0) return

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
    if (fitSpecIsAssumption(spec)) {
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

function splitLoopSpecs(specs: FitLoopSpec[]): {validSpecs: FitLoopSpec[]; resultSpecs: FitLoopSpec[]} {
  const validSpecs: FitLoopSpec[] = []
  const resultSpecs: FitLoopSpec[] = []
  for (const spec of specs) {
    if (specMentionsRoot(spec, fitReturnInternalRoot)) resultSpecs.push(spec)
    else validSpecs.push(spec)
  }
  return {validSpecs, resultSpecs}
}

function reportLoopResultSpecs(specs: FitLoopSpec[], context: EvalContext) {
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
    case 'range':
      return [spec.expression]
    case 'value':
      return [spec.expression, ...fitValueSpecExpressions(spec.value)]
    case 'comparison':
      return [spec.left, spec.right]
    case 'expression':
      return [spec.expression]
    case 'pure':
      return []
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

  const {assumptions, booleanAssumptions, checks: impossibleChecks} = collectGivenAssumptions(
    context.file,
    context.program,
    functionName,
    context.env,
    context.inputRoots,
    assumedGivens,
    context.contractCache,
    givenEvaluators,
    [...context.stack, 'loop'],
  )
  context.checks.push(...impossibleChecks)
  context.assumptions = mergeAssumptions(context.assumptions, assumptions)
  context.booleanAssumptions ??= new Map()
  for (const [key, expected] of booleanAssumptions) context.booleanAssumptions.set(key, expected)
}

function verifyLocalLoopSpecs(specs: FitLoopSpec[], context: EvalContext) {
  if (specs.length === 0) return
  const functionName = `${context.stack.at(-1) ?? '<unknown>'} > loop`
  const loopResult = unknown('Loop annotations do not have return; name local values directly')
  for (const spec of specs) {
    if (!fitSpecIsProof(spec)) continue
    context.checks.push(verifyCheckSpec(
      context.file,
      context.program,
      functionName,
      context.env,
      loopResult,
      spec,
      context.checks,
      context.assumptions,
      context.booleanAssumptions,
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
  if (context.stack.length >= maxInlineDepth) {
    // Announce the budget like the branch-state budget: a recorded check, not
    // just a value reason, because call results get rewritten at function
    // boundaries and would swallow the explanation.
    const reason = `Inline call budget exceeded: ${context.stack.length} nested calls reach limit ${maxInlineDepth}; facts through ${functionName} become unknown`
    context.checks.push({
      file: context.file,
      functionName: context.stack.join(' > '),
      text: options.callText,
      status: 'unknown',
      reason,
      ...(options.callLine == null ? {} : {line: options.callLine}),
    })
    return unknown(reason)
  }
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
    ...(context.booleanAssumptions == null ? {} : {booleanAssumptions: context.booleanAssumptions}),
    contractCache: context.contractCache,
    ...(context.callObligations == null ? {} : {callObligations: context.callObligations}),
    ...(context.contractExpression == null ? {} : {contractExpression: context.contractExpression}),
    ...(context.contractExpressionProblems == null ? {} : {contractExpressionProblems: context.contractExpressionProblems}),
  })
  const returnTypeFallback = valueFromFunctionReturnType(`${functionName}Result`, fn.node, context.program)
    ?? valueFromTypeNode(`${functionName}Result`, fn.node.type, context.program)
    ?? options.fallback
  const fallbackResult = result.kind === 'unknown'
    ? returnTypeFallback ?? result
    : result
  const callSiteFallbackResult = valueWithCallSiteText(fallbackResult, options.callSiteBindings)
  const contractSpecs = filterTypeCheckedSpecs(context.program, functionContractSpecs(context.program, fn))
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
    bindPatternFromValue(param.name, parameterArgumentValue(param, defaultedValue, calleeProgram), env, {preserveLinear: true}, calleeProgram)
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
    ...(callerContext.booleanAssumptions == null ? {} : {booleanAssumptions: callerContext.booleanAssumptions}),
    contractCache: callerContext.contractCache,
    ...(callerContext.callObligations == null ? {} : {callObligations: callerContext.callObligations}),
    ...(callerContext.contractExpression == null ? {} : {contractExpression: callerContext.contractExpression}),
    ...(callerContext.contractExpressionProblems == null ? {} : {contractExpressionProblems: callerContext.contractExpressionProblems}),
  } satisfies EvalContext
  return evaluateCallArgumentExpression(param.initializer!, context)
}

function evaluateCallArgumentExpression(expression: ts.Expression, context: EvalContext): Value {
  if (context.contractExpression === true) return evaluateContractExpression(expression, context)
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
  returnTypeFallback: Value | null,
  callSiteBindings: CallSiteBindings,
  thisValue?: Value,
): Value {
  const contractSpecs = filterTypeCheckedSpecs(target.program, functionContractSpecs(target.program, fn))
  const resolvedReturnTypeFallback = returnTypeFallback ?? valueFromFunctionReturnType(`${target.functionName}Result`, fn.node, target.program)
  if (target.imported == null) return resolvedReturnTypeFallback ?? unknown(`Call target ${callName} resolved outside the current module without an import binding`)
  if (contractSpecs.length === 0) {
    return resolvedReturnTypeFallback ?? unknown(importedContractUnavailableReason(
      callName,
      target.imported.binding,
      `resolved to ${target.program.file}#${target.functionName}, but that function has no @fit contract`,
    ))
  }
  if (fn.node.parameters.length !== argumentValues.length) return unknown(`Call arity mismatch for imported function ${target.functionName}`)
  if (!shouldRecordCallObligations(context)) return resolvedReturnTypeFallback ?? unknown(`Imported call ${target.functionName} contract was not used outside a @fit claim`)

  const proof = verifyFunctionContract(target.program, target.functionName, context.contractCache)
  if (proof.status !== 'pass') return unknown(importedContractFailureReason(callName, target.imported.binding, proof))

  const obligations = verifyCallGivenSpecs(
    target.program,
    fn,
    callText,
    argumentValues,
    context,
    {record: true, callLine, thisValue, callSiteBindings},
    callContractEvaluators,
  )
  if (obligations !== 'pass') return unknown(`Imported call ${target.functionName} precondition was not proven`)

  return valueWithFunctionContractSummary(callName, target.program, fn, contractSpecs, argumentValues, context.contractCache, {
    kind: 'imported',
    sourceFile: target.program.file,
    sourceFunctionName: fn.name,
  }, resolvedReturnTypeFallback ?? unknownResultValue(), thisValue, callSiteBindings, callContractEvaluators)
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
  if (fn == null) {
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

  const contractSpecs = filterTypeCheckedSpecs(program, functionContractSpecs(program, fn))
  if (contractSpecs.length === 0) {
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
  const checks = verifyFunctionSpecs(program.file, program, fn, contractCache)
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

function verifyInlineSpecsForValue(specs: FitInlineCheckSpec[], value: Value, context: EvalContext) {
  if (specs.length === 0) return
  for (const spec of specs) {
    const status = spec.kind === 'range'
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

function proveInlineComparisonSpec(value: Value, spec: FitComparisonCheckSpec, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  const right = evaluateSpecExpression(spec.right, context)
  return proveComparison(value, spec.op, right, context.assumptions)
}
