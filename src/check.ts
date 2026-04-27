import * as ts from 'typescript'
import {
  loadFitProject,
  resolveFitExport,
  type FitCallAlias,
  type FitFunction,
  type FitImportBinding,
  type FitModule,
} from './modules.ts'
import {
  proveBoundIndexComparisonSpec,
  proveBoundIndexRangeSpec,
  type BoundIndexContext,
} from './bound-index.ts'
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
  type FitRange,
  type FitSpec,
} from './parser.ts'
import {
  addNumbers,
  callExpr,
  conditionalRunningSumNumber,
  divideNumbers,
  finiteNumberSet,
  finiteNumberValue,
  joinValues,
  linearNameForExpression,
  maxNumberCases,
  mergeArraySummary,
  mergeAssumptions,
  mergeElementValue,
  mergeProvenance,
  moduloNumbers,
  multiplyNumbers,
  nullValue,
  nullableValue,
  numberBranches,
  numberValue,
  plainNumber,
  powerNumbers,
  runningSumNumber,
  subtractNumbers,
  unknown,
  unknownArray,
  unknownArrayLength,
  unknownNumber,
  unknownObject,
  valueWithAssumptions,
  withNumberCases,
  type ArrayOrigin,
  type ArraySummary,
  type ArrayValue,
  type FactSource,
  type LinearConstraint,
  type NullishKind,
  type NumberCase,
  type NumberValue,
  type Value,
} from './domain.ts'
import {
  combineNumberCases,
  comparisonConditionFacts,
  negatedComparison,
  refineNumberCasesForComparison,
  stablePlainConditionOperand,
  type ConditionFacts,
} from './guarded-facts.ts'
import {
  adjacentElementAccessFacts,
  elementValueForIndexCases,
  valueWithRebasedElementPath,
} from './indexed-facts.ts'
import {
  applyLoopExtrema,
  applySegmentedStackCursorUpdate,
  conditionalPushLength,
  indexedElementPathValue,
  indexedLoopElementFromPush,
  loopElementFromPush,
  loopExtremaConflictWithAdds,
  pushedElementValue,
  segmentedStackElement,
  segmentedStackSummary,
  sequenceSummaryFromLoopPush,
  type GuardedLoopPush,
  type LoopExtremum,
  type LoopPush,
  type LoopScalarUpdate,
} from './loop-summary.ts'
import {
  indexedLoopShape,
  isPushCall,
  readConditionalLoopAdd,
  readGuardedLoopPushes,
  readLoopExtremumAssignment,
  readLoopPush,
  readLoopScalarAdd,
  type IndexedLoopShape,
  type LoopSourceContext,
} from './loop-source.ts'
import {
  cleanLinear,
  linearAdd,
  linearConstant,
  linearEpsilon,
  linearScaleExact,
  linearScale,
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
  conditionalRunningSumFacts,
  flipComparison,
  nonNegativeFacts,
  proveNonNegativeFromFacts,
  proveComparison,
  proveComparisonPlain,
  rangeFactsFromBounds,
  type NonNegativeFact,
} from './proof.ts'
import {
  comparisonNeed,
  formatArraySummary,
  formatExpectedRange,
  formatRangeSpec,
  formatRange,
  finiteRangeSpecFailureReason,
  rangeSpecFailureReason,
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
  adjacentComparisonText,
  hasNondecreasingProp,
  provedSpacing,
  proveAdjacentComparison,
  sequenceRelationText,
} from './sequence-facts.ts'
import {
  factsFromEnvRoots,
  factsFromValue,
  localFactsFromEnv,
  numberFacts,
  uniqueFacts,
  type FitInferFact,
} from './facts.ts'
import {
  inferFunctionSpecReports,
  redundantSpecs,
  topUnknownReason,
  type FitInferRedundantSpec,
  type FitInferSpec,
  type FitInferSpecStatus,
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

export type FitCheckStatus = 'pass' | 'fail' | 'unknown'

export type FitCheck = {
  file: string
  line?: number
  functionName: string
  text: string
  status: FitCheckStatus
  reason?: string
}

export type FitDoctorStatus = 'pass' | 'fail' | 'requires' | 'unknown'

export type FitDoctorCheck = {
  file: string
  line?: number
  functionName: string
  text: string
  status: FitDoctorStatus
  reason?: string
}

export type {FitScoutCandidate, FitScoutReport} from './scout.ts'
export type {FitInferRedundantSpec, FitInferSpec, FitInferSpecStatus} from './infer-report.ts'

export type FitInferLoopSpecStatus = FitInferSpecStatus
export type FitInferLoopSpec = FitInferSpec

export type FitInferLoopReport = {
  line: number
  kind: 'for-of' | 'for'
  header: string
  facts: FitInferFact[]
  specs: FitInferLoopSpec[]
  redundant: FitInferRedundantSpec[]
  unsupported: string[]
}

export type FitInferFunctionReport = {
  file: string
  functionName: string
  facts: FitInferFact[]
  locals: FitInferFact[]
  specs: FitInferSpec[]
  redundant: FitInferRedundantSpec[]
  loops: FitInferLoopReport[]
  unsupported: string[]
}

export type FitInferReport = {
  files: string[]
  functions: FitInferFunctionReport[]
}

export type FitShapeInsight = {
  file: string
  functionName: string
  subject: string
  freerange: string[]
  typescript: string[]
}

export type FitShapeReport = {
  files: string[]
  insights: FitShapeInsight[]
}

export type FitShapeOptions = {
  functionName?: string
  all?: boolean
  calls?: boolean
}

type Program = FitModule<NumberValue>

type ImportedBinding = FitImportBinding<Program>

type ResolvedCallTarget =
  | {
      kind: 'math'
      name: string
    }
  | {
      kind: 'function'
      module: Program
      functionName: string
      imported?: {
        localName: string
        binding: Extract<ImportedBinding, {kind: 'resolved'}>
      }
    }
  | {
      kind: 'unresolved'
      reason: string
    }

export type FunctionContractProof =
  | {status: 'verifying'}
  | {status: FitCheckStatus; checks: FitCheck[]}

type WildcardUse =
  | {kind: 'none'}
  | {kind: 'one'; collection: string}
  | {kind: 'unsupported'; reason: string}

type EvalContext = {
  program: Program
  file: string
  env: Map<string, Value>
  inputRoots: string[]
  stack: string[]
  checks: FitCheck[]
  assumptions: LinearConstraint[]
  contractCache: Map<string, FunctionContractProof>
  callObligations?: 'record' | 'silent'
  objectPath?: string[]
  inferLoops?: FitInferLoopReport[]
  inferUnsupported?: string[]
  insideLoop?: true
}

type EvalFlow =
  | {kind: 'return'; value: Value}
  | {kind: 'exit'}
  | {kind: 'fallthrough'}

type ArrayCallbackFunction = ts.ArrowFunction | ts.FunctionExpression

type PresenceGuard = {
  target: ts.Expression
  nullish: NullishKind
  presentWhenTrue: boolean
}

type LocalizeOptions = {
  preserveLinear?: boolean
}

const maxInlineDepth = 12

type AssumedGivenSpec =
  | {kind: 'range'; spec: Extract<FitSpec, {kind: 'given-range'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}
  | {kind: 'comparison'; spec: Extract<FitSpec, {kind: 'given-comparison'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}

type ImportedContractSource = {
  sourceFile: string
  sourceFunctionName: string
}

type FunctionContractSource = ImportedContractSource & {
  kind: 'imported' | 'local'
}

export function inferFitFiles(paths: string[], options: {functionName?: string; all?: boolean} = {}): FitInferReport {
  const project = loadFitProject(paths, readTopLevelNumberGlobal)
  const contractCache = new Map<string, FunctionContractProof>()
  const functions: FitInferFunctionReport[] = []
  for (const program of project.entries) {
    for (const [functionName, fn] of program.functions) {
      if (options.functionName != null && functionName !== options.functionName) continue
      if (options.functionName == null && options.all !== true && !program.fitFunctions.has(functionName) && !functionHasBodyFitComment(program, fn)) continue
      functions.push(inferFunctionFacts(program, fn, contractCache))
    }
  }
  return {files: paths, functions}
}

export function scoutFitFiles(paths: string[], options: {functionName?: string} = {}): FitScoutReport {
  const project = loadFitProject(paths, readTopLevelNumberGlobal)
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
  const project = loadFitProject(paths, readTopLevelNumberGlobal)
  const contractCache = new Map<string, FunctionContractProof>()
  const insights: FitShapeInsight[] = []
  for (const program of project.entries) {
    for (const [functionName, fn] of program.functions) {
      if (options.functionName != null && functionName !== options.functionName) continue
      if (options.functionName == null && options.all !== true && !program.fitFunctions.has(functionName) && !functionHasBodyFitComment(program, fn)) continue
      insights.push(...inspectFunctionShapes(program, fn, contractCache, options))
    }
  }
  return {files: paths, insights}
}

export function createFunctionContractCache(): Map<string, FunctionContractProof> {
  return new Map<string, FunctionContractProof>()
}

export function readTopLevelNumberGlobal(declaration: ts.VariableDeclaration): {name: string; value: NumberValue} | null {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) return null
  const literal = numericLiteralValue(declaration.initializer)
  if (literal == null) return null
  return {
    name: declaration.name.text,
    value: numberValue(literal, literal, Number.isInteger(literal), declaration.name.text, linearConstant(literal)),
  }
}

export function verifyFitProgram(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const checks: FitCheck[] = []
  for (const fn of program.functions.values()) {
    const specs = program.specsByFunction.get(fn.name) ?? []
    if (specs.length === 0 && !functionHasBodyFitComment(program, fn)) continue
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
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, specs, program, env)

  const {assumedGivens} = validateGivenSpecs(program.file, functionName, specs, inputRoots, 'function-given')
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

function isFunctionLikeWithBody(node: ts.Node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
}

function lineNumberForNode(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function verifyFunctionSpecs(
  file: string,
  program: Program,
  fn: FitFunction,
  specs: FitSpec[],
  contractCache: Map<string, FunctionContractProof>,
): FitCheck[] {
  const functionName = fn.name
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, specs, program, env)

  const {assumedGivens, checks} = validateGivenSpecs(file, functionName, specs, inputRoots, 'function-given')

  for (const given of assumedGivens) {
    if (given.kind !== 'range') continue
    applyGivenRangeSpec(env, given.spec)
  }

  const {assumptions, checks: impossibleChecks} = collectGivenAssumptions(file, program, functionName, env, inputRoots, assumedGivens, contractCache)
  checks.push(...impossibleChecks)
  const hasBodyClaims = functionHasBodyClaims(specs) || functionHasBodyFitComment(program, fn)
  const context: EvalContext = {
    program,
    file,
    env,
    inputRoots,
    stack: [functionName],
    checks: [],
    assumptions,
    contractCache,
    callObligations: functionHasBodyClaims(specs) ? 'record' : 'silent',
  }
  const result = hasBodyClaims ? evaluateFunctionBody(fn, context) : unknown('No body claim requested')
  if (hasBodyClaims) checks.push(...context.checks)

  for (const spec of specs) {
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
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)
  const loops: FitInferLoopReport[] = []

  bindFunctionInputParameters(fn, specs, program, env)

  const {assumedGivens, checks: givenChecks} = validateGivenSpecs(program.file, functionName, specs, inputRoots, 'function-given')
  for (const given of assumedGivens) {
    if (given.kind === 'range') applyGivenRangeSpec(env, given.spec)
  }
  const {assumptions, checks} = collectGivenAssumptions(program.file, program, functionName, env, inputRoots, assumedGivens, contractCache)
  const inferUnsupported: string[] = []
  const context: EvalContext = {program, file: program.file, env, inputRoots, stack: [functionName], checks: [], assumptions, contractCache, inferLoops: loops, inferUnsupported}
  const state = evaluateFunctionBodyState(fn, context)
  const resultFacts = factsFromValue(fitReturnInternalRoot, state.result)
  const localFacts = localFactsFromEnv(env, state.env)
  const backgroundChecks = [
    ...givenChecks,
    ...checks,
    ...context.checks,
  ]
  const specReports = inferFunctionSpecReports(specs, backgroundChecks, spec => verifyCheckSpec(
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
  const state = options.functionName != null || program.fitFunctions.has(functionName) || functionHasBodyFitComment(program, fn)
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
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, specs, program, env)

  const {assumedGivens} = validateGivenSpecs(program.file, functionName, specs, inputRoots, 'function-given')
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
  if (match == null) return null
  const min = parsePrintedNumber(match[2]!)
  const max = parsePrintedNumber(match[3]!)
  return min == null || max == null ? null : {isInteger: match[1] != null, min, max}
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

function bindFunctionArgumentParameters(fn: FitFunction, argumentValues: Value[], env: Map<string, Value>, options: LocalizeOptions = {}) {
  for (let i = 0; i < fn.node.parameters.length; i++) {
    const param = fn.node.parameters[i]!
    const value = argumentValues[i] ?? unknown(`Missing argument ${i} for ${fn.name}`)
    bindPatternFromValue(param.name, value, env, options)
  }
}

function bindFunctionCallInputs(fn: FitFunction, argumentValues: Value[], env: Map<string, Value>, thisValue?: Value) {
  if (functionHasInstanceThisInput(fn)) {
    env.set('this', localizeValue(thisValue ?? unknownObject('this'), 'this', {preserveLinear: true}))
  }
  bindFunctionArgumentParameters(fn, argumentValues, env, {preserveLinear: true})
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

function localizeValue(value: Value, expr: string, options: LocalizeOptions = {}): Value {
  if (value.kind === 'number') {
    return numberValue(
      value.min,
      value.max,
      value.isInteger,
      expr,
      options.preserveLinear === true ? value.linear : linearVariable(linearNameForExpression(expr)),
      options.preserveLinear === true ? value.cases : null,
      value.provenance,
    )
  }
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, localizeValue(prop, `${expr}.${name}`, options))
    return {...value, props, expr}
  }
  if (value.kind === 'array') {
    return {
      ...value,
      length: localizeValue(value.length, `${expr}.length`, options) as NumberValue,
      elements: value.elements == null ? null : value.elements.map((element, index) => localizeValue(element, `${expr}[${index}]`, options)),
      element: value.element == null ? null : localizeValue(value.element, `${expr}[]`, options),
      expr,
    }
  }
  return value
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) names.push(...bindingNames(element.name))
  }
  if (ts.isArrayBindingPattern(name)) {
    forEachArrayBindingElement(name, elementName => names.push(...bindingNames(elementName)))
  }
  return names
}

function functionInputRoots(program: Program, fn: FitFunction): string[] {
  const roots = [...program.globals.keys()]
  if (functionHasInstanceThisInput(fn)) roots.push('this')
  for (const param of fn.node.parameters) {
    roots.push(...bindingNames(param.name))
  }
  return [...new Set(roots)]
}

function functionHasInstanceThisInput(fn: FitFunction) {
  return (ts.isMethodDeclaration(fn.node) || ts.isGetAccessorDeclaration(fn.node))
    && !hasModifier(fn.node, ts.SyntaxKind.StaticKeyword)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function programGlobalEnv(program: Program): Map<string, Value> {
  const env = new Map<string, Value>()
  for (const [name, value] of program.globals) env.set(name, value)
  for (const [localName, binding] of program.imports) {
    const imported = importedGlobalValue(localName, binding)
    if (imported != null) env.set(localName, imported)
  }
  return env
}

function importedGlobalValue(localName: string, binding: ImportedBinding): NumberValue | null {
  if (binding.kind === 'unresolved') return null
  const exported = resolveFitExport(binding.module, binding.exportedName)
  if (exported.kind === 'unresolved') return null
  const value = exported.module.globals.get(exported.localName)
  if (value == null) return null
  return numberValue(value.min, value.max, value.isInteger, localName, value.linear, null, value.provenance)
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

function expressionRootNamesFromText(text: string): string[] {
  const parsed = parseFitExpression(text)
  const ignored = [...parsed.domainPaths.keys()]
  const roots = [...parsed.domainPaths.values()].map(domainPath => domainPath.root)
  roots.push(...expressionRootNames(parsed.expression, ignored))
  return [...new Set(roots)]
}

function expressionRootNames(expression: ts.Expression, ignored: string[]): string[] {
  if (ts.isIdentifier(expression)) return ignored.includes(expression.text) ? [] : [expression.text]
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ignored.includes('this') ? [] : ['this']
  if (ts.isPropertyAccessExpression(expression)) return expressionRootNames(expression.expression, ignored)
  if (ts.isElementAccessExpression(expression)) {
    const roots = expressionRootNames(expression.expression, ignored)
    if (expression.argumentExpression != null) roots.push(...expressionRootNames(expression.argumentExpression, ignored))
    return roots
  }
  if (ts.isCallExpression(expression)) {
    const roots = expressionRootNames(expression.expression, ignored)
    for (const argument of expression.arguments) roots.push(...expressionRootNames(argument, ignored))
    return roots
  }

  const roots: string[] = []
  for (const child of expression.getChildren()) {
    if (ts.isExpression(child)) roots.push(...expressionRootNames(child, ignored))
  }
  return roots
}

function expressionMentionsArrayParam(expression: ts.Expression, name: string): boolean {
  const lengthRoot = arrayLengthRoot(expression)
  if (lengthRoot === name) return true
  if (ts.isElementAccessExpression(expression) && expressionRootName(expression.expression) === name) return true

  for (const child of expression.getChildren()) {
    if (ts.isExpression(child) && expressionMentionsArrayParam(child, name)) return true
  }
  return false
}

function expressionMentionsObjectParam(expression: ts.Expression, name: string): boolean {
  if (ts.isPropertyAccessExpression(expression) && expressionRootNameDeep(expression.expression) === name) return true

  for (const child of expression.getChildren()) {
    if (ts.isExpression(child) && expressionMentionsObjectParam(child, name)) return true
  }
  return false
}

function arrayLengthRoot(expression: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(expression)) return null
  if (expression.name.text !== 'length') return null
  return expressionRootName(expression.expression)
}

function expressionRootName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isParenthesizedExpression(expression)) return expressionRootName(expression.expression)
  return null
}

function expressionRootNameDeep(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isParenthesizedExpression(expression)) return expressionRootNameDeep(expression.expression)
  if (ts.isPropertyAccessExpression(expression)) return expressionRootNameDeep(expression.expression)
  return null
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
): FitCheck {
  const env = new Map(baseEnv)
  env.set(fitReturnInternalRoot, result)
  const inputRoots = [...baseEnv.keys(), fitReturnInternalRoot]
  const context: EvalContext = {program, file, env, inputRoots, stack: [functionName], checks, assumptions, contractCache}
  const boundIndexContext = specBoundIndexContext(context)

  if (spec.kind === 'check-range') {
    const boundIndexCheck = proveBoundIndexRangeSpec(spec, boundIndexContext)
    if (boundIndexCheck != null && boundIndexCheck.status !== 'pass') {
      return {
        file,
        ...(spec.line == null ? {} : {line: spec.line}),
        functionName,
        text: spec.text,
        status: boundIndexCheck.status,
        ...(boundIndexCheck.reason == null ? {} : {reason: boundIndexCheck.reason}),
      }
    }
    const value = evaluateSpecExpression(spec.expression, context)
    const status = proveRangeSpec(value, spec.range, context)
    return {
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    }
  }

  if (spec.kind === 'check-atom') return verifyAtomSpec(file, functionName, spec, context)

  const boundIndexCheck = proveBoundIndexComparisonSpec(spec, boundIndexContext)
  if (boundIndexCheck != null) {
    return {
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: boundIndexCheck.status,
      ...(boundIndexCheck.reason == null ? {} : {reason: boundIndexCheck.reason}),
    }
  }

  const wildcardCheck = checkWildcardComparisonShape(spec.left, spec.right)
  if (wildcardCheck.kind === 'unsupported') {
    return {file, functionName, ...(spec.line == null ? {} : {line: spec.line}), text: spec.text, status: 'unknown', reason: wildcardCheck.reason}
  }

  const left = evaluateSpecExpression(spec.left, context)
  const right = evaluateSpecExpression(spec.right, context)
  const status = proveComparison(left, spec.op, right, context.assumptions)
  const reason = wildcardCheck.kind === 'one' && status.status !== 'pass' && status.reason != null
    ? `wildcard comparison means every ${publicFitText(wildcardCheck.collection)} item must satisfy: ${spec.text}\n${status.reason}`
    : status.reason
  return {
    file,
    ...(spec.line == null ? {} : {line: spec.line}),
    functionName,
    text: spec.text,
    status: status.status,
    ...(reason == null ? {} : {reason}),
  }
}

function proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  if (value.kind !== 'number') return {status: 'unknown', reason: expectedNumberReason(value)}
  if (range.finiteValues != null) return proveFiniteRangeSpec(value, range)
  if (staticRangeInside(value, range)) return {status: 'pass'}
  const lower = evaluateRangeBound(range.lower, context)
  if (lower.kind !== 'number') return {status: 'unknown', reason: `Range lower bound is not a number: ${range.lower}`}
  const upper = evaluateRangeBound(range.upper, context)
  if (upper.kind !== 'number') return {status: 'unknown', reason: `Range upper bound is not a number: ${range.upper}`}

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
  return value.kind === 'array' ? 'Expected a number, got an array' : 'Expected a number, got an object'
}

function specBoundIndexContext(context: EvalContext): BoundIndexContext {
  return {
    assumptions: context.assumptions,
    evaluateDomainPath: domainPath => evaluateDomainPath(domainPath, context),
    evaluateSpecExpression: text => evaluateSpecExpression(text, context),
    nondecreasingFailureReason,
    proveAdjacentComparison: (collectionPath, comparison) => {
      const collection = evaluateDomainPath(collectionPath, context)
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

function evaluateRangeBound(text: string, context: EvalContext): Value {
  const printed = parsePrintedNumber(text)
  if (printed != null) return numberValue(printed, printed, Number.isInteger(printed), text, Number.isFinite(printed) ? linearConstant(printed) : null)
  return evaluateSpecExpression(text, context)
}

function checkWildcardComparisonShape(left: string, right: string): WildcardUse {
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

function wildcardUse(text: string): WildcardUse {
  const collections = new Set<string>()
  for (const domainPath of parseFitExpression(text).domainPaths.values()) {
    const itemCount = domainPath.segments.filter(segment => segment.kind === 'item').length
    if (itemCount === 0) continue
    collections.add(domainPathCollectionText(domainPath))
  }
  if (collections.size === 0) return {kind: 'none'}
  if (collections.size > 1) return {kind: 'unsupported', reason: `Wildcard comparisons support one collection at a time: ${text}`}
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

function evaluateSpecExpression(text: string, context: EvalContext): Value {
  const parsed = parseFitExpression(text)
  if (parsed.domainPaths.size === 0) return evaluateExpression(parsed.expression, context)

  const env = new Map(context.env)
  for (const [name, domainPath] of parsed.domainPaths) env.set(name, evaluateDomainPath(domainPath, context))
  return evaluateExpression(parsed.expression, {...context, env})
}

function verifyAtomSpec(file: string, functionName: string, spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext): FitCheck {
  const status = proveAtomSpec(spec, context)
  return {
    file,
    ...(spec.line == null ? {} : {line: spec.line}),
    functionName,
    text: spec.text,
    status: status.status,
    ...(status.reason == null ? {} : {reason: status.reason}),
  }
}

function proveAtomSpec(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  switch (spec.name) {
    case 'nondecreasing':
      return proveNondecreasingAtom(spec, context)
    case 'spaced':
      return proveSpacedAtom(spec, context)
    default:
      return {status: 'unknown', reason: `Unknown layout atom ${spec.name}`}
  }
}

function proveNondecreasingAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  const target = sequencePropArgument(spec.args, context)
  if (target == null) return {status: 'unknown', reason: 'nondecreasing expects return.rows.top'}
  if (hasNondecreasingProp(target.array, target.prop)) return {status: 'pass'}
  return {status: 'unknown', reason: nondecreasingFailureReason(spec.text, target)}
}

function proveSpacedAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  if (spec.args.length !== 2) return {status: 'unknown', reason: 'spaced expects spaced(rows, gap)'}
  const rows = evaluateSpecExpression(spec.args[0]!, context)
  const gap = evaluateSpecExpression(spec.args[1]!, context)
  if (rows.kind !== 'array') return {status: 'unknown', reason: 'spaced expected an array'}
  if (gap.kind !== 'number' || gap.expr == null) return {status: 'unknown', reason: 'spaced expected a known gap expression'}
  if (provedSpacing(rows, gap.expr) != null) return {status: 'pass'}
  return {status: 'unknown', reason: spacedFailureReason(spec.text, rows, gap.expr)}
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
  const provedSpacing = rows.summary?.spaced[0]
  if (provedSpacing != null) {
    known.push(`loop proved: row advance ${provedSpacing.advanceExpr} = previous height ${provedSpacing.heightExpr} + ${provedSpacing.gapExpr}`)
  }
  known.push(`sequence facts: ${formatArraySummary(rows)}`)
  lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)

  if (provedSpacing != null) {
    lines.push(`missing: given ${provedSpacing.gapExpr} == ${gapExpr}`)
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

function evaluateFunctionBody(fn: FitFunction, context: EvalContext): Value {
  return evaluateFunctionBodyState(fn, context).result
}

function evaluateFunctionBodyState(fn: FitFunction, context: EvalContext): {result: Value; env: Map<string, Value>; assumptions: LinearConstraint[]} {
  if (fn.node.body == null) {
    return {
      result: unknown(`Function ${fn.name} has no body`),
      env: context.env,
      assumptions: context.assumptions,
    }
  }
  const localEnv = new Map(context.env)
  const localContext: EvalContext = {...context, env: localEnv}
  const result = ts.isBlock(fn.node.body)
    ? evaluateStatements(fn.node.body.statements, localContext)
    : evaluateReturnExpression(fn.node.body, fn.node, localContext)
  context.assumptions = localContext.assumptions
  return {result, env: localEnv, assumptions: localContext.assumptions}
}

function evaluateStatements(statements: ts.NodeArray<ts.Statement>, context: EvalContext, startIndex = 0): Value {
  const flow = evaluateStatementsFlow(statements, context, startIndex)
  return flow.kind === 'return' ? flow.value : unknown(functionDidNotReturnReason(context))
}

function evaluateStatementsFlow(statements: ts.NodeArray<ts.Statement>, context: EvalContext, startIndex = 0): EvalFlow {
  for (let index = startIndex; index < statements.length; index++) {
    const statement = statements[index]!
    if (ts.isVariableStatement(statement)) {
      bindVariableStatement(statement, context)
      continue
    }
    if (ts.isForOfStatement(statement)) {
      const result = evaluateForOfStatement(statement, context)
      if (result != null) return {kind: 'return', value: result}
      continue
    }
    if (ts.isForStatement(statement)) {
      const result = evaluateForStatement(statement, context)
      if (result != null) return {kind: 'return', value: result}
      continue
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      const result = evaluateForgettableWhileStatement(statement, context)
      if (result != null) return {kind: 'return', value: result}
      continue
    }
    if (ts.isExpressionStatement(statement)) {
      const result = applyExpressionStatement(statement.expression, context)
      if (result != null) return {kind: 'return', value: result}
      continue
    }
    if (ts.isIfStatement(statement)) {
      const flow = evaluateIfStatement(statement, context, statements, index + 1)
      if (flow.kind !== 'fallthrough') return flow
      continue
    }
    if (ts.isReturnStatement(statement)) {
      return {kind: 'return', value: evaluateReturnStatement(statement, context)}
    }
    if (ts.isThrowStatement(statement)) return {kind: 'exit'}
    return {kind: 'return', value: unknown(`Unsupported statement in ${context.stack.at(-1) ?? '<unknown>'}: ${statement.getText(context.program.sourceFile)}`)}
  }

  return {kind: 'fallthrough'}
}

function bindVariableDeclaration(declaration: ts.VariableDeclaration, context: EvalContext, options: {claim?: boolean} = {}) {
  if (declaration.initializer == null) {
    bindUninitializedName(declaration.name, context)
    return
  }
  const evaluate = () => ts.isIdentifier(declaration.name)
    ? evaluateExpressionWithObjectPath(declaration.initializer!, context, [declaration.name.text])
    : evaluateExpression(declaration.initializer!, context)
  const value = options.claim === true ? withCallObligationRecording(context, evaluate) : evaluate()
  bindName(declaration.name, valueWithBindingShapeFallback(declaration.name, value, context), context)
}

function bindVariableStatement(statement: ts.VariableStatement, context: EvalContext) {
  const specs = parseLocalFitSpecs(context.program.sourceText, statement)
  for (const declaration of statement.declarationList.declarations) {
    bindVariableDeclaration(declaration, context, {claim: specs.length > 0})
  }
  verifyLocalFitSpecs(specs, context)
}

function verifyLocalFitSpecs(specs: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'}>[], context: EvalContext) {
  if (specs.length === 0) return
  for (const spec of specs) {
    context.checks.push(verifyCheckSpec(
      context.file,
      context.program,
      context.stack.join(' > '),
      context.env,
      unknown('Inline @fit checks do not use return'),
      spec,
      [...context.checks],
      context.assumptions,
      context.contractCache,
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

function forEachArrayBindingElement(
  pattern: ts.ArrayBindingPattern,
  visit: (name: ts.BindingName, index: number, isRest: boolean) => void,
) {
  pattern.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) return
    visit(element.name, index, element.dotDotDotToken != null)
  })
}

function arrayPatternElementValue(value: Value, index: number): Value {
  if (value.kind !== 'array') return unknown(`Array destructuring expected an array`)
  return value.elements?.[index]
    ?? value.element
    ?? unknownNumber(`${value.expr ?? 'array'}[${index}]`)
}

function bindingElementPropertyName(element: ts.BindingElement): string | null {
  if (element.propertyName == null) return ts.isIdentifier(element.name) ? element.name.text : null
  if (ts.isIdentifier(element.propertyName)) return element.propertyName.text
  if (ts.isStringLiteral(element.propertyName) || ts.isNumericLiteral(element.propertyName)) return element.propertyName.text
  return null
}

function applyExpressionStatement(expression: ts.Expression, context: EvalContext): Value | null {
  if (ts.isCallExpression(expression)) return applyCallExpressionStatement(expression, context)
  if (!ts.isBinaryExpression(expression)) return unknown(`Unsupported expression statement: ${expression.getText(context.program.sourceFile)}`)

  if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    if (!ts.isIdentifier(expression.left)) return unknown(`Unsupported assignment target: ${expression.left.getText(context.program.sourceFile)}`)
    const current = context.env.get(expression.left.text)
    const increment = evaluateExpression(expression.right, context)
    if (current == null || current.kind !== 'number' || increment.kind !== 'number') {
      if (isSideEffectFreeExpression(expression.right)) {
        context.env.set(expression.left.text, unknown(`Unsupported += changed ${expression.left.text}`))
        return null
      }
      return unknown('+= expected numbers')
    }
    const next = evaluateNumberBinary(ts.SyntaxKind.PlusToken, current, increment)
    context.env.set(expression.left.text, next)
    return null
  }

  if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) return applyAssignmentStatement(expression, context)
  return unknown(`Unsupported expression statement: ${expression.getText(context.program.sourceFile)}`)
}

function applyCallExpressionStatement(expression: ts.CallExpression, context: EvalContext): Value | null {
  if (!ts.isPropertyAccessExpression(expression.expression)) return unknown(`Unsupported expression statement: ${expression.getText(context.program.sourceFile)}`)
  const targetName = expressionRootName(expression.expression.expression)
  if (targetName == null) return unknown(`Unsupported mutation target: ${expression.expression.expression.getText(context.program.sourceFile)}`)
  const target = context.env.get(targetName)
  if (target?.kind !== 'array') return unknown(`${targetName}.${expression.expression.name.text} expected an array`)
  const targetNames = mutationTargetRoots(expression.expression.expression, context)

  switch (expression.expression.name.text) {
    case 'reverse':
    case 'sort':
      for (const name of targetNames) markArrayOrderMutated(context, name)
      return null
    case 'splice':
      for (const name of targetNames) markRootMutated(context, name)
      return null
    default:
      return unknown(`Unsupported array mutation: ${expression.getText(context.program.sourceFile)}`)
  }
}

function applyAssignmentStatement(expression: ts.BinaryExpression, context: EvalContext): Value | null {
  if (ts.isIdentifier(expression.left)) {
    context.env.set(expression.left.text, evaluateExpression(expression.right, context))
    return null
  }
  const targetNames = mutationTargetRoots(expression.left, context)
  if (targetNames.length === 0) return unknown(`Unsupported assignment target: ${expression.left.getText(context.program.sourceFile)}`)
  for (const targetName of targetNames) markRootMutated(context, targetName)
  return null
}

function mutationTargetRoot(expression: ts.Expression): string | null {
  if (ts.isElementAccessExpression(expression)) return expressionRootName(expression.expression) ?? mutationTargetRoot(expression.expression)
  if (ts.isPropertyAccessExpression(expression)) return expressionRootName(expression.expression) ?? mutationTargetRoot(expression.expression)
  if (ts.isParenthesizedExpression(expression)) return mutationTargetRoot(expression.expression)
  if (ts.isNonNullExpression(expression)) return mutationTargetRoot(expression.expression)
  return null
}

function mutationTargetRoots(expression: ts.Expression, context: EvalContext): string[] {
  const root = expressionRootName(expression) ?? mutationTargetRoot(expression)
  if (root == null) return []
  const roots = [root]
  const value = context.env.get(root)
  const aliasedRoot = value == null ? null : referenceRootName(value)
  if (aliasedRoot != null && aliasedRoot !== root) roots.push(aliasedRoot)
  return [...new Set(roots)]
}

function referenceRootName(value: Value): string | null {
  if (value.kind !== 'object' && value.kind !== 'array') return null
  return value.expr == null ? null : rootNameFromExpressionText(value.expr)
}

function rootNameFromExpressionText(text: string): string | null {
  const match = /^(?:this|[A-Za-z_$][\w$]*)/.exec(text)
  return match?.[0] ?? null
}

function markRootMutated(context: EvalContext, root: string) {
  const rootValue = context.env.get(root)
  context.env.set(root, mutatedRootValue(root, rootValue))

  for (const [name, value] of context.env) {
    if (name === root) continue
    if (referenceRootName(value) !== root) continue
    context.env.set(name, mutatedRootValue(name, value))
  }
}

function markArrayOrderMutated(context: EvalContext, root: string) {
  const rootValue = context.env.get(root)
  if (rootValue?.kind === 'array') context.env.set(root, arrayWithoutSequenceFacts(rootValue))

  for (const [name, value] of context.env) {
    if (name === root || value.kind !== 'array') continue
    if (referenceRootName(value) !== root) continue
    context.env.set(name, arrayWithoutSequenceFacts(value))
  }
}

function mutatedRootValue(root: string, value: Value | undefined): Value {
  const expr = mutatedRootName(root)
  if (value?.kind === 'array') return arrayWithUnknownContents(expr, {...value, expr})
  if (value?.kind === 'object') return unknownObject(expr)
  if (value?.kind === 'number') return unknownNumber(expr)
  return unknown(`Unsupported assignment changed ${root}`)
}

function mutatedRootName(root: string) {
  return `${root}AfterMutation`
}

function arrayWithoutSequenceFacts(array: ArrayValue): ArrayValue {
  return {...array, elements: null, summary: null}
}

function arrayWithUnknownContents(name: string, array: ArrayValue): ArrayValue {
  const expr = array.expr ?? name
  return {
    ...array,
    length: unknownArrayLength(expr),
    elements: null,
    element: null,
    summary: null,
  }
}

function evaluateIfStatement(statement: ts.IfStatement, context: EvalContext, statements: ts.NodeArray<ts.Statement>, nextIndex: number): EvalFlow {
  const condition = evaluateConditionFacts(statement.expression, context)
  if (condition.truth === 'true') return evaluateBranchStatement(statement.thenStatement, context)
  if (condition.truth === 'false') {
    return statement.elseStatement == null ? {kind: 'fallthrough'} : evaluateElseBranchStatement(statement.elseStatement, context, statements, nextIndex)
  }

  const trueContext = contextWithEnvAndAssumptions(context, refinedEnvForCondition(context, statement.expression, true), condition.trueAssumptions)
  const falseContext = contextWithEnvAndAssumptions(context, refinedEnvForCondition(context, statement.expression, false), condition.falseAssumptions)
  const trueFlow = evaluateBranchStatement(statement.thenStatement, trueContext)
  const falseFlow = statement.elseStatement == null
    ? {kind: 'fallthrough'} satisfies EvalFlow
    : evaluateElseBranchStatement(statement.elseStatement, falseContext, statements, nextIndex)
  if (isNonFallthroughFlow(trueFlow) && isNonFallthroughFlow(falseFlow)) {
    return joinNonFallthroughFlows(trueFlow, condition.trueAssumptions, falseFlow, condition.falseAssumptions, functionDidNotReturnReason(context))
  }
  if (trueFlow.kind === 'exit') {
    context.env = envWithAssumptions(falseContext.env, condition.falseAssumptions)
    context.assumptions = falseContext.assumptions
    return {kind: 'fallthrough'}
  }
  if (falseFlow.kind === 'exit') {
    context.env = envWithAssumptions(trueContext.env, condition.trueAssumptions)
    context.assumptions = trueContext.assumptions
    return {kind: 'fallthrough'}
  }
  if (trueFlow.kind === 'return') {
    const falseContinuation = evaluateStatementsFlow(statements, falseContext, nextIndex)
    return joinNonFallthroughFlows(trueFlow, condition.trueAssumptions, falseContinuation, condition.falseAssumptions, functionDidNotReturnReason(context))
  }
  if (falseFlow.kind === 'return') {
    const trueContinuation = evaluateStatementsFlow(statements, trueContext, nextIndex)
    return joinNonFallthroughFlows(trueContinuation, condition.trueAssumptions, falseFlow, condition.falseAssumptions, functionDidNotReturnReason(context))
  }
  context.env = joinEnvironments(
    envWithAssumptions(trueContext.env, condition.trueAssumptions),
    envWithAssumptions(falseContext.env, condition.falseAssumptions),
  )
  return {kind: 'fallthrough'}
}

function functionDidNotReturnReason(context: EvalContext) {
  return `Function ${context.stack.at(-1) ?? '<unknown>'} did not return`
}

function isNonFallthroughFlow(flow: EvalFlow) {
  return flow.kind !== 'fallthrough'
}

function joinNonFallthroughFlows(
  leftFlow: EvalFlow,
  leftAssumptions: LinearConstraint[],
  rightFlow: EvalFlow,
  rightAssumptions: LinearConstraint[],
  fallthroughReason: string,
): EvalFlow {
  const left = flowReturnValue(leftFlow, leftAssumptions, fallthroughReason)
  const right = flowReturnValue(rightFlow, rightAssumptions, fallthroughReason)
  if (left == null && right == null) return {kind: 'exit'}
  if (left == null) return {kind: 'return', value: right!}
  if (right == null) return {kind: 'return', value: left}
  return {kind: 'return', value: joinValues(left, right)}
}

function flowReturnValue(flow: EvalFlow, assumptions: LinearConstraint[], fallthroughReason: string): Value | null {
  if (flow.kind === 'exit') return null
  const value = flow.kind === 'return' ? flow.value : unknown(fallthroughReason)
  return valueWithAssumptions(value, assumptions)
}

function evaluateElseBranchStatement(statement: ts.Statement, context: EvalContext, statements: ts.NodeArray<ts.Statement>, nextIndex: number): EvalFlow {
  return ts.isIfStatement(statement)
    ? evaluateIfStatement(statement, context, statements, nextIndex)
    : evaluateBranchStatement(statement, context)
}

function refinedEnvForCondition(context: EvalContext, expression: ts.Expression, truth: boolean): Map<string, Value> {
  const env = new Map(context.env)
  const presence = presenceCaseRefinement(context, expression, truth)
  if (presence != null) {
    env.set(presence.root, presence.value)
    return env
  }
  const refinement = conditionCaseRefinement(context, expression, truth)
  if (refinement == null) return env
  const current = env.get(refinement.name)
  if (current?.kind !== 'number' || current.cases == null) return env
  const refined = refineNumberCasesForComparison(current, refinement.op, refinement.other, context.assumptions)
  if (refined == null) return env
  env.set(refinement.name, refined)
  return env
}

function presenceCaseRefinement(context: EvalContext, expression: ts.Expression, truth: boolean): {root: string; value: Value} | null {
  const guard = presenceGuardForCondition(expression)
  if (guard == null || truth !== guard.presentWhenTrue) return null
  const path = nullablePresencePath(guard.target)
  if (path == null) return null
  const root = context.env.get(path.root)
  const current = valueAtPropertyPath(root, path.segments)
  if (current?.kind !== 'nullable') return null
  if (!presenceGuardExcludesAbsent(current.absent, guard.nullish)) return null
  const value = valueWithPropertyPathValue(root, path.segments, current.present)
  return value == null ? null : {root: path.root, value}
}

function nullablePresencePath(expression: ts.Expression): {root: string; segments: string[]} | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return {root: current.text, segments: []}
  if (current.kind === ts.SyntaxKind.ThisKeyword) return {root: 'this', segments: []}
  if (!ts.isPropertyAccessExpression(current)) return null
  const base = nullablePresencePath(current.expression)
  return base == null ? null : {root: base.root, segments: [...base.segments, current.name.text]}
}

function valueAtPropertyPath(value: Value | undefined, segments: string[]): Value | null {
  if (value == null) return null
  const [segment, ...rest] = segments
  if (segment == null) return value
  if (value.kind !== 'object') return null
  return valueAtPropertyPath(value.props.get(segment), rest)
}

function valueWithPropertyPathValue(value: Value | undefined, segments: string[], replacement: Value): Value | null {
  if (value == null) return null
  const [segment, ...rest] = segments
  if (segment == null) return replacement
  if (value.kind !== 'object') return null
  const current = value.props.get(segment)
  const next = valueWithPropertyPathValue(current, rest, replacement)
  if (next == null) return null
  const props = new Map(value.props)
  props.set(segment, next)
  return {...value, props}
}

function conditionCaseRefinement(
  context: EvalContext,
  expression: ts.Expression,
  truth: boolean,
): {name: string; op: ComparisonOperator; other: NumberValue} | null {
  if (!ts.isBinaryExpression(expression)) return null
  const op = expression.operatorToken.kind
  if (!isComparisonSyntax(op)) return null
  const comparison = syntaxToComparison(op)
  const branchComparison = truth ? comparison : negatedComparison(comparison)
  if (branchComparison == null) return null

  const leftTarget = identifierComparisonTarget(context, expression.left, branchComparison, expression.right)
  if (leftTarget != null) return leftTarget
  return identifierComparisonTarget(context, expression.right, flipComparison(branchComparison), expression.left)
}

function presenceGuardForCondition(expression: ts.Expression): PresenceGuard | null {
  return typeofUndefinedPresenceGuard(expression) ?? nullishPresenceGuard(expression)
}

function typeofUndefinedPresenceGuard(expression: ts.Expression): PresenceGuard | null {
  if (!ts.isBinaryExpression(expression)) return null
  const op = expression.operatorToken.kind
  if (!isNullishComparisonSyntax(op)) return null

  const left = typeofUndefinedSide(expression.left, expression.right)
  const right = typeofUndefinedSide(expression.right, expression.left)
  const target = left ?? right
  if (target == null) return null
  const equalsUndefined = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken
  return {target, nullish: 'undefined', presentWhenTrue: !equalsUndefined}
}

function typeofUndefinedSide(typeofExpression: ts.Expression, literalExpression: ts.Expression): ts.Expression | null {
  const literal = unwrapExpression(literalExpression)
  if (!ts.isStringLiteral(literal) || literal.text !== 'undefined') return null
  const current = unwrapExpression(typeofExpression)
  return ts.isTypeOfExpression(current) ? current.expression : null
}

function nullishPresenceGuard(expression: ts.Expression): PresenceGuard | null {
  if (!ts.isBinaryExpression(expression)) return null
  const op = expression.operatorToken.kind
  if (!isNullishComparisonSyntax(op)) return null
  const left = nullishLiteralKind(expression.left)
  const right = nullishLiteralKind(expression.right)
  const target = left != null ? expression.right : right != null ? expression.left : null
  const literalKind = left ?? right
  if (target == null || literalKind == null) return null
  const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
  const equalsNullish = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken
  return {
    target,
    nullish: loose ? 'nullish' : literalKind,
    presentWhenTrue: !equalsNullish,
  }
}

function nullishLiteralKind(expression: ts.Expression): NullishKind | null {
  const unwrapped = unwrapExpression(expression)
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined') return 'undefined'
  return null
}

function presenceGuardExcludesAbsent(absent: NullishKind, guard: NullishKind) {
  return guard === 'nullish' || absent === guard
}

function isNullishComparisonSyntax(kind: ts.SyntaxKind) {
  return kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken
}

function identifierComparisonTarget(
  context: EvalContext,
  target: ts.Expression,
  op: ComparisonOperator,
  otherExpression: ts.Expression,
): {name: string; op: ComparisonOperator; other: NumberValue} | null {
  const unwrappedTarget = unwrapExpression(target)
  if (!ts.isIdentifier(unwrappedTarget)) return null
  const other = evaluateExpression(otherExpression, context)
  if (other.kind !== 'number') return null
  const stableOther = stablePlainConditionOperand(other)
  if (stableOther == null) return null
  return {name: unwrappedTarget.text, op, other: stableOther}
}

function evaluateBranchStatement(statement: ts.Statement, context: EvalContext): EvalFlow {
  if (ts.isReturnStatement(statement)) {
    return {kind: 'return', value: evaluateReturnStatement(statement, context)}
  }
  if (ts.isThrowStatement(statement)) return {kind: 'exit'}
  if (!ts.isBlock(statement)) return {kind: 'return', value: unknown(`Unsupported branch statement: ${statement.getText(context.program.sourceFile)}`)}
  return evaluateStatementsFlow(statement.statements, context)
}

function contextWithEnvAndAssumptions(context: EvalContext, env: Map<string, Value>, assumptions: LinearConstraint[]): EvalContext {
  return {
    ...context,
    env,
    assumptions: assumptions.length === 0 ? context.assumptions : mergeAssumptions(context.assumptions, assumptions),
  }
}

function envWithAssumptions(env: Map<string, Value>, assumptions: LinearConstraint[]): Map<string, Value> {
  if (assumptions.length === 0) return env
  const next = new Map<string, Value>()
  for (const [name, value] of env) next.set(name, valueWithAssumptions(value, assumptions))
  return next
}

function joinEnvironments(left: Map<string, Value>, right: Map<string, Value>): Map<string, Value> {
  const next = new Map<string, Value>()
  const keys = new Set([...left.keys(), ...right.keys()])
  for (const key of keys) {
    const leftValue = left.get(key)
    const rightValue = right.get(key)
    next.set(key, leftValue == null || rightValue == null ? unknown(`Local ${key} only exists on one branch`) : joinValues(leftValue, rightValue))
  }
  return next
}

function evaluateReturnStatement(statement: ts.ReturnStatement, context: EvalContext): Value {
  if (statement.expression == null) return unknown('Return without expression')
  return evaluateReturnExpression(statement.expression, statement, context)
}

function evaluateReturnExpression(expression: ts.Expression, inlineNode: ts.Node, context: EvalContext): Value {
  const specs = parseInlineFitSpecsForExpression(context.program.sourceText, inlineNode, fitReturnPublicRoot)
  const evaluate = () => evaluateExpressionWithObjectPath(expression, context, [fitReturnPublicRoot])
  const value = specs.length > 0 ? withCallObligationRecording(context, evaluate) : evaluate()
  verifyInlineSpecsForValue(specs, value, context)
  return value
}

function evaluateForOfStatement(statement: ts.ForOfStatement, context: EvalContext): Value | null {
  const checksStart = context.checks.length
  const rawLocalSpecs = parseFitSpecs(context.program.sourceText, statement)
  const {validSpecs: localSpecs, resultSpecs} = splitLoopSpecs(rawLocalSpecs)
  return withCallObligationRecordingWhen(context, functionHasBodyClaims(localSpecs), () =>
    evaluateForOfStatementCore(statement, context, checksStart, rawLocalSpecs, localSpecs, resultSpecs))
}

function evaluateForOfStatementCore(
  statement: ts.ForOfStatement,
  context: EvalContext,
  checksStart: number,
  rawLocalSpecs: FitSpec[],
  localSpecs: FitSpec[],
  resultSpecs: FitSpec[],
): Value | null {
  reportLoopResultSpecs(resultSpecs, context)
  applyLocalGivenSpecs(localSpecs, context)

  if (!ts.isVariableDeclarationList(statement.initializer)) return unknown('Only for-of variable declarations are supported')
  const declaration = statement.initializer.declarations[0]
  if (declaration == null || !ts.isIdentifier(declaration.name)) return unknown('Only simple for-of variables are supported')
  const source = evaluateExpression(statement.expression, context)
  if (source.kind !== 'array') return unknown('For-of source expected an array')
  if (!ts.isBlock(statement.statement)) return unknown('Only block for-of bodies are supported')

  const loopItemName = declaration.name.text
  const loopItem = source.element ?? unknownObject(`${source.expr ?? statement.expression.getText(context.program.sourceFile)}[]`)
  const pushedArrays: LoopPush[] = []
  const conditionalPushedArrays: GuardedLoopPush[] = []
  const conditionalAdds = new Map<string, NumberValue>()
  const pendingAdds = new Map<string, NumberValue>()
  const pendingExtrema = new Map<string, LoopExtremum>()
  const loopContext: EvalContext = {...context, env: new Map(context.env).set(loopItemName, loopItem), insideLoop: true}
  const loopSource = loopSourceContext(loopContext)

  for (const child of statement.statement.statements) {
    if (ts.isVariableStatement(child)) {
      bindVariableStatement(child, loopContext)
      continue
    }

    if (ts.isExpressionStatement(child) && isPushCall(child.expression)) {
      const targetName = child.expression.expression.expression.text
      const target = context.env.get(targetName)
      if (target == null || target.kind !== 'array') return unknown(`${targetName}.push expected an array`)
      pushedArrays.push({...readLoopPush(child.expression, loopSource), arrayName: targetName, length: source.length})
      continue
    }

    const conditionalPushes = readGuardedLoopPushes(child, loopSource, source.length, pendingExtrema)
    if (conditionalPushes != null) {
      conditionalPushedArrays.push(...conditionalPushes)
      continue
    }

    const conditionalAdd = readConditionalLoopAdd(child, loopSource)
    if (conditionalAdd != null) {
      if (conditionalAdds.has(conditionalAdd.targetName)) return unknown(`Conditional running-sum loop already updates ${conditionalAdd.targetName}`)
      conditionalAdds.set(conditionalAdd.targetName, conditionalAdd.increment)
      continue
    }

    const scalarAdd = readLoopScalarAdd(child, loopSource)
    if (scalarAdd != null) {
      pendingAdds.set(scalarAdd.targetName, scalarAdd.increment)
      continue
    }

    const extremum = readLoopExtremumAssignment(child, loopSource)
    if (extremum != null) {
      if (pendingExtrema.has(extremum.targetName)) return unknown(`Scalar min/max loop already updates ${extremum.targetName}`)
      pendingExtrema.set(extremum.targetName, extremum)
      continue
    }

    return unknown(`Unsupported for-of body statement: ${child.getText(context.program.sourceFile)}`)
  }

  if (conditionalPushedArrays.length > 0 && (conditionalPushedArrays.length > 1 || pushedArrays.length > 0)) {
    return unknown('Conditional push loops support one guarded push array')
  }
  if (conditionalAdds.size > 0 && (pushedArrays.length > 0 || conditionalPushedArrays.length > 0 || pendingAdds.size > 0 || pendingExtrema.size > 0)) {
    return unknown('Conditional running-sum loops support guarded += statements only')
  }
  if (loopExtremaConflictWithAdds(pendingExtrema, pendingAdds)) return unknown('Scalar min/max loops cannot also use += on the same target')

  const updates = new Map<string, LoopScalarUpdate>()
  const factRoots = new Set<string>()

  for (const [targetName, increment] of pendingAdds) {
    const start = context.env.get(targetName)
    if (start == null || start.kind !== 'number') return unknown('Running-sum loop target expected a number')
    const end = runningSumNumber(start, source.length, increment)
    context.env.set(targetName, end)
    updates.set(targetName, {start, increment, end})
    factRoots.add(targetName)
  }

  for (const [targetName, increment] of conditionalAdds) {
    const start = context.env.get(targetName)
    if (start == null || start.kind !== 'number') return unknown('Conditional running-sum loop target expected a number')
    const end = conditionalRunningSumNumber(targetName, start, source.length, increment)
    context.env.set(targetName, end)
    context.assumptions = mergeAssumptions(context.assumptions, conditionalRunningSumFacts(end, start, source.length, increment))
    factRoots.add(targetName)
  }

  const extremumResult = applyLoopExtrema(pendingExtrema, source.length, context.env, 'Scalar min/max loop target expected a number')
  if (extremumResult != null) return extremumResult
  for (const targetName of pendingExtrema.keys()) factRoots.add(targetName)

  for (const push of pushedArrays) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
    factRoots.add(push.arrayName)
    const update = updates.get(push.topName ?? '')
    context.env.set(push.arrayName, {
      ...target,
      length: push.length,
      elements: null,
      element: loopElementFromPush(push, updates, new Map(), source.length, context.env, context.assumptions),
      summary: mergeArraySummary(target.summary, sequenceSummaryFromLoopPush(push, update, loopSummaryOptions(context))),
    })
  }

  for (const push of conditionalPushedArrays) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
    factRoots.add(push.arrayName)
    const length = conditionalPushLength(push.arrayName, source.length)
    const baseElement = loopElementFromPush(push, updates, pendingExtrema, source.length, context.env, context.assumptions)
    const element = segmentedStackElement(push, baseElement, source.length, context.env)
    context.env.set(push.arrayName, {
      ...target,
      length,
      elements: null,
      element: pushedElementValue(target, element),
      summary: mergeArraySummary(target.summary, segmentedStackSummary(push, element)),
    })
    applySegmentedStackCursorUpdate(push, element, source.length, context.env)
    const fact = comparisonConstraint(length, '<=', source.length, `${length.expr ?? push.arrayName + '.length'} <= ${source.length.expr ?? formatRange(source.length)}`)
    if (fact != null) context.assumptions = mergeAssumptions(context.assumptions, [fact])
  }

  verifyLocalLoopSpecs(localSpecs, context)
  recordInferLoop(statement, 'for-of', rawLocalSpecs, context, checksStart, factRoots)

  return null
}

function evaluateForStatement(statement: ts.ForStatement, context: EvalContext): Value | null {
  const checksStart = context.checks.length
  const rawLocalSpecs = parseFitSpecs(context.program.sourceText, statement)
  const {validSpecs: localSpecs, resultSpecs} = splitLoopSpecs(rawLocalSpecs)
  return withCallObligationRecordingWhen(context, functionHasBodyClaims(localSpecs), () =>
    evaluateForStatementCore(statement, context, checksStart, rawLocalSpecs, localSpecs, resultSpecs))
}

function evaluateForStatementCore(
  statement: ts.ForStatement,
  context: EvalContext,
  checksStart: number,
  rawLocalSpecs: FitSpec[],
  localSpecs: FitSpec[],
  resultSpecs: FitSpec[],
): Value | null {
  reportLoopResultSpecs(resultSpecs, context)
  applyLocalGivenSpecs(localSpecs, context)

  const shape = indexedLoopShape(statement)
  if (shape == null) return evaluateForgettableForStatement(statement, context)
  if (!ts.isBlock(statement.statement)) return unknown('Only block indexed loops are supported')

  const source = indexedLoopSourceValue(shape, context)
  if (source.kind !== 'array') return source
  if (source.length.max < 1) return unknown('Indexed loop expected a possibly non-empty source')

  const indexValue = numberValue(0, source.length.max - 1, true, shape.indexName, linearVariable(shape.indexName))
  const indexFacts = indexedLoopAssumptions(indexValue, source.length)
  const loopContext = contextWithAssumptions(
    {...context, env: new Map(context.env).set(shape.indexName, indexValue), insideLoop: true},
    indexFacts,
  )

  const pushes: LoopPush[] = []
  const conditionalPushedArrays: GuardedLoopPush[] = []
  const pendingAdds = new Map<string, NumberValue>()
  const pendingExtrema = new Map<string, LoopExtremum>()
  const forgottenRoots = new Set<string>()
  const loopSource = loopSourceContext(loopContext)
  for (const child of statement.statement.statements) {
    if (ts.isVariableStatement(child)) {
      bindVariableStatement(child, loopContext)
      continue
    }

    if (ts.isExpressionStatement(child) && isPushCall(child.expression)) {
      const targetName = child.expression.expression.expression.text
      const target = context.env.get(targetName)
      if (target == null || target.kind !== 'array') return unknown(`${targetName}.push expected an array`)
      pushes.push({...readLoopPush(child.expression, loopSource), arrayName: targetName, length: source.length})
      continue
    }

    const conditionalPushes = readGuardedLoopPushes(child, loopSource, source.length, pendingExtrema)
    if (conditionalPushes != null) {
      conditionalPushedArrays.push(...conditionalPushes)
      continue
    }

    const scalarAdd = readLoopScalarAdd(child, loopSource)
    if (scalarAdd != null) {
      pendingAdds.set(scalarAdd.targetName, scalarAdd.increment)
      continue
    }

    const extremum = readLoopExtremumAssignment(child, loopSource)
    if (extremum != null) {
      if (pendingExtrema.has(extremum.targetName)) return unknown(`Indexed scalar min/max loop already updates ${extremum.targetName}`)
      pendingExtrema.set(extremum.targetName, extremum)
      continue
    }

    const forgotten = forgettableMutationRoots(child)
    if (forgotten != null) {
      for (const root of forgotten) forgottenRoots.add(root)
      addInferUnsupported(context, `Forgot unsupported indexed loop side effect: ${child.getText(context.program.sourceFile)}`)
      continue
    }

    return unknown(`Unsupported indexed loop body statement: ${child.getText(context.program.sourceFile)}`)
  }

  if (loopExtremaConflictWithAdds(pendingExtrema, pendingAdds)) return unknown('Indexed scalar min/max loops cannot also use += on the same target')

  const updates = new Map<string, LoopScalarUpdate>()
  const factRoots = new Set<string>()
  for (const [targetName, increment] of pendingAdds) {
    const start = context.env.get(targetName)
    if (start == null || start.kind !== 'number') return unknown('Indexed running-sum loop target expected a number')
    const end = runningSumNumber(start, source.length, increment)
    context.env.set(targetName, end)
    updates.set(targetName, {start, increment, end})
    factRoots.add(targetName)
  }

  const extremumResult = applyLoopExtrema(pendingExtrema, source.length, context.env, 'Indexed scalar min/max loop target expected a number')
  if (extremumResult != null) return extremumResult
  for (const targetName of pendingExtrema.keys()) factRoots.add(targetName)

  for (const push of pushes) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
    factRoots.add(push.arrayName)
    const update = updates.get(push.topName ?? '')
    const cursorElement = loopElementFromPush(push, updates, pendingExtrema, source.length, context.env, context.assumptions)
    const element = indexedLoopElementFromPush({...push, element: cursorElement}, shape.indexName, source.length)
    context.env.set(push.arrayName, {
      ...target,
      length: source.length,
      elements: null,
      element,
      summary: mergeArraySummary(target.summary, sequenceSummaryFromLoopPush(push, update, loopSummaryOptions(context))),
    })
    context.assumptions = mergeAssumptions(context.assumptions, indexedPushElementAssumptions(push, shape.indexName, source.length))
  }

  for (const push of conditionalPushedArrays) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
    factRoots.add(push.arrayName)
    const length = conditionalPushLength(push.arrayName, source.length, target.length)
    const baseElement = loopElementFromPush(push, updates, pendingExtrema, source.length, context.env, context.assumptions)
    const element = segmentedStackElement(push, baseElement, source.length, context.env)
    context.env.set(push.arrayName, {
      ...target,
      length,
      elements: null,
      element: pushedElementValue(target, element),
      summary: mergeArraySummary(target.summary, segmentedStackSummary(push, element)),
    })
    applySegmentedStackCursorUpdate(push, element, source.length, context.env)
    if (target.length.min === 0 && target.length.max === 0) {
      const fact = comparisonConstraint(length, '<=', source.length, `${length.expr ?? push.arrayName + '.length'} <= ${source.length.expr ?? formatRange(source.length)}`)
      if (fact != null) context.assumptions = mergeAssumptions(context.assumptions, [fact])
    }
  }

  for (const root of forgottenRoots) {
    if (factRoots.has(root)) factRoots.delete(root)
    forgetRoot(context.env, root)
  }

  verifyLocalLoopSpecs(localSpecs, context)
  recordInferLoop(statement, 'for', rawLocalSpecs, context, checksStart, factRoots)

  return null
}

function indexedLoopSourceValue(shape: IndexedLoopShape, context: EvalContext): ArrayValue | Value {
  const source = evaluateExpression(shape.sourceExpression, context)
  if (shape.sourceKind === 'array') {
    return source.kind === 'array' ? source : unknown('Indexed loop source expected an array')
  }
  if (source.kind !== 'number') return unknown('Indexed loop limit expected a number')
  return unknownArray(shape.sourceExpression.getText(context.program.sourceFile), source)
}

function evaluateForgettableForStatement(statement: ts.ForStatement, context: EvalContext): Value | null {
  if (!isForgettableForStatement(statement)) return unknown(`Unsupported for loop: ${statement.getText(context.program.sourceFile)}`)
  const forgotten = forgettableMutationRoots(statement.statement)
  if (forgotten == null) return unknown(`Unsupported for loop: ${statement.getText(context.program.sourceFile)}`)
  for (const root of forgotten) forgetRoot(context.env, root)
  addInferUnsupported(context, `Forgot unsupported for loop side effects: ${loopHeaderText(statement, context.program.sourceFile)}`)
  return null
}

function evaluateForgettableWhileStatement(statement: ts.WhileStatement | ts.DoStatement, context: EvalContext): Value | null {
  if (!isSideEffectFreeExpression(statement.expression)) return unknown(`Unsupported while loop: ${statement.getText(context.program.sourceFile)}`)
  const forgotten = forgettableMutationRoots(statement.statement)
  if (forgotten == null) return unknown(`Unsupported while loop: ${statement.getText(context.program.sourceFile)}`)
  for (const root of forgotten) forgetRoot(context.env, root)
  const kind = ts.isWhileStatement(statement) ? 'while' : 'do while'
  addInferUnsupported(context, `Forgot unsupported ${kind} loop side effects: ${loopHeaderText(statement, context.program.sourceFile)}`)
  return null
}

function isForgettableForStatement(statement: ts.ForStatement) {
  const indexName = forgettableForIndexName(statement.initializer)
  return indexName != null
    && statement.condition != null
    && statement.incrementor != null
    && isSideEffectFreeExpression(statement.condition)
    && incrementorOnlyTouchesIndex(statement.incrementor, indexName)
}

function forgettableForIndexName(initializer: ts.ForInitializer | undefined): string | null {
  if (initializer == null || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return null
  const declaration = initializer.declarations[0]!
  if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) return null
  return isSideEffectFreeExpression(declaration.initializer) ? declaration.name.text : null
}

function incrementorOnlyTouchesIndex(expression: ts.Expression, indexName: string): boolean {
  if (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) {
    return (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isIdentifier(expression.operand)
      && expression.operand.text === indexName
  }
  if (!ts.isBinaryExpression(expression) || !ts.isIdentifier(expression.left) || expression.left.text !== indexName) return false
  if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) return isSideEffectFreeExpression(expression.right)
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false
  return isSideEffectFreeExpression(expression.right)
}

function forgettableMutationRoots(statement: ts.Statement): string[] | null {
  if (ts.isBlock(statement)) {
    const roots: string[] = []
    for (const child of statement.statements) {
      const childRoots = forgettableMutationRoots(child)
      if (childRoots == null) return null
      roots.push(...childRoots)
    }
    return [...new Set(roots)]
  }
  if (ts.isIfStatement(statement) && statement.elseStatement == null && isSideEffectFreeExpression(statement.expression)) return forgettableMutationRoots(statement.thenStatement)
  if (!ts.isExpressionStatement(statement)) return null

  const expression = statement.expression
  if ((ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression))
    && (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isIdentifier(expression.operand)) return [expression.operand.text]
  if (ts.isCallExpression(expression) && isPushCall(expression) && expression.arguments.every(isSideEffectFreeExpression)) return [expression.expression.expression.text]
  if (ts.isBinaryExpression(expression)) {
    const root = assignmentRootName(expression.left)
    if (root == null) return null
    if (!isSideEffectFreeExpression(expression.right)) return null
    if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken || expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) return [root]
  }
  return null
}

function isSideEffectFreeExpression(expression: ts.Expression): boolean {
  if (
    ts.isIdentifier(expression)
    || ts.isNumericLiteral(expression)
    || ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.NullKeyword
  ) return true
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.every(span => isSideEffectFreeExpression(span.expression))
  }
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return isSideEffectFreeExpression(expression.expression)
  if (ts.isPropertyAccessExpression(expression)) return isSideEffectFreeExpression(expression.expression)
  if (ts.isElementAccessExpression(expression)) return isSideEffectFreeExpression(expression.expression) && (expression.argumentExpression == null || isSideEffectFreeExpression(expression.argumentExpression))
  if (ts.isPrefixUnaryExpression(expression)) return expression.operator !== ts.SyntaxKind.PlusPlusToken && expression.operator !== ts.SyntaxKind.MinusMinusToken && isSideEffectFreeExpression(expression.operand)
  if (ts.isPostfixUnaryExpression(expression)) return false
  if (ts.isBinaryExpression(expression)) return !isAssignmentOperator(expression.operatorToken.kind) && isSideEffectFreeExpression(expression.left) && isSideEffectFreeExpression(expression.right)
  if (ts.isConditionalExpression(expression)) return isSideEffectFreeExpression(expression.condition) && isSideEffectFreeExpression(expression.whenTrue) && isSideEffectFreeExpression(expression.whenFalse)
  if (ts.isCallExpression(expression)) return isKnownPureReadCall(expression)
  return false
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function isKnownPureReadCall(expression: ts.CallExpression): boolean {
  if (!expression.arguments.every(isSideEffectFreeExpression)) return false
  const target = expression.expression
  if (ts.isIdentifier(target)) return true
  if (!ts.isPropertyAccessExpression(target)) return false
  if (ts.isIdentifier(target.expression) && target.expression.text === 'Math') return true
  return target.name.text === 'at' && isSideEffectFreeExpression(target.expression)
}

function assignmentRootName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  return mutationTargetRoot(expression)
}

function forgetRoot(env: Map<string, Value>, root: string) {
  const current = env.get(root)
  if (current?.kind === 'array') {
    env.set(root, arrayWithUnknownContents(root, current))
    return
  }
  if (current?.kind === 'number') {
    env.set(root, unknownNumber(root))
    return
  }
  if (current?.kind === 'object') {
    env.set(root, unknownObject(root))
    return
  }
  env.set(root, unknown(`Unsupported mutation changed ${root}`))
}

function addInferUnsupported(context: EvalContext, message: string) {
  context.inferUnsupported?.push(message)
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

function loopSourceContext(context: EvalContext): LoopSourceContext {
  return {
    env: context.env,
    sourceFile: context.program.sourceFile,
    evaluateExpression: (expression, env) => evaluateExpression(expression, {...context, env}),
    bindVariableStatement: (statement, env) => bindVariableStatement(statement, {...context, env}),
    isSideEffectFreeExpression,
  }
}

function loopSummaryOptions(context: EvalContext) {
  return {
    assumptions: context.assumptions,
    resolveNumber: (expr: string) => {
      const value = evaluateSpecExpression(expr, context)
      return value.kind === 'number' ? value : null
    },
  }
}

function indexedLoopAssumptions(index: NumberValue, sourceLength: NumberValue): LinearConstraint[] {
  const lower = comparisonConstraint(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)))
  const upper = comparisonConstraint(index, '<', sourceLength)
  return nonNullFacts(lower, upper)
}

function indexedPushElementAssumptions(push: LoopPush, indexName: string, sourceLength: NumberValue): LinearConstraint[] {
  return indexedLoopIndexPaths(push.element, indexName, `${push.arrayName}[]`)
    .flatMap(expr => indexedElementPathAssumptions(indexedElementPathValue(expr, sourceLength), sourceLength))
}

function indexedLoopIndexPaths(value: Value | null, indexName: string, expr: string): string[] {
  if (value == null) return []
  if (value.kind === 'number') return value.expr === indexName ? [expr] : []
  if (value.kind === 'array') {
    const paths: string[] = []
    if (value.element != null) paths.push(...indexedLoopIndexPaths(value.element, indexName, `${expr}[]`))
    if (value.elements != null) {
      for (let index = 0; index < value.elements.length; index++) {
        paths.push(...indexedLoopIndexPaths(value.elements[index]!, indexName, `${expr}[${index}]`))
      }
    }
    return paths
  }
  if (value.kind !== 'object') return []
  const paths: string[] = []
  for (const [name, prop] of value.props) {
    paths.push(...indexedLoopIndexPaths(prop, indexName, `${expr}.${name}`))
  }
  return paths
}

function indexedElementPathAssumptions(index: NumberValue, sourceLength: NumberValue): LinearConstraint[] {
  const lower = comparisonConstraint(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), `${index.expr ?? 'index'} >= 0`)
  const upper = comparisonConstraint(index, '<', sourceLength, `${index.expr ?? 'index'} < ${sourceLength.expr ?? formatRange(sourceLength)}`)
  return nonNullFacts(lower, upper)
}

function nonNullFacts(...facts: (LinearConstraint | null)[]): LinearConstraint[] {
  return facts.filter(fact => fact != null)
}

function evaluateExpression(expression: ts.Expression, context: EvalContext): Value {
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text)
    return numberValue(value, value, Number.isInteger(value), expression.text, linearConstant(value))
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) return nullValue('null')
  if (ts.isIdentifier(expression)) return context.env.get(expression.text) ?? unknown(unknownIdentifierReason(expression.text))
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return context.env.get('this') ?? unknown('Unknown identifier this')
  if (ts.isParenthesizedExpression(expression)) return evaluateExpression(expression.expression, context)
  if (ts.isPrefixUnaryExpression(expression)) return evaluatePrefixUnary(expression, context)
  if (ts.isBinaryExpression(expression)) return evaluateBinary(expression, context)
  if (ts.isConditionalExpression(expression)) return evaluateConditional(expression, context)
  if (ts.isCallExpression(expression)) return evaluateCall(expression, context)
  if (ts.isPropertyAccessExpression(expression)) return evaluatePropertyAccess(expression, context)
  if (ts.isElementAccessExpression(expression)) return evaluateElementAccess(expression, context)
  if (ts.isNonNullExpression(expression)) return evaluateExpression(expression.expression, context)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return valueWithStructuralFallback(evaluateExpression(expression.expression, context), expressionStructuralFallback(expression, context))
  }
  if (ts.isTypeAssertionExpression(expression)) {
    return valueWithStructuralFallback(evaluateExpression(expression.expression, context), expressionStructuralFallback(expression, context))
  }
  if (ts.isObjectLiteralExpression(expression)) return evaluateObjectLiteral(expression, context)
  if (ts.isArrayLiteralExpression(expression)) return evaluateArrayLiteral(expression, context)
  return expressionStructuralFallback(expression, context) ?? unknown(`Unsupported expression: ${expression.getText(context.program.sourceFile)}`)
}

function expressionStructuralFallback(expression: ts.Expression, context: EvalContext): Value | null {
  return structuralShape(valueFromNodeShape(expression.getText(context.program.sourceFile), expression, context.program))
}

function evaluatePrefixUnary(expression: ts.PrefixUnaryExpression, context: EvalContext): Value {
  const value = evaluateExpression(expression.operand, context)
  if (value.kind !== 'number') return unknown('Unary operator expected a number')
  switch (expression.operator) {
    case ts.SyntaxKind.MinusToken:
      return numberValue(-value.max, -value.min, value.isInteger, value.expr == null ? null : `-${value.expr}`, linearScale(value.linear, -1), null, value.provenance)
    case ts.SyntaxKind.PlusToken:
      return value
    default:
      return unknown(`Unsupported unary operator ${ts.SyntaxKind[expression.operator]}`)
  }
}

function evaluateBinary(expression: ts.BinaryExpression, context: EvalContext): Value {
  const op = expression.operatorToken.kind
  if (op === ts.SyntaxKind.QuestionQuestionToken) return evaluateNullishCoalescing(expression, context)
  if (isComparisonSyntax(op)) {
    return unknown('Comparison expressions are only supported in condition positions')
  }
  const left = evaluateExpression(expression.left, context)
  const right = evaluateExpression(expression.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') {
    const fallback = expressionStructuralFallback(expression, context)
    if (left.kind === 'unknown') return fallback ?? left
    if (right.kind === 'unknown') return fallback ?? right
    return fallback ?? unknown(`Binary arithmetic expected numbers in ${expression.getText()}`)
  }

  const result = evaluateNumberBinary(op, left, right)
  return result.kind === 'unknown' ? expressionStructuralFallback(expression, context) ?? result : result
}

function evaluateNullishCoalescing(expression: ts.BinaryExpression, context: EvalContext): Value {
  const fallback = expressionStructuralFallback(expression, context)
  const left = evaluateExpression(expression.left, context)
  if (left.kind === 'null') return valueWithStructuralFallback(evaluateExpression(expression.right, context), fallback)
  if (left.kind === 'nullable') {
    return valueWithStructuralFallback(joinValues(left.present, evaluateExpression(expression.right, context)), fallback)
  }
  if (left.kind === 'unknown') return fallback ?? left
  return valueWithStructuralFallback(left, fallback)
}

function evaluateNumberBinary(op: ts.SyntaxKind, left: NumberValue, right: NumberValue): Value {
  const plain = evaluatePlainNumberBinary(op, plainNumber(left), plainNumber(right))
  if (plain.kind !== 'number') return plain
  if (left.cases == null && right.cases == null) return plain

  const cases = combineNumberCases(left, right, (leftCase, rightCase) => evaluatePlainNumberBinary(op, leftCase, rightCase))
  return withNumberCases(plain, cases)
}

function evaluatePlainNumberBinary(op: ts.SyntaxKind, left: NumberValue, right: NumberValue): Value {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return addNumbers(left, right)
    case ts.SyntaxKind.MinusToken:
      return subtractNumbers(left, right)
    case ts.SyntaxKind.AsteriskToken:
      return multiplyNumbers(left, right)
    case ts.SyntaxKind.SlashToken:
      return divideNumbers(left, right)
    case ts.SyntaxKind.PercentToken:
      return moduloNumbers(left, right)
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return powerNumbers(left, right)
    default:
      return unknown(`Unsupported binary operator ${ts.SyntaxKind[op]}`)
  }
}

function evaluateConditional(expression: ts.ConditionalExpression, context: EvalContext): Value {
  const extentEnd = evaluateExtentEndConditional(expression, context)
  if (extentEnd != null) return extentEnd
  const choice = evaluateConditionalChoice(expression, context)
  if (choice != null) return choice

  const condition = evaluateConditionFacts(expression.condition, context)
  switch (condition.truth) {
    case 'true':
      return evaluateExpression(expression.whenTrue, context)
    case 'false':
      return evaluateExpression(expression.whenFalse, context)
    case 'maybe':
      const trueContext = contextWithEnvAndAssumptions(
        context,
        refinedEnvForCondition(context, expression.condition, true),
        condition.trueAssumptions,
      )
      const falseContext = contextWithEnvAndAssumptions(
        context,
        refinedEnvForCondition(context, expression.condition, false),
        condition.falseAssumptions,
      )
      return valueWithStructuralFallback(joinValues(
        valueWithAssumptions(
          evaluateExpression(expression.whenTrue, trueContext),
          condition.trueAssumptions,
        ),
        valueWithAssumptions(
          evaluateExpression(expression.whenFalse, falseContext),
          condition.falseAssumptions,
        ),
      ), expressionStructuralFallback(expression, context))
  }
}

function evaluateConditionalChoice(expression: ts.ConditionalExpression, context: EvalContext): Value | null {
  if (!ts.isBinaryExpression(expression.condition)) return null
  const op = expression.condition.operatorToken.kind
  if (
    op !== ts.SyntaxKind.LessThanToken
    && op !== ts.SyntaxKind.LessThanEqualsToken
    && op !== ts.SyntaxKind.GreaterThanToken
    && op !== ts.SyntaxKind.GreaterThanEqualsToken
  ) return null

  const leftText = expression.condition.left.getText(context.program.sourceFile)
  const rightText = expression.condition.right.getText(context.program.sourceFile)
  const trueText = expression.whenTrue.getText(context.program.sourceFile)
  const falseText = expression.whenFalse.getText(context.program.sourceFile)
  const trueIsLeft = sameExpressionText(trueText, leftText)
  const trueIsRight = sameExpressionText(trueText, rightText)
  const falseIsLeft = sameExpressionText(falseText, leftText)
  const falseIsRight = sameExpressionText(falseText, rightText)
  if (!((trueIsLeft && falseIsRight) || (trueIsRight && falseIsLeft))) return null

  const left = evaluateExpression(expression.condition.left, context)
  const right = evaluateExpression(expression.condition.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') return null

  if (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) {
    return trueIsLeft ? minNumberPair(left, right, context.assumptions) : maxNumberPair(left, right, context.assumptions)
  }
  return trueIsLeft ? maxNumberPair(left, right, context.assumptions) : minNumberPair(left, right, context.assumptions)
}

function evaluateCall(expression: ts.CallExpression, context: EvalContext): Value {
  if (ts.isIdentifier(expression.expression) && expression.expression.text === 'lastEnd') return evaluateLastEndCall(expression, context)
  if (ts.isIdentifier(expression.expression) && expression.expression.text === 'extentEnd') return evaluateExtentEndCall(expression, context)
  if (ts.isPropertyAccessExpression(expression.expression)) {
    const target = expression.expression
    if (ts.isIdentifier(target.expression) && target.expression.text === 'Math') {
      return evaluateMathCall(target.name.text, expression.arguments, context)
    }
    const classMethodResult = evaluateClassMethodCall(expression, target, context)
    if (classMethodResult != null) return classMethodResult
    const atResult = evaluateArrayAtCall(expression, context)
    if (atResult != null) return atResult
    const mapResult = evaluateArrayMapCall(expression, context)
    if (mapResult != null) return mapResult
    const filterResult = evaluateArrayFilterCall(expression, context)
    if (filterResult != null) return filterResult
    const namespaceImportResult = evaluateNamespaceImportedCall(expression, target, context)
    if (namespaceImportResult != null) return namespaceImportResult
    const fallback = expressionStructuralFallback(expression, context)
    if (fallback != null) return fallback
  }
  if (!ts.isIdentifier(expression.expression)) return unknown('Only named pure calls are supported')

  const functionName = expression.expression.text
  const fallback = structuralShape(valueFromCallReturnShape(expression.getText(context.program.sourceFile), expression, context.program))
  return evaluateResolvedCallTarget(
    functionName,
    resolveIdentifierCallTarget(context.program, functionName),
    expression,
    context,
    fallback,
  )
}

function evaluateClassMethodCall(expression: ts.CallExpression, access: ts.PropertyAccessExpression, context: EvalContext): Value | null {
  const member = classMemberFunctionForPropertyAccess(access, context)
  if (member == null || !ts.isMethodDeclaration(member.fn.node)) return null
  const receiver = evaluateExpression(access.expression, context)
  const argumentValues = expression.arguments.map(argument => evaluateExpression(argument, context))
  return evaluateLocalFunctionCall(member.functionName, member.fn, argumentValues, context, {
    thisValue: receiver,
    callText: `${access.getText(context.program.sourceFile)}(${expression.arguments.map(argument => argument.getText(context.program.sourceFile)).join(', ')})`,
    callLine: lineNumberForNode(context.program.sourceFile, expression),
    fallback: valueFromCallReturnShape(expression.getText(context.program.sourceFile), expression, context.program),
    callSiteBindings: callSiteBindingsFor(member.fn, expression.arguments, context.program.sourceFile, access.expression.getText(context.program.sourceFile), argumentValues),
  })
}

function evaluateClassGetterAccess(expression: ts.PropertyAccessExpression, context: EvalContext, fallback: Value | null): Value | null {
  const member = classMemberFunctionForPropertyAccess(expression, context)
  if (member == null || !ts.isGetAccessorDeclaration(member.fn.node)) return null
  const receiver = evaluateExpression(expression.expression, context)
  return evaluateLocalFunctionCall(member.functionName, member.fn, [], context, {
    thisValue: receiver,
    callText: expression.getText(context.program.sourceFile),
    callLine: lineNumberForNode(context.program.sourceFile, expression),
    fallback,
    callSiteBindings: callSiteBindingsFor(member.fn, [], context.program.sourceFile, expression.expression.getText(context.program.sourceFile)),
  })
}

function classMemberFunctionForPropertyAccess(access: ts.PropertyAccessExpression, context: EvalContext): {functionName: string; fn: FitFunction} | null {
  const className = classNameForPropertyAccess(access, context)
  if (className == null) return null
  const functionName = `${className}.${access.name.text}`
  const fn = context.program.functions.get(functionName)
  return fn == null ? null : {functionName, fn}
}

function classNameForPropertyAccess(access: ts.PropertyAccessExpression, context: EvalContext): string | null {
  const checker = context.program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (
    declaration != null
    && (ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration))
    && ts.isClassDeclaration(declaration.parent)
    && declaration.parent.name != null
  ) {
    return declaration.parent.name.text
  }

  if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const current = context.stack.at(-1)
    const dot = current?.indexOf('.') ?? -1
    if (current != null && dot > 0) return current.slice(0, dot)
  }

  return null
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
  bindFunctionCallInputs(fn, argumentValues, env, options.thisValue)

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
  if (specs.length === 0) return callSiteFallbackResult
  if (obligations !== 'pass') return callSiteFallbackResult

  const proof = verifyFunctionContract(context.program, functionName, context.contractCache)
  if (proof.status !== 'pass') return callSiteFallbackResult

  return valueWithFunctionContractSummary(functionName, context.program, fn, specs, argumentValues, context.contractCache, {
    kind: 'local',
    sourceFile: context.program.file,
    sourceFunctionName: functionName,
  }, fallbackResult, options.thisValue, options.callSiteBindings)
}

function evaluateArrayAtCall(expression: ts.CallExpression, context: EvalContext): Value | null {
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== 'at') return null
  const target = evaluateExpression(expression.expression.expression, context)
  if (target.kind !== 'array') return unknown('Array.at expected an array')
  const offset = expression.arguments.length === 1 ? numericLiteralValue(expression.arguments[0]!) : null
  if (offset == null || !Number.isInteger(offset) || offset >= 0) {
    return unknown('Array.at only supports constant negative indexes')
  }

  const requiredLength = -offset
  const longEnough = proveComparison(target.length, '>=', numberValue(requiredLength, requiredLength, true, `${requiredLength}`, linearConstant(requiredLength)), context.assumptions)
  if (longEnough.status !== 'pass') return unknown(`Array.at(${offset}) expected length >= ${requiredLength}; length was ${formatRange(target.length)}`)

  const fallback = expressionStructuralFallback(expression, context)
  if (target.elements != null) {
    if (context.insideLoop === true) return fallback ?? unknown(`Array.at(${offset}) on finite local arrays inside loops is not supported`)
    const value = target.elements[target.elements.length + offset]
    return value == null ? unknown(`Array.at(${offset}) has no matching element`) : valueWithStructuralFallback(value, fallback)
  }
  if (target.element != null) return valueWithStructuralFallback(target.element, fallback)
  return fallback ?? unknown(`Array.at(${offset}) element values are not tracked`)
}

function resolveIdentifierCallTarget(program: Program, name: string, seen = new Set<string>()): ResolvedCallTarget {
  if (program.functions.has(name)) return {kind: 'function', module: program, functionName: name}

  const key = `${program.sourceId}#${name}`
  if (seen.has(key)) return {kind: 'unresolved', reason: `Cyclic call alias at ${program.file}#${name}`}
  seen.add(key)

  const alias = program.callAliases.get(name)
  if (alias != null) return resolveCallAliasTarget(program, alias, seen)

  const unsupportedAlias = program.unsupportedCallAliases.get(name)
  if (unsupportedAlias != null) return {kind: 'unresolved', reason: unsupportedAlias}

  const binding = program.imports.get(name)
  if (binding == null) return {kind: 'unresolved', reason: `Unknown function ${name}`}
  if (binding.kind === 'unresolved') return {kind: 'unresolved', reason: importedContractUnavailableReason(name, binding, binding.reason)}
  return resolveImportedBindingCallTarget(name, binding, seen)
}

function resolveCallAliasTarget(program: Program, alias: FitCallAlias, seen: Set<string>): ResolvedCallTarget {
  switch (alias.kind) {
    case 'math':
      return {kind: 'math', name: alias.name}
    case 'identifier':
      return resolveIdentifierCallTarget(program, alias.name, seen)
    case 'namespace-member':
      return resolveNamespaceMemberCallTarget(program, alias.namespace, alias.exportedName, seen)
  }
}

function resolveNamespaceMemberCallTarget(program: Program, namespace: string, exportedName: string, seen: Set<string>): ResolvedCallTarget {
  const binding = program.imports.get(namespace)
  if (binding == null || binding.exportedName !== '*') {
    return {kind: 'unresolved', reason: `${namespace}.${exportedName} is not a supported namespace import call target`}
  }
  if (binding.kind === 'unresolved') {
    return {kind: 'unresolved', reason: importedContractUnavailableReason(`${namespace}.${exportedName}`, binding, binding.reason)}
  }
  return resolveExportedCallTarget(`${namespace}.${exportedName}`, binding, exportedName, seen)
}

function resolveImportedBindingCallTarget(localName: string, binding: Extract<ImportedBinding, {kind: 'resolved'}>, seen: Set<string>): ResolvedCallTarget {
  return resolveExportedCallTarget(localName, binding, binding.exportedName, seen)
}

function resolveExportedCallTarget(localName: string, binding: Extract<ImportedBinding, {kind: 'resolved'}>, exportedName: string, seen: Set<string>): ResolvedCallTarget {
  const exported = resolveFitExport(binding.module, exportedName)
  if (exported.kind === 'unresolved') return {kind: 'unresolved', reason: importedContractUnavailableReason(localName, binding, exported.reason)}

  const target = resolveIdentifierCallTarget(exported.module, exported.localName, seen)
  if (target.kind === 'function') return {...target, imported: {localName, binding}}
  return target
}

function evaluateResolvedCallTarget(
  callName: string,
  target: ResolvedCallTarget,
  expression: ts.CallExpression,
  context: EvalContext,
  structuralFallback: Value | null,
): Value {
  if (target.kind === 'math') return evaluateMathCall(target.name, expression.arguments, context)
  if (target.kind === 'unresolved') return structuralFallback ?? unknown(target.reason)

  const fn = target.module.functions.get(target.functionName)
  if (fn == null) return structuralFallback ?? unknown(`Resolved call target ${target.functionName} is not a supported function`)
  const argumentValues = expression.arguments.map(argument => evaluateExpression(argument, context))
  const callText = `${callName}(${expression.arguments.map(argument => argument.getText(context.program.sourceFile)).join(', ')})`
  const callLine = lineNumberForNode(context.program.sourceFile, expression)
  const callSiteBindings = callSiteBindingsFor(fn, expression.arguments, context.program.sourceFile, undefined, argumentValues)

  if (target.module === context.program) {
    return evaluateLocalFunctionCall(target.functionName, fn, argumentValues, context, {
      callText,
      callLine,
      fallback: structuralFallback,
      callSiteBindings,
    })
  }

  return evaluateImportedFunctionCall(callName, target, fn, argumentValues, callText, callLine, context, structuralFallback, callSiteBindings)
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
  const resolvedStructuralFallback = structuralFallback ?? structuralShape(valueFromFunctionReturnShape(`${target.functionName}Result`, fn.node, target.module))
  if (target.imported == null) return resolvedStructuralFallback ?? unknown(`Call target ${callName} resolved outside the current module without an import binding`)
  if (specs.length === 0) {
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

  return valueWithFunctionContractSummary(callName, target.module, fn, specs, argumentValues, context.contractCache, {
    kind: 'imported',
    sourceFile: target.module.file,
    sourceFunctionName: fn.name,
  }, resolvedStructuralFallback ?? unknownResultValue(specs, target.module), undefined, callSiteBindings)
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

function evaluateNamespaceImportedCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, context: EvalContext): Value | null {
  if (!ts.isIdentifier(target.expression)) return null
  const binding = context.program.imports.get(target.expression.text)
  if (binding?.exportedName !== '*') return null
  const functionName = `${target.expression.text}.${target.name.text}`
  const structuralFallback = structuralShape(valueFromCallReturnShape(expression.getText(context.program.sourceFile), expression, context.program))
  const resolved = binding.kind === 'unresolved'
    ? {kind: 'unresolved', reason: importedContractUnavailableReason(functionName, binding, binding.reason)} satisfies ResolvedCallTarget
    : resolveExportedCallTarget(functionName, binding, target.name.text, new Set())
  return evaluateResolvedCallTarget(functionName, resolved, expression, context, structuralFallback)
}

function evaluateArrayMapCall(expression: ts.CallExpression, context: EvalContext): Value | null {
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== 'map') return null
  const source = evaluateExpression(expression.expression.expression, context)
  if (source.kind !== 'array') return unknown('Array.map expected an array')
  const callback = expression.arguments[0]
  if (callback == null || expression.arguments.length !== 1 || !isArrayCallbackFunction(callback)) return unknown('Array.map expects one arrow or function callback')
  const params = simpleArrayCallbackParams(callback)
  if (params == null) return unknown('Array.map callback expected one simple item parameter and optional index parameter')
  const sourceName = source.expr ?? expression.expression.expression.getText(context.program.sourceFile)
  const item = source.element ?? unknownObject(`${sourceName}[]`)
  const env = new Map(context.env).set(params.itemName, item)
  if (params.indexName != null) {
    const index = indexedElementPathValue(`mapIndex(${sourceName})`, source.length)
    env.set(params.indexName, index)
    context.assumptions = mergeAssumptions(context.assumptions, indexedElementPathAssumptions(index, source.length))
  }
  const callbackContext = {...context, env}
  const element = evaluateArrayMapCallbackBody(callback, callbackContext)
  const mapped = {
    kind: 'array',
    length: source.length,
    elements: null,
    element,
    expr: null,
    summary: emptyArraySummary(mapOrigin(source, sourceName)),
  } satisfies ArrayValue
  return valueWithStructuralFallback(mapped, expressionStructuralFallback(expression, context))
}

function isArrayCallbackFunction(expression: ts.Expression): expression is ArrayCallbackFunction {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
}

function evaluateArrayMapCallbackBody(callback: ArrayCallbackFunction, context: EvalContext): Value {
  if (ts.isExpression(callback.body)) return evaluateExpression(callback.body, context)
  return evaluateArrayMapCallbackBlock(callback.body, context)
}

function evaluateArrayMapCallbackBlock(block: ts.Block, context: EvalContext): Value {
  const flow = evaluateArrayMapCallbackStatements(block.statements, context)
  return flow.kind === 'return' ? flow.value : unknown('Array.map callback block did not return')
}

function evaluateArrayMapCallbackStatements(statements: ts.NodeArray<ts.Statement>, context: EvalContext, startIndex = 0): EvalFlow {
  for (let index = startIndex; index < statements.length; index++) {
    const statement = statements[index]!
    if (ts.isVariableStatement(statement)) {
      if (!isConstDeclarationList(statement.declarationList)) return {kind: 'return', value: unsupportedArrayMapCallbackBlock()}
      bindVariableStatement(statement, context)
      continue
    }
    if (ts.isReturnStatement(statement)) {
      if (statement.expression == null) return {kind: 'return', value: unknown('Array.map callback block return expected an expression')}
      return {kind: 'return', value: evaluateExpression(statement.expression, context)}
    }
    if (ts.isIfStatement(statement)) {
      const flow = evaluateArrayMapCallbackIfStatement(statement, context, statements, index + 1)
      if (flow.kind !== 'fallthrough') return flow
      continue
    }
    if (ts.isThrowStatement(statement)) return {kind: 'exit'}
    return {kind: 'return', value: unsupportedArrayMapCallbackBlock()}
  }
  return {kind: 'fallthrough'}
}

function evaluateArrayMapCallbackIfStatement(statement: ts.IfStatement, context: EvalContext, statements: ts.NodeArray<ts.Statement>, nextIndex: number): EvalFlow {
  if (!isSideEffectFreeExpression(statement.expression)) return {kind: 'return', value: unsupportedArrayMapCallbackBlock()}
  const condition = evaluateConditionFacts(statement.expression, context)
  if (condition.truth === 'true') return evaluateArrayMapCallbackBranchStatement(statement.thenStatement, context)
  if (condition.truth === 'false') {
    return statement.elseStatement == null ? {kind: 'fallthrough'} : evaluateArrayMapCallbackElseBranchStatement(statement.elseStatement, context, statements, nextIndex)
  }

  const trueContext = contextWithEnvAndAssumptions(context, refinedEnvForCondition(context, statement.expression, true), condition.trueAssumptions)
  const falseContext = contextWithEnvAndAssumptions(context, refinedEnvForCondition(context, statement.expression, false), condition.falseAssumptions)
  const trueFlow = evaluateArrayMapCallbackBranchStatement(statement.thenStatement, trueContext)
  const falseFlow = statement.elseStatement == null
    ? {kind: 'fallthrough'} satisfies EvalFlow
    : evaluateArrayMapCallbackElseBranchStatement(statement.elseStatement, falseContext, statements, nextIndex)
  if (isNonFallthroughFlow(trueFlow) && isNonFallthroughFlow(falseFlow)) {
    return joinNonFallthroughFlows(trueFlow, condition.trueAssumptions, falseFlow, condition.falseAssumptions, arrayMapCallbackDidNotReturnReason)
  }
  if (trueFlow.kind === 'exit') {
    context.env = envWithAssumptions(falseContext.env, condition.falseAssumptions)
    context.assumptions = falseContext.assumptions
    return {kind: 'fallthrough'}
  }
  if (falseFlow.kind === 'exit') {
    context.env = envWithAssumptions(trueContext.env, condition.trueAssumptions)
    context.assumptions = trueContext.assumptions
    return {kind: 'fallthrough'}
  }
  if (trueFlow.kind === 'return') {
    const falseContinuationFlow = evaluateArrayMapCallbackStatements(statements, falseContext, nextIndex)
    return joinNonFallthroughFlows(trueFlow, condition.trueAssumptions, falseContinuationFlow, condition.falseAssumptions, arrayMapCallbackDidNotReturnReason)
  }
  if (falseFlow.kind === 'return') {
    const trueContinuationFlow = evaluateArrayMapCallbackStatements(statements, trueContext, nextIndex)
    return joinNonFallthroughFlows(trueContinuationFlow, condition.trueAssumptions, falseFlow, condition.falseAssumptions, arrayMapCallbackDidNotReturnReason)
  }
  context.env = joinEnvironments(
    envWithAssumptions(trueContext.env, condition.trueAssumptions),
    envWithAssumptions(falseContext.env, condition.falseAssumptions),
  )
  return {kind: 'fallthrough'}
}

function evaluateArrayMapCallbackElseBranchStatement(statement: ts.Statement, context: EvalContext, statements: ts.NodeArray<ts.Statement>, nextIndex: number): EvalFlow {
  return ts.isIfStatement(statement)
    ? evaluateArrayMapCallbackIfStatement(statement, context, statements, nextIndex)
    : evaluateArrayMapCallbackBranchStatement(statement, context)
}

function evaluateArrayMapCallbackBranchStatement(statement: ts.Statement, context: EvalContext): EvalFlow {
  if (ts.isReturnStatement(statement)) {
    if (statement.expression == null) return {kind: 'return', value: unknown('Array.map callback block return expected an expression')}
    return {kind: 'return', value: evaluateExpression(statement.expression, context)}
  }
  if (ts.isThrowStatement(statement)) return {kind: 'exit'}
  if (!ts.isBlock(statement)) return {kind: 'return', value: unsupportedArrayMapCallbackBlock()}
  return evaluateArrayMapCallbackStatements(statement.statements, context)
}

function unsupportedArrayMapCallbackBlock(): Value {
  return unknown('Array.map callback block supports const bindings, if branches, and return only')
}

const arrayMapCallbackDidNotReturnReason = 'Array.map callback block did not return'

function evaluateArrayFilterCall(expression: ts.CallExpression, context: EvalContext): Value | null {
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== 'filter') return null
  const source = evaluateExpression(expression.expression.expression, context)
  if (source.kind !== 'array') return unknown('Array.filter expected an array')
  const callback = expression.arguments[0]
  if (callback == null || expression.arguments.length !== 1 || !ts.isArrowFunction(callback)) return unknown('Array.filter expects one arrow callback')
  if (simpleArrayCallbackParams(callback) == null || !ts.isExpression(callback.body) || !isSideEffectFreeExpression(callback.body)) {
    return unknown('Array.filter callback expected a simple side-effect-free predicate')
  }

  const length = filteredArrayLength(expression, source, context)
  const fact = comparisonConstraint(length, '<=', source.length, `${length.expr ?? 'filtered.length'} <= ${source.length.expr ?? formatRange(source.length)}`)
  if (fact != null) context.assumptions = mergeAssumptions(context.assumptions, [fact])

  const filtered = {
    kind: 'array',
    length,
    elements: null,
    element: source.element,
    expr: null,
    summary: emptyArraySummary(filterOrigin(source, source.expr ?? expression.expression.expression.getText(context.program.sourceFile))),
  } satisfies ArrayValue
  return valueWithStructuralFallback(filtered, expressionStructuralFallback(expression, context))
}

function mapOrigin(source: ArrayValue, sourceExpr: string): ArrayOrigin {
  const origin = source.summary?.origin
  if (origin?.kind === 'subsequence') return {kind: 'subsequence', sourceExpr: origin.sourceExpr}
  if (origin?.kind === 'identity') return {kind: 'identity', sourceExpr: origin.sourceExpr}
  return {kind: 'identity', sourceExpr}
}

function filterOrigin(source: ArrayValue, sourceExpr: string): ArrayOrigin {
  return {kind: 'subsequence', sourceExpr: source.summary?.origin?.sourceExpr ?? sourceExpr}
}

function emptyArraySummary(origin: ArrayOrigin | null): ArraySummary {
  return {
    origin,
    relations: [],
    nondecreasingProps: [],
    advances: [],
    spaced: [],
    lastEnd: null,
    extentEnds: [],
  }
}

function simpleArrayCallbackParams(callback: ArrayCallbackFunction): {itemName: string; indexName: string | null} | null {
  const itemParam = callback.parameters[0]
  const indexParam = callback.parameters[1]
  if (itemParam == null || callback.parameters.length > 2 || !ts.isIdentifier(itemParam.name)) return null
  if (indexParam == null) return {itemName: itemParam.name.text, indexName: null}
  if (!ts.isIdentifier(indexParam.name)) return null
  return {itemName: itemParam.name.text, indexName: indexParam.name.text}
}

function filteredArrayLength(expression: ts.CallExpression, source: ArrayValue, context: EvalContext): NumberValue {
  const expr = context.objectPath == null
    ? `${expression.getText(context.program.sourceFile)}.length`
    : `${objectPathText(context.objectPath)}.length`
  return numberValue(
    0,
    source.length.max,
    true,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}

function isConstDeclarationList(list: ts.VariableDeclarationList) {
  return (list.flags & ts.NodeFlags.Const) !== 0
}

function evaluateExtentEndConditional(expression: ts.ConditionalExpression, context: EvalContext): NumberValue | null {
  const condition = arrayLengthZeroCondition(expression.condition, context)
  if (condition == null) return null

  const trueValue = evaluateExpression(expression.whenTrue, context)
  const falseValue = evaluateExpression(expression.whenFalse, context)
  if (trueValue.kind !== 'number' || falseValue.kind !== 'number') return null

  const emptyValue = condition.emptyWhenTrue ? trueValue : falseValue
  const nonEmptyValue = condition.emptyWhenTrue ? falseValue : trueValue
  if (emptyValue.expr == null || nonEmptyValue.expr == null) return null
  return extentEndSummaryValue(condition.array, emptyValue.expr, nonEmptyValue.expr)
}

function arrayLengthZeroCondition(expression: ts.Expression, context: EvalContext): {array: ArrayValue; emptyWhenTrue: boolean} | null {
  if (!ts.isBinaryExpression(expression)) return null
  const leftLength = arrayFromLengthExpression(expression.left, context)
  const rightLength = arrayFromLengthExpression(expression.right, context)
  const leftZero = numericLiteralValue(expression.left) === 0
  const rightZero = numericLiteralValue(expression.right) === 0
  const op = expression.operatorToken.kind

  if (leftLength != null && rightZero && (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)) return {array: leftLength, emptyWhenTrue: true}
  if (rightLength != null && leftZero && (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)) return {array: rightLength, emptyWhenTrue: true}
  if (leftLength != null && rightZero && op === ts.SyntaxKind.GreaterThanToken) return {array: leftLength, emptyWhenTrue: false}
  if (rightLength != null && leftZero && op === ts.SyntaxKind.LessThanToken) return {array: rightLength, emptyWhenTrue: false}
  return null
}

function arrayFromLengthExpression(expression: ts.Expression, context: EvalContext): ArrayValue | null {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'length') return null
  const value = evaluateExpression(expression.expression, context)
  return value.kind === 'array' ? value : null
}

function evaluateLastEndCall(expression: ts.CallExpression, context: EvalContext): Value {
  const targetExpression = expression.arguments[0]
  if (targetExpression == null || expression.arguments.length !== 1) return unknown('lastEnd expects one array')
  const target = evaluateExpression(targetExpression, context)
  if (target.kind !== 'array') return unknown('lastEnd expected an array')
  return target.summary?.lastEnd ?? unknown(lastEndFailureReason(targetExpression.getText(), target))
}

function evaluateExtentEndCall(expression: ts.CallExpression, context: EvalContext): Value {
  const targetExpression = expression.arguments[0]
  const emptyExpression = expression.arguments[1]
  if (targetExpression == null || emptyExpression == null || expression.arguments.length !== 2) return unknown('extentEnd expects extentEnd(rows, emptyValue)')
  const target = evaluateExpression(targetExpression, context)
  if (target.kind !== 'array') return unknown('extentEnd expected an array')
  const empty = evaluateExpression(emptyExpression, context)
  if (empty.kind !== 'number' || empty.expr == null) return unknown('extentEnd expected a known empty value')

  if (target.length.max === 0) return empty
  if (target.length.min >= 1 && target.summary?.lastEnd != null) return target.summary.lastEnd
  return extentEndSummaryValue(target, empty.expr) ?? unknown(extentEndFailureReason(targetExpression.getText(), empty.expr, target))
}

function lastEndFailureReason(targetText: string, target: ArrayValue) {
  const missing = target.length.min >= 1 ? 'pushed row height for lastEnd' : 'row height and non-empty length for lastEnd'
  const publicTargetText = publicFitText(targetText)
  const lines = [
    `lastEnd(${publicTargetText}) was not inferred`,
    'need: a non-empty append-only row loop that pushes height',
    `known:\n  rows length: ${formatRange(target.length)}\n  sequence facts: ${formatArraySummary(target)}`,
  ]
  lines.push(`missing: ${missing}`)
  return lines.join('\n')
}

function extentEndFailureReason(targetText: string, emptyExpr: string, target: ArrayValue) {
  const publicTargetText = publicFitText(targetText)
  const publicEmptyExpr = publicFitText(emptyExpr)
  const lines = [
    `extentEnd(${publicTargetText}, ${publicEmptyExpr}) was not inferred`,
    'need: an append-only row loop plus the empty fallback used by the source',
    `known:\n  rows length: ${formatRange(target.length)}\n  sequence facts: ${formatArraySummary(target)}`,
  ]
  lines.push('missing: empty-safe row end')
  return lines.join('\n')
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
  if (fn == null || specs.length === 0) {
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
  bindFunctionCallInputs(fn, argumentValues, env, thisValue)
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
  return {...base, elements}
}

function verifyCallGivenSpecs(
  calleeProgram: Program,
  fn: FitFunction,
  callText: string,
  argumentValues: Value[],
  context: EvalContext,
  options: {record: boolean; callLine?: number | undefined; thisValue?: Value | undefined; callSiteBindings?: CallSiteBindings | undefined},
) {
  const specs = calleeProgram.specsByFunction.get(fn.name) ?? []
  const env = programGlobalEnv(calleeProgram)
  let statusSummary: FitCheckStatus = 'pass'
  bindFunctionCallInputs(fn, argumentValues, env, options.thisValue)
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
    `this call passes ${formatCallBinding(spec.left, left)} and ${formatCallBinding(spec.right, right)}`,
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

function evaluateMathCall(name: string, args: ts.NodeArray<ts.Expression>, context: EvalContext): Value {
  const values = args.map(arg => evaluateExpression(arg, context))
  const numbers: NumberValue[] = []
  for (const value of values) {
    if (value.kind !== 'number') return unknown(`Math.${name} expected numbers`)
    numbers.push(value)
  }

  switch (name) {
    case 'floor': {
      const value = numbers[0]
      if (value == null) return unknown('Math.floor expects one argument')
      return evaluateNumberUnary(value, floorNumber)
    }
    case 'ceil': {
      const value = numbers[0]
      if (value == null) return unknown('Math.ceil expects one argument')
      return evaluateNumberUnary(value, ceilNumber)
    }
    case 'round': {
      const value = numbers[0]
      if (value == null) return unknown('Math.round expects one argument')
      return evaluateNumberUnary(value, roundNumber)
    }
    case 'trunc': {
      const value = numbers[0]
      if (value == null) return unknown('Math.trunc expects one argument')
      return evaluateNumberUnary(value, truncNumber)
    }
    case 'abs': {
      const value = numbers[0]
      if (value == null) return unknown('Math.abs expects one argument')
      return absNumber(value, context.assumptions)
    }
    case 'sqrt': {
      const value = numbers[0]
      if (value == null) return unknown('Math.sqrt expects one argument')
      return evaluateNumberUnary(value, sqrtNumber)
    }
    case 'sign': {
      const value = numbers[0]
      if (value == null) return unknown('Math.sign expects one argument')
      return evaluateNumberUnary(value, signNumber)
    }
    case 'min': {
      if (numbers.length === 0) return unknown('Math.min expects at least one argument')
      return numbers.slice(1).reduce((current, next) => minNumberPair(current, next, context.assumptions), numbers[0]!)
    }
    case 'max': {
      if (numbers.length === 0) return unknown('Math.max expects at least one argument')
      return numbers.slice(1).reduce((current, next) => maxNumberPair(current, next, context.assumptions), numbers[0]!)
    }
    default:
      return unknown(`Math.${name} is not in the static layout subset`)
  }
}

function evaluateNumberUnary(value: NumberValue, evaluate: (value: NumberValue) => Value): Value {
  const plain = evaluate(plainNumber(value))
  if (plain.kind !== 'number') return plain
  if (value.cases == null) return plain

  const cases: NumberCase[] = []
  for (const valueCase of value.cases) {
    const caseResult = evaluate(valueCase.value)
    if (caseResult.kind !== 'number') return plain
    cases.push({value: caseResult, assumptions: valueCase.assumptions})
    if (cases.length > maxNumberCases) return plain
  }
  return withNumberCases(plain, cases)
}

function floorNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.floor(value.min), Math.floor(value.max), true, value.expr == null ? null : `floor(${value.expr})`, null, null, value.provenance)
}

function ceilNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.ceil(value.min), Math.ceil(value.max), true, value.expr == null ? null : `ceil(${value.expr})`, null, null, value.provenance)
}

function roundNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.round(value.min), Math.round(value.max), true, value.expr == null ? null : `round(${value.expr})`, null, null, value.provenance)
}

function truncNumber(value: NumberValue): NumberValue {
  if (value.isInteger) return numberValue(value.min, value.max, true, value.expr, value.linear, null, value.provenance)
  return numberValue(Math.trunc(value.min), Math.trunc(value.max), true, value.expr == null ? null : `trunc(${value.expr})`, null, null, value.provenance)
}

function sqrtNumber(value: NumberValue): Value {
  if (value.min < 0) return unknown('Math.sqrt over a negative range is unsupported')
  return numberValue(Math.sqrt(value.min), Math.sqrt(value.max), false, value.expr == null ? null : `sqrt(${value.expr})`, null, null, value.provenance)
}

function signNumber(value: NumberValue): NumberValue {
  const expr = value.expr == null ? null : `sign(${value.expr})`
  if (value.min === 0 && value.max === 0) return numberValue(0, 0, true, expr, null, null, value.provenance)
  if (value.min > 0) return numberValue(1, 1, true, expr, null, null, value.provenance)
  if (value.max < 0) return numberValue(-1, -1, true, expr, null, null, value.provenance)
  if (value.min >= 0) return numberValue(0, 1, true, expr, null, null, value.provenance)
  if (value.max <= 0) return numberValue(-1, 0, true, expr, null, null, value.provenance)
  return numberValue(-1, 1, true, expr, null, null, value.provenance)
}

function absNumber(value: NumberValue, assumptions: LinearConstraint[]): NumberValue {
  const plain = plainNumber(value)
  if (plain.min >= 0) return withNumberCases(plain, value.cases)
  if (plain.max <= 0) {
    const result = evaluateNumberUnary(value, current => numberValue(-current.max, -current.min, current.isInteger, current.expr == null ? null : `abs(${current.expr})`, linearScale(current.linear, -1), null, current.provenance))
    return result.kind === 'number' ? result : numberValue(-plain.max, -plain.min, plain.isInteger, plain.expr == null ? null : `abs(${plain.expr})`, linearScale(plain.linear, -1), null, plain.provenance)
  }

  const max = Math.max(Math.abs(plain.min), Math.abs(plain.max))
  const joined = numberValue(0, max, plain.isInteger, plain.expr == null ? null : `abs(${plain.expr})`, null, null, plain.provenance)
  const cases: NumberCase[] = []
  for (const valueCase of numberBranches(value)) {
    const nonNegative = comparisonConstraint(valueCase.value, '>=', numberValue(0, 0, true, '0', linearConstant(0)), undefined, 'branch')
    const nonPositive = comparisonConstraint(valueCase.value, '<=', numberValue(0, 0, true, '0', linearConstant(0)), undefined, 'branch')
    if (nonNegative == null || nonPositive == null) return joined

    const positiveStatus = proveComparisonPlain(valueCase.value, '>=', numberValue(0, 0, true, '0', linearConstant(0)), mergeAssumptions(assumptions, valueCase.assumptions))
    const negativeStatus = proveComparisonPlain(valueCase.value, '<=', numberValue(0, 0, true, '0', linearConstant(0)), mergeAssumptions(assumptions, valueCase.assumptions))

    if (positiveStatus.status !== 'fail') {
      cases.push({
        value: valueCase.value,
        assumptions: positiveStatus.status === 'pass' ? valueCase.assumptions : mergeAssumptions(valueCase.assumptions, [nonNegative]),
      })
    }
    if (negativeStatus.status !== 'fail') {
      cases.push({
        value: numberValue(-valueCase.value.max, -valueCase.value.min, valueCase.value.isInteger, valueCase.value.expr == null ? null : `abs(${valueCase.value.expr})`, linearScale(valueCase.value.linear, -1), null, valueCase.value.provenance),
        assumptions: negativeStatus.status === 'pass' ? valueCase.assumptions : mergeAssumptions(valueCase.assumptions, [nonPositive]),
      })
    }
    if (cases.length > maxNumberCases) return joined
  }
  return withNumberCases(joined, cases)
}

function minNumberPair(left: NumberValue, right: NumberValue, assumptions: LinearConstraint[]): NumberValue {
  return choiceNumberPair('min', left, right, '<=', '<=', assumptions)
}

function maxNumberPair(left: NumberValue, right: NumberValue, assumptions: LinearConstraint[]): NumberValue {
  return choiceNumberPair('max', left, right, '>=', '>=', assumptions)
}

function choiceNumberPair(
  name: 'min' | 'max',
  left: NumberValue,
  right: NumberValue,
  leftOp: ComparisonOperator,
  rightOp: ComparisonOperator,
  assumptions: LinearConstraint[],
): NumberValue {
  const plainLeft = plainNumber(left)
  const plainRight = plainNumber(right)
  const joined =
    name === 'min'
      ? numberValue(Math.min(plainLeft.min, plainRight.min), Math.min(plainLeft.max, plainRight.max), plainLeft.isInteger && plainRight.isInteger, callExpr(name, [plainLeft, plainRight]), null, null, mergeProvenance(plainLeft, plainRight))
      : numberValue(Math.max(plainLeft.min, plainRight.min), Math.max(plainLeft.max, plainRight.max), plainLeft.isInteger && plainRight.isInteger, callExpr(name, [plainLeft, plainRight]), null, null, mergeProvenance(plainLeft, plainRight))

  const cases: NumberCase[] = []
  for (const leftCase of numberBranches(left)) {
    for (const rightCase of numberBranches(right)) {
      const baseAssumptions = mergeAssumptions(assumptions, leftCase.assumptions, rightCase.assumptions)
      const leftWins = proveComparisonPlain(leftCase.value, leftOp, rightCase.value, baseAssumptions)
      const rightWins = proveComparisonPlain(rightCase.value, rightOp, leftCase.value, baseAssumptions)

      if (leftWins.status !== 'fail') {
        const fact = comparisonConstraint(leftCase.value, leftOp, rightCase.value, undefined, 'branch')
        if (leftWins.status === 'pass') {
          cases.push({
            value: leftCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions),
          })
        } else if (fact != null) {
          cases.push({
            value: leftCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions, [fact]),
          })
        }
      }
      if (rightWins.status !== 'fail') {
        const fact = comparisonConstraint(rightCase.value, rightOp, leftCase.value, undefined, 'branch')
        if (rightWins.status === 'pass') {
          cases.push({
            value: rightCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions),
          })
        } else if (fact != null) {
          cases.push({
            value: rightCase.value,
            assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions, [fact]),
          })
        }
      }
      if (cases.length > maxNumberCases) return joined
    }
  }

  return withNumberCases(joined, cases)
}

function evaluatePropertyAccess(expression: ts.PropertyAccessExpression, context: EvalContext): Value {
  const target = evaluateExpression(expression.expression, context)
  const fallback = expressionStructuralFallback(expression, context)
  const getterResult = evaluateClassGetterAccess(expression, context, fallback)
  if (getterResult != null) return getterResult
  const optional = hasQuestionDotToken(expression)
  if (target.kind === 'nullable' && optional) {
    const present = evaluatePresentPropertyAccess(target.present, expression, context, fallback)
    return nullableValue(present, expression.getText(context.program.sourceFile), 'undefined')
  }
  if (target.kind === 'null' && optional) return nullValue('undefined')
  return evaluatePresentPropertyAccess(target, expression, context, fallback)
}

function evaluatePresentPropertyAccess(target: Value, expression: ts.PropertyAccessExpression, context: EvalContext, fallback: Value | null): Value {
  if (target.kind === 'array' && expression.name.text === 'length') return target.length
  if (target.kind === 'unknown') return fallback ?? target
  if (target.kind === 'nullable') return fallback ?? unknown(`Nullable value ${target.expr ?? expression.expression.getText(context.program.sourceFile)} was not proven present`)
  if (target.kind === 'null') return fallback ?? unknown(`Property access ${expression.name.text} expected a present object`)
  if (target.kind !== 'object') return fallback ?? unknown(`Property access ${expression.name.text} expected an object`)
  const value = target.props.get(expression.name.text) ?? (target.expr == null ? unknown(`Unknown property ${expression.name.text}`) : unknownNumber(`${target.expr}.${expression.name.text}`))
  return valueWithStructuralFallback(value, fallback)
}

function evaluateElementAccess(expression: ts.ElementAccessExpression, context: EvalContext): Value {
  const target = evaluateExpression(expression.expression, context)
  const fallback = expressionStructuralFallback(expression, context)
  const optional = hasQuestionDotToken(expression)
  if (target.kind === 'nullable' && optional) {
    const present = evaluatePresentElementAccess(target.present, expression, context, fallback)
    return nullableValue(present, expression.getText(context.program.sourceFile), 'undefined')
  }
  if (target.kind === 'null' && optional) return nullValue('undefined')
  return evaluatePresentElementAccess(target, expression, context, fallback)
}

function evaluatePresentElementAccess(target: Value, expression: ts.ElementAccessExpression, context: EvalContext, fallback: Value | null): Value {
  if (target.kind === 'unknown') return fallback ?? target
  if (target.kind === 'nullable') return fallback ?? unknown(`Nullable value ${target.expr ?? expression.expression.getText(context.program.sourceFile)} was not proven present`)
  if (target.kind === 'null') return fallback ?? unknown('Element access expected a present array')
  if (target.kind !== 'array') return fallback ?? unknown(`Element access expected an array`)
  const targetRoot = expressionRootName(expression.expression)
  if (
    context.insideLoop === true
    && target.elements != null
    && targetRoot != null
    && expressionMentionsArrayLength(expression.argumentExpression, targetRoot)
  ) {
    return unknown('Array length-derived index on finite local arrays inside loops is not supported')
  }
  const index = evaluateExpression(expression.argumentExpression, context)
  if (index.kind !== 'number') return unknown('Array index expected a number')
  if (!index.isInteger) return unknown(`Array index ${formatRange(index)} was not proven integer`)
  const lower = proveComparison(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), context.assumptions)
  const upper = proveComparison(index, '<', target.length, context.assumptions)
  if (lower.status !== 'pass' || upper.status !== 'pass') return unknown(`Array index ${formatRange(index)} was not proven inside length ${formatRange(target.length)}`)
  const sourceName = target.expr ?? expression.expression.getText(context.program.sourceFile)
  const indexText = expression.argumentExpression.getText(context.program.sourceFile)
  const accessExpr = `${sourceName}[${indexText}]`
  const sourceElementExpr = `${sourceName}[]`
  const adjacentFacts = adjacentElementAccessFacts(target, index, sourceName, indexText, accessExpr, context.assumptions)
  if (adjacentFacts.length > 0) context.assumptions = mergeAssumptions(context.assumptions, adjacentFacts)
  if (target.elements == null) {
    const element = target.element == null
      ? unknown('Array element values are not tracked')
      : context.insideLoop === true
        ? target.element
        : valueWithRebasedElementPath(target.element, sourceElementExpr, accessExpr)
    return valueWithStructuralFallback(element, fallback)
  }
  const caseValue = elementValueForIndexCases(target, index)
  if (caseValue != null) return valueWithStructuralFallback(caseValue, fallback)
  const start = Math.max(0, Math.ceil(index.min))
  const end = Math.min(target.elements.length - 1, Math.floor(index.max))
  const valueAt = (i: number) => target.elements?.[i] ?? target.element ?? unknown('Array element values are not tracked')
  let value = start > end ? valueAt(Math.max(0, Math.ceil(index.min))) : valueAt(start)
  for (let i = start + 1; i <= end; i++) value = joinValues(value, valueAt(i))
  return valueWithStructuralFallback(value, fallback)
}

function hasQuestionDotToken(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
  return (expression as {questionDotToken?: ts.QuestionDotToken}).questionDotToken != null
}

function expressionMentionsArrayLength(expression: ts.Expression | undefined, root: string): boolean {
  if (expression == null) return false
  if (
    ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'length'
    && expressionRootName(expression.expression) === root
  ) return true
  for (const child of expression.getChildren()) {
    if (ts.isExpression(child) && expressionMentionsArrayLength(child, root)) return true
  }
  return false
}

function evaluateObjectLiteral(expression: ts.ObjectLiteralExpression, context: EvalContext): Value {
  const props = new Map<string, Value>()
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadValue = evaluateExpression(property.expression, context)
      if (spreadValue.kind !== 'object') return unknown('Object spread expected an object')
      for (const [name, value] of spreadValue.props) props.set(name, value)
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const propertyPath = objectPropertyPath(context, property.name.text)
      const specs = parseInlineFitSpecsForExpression(context.program.sourceText, property, objectPathText(propertyPath))
      const evaluate = () => evaluateExpressionWithObjectPath(property.name, context, propertyPath)
      const value = specs.length > 0 ? withCallObligationRecording(context, evaluate) : evaluate()
      props.set(property.name.text, value)
      verifyInlineSpecsForValue(specs, value, context)
      continue
    }
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      const propertyPath = objectPropertyPath(context, property.name.text)
      const specs = parseInlineFitSpecsForExpression(context.program.sourceText, property, objectPathText(propertyPath))
      const evaluate = () => evaluateExpressionWithObjectPath(property.initializer, context, propertyPath)
      const value = specs.length > 0 ? withCallObligationRecording(context, evaluate) : evaluate()
      props.set(property.name.text, value)
      verifyInlineSpecsForValue(specs, value, context)
      continue
    }
    return unknown(`Unsupported object literal property: ${property.getText(context.program.sourceFile)}`)
  }
  return {kind: 'object', props, expr: null}
}

function evaluateExpressionWithObjectPath(expression: ts.Expression, context: EvalContext, objectPath: string[]): Value {
  const previous = context.objectPath
  context.objectPath = objectPath
  try {
    return evaluateExpression(expression, context)
  } finally {
    if (previous == null) delete context.objectPath
    else context.objectPath = previous
  }
}

function objectPropertyPath(context: EvalContext, propertyName: string): string[] {
  return [...(context.objectPath ?? []), propertyName]
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

function evaluateArrayLiteral(expression: ts.ArrayLiteralExpression, context: EvalContext): Value {
  let length = numberValue(0, 0, true, '0', linearConstant(0))
  let elements: Value[] | null = []
  let elementValue: Value | null = null
  let hasSpread = false

  for (const element of expression.elements) {
    if (ts.isSpreadElement(element)) {
      hasSpread = true
      const spreadValue = evaluateExpression(element.expression, context)
      if (spreadValue.kind !== 'array') return unknown('Array spread expected an array')
      const nextLength = evaluateNumberBinary(ts.SyntaxKind.PlusToken, length, spreadValue.length)
      if (nextLength.kind !== 'number') return nextLength
      length = nextLength
      elements = elements == null || spreadValue.elements == null ? null : [...elements, ...spreadValue.elements]
      elementValue = mergeElementValue(elementValue, spreadValue.element)
      continue
    }

    const value = evaluateExpression(element, context)
    const nextLength = evaluateNumberBinary(ts.SyntaxKind.PlusToken, length, numberValue(1, 1, true, '1', linearConstant(1)))
    if (nextLength.kind !== 'number') return nextLength
    length = nextLength
    if (elements != null) elements.push(value)
    elementValue = mergeElementValue(elementValue, value)
  }

  if (!hasSpread) {
    const fixedLength = expression.elements.length
    length = numberValue(fixedLength, fixedLength, true, `${fixedLength}`, linearConstant(fixedLength))
  }

  return {kind: 'array', length, elements, element: elementValue, expr: null, summary: null}
}

function unknownIdentifierReason(name: string) {
  return `Unknown identifier ${name}`
}

function evaluateConditionFacts(expression: ts.Expression, context: EvalContext): ConditionFacts {
  const presence = evaluatePresenceConditionFacts(expression, context)
  if (presence != null) return presence
  if (!ts.isBinaryExpression(expression)) return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const op = expression.operatorToken.kind
  if (!isComparisonSyntax(op)) return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const left = evaluateExpression(expression.left, context)
  const right = evaluateExpression(expression.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  return comparisonConditionFacts(left, syntaxToComparison(op), right, context.assumptions)
}

function evaluatePresenceConditionFacts(expression: ts.Expression, context: EvalContext): ConditionFacts | null {
  const guard = presenceGuardForCondition(expression)
  if (guard == null) return null
  const target = evaluateExpression(guard.target, context)
  const presentTruth = guard.presentWhenTrue ? 'true' : 'false'
  const truth = target.kind === 'null'
    ? knownAbsentPresenceTruth('null', guard)
    : target.kind === 'nullable'
      ? nullablePresenceTruth(target.absent, guard, presentTruth)
      : target.kind === 'unknown'
      ? 'maybe'
      : presentTruth
  return {truth, trueAssumptions: [], falseAssumptions: []}
}

function nullablePresenceTruth(absent: NullishKind, guard: PresenceGuard, presentTruth: 'true' | 'false'): 'true' | 'false' | 'maybe' {
  const absentTruth = knownAbsentPresenceTruth(absent, guard)
  return absentTruth === presentTruth ? presentTruth : 'maybe'
}

function knownAbsentPresenceTruth(absent: NullishKind, guard: PresenceGuard): 'true' | 'false' | 'maybe' {
  if (guard.nullish === 'nullish') return guard.presentWhenTrue ? 'false' : 'true'
  if (absent === 'nullish') return 'maybe'
  if (absent === guard.nullish) return guard.presentWhenTrue ? 'false' : 'true'
  return guard.presentWhenTrue ? 'true' : 'false'
}

function isComparisonSyntax(kind: ts.SyntaxKind) {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.LessThanToken
  )
}

function syntaxToComparison(kind: ts.SyntaxKind): ComparisonOperator {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return '=='
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return '>='
    case ts.SyntaxKind.LessThanEqualsToken:
      return '<='
    case ts.SyntaxKind.GreaterThanToken:
      return '>'
    case ts.SyntaxKind.LessThanToken:
      return '<'
    default:
      throw new Error(`Not a comparison syntax: ${ts.SyntaxKind[kind]}`)
  }
}

function sequencePropArgument(args: string[], context: EvalContext): {array: ArrayValue; prop: string} | null {
  if (args.length !== 1) return null
  let expression = unwrapExpression(parseExpression(args[0]!))
  const path: string[] = []
  while (ts.isPropertyAccessExpression(expression)) {
    path.unshift(expression.name.text)
    const array = evaluateExpression(expression.expression, context)
    if (array.kind === 'array') return {array, prop: path.join('.')}
    expression = unwrapExpression(expression.expression)
  }
  return null
}

function extentEndSummaryValue(array: ArrayValue, emptyExpr: string, nonEmptyExpr?: string): NumberValue | null {
  const extentEnds = array.summary?.extentEnds ?? []
  return extentEnds.find(fact =>
    sameExpressionText(fact.emptyExpr, emptyExpr)
    && (nonEmptyExpr == null || sameExpressionText(fact.nonEmptyExpr, nonEmptyExpr))
  )?.value ?? null
}

function contextWithAssumptions(context: EvalContext, assumptions: LinearConstraint[]): EvalContext {
  return assumptions.length === 0 ? context : {...context, assumptions: mergeAssumptions(context.assumptions, assumptions)}
}
