import * as ts from 'typescript'
import {
  loadFitProject,
  type FitFunction,
} from './modules.ts'
import {readTopLevelGlobal} from './module-values.ts'
export {readTopLevelGlobal} from './module-values.ts'
import {
  parseDomainPathText,
  parseExpression,
  parseFitExpression,
  parseFitSpecLine,
  parseFitSpecs,
  parseInlineFitSpecsForExpression,
  parseLocalFitSpecs,
  hasFitComment,
  hasInlineFitComment,
  fitReturnInternalRoot,
  fitReturnPublicRoot,
  publicFitText,
  type ComparisonOperator,
  type FitDomainPath,
  type FitDomainPathSegment,
  type FitCheckSpec,
  type FitGivenSpec,
  type FitRange,
  type FitSpec,
} from './parser.ts'
import {
  evaluateRangeBound as evaluateParsedRangeBound,
  evaluateSpecExpression as evaluateParsedSpecExpression,
  proveRangeSpec as proveParsedRangeSpec,
  verifyCheckSpec as verifyParsedCheckSpec,
  type CheckSpecHooks,
} from './check-specs.ts'
import {
  type AssumedGivenSpec,
  type EvalContext,
  type EvalFlow,
  type FitCheck,
  type FitCheckStatus,
  type FitDoctorCheck,
  type FitInferFunctionReport,
  type FitInferLoopReport,
  type FitInferLoopSpec,
  type FitInferReport,
  type FitShapeInsight,
  type FitShapeOptions,
  type FitShapeReport,
  type FunctionContractProof,
  type FunctionContractSource,
  type ImportedBinding,
  type LocalizeOptions,
  type Program,
  type ResolvedCallTarget,
} from './check-types.ts'
import {
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from './binding-patterns.ts'
import {
  finiteNumberValue,
  linearNameForExpression,
  mergeAssumptions,
  mergeProvenance,
  numberBranches,
  numberValue,
  tupleElements,
  unknown,
  unknownArray,
  unknownNumber,
  unknownObject,
  valueWithDefaultedUndefined,
  withNumberCases,
  type FactSource,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from './domain.ts'
import {
  cleanLinear,
  linearAdd,
  linearConstant,
  linearEpsilon,
  linearScaleExact,
  linearVariable,
  mergeScale,
  numericLiteralValue,
  sameExpressionText,
  isFixedElementPathExpression,
  unwrapExpression,
  type LinearExpr,
} from './linear.ts'
import {
  comparisonConstraint,
  flipComparison,
  nonNegativeFacts,
  proveNonNegativeFromFacts,
  proveComparison,
  rangeFactsFromBounds,
  type NonNegativeFact,
} from './proof.ts'
import {
  comparisonNeed,
  formatExpectedRange,
  formatRangeSpec,
  formatRange,
  rangeSpecMissingBounds,
} from './reporting.ts'
import {
  structuralShape,
  valueFromCallReturnShape,
  valueFromFunctionReturnShape,
  valueFromNodeShape,
  valueFromSyntaxTypeShape,
  valueWithStructuralFallback,
} from './shapes.ts'
import {
  factsFromEnvRoots,
  factsFromValue,
  localFactsFromEnv,
  numberFacts,
  uniqueFacts,
} from './facts.ts'
import {
  inferFunctionSpecReports,
  redundantSpecs,
  topUnknownReason,
} from './infer-report.ts'
import {
  replaceFunctionSpecs,
  restoreFunctionSpecs,
  scoutNumericParameterNames,
  scoutRequirementSpecsByFunction,
  scoutRequirementsFromReason,
  uniqueScoutCandidates,
  type FitScoutCandidate,
  type FitScoutReport,
} from './scout.ts'
import {
  callSiteBindingsFor,
  callSiteText,
  valueWithCallSiteText,
  type CallSiteBindings,
} from './call-site-text.ts'
import {
  typeCheckContractForTypeNode,
  typeInputGivenContractForFunction,
  typeReturnCheckContractForFunction,
  type TypeContractResult,
  type TypeContractUnsupported,
} from './type-contracts.ts'
import {
  checkBoundaryForNode,
  lineNumberForNode,
  type CheckBoundary,
} from './source-boundary.ts'
import {
  arrayLengthRoot,
  expressionMentionsArrayParam,
  expressionMentionsObjectParam,
  expressionRootName,
  expressionRootNameDeep,
  expressionRootNamesFromText,
} from './source-expressions.ts'
import {localizeValue} from './value-localize.ts'
import {programGlobalEnv} from './program-env.ts'
import {
  functionHasInstanceThisInput,
  functionInputRoots,
  isFunctionLikeWithBody,
} from './function-shape.ts'
import {
  evaluateInterpreterExpression,
  evaluateInterpreterFunctionBody,
} from './interpreter/evaluate.ts'
import type {
  InterpreterCall,
  InterpreterClaim,
  InterpreterFrame,
  InterpreterHooks,
  InterpreterLoopClaim,
} from './interpreter/context.ts'
import {formatInterpreterIssues} from './interpreter/format.ts'

export type {FitScoutCandidate, FitScoutReport} from './scout.ts'
export type {FitInferRedundantSpec, FitInferSpec, FitInferSpecStatus} from './infer-report.ts'
export type {
  FitCheck,
  FitCheckStatus,
  FitDoctorCheck,
  FitDoctorStatus,
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

export function scoutFitFiles(paths: string[], options: {functionName?: string} = {}): FitScoutReport {
  const project = loadFitProject(paths, readTopLevelGlobal)
  const programs = [...project.modules.values()]
  const candidates = programs.flatMap(program => [...program.functions.values()]
    .filter(fn => options.functionName == null || fn.name === options.functionName)
    .flatMap(fn => scoutFunctionCandidates(program, fn)))
  const scoutSpecs = scoutRequirementSpecsByFunction(programs, candidates)
  const savedSpecs = replaceFunctionSpecs(programs, scoutSpecs)
  const checks: FitDoctorCheck[] = []

  try {
    const contractCache = new Map<string, FunctionContractProof>()
    for (const program of project.entries) checks.push(...doctorFitProgram(program, contractCache))
  } finally {
    restoreFunctionSpecs(savedSpecs)
  }

  return {
    files: paths,
    candidates,
    checks,
    summary: {
      candidates: candidates.length,
      pass: checks.filter(check => check.status === 'pass').length,
      fail: checks.filter(check => check.status === 'fail').length,
      requires: checks.filter(check => check.status === 'requires').length,
      unknown: checks.filter(check => check.status === 'unknown').length,
    },
  }
}

export function inspectFitShapes(paths: string[], options: FitShapeOptions = {}): FitShapeReport {
  const project = loadFitProject(paths, readTopLevelGlobal)
  const contractCache = new Map<string, FunctionContractProof>()
  const insights: FitShapeInsight[] = []
  for (const program of project.entries) {
    for (const [functionName, fn] of program.functions) {
      if (options.functionName != null && functionName !== options.functionName) continue
      if (options.functionName == null && options.all !== true && !program.fitFunctions.has(functionName) && !functionHasBodyFitComment(program, fn) && !functionHasTypeContracts(program, fn)) continue
      insights.push(...inspectFunctionShapes(program, fn, contractCache, options))
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

export function doctorFitProgram(program: Program, contractCache: Map<string, FunctionContractProof>): FitDoctorCheck[] {
  const checks: FitCheck[] = []
  checks.push(...doctorTopLevelCalls(program, contractCache))
  for (const fn of program.functions.values()) checks.push(...doctorFunctionCalls(program, fn, contractCache))
  return dedupeDoctorChecks(checks.map(toDoctorCheck))
}

function doctorTopLevelCalls(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const context: EvalContext = {
    program,
    file: program.file,
    env: programGlobalEnv(program),
    inputRoots: [],
    stack: ['<top-level>'],
    checks: [],
    assumptions: [],
    contractCache,
    callObligations: 'record',
  }
  for (const statement of program.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      bindVariableDeclaration(declaration, context, {claim: true})
    }
  }
  return context.checks.filter(isCallCheck)
}

function doctorFunctionCalls(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const functionName = fn.name
  const specs = program.specsByFunction.get(functionName) ?? []
  const inputSpecs = functionInputSpecs(program, fn, specs)
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, inputSpecs, program, env)

  const {assumedGivens} = validateGivenSpecs(program.file, functionName, inputSpecs, inputRoots, 'function-given')
  for (const given of assumedGivens) {
    if (given.kind === 'range') applyGivenRangeSpec(env, given.spec)
  }
  const {assumptions} = collectGivenAssumptions(program.file, program, functionName, env, inputRoots, assumedGivens, contractCache)
  const context: EvalContext = {
    program,
    file: program.file,
    env,
    inputRoots,
    stack: [functionName],
    checks: [],
    assumptions,
    contractCache,
    callObligations: 'record',
  }
  evaluateFunctionBody(fn, context)
  return context.checks.filter(isCallCheck)
}

function isCallCheck(check: FitCheck) {
  return check.text.startsWith('call ')
}

function toDoctorCheck(check: FitCheck): FitDoctorCheck {
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
  }
}

function isDefiniteCallFailure(check: FitCheck) {
  return check.reason?.split('\n').some(line => line.startsWith('this call passes ') && line.includes(' = ') && !line.includes(' is ')) === true
}

function dedupeDoctorChecks(checks: FitDoctorCheck[]) {
  const seen = new Set<string>()
  const result: FitDoctorCheck[] = []
  for (const check of checks) {
    const key = `${check.file}\0${check.functionName}\0${check.text}\0${check.status}\0${check.reason ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(check)
  }
  return result
}

function verifyTopLevelInlineSpecs(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const context: EvalContext = {
    program,
    file: program.file,
    env: programGlobalEnv(program),
    inputRoots: [],
    stack: ['<top-level>'],
    checks: [],
    assumptions: [],
    contractCache,
    callObligations: 'silent',
  }
  for (const statement of program.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    bindVariableStatement(statement, context)
  }
  return context.checks
}

function functionHasBodyFitComment(program: Program, fn: FitFunction) {
  if (fn.node.body == null) return false
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (node !== fn.node.body && isFunctionLikeWithBody(node)) return
    if (hasInlineFitComment(program.sourceText, node) || hasFitComment(program.sourceText, node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  if (hasInlineFitComment(program.sourceText, fn.node)) return true
  visit(fn.node.body)
  return found
}

function functionHasTypeContracts(program: Program, fn: FitFunction) {
  return hasTypeContractWork(functionTypeGivenContract(program, fn))
    || hasTypeContractWork(functionTypeReturnContract(program, fn))
    || functionHasBodyTypeBoundary(program, fn)
}

function functionContractSpecs(program: Program, fn: FitFunction, explicitSpecs: FitSpec[] = program.specsByFunction.get(fn.name) ?? []): FitSpec[] {
  return [
    ...functionTypeGivenSpecs(program, fn),
    ...explicitSpecs,
    ...functionTypeReturnSpecs(program, fn),
  ]
}

function functionInputSpecs(program: Program, fn: FitFunction, explicitSpecs: FitSpec[] = program.specsByFunction.get(fn.name) ?? []): FitSpec[] {
  return [
    ...functionTypeGivenSpecs(program, fn),
    ...explicitSpecs,
  ]
}

function functionTypeGivenSpecs(program: Program, fn: FitFunction): FitGivenSpec[] {
  return functionTypeGivenContract(program, fn).specs
}

function functionTypeReturnSpecs(program: Program, fn: FitFunction): FitCheckSpec[] {
  return functionTypeReturnContract(program, fn).specs
}

function functionTypeGivenContract(program: Program, fn: FitFunction): TypeContractResult<FitGivenSpec> {
  return typeInputGivenContractForFunction(program, fn)
}

function functionTypeReturnContract(program: Program, fn: FitFunction): TypeContractResult<FitCheckSpec> {
  return typeReturnCheckContractForFunction(program, fn)
}

function functionTypeUnsupported(program: Program, fn: FitFunction) {
  return [
    ...functionTypeGivenContract(program, fn).unsupported,
    ...functionTypeReturnContract(program, fn).unsupported,
  ]
}

function hasTypeContractWork<T extends FitCheckSpec | FitGivenSpec>(contract: TypeContractResult<T>) {
  return contract.specs.length > 0 || contract.unsupported.length > 0
}

function functionHasBodyTypeBoundary(program: Program, fn: FitFunction) {
  if (fn.node.body == null) return false
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (node !== fn.node.body && isFunctionLikeWithBody(node)) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (hasTypeContractWork(typeCheckContractForTypeNode(program, node.type, node.name.text))) {
        found = true
        return
      }
      if (node.initializer != null && hasTypeContractWork(typeCheckContractForExpressionBoundary(program, node.initializer, node.name.text))) {
        found = true
        return
      }
    }
    if (ts.isReturnStatement(node) && node.expression != null && hasTypeContractWork(typeCheckContractForExpressionBoundary(program, node.expression, fitReturnPublicRoot))) {
      found = true
      return
    }
    if (node === fn.node.body && ts.isExpression(node) && hasTypeContractWork(typeCheckContractForExpressionBoundary(program, node, fitReturnPublicRoot))) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(fn.node.body)
  return found
}

function typeCheckContractForExpressionBoundary(program: Program, expression: ts.Expression, root: string): TypeContractResult<FitCheckSpec> {
  const type = expressionBoundaryType(expression)
  return type == null ? emptyTypeContract() : typeCheckContractForTypeNode(program, type, root)
}

function emptyTypeContract<T extends FitCheckSpec | FitGivenSpec>(): TypeContractResult<T> {
  return {specs: [], unsupported: []}
}

function mergeTypeContracts<T extends FitCheckSpec | FitGivenSpec>(contracts: TypeContractResult<T>[]): TypeContractResult<T> {
  return {
    specs: contracts.flatMap(contract => contract.specs),
    unsupported: contracts.flatMap(contract => contract.unsupported),
  }
}

function expressionBoundaryType(expression: ts.Expression): ts.TypeNode | null {
  if (ts.isParenthesizedExpression(expression)) return expressionBoundaryType(expression.expression)
  if (ts.isNonNullExpression(expression)) return expressionBoundaryType(expression.expression)
  if (ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return expression.type
  return null
}

function verifyFunctionSpecs(
  file: string,
  program: Program,
  fn: FitFunction,
  specs: FitSpec[],
  contractCache: Map<string, FunctionContractProof>,
): FitCheck[] {
  const functionName = fn.name
  const inputSpecs = functionInputSpecs(program, fn, specs)
  const contractSpecs = functionContractSpecs(program, fn, specs)
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, inputSpecs, program, env)

  const {assumedGivens, checks} = validateGivenSpecs(file, functionName, inputSpecs, inputRoots, 'function-given')
  checks.push(...typeUnsupportedChecks(file, functionName, functionTypeUnsupported(program, fn)))

  for (const given of assumedGivens) {
    if (given.kind !== 'range') continue
    applyGivenRangeSpec(env, given.spec)
  }

  const {assumptions, checks: impossibleChecks} = collectGivenAssumptions(file, program, functionName, env, inputRoots, assumedGivens, contractCache)
  checks.push(...impossibleChecks)
  const hasBodyClaims = functionHasBodyClaims(contractSpecs) || functionHasBodyFitComment(program, fn) || functionHasBodyTypeBoundary(program, fn)
  const context: EvalContext = {
    program,
    file,
    env,
    inputRoots,
    stack: [functionName],
    checks: [],
    assumptions,
    contractCache,
    callObligations: functionHasBodyClaims(contractSpecs) ? 'record' : 'silent',
  }
  const result = hasBodyClaims ? evaluateFunctionBody(fn, context) : unknown('No body claim requested')
  if (hasBodyClaims) checks.push(...context.checks)

  for (const spec of contractSpecs) {
    if (spec.kind === 'given-range' || spec.kind === 'given-comparison') continue
    checks.push(verifyCheckSpec(file, program, functionName, env, result, spec, checks, context.assumptions, contractCache))
  }

  return checks
}

function functionHasBodyClaims(specs: FitSpec[]) {
  return specs.some(spec => spec.kind !== 'given-range' && spec.kind !== 'given-comparison')
}

function inferFunctionFacts(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FitInferFunctionReport {
  const functionName = fn.name
  const specs = program.specsByFunction.get(functionName) ?? []
  const inputSpecs = functionInputSpecs(program, fn, specs)
  const contractSpecs = functionContractSpecs(program, fn, specs)
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)
  const loops: FitInferLoopReport[] = []

  bindFunctionInputParameters(fn, inputSpecs, program, env)

  const {assumedGivens, checks: givenChecks} = validateGivenSpecs(program.file, functionName, inputSpecs, inputRoots, 'function-given')
  for (const given of assumedGivens) {
    if (given.kind === 'range') applyGivenRangeSpec(env, given.spec)
  }
  const {assumptions, checks} = collectGivenAssumptions(program.file, program, functionName, env, inputRoots, assumedGivens, contractCache)
  const typeContractChecks = typeUnsupportedChecks(program.file, functionName, functionTypeUnsupported(program, fn))
  const inferUnsupported: string[] = []
  const context: EvalContext = {program, file: program.file, env, inputRoots, stack: [functionName], checks: [], assumptions, contractCache, inferLoops: loops, inferUnsupported}
  const state = evaluateFunctionBodyState(fn, context)
  const resultFacts = factsFromValue(fitReturnInternalRoot, state.result)
  const localFacts = localFactsFromEnv(env, state.env)
  const backgroundChecks = [
    ...givenChecks,
    ...typeContractChecks,
    ...checks,
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
    ...givenChecks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
    ...typeContractChecks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
    ...checks.filter(check => check.status !== 'pass').map(check => `${check.text}: ${check.reason ?? check.status}`),
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
    unsupported: [...new Set(unsupported)],
  }
}

function scoutFunctionCandidates(program: Program, fn: FitFunction): FitScoutCandidate[] {
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)
  bindFunctionInputParameters(fn, [], program, env)

  const context: EvalContext = {
    program,
    file: program.file,
    env,
    inputRoots,
    stack: [fn.name],
    checks: [],
    assumptions: [],
    contractCache: new Map(),
    callObligations: 'silent',
  }
  const state = evaluateFunctionBodyState(fn, context)
  if (state.result.kind !== 'number') return []

  const candidates: FitScoutCandidate[] = []
  for (const paramName of scoutNumericParameterNames(fn, env)) {
    for (const op of ['>=', '<='] as const) {
      const fact = `return ${op} ${paramName}`
      const spec = parseFitSpecLine(fact)
      if (spec.kind !== 'check-comparison') continue
      const check = verifyCheckSpec(program.file, program, fn.name, env, state.result, spec, [], state.assumptions, new Map())
      const requirements = scoutRequirementsFromReason(check.reason)
      if (requirements.length === 0) continue
      candidates.push({file: program.file, functionName: fn.name, fact, requirements})
    }
  }
  return uniqueScoutCandidates(candidates)
}

type FunctionShapeState = {
  baseEnv: Map<string, Value>
  env: Map<string, Value>
  result: Value
}

function inspectFunctionShapes(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>, options: FitShapeOptions): FitShapeInsight[] {
  const functionName = fn.name
  const insights: FitShapeInsight[] = []
  const state = options.functionName != null || program.fitFunctions.has(functionName) || functionHasBodyFitComment(program, fn) || functionHasTypeContracts(program, fn)
    ? evaluateFunctionShapeState(program, fn, contractCache)
    : null

  for (const param of fn.node.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    const subject = `param ${param.name.text}`
    const freerange = state?.baseEnv.get(param.name.text) ?? valueFromSyntaxTypeShape(param.name.text, param.type, program, new Set())
    const typescript = valueFromNodeShape(param.name.text, param.name, program)
    addShapeInsight(insights, program, functionName, subject, param.name.text, freerange, typescript)
  }

  const syntaxReturn = valueFromSyntaxTypeShape(fitReturnPublicRoot, fn.node.type, program, new Set())
  const tsReturn = valueFromFunctionReturnShape(fitReturnPublicRoot, fn.node, program)
  addShapeInsight(insights, program, functionName, 'return type', fitReturnPublicRoot, state?.result ?? syntaxReturn, tsReturn)

  if (fn.node.body != null && (state != null || options.calls === true)) {
    collectShapeInsightsFromNode(fn.node.body, program, functionName, state, options, insights)
  }

  return insights
}

function evaluateFunctionShapeState(program: Program, fn: FitFunction, contractCache: Map<string, FunctionContractProof>): FunctionShapeState {
  const functionName = fn.name
  const specs = program.specsByFunction.get(functionName) ?? []
  const inputSpecs = functionInputSpecs(program, fn, specs)
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, inputSpecs, program, env)

  const {assumedGivens} = validateGivenSpecs(program.file, functionName, inputSpecs, inputRoots, 'function-given')
  for (const given of assumedGivens) {
    if (given.kind === 'range') applyGivenRangeSpec(env, given.spec)
  }
  const {assumptions} = collectGivenAssumptions(program.file, program, functionName, env, inputRoots, assumedGivens, contractCache)
  const context: EvalContext = {program, file: program.file, env, inputRoots, stack: [functionName], checks: [], assumptions, contractCache}
  const baseEnv = new Map(env)
  const state = evaluateFunctionBodyState(fn, context)
  return {baseEnv, env: state.env, result: state.result}
}

function collectShapeInsightsFromNode(node: ts.Node, program: Program, functionName: string, state: FunctionShapeState | null, options: FitShapeOptions, insights: FitShapeInsight[]) {
  if (node !== program.sourceFile && isNestedFunctionLike(node)) return

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const freerange = state?.env.get(node.name.text) ?? valueFromSyntaxTypeShape(node.name.text, node.type, program, new Set())
    const typescript = valueFromNodeShape(node.name.text, node.name, program)
    addShapeInsight(insights, program, functionName, `local ${node.name.text}`, node.name.text, freerange, typescript)
  }

  if (options.calls === true && ts.isCallExpression(node)) {
    const typescript = structuralShape(valueFromCallReturnShape('shape', node, program))
    addShapeInsight(insights, program, functionName, `call ${compactNodeText(node, program.sourceFile)}`, 'shape', null, typescript)
  }

  ts.forEachChild(node, child => collectShapeInsightsFromNode(child, program, functionName, state, options, insights))
}

function isNestedFunctionLike(node: ts.Node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

function addShapeInsight(
  insights: FitShapeInsight[],
  program: Program,
  functionName: string,
  subject: string,
  root: string,
  freerangeValue: Value | null,
  typescriptValue: Value | null,
) {
  const typescript = shapeFactTexts(root, typescriptValue)
  if (typescript.length === 0) return
  const freerange = shapeFactTexts(root, freerangeValue)
  const extra = typescript.filter(fact => !freerangeFactsImply(freerange, fact))
  if (extra.length === 0) return
  insights.push({file: program.file, functionName, subject, freerange, typescript: extra})
}

function freerangeFactsImply(facts: string[], fact: string) {
  if (facts.includes(fact)) return true
  const shape = shapeFactParts(fact)
  if (shape == null) return false
  return facts.some(candidate => factAtPathImpliesShapeFact(candidate, shape.path, shape.description))
}

function factAtPathImpliesShapeFact(fact: string, path: string, description: string) {
  if (description === 'number') {
    return fact.startsWith(`${path}: `) || fact.startsWith(`${path} == `)
  }
  if (description === 'int 0..Infinity') {
    const range = rangeFactAtPath(fact, path)
    if (range != null) return range.isInteger && range.min >= 0
    const equal = equalityFactRightAtPath(fact, path)
    return equal != null && expressionIsClearlyNonnegativeInteger(equal)
  }
  return false
}

function rangeFactAtPath(fact: string, path: string): {isInteger: boolean; min: number; max: number} | null {
  return rangeFactForExpression(fact, path)
}

function rangeFactForExpression(fact: string, expression: string): {isInteger: boolean; min: number; max: number} | null {
  if (!fact.startsWith(`${expression}: `)) return null
  const text = fact.slice(expression.length + 2)
  const match = /^(int )?(-?(?:\d+(?:\.\d+)?|Infinity))\.\.(-?(?:\d+(?:\.\d+)?|Infinity))$/.exec(text)
  if (match == null) return finiteNumberUnionRange(text)
  const min = parsePrintedNumber(match[2]!)
  const max = parsePrintedNumber(match[3]!)
  return min == null || max == null ? null : {isInteger: match[1] != null, min, max}
}

function finiteNumberUnionRange(text: string): {isInteger: boolean; min: number; max: number} | null {
  const values = text.split('|').map(part => parsePrintedNumber(part.trim()))
  if (values.length <= 1 || values.some(value => value == null)) return null
  const numbers = values as number[]
  return {
    isInteger: numbers.every(Number.isInteger),
    min: Math.min(...numbers),
    max: Math.max(...numbers),
  }
}

function parsePrintedNumber(text: string): number | null {
  if (text === 'Infinity') return Number.POSITIVE_INFINITY
  if (text === '-Infinity') return Number.NEGATIVE_INFINITY
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function equalityFactRightAtPath(fact: string, path: string): string | null {
  const prefix = `${path} == `
  return fact.startsWith(prefix) ? fact.slice(prefix.length).trim() : null
}

function expressionIsClearlyNonnegativeInteger(expression: string) {
  if (/^\d+$/.test(expression)) return true
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\])*\.(?:length)$/.test(expression)
}

function shapeFactParts(fact: string): {path: string; description: string} | null {
  const index = fact.indexOf(': ')
  if (index < 0) return null
  return {
    path: fact.slice(0, index),
    description: fact.slice(index + 2),
  }
}

function shapeFactTexts(root: string, value: Value | null): string[] {
  if (value == null) return []
  return [...new Set(shapeFactsFromValue(root, value))]
}

function shapeFactsFromValue(path: string, value: Value): string[] {
  if (value.kind === 'unknown') return []
  if (value.kind === 'null' || value.kind === 'nullable') return []
  if (value.kind === 'literal') return []
  if (value.kind === 'number') {
    if (!isStructuralShapePath(path)) return []
    const facts = numberFacts(path, value).map(fact => fact.text)
    return facts.length === 0 ? [`${path}: number`] : facts
  }
  if (value.kind === 'object') {
    const facts: string[] = []
    for (const [name, prop] of [...value.props.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      facts.push(...shapeFactsFromValue(`${path}.${name}`, prop))
    }
    return facts
  }

  const facts = numberFacts(`${path}.length`, value.length).map(fact => fact.text)
  if (value.element != null) facts.push(...shapeFactsFromValue(`${path}[]`, value.element))
  return facts
}

function compactNodeText(node: ts.Node, sourceFile: ts.SourceFile) {
  return node.getText(sourceFile)
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ ,/g, ',')
    .replace(/, \)/g, ')')
    .replace(/ \)/g, ')')
    .trim()
}

function isStructuralShapePath(path: string) {
  return path.includes('.') || path.includes('[]')
}

function bindFunctionInputParameters(fn: FitFunction, specs: FitSpec[], program: Program, env: Map<string, Value>) {
  if (functionHasInstanceThisInput(fn)) {
    env.set('this', unknownParamValue('this', specs, undefined, program))
  }
  for (const param of fn.node.parameters) {
    if (ts.isIdentifier(param.name)) {
      env.set(param.name.text, unknownParamValue(param.name.text, specs, param.type, program, param.name))
      continue
    }
    bindPatternFromValue(param.name, unknownParamPatternValue(param, program), env)
  }
}

function bindFunctionArgumentParameters(fn: FitFunction, argumentValues: Value[], env: Map<string, Value>, program: Program, options: LocalizeOptions = {}) {
  for (let i = 0; i < fn.node.parameters.length; i++) {
    const param = fn.node.parameters[i]!
    const value = argumentValues[i] ?? unknown(`Missing argument ${i} for ${fn.name}`)
    bindPatternFromValue(param.name, parameterArgumentValue(param, value, program), env, options)
  }
}

function parameterArgumentValue(param: ts.ParameterDeclaration, value: Value, program: Program): Value {
  const expr = ts.isIdentifier(param.name) ? param.name.text : 'param'
  return valueWithStructuralFallback(value, valueFromSyntaxTypeShape(expr, param.type, program, new Set()))
}

function bindFunctionCallInputs(fn: FitFunction, argumentValues: Value[], env: Map<string, Value>, program: Program, thisValue?: Value) {
  if (functionHasInstanceThisInput(fn)) {
    env.set('this', localizeValue(thisValue ?? unknownObject('this'), 'this', {preserveLinear: true}))
  }
  bindFunctionArgumentParameters(fn, argumentValues, env, program, {preserveLinear: true})
}

function unknownParamPatternValue(param: ts.ParameterDeclaration, program: Program): Value {
  return valueFromNodeShape('param', param.name, program)
    ?? valueFromSyntaxTypeShape('param', param.type, program, new Set())
    ?? unknownObject('param')
}

function bindPatternFromValue(name: ts.BindingName, value: Value, env: Map<string, Value>, options: LocalizeOptions = {}) {
  if (ts.isIdentifier(name)) {
    env.set(name.text, localizeValue(value, name.text, options))
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (element.dotDotDotToken != null) continue
      const propertyName = bindingElementPropertyName(element)
      if (propertyName == null) {
        bindUnknownPattern(element.name, env)
        continue
      }
      const prop = value.kind === 'object'
        ? value.props.get(propertyName) ?? unknownNumber(`${value.expr ?? 'param'}.${propertyName}`)
        : unknown(`Destructuring property ${propertyName} expected an object`)
      bindPatternFromValue(element.name, prop, env, options)
    }
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    bindArrayPatternFromValue(name, value, env, options)
    return
  }
  bindUnknownPattern(name, env)
}

function bindArrayPatternFromValue(name: ts.ArrayBindingPattern, value: Value, env: Map<string, Value>, options: LocalizeOptions = {}) {
  forEachArrayBindingElement(name, (elementName, index, isRest) => {
    if (isRest) {
      bindUnknownPattern(elementName, env)
      return
    }
    const item = arrayPatternElementValue(value, index)
    bindPatternFromValue(elementName, item, env, options)
  })
}

function bindUnknownPattern(name: ts.BindingName, env: Map<string, Value>) {
  if (ts.isIdentifier(name)) {
    env.set(name.text, unknownNumber(name.text))
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) bindUnknownPattern(element.name, env)
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    forEachArrayBindingElement(name, elementName => bindUnknownPattern(elementName, env))
  }
}

function validateGivenSpecs(
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

function closedRangeApprox(range: FitRange): {min: number; max: number} | null {
  const lower = range.lowerValue ?? Number.NEGATIVE_INFINITY
  const upper = range.upperValue ?? Number.POSITIVE_INFINITY
  const min = range.valueKind === 'int' && range.lowerValue != null && !range.lowerInclusive
    ? Math.floor(lower) + 1
    : lower
  const max = range.valueKind === 'int' && range.upperValue != null && !range.upperInclusive
    ? Math.ceil(upper) - 1
    : upper
  if (!Number.isFinite(min) && !Number.isFinite(max) && min === Number.NEGATIVE_INFINITY && max === Number.POSITIVE_INFINITY) return null
  return {min, max}
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

function collectGivenAssumptions(
  file: string,
  program: Program,
  functionName: string,
  env: Map<string, Value>,
  inputRoots: string[],
  givens: AssumedGivenSpec[],
  contractCache: Map<string, FunctionContractProof>,
): {assumptions: LinearConstraint[]; checks: FitCheck[]} {
  const assumptions: LinearConstraint[] = []
  const checks: FitCheck[] = []
  const context: EvalContext = {program, file, env, inputRoots, stack: [functionName], checks: [], assumptions, contractCache}
  for (const given of givens) {
    if (given.kind === 'range') {
      const spec = given.spec
      const value = evaluateSpecExpression(spec.expression, context)
      if (value.kind !== 'number') continue
      const lower = evaluateRangeBound(spec.range.lower, context)
      const upper = evaluateRangeBound(spec.range.upper, context)
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
    const left = evaluateSpecExpression(spec.left, context)
    const right = evaluateSpecExpression(spec.right, context)
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
    const fact = comparisonFactFromSpec(spec, context, given.source)
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

function comparisonFactFromSpec(spec: Extract<FitSpec, {kind: 'given-comparison'}>, context: EvalContext, source: FactSource): LinearConstraint | null {
  const left = evaluateSpecExpression(spec.left, context)
  const right = evaluateSpecExpression(spec.right, context)
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

function applyGivenRangeSpec(env: Map<string, Value>, spec: Extract<FitSpec, {kind: 'given-range'}>) {
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

function unknownParamValue(name: string, specs: FitSpec[], type: ts.TypeNode | undefined, program: Program, node?: ts.Node): Value {
  const typed = (node == null ? null : valueFromNodeShape(name, node, program)) ?? valueFromSyntaxTypeShape(name, type, program, new Set())
  if (typed != null) return typed

  const shape = specParamShape(name, specs)
  if (shape === 'array') return unknownArray(name)
  if (shape === 'object') return unknownObject(name)
  return unknownNumber(name)
}

function unknownResultValue(specs: FitSpec[], program: Program): Value {
  return unknownParamValue(fitReturnInternalRoot, specs, undefined, program)
}

function specParamShape(name: string, specs: FitSpec[]): 'array' | 'object' | 'number' {
  let shape: 'object' | 'number' = 'number'
  for (const spec of specs) {
    if (spec.kind === 'given-range' || spec.kind === 'check-range') {
      const next = specExpressionParamShape(spec.expression, name)
      if (next === 'array') return 'array'
      if (next === 'object') shape = 'object'
      continue
    }
    if (spec.kind === 'check-atom') {
      for (const arg of spec.args) {
        const next = specExpressionParamShape(arg, name)
        if (next === 'array') return 'array'
        if (next === 'object') shape = 'object'
      }
      continue
    }
    for (const expression of [spec.left, spec.right]) {
      const next = specExpressionParamShape(expression, name)
      if (next === 'array') return 'array'
      if (next === 'object') shape = 'object'
    }
  }
  return shape
}

function specExpressionParamShape(text: string, name: string): 'array' | 'object' | 'number' {
  const parsed = parseFitExpression(text)
  for (const domainPath of parsed.domainPaths.values()) {
    if (domainPath.root !== name) continue
    return domainPath.segments[0]?.kind === 'item' ? 'array' : 'object'
  }
  if (expressionMentionsArrayParam(parsed.expression, name)) return 'array'
  if (expressionMentionsObjectParam(parsed.expression, name)) return 'object'
  return 'number'
}

function setDomainPathValue(current: Value | undefined, expr: string, segments: FitDomainPathSegment[], value: Value): Value {
  const segment = segments[0]
  if (segment == null) return value

  if (segment.kind === 'prop') {
    if (current?.kind === 'array' && segment.name === 'length') {
      const length = setDomainPathValue(current.length, `${expr}.length`, segments.slice(1), value)
      return length.kind === 'number' ? {...current, length} : current
    }
    const base = current?.kind === 'object' ? current : unknownObject(expr)
    const props = new Map(base.props)
    const propExpr = `${expr}.${segment.name}`
    props.set(segment.name, setDomainPathValue(props.get(segment.name), propExpr, segments.slice(1), value))
    return {...base, props}
  }

  const objectLength = current?.kind === 'object' ? current.props.get('length') : null
  const base = current?.kind === 'array'
    ? current
    : unknownArray(expr, objectLength?.kind === 'number' ? objectLength : undefined)
  return {
    ...base,
    element: setDomainPathValue(base.element ?? undefined, `${expr}[]`, segments.slice(1), value),
  }
}

function evaluateDomainPath(domainPath: FitDomainPath, context: EvalContext): Value {
  const root = context.env.get(domainPath.root) ?? unknown(unknownIdentifierReason(domainPath.root))
  return evaluateDomainPathSegments(root, domainPath.root, domainPath.segments)
}

function evaluateDomainPathSegments(current: Value, expr: string, segments: FitDomainPathSegment[]): Value {
  const segment = segments[0]
  if (segment == null) return current

  if (segment.kind === 'item') {
    if (current.kind !== 'array') return unknown(`${expr} expected an array`)
    const item = current.element ?? (segments[1]?.kind === 'prop' ? unknownObject(`${expr}[]`) : unknownNumber(`${expr}[]`))
    return evaluateDomainPathSegments(item, `${expr}[]`, segments.slice(1))
  }

  if (current.kind === 'array' && segment.name === 'length') {
    return evaluateDomainPathSegments(current.length, `${expr}.length`, segments.slice(1))
  }
  if (current.kind === 'object') {
    const prop = current.props.get(segment.name) ?? (current.expr == null ? unknown(`Unknown property ${segment.name}`) : unknownNumber(`${current.expr}.${segment.name}`))
    return evaluateDomainPathSegments(prop, `${expr}.${segment.name}`, segments.slice(1))
  }
  return unknown(`${publicFitText(`${expr}.${segment.name}`)} expected an object`)
}

const checkSpecHooks: CheckSpecHooks = {
  evaluateExpression: (expression, context) => evaluateCheckedExpression(expression, context),
  evaluateDomainPath: (domainPath, context) => evaluateDomainPath(domainPath, context),
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
): FitCheck {
  const check = verifyParsedCheckSpec(file, program, functionName, baseEnv, result, spec, checks, assumptions, contractCache, checkSpecHooks)
  return boundary == null ? check : {...check, ...boundary}
}

function proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  return proveParsedRangeSpec(value, range, context, checkSpecHooks)
}

function evaluateRangeBound(text: string, context: EvalContext): Value {
  return evaluateParsedRangeBound(text, context, checkSpecHooks)
}

function evaluateSpecExpression(text: string, context: EvalContext): Value {
  return evaluateParsedSpecExpression(text, context, checkSpecHooks)
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
  const callContext: EvalContext = {
    ...rootContext,
    program: frame.program,
    file: frame.program.file,
    env: frame.env,
    stack: frame.stack,
    assumptions: frame.assumptions,
    checks: shouldRecordCallObligations(rootContext) ? rootContext.checks : [],
    ...(rootContext.callObligations == null ? {} : {callObligations: rootContext.callObligations}),
  }
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
  }, call.fn, callArguments.values, callText, callLine, callContext, call.fallback, callSiteBindings)
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
    verifyCheckSpecsWithResult(typeContract.specs, unknown('Inline @fit checks do not use return'), context, boundary)
    return
  }

  if (claim.kind === 'return') {
    const specs = parseInlineFitSpecsForExpression(frame.program.sourceText, claim.node, fitReturnPublicRoot)
    const typeContract = typeCheckContractForExpressionBoundary(frame.program, claim.expression, fitReturnPublicRoot)
    verifyInlineSpecsForValue(specs, value, context)
    const boundary = checkBoundaryForNode(frame.program.sourceFile, claim.node)
    pushTypeUnsupportedChecks(context, typeContract.unsupported, boundary)
    verifyCheckSpecsWithResult(typeContract.specs, value, context, boundary)
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
  return {
    ...rootContext,
    program: frame.program,
    file: frame.program.file,
    env: frame.env,
    stack: sameClaimBodyStack(frame.stack, rootContext.stack) ? rootContext.stack : frame.stack,
    checks: rootContext.checks,
    assumptions: frame.assumptions,
    ...(frame.objectPath == null ? {} : {objectPath: frame.objectPath}),
  }
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
  bindName(declaration.name, valueWithBindingShapeFallback(declaration.name, value, context), context)
  const boundary = checkBoundaryForNode(context.program.sourceFile, declaration)
  pushTypeUnsupportedChecks(context, typeContract.unsupported, boundary)
  verifyCheckSpecsWithResult(typeSpecs, unknown('Inline @fit checks do not use return'), context, boundary)
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

function verifyCheckSpecsWithResult(specs: FitCheckSpec[], result: Value, context: EvalContext, boundary?: CheckBoundary) {
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
    ))
  }
}

function valueWithBindingShapeFallback(name: ts.BindingName, value: Value, context: EvalContext): Value {
  if (!ts.isIdentifier(name)) return value
  return valueWithStructuralFallback(value, valueFromNodeShape(name.text, name, context.program))
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

function arrayPatternElementValue(value: Value, index: number): Value {
  if (value.kind !== 'array') return unknown(`Array destructuring expected an array`)
  return tupleElements(value)?.[index]
    ?? value.element
    ?? unknownNumber(`${value.expr ?? 'array'}[${index}]`)
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

function specExpressionTexts(spec: FitSpec): string[] {
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

function expressionTextMentionsRoot(text: string, root: string) {
  const parsed = parseFitExpression(text)
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
  })

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
  }, fallbackResult, options.thisValue, options.callSiteBindings)
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
  if (functionHasInstanceThisInput(fn)) {
    env.set('this', localizeValue(thisValue ?? unknownObject('this'), 'this', {preserveLinear: true}))
  }

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
    {record: true, callLine, callSiteBindings},
  )
  if (obligations !== 'pass') return unknown(`Imported call ${target.functionName} precondition was not proven`)

  return valueWithFunctionContractSummary(callName, target.module, fn, contractSpecs, argumentValues, context.contractCache, {
    kind: 'imported',
    sourceFile: target.module.file,
    sourceFunctionName: fn.name,
  }, resolvedStructuralFallback ?? unknownResultValue(contractSpecs, target.module), undefined, callSiteBindings)
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
    : checks.some(check => check.status === 'unknown') ? 'unknown'
      : 'pass'
  const proof: FunctionContractProof = {status, checks}
  contractCache.set(key, proof)
  return proof
}

function importedContractUnavailableReason(localName: string, binding: ImportedBinding, detail: string) {
  return [
    'imported helper contract was not available',
    `helper: ${importedHelperLabel(localName, binding)}`,
    `reason: ${detail}`,
  ].join('\n')
}

function importedContractFailureReason(localName: string, binding: Extract<ImportedBinding, {kind: 'resolved'}>, proof: FunctionContractProof) {
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

function valueWithFunctionContractSummary(
  functionName: string,
  program: Program,
  fn: FitFunction,
  specs: FitSpec[],
  argumentValues: Value[],
  contractCache: Map<string, FunctionContractProof>,
  source: FunctionContractSource,
  result: Value,
  thisValue?: Value,
  callSiteBindings?: CallSiteBindings,
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
    if (spec.kind === 'check-range') applySummaryRangeSpec(env, spec, context, source)
  }
  for (const spec of specs) {
    if (spec.kind === 'check-comparison') applySummaryComparisonSpec(env, spec, context, source)
  }

  const summary = env.get(fitReturnInternalRoot) ?? unknown(`Imported function ${functionName} contract did not describe return`)
  return valueWithCallSiteText(summary, callSiteBindings)
}

function applySummaryRangeSpec(
  env: Map<string, Value>,
  spec: Extract<FitSpec, {kind: 'check-range'}>,
  context: EvalContext,
  source: FunctionContractSource,
) {
  if (simpleResultPathText(spec.expression) == null) return
  const closed = closedRangeApprox(spec.range)
  if (closed == null) return
  const current = evaluateSpecExpression(spec.expression, context)
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
) {
  const leftPath = simpleResultPathText(spec.left)
  const rightPath = simpleResultPathText(spec.right)
  const fact = checkedContractFact(source, spec.text)
  if (leftPath != null && rightPath == null) {
    const right = evaluateSpecExpression(spec.right, context)
    if (right.kind === 'number') applySummaryComparisonToPath(env, context, leftPath, spec.op, right, fact)
    return
  }
  if (rightPath != null && leftPath == null) {
    const left = evaluateSpecExpression(spec.left, context)
    if (left.kind === 'number') applySummaryComparisonToPath(env, context, rightPath, flipComparison(spec.op), left, fact)
  }
}

function applySummaryComparisonToPath(
  env: Map<string, Value>,
  context: EvalContext,
  path: string,
  op: ComparisonOperator,
  other: NumberValue,
  fact: string,
) {
  const current = evaluateSpecExpression(path, context)
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

function finiteElementAccessRoot(expression: ts.Expression): {root: string; index: number} | null {
  const current = unwrapExpression(expression)
  if (!ts.isElementAccessExpression(current)) return null
  const index = numericLiteralValue(current.argumentExpression)
  if (index == null || !Number.isInteger(index) || index < 0) return null
  const root = expressionRootName(current.expression)
  return root == null ? null : {root, index}
}

function setFiniteArrayElementValue(current: Value | undefined, expr: string, index: number, value: Value): Value {
  const base = current?.kind === 'array' ? current : unknownArray(expr)
  const elements = base.elements == null ? [] : [...base.elements]
  while (elements.length <= index) {
    elements.push(base.element ?? unknownNumber(`${expr}[${elements.length}]`))
  }
  elements[index] = value
  return {...base, layout: 'tuple', elements}
}

function verifyCallGivenSpecs(
  calleeProgram: Program,
  fn: FitFunction,
  callText: string,
  argumentValues: Value[],
  context: EvalContext,
  options: {record: boolean; callLine?: number | undefined; thisValue?: Value | undefined; callSiteBindings?: CallSiteBindings | undefined},
) {
  const specs = functionContractSpecs(calleeProgram, fn)
  const env = programGlobalEnv(calleeProgram)
  let statusSummary: FitCheckStatus = 'pass'
  bindFunctionCallInputs(fn, argumentValues, env, calleeProgram, options.thisValue)
  const calleeContext: EvalContext = {...context, program: calleeProgram, env, inputRoots: functionInputRoots(calleeProgram, fn)}

  for (const spec of specs) {
    let status: {status: FitCheckStatus; reason?: string} | null = null
    if (spec.kind === 'given-range') {
      const value = evaluateSpecExpression(spec.expression, calleeContext)
      status = proveRangeSpec(value, spec.range, calleeContext)
      if (status.status !== 'pass') status = withCallRangeReason(status, value, spec, options.callSiteBindings)
    }
    if (spec.kind === 'given-comparison') {
      const left = evaluateSpecExpression(spec.left, calleeContext)
      const right = evaluateSpecExpression(spec.right, calleeContext)
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

function unknownIdentifierReason(name: string) {
  return `Unknown identifier ${name}`
}
