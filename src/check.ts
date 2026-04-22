import * as ts from 'typescript'
import {
  buildFitSourceModule,
  loadFitProject,
  resolveFitExport,
  type FitImportBinding,
  type FitModule,
} from './modules.ts'
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
  type ComparisonOperator,
  type FitDomainPath,
  type FitDomainPathSegment,
  type FitRange,
  type FitSpec,
} from './parser.ts'
import {
  binaryExpr,
  callExpr,
  conditionalRunningSumNumber,
  divideNumbers,
  joinValues,
  linearNameForExpression,
  maxNumberCases,
  mergeArraySummary,
  mergeAssumptions,
  mergeElementValue,
  mergeProvenance,
  moduloNumbers,
  multiplyNumbers,
  numberBranches,
  numberValue,
  plainNumber,
  powerNumbers,
  runningExtremumNumber,
  runningSumNumber,
  unknown,
  unknownArray,
  unknownArrayLength,
  unknownNumber,
  unknownObject,
  valueWithAssumptions,
  withNumberCases,
  type ArraySummary,
  type ArrayValue,
  type FactSource,
  type LinearConstraint,
  type NumberCase,
  type NumberValue,
  type Value,
} from './domain.ts'
import {
  cleanLinear,
  linearAdd,
  linearConstant,
  linearEpsilon,
  linearScaleExact,
  linearScale,
  linearSubtract,
  linearVariable,
  mergeScale,
  numericLiteralValue,
  sameExpressionText,
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
  type Truth,
} from './proof.ts'
import {
  comparisonNeed,
  formatArraySummary,
  formatExpectedRange,
  formatRangeSpec,
  formatRange,
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

export type FitCheckStatus = 'pass' | 'fail' | 'unknown'

export type FitCheck = {
  file: string
  functionName: string
  text: string
  status: FitCheckStatus
  reason?: string
}

export type FitCheckReport = {
  phase: 'ready' | 'error'
  files: string[]
  checks: FitCheck[]
  summary: {
    pass: number
    fail: number
    unknown: number
  }
}

export type FitInferFact = {
  text: string
  source: 'range' | 'equality' | 'sequence'
}

export type FitInferSpecStatus = 'source-proved' | 'trusted' | 'not-inferred'

export type FitInferSpec = {
  text: string
  status: FitInferSpecStatus
  reason?: string
}

export type FitInferRedundantSpec = {
  text: string
  reason: string
}

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

type FunctionContractProof =
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
}

const maxInlineDepth = 12

type TrustedGivenSpec =
  | {kind: 'range'; spec: Extract<FitSpec, {kind: 'given-range'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}
  | {kind: 'comparison'; spec: Extract<FitSpec, {kind: 'given-comparison'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}

type ConditionalLoopAdd = {
  targetName: string
  increment: NumberValue
}

type LoopExtremum = {
  targetName: string
  kind: 'min' | 'max'
  candidate: NumberValue
}

type ImportedContractSource = {
  sourceFile: string
  sourceFunctionName: string
}

type FunctionContractSource = ImportedContractSource & {
  kind: 'imported' | 'local'
}

export async function verifyFitFiles(paths: string[]): Promise<FitCheckReport> {
  const checks: FitCheck[] = []
  const contractCache = new Map<string, FunctionContractProof>()
  const project = loadFitProject(paths, readTopLevelNumberGlobal)
  for (const program of project.entries) checks.push(...verifyProgram(program, contractCache))

  const summary = {
    pass: checks.filter(check => check.status === 'pass').length,
    fail: checks.filter(check => check.status === 'fail').length,
    unknown: checks.filter(check => check.status === 'unknown').length,
  }
  return {
    phase: summary.fail === 0 && summary.unknown === 0 ? 'ready' : 'error',
    files: paths,
    checks,
    summary,
  }
}

export function verifyFitSource(file: string, sourceText: string): FitCheck[] {
  const program = buildFitSourceModule(file, sourceText, readTopLevelNumberGlobal)
  return verifyProgram(program, new Map<string, FunctionContractProof>())
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

function readTopLevelNumberGlobal(declaration: ts.VariableDeclaration): {name: string; value: NumberValue} | null {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) return null
  const literal = numericLiteralValue(declaration.initializer)
  if (literal == null) return null
  return {
    name: declaration.name.text,
    value: numberValue(literal, literal, Number.isInteger(literal), declaration.name.text, linearConstant(literal)),
  }
}

function verifyProgram(program: Program, contractCache: Map<string, FunctionContractProof>): FitCheck[] {
  const checks: FitCheck[] = []
  for (const statement of program.sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue
    if (statement.name == null) continue
    const specs = program.specsByFunction.get(statement.name.text) ?? []
    if (specs.length === 0 && !functionHasBodyFitComment(program, statement)) continue
    checks.push(...verifyFunctionSpecs(program.file, program, statement, specs, contractCache))
  }
  checks.push(...verifyTopLevelInlineSpecs(program, contractCache))

  return checks
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

function functionHasBodyFitComment(program: Program, fn: ts.FunctionDeclaration) {
  if (fn.body == null) return false
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (node !== fn.body && isFunctionLikeWithBody(node)) return
    if (hasInlineFitComment(program.sourceText, node) || hasFitComment(program.sourceText, node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return found
}

function isFunctionLikeWithBody(node: ts.Node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
}

function verifyFunctionSpecs(
  file: string,
  program: Program,
  fn: ts.FunctionDeclaration,
  specs: FitSpec[],
  contractCache: Map<string, FunctionContractProof>,
): FitCheck[] {
  const functionName = fn.name?.text ?? '<anonymous>'
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  for (const param of fn.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    env.set(param.name.text, unknownParamValue(param.name.text, specs, param.type, program, param.name))
  }

  const {trustedGivens, checks} = validateGivenSpecs(file, functionName, specs, inputRoots, 'function-given')

  for (const given of trustedGivens) {
    if (given.kind !== 'range') continue
    applyGivenRangeSpec(env, given.spec)
  }

  const {assumptions, checks: impossibleChecks} = collectGivenAssumptions(file, program, functionName, env, inputRoots, trustedGivens, contractCache)
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

function inferFunctionFacts(program: Program, fn: ts.FunctionDeclaration, contractCache: Map<string, FunctionContractProof>): FitInferFunctionReport {
  const functionName = fn.name?.text ?? '<anonymous>'
  const specs = program.specsByFunction.get(functionName) ?? []
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)
  const loops: FitInferLoopReport[] = []

  for (const param of fn.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    env.set(param.name.text, unknownParamValue(param.name.text, specs, param.type, program, param.name))
  }

  const {trustedGivens, checks: givenChecks} = validateGivenSpecs(program.file, functionName, specs, inputRoots, 'function-given')
  for (const given of trustedGivens) {
    if (given.kind === 'range') applyGivenRangeSpec(env, given.spec)
  }
  const {assumptions, checks} = collectGivenAssumptions(program.file, program, functionName, env, inputRoots, trustedGivens, contractCache)
  const inferUnsupported: string[] = []
  const context: EvalContext = {program, file: program.file, env, inputRoots, stack: [functionName], checks: [], assumptions, contractCache, inferLoops: loops, inferUnsupported}
  const state = evaluateFunctionBodyState(fn, context)
  const resultFacts = factsFromValue('result', state.result)
  const localFacts = localFactsFromEnv(env, state.env)
  const specReports = inferFunctionSpecReports(program, functionName, specs, env, state.result, [
    ...givenChecks,
    ...checks,
    ...context.checks,
  ], state.assumptions, contractCache)
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

type FunctionShapeState = {
  baseEnv: Map<string, Value>
  env: Map<string, Value>
  result: Value
}

function inspectFunctionShapes(program: Program, fn: ts.FunctionDeclaration, contractCache: Map<string, FunctionContractProof>, options: FitShapeOptions): FitShapeInsight[] {
  const functionName = fn.name?.text ?? '<anonymous>'
  const insights: FitShapeInsight[] = []
  const state = options.functionName != null || program.fitFunctions.has(functionName) || functionHasBodyFitComment(program, fn)
    ? evaluateFunctionShapeState(program, fn, contractCache)
    : null

  for (const param of fn.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    const subject = `param ${param.name.text}`
    const freerange = state?.baseEnv.get(param.name.text) ?? valueFromSyntaxTypeShape(param.name.text, param.type, program, new Set())
    const typescript = valueFromNodeShape(param.name.text, param.name, program)
    addShapeInsight(insights, program, functionName, subject, param.name.text, freerange, typescript)
  }

  const syntaxReturn = valueFromSyntaxTypeShape('result', fn.type, program, new Set())
  const tsReturn = valueFromFunctionReturnShape('result', fn, program)
  addShapeInsight(insights, program, functionName, 'return type', 'result', state?.result ?? syntaxReturn, tsReturn)

  if (fn.body != null && (state != null || options.calls === true)) {
    collectShapeInsightsFromNode(fn.body, program, functionName, state, options, insights)
  }

  return insights
}

function evaluateFunctionShapeState(program: Program, fn: ts.FunctionDeclaration, contractCache: Map<string, FunctionContractProof>): FunctionShapeState {
  const functionName = fn.name?.text ?? '<anonymous>'
  const specs = program.specsByFunction.get(functionName) ?? []
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  for (const param of fn.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    env.set(param.name.text, unknownParamValue(param.name.text, specs, param.type, program, param.name))
  }

  const {trustedGivens} = validateGivenSpecs(program.file, functionName, specs, inputRoots, 'function-given')
  for (const given of trustedGivens) {
    if (given.kind === 'range') applyGivenRangeSpec(env, given.spec)
  }
  const {assumptions} = collectGivenAssumptions(program.file, program, functionName, env, inputRoots, trustedGivens, contractCache)
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

function localFactsFromEnv(baseEnv: Map<string, Value>, finalEnv: Map<string, Value>): FitInferFact[] {
  const facts: FitInferFact[] = []
  for (const [name, value] of finalEnv) {
    if (baseEnv.has(name) || name === 'result') continue
    facts.push(...factsFromValue(name, value))
  }
  return facts
}

function factsFromValue(path: string, value: Value): FitInferFact[] {
  if (value.kind === 'unknown') return []
  if (value.kind === 'number') return numberFacts(path, value)
  if (value.kind === 'object') {
    const facts: FitInferFact[] = []
    for (const [name, prop] of [...value.props.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      facts.push(...factsFromValue(`${path}.${name}`, prop))
    }
    return facts
  }

  const facts = numberFacts(`${path}.length`, value.length)
  if (value.element != null) facts.push(...factsFromValue(`${path}[]`, value.element))
  if (value.summary != null) {
    for (const prop of value.summary.nondecreasingProps) facts.push({source: 'sequence', text: `nondecreasing(${path}.${prop})`})
    for (const fact of value.summary.spaced) facts.push({source: 'sequence', text: `spaced(${path}, ${fact.gapExpr})`})
    if (value.summary.lastEnd != null) {
      facts.push(...numberFacts(`lastEnd(${path})`, value.summary.lastEnd))
    }
    for (const fact of value.summary.extentEnds) {
      facts.push(...numberFacts(`extentEnd(${path}, ${fact.emptyExpr})`, fact.value))
    }
  }
  return facts
}

function factsFromEnvRoots(env: Map<string, Value>, roots: Set<string>): FitInferFact[] {
  const facts: FitInferFact[] = []
  for (const name of [...roots].sort()) {
    const value = env.get(name)
    if (value == null) continue
    facts.push(...factsFromValue(name, value))
  }
  return uniqueFacts(facts)
}

function inferFunctionSpecReports(
  program: Program,
  functionName: string,
  specs: FitSpec[],
  env: Map<string, Value>,
  result: Value,
  backgroundChecks: FitCheck[],
  assumptions: LinearConstraint[],
  contractCache: Map<string, FunctionContractProof>,
): FitInferSpec[] {
  const checkByText = new Map<string, FitCheck>()
  for (const check of backgroundChecks) {
    if (!checkByText.has(check.text)) checkByText.set(check.text, check)
  }

  return specs.map(spec => {
    if (spec.kind === 'given-range' || spec.kind === 'given-comparison') {
      const check = checkByText.get(spec.text)
      if (check == null || check.status === 'pass') return {text: spec.text, status: 'trusted'}
      return {text: spec.text, status: 'not-inferred', reason: check.reason ?? check.status}
    }

    const check = verifyCheckSpec(program.file, program, functionName, env, result, spec, [...backgroundChecks], assumptions, contractCache)
    if (check.status === 'pass') return {text: spec.text, status: 'source-proved'}
    return {text: spec.text, status: 'not-inferred', reason: check.reason ?? check.status}
  })
}

function redundantSpecs(specs: FitInferSpec[], facts: FitInferFact[]) {
  const redundant: FitInferRedundantSpec[] = []
  for (const spec of specs) {
    if (spec.status !== 'source-proved') continue
    const reason = inferredFactReasonForSpecText(spec.text, facts)
    if (reason == null) continue
    redundant.push({text: spec.text, reason})
  }
  return redundant
}

function inferredFactReasonForSpecText(specText: string, facts: FitInferFact[]) {
  const exactFact = facts.find(fact => fact.text === specText)
  if (exactFact != null) return exactFact.text

  const spec = parseFitSpecLineForInference(specText)
  if (spec == null || spec.kind === 'given-range' || spec.kind === 'given-comparison') return null
  if (spec.kind === 'check-atom') return null
  if (spec.kind === 'check-range') return rangeFactReasonForSpec(spec, facts)
  return comparisonFactReasonForSpec(spec, facts)
}

function parseFitSpecLineForInference(text: string): FitSpec | null {
  try {
    return parseFitSpecLine(text)
  } catch {
    return null
  }
}

function rangeFactReasonForSpec(spec: Extract<FitSpec, {kind: 'check-range'}>, facts: FitInferFact[]) {
  const range = inferredRangeFactForExpression(facts, spec.expression)
  if (range == null) return null
  const lowerOk = spec.range.lowerValue != null
    && (spec.range.lowerInclusive ? range.min >= spec.range.lowerValue : range.min > spec.range.lowerValue)
  const upperOk = spec.range.upperValue != null
    && (spec.range.upperInclusive ? range.max <= spec.range.upperValue : range.max < spec.range.upperValue)
  return lowerOk
    && upperOk
    && (spec.range.valueKind !== 'int' || range.isInteger)
    ? range.text
    : null
}

function comparisonFactReasonForSpec(spec: Extract<FitSpec, {kind: 'check-comparison'}>, facts: FitInferFact[]) {
  const leftRange = inferredRangeFactForExpression(facts, spec.left)
  const rightRange = inferredRangeFactForExpression(facts, spec.right)
  const leftNumber = numberText(spec.left)
  const rightNumber = numberText(spec.right)

  switch (spec.op) {
    case '>=':
      if (leftRange != null && rightNumber != null && leftRange.min >= rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber >= rightRange.max) return rightRange.text
      return null
    case '>':
      if (leftRange != null && rightNumber != null && leftRange.min > rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber > rightRange.max) return rightRange.text
      return null
    case '<=':
      if (leftRange != null && rightNumber != null && leftRange.max <= rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber <= rightRange.min) return rightRange.text
      return null
    case '<':
      if (leftRange != null && rightNumber != null && leftRange.max < rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber < rightRange.min) return rightRange.text
      return null
    case '==':
      return null
  }
}

function inferredRangeFactForExpression(facts: FitInferFact[], expression: string) {
  for (const fact of facts) {
    const range = rangeFactForExpression(fact.text, expression)
    if (range != null) return {text: fact.text, ...range}
  }
  return null
}

function numberText(text: string): number | null {
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function numberFacts(path: string, value: NumberValue): FitInferFact[] {
  const facts: FitInferFact[] = []
  if (value.expr != null && !sameExpressionText(path, value.expr)) {
    facts.push({source: 'equality', text: `${path} == ${value.expr}`})
  }
  if (isInterestingNumberRange(value)) {
    facts.push({source: 'range', text: `${path}: ${formatExpectedRange(value.min, value.max, value.isInteger)}`})
  }
  return facts
}

function isInterestingNumberRange(value: NumberValue) {
  if (value.min === Number.NEGATIVE_INFINITY && value.max === Number.POSITIVE_INFINITY) return false
  return true
}

function topUnknownReason(value: Value): string[] {
  if (value.kind === 'unknown') return [value.reason]
  return []
}

function uniqueFacts(facts: FitInferFact[]): FitInferFact[] {
  const seen = new Set<string>()
  const unique: FitInferFact[] = []
  for (const fact of facts) {
    const key = `${fact.source}:${fact.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(fact)
  }
  return unique
}

function functionInputRoots(program: Program, fn: ts.FunctionDeclaration): string[] {
  const roots = [...program.globals.keys()]
  for (const param of fn.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    roots.push(param.name.text)
  }
  return [...new Set(roots)]
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
): {trustedGivens: TrustedGivenSpec[]; checks: FitCheck[]} {
  const trustedGivens: TrustedGivenSpec[] = []
  const checks: FitCheck[] = []
  const ranges: Extract<FitSpec, {kind: 'given-range'}>[] = []

  for (const spec of specs) {
    if (spec.kind !== 'given-range' && spec.kind !== 'given-comparison') continue
    const badRoot = givenBadRoot(spec, allowedRoots)
    if (badRoot != null) {
      checks.push(invalidGivenCheck(file, functionName, spec.text, `given can only describe inputs; ${badRoot} is not an input here`))
      continue
    }
    const shapeProblem = givenShapeProblem(spec)
    if (shapeProblem != null) {
      checks.push(invalidGivenCheck(file, functionName, spec.text, shapeProblem))
      continue
    }

    if (spec.kind === 'given-range') {
      const rangeProblem = givenRangeProblem(spec, ranges)
      if (rangeProblem != null) {
        checks.push({file, functionName, text: spec.text, status: 'fail', reason: rangeProblem})
        continue
      }
      ranges.push(spec)
      trustedGivens.push({kind: 'range', spec, source})
      continue
    }

    trustedGivens.push({kind: 'comparison', spec, source})
  }

  return {trustedGivens, checks}
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
  if (ts.isIdentifier(expression)) return true
  if (ts.isPropertyAccessExpression(expression)) return isGivenRangeExpression(expression.expression)
  if (ts.isParenthesizedExpression(expression)) return isGivenRangeExpression(expression.expression)
  return false
}

function isGivenComparisonExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return true
  if (numericLiteralValue(expression) != null) return true
  if (ts.isPropertyAccessExpression(expression)) return isGivenComparisonExpression(expression.expression)
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

function invalidGivenCheck(file: string, functionName: string, text: string, reason: string): FitCheck {
  return {file, functionName, text, status: 'unknown', reason}
}

function collectGivenAssumptions(
  file: string,
  program: Program,
  functionName: string,
  env: Map<string, Value>,
  inputRoots: string[],
  givens: TrustedGivenSpec[],
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
      assumptions.push(...rangeFactsFromBounds(value, lower, spec.range.lowerInclusive, upper, spec.range.upperInclusive, spec.text, given.source))
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
  const value = numberValue(
    closed?.min ?? Number.NEGATIVE_INFINITY,
    closed?.max ?? Number.POSITIVE_INFINITY,
    spec.range.valueKind === 'int',
    spec.expression,
    linearVariable(linearNameForExpression(spec.expression)),
  )
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
  return unknownParamValue('result', specs, undefined, program)
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
  if (ts.isParenthesizedExpression(expression)) return expressionRootName(expression.expression)
  return null
}

function expressionRootNameDeep(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
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
  const root = context.env.get(domainPath.root) ?? unknown(`Unknown identifier ${domainPath.root}`)
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
  return unknown(`${expr}.${segment.name} expected an object`)
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
  env.set('result', result)
  const inputRoots = [...baseEnv.keys(), 'result']
  const context: EvalContext = {program, file, env, inputRoots, stack: [functionName], checks, assumptions, contractCache}

  if (spec.kind === 'check-range') {
    const value = evaluateSpecExpression(spec.expression, context)
    const status = proveRangeSpec(value, spec.range, context)
    return {
      file,
      functionName,
      text: spec.text,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    }
  }

  if (spec.kind === 'check-atom') return verifyAtomSpec(file, functionName, spec, context)

  const wildcardCheck = checkWildcardComparisonShape(spec.left, spec.right)
  if (wildcardCheck.kind === 'unsupported') {
    return {file, functionName, text: spec.text, status: 'unknown', reason: wildcardCheck.reason}
  }

  const left = evaluateSpecExpression(spec.left, context)
  const right = evaluateSpecExpression(spec.right, context)
  const status = proveComparison(left, spec.op, right, context.assumptions)
  const reason = wildcardCheck.kind === 'one' && status.status !== 'pass' && status.reason != null
    ? `wildcard comparison means every ${wildcardCheck.collection} item must satisfy: ${spec.text}\n${status.reason}`
    : status.reason
  return {
    file,
    functionName,
    text: spec.text,
    status: status.status,
    ...(reason == null ? {} : {reason}),
  }
}

function proveRangeSpec(value: Value, range: FitRange, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  if (value.kind !== 'number') return {status: 'unknown', reason: expectedNumberReason(value)}
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

function expectedNumberReason(value: Exclude<Value, NumberValue>) {
  if (value.kind === 'unknown') return value.reason
  return value.kind === 'array' ? 'Expected a number, got an array' : 'Expected a number, got an object'
}

function staticRangeInside(value: NumberValue, range: FitRange) {
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
  return collection
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
  if (target == null) return {status: 'unknown', reason: 'nondecreasing expects result.rows.top'}
  if (target.array.summary?.nondecreasingProps.some(prop => prop === target.prop) === true) return {status: 'pass'}
  return {status: 'unknown', reason: nondecreasingFailureReason(spec.text, target)}
}

function proveSpacedAtom(spec: Extract<FitSpec, {kind: 'check-atom'}>, context: EvalContext): {status: FitCheckStatus; reason?: string} {
  if (spec.args.length !== 2) return {status: 'unknown', reason: 'spaced expects spaced(rows, gap)'}
  const rows = evaluateSpecExpression(spec.args[0]!, context)
  const gap = evaluateSpecExpression(spec.args[1]!, context)
  if (rows.kind !== 'array') return {status: 'unknown', reason: 'spaced expected an array'}
  if (gap.kind !== 'number' || gap.expr == null) return {status: 'unknown', reason: 'spaced expected a known gap expression'}
  if (rows.summary?.spaced.some(fact => sameExpressionText(fact.gapExpr, gap.expr!)) === true) return {status: 'pass'}
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

function evaluateFunctionBody(fn: ts.FunctionDeclaration, context: EvalContext): Value {
  return evaluateFunctionBodyState(fn, context).result
}

function evaluateFunctionBodyState(fn: ts.FunctionDeclaration, context: EvalContext): {result: Value; env: Map<string, Value>; assumptions: LinearConstraint[]} {
  if (fn.body == null) {
    return {
      result: unknown(`Function ${fn.name?.text ?? '<anonymous>'} has no body`),
      env: context.env,
      assumptions: context.assumptions,
    }
  }
  const localEnv = new Map(context.env)
  const localContext: EvalContext = {...context, env: localEnv}
  const result = evaluateStatements(fn.body.statements, localContext)
  context.assumptions = localContext.assumptions
  return {result, env: localEnv, assumptions: localContext.assumptions}
}

function evaluateStatements(statements: ts.NodeArray<ts.Statement>, context: EvalContext, startIndex = 0): Value {
  for (let index = startIndex; index < statements.length; index++) {
    const statement = statements[index]!
    if (ts.isVariableStatement(statement)) {
      bindVariableStatement(statement, context)
      continue
    }
    if (ts.isForOfStatement(statement)) {
      const result = evaluateForOfStatement(statement, context)
      if (result != null) return result
      continue
    }
    if (ts.isForStatement(statement)) {
      const result = evaluateForStatement(statement, context)
      if (result != null) return result
      continue
    }
    if (ts.isExpressionStatement(statement)) {
      const result = applyExpressionStatement(statement.expression, context)
      if (result != null) return result
      continue
    }
    if (ts.isIfStatement(statement)) {
      return evaluateIfStatement(statement, context, statements, index + 1)
    }
    if (ts.isReturnStatement(statement)) {
      if (statement.expression == null) return unknown('Return without expression')
      return evaluateExpressionWithObjectPath(statement.expression, context, ['result'])
    }
    return unknown(`Unsupported statement in ${context.stack.at(-1) ?? '<unknown>'}: ${statement.getText(context.program.sourceFile)}`)
  }

  return unknown(`Function ${context.stack.at(-1) ?? '<unknown>'} did not return`)
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

function verifyLocalFitSpecs(specs: Extract<FitSpec, {kind: 'check-range'}>[], context: EvalContext) {
  if (specs.length === 0) return
  for (const spec of specs) {
    context.checks.push(verifyCheckSpec(
      context.file,
      context.program,
      context.stack.join(' > '),
      context.env,
      unknown('Inline @fit checks do not use result'),
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
}

function bindName(name: ts.BindingName, value: Value, context: EvalContext) {
  if (ts.isIdentifier(name)) {
    context.env.set(name.text, value)
    return
  }
  if (ts.isObjectBindingPattern(name)) bindObjectPattern(name, value, context)
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
    if (current == null || current.kind !== 'number' || increment.kind !== 'number') return unknown('+= expected numbers')
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

  switch (expression.expression.name.text) {
    case 'reverse':
    case 'sort':
      context.env.set(targetName, arrayWithoutSequenceFacts(target))
      return null
    case 'splice':
      context.env.set(targetName, arrayWithUnknownContents(targetName, target))
      return null
    default:
      return unknown(`Unsupported array mutation: ${expression.getText(context.program.sourceFile)}`)
  }
}

function applyAssignmentStatement(expression: ts.BinaryExpression, context: EvalContext): Value | null {
  const targetName = mutationTargetRoot(expression.left)
  if (targetName == null) return unknown(`Unsupported assignment target: ${expression.left.getText(context.program.sourceFile)}`)
  const target = context.env.get(targetName)
  if (target?.kind !== 'array') return unknown(`Assignment target ${targetName} expected an array`)
  context.env.set(targetName, arrayWithUnknownContents(targetName, target))
  return null
}

function mutationTargetRoot(expression: ts.Expression): string | null {
  if (ts.isElementAccessExpression(expression)) return expressionRootName(expression.expression) ?? mutationTargetRoot(expression.expression)
  if (ts.isPropertyAccessExpression(expression)) return expressionRootName(expression.expression) ?? mutationTargetRoot(expression.expression)
  if (ts.isParenthesizedExpression(expression)) return mutationTargetRoot(expression.expression)
  if (ts.isNonNullExpression(expression)) return mutationTargetRoot(expression.expression)
  return null
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

function evaluateIfStatement(statement: ts.IfStatement, context: EvalContext, statements: ts.NodeArray<ts.Statement>, nextIndex: number): Value {
  const condition = evaluateConditionFacts(statement.expression, context)
  if (condition.truth === 'true') return evaluateBranchStatement(statement.thenStatement, context)
  if (condition.truth === 'false') {
    return statement.elseStatement == null ? evaluateStatements(statements, context, nextIndex) : evaluateBranchStatement(statement.elseStatement, context)
  }

  const trueValue = valueWithAssumptions(
    evaluateBranchStatement(statement.thenStatement, contextWithAssumptions(context, condition.trueAssumptions)),
    condition.trueAssumptions,
  )
  const falseValue = statement.elseStatement == null
    ? valueWithAssumptions(
      evaluateStatements(statements, contextWithAssumptions(context, condition.falseAssumptions), nextIndex),
      condition.falseAssumptions,
    )
    : valueWithAssumptions(
      evaluateBranchStatement(statement.elseStatement, contextWithAssumptions(context, condition.falseAssumptions)),
      condition.falseAssumptions,
    )
  return joinValues(trueValue, falseValue)
}

function evaluateBranchStatement(statement: ts.Statement, context: EvalContext): Value {
  if (ts.isReturnStatement(statement)) {
    if (statement.expression == null) return unknown('Return without expression')
    return evaluateExpressionWithObjectPath(statement.expression, context, ['result'])
  }
  if (!ts.isBlock(statement)) return unknown(`Unsupported branch statement: ${statement.getText(context.program.sourceFile)}`)
  const localContext: EvalContext = {...context, env: new Map(context.env)}
  for (const child of statement.statements) {
    if (ts.isVariableStatement(child)) {
      bindVariableStatement(child, localContext)
      continue
    }
    if (ts.isExpressionStatement(child)) {
      const result = applyExpressionStatement(child.expression, localContext)
      if (result != null) return result
      continue
    }
    if (ts.isReturnStatement(child)) {
      if (child.expression == null) return unknown('Return without expression')
      return evaluateExpressionWithObjectPath(child.expression, localContext, ['result'])
    }
    return unknown(`Unsupported branch statement: ${child.getText(context.program.sourceFile)}`)
  }
  return unknown('Branch did not return')
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
  const conditionalPushedArrays: LoopPush[] = []
  const conditionalAdds = new Map<string, NumberValue>()
  const pendingAdds = new Map<string, NumberValue>()
  const pendingExtrema = new Map<string, LoopExtremum>()
  const loopContext = {...context, env: new Map(context.env).set(loopItemName, loopItem)}

  for (const child of statement.statement.statements) {
    if (ts.isVariableStatement(child)) {
      bindVariableStatement(child, loopContext)
      continue
    }

    if (ts.isExpressionStatement(child) && isPushCall(child.expression)) {
      const targetName = child.expression.expression.expression.text
      const target = context.env.get(targetName)
      if (target == null || target.kind !== 'array') return unknown(`${targetName}.push expected an array`)
      pushedArrays.push({...readLoopPush(child.expression, loopContext), arrayName: targetName, length: source.length})
      continue
    }

    const conditionalPush = readConditionalLoopPush(child, loopContext, source.length)
    if (conditionalPush != null) {
      conditionalPushedArrays.push(conditionalPush)
      continue
    }

    const conditionalAdd = readConditionalLoopAdd(child, loopContext)
    if (conditionalAdd != null) {
      if (conditionalAdds.has(conditionalAdd.targetName)) return unknown(`Conditional running-sum loop already updates ${conditionalAdd.targetName}`)
      conditionalAdds.set(conditionalAdd.targetName, conditionalAdd.increment)
      continue
    }

    if (ts.isExpressionStatement(child) && ts.isBinaryExpression(child.expression) && child.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
      if (!ts.isIdentifier(child.expression.left)) return unknown('Running-sum loop expected a simple += target')
      const targetName = child.expression.left.text
      const increment = evaluateExpression(child.expression.right, loopContext)
      if (increment.kind !== 'number') return unknown('Running-sum loop increment expected a number')
      pendingAdds.set(targetName, increment)
      continue
    }

    const extremum = readLoopExtremumAssignment(child, loopContext)
    if (extremum != null) {
      if (pendingExtrema.has(extremum.targetName)) return unknown(`Scalar min/max loop already updates ${extremum.targetName}`)
      pendingExtrema.set(extremum.targetName, extremum)
      continue
    }

    return unknown(`Unsupported for-of body statement: ${child.getText(context.program.sourceFile)}`)
  }

  if (conditionalPushedArrays.length > 0 && (conditionalPushedArrays.length > 1 || pushedArrays.length > 0 || pendingAdds.size > 0 || pendingExtrema.size > 0)) {
    return unknown('Conditional push loops support one guarded push and no cursor update')
  }
  if (conditionalAdds.size > 0 && (pushedArrays.length > 0 || conditionalPushedArrays.length > 0 || pendingAdds.size > 0 || pendingExtrema.size > 0)) {
    return unknown('Conditional running-sum loops support guarded += statements only')
  }
  if (loopExtremaConflictWithAdds(pendingExtrema, pendingAdds)) return unknown('Scalar min/max loops cannot also use += on the same target')

  const updates = new Map<string, {start: NumberValue; increment: NumberValue; end: NumberValue}>()
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

  const extremumResult = applyLoopExtrema(pendingExtrema, source.length, context, 'Scalar min/max loop target expected a number')
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
      element: loopElementFromPush(push, updates, context),
      summary: mergeArraySummary(target.summary, sequenceSummaryFromLoopPush(push, update, context)),
    })
  }

  for (const push of conditionalPushedArrays) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
    factRoots.add(push.arrayName)
    const length = conditionalPushLength(push.arrayName, source.length)
    context.env.set(push.arrayName, {
      ...target,
      length,
      elements: null,
      element: mergeElementValue(target.element, push.element),
      summary: null,
    })
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

  const source = evaluateExpression(shape.sourceExpression, context)
  if (source.kind !== 'array') return unknown('Indexed loop source expected an array')
  if (source.length.max < 1) return unknown('Indexed loop expected a possibly non-empty source')

  const indexValue = numberValue(0, source.length.max - 1, true, shape.indexName, linearVariable(shape.indexName))
  const indexFacts = indexedLoopAssumptions(indexValue, source.length)
  const loopContext = contextWithAssumptions(
    {...context, env: new Map(context.env).set(shape.indexName, indexValue)},
    indexFacts,
  )

  const pushes: LoopPush[] = []
  const pendingAdds = new Map<string, NumberValue>()
  const pendingExtrema = new Map<string, LoopExtremum>()
  const forgottenRoots = new Set<string>()
  for (const child of statement.statement.statements) {
    if (ts.isVariableStatement(child)) {
      bindVariableStatement(child, loopContext)
      continue
    }

    if (ts.isExpressionStatement(child) && isPushCall(child.expression)) {
      const targetName = child.expression.expression.expression.text
      const target = context.env.get(targetName)
      if (target == null || target.kind !== 'array') return unknown(`${targetName}.push expected an array`)
      pushes.push({...readLoopPush(child.expression, loopContext), arrayName: targetName, length: source.length})
      continue
    }

    if (ts.isExpressionStatement(child) && ts.isBinaryExpression(child.expression) && child.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
      if (!ts.isIdentifier(child.expression.left)) return unknown('Indexed running-sum loop expected a simple += target')
      const targetName = child.expression.left.text
      const increment = evaluateExpression(child.expression.right, loopContext)
      if (increment.kind !== 'number') return unknown('Indexed running-sum loop increment expected a number')
      pendingAdds.set(targetName, increment)
      continue
    }

    const extremum = readLoopExtremumAssignment(child, loopContext)
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

  const updates = new Map<string, {start: NumberValue; increment: NumberValue; end: NumberValue}>()
  const factRoots = new Set<string>()
  for (const [targetName, increment] of pendingAdds) {
    const start = context.env.get(targetName)
    if (start == null || start.kind !== 'number') return unknown('Indexed running-sum loop target expected a number')
    const end = runningSumNumber(start, source.length, increment)
    context.env.set(targetName, end)
    updates.set(targetName, {start, increment, end})
    factRoots.add(targetName)
  }

  const extremumResult = applyLoopExtrema(pendingExtrema, source.length, context, 'Indexed scalar min/max loop target expected a number')
  if (extremumResult != null) return extremumResult
  for (const targetName of pendingExtrema.keys()) factRoots.add(targetName)

  for (const push of pushes) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
    factRoots.add(push.arrayName)
    const update = updates.get(push.topName ?? '')
    const cursorElement = loopElementFromPush(push, updates, context)
    const element = indexedLoopElementFromPush({...push, element: cursorElement}, shape.indexName, source.length)
    context.env.set(push.arrayName, {
      ...target,
      length: source.length,
      elements: null,
      element,
      summary: mergeArraySummary(target.summary, sequenceSummaryFromLoopPush(push, update, context)),
    })
    context.assumptions = mergeAssumptions(context.assumptions, indexedElementAssumptions(push.arrayName, source.length))
  }

  for (const root of forgottenRoots) {
    if (factRoots.has(root)) factRoots.delete(root)
    forgetRoot(context.env, root)
  }

  verifyLocalLoopSpecs(localSpecs, context)
  recordInferLoop(statement, 'for', rawLocalSpecs, context, checksStart, factRoots)

  return null
}

function evaluateForgettableForStatement(statement: ts.ForStatement, context: EvalContext): Value | null {
  if (!isForgettableForStatement(statement)) return unknown(`Unsupported for loop: ${statement.getText(context.program.sourceFile)}`)
  const forgotten = forgettableMutationRoots(statement.statement)
  if (forgotten == null) return unknown(`Unsupported for loop: ${statement.getText(context.program.sourceFile)}`)
  for (const root of forgotten) forgetRoot(context.env, root)
  addInferUnsupported(context, `Forgot unsupported for loop side effects: ${loopHeaderText(statement, context.program.sourceFile)}`)
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
    || expression.kind === ts.SyntaxKind.TrueKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.NullKeyword
  ) return true
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
      if (check == null || check.status === 'pass') return {text: spec.text, status: 'trusted'}
      return {text: spec.text, status: 'not-inferred', reason: check.reason ?? check.status}
    }
    if (check?.status === 'pass') return {text: spec.text, status: 'source-proved'}
    return {text: spec.text, status: 'not-inferred', reason: check?.reason ?? check?.status ?? 'not checked'}
  })
}

function loopHeaderText(statement: ts.ForOfStatement | ts.ForStatement, sourceFile: ts.SourceFile) {
  const text = statement.getText(sourceFile)
  const bodyStart = text.indexOf('{')
  const header = bodyStart === -1 ? text : text.slice(0, bodyStart)
  return header.replace(/\s+/g, ' ').trim()
}

function splitLoopSpecs(specs: FitSpec[]): {validSpecs: FitSpec[]; resultSpecs: FitSpec[]} {
  const validSpecs: FitSpec[] = []
  const resultSpecs: FitSpec[] = []
  for (const spec of specs) {
    if (specMentionsRoot(spec, 'result')) resultSpecs.push(spec)
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
      functionName,
      text: spec.text,
      status: 'unknown',
      reason: 'loop @fit specs do not have result; name local values directly',
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
  const {trustedGivens, checks} = validateGivenSpecs(context.file, functionName, specs, context.inputRoots, 'loop-given')
  context.checks.push(...checks)

  for (const given of trustedGivens) {
    if (given.kind !== 'range') continue
    applyGivenRangeSpec(context.env, given.spec)
  }
  const {assumptions, checks: impossibleChecks} = collectGivenAssumptions(
    context.file,
    context.program,
    functionName,
    context.env,
    context.inputRoots,
    trustedGivens,
    context.contractCache,
  )
  context.checks.push(...impossibleChecks)
  context.assumptions = mergeAssumptions(context.assumptions, assumptions)
}

function verifyLocalLoopSpecs(specs: FitSpec[], context: EvalContext) {
  if (specs.length === 0) return
  const functionName = `${context.stack.at(-1) ?? '<unknown>'} > loop`
  const loopResult = unknown('Loop annotations do not have result; name local values directly')
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

type LoopPush = {
  arrayName: string
  length: NumberValue
  element: Value | null
  topName: string | null
  height: NumberValue | null
  cursorPaths: {path: string[]; targetName: string}[]
}

function readLoopPush(expression: ts.CallExpression, context: EvalContext): Omit<LoopPush, 'arrayName' | 'length'> {
  const row = expression.arguments[0]
  if (row == null) return {element: null, topName: null, height: null, cursorPaths: []}
  if (!ts.isObjectLiteralExpression(row)) {
    return {
      element: evaluateExpression(row, context),
      topName: null,
      height: null,
      cursorPaths: ts.isIdentifier(row) ? [{path: [], targetName: row.text}] : [],
    }
  }
  const topExpression = objectPropertyExpression(row, 'top')
  const heightExpression = objectPropertyExpression(row, 'height')
  const topName = topExpression != null && ts.isIdentifier(topExpression) ? topExpression.text : null
  const height = heightExpression == null ? null : evaluateExpression(heightExpression, context)
  return {element: evaluateExpression(row, context), topName, height: height?.kind === 'number' ? height : null, cursorPaths: objectIdentifierPropertyPaths(row)}
}

function readConditionalLoopPush(statement: ts.Statement, context: EvalContext, length: NumberValue): LoopPush | null {
  if (!ts.isIfStatement(statement) || statement.elseStatement != null) return null
  const push = pushCallFromStatement(statement.thenStatement)
  if (push == null) return null
  const targetName = push.expression.expression.text
  const target = context.env.get(targetName)
  if (target == null || target.kind !== 'array') return null
  return {...readLoopPush(push, context), arrayName: targetName, length}
}

function readConditionalLoopAdd(statement: ts.Statement, context: EvalContext): ConditionalLoopAdd | null {
  if (!ts.isIfStatement(statement) || statement.elseStatement != null) return null
  const add = plusEqualsFromStatement(statement.thenStatement)
  if (add == null) return null
  const increment = evaluateExpression(add.right, context)
  if (increment.kind !== 'number') return null
  return {targetName: add.left.text, increment}
}

function readLoopExtremumAssignment(statement: ts.Statement, context: EvalContext): LoopExtremum | null {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return null
  const assignment = statement.expression
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.left)) return null
  if (!ts.isCallExpression(assignment.right) || !ts.isPropertyAccessExpression(assignment.right.expression)) return null

  const callTarget = assignment.right.expression
  if (!ts.isIdentifier(callTarget.expression) || callTarget.expression.text !== 'Math') return null
  if (callTarget.name.text !== 'min' && callTarget.name.text !== 'max') return null
  if (assignment.right.arguments.length !== 2) return null

  const targetName = assignment.left.text
  const left = assignment.right.arguments[0]!
  const right = assignment.right.arguments[1]!
  const candidateExpression =
    ts.isIdentifier(left) && left.text === targetName ? right
      : ts.isIdentifier(right) && right.text === targetName ? left
        : null
  if (candidateExpression == null) return null

  const candidate = evaluateExpression(candidateExpression, context)
  if (candidate.kind !== 'number') return null
  return {targetName, kind: callTarget.name.text, candidate}
}

function loopExtremaConflictWithAdds(extrema: Map<string, LoopExtremum>, adds: Map<string, NumberValue>) {
  for (const targetName of extrema.keys()) {
    if (adds.has(targetName)) return true
  }
  return false
}

function applyLoopExtrema(extrema: Map<string, LoopExtremum>, length: NumberValue, context: EvalContext, targetError: string): Value | null {
  for (const extremum of extrema.values()) {
    const start = context.env.get(extremum.targetName)
    if (start == null || start.kind !== 'number') return unknown(targetError)
    context.env.set(extremum.targetName, runningExtremumNumber(extremum.kind, extremum.targetName, start, length, extremum.candidate))
  }
  return null
}

function pushCallFromStatement(statement: ts.Statement): (ts.CallExpression & {expression: ts.PropertyAccessExpression & {expression: ts.Identifier}}) | null {
  if (ts.isExpressionStatement(statement) && isPushCall(statement.expression)) return statement.expression
  if (!ts.isBlock(statement) || statement.statements.length !== 1) return null
  const child = statement.statements[0]
  return child != null && ts.isExpressionStatement(child) && isPushCall(child.expression) ? child.expression : null
}

function plusEqualsFromStatement(statement: ts.Statement): (ts.BinaryExpression & {left: ts.Identifier}) | null {
  if (ts.isExpressionStatement(statement) && isIdentifierPlusEquals(statement.expression)) return statement.expression
  if (!ts.isBlock(statement) || statement.statements.length !== 1) return null
  const child = statement.statements[0]
  return child != null && ts.isExpressionStatement(child) && isIdentifierPlusEquals(child.expression) ? child.expression : null
}

function isIdentifierPlusEquals(expression: ts.Expression): expression is ts.BinaryExpression & {left: ts.Identifier} {
  return ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
    && ts.isIdentifier(expression.left)
}

function conditionalPushLength(arrayName: string, sourceLength: NumberValue): NumberValue {
  return numberValue(0, sourceLength.max, true, `${arrayName}.length`, linearVariable(linearNameForExpression(`${arrayName}.length`)))
}

type IndexedLoopShape = {
  indexName: string
  sourceExpression: ts.Expression
}

function indexedLoopShape(statement: ts.ForStatement): IndexedLoopShape | null {
  if (statement.initializer == null || !ts.isVariableDeclarationList(statement.initializer)) return null
  if (statement.initializer.declarations.length !== 1) return null
  const declaration = statement.initializer.declarations[0]
  if (declaration == null || !ts.isIdentifier(declaration.name)) return null
  if (declaration.initializer == null || numericLiteralValue(declaration.initializer) !== 0) return null

  const indexName = declaration.name.text
  if (statement.condition == null || statement.incrementor == null) return null
  const sourceExpression = indexedLoopSourceExpression(statement.condition, indexName)
  if (sourceExpression == null) return null
  if (!indexedLoopIncrements(statement.incrementor, indexName)) return null
  return {indexName, sourceExpression}
}

function indexedLoopSourceExpression(expression: ts.Expression, indexName: string): ts.Expression | null {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null
  if (!ts.isIdentifier(expression.left) || expression.left.text !== indexName) return null
  if (!ts.isPropertyAccessExpression(expression.right) || expression.right.name.text !== 'length') return null
  return expression.right.expression
}

function indexedLoopIncrements(expression: ts.Expression, indexName: string) {
  if ((ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression))
    && expression.operator === ts.SyntaxKind.PlusPlusToken
    && ts.isIdentifier(expression.operand)
    && expression.operand.text === indexName) return true

  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken) return false
  return ts.isIdentifier(expression.left)
    && expression.left.text === indexName
    && numericLiteralValue(expression.right) === 1
}

function indexedLoopAssumptions(index: NumberValue, sourceLength: NumberValue): LinearConstraint[] {
  const lower = comparisonConstraint(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)))
  const upper = comparisonConstraint(index, '<', sourceLength)
  return nonNullFacts(lower, upper)
}

function indexedElementAssumptions(arrayName: string, sourceLength: NumberValue): LinearConstraint[] {
  const index = indexedElementValue(arrayName, 'index', sourceLength)
  return indexedElementPathAssumptions(index, sourceLength)
}

function indexedElementPathAssumptions(index: NumberValue, sourceLength: NumberValue): LinearConstraint[] {
  const lower = comparisonConstraint(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), `${index.expr ?? 'index'} >= 0`)
  const upper = comparisonConstraint(index, '<', sourceLength, `${index.expr ?? 'index'} < ${sourceLength.expr ?? formatRange(sourceLength)}`)
  return nonNullFacts(lower, upper)
}

function nonNullFacts(...facts: (LinearConstraint | null)[]): LinearConstraint[] {
  return facts.filter(fact => fact != null)
}

function objectPropertyExpression(expression: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    if (property.name.text === name) return property.initializer
  }
  return null
}

function objectIdentifierPropertyPaths(expression: ts.ObjectLiteralExpression, prefix: string[] = []): {path: string[]; targetName: string}[] {
  const paths: {path: string[]; targetName: string}[] = []
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      paths.push({path: [...prefix, property.name.text], targetName: property.name.text})
      continue
    }
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    const path = [...prefix, property.name.text]
    if (ts.isIdentifier(property.initializer)) {
      paths.push({path, targetName: property.initializer.text})
      continue
    }
    if (ts.isObjectLiteralExpression(property.initializer)) paths.push(...objectIdentifierPropertyPaths(property.initializer, path))
  }
  return paths
}

function loopElementFromPush(
  push: LoopPush,
  updates: Map<string, {start: NumberValue; increment: NumberValue; end: NumberValue}>,
  context: EvalContext,
): Value | null {
  if (push.element == null || updates.size === 0) return push.element
  let element = push.element
  for (const cursorPath of push.cursorPaths) {
    const update = updates.get(cursorPath.targetName)
    if (update == null) continue
    const expr = cursorPath.path.length === 0 ? `${push.arrayName}[]` : `${push.arrayName}[].${cursorPath.path.join('.')}`
    element = setObjectPathValue(element, cursorPath.path, loopCursorElementValue(update, expr, context))
  }
  return element
}

function indexedLoopElementFromPush(push: LoopPush, indexName: string, sourceLength: NumberValue): Value | null {
  if (push.element == null) return null
  return indexedLoopValueFromPush(push.element, indexName, sourceLength, `${push.arrayName}[]`)
}

function setObjectPathValue(value: Value, path: string[], replacement: Value): Value {
  const [head, ...tail] = path
  if (head == null) return replacement
  if (value.kind !== 'object') return value
  const props = new Map(value.props)
  const current = props.get(head)
  props.set(head, setObjectPathValue(current ?? unknownObject(head), tail, replacement))
  return {...value, props}
}

function indexedLoopValueFromPush(value: Value, indexName: string, sourceLength: NumberValue, expr: string): Value {
  if (value.kind === 'number' && value.expr === indexName) return indexedElementPathValue(expr, sourceLength)
  if (value.kind === 'array') {
    return {
      ...value,
      elements: value.elements == null ? null : value.elements.map((element, index) => indexedLoopValueFromPush(element, indexName, sourceLength, `${expr}[${index}]`)),
      element: value.element == null ? null : indexedLoopValueFromPush(value.element, indexName, sourceLength, `${expr}[]`),
    }
  }
  if (value.kind !== 'object') return value
  const props = new Map<string, Value>()
  for (const [name, prop] of value.props) {
    props.set(name, indexedLoopValueFromPush(prop, indexName, sourceLength, `${expr}.${name}`))
  }
  return {...value, props}
}

function indexedElementValue(arrayName: string, prop: string, sourceLength: NumberValue): NumberValue {
  return indexedElementPathValue(`${arrayName}[].${prop}`, sourceLength)
}

function indexedElementPathValue(expr: string, sourceLength: NumberValue): NumberValue {
  return numberValue(
    0,
    Math.max(0, sourceLength.max - 1),
    true,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}

function loopCursorElementValue(
  update: {start: NumberValue; increment: NumberValue; end: NumberValue},
  expr: string,
  context: EvalContext,
): NumberValue {
  if (update.increment.min < 0) return unknownNumber(expr)
  const startMin = proveComparison(update.start, '>=', numberValue(0, 0, true, '0', linearConstant(0)), context.assumptions).status === 'pass'
    ? Math.max(0, update.start.min)
    : update.start.min
  return numberValue(
    startMin,
    update.end.max,
    update.start.isInteger && update.increment.isInteger,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}

function sequenceSummaryFromLoopPush(
  push: LoopPush,
  update: {start: NumberValue; increment: NumberValue; end: NumberValue} | undefined,
  context: EvalContext,
): ArraySummary | null {
  if (push.topName == null || push.height == null || update == null) return null
  const summary: ArraySummary = {nondecreasingProps: [], advances: [{prop: 'top', value: update.increment}], spaced: [], lastEnd: null, extentEnds: []}
  if (update.increment.min >= 0) summary.nondecreasingProps.push('top')

  const advanceExpr = update.increment.expr
  const heightExpr = push.height.expr
  if (advanceExpr == null || heightExpr == null) return summary
  const gapExpr = spacedGapExpr(advanceExpr, heightExpr)
  if (gapExpr == null) return summary

  summary.spaced.push({gapExpr, heightExpr, advanceExpr})
  const nonEmptyEnd = lastEndFromLoopEnd(nonEmptyLoopEnd(update, push.length), gapExpr, context)
  if (push.length.min >= 1) summary.lastEnd = nonEmptyEnd
  const extentEnd = extentEndFromLoopPush(push.arrayName, update.start, nonEmptyEnd)
  if (extentEnd != null) summary.extentEnds.push(extentEnd)
  return summary
}

function nonEmptyLoopEnd(
  update: {start: NumberValue; increment: NumberValue; end: NumberValue},
  length: NumberValue,
): NumberValue {
  const nonEmptyLength = {...length, min: Math.max(1, length.min)}
  return runningSumNumber(update.start, nonEmptyLength, update.increment)
}

function extentEndFromLoopPush(
  arrayName: string,
  empty: NumberValue,
  nonEmptyEnd: NumberValue | null,
): ArraySummary['extentEnds'][number] | null {
  if (empty.expr == null || nonEmptyEnd?.expr == null) return null
  return {
    emptyExpr: empty.expr,
    nonEmptyExpr: nonEmptyEnd.expr,
    value: numberValue(
      Math.min(empty.min, nonEmptyEnd.min),
      Math.max(empty.max, nonEmptyEnd.max),
      empty.isInteger && nonEmptyEnd.isInteger,
      `extentEnd(${arrayName}, ${empty.expr})`,
    ),
  }
}

function spacedGapExpr(incrementExpr: string, heightExpr: string): string | null {
  if (sameExpressionText(incrementExpr, heightExpr)) return '0'
  const expression = unwrapExpression(parseExpression(incrementExpr))
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
  if (sameExpressionText(expression.left.getText(), heightExpr)) return expression.right.getText()
  if (sameExpressionText(expression.right.getText(), heightExpr)) return expression.left.getText()
  return null
}

function lastEndFromLoopEnd(end: NumberValue, gapExpr: string, context: EvalContext): NumberValue | null {
  if (sameExpressionText(gapExpr, '0')) return end
  const gap = evaluateSpecExpression(gapExpr, context)
  if (gap.kind !== 'number') return null
  const value = evaluateNumberBinary(ts.SyntaxKind.MinusToken, end, gap)
  return value.kind === 'number' ? value : null
}

function isPushCall(expression: ts.Expression): expression is ts.CallExpression & {expression: ts.PropertyAccessExpression & {expression: ts.Identifier}} {
  return ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.name.text === 'push'
}

function evaluateExpression(expression: ts.Expression, context: EvalContext): Value {
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text)
    return numberValue(value, value, Number.isInteger(value), expression.text, linearConstant(value))
  }
  if (ts.isIdentifier(expression)) return context.env.get(expression.text) ?? unknown(`Unknown identifier ${expression.text}`)
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
  if (isComparisonSyntax(op)) {
    return unknown('Comparison expressions are only supported in condition positions')
  }
  const left = evaluateExpression(expression.left, context)
  const right = evaluateExpression(expression.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') return expressionStructuralFallback(expression, context) ?? unknown('Binary arithmetic expected numbers')

  const result = evaluateNumberBinary(op, left, right)
  return result.kind === 'unknown' ? expressionStructuralFallback(expression, context) ?? result : result
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
      return numberValue(left.min + right.min, left.max + right.max, left.isInteger && right.isInteger, binaryExpr(left, '+', right), linearAdd(left.linear, right.linear), null, mergeProvenance(left, right))
    case ts.SyntaxKind.MinusToken:
      return numberValue(left.min - right.max, left.max - right.min, left.isInteger && right.isInteger, binaryExpr(left, '-', right), linearSubtract(left.linear, right.linear), null, mergeProvenance(left, right))
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

function combineNumberCases(
  left: NumberValue,
  right: NumberValue,
  evaluate: (left: NumberValue, right: NumberValue) => Value,
): NumberCase[] | null {
  if (left.cases == null && right.cases == null) return null
  const cases: NumberCase[] = []
  for (const leftCase of numberBranches(left)) {
    for (const rightCase of numberBranches(right)) {
      const value = evaluate(leftCase.value, rightCase.value)
      if (value.kind !== 'number') return null
      cases.push({
        value,
        assumptions: mergeAssumptions(leftCase.assumptions, rightCase.assumptions),
      })
      if (cases.length > maxNumberCases) return null
    }
  }
  return cases
}

function evaluateConditional(expression: ts.ConditionalExpression, context: EvalContext): Value {
  const extentEnd = evaluateExtentEndConditional(expression, context)
  if (extentEnd != null) return extentEnd

  const condition = evaluateConditionFacts(expression.condition, context)
  switch (condition.truth) {
    case 'true':
      return evaluateExpression(expression.whenTrue, context)
    case 'false':
      return evaluateExpression(expression.whenFalse, context)
    case 'maybe':
      return valueWithStructuralFallback(joinValues(
        valueWithAssumptions(
          evaluateExpression(expression.whenTrue, contextWithAssumptions(context, condition.trueAssumptions)),
          condition.trueAssumptions,
        ),
        valueWithAssumptions(
          evaluateExpression(expression.whenFalse, contextWithAssumptions(context, condition.falseAssumptions)),
          condition.falseAssumptions,
        ),
      ), expressionStructuralFallback(expression, context))
  }
}

function evaluateCall(expression: ts.CallExpression, context: EvalContext): Value {
  if (ts.isIdentifier(expression.expression) && expression.expression.text === 'lastEnd') return evaluateLastEndCall(expression, context)
  if (ts.isIdentifier(expression.expression) && expression.expression.text === 'extentEnd') return evaluateExtentEndCall(expression, context)
  if (ts.isPropertyAccessExpression(expression.expression)) {
    const target = expression.expression
    if (ts.isIdentifier(target.expression) && target.expression.text === 'Math') {
      return evaluateMathCall(target.name.text, expression.arguments, context)
    }
    const mapResult = evaluateArrayMapCall(expression, context)
    if (mapResult != null) return mapResult
    const namespaceImportReason = namespaceImportCallReason(target, context)
    const fallback = expressionStructuralFallback(expression, context)
    if (fallback != null) return fallback
    if (namespaceImportReason != null) return unknown(namespaceImportReason)
  }
  if (!ts.isIdentifier(expression.expression)) return unknown('Only named pure calls are supported')

  const functionName = expression.expression.text
  const fn = context.program.functions.get(functionName)
  if (fn == null) return evaluateImportedCall(functionName, expression, context)
  if (context.stack.length >= maxInlineDepth) return unknown(`Inline depth exceeded at ${functionName}`)
  if (fn.parameters.length !== expression.arguments.length) return unknown(`Call arity mismatch for ${functionName}`)
  const argumentValues = expression.arguments.map(argument => evaluateExpression(argument, context))
  const obligations = shouldRecordCallObligations(context)
    ? verifyCallGivenSpecs(functionName, context.program, fn, expression, argumentValues, context)
    : 'unknown'

  const env = programGlobalEnv(context.program)
  for (let i = 0; i < fn.parameters.length; i++) {
    const param = fn.parameters[i]!
    if (!ts.isIdentifier(param.name)) return unknown(`Unsupported parameter pattern in ${functionName}`)
    env.set(param.name.text, argumentValues[i] ?? unknown(`Missing argument ${i} for ${functionName}`))
  }

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
  const fallbackShape = valueFromFunctionReturnShape(`${functionName}Result`, fn, context.program)
    ?? valueFromSyntaxTypeShape(`${functionName}Result`, fn.type, context.program, new Set())
    ?? valueFromCallReturnShape(expression.getText(context.program.sourceFile), expression, context.program)
  const fallbackResult = result.kind === 'unknown'
    ? fallbackShape ?? result
    : valueWithStructuralFallback(result, fallbackShape)
  const specs = context.program.specsByFunction.get(functionName) ?? []
  if (specs.length === 0) return fallbackResult
  if (obligations !== 'pass') return fallbackResult

  const proof = verifyFunctionContract(context.program, functionName, context.contractCache)
  if (proof.status !== 'pass') return fallbackResult

  return valueWithFunctionContractSummary(functionName, context.program, fn, specs, argumentValues, context.contractCache, {
    kind: 'local',
    sourceFile: context.program.file,
    sourceFunctionName: functionName,
  }, fallbackResult)
}

function evaluateImportedCall(functionName: string, expression: ts.CallExpression, context: EvalContext): Value {
  const binding = context.program.imports.get(functionName)
  const structuralFallback = structuralShape(valueFromCallReturnShape(expression.getText(context.program.sourceFile), expression, context.program))
  if (binding == null) return structuralFallback ?? unknown(`Unknown function ${functionName}`)
  if (binding.kind === 'unresolved') return structuralFallback ?? unknown(importedContractUnavailableReason(functionName, binding, binding.reason))

  const exported = resolveFitExport(binding.module, binding.exportedName)
  if (exported.kind === 'unresolved') return unknown(importedContractUnavailableReason(functionName, binding, exported.reason))

  const fn = exported.module.functions.get(exported.localName)
  if (fn == null) return unknown(importedContractUnavailableReason(functionName, binding, `resolved to ${exported.module.file}#${exported.localName}, but that symbol is not a function declaration`))
  const specs = exported.module.specsByFunction.get(exported.localName) ?? []
  const resolvedStructuralFallback = structuralFallback ?? structuralShape(valueFromFunctionReturnShape(`${binding.exportedName}Result`, fn, exported.module))
  if (specs.length === 0) return resolvedStructuralFallback ?? unknown(importedContractUnavailableReason(functionName, binding, `resolved to ${exported.module.file}#${exported.localName}, but that function has no @fit contract`))
  if (fn.parameters.length !== expression.arguments.length) return unknown(`Call arity mismatch for imported function ${binding.exportedName}`)
  if (!shouldRecordCallObligations(context)) return resolvedStructuralFallback ?? unknown(`Imported call ${binding.exportedName} contract was not used outside a @fit claim`)
  const source = {
    sourceFile: exported.module.file,
    sourceFunctionName: fn.name?.text ?? exported.localName,
  }

  const proof = verifyFunctionContract(exported.module, exported.localName, context.contractCache)
  if (proof.status !== 'pass') return unknown(importedContractFailureReason(functionName, binding, proof))

  const argumentValues = expression.arguments.map(argument => evaluateExpression(argument, context))
  const obligations = verifyCallGivenSpecs(functionName, exported.module, fn, expression, argumentValues, context)
  if (obligations !== 'pass') return unknown(`Imported call ${binding.exportedName} precondition was not proven`)

  return valueWithFunctionContractSummary(functionName, exported.module, fn, specs, argumentValues, context.contractCache, {...source, kind: 'imported'}, resolvedStructuralFallback ?? unknownResultValue(specs, exported.module))
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

function namespaceImportCallReason(target: ts.PropertyAccessExpression, context: EvalContext): string | null {
  if (!ts.isIdentifier(target.expression)) return null
  const binding = context.program.imports.get(target.expression.text)
  if (binding?.kind !== 'unresolved' || binding.exportedName !== '*') return null
  return importedContractUnavailableReason(`${target.expression.text}.${target.name.text}`, binding, binding.reason)
}

function evaluateArrayMapCall(expression: ts.CallExpression, context: EvalContext): Value | null {
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== 'map') return null
  const source = evaluateExpression(expression.expression.expression, context)
  if (source.kind !== 'array') return unknown('Array.map expected an array')
  const callback = expression.arguments[0]
  if (callback == null || expression.arguments.length !== 1 || !ts.isArrowFunction(callback)) return unknown('Array.map expects one arrow callback')
  const itemParam = callback.parameters[0]
  const indexParam = callback.parameters[1]
  if (itemParam == null || callback.parameters.length > 2 || !ts.isIdentifier(itemParam.name)) return unknown('Array.map callback expected one simple item parameter and optional index parameter')
  const indexName = indexParam == null ? null : ts.isIdentifier(indexParam.name) ? indexParam.name.text : null
  if (indexParam != null && indexName == null) return unknown('Array.map index parameter expected a simple identifier')
  const sourceName = source.expr ?? expression.expression.expression.getText(context.program.sourceFile)
  const item = source.element ?? unknownObject(`${sourceName}[]`)
  const env = new Map(context.env).set(itemParam.name.text, item)
  if (indexName != null) {
    const index = indexedElementPathValue(`mapIndex(${sourceName})`, source.length)
    env.set(indexName, index)
    context.assumptions = mergeAssumptions(context.assumptions, indexedElementPathAssumptions(index, source.length))
  }
  const callbackContext = {...context, env}
  const element = ts.isExpression(callback.body)
    ? evaluateExpression(callback.body, callbackContext)
    : evaluateArrayMapCallbackBlock(callback.body, callbackContext)
  const mapped = {
    kind: 'array',
    length: source.length,
    elements: null,
    element,
    expr: null,
    summary: null,
  } satisfies ArrayValue
  return valueWithStructuralFallback(mapped, expressionStructuralFallback(expression, context))
}

function evaluateArrayMapCallbackBlock(block: ts.Block, context: EvalContext): Value {
  for (const statement of block.statements) {
    if (ts.isVariableStatement(statement)) {
      if (!isConstDeclarationList(statement.declarationList)) return unknown('Array.map callback block supports const bindings and return only')
      bindVariableStatement(statement, context)
      continue
    }
    if (ts.isReturnStatement(statement)) {
      if (statement.expression == null) return unknown('Array.map callback block return expected an expression')
      return evaluateExpression(statement.expression, context)
    }
    return unknown('Array.map callback block supports const bindings and return only')
  }
  return unknown('Array.map callback block did not return')
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
  const lines = [
    `lastEnd(${targetText}) was not inferred`,
    'need: a non-empty append-only row loop that pushes height',
    `known:\n  rows length: ${formatRange(target.length)}\n  sequence facts: ${formatArraySummary(target)}`,
  ]
  lines.push(`missing: ${missing}`)
  return lines.join('\n')
}

function extentEndFailureReason(targetText: string, emptyExpr: string, target: ArrayValue) {
  const lines = [
    `extentEnd(${targetText}, ${emptyExpr}) was not inferred`,
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
  const head = proof.status === 'fail' ? 'imported helper contract failed in source before this call could trust it' : 'imported helper contract was not proven in source before this call could trust it'
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
    : binding.exportedName === localName ? localName : `${localName} (${binding.exportedName})`
  return `${importedName} from ${binding.specifier}`
}

function valueWithFunctionContractSummary(
  functionName: string,
  program: Program,
  fn: ts.FunctionDeclaration,
  specs: FitSpec[],
  argumentValues: Value[],
  contractCache: Map<string, FunctionContractProof>,
  source: FunctionContractSource,
  result: Value,
): Value {
  const env = programGlobalEnv(program)
  for (let i = 0; i < fn.parameters.length; i++) {
    const param = fn.parameters[i]!
    if (!ts.isIdentifier(param.name)) return unknown(`Unsupported parameter pattern in imported function ${functionName}`)
    env.set(param.name.text, argumentValues[i] ?? unknown(`Missing argument ${i} for imported function ${functionName}`))
  }
  env.set('result', result)

  const context: EvalContext = {
    program,
    file: program.file,
    env,
    inputRoots: [...functionInputRoots(program, fn), 'result'],
    stack: [functionName],
    checks: [],
    assumptions: [],
    contractCache,
  }

  for (const spec of specs) {
    if (spec.kind === 'check-range') applySummaryRangeSpec(env, spec, source)
  }
  for (const spec of specs) {
    if (spec.kind === 'check-comparison') applySummaryComparisonSpec(env, spec, context, source)
  }

  return env.get('result') ?? unknown(`Imported function ${functionName} contract did not describe result`)
}

function applySummaryRangeSpec(env: Map<string, Value>, spec: Extract<FitSpec, {kind: 'check-range'}>, source: FunctionContractSource) {
  if (simpleResultPathText(spec.expression) == null) return
  const closed = closedRangeApprox(spec.range)
  if (closed == null) return
  setSummaryPathValue(
    env,
    spec.expression,
    numberValue(
      closed.min,
      closed.max,
      spec.range.valueKind === 'int',
      spec.expression,
      linearVariable(linearNameForExpression(spec.expression)),
      null,
      [sourceProvedContractFact(source, spec.text)],
    ),
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
  const fact = sourceProvedContractFact(source, spec.text)
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

function sourceProvedContractFact(source: FunctionContractSource, text: string) {
  const kind = source.kind === 'local' ? 'source-proved helper contract' : 'source-proved imported contract'
  return `${kind}: ${source.sourceFile}#${source.sourceFunctionName}: ${text}`
}

function simpleResultPathText(text: string): string | null {
  const parsed = parseFitExpression(text)
  const domainPaths = [...parsed.domainPaths.values()]
  if (domainPaths.length === 1 && domainPaths[0]!.root === 'result' && ts.isIdentifier(parsed.expression)) return text
  if (domainPaths.length > 0) return null

  const expression = unwrapExpression(parsed.expression)
  if (ts.isIdentifier(expression) && expression.text === 'result') return text
  if (ts.isPropertyAccessExpression(expression) && expressionRootNameDeep(expression.expression) === 'result') return text
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
  }
}

function verifyCallGivenSpecs(
  functionName: string,
  calleeProgram: Program,
  fn: ts.FunctionDeclaration,
  expression: ts.CallExpression,
  argumentValues: Value[],
  context: EvalContext,
) {
  const specs = calleeProgram.specsByFunction.get(fn.name?.text ?? functionName) ?? []
  const callText = `${functionName}(${expression.arguments.map(argument => argument.getText(context.program.sourceFile)).join(', ')})`
  const env = programGlobalEnv(calleeProgram)
  let statusSummary: FitCheckStatus = 'pass'
  for (let i = 0; i < fn.parameters.length; i++) {
    const param = fn.parameters[i]!
    if (!ts.isIdentifier(param.name)) continue
    env.set(param.name.text, argumentValues[i] ?? unknown(`Missing argument ${i} for ${functionName}`))
  }
  const calleeContext: EvalContext = {...context, program: calleeProgram, env, inputRoots: functionInputRoots(calleeProgram, fn)}

  for (const spec of specs) {
    let status: {status: FitCheckStatus; reason?: string} | null = null
    if (spec.kind === 'given-range') {
      const value = evaluateSpecExpression(spec.expression, calleeContext)
      status = proveRangeSpec(value, spec.range, calleeContext)
      if (status.status !== 'pass') status = withCallRangeReason(status, value, spec)
    }
    if (spec.kind === 'given-comparison') {
      const left = evaluateSpecExpression(spec.left, calleeContext)
      const right = evaluateSpecExpression(spec.right, calleeContext)
      status = proveComparison(left, spec.op, right, calleeContext.assumptions)
      if (status.status !== 'pass') status = withCallComparisonReason(status, left, right, spec)
    }
    if (status == null) continue
    context.checks.push({
      file: context.file,
      functionName: context.stack.join(' > '),
      text: `call ${callText}: ${callRequirementText(spec)}`,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    })
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
): {status: FitCheckStatus; reason?: string} {
  if (value.kind !== 'number') return status
  return {
    ...status,
    reason: [
      `called function requires ${spec.expression}: ${formatRangeSpec(spec.range)}`,
      `this call passes ${formatCallBinding(spec.expression, value)}`,
      ...missingBoundsForRange(value, spec.range),
    ].join('\n'),
  }
}

function missingBoundsForRange(value: NumberValue, range: FitRange) {
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
  )
}

function withCallComparisonReason(
  status: {status: FitCheckStatus; reason?: string},
  left: Value,
  right: Value,
  spec: Extract<FitSpec, {kind: 'given-comparison'}>,
): {status: FitCheckStatus; reason?: string} {
  if (left.kind !== 'number' || right.kind !== 'number') return status
  const lines = [
    `called function requires ${spec.left} ${spec.op} ${spec.right}`,
    `this call passes ${formatCallBinding(spec.left, left)} and ${formatCallBinding(spec.right, right)}`,
  ]
  if (status.status === 'unknown') lines.push(`could not prove ${comparisonNeed(left, spec.op, right)}`)
  return {
    ...status,
    reason: lines.join('\n'),
  }
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
  if (target.kind === 'array' && expression.name.text === 'length') return target.length
  if (target.kind === 'unknown') return fallback ?? target
  if (target.kind !== 'object') return fallback ?? unknown(`Property access ${expression.name.text} expected an object`)
  const value = target.props.get(expression.name.text) ?? (target.expr == null ? unknown(`Unknown property ${expression.name.text}`) : unknownNumber(`${target.expr}.${expression.name.text}`))
  return valueWithStructuralFallback(value, fallback)
}

function evaluateElementAccess(expression: ts.ElementAccessExpression, context: EvalContext): Value {
  const target = evaluateExpression(expression.expression, context)
  if (target.kind !== 'array') return expressionStructuralFallback(expression, context) ?? unknown(`Element access expected an array`)
  const index = evaluateExpression(expression.argumentExpression, context)
  if (index.kind !== 'number') return unknown('Array index expected a number')
  if (!index.isInteger) return unknown(`Array index ${formatRange(index)} was not proven integer`)
  const lower = proveComparison(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), context.assumptions)
  const upper = proveComparison(index, '<', target.length, context.assumptions)
  if (lower.status !== 'pass' || upper.status !== 'pass') return unknown(`Array index ${formatRange(index)} was not proven inside length ${formatRange(target.length)}`)
  const fallback = expressionStructuralFallback(expression, context)
  if (target.elements == null) return valueWithStructuralFallback(target.element ?? unknown('Array element values are not tracked'), fallback)
  const start = Math.max(0, Math.ceil(index.min))
  const end = Math.min(target.elements.length - 1, Math.floor(index.max))
  if (start > end) return unknown(`Array index ${formatRange(index)} has no possible element`)
  let value = target.elements[start]!
  for (let i = start + 1; i <= end; i++) value = joinValues(value, target.elements[i]!)
  return valueWithStructuralFallback(value, fallback)
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
      verifyInlineRangeSpecsForValue(specs, value, context)
      continue
    }
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      const propertyPath = objectPropertyPath(context, property.name.text)
      const specs = parseInlineFitSpecsForExpression(context.program.sourceText, property, objectPathText(propertyPath))
      const evaluate = () => evaluateExpressionWithObjectPath(property.initializer, context, propertyPath)
      const value = specs.length > 0 ? withCallObligationRecording(context, evaluate) : evaluate()
      props.set(property.name.text, value)
      verifyInlineRangeSpecsForValue(specs, value, context)
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

function verifyInlineRangeSpecsForValue(specs: Extract<FitSpec, {kind: 'check-range'}>[], value: Value, context: EvalContext) {
  if (specs.length === 0) return
  for (const spec of specs) {
    const status = proveRangeSpec(value, spec.range, context)
    context.checks.push({
      file: context.file,
      functionName: context.stack.join(' > '),
      text: spec.text,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    })
  }
}

function evaluateArrayLiteral(expression: ts.ArrayLiteralExpression, context: EvalContext): Value {
  let length = numberValue(0, 0, true, '0', linearConstant(0))
  let elements: Value[] | null = []
  let elementValue: Value | null = null

  for (const element of expression.elements) {
    if (ts.isSpreadElement(element)) {
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

  return {kind: 'array', length, elements, element: elementValue, expr: null, summary: null}
}

function evaluateConditionFacts(expression: ts.Expression, context: EvalContext): {truth: Truth; trueAssumptions: LinearConstraint[]; falseAssumptions: LinearConstraint[]} {
  if (!ts.isBinaryExpression(expression)) return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const op = expression.operatorToken.kind
  if (!isComparisonSyntax(op)) return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const left = evaluateExpression(expression.left, context)
  const right = evaluateExpression(expression.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const comparison = syntaxToComparison(op)
  const trueFact = comparisonConstraint(left, comparison, right, undefined, 'branch')
  const falseComparison = negatedComparison(comparison)
  const falseFact = falseComparison == null ? null : comparisonConstraint(left, falseComparison, right, undefined, 'branch')
  const status = proveComparison(left, comparison, right, context.assumptions)
  if (status.status === 'pass') return {truth: 'true', trueAssumptions: trueFact == null ? [] : [trueFact], falseAssumptions: falseFact == null ? [] : [falseFact]}
  if (status.status === 'fail') return {truth: 'false', trueAssumptions: trueFact == null ? [] : [trueFact], falseAssumptions: falseFact == null ? [] : [falseFact]}
  return {
    truth: 'maybe',
    trueAssumptions: trueFact == null ? [] : [trueFact],
    falseAssumptions: falseFact == null ? [] : [falseFact],
  }
}

function negatedComparison(op: ComparisonOperator): ComparisonOperator | null {
  switch (op) {
    case '==':
      return null
    case '>=':
      return '<'
    case '<=':
      return '>'
    case '>':
      return '<='
    case '<':
      return '>='
  }
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
  const expression = unwrapExpression(parseExpression(args[0]!))
  if (!ts.isPropertyAccessExpression(expression)) return null
  const array = evaluateExpression(expression.expression, context)
  return array.kind === 'array' ? {array, prop: expression.name.text} : null
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
