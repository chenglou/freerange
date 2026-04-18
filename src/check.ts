import * as ts from 'typescript'
import {
  buildFitSourceModule,
  loadFitProject,
  resolveFitExport,
  type FitImportBinding,
  type FitModule,
} from './modules.ts'
import {
  domainPathSyntheticName,
  parseDomainPathText,
  parseExpression,
  parseFitExpression,
  parseFitSpecs,
  type ComparisonOperator,
  type FitDomainPath,
  type FitDomainPathSegment,
  type FitSpec,
} from './parser.ts'
import {
  comparisonFailureReason,
  comparisonNeed,
  formatArraySummary,
  formatRange,
  missingRangeBounds,
  rangeFailureReason,
} from './reporting.ts'

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

type Program = FitModule<NumberValue>

type ImportedBinding = FitImportBinding<Program>

type FunctionContractProof =
  | {status: 'verifying'}
  | {status: FitCheckStatus; checks: FitCheck[]}

type Value = NumberValue | ObjectValue | ArrayValue | UnknownValue

type NumberValue = {
  kind: 'number'
  min: number
  max: number
  isInteger: boolean
  expr: string | null
  linear: LinearExpr | null
  cases: NumberCase[] | null
  provenance: string[]
}

type ObjectValue = {
  kind: 'object'
  props: Map<string, Value>
  expr: string | null
}

type ArrayValue = {
  kind: 'array'
  length: NumberValue
  elements: Value[] | null
  element: Value | null
  expr: string | null
  summary: ArraySummary | null
}

type ArraySummary = {
  nondecreasingProps: string[]
  advances: {prop: string; value: NumberValue}[]
  spaced: {gapExpr: string; heightExpr: string; advanceExpr: string}[]
  lastEnd: NumberValue | null
  extentEnds: {emptyExpr: string; nonEmptyExpr: string; value: NumberValue}[]
}

type WildcardUse =
  | {kind: 'none'}
  | {kind: 'one'; collection: string}
  | {kind: 'unsupported'; reason: string}

type UnknownValue = {
  kind: 'unknown'
  reason: string
}

type EvalContext = {
  program: Program
  file: string
  env: Map<string, Value>
  inputRoots: string[]
  stack: string[]
  checks: FitCheck[]
  assumptions: LinearConstraint[]
  contractCache: Map<string, FunctionContractProof>
}

const maxInlineDepth = 12
const maxNumberCases = 8
const maxLinearReductionDepth = 4
const linearEpsilon = 1e-9

type LinearExpr = {
  constant: number
  terms: Map<string, number>
}

type LinearConstraint = {
  diff: LinearExpr | null
  op: ComparisonOperator
  text?: string
  leftExpr?: string
  rightExpr?: string
  source: FactSource
  rangeFact?: true
}

type FactSource = 'function-given' | 'loop-given' | 'code'

type TrustedGivenSpec =
  | {kind: 'range'; spec: Extract<FitSpec, {kind: 'given-range'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}
  | {kind: 'comparison'; spec: Extract<FitSpec, {kind: 'given-comparison'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}

type ConditionalLoopAdd = {
  targetName: string
  increment: NumberValue
}

type NonNegativeFact = {
  diff: LinearExpr
  strict: boolean
  text?: string
}

type NumberCase = {
  value: NumberValue
  assumptions: LinearConstraint[]
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
    if (specs.length === 0) continue
    checks.push(...verifyFunctionSpecs(program.file, program, statement, specs, contractCache))
  }

  return checks
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
    env.set(param.name.text, unknownParamValue(param.name.text, specs))
  }

  const {trustedGivens, checks} = validateGivenSpecs(file, functionName, specs, inputRoots, 'function-given')

  for (const given of trustedGivens) {
    if (given.kind !== 'range') continue
    applyGivenRangeSpec(env, given.spec)
  }

  const {assumptions, checks: impossibleChecks} = collectGivenAssumptions(file, program, functionName, env, inputRoots, trustedGivens, contractCache)
  checks.push(...impossibleChecks)
  const context: EvalContext = {program, file, env, inputRoots, stack: [functionName], checks: [], assumptions, contractCache}
  const result = evaluateFunctionBody(fn, context)
  checks.push(...context.checks)

  for (const spec of specs) {
    if (spec.kind === 'given-range' || spec.kind === 'given-comparison') continue
    checks.push(verifyCheckSpec(file, program, functionName, env, result, spec, checks, context.assumptions, contractCache))
  }

  return checks
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
      return expressionRootNamesFromText(spec.expression)
    case 'given-comparison':
      return [...new Set([...expressionRootNamesFromText(spec.left), ...expressionRootNamesFromText(spec.right)])]
  }
}

function givenRangeProblem(spec: Extract<FitSpec, {kind: 'given-range'}>, ranges: Extract<FitSpec, {kind: 'given-range'}>[]): string | null {
  if (spec.min > spec.max) return `no input can satisfy this: minimum ${spec.min} is greater than maximum ${spec.max}`
  for (const range of ranges) {
    if (!sameExpressionText(range.expression, spec.expression)) continue
    if (spec.max < range.min || spec.min > range.max) {
      return `no input can satisfy both ${range.text} and ${spec.text}`
    }
  }
  return null
}

function givenShapeProblem(spec: Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>): string | null {
  const roots = givenRootNames(spec)
  if (roots.length === 0) return 'given must mention an input'

  if (spec.kind === 'given-range') {
    if (parseDomainPathText(spec.expression) != null) return null
    const expression = parseExpression(spec.expression)
    return isGivenRangeExpression(expression) ? null : 'given range must name one input path, not a derived expression'
  }

  const left = givenComparisonExpressionProblem(spec.left)
  if (left != null) return left
  return givenComparisonExpressionProblem(spec.right)
}

function givenComparisonExpressionProblem(text: string): string | null {
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
      assumptions.push(...rangeFactsFromValue(value, spec.min, spec.max, spec.text, given.source))
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
    if (fact != null) assumptions.push(fact)
  }
  return {assumptions, checks}
}

function applyGivenRangeSpec(env: Map<string, Value>, spec: Extract<FitSpec, {kind: 'given-range'}>) {
  const value = numberValue(spec.min, spec.max, spec.valueKind === 'int', spec.expression, linearVariable(linearNameForExpression(spec.expression)))
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

function unknownParamValue(name: string, specs: FitSpec[]): Value {
  const shape = specParamShape(name, specs)
  if (shape === 'array') return unknownArray(name)
  if (shape === 'object') return unknownObject(name)
  return unknownNumber(name)
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
    const status = proveRange(value, spec.min, spec.max, spec.valueKind === 'int', context.assumptions)
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
  if (fn.body == null) return unknown(`Function ${fn.name?.text ?? '<anonymous>'} has no body`)
  const localEnv = new Map(context.env)
  const localContext: EvalContext = {...context, env: localEnv}
  const result = evaluateStatements(fn.body.statements, localContext)
  context.assumptions = localContext.assumptions
  return result
}

function evaluateStatements(statements: ts.NodeArray<ts.Statement>, context: EvalContext, startIndex = 0): Value {
  for (let index = startIndex; index < statements.length; index++) {
    const statement = statements[index]!
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindVariableDeclaration(declaration, context)
      }
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
      return evaluateExpression(statement.expression, context)
    }
    return unknown(`Unsupported statement in ${context.stack.at(-1) ?? '<unknown>'}: ${statement.getText(context.program.sourceFile)}`)
  }

  return unknown(`Function ${context.stack.at(-1) ?? '<unknown>'} did not return`)
}

function bindVariableDeclaration(declaration: ts.VariableDeclaration, context: EvalContext) {
  if (!ts.isIdentifier(declaration.name)) return
  if (declaration.initializer == null) {
    context.env.set(declaration.name.text, unknown(`Uninitialized local ${declaration.name.text}`))
    return
  }
  context.env.set(declaration.name.text, evaluateExpression(declaration.initializer, context))
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
    length: unknownNumber(`${expr}.length`),
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
    return evaluateExpression(statement.expression, context)
  }
  if (!ts.isBlock(statement)) return unknown(`Unsupported branch statement: ${statement.getText(context.program.sourceFile)}`)
  const localContext: EvalContext = {...context, env: new Map(context.env)}
  for (const child of statement.statements) {
    if (ts.isVariableStatement(child)) {
      for (const declaration of child.declarationList.declarations) bindVariableDeclaration(declaration, localContext)
      continue
    }
    if (ts.isExpressionStatement(child)) {
      const result = applyExpressionStatement(child.expression, localContext)
      if (result != null) return result
      continue
    }
    if (ts.isReturnStatement(child)) {
      if (child.expression == null) return unknown('Return without expression')
      return evaluateExpression(child.expression, localContext)
    }
    return unknown(`Unsupported branch statement: ${child.getText(context.program.sourceFile)}`)
  }
  return unknown('Branch did not return')
}

function evaluateForOfStatement(statement: ts.ForOfStatement, context: EvalContext): Value | null {
  const rawLocalSpecs = parseFitSpecs(context.program.sourceText, statement)
  const {validSpecs: localSpecs, resultSpecs} = splitLoopSpecs(rawLocalSpecs)
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

  for (const child of statement.statement.statements) {
    const loopContext = {...context, env: new Map(context.env).set(loopItemName, loopItem)}
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

    return unknown(`Unsupported for-of body statement: ${child.getText(context.program.sourceFile)}`)
  }

  if (conditionalPushedArrays.length > 0 && (conditionalPushedArrays.length > 1 || pushedArrays.length > 0 || pendingAdds.size > 0)) {
    return unknown('Conditional push loops support one guarded push and no cursor update')
  }
  if (conditionalAdds.size > 0 && (pushedArrays.length > 0 || conditionalPushedArrays.length > 0 || pendingAdds.size > 0)) {
    return unknown('Conditional running-sum loops support guarded += statements only')
  }

  const updates = new Map<string, {start: NumberValue; increment: NumberValue; end: NumberValue}>()

  for (const [targetName, increment] of pendingAdds) {
    const start = context.env.get(targetName)
    if (start == null || start.kind !== 'number') return unknown('Running-sum loop target expected a number')
    const end = runningSumNumber(start, source.length, increment)
    context.env.set(targetName, end)
    updates.set(targetName, {start, increment, end})
  }

  for (const [targetName, increment] of conditionalAdds) {
    const start = context.env.get(targetName)
    if (start == null || start.kind !== 'number') return unknown('Conditional running-sum loop target expected a number')
    const end = conditionalRunningSumNumber(targetName, start, source.length, increment)
    context.env.set(targetName, end)
    context.assumptions = mergeAssumptions(context.assumptions, conditionalRunningSumFacts(end, start, source.length, increment))
  }

  for (const push of pushedArrays) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
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

  return null
}

function evaluateForStatement(statement: ts.ForStatement, context: EvalContext): Value | null {
  const rawLocalSpecs = parseFitSpecs(context.program.sourceText, statement)
  const {validSpecs: localSpecs, resultSpecs} = splitLoopSpecs(rawLocalSpecs)
  reportLoopResultSpecs(resultSpecs, context)
  applyLocalGivenSpecs(localSpecs, context)

  const shape = indexedLoopShape(statement)
  if (shape == null) return unknown(`Unsupported for loop: ${statement.getText(context.program.sourceFile)}`)
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
  for (const child of statement.statement.statements) {
    if (ts.isVariableStatement(child)) {
      for (const declaration of child.declarationList.declarations) bindVariableDeclaration(declaration, loopContext)
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

    return unknown(`Unsupported indexed loop body statement: ${child.getText(context.program.sourceFile)}`)
  }

  const updates = new Map<string, {start: NumberValue; increment: NumberValue; end: NumberValue}>()
  for (const [targetName, increment] of pendingAdds) {
    const start = context.env.get(targetName)
    if (start == null || start.kind !== 'number') return unknown('Indexed running-sum loop target expected a number')
    const end = runningSumNumber(start, source.length, increment)
    context.env.set(targetName, end)
    updates.set(targetName, {start, increment, end})
  }

  for (const push of pushes) {
    const target = context.env.get(push.arrayName)
    if (target?.kind !== 'array') continue
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

  verifyLocalLoopSpecs(localSpecs, context)

  return null
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
  if (row == null || !ts.isObjectLiteralExpression(row)) return {element: null, topName: null, height: null, cursorPaths: []}
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
  const lower = comparisonConstraint(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), `${index.expr ?? `${arrayName}[].index`} >= 0`)
  const upper = comparisonConstraint(index, '<', sourceLength, `${index.expr ?? `${arrayName}[].index`} < ${sourceLength.expr ?? formatRange(sourceLength)}`)
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
    element = setObjectPathValue(element, cursorPath.path, loopCursorElementValue(update, `${push.arrayName}[].${cursorPath.path.join('.')}`, context))
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
  if (ts.isObjectLiteralExpression(expression)) return evaluateObjectLiteral(expression, context)
  if (ts.isArrayLiteralExpression(expression)) return evaluateArrayLiteral(expression, context)
  return unknown(`Unsupported expression: ${expression.getText(context.program.sourceFile)}`)
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
  if (left.kind !== 'number' || right.kind !== 'number') return unknown('Binary arithmetic expected numbers')

  return evaluateNumberBinary(op, left, right)
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
      return joinValues(
        valueWithAssumptions(
          evaluateExpression(expression.whenTrue, contextWithAssumptions(context, condition.trueAssumptions)),
          condition.trueAssumptions,
        ),
        valueWithAssumptions(
          evaluateExpression(expression.whenFalse, contextWithAssumptions(context, condition.falseAssumptions)),
          condition.falseAssumptions,
        ),
      )
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
  }
  if (!ts.isIdentifier(expression.expression)) return unknown('Only named pure calls are supported')

  const functionName = expression.expression.text
  const fn = context.program.functions.get(functionName)
  if (fn == null) return evaluateImportedCall(functionName, expression, context)
  if (context.stack.length >= maxInlineDepth) return unknown(`Inline depth exceeded at ${functionName}`)
  if (fn.parameters.length !== expression.arguments.length) return unknown(`Call arity mismatch for ${functionName}`)
  const argumentValues = expression.arguments.map(argument => evaluateExpression(argument, context))
  const obligations = verifyCallGivenSpecs(functionName, context.program, fn, expression, argumentValues, context)

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
    checks: context.checks,
    assumptions: context.assumptions,
    contractCache: context.contractCache,
  })
  const specs = context.program.specsByFunction.get(functionName) ?? []
  if (specs.length === 0) return result
  if (obligations !== 'pass') return result

  const proof = verifyFunctionContract(context.program, functionName, context.contractCache)
  if (proof.status !== 'pass') return result

  return valueWithFunctionContractSummary(functionName, context.program, fn, specs, argumentValues, context.contractCache, {
    kind: 'local',
    sourceFile: context.program.file,
    sourceFunctionName: functionName,
  }, result)
}

function evaluateImportedCall(functionName: string, expression: ts.CallExpression, context: EvalContext): Value {
  const binding = context.program.imports.get(functionName)
  if (binding == null) return unknown(`Unknown function ${functionName}`)
  if (binding.kind === 'unresolved') return unknown(binding.reason)

  const exported = resolveFitExport(binding.module, binding.exportedName)
  if (exported.kind === 'unresolved') return unknown(exported.reason)

  const fn = exported.module.functions.get(exported.localName)
  if (fn == null) return unknown(`Imported symbol ${binding.exportedName} from ${binding.specifier} is not a function declaration`)
  const specs = exported.module.specsByFunction.get(exported.localName) ?? []
  if (specs.length === 0) return unknown(`Imported function ${binding.exportedName} from ${binding.specifier} has no @fit contract`)
  if (fn.parameters.length !== expression.arguments.length) return unknown(`Call arity mismatch for imported function ${binding.exportedName}`)
  const source = {
    sourceFile: exported.module.file,
    sourceFunctionName: fn.name?.text ?? exported.localName,
  }

  const proof = verifyFunctionContract(exported.module, exported.localName, context.contractCache)
  if (proof.status !== 'pass') return unknown(importedContractFailureReason(binding, proof))

  const argumentValues = expression.arguments.map(argument => evaluateExpression(argument, context))
  const obligations = verifyCallGivenSpecs(functionName, exported.module, fn, expression, argumentValues, context)
  if (obligations !== 'pass') return unknown(`Imported call ${binding.exportedName} precondition was not proven`)

  return valueWithFunctionContractSummary(functionName, exported.module, fn, specs, argumentValues, context.contractCache, {...source, kind: 'imported'}, unknownParamValue('result', specs))
}

function evaluateArrayMapCall(expression: ts.CallExpression, context: EvalContext): Value | null {
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== 'map') return null
  const source = evaluateExpression(expression.expression.expression, context)
  if (source.kind !== 'array') return unknown('Array.map expected an array')
  const callback = expression.arguments[0]
  if (callback == null || expression.arguments.length !== 1 || !ts.isArrowFunction(callback)) return unknown('Array.map expects one arrow callback')
  const param = callback.parameters[0]
  if (param == null || callback.parameters.length !== 1 || !ts.isIdentifier(param.name)) return unknown('Array.map callback expected one simple parameter')
  if (!ts.isExpression(callback.body)) return unknown('Array.map callback block bodies are not supported yet')

  const item = source.element ?? unknownObject(`${source.expr ?? expression.expression.expression.getText(context.program.sourceFile)}[]`)
  const element = evaluateExpression(callback.body, {...context, env: new Map(context.env).set(param.name.text, item)})
  return {
    kind: 'array',
    length: source.length,
    elements: null,
    element,
    expr: null,
    summary: null,
  }
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

function importedContractFailureReason(binding: Extract<ImportedBinding, {kind: 'resolved'}>, proof: FunctionContractProof) {
  if (proof.status === 'verifying') return `Imported contract ${binding.exportedName} from ${binding.specifier} is already being verified`
  const failed = proof.checks.find(check => check.status !== 'pass')
  if (failed == null) return `Imported contract ${binding.exportedName} from ${binding.specifier} was not proven`
  const reason = failed.reason == null ? '' : `\n${failed.reason}`
  return `Imported contract ${binding.exportedName} from ${binding.specifier} was not proven\n${failed.file}:${failed.functionName}: ${failed.text}${reason}`
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
    if (spec.kind === 'check-comparison') applySummaryComparisonSpec(env, spec, context, source)
  }

  return env.get('result') ?? unknown(`Imported function ${functionName} contract did not describe result`)
}

function applySummaryRangeSpec(env: Map<string, Value>, spec: Extract<FitSpec, {kind: 'check-range'}>, source: FunctionContractSource) {
  if (simpleResultPathText(spec.expression) == null) return
  setSummaryPathValue(
    env,
    spec.expression,
    numberValue(
      spec.min,
      spec.max,
      spec.valueKind === 'int',
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

  switch (op) {
    case '==':
      setSummaryPathValue(env, path, numberValue(other.min, other.max, other.isInteger, other.expr, other.linear, null, provenance))
      return
    case '>=':
    case '>':
      setSummaryPathValue(env, path, numberValue(Math.max(current.min, other.min), current.max, current.isInteger, current.expr, current.linear, current.cases, provenance))
      return
    case '<=':
    case '<':
      setSummaryPathValue(env, path, numberValue(current.min, Math.min(current.max, other.max), current.isInteger, current.expr, current.linear, current.cases, provenance))
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
      status = proveRange(value, spec.min, spec.max, spec.valueKind === 'int', calleeContext.assumptions)
      if (status.status !== 'pass') status = withCallRangeReason(status, value, spec)
    }
    if (spec.kind === 'given-comparison') {
      const left = evaluateSpecExpression(spec.left, calleeContext)
      const right = evaluateSpecExpression(spec.right, calleeContext)
      status = proveComparison(left, spec.op, right, calleeContext.assumptions)
      if (status.status !== 'pass') status = withCallComparisonReason(status, left, spec.op, right, spec.text)
    }
    if (status == null) continue
    context.checks.push({
      file: context.file,
      functionName: context.stack.join(' > '),
      text: `call ${callText}: ${spec.text}`,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    })
    if (status.status === 'fail') statusSummary = 'fail'
    else if (status.status === 'unknown' && statusSummary === 'pass') statusSummary = 'unknown'
  }
  return statusSummary
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
      `caller has ${formatRange(value)}`,
      `callee needs ${spec.expression}: ${spec.valueKind}[${spec.min}, ${spec.max}]`,
      ...missingRangeBounds(value, spec.min, spec.max),
    ].join('\n'),
  }
}

function withCallComparisonReason(
  status: {status: FitCheckStatus; reason?: string},
  left: Value,
  op: ComparisonOperator,
  right: Value,
  text: string,
): {status: FitCheckStatus; reason?: string} {
  if (left.kind !== 'number' || right.kind !== 'number') return status
  return {
    ...status,
    reason: [
      `callee needs ${text}`,
      `caller has ${formatRange(left)} ${op} ${formatRange(right)}`,
      ...(status.reason == null ? [] : status.reason.split('\n')),
    ].join('\n'),
  }
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
    const nonNegative = comparisonConstraint(valueCase.value, '>=', numberValue(0, 0, true, '0', linearConstant(0)))
    const nonPositive = comparisonConstraint(valueCase.value, '<=', numberValue(0, 0, true, '0', linearConstant(0)))
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
        const fact = comparisonConstraint(leftCase.value, leftOp, rightCase.value)
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
        const fact = comparisonConstraint(rightCase.value, rightOp, leftCase.value)
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
  if (target.kind === 'array' && expression.name.text === 'length') return target.length
  if (target.kind !== 'object') return unknown(`Property access ${expression.name.text} expected an object`)
  return target.props.get(expression.name.text) ?? (target.expr == null ? unknown(`Unknown property ${expression.name.text}`) : unknownNumber(`${target.expr}.${expression.name.text}`))
}

function evaluateElementAccess(expression: ts.ElementAccessExpression, context: EvalContext): Value {
  const target = evaluateExpression(expression.expression, context)
  if (target.kind !== 'array') return unknown(`Element access expected an array`)
  const index = evaluateExpression(expression.argumentExpression, context)
  if (index.kind !== 'number') return unknown('Array index expected a number')
  if (!index.isInteger) return unknown(`Array index ${formatRange(index)} was not proven integer`)
  const lower = proveComparison(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), context.assumptions)
  const upper = proveComparison(index, '<', target.length, context.assumptions)
  if (lower.status !== 'pass' || upper.status !== 'pass') return unknown(`Array index ${formatRange(index)} was not proven inside length ${formatRange(target.length)}`)
  if (target.elements == null) return target.element ?? unknown('Array element values are not tracked')
  const start = Math.max(0, Math.ceil(index.min))
  const end = Math.min(target.elements.length - 1, Math.floor(index.max))
  if (start > end) return unknown(`Array index ${formatRange(index)} has no possible element`)
  let value = target.elements[start]!
  for (let i = start + 1; i <= end; i++) value = joinValues(value, target.elements[i]!)
  return value
}

function evaluateObjectLiteral(expression: ts.ObjectLiteralExpression, context: EvalContext): Value {
  const props = new Map<string, Value>()
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      props.set(property.name.text, evaluateExpression(property.name, context))
      continue
    }
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      props.set(property.name.text, evaluateExpression(property.initializer, context))
      continue
    }
    return unknown(`Unsupported object literal property: ${property.getText(context.program.sourceFile)}`)
  }
  return {kind: 'object', props, expr: null}
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

type Truth = 'true' | 'false' | 'maybe'

function evaluateConditionFacts(expression: ts.Expression, context: EvalContext): {truth: Truth; trueAssumptions: LinearConstraint[]; falseAssumptions: LinearConstraint[]} {
  if (!ts.isBinaryExpression(expression)) return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const op = expression.operatorToken.kind
  if (!isComparisonSyntax(op)) return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const left = evaluateExpression(expression.left, context)
  const right = evaluateExpression(expression.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') return {truth: 'maybe', trueAssumptions: [], falseAssumptions: []}
  const comparison = syntaxToComparison(op)
  const trueFact = comparisonConstraint(left, comparison, right)
  const falseComparison = negatedComparison(comparison)
  const falseFact = falseComparison == null ? null : comparisonConstraint(left, falseComparison, right)
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

function compareRanges(left: NumberValue, op: ComparisonOperator, right: NumberValue): Truth {
  switch (op) {
    case '==':
      if (left.min === left.max && right.min === right.max && left.min === right.min) return 'true'
      if (left.max < right.min || right.max < left.min) return 'false'
      return 'maybe'
    case '>=':
      if (left.min >= right.max) return 'true'
      if (left.max < right.min) return 'false'
      return 'maybe'
    case '<=':
      if (left.max <= right.min) return 'true'
      if (left.min > right.max) return 'false'
      return 'maybe'
    case '>':
      if (left.min > right.max) return 'true'
      if (left.max <= right.min) return 'false'
      return 'maybe'
    case '<':
      if (left.max < right.min) return 'true'
      if (left.min >= right.max) return 'false'
      return 'maybe'
  }
}

function proveRange(value: Value, min: number, max: number, requireInteger: boolean, assumptions: LinearConstraint[] = []): {status: FitCheckStatus; reason?: string} {
  if (value.kind !== 'number') return {status: 'unknown', reason: nonNumberReason(value)}
  if (value.min < min || value.max > max) {
    const lower = proveComparison(value, '>=', numberValue(min, min, Number.isInteger(min), `${min}`, linearConstant(min)), assumptions)
    const upper = proveComparison(value, '<=', numberValue(max, max, Number.isInteger(max), `${max}`, linearConstant(max)), assumptions)
    if (lower.status === 'pass' && upper.status === 'pass' && (!requireInteger || value.isInteger)) return {status: 'pass'}
    return {
      status: 'fail',
      reason: rangeFailureReason(value, min, max, requireInteger, assumptions),
    }
  }
  if (requireInteger && !value.isInteger) return {status: 'fail', reason: `range was ${formatRange(value)}, expected integer\nneed: ${value.expr ?? formatRange(value)} to be integer`}
  return {status: 'pass'}
}

function proveComparison(left: Value, op: ComparisonOperator, right: Value, assumptions: LinearConstraint[]): {status: FitCheckStatus; reason?: string} {
  if (left.kind !== 'number') return {status: 'unknown', reason: nonNumberReason(left)}
  if (right.kind !== 'number') return {status: 'unknown', reason: nonNumberReason(right)}
  if (left.cases != null || right.cases != null) {
    let unknownStatus: {status: FitCheckStatus; reason?: string} | null = null
    for (const leftCase of numberBranches(left)) {
      for (const rightCase of numberBranches(right)) {
        const status = proveComparisonPlain(
          leftCase.value,
          op,
          rightCase.value,
          mergeAssumptions(assumptions, leftCase.assumptions, rightCase.assumptions),
        )
        if (status.status === 'fail') return status
        if (status.status === 'unknown') unknownStatus = status
      }
    }
    return unknownStatus ?? {status: 'pass'}
  }
  return proveComparisonPlain(left, op, right, assumptions)
}

function proveComparisonPlain(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): {status: FitCheckStatus; reason?: string} {
  if (op === '==' && left.expr != null && right.expr != null && left.expr === right.expr) return {status: 'pass'}
  const mathTruth = proveMathLemma(left, op, right, assumptions)
  if (mathTruth === 'true') return {status: 'pass'}
  const truth = compareRanges(left, op, right)
  if (truth === 'true') return {status: 'pass'}
  if (truth === 'false') return {status: 'fail', reason: comparisonFailureReason(left, op, right, assumptions, 'is false', missingComparisonFact(left, op, right, assumptions))}
  const linearTruth = compareLinear(left, op, right, assumptions)
  if (linearTruth === 'true') return {status: 'pass'}
  if (linearTruth === 'false') return {status: 'fail', reason: comparisonFailureReason(left, op, right, assumptions, 'is false by exact linear facts', missingComparisonFact(left, op, right, assumptions))}
  return {status: 'unknown', reason: comparisonFailureReason(left, op, right, assumptions, 'was not proven', missingComparisonFact(left, op, right, assumptions))}
}

function proveMathLemma(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): Truth {
  if (left.expr == null || right.expr == null) return 'maybe'
  if (provesRoundingFact(left.expr, op, right.expr)) return 'true'
  if ((op === '>=' || op === '>') && provesCeilDivisionCovers(left.expr, right.expr, assumptions)) return op === '>=' ? 'true' : 'maybe'
  if ((op === '<' || op === '<=') && provesFloorDivisionBelowCount(left.expr, right, assumptions)) return 'true'
  if ((op === '<' || op === '<=') && provesModuloBelowDivisor(left.expr, right.expr, assumptions)) return 'true'
  if ((op === '>=' || op === '>') && provesRunningSumAtLeastStart(left.expr, right.expr, assumptions)) return op === '>=' ? 'true' : 'maybe'
  if ((op === '>=' || op === '>') && provesRunningSumMinusTrailingGapAtLeastStart(left.expr, right.expr, assumptions)) return op === '>=' ? 'true' : 'maybe'
  if (provesPositiveMonotone(left.expr, op, right.expr, assumptions)) return 'true'
  return 'maybe'
}

function provesRoundingFact(leftExpr: string, op: ComparisonOperator, rightExpr: string) {
  const leftCeil = callArg(leftExpr, 'ceil')
  if ((op === '>=' || op === '>') && leftCeil != null && sameExpressionText(leftCeil, rightExpr)) return op === '>='
  const leftFloor = callArg(leftExpr, 'floor')
  if ((op === '<=' || op === '<') && leftFloor != null && sameExpressionText(leftFloor, rightExpr)) return op === '<='
  const rightCeil = callArg(rightExpr, 'ceil')
  if ((op === '<=' || op === '<') && rightCeil != null && sameExpressionText(leftExpr, rightCeil)) return op === '<='
  const rightFloor = callArg(rightExpr, 'floor')
  if ((op === '>=' || op === '>') && rightFloor != null && sameExpressionText(leftExpr, rightFloor)) return op === '>='
  return false
}

function provesCeilDivisionCovers(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const shape = ceilDivisionProduct(leftExpr)
  if (shape == null) return false
  const {total, count} = shape
  if (!sameExpressionText(total, rightExpr)) return false
  return provesExprNonNegative(total, false, assumptions) && provesExprNonNegative(count, true, assumptions)
}

function provesFloorDivisionBelowCount(leftExpr: string, right: NumberValue, assumptions: LinearConstraint[]) {
  if (right.expr == null || !right.isInteger) return false
  const shape = floorDivision(leftExpr)
  if (shape == null) return false
  const {left: pointer, right: cell} = shape
  if (!provesExprNonNegative(cell, true, assumptions)) return false
  return hasComparisonFact(pointer, '<', `(${right.expr} * ${cell})`, assumptions) || hasComparisonFact(pointer, '<', `(${cell} * ${right.expr})`, assumptions)
}

function provesModuloBelowDivisor(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const shape = moduloExpression(leftExpr)
  if (shape == null || !sameExpressionText(shape.right, rightExpr)) return false
  return provesExprNonNegative(shape.left, false, assumptions) && provesExprNonNegative(shape.right, true, assumptions)
}

function provesRunningSumAtLeastStart(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const args = callArgs(leftExpr, 'runningSum')
  if (args == null || args.length !== 3 || !sameExpressionText(args[0]!, rightExpr)) return false
  return provesExprNonNegative(args[1]!, false, assumptions) && provesExprNonNegative(args[2]!, false, assumptions)
}

function provesRunningSumMinusTrailingGapAtLeastStart(leftExpr: string, rightExpr: string, assumptions: LinearConstraint[]) {
  const trailingGap = binaryExpression(leftExpr, '-')
  if (trailingGap == null) return false
  const args = callArgs(trailingGap.left, 'runningSum')
  if (args == null || args.length !== 3 || !sameExpressionText(args[0]!, rightExpr)) return false
  const count = args[1]!
  const increment = args[2]!
  const gap = trailingGap.right
  if (!hasComparisonFact(count, '>=', '1', assumptions)) return false
  if (!provesExprNonNegative(gap, false, assumptions)) return false
  if (sameExpressionText(increment, gap)) return true
  const incrementSum = binaryExpression(increment, '+')
  if (incrementSum == null) return false
  const base =
    sameExpressionText(incrementSum.left, gap) ? incrementSum.right
      : sameExpressionText(incrementSum.right, gap) ? incrementSum.left
        : null
  return base != null && provesExprNonNegative(base, false, assumptions)
}

function provesPositiveMonotone(leftExpr: string, op: ComparisonOperator, rightExpr: string, assumptions: LinearConstraint[]) {
  if (op === '<=' || op === '<') return provesPositiveMonotoneLess(leftExpr, op, rightExpr, assumptions)
  if (op === '>=') return provesPositiveMonotoneLess(rightExpr, '<=', leftExpr, assumptions)
  if (op === '>') return provesPositiveMonotoneLess(rightExpr, '<', leftExpr, assumptions)
  return false
}

function provesPositiveMonotoneLess(leftExpr: string, op: '<=' | '<', rightExpr: string, assumptions: LinearConstraint[]) {
  const leftDivision = binaryExpression(leftExpr, '/')
  const rightDivision = binaryExpression(rightExpr, '/')
  if (leftDivision != null && rightDivision != null && sameExpressionText(leftDivision.right, rightDivision.right)) {
    return provesExprNonNegative(leftDivision.right, true, assumptions) && hasComparisonFact(leftDivision.left, op, rightDivision.left, assumptions)
  }

  const leftProduct = productFactors(leftExpr)
  const rightProduct = productFactors(rightExpr)
  if (leftProduct == null || rightProduct == null) return false
  for (let leftIndex = 0; leftIndex < leftProduct.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < rightProduct.length; rightIndex++) {
      const leftFactor = leftProduct[leftIndex]!
      const rightFactor = rightProduct[rightIndex]!
      if (!sameExpressionText(leftFactor, rightFactor)) continue
      const factorIsPositive = provesExprNonNegative(leftFactor, op === '<', assumptions)
      if (!factorIsPositive) continue
      const leftBase = productText(leftProduct.filter((_, index) => index !== leftIndex))
      const rightBase = productText(rightProduct.filter((_, index) => index !== rightIndex))
      if (hasComparisonFact(leftBase, op, rightBase, assumptions)) return true
    }
  }
  return false
}

function provesExprNonNegative(expression: string, strict: boolean, assumptions: LinearConstraint[]) {
  const linear = linearFromExpressionText(expression)
  return linear != null && provesNonNegative(linear, strict, assumptions)
}

function hasComparisonFact(leftExpr: string, op: ComparisonOperator, rightExpr: string, assumptions: LinearConstraint[]) {
  for (const assumption of assumptions) {
    if (assumption.leftExpr == null || assumption.rightExpr == null) continue
    if (sameExpressionText(assumption.leftExpr, leftExpr) && sameExpressionText(assumption.rightExpr, rightExpr) && comparisonImplies(assumption.op, op)) return true
    if (sameExpressionText(assumption.leftExpr, rightExpr) && sameExpressionText(assumption.rightExpr, leftExpr) && comparisonImplies(flipComparison(assumption.op), op)) return true
  }

  const leftLinear = linearFromExpressionText(leftExpr)
  const rightLinear = linearFromExpressionText(rightExpr)
  if (leftLinear == null || rightLinear == null) return false
  return compareLinear(
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, leftExpr, leftLinear),
    op,
    numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, rightExpr, rightLinear),
    assumptions,
  ) === 'true'
}

function comparisonImplies(actual: ComparisonOperator, needed: ComparisonOperator) {
  if (actual === needed) return true
  if (actual === '==') return needed === '>=' || needed === '<='
  if (actual === '>') return needed === '>='
  if (actual === '<') return needed === '<='
  return false
}

function flipComparison(op: ComparisonOperator): ComparisonOperator {
  switch (op) {
    case '==':
      return '=='
    case '>=':
      return '<='
    case '<=':
      return '>='
    case '>':
      return '<'
    case '<':
      return '>'
  }
}

function sameExpressionText(left: string, right: string) {
  return expressionKeyFromText(left) === expressionKeyFromText(right)
}

function expressionKeyFromText(text: string): string {
  try {
    return expressionKey(parseExpression(text))
  } catch {
    return `text:${text}`
  }
}

function expressionKey(expression: ts.Expression): string {
  const current = unwrapExpression(expression)
  const linear = linearFromExpression(current)
  if (linear != null) return `linear:${linearKey(linear)}`
  if (ts.isIdentifier(current)) return `id:${current.text}`
  if (ts.isNumericLiteral(current)) return `number:${Number(current.text)}`
  if (ts.isPropertyAccessExpression(current)) return `prop:${expressionKey(current.expression)}.${current.name.text}`
  if (ts.isCallExpression(current)) return `call:${callName(current.expression)}(${current.arguments.map(argument => expressionKey(argument)).join(',')})`
  if (ts.isPrefixUnaryExpression(current)) return `prefix:${current.operator}:${expressionKey(current.operand)}`
  if (ts.isBinaryExpression(current)) {
    const op = current.operatorToken.kind
    if (op === ts.SyntaxKind.AsteriskToken) return `product:${productFactorsFromExpression(current).map(text => expressionKeyFromText(text)).sort().join('*')}`
    return `binary:${ts.SyntaxKind[op]}:${expressionKey(current.left)}:${expressionKey(current.right)}`
  }
  return `text:${current.getText()}`
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function callName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`
  return expression.getText()
}

function callArgs(text: string, name: string): string[] | null {
  const expression = unwrapExpression(parseExpression(text))
  if (!ts.isCallExpression(expression) || callName(expression.expression) !== name) return null
  return expression.arguments.map(argument => argument.getText())
}

function callArg(text: string, name: string): string | null {
  const args = callArgs(text, name)
  return args != null && args.length === 1 ? args[0]! : null
}

function ceilDivisionProduct(text: string): {total: string; count: string} | null {
  const product = binaryExpression(text, '*')
  if (product == null) return null
  for (const [maybeCeil, maybeCount] of [[product.left, product.right], [product.right, product.left]] as const) {
    const ceilArg = callArg(maybeCeil, 'ceil')
    if (ceilArg == null) continue
    const division = binaryExpression(ceilArg, '/')
    if (division != null && sameExpressionText(division.right, maybeCount)) return {total: division.left, count: division.right}
  }
  return null
}

function floorDivision(text: string): {left: string; right: string} | null {
  const floorArg = callArg(text, 'floor')
  return floorArg == null ? null : binaryExpression(floorArg, '/')
}

function moduloExpression(text: string): {left: string; right: string} | null {
  return binaryExpression(text, '%')
}

function binaryExpression(text: string, op: '*' | '/' | '%' | '+' | '-'): {left: string; right: string} | null {
  const expression = unwrapExpression(parseExpression(text))
  if (!ts.isBinaryExpression(expression)) return null
  const expected = op === '*'
    ? ts.SyntaxKind.AsteriskToken
    : op === '/'
      ? ts.SyntaxKind.SlashToken
      : op === '%'
        ? ts.SyntaxKind.PercentToken
        : op === '+'
          ? ts.SyntaxKind.PlusToken
          : ts.SyntaxKind.MinusToken
  if (expression.operatorToken.kind !== expected) return null
  return {left: expression.left.getText(), right: expression.right.getText()}
}

function productFactors(text: string): string[] | null {
  const expression = unwrapExpression(parseExpression(text))
  const factors = productFactorsFromExpression(expression)
  return factors.length <= 1 ? null : factors
}

function productFactorsFromExpression(expression: ts.Expression): string[] {
  const current = unwrapExpression(expression)
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return [current.getText()]
  return [...productFactorsFromExpression(current.left), ...productFactorsFromExpression(current.right)]
}

function productText(factors: string[]) {
  if (factors.length === 0) return '1'
  if (factors.length === 1) return factors[0]!
  return factors.map(factor => `(${factor})`).join(' * ')
}

function missingComparisonFact(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]) {
  const missingLinear = missingLinearFact(left, op, right, assumptions)
  if (missingLinear != null) return missingLinear
  return `given ${comparisonNeed(left, op, right)}`
}

function missingLinearFact(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]) {
  const diff = comparisonDiff(left, op, right)
  if (diff == null) return null
  const target = cleanLinear(diff)
  for (const fact of assumptions.filter(assumption => assumption.rangeFact !== true).flatMap(nonNegativeFacts)) {
    for (const scale of reductionScales(target, fact.diff)) {
      const scaledFact = linearScaleExact(fact.diff, scale)
      const remainder = linearSubtract(target, scaledFact)
      if (remainder == null || sameLinear(remainder, target)) continue
      const missing = singleLinearBound(remainder)
      if (missing != null) return missing
    }
  }
  return null
}

function comparisonDiff(left: NumberValue, op: ComparisonOperator, right: NumberValue): LinearExpr | null {
  switch (op) {
    case '==':
      return null
    case '>=':
    case '>':
      return linearSubtract(left.linear, right.linear)
    case '<=':
    case '<':
      return linearSubtract(right.linear, left.linear)
  }
}

function singleLinearBound(linear: LinearExpr) {
  const clean = cleanLinear(linear)
  if (clean.constant !== 0 || clean.terms.size !== 1) return null
  const first = [...clean.terms.entries()][0]
  if (first == null) return null
  const [name, coefficient] = first
  if (coefficient === 0) return null
  return coefficient > 0 ? `${name} >= 0` : `${name} <= 0`
}

function comparisonConstraint(left: NumberValue, op: ComparisonOperator, right: NumberValue, text?: string, source: FactSource = 'code'): LinearConstraint | null {
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null && left.expr == null && right.expr == null && text == null) return null
  return {
    diff,
    op,
    source,
    ...(left.expr == null ? {} : {leftExpr: left.expr}),
    ...(right.expr == null ? {} : {rightExpr: right.expr}),
    ...(text == null ? {} : {text}),
  }
}

function comparisonFactFromSpec(spec: Extract<FitSpec, {kind: 'given-comparison'}>, context: EvalContext, source: FactSource): LinearConstraint | null {
  const left = evaluateSpecExpression(spec.left, context)
  const right = evaluateSpecExpression(spec.right, context)
  if (left.kind !== 'number' || right.kind !== 'number') return null
  return comparisonConstraint(left, spec.op, right, spec.text, source)
}

function rangeFactsFromValue(value: Value, min: number, max: number, text: string, source: FactSource): LinearConstraint[] {
  if (value.kind !== 'number') return []
  const minDiff = linearSubtract(value.linear, linearConstant(min))
  const maxDiff = linearSubtract(linearConstant(max), value.linear)
  const facts: LinearConstraint[] = []
  if (minDiff != null) facts.push({diff: minDiff, op: '>=', text, source, rangeFact: true})
  if (maxDiff != null) facts.push({diff: maxDiff, op: '>=', text, source, rangeFact: true})
  return facts
}

function compareLinear(left: NumberValue, op: ComparisonOperator, right: NumberValue, assumptions: LinearConstraint[]): Truth {
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null) return 'maybe'

  switch (op) {
    case '==':
      if (isZeroLinear(diff)) return 'true'
      return provesNonNegative(diff, false, assumptions) && provesNonNegative(linearScaleExact(diff, -1), false, assumptions) ? 'true' : 'maybe'
    case '>=':
      return provesNonNegative(diff, false, assumptions) ? 'true' : 'maybe'
    case '<=':
      return provesNonNegative(linearScaleExact(diff, -1), false, assumptions) ? 'true' : 'maybe'
    case '>':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(diff, true, assumptions) ? 'true' : 'maybe'
    case '<':
      if (isZeroLinear(diff)) return 'false'
      return provesNonNegative(linearScaleExact(diff, -1), true, assumptions) ? 'true' : 'maybe'
  }
}

function provesNonNegative(diff: LinearExpr, strict: boolean, assumptions: LinearConstraint[]) {
  const facts = assumptions.flatMap(nonNegativeFacts)
  return reduceToNonNegative(diff, strict, facts, maxLinearReductionDepth, new Set())
}

function reduceToNonNegative(
  diff: LinearExpr,
  strict: boolean,
  facts: NonNegativeFact[],
  depth: number,
  seen: Set<string>,
): boolean {
  const cleanDiff = cleanLinear(diff)
  if (linearConstantStatus(cleanDiff, strict)) return true
  for (const fact of facts) {
    const scale = positiveScaleMultiple(cleanDiff, fact.diff)
    if (scale != null && (!strict || fact.strict)) return true
  }
  if (depth === 0) return false

  const key = `${strict ? 'strict' : 'loose'}:${linearKey(cleanDiff)}`
  if (seen.has(key)) return false
  seen.add(key)

  for (const fact of facts) {
    for (const scale of reductionScales(cleanDiff, fact.diff)) {
      const scaledFact = linearScaleExact(fact.diff, scale)
      const remainder = linearSubtract(cleanDiff, scaledFact)
      if (remainder == null || sameLinear(remainder, cleanDiff)) continue
      if (reduceToNonNegative(remainder, strict && !fact.strict, facts, depth - 1, new Set(seen))) return true
    }
  }
  return false
}

function nonNegativeFacts(assumption: LinearConstraint): NonNegativeFact[] {
  if (assumption.diff == null) return []
  switch (assumption.op) {
    case '==':
      return [
        nonNegativeFact(assumption.diff, false, assumption.text),
        nonNegativeFact(linearScaleExact(assumption.diff, -1), false, assumption.text == null ? undefined : `${assumption.text} reversed`),
      ]
    case '>=':
      return [nonNegativeFact(assumption.diff, false, assumption.text)]
    case '<=':
      return [nonNegativeFact(linearScaleExact(assumption.diff, -1), false, assumption.text)]
    case '>':
      return [nonNegativeFact(assumption.diff, true, assumption.text)]
    case '<':
      return [nonNegativeFact(linearScaleExact(assumption.diff, -1), true, assumption.text)]
  }
}

function nonNegativeFact(diff: LinearExpr, strict: boolean, text?: string): NonNegativeFact {
  return {diff, strict, ...(text == null ? {} : {text})}
}

function nonNumberReason(value: ObjectValue | ArrayValue | UnknownValue) {
  if (value.kind === 'unknown') return value.reason
  return value.kind === 'array' ? 'Expected a number, got an array' : 'Expected a number, got an object'
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

function mergeArraySummary(left: ArraySummary | null, right: ArraySummary | null): ArraySummary | null {
  if (left == null) return right
  if (right == null) return left
  return {
    nondecreasingProps: [...new Set([...left.nondecreasingProps, ...right.nondecreasingProps])],
    advances: [...left.advances, ...right.advances].filter((fact, index, facts) => facts.findIndex(other => sameAdvanceFact(other, fact)) === index),
    spaced: [...left.spaced, ...right.spaced].filter((fact, index, facts) => facts.findIndex(other => sameSpacedFact(other, fact)) === index),
    lastEnd: right.lastEnd ?? left.lastEnd,
    extentEnds: [...left.extentEnds, ...right.extentEnds].filter((fact, index, facts) => facts.findIndex(other => sameExtentEndFact(other, fact)) === index),
  }
}

function mergeElementValue(left: Value | null, right: Value | null): Value | null {
  if (left == null) return right
  if (right == null) return left
  return joinValues(left, right)
}

function sameArraySummary(left: ArraySummary | null, right: ArraySummary | null) {
  if (left === right) return true
  if (left == null || right == null) return false
  if ((left.lastEnd?.expr ?? null) !== (right.lastEnd?.expr ?? null)) return false
  if (left.nondecreasingProps.join('|') !== right.nondecreasingProps.join('|')) return false
  if (left.advances.length !== right.advances.length) return false
  if (!left.advances.every((fact, index) => sameAdvanceFact(fact, right.advances[index]!))) return false
  if (left.spaced.length !== right.spaced.length) return false
  if (!left.spaced.every((fact, index) => sameSpacedFact(fact, right.spaced[index]!))) return false
  if (left.extentEnds.length !== right.extentEnds.length) return false
  return left.extentEnds.every((fact, index) => sameExtentEndFact(fact, right.extentEnds[index]!))
}

function sameAdvanceFact(left: ArraySummary['advances'][number], right: ArraySummary['advances'][number]) {
  return left.prop === right.prop && (left.value.expr ?? null) === (right.value.expr ?? null)
}

function sameSpacedFact(left: ArraySummary['spaced'][number], right: ArraySummary['spaced'][number]) {
  return sameExpressionText(left.gapExpr, right.gapExpr)
    && sameExpressionText(left.heightExpr, right.heightExpr)
    && sameExpressionText(left.advanceExpr, right.advanceExpr)
}

function sameExtentEndFact(left: ArraySummary['extentEnds'][number], right: ArraySummary['extentEnds'][number]) {
  return sameExpressionText(left.emptyExpr, right.emptyExpr)
    && sameExpressionText(left.nonEmptyExpr, right.nonEmptyExpr)
    && (left.value.expr ?? null) === (right.value.expr ?? null)
}

function linearNameForExpression(text: string) {
  const domainPath = parseDomainPathText(text)
  return domainPath?.segments.some(segment => segment.kind === 'item') === true ? domainPathSyntheticName(text) : text
}

function numberValue(
  min: number,
  max: number,
  isInteger: boolean,
  expr: string | null,
  linear: LinearExpr | null = null,
  cases: NumberCase[] | null = null,
  provenance: string[] = [],
): NumberValue {
  const clean = linear == null ? null : cleanLinear(linear)
  const cleanProvenance = [...new Set(provenance)]
  if (clean != null && clean.terms.size === 0 && Number.isFinite(clean.constant)) {
    return {kind: 'number', min: clean.constant, max: clean.constant, isInteger: Number.isInteger(clean.constant), expr, linear: clean, cases, provenance: cleanProvenance}
  }
  return {kind: 'number', min, max, isInteger, expr, linear: clean, cases, provenance: cleanProvenance}
}

function unknownNumber(name: string): NumberValue {
  return {
    kind: 'number',
    min: Number.NEGATIVE_INFINITY,
    max: Number.POSITIVE_INFINITY,
    isInteger: false,
    expr: name,
    linear: linearVariable(linearNameForExpression(name)),
    cases: null,
    provenance: [],
  }
}

function mergeProvenance(...items: (NumberValue | string[])[]) {
  const lines: string[] = []
  for (const item of items) {
    lines.push(...(Array.isArray(item) ? item : item.provenance))
  }
  return [...new Set(lines)]
}

function unknownObject(name: string): ObjectValue {
  return {
    kind: 'object',
    props: new Map(),
    expr: name,
  }
}

function unknownArray(name: string, length: NumberValue = unknownNumber(`${name}.length`), element: Value | null = null): ArrayValue {
  return {
    kind: 'array',
    length,
    elements: null,
    element,
    expr: name,
    summary: null,
  }
}

function unknown(reason: string): UnknownValue {
  return {kind: 'unknown', reason}
}

function plainNumber(value: NumberValue): NumberValue {
  return value.cases == null ? value : {...value, cases: null}
}

function numberBranches(value: NumberValue): NumberCase[] {
  return value.cases ?? [{value: plainNumber(value), assumptions: []}]
}

function withNumberCases(value: NumberValue, cases: NumberCase[] | null): NumberValue {
  if (cases == null || cases.length === 0 || cases.length > maxNumberCases) return value
  return {...value, cases: cases.map(choice => ({value: plainNumber(choice.value), assumptions: choice.assumptions}))}
}

function valueWithAssumptions(value: Value, assumptions: LinearConstraint[]): Value {
  if (assumptions.length === 0) return value
  if (value.kind === 'number') {
    return withNumberCases(value, numberBranches(value).map(branch => ({
      value: branch.value,
      assumptions: mergeAssumptions(branch.assumptions, assumptions),
    })))
  }
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, valueWithAssumptions(prop, assumptions))
    return {...value, props}
  }
  if (value.kind === 'array') {
    return {
      ...value,
      length: valueWithAssumptions(value.length, assumptions) as NumberValue,
      elements: value.elements == null ? null : value.elements.map(element => valueWithAssumptions(element, assumptions)),
      element: value.element == null ? null : valueWithAssumptions(value.element, assumptions),
      summary: value.summary == null ? null : {
        ...value.summary,
        advances: value.summary.advances.map(fact => ({...fact, value: valueWithAssumptions(fact.value, assumptions) as NumberValue})),
        lastEnd: value.summary.lastEnd == null ? null : valueWithAssumptions(value.summary.lastEnd, assumptions) as NumberValue,
        extentEnds: value.summary.extentEnds.map(fact => ({...fact, value: valueWithAssumptions(fact.value, assumptions) as NumberValue})),
      },
    }
  }
  return value
}

function contextWithAssumptions(context: EvalContext, assumptions: LinearConstraint[]): EvalContext {
  return assumptions.length === 0 ? context : {...context, assumptions: mergeAssumptions(context.assumptions, assumptions)}
}

function mergeAssumptions(...groups: LinearConstraint[][]): LinearConstraint[] {
  return groups.flat()
}

function numericLiteralValue(expression: ts.Expression): number | null {
  if (ts.isNumericLiteral(expression)) return Number(expression.text)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text)
  }
  return null
}

function linearConstant(value: number): LinearExpr {
  return {constant: value, terms: new Map()}
}

function linearVariable(name: string): LinearExpr {
  return {constant: 0, terms: new Map([[name, 1]])}
}

function linearFromExpressionText(text: string): LinearExpr | null {
  try {
    return linearFromExpression(parseExpression(text))
  } catch {
    return null
  }
}

function linearFromExpression(expression: ts.Expression): LinearExpr | null {
  if (ts.isNumericLiteral(expression)) return linearConstant(Number(expression.text))
  if (ts.isIdentifier(expression)) return linearVariable(expression.text)
  if (ts.isPropertyAccessExpression(expression)) return linearVariable(expression.getText())
  if (ts.isParenthesizedExpression(expression)) return linearFromExpression(expression.expression)
  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = linearFromExpression(expression.operand)
    if (operand == null) return null
    if (expression.operator === ts.SyntaxKind.MinusToken) return linearScaleExact(operand, -1)
    if (expression.operator === ts.SyntaxKind.PlusToken) return operand
    return null
  }
  if (!ts.isBinaryExpression(expression)) return null
  const left = linearFromExpression(expression.left)
  const right = linearFromExpression(expression.right)
  switch (expression.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return linearAdd(left, right)
    case ts.SyntaxKind.MinusToken:
      return linearSubtract(left, right)
    case ts.SyntaxKind.AsteriskToken: {
      const leftValue = numericLiteralValue(expression.left)
      const rightValue = numericLiteralValue(expression.right)
      if (leftValue != null) return linearScale(right, leftValue)
      if (rightValue != null) return linearScale(left, rightValue)
      return null
    }
    case ts.SyntaxKind.SlashToken: {
      const rightValue = numericLiteralValue(expression.right)
      return rightValue == null || rightValue === 0 ? null : linearScale(left, 1 / rightValue)
    }
    default:
      return null
  }
}

function linearAdd(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  if (left == null || right == null) return null
  const terms = new Map(left.terms)
  for (const [name, coefficient] of right.terms) {
    terms.set(name, (terms.get(name) ?? 0) + coefficient)
  }
  return cleanLinear({constant: left.constant + right.constant, terms})
}

function linearSubtract(left: LinearExpr | null, right: LinearExpr | null): LinearExpr | null {
  if (left == null || right == null) return null
  return linearAdd(left, linearScaleExact(right, -1))
}

function linearScale(linear: LinearExpr | null, factor: number): LinearExpr | null {
  return linear == null ? null : linearScaleExact(linear, factor)
}

function linearScaleExact(linear: LinearExpr, factor: number): LinearExpr {
  const terms = new Map<string, number>()
  for (const [name, coefficient] of linear.terms) terms.set(name, coefficient * factor)
  return cleanLinear({constant: linear.constant * factor, terms})
}

function linearMultiply(left: NumberValue, right: NumberValue): LinearExpr | null {
  if (left.min === left.max) return linearScale(right.linear, left.min)
  if (right.min === right.max) return linearScale(left.linear, right.min)
  return null
}

function sameLinear(left: LinearExpr, right: LinearExpr) {
  const diff = linearSubtract(left, right)
  return diff != null && isZeroLinear(diff)
}

function cleanLinear(linear: LinearExpr): LinearExpr {
  const terms = new Map<string, number>()
  for (const [name, coefficient] of linear.terms) {
    if (Math.abs(coefficient) > linearEpsilon) terms.set(name, coefficient)
  }
  return {
    constant: Math.abs(linear.constant) > linearEpsilon ? linear.constant : 0,
    terms,
  }
}

function isZeroLinear(linear: LinearExpr) {
  return linear.constant === 0 && linear.terms.size === 0
}

function linearConstantStatus(linear: LinearExpr, strict: boolean) {
  if (linear.terms.size > 0) return false
  return strict ? linear.constant > linearEpsilon : linear.constant >= -linearEpsilon
}

function linearKey(linear: LinearExpr) {
  const parts = [`${linear.constant}`]
  for (const [name, coefficient] of [...linear.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`${name}:${coefficient}`)
  }
  return parts.join('|')
}

function reductionScales(target: LinearExpr, fact: LinearExpr): number[] {
  const scales: number[] = []
  const names = new Set([...target.terms.keys(), ...fact.terms.keys()])
  for (const name of names) addReductionScale(scales, target.terms.get(name) ?? 0, fact.terms.get(name) ?? 0)
  addReductionScale(scales, target.constant, fact.constant)
  return scales
}

function addReductionScale(scales: number[], targetCoefficient: number, factCoefficient: number) {
  if (Math.abs(targetCoefficient) <= linearEpsilon || Math.abs(factCoefficient) <= linearEpsilon) return
  const scale = targetCoefficient / factCoefficient
  if (scale <= linearEpsilon) return
  if (!scales.some(existing => Math.abs(existing - scale) <= linearEpsilon)) scales.push(scale)
}

function positiveScaleMultiple(target: LinearExpr, fact: LinearExpr): number | null {
  let scale: number | null = null
  const names = new Set([...target.terms.keys(), ...fact.terms.keys()])
  for (const name of names) {
    const nextScale = coefficientScale(target.terms.get(name) ?? 0, fact.terms.get(name) ?? 0)
    if (nextScale === false) return null
    if (nextScale != null) scale = mergeScale(scale, nextScale)
    if (scale === Number.NEGATIVE_INFINITY) return null
  }

  const constantScale = coefficientScale(target.constant, fact.constant)
  if (constantScale === false) return null
  if (constantScale != null) scale = mergeScale(scale, constantScale)
  if (scale == null || scale === Number.NEGATIVE_INFINITY || scale <= 0) return null
  return scale
}

function coefficientScale(target: number, fact: number): number | null | false {
  if (Math.abs(fact) <= linearEpsilon) return Math.abs(target) <= linearEpsilon ? null : false
  return target / fact
}

function mergeScale(current: number | null, next: number): number {
  if (current == null) return next
  return Math.abs(current - next) <= linearEpsilon ? current : Number.NEGATIVE_INFINITY
}

function multiplyNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const products = [
    left.min * right.min,
    left.min * right.max,
    left.max * right.min,
    left.max * right.max,
  ]
  return numberValue(Math.min(...products), Math.max(...products), left.isInteger && right.isInteger, binaryExpr(left, '*', right), linearMultiply(left, right), null, mergeProvenance(left, right))
}

function divideNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 && right.max >= 0) return unknown('Division by a range containing zero is unsupported')
  const quotients = [
    left.min / right.min,
    left.min / right.max,
    left.max / right.min,
    left.max / right.max,
  ]
  return numberValue(Math.min(...quotients), Math.max(...quotients), false, binaryExpr(left, '/', right), right.min === right.max ? linearScale(left.linear, 1 / right.min) : null, null, mergeProvenance(left, right))
}

function moduloNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 || left.min < 0) return unknown('Modulo is only supported for non-negative values and positive divisors')
  const max = left.isInteger && right.isInteger ? Math.max(0, Math.ceil(right.max) - 1) : right.max
  return numberValue(0, max, left.isInteger && right.isInteger, binaryExpr(left, '%', right), null, null, mergeProvenance(left, right))
}

function runningSumNumber(start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const exactIncrement = increment.min === increment.max ? increment.min : null
  const linear = exactIncrement == null || start.linear == null || count.linear == null
    ? null
    : linearAdd(start.linear, linearScale(count.linear, exactIncrement))
  if (count.min < 0 || increment.min < 0) return numberValue(
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    false,
    start.expr != null && count.expr != null && increment.expr != null ? `runningSum(${start.expr}, ${count.expr}, ${increment.expr})` : null,
    linear,
    null,
    mergeProvenance(start, count, increment),
  )
  const deltas = [
    count.min * increment.min,
    count.min * increment.max,
    count.max * increment.min,
    count.max * increment.max,
  ]
  return numberValue(
    start.min + Math.min(...deltas),
    start.max + Math.max(...deltas),
    start.isInteger && count.isInteger && increment.isInteger,
    start.expr != null && count.expr != null && increment.expr != null ? `runningSum(${start.expr}, ${count.expr}, ${increment.expr})` : null,
    linear,
    null,
    mergeProvenance(start, count, increment),
  )
}

function conditionalRunningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const deltas = [
    0,
    count.max * increment.min,
    count.max * increment.max,
  ]
  return numberValue(
    start.min + Math.min(...deltas),
    start.max + Math.max(...deltas),
    start.isInteger && count.isInteger && increment.isInteger,
    targetName,
    linearVariable(targetName),
    null,
    mergeProvenance(start, count, increment),
  )
}

function conditionalRunningSumFacts(value: NumberValue, start: NumberValue, count: NumberValue, increment: NumberValue): LinearConstraint[] {
  const facts: LinearConstraint[] = []
  if (increment.min >= 0) {
    const lower = comparisonConstraint(value, '>=', start, `${value.expr ?? formatRange(value)} >= ${start.expr ?? formatRange(start)}`)
    if (lower != null) facts.push(lower)
  }
  if (increment.max <= 0) {
    const upper = comparisonConstraint(value, '<=', start, `${value.expr ?? formatRange(value)} <= ${start.expr ?? formatRange(start)}`)
    if (upper != null) facts.push(upper)
  }
  if (start.min === 0 && start.max === 0 && increment.min === 1 && increment.max === 1) {
    const upper = comparisonConstraint(value, '<=', count, `${value.expr ?? formatRange(value)} <= ${count.expr ?? formatRange(count)}`)
    if (upper != null) facts.push(upper)
  }
  return facts
}

function powerNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min !== right.max) return unknown('Non-constant exponent is unsupported')
  if (right.min === 2 && left.min >= 0) return numberValue(left.min ** 2, left.max ** 2, left.isInteger, binaryExpr(left, '**', right), null, null, mergeProvenance(left, right))
  if (left.min === left.max) return numberValue(left.min ** right.min, left.min ** right.min, Number.isInteger(left.min ** right.min), binaryExpr(left, '**', right), null, null, mergeProvenance(left, right))
  return unknown('Only square of non-negative ranges is supported')
}

function joinValues(left: Value, right: Value): Value {
  if (left.kind === 'unknown') return left
  if (right.kind === 'unknown') return right
  if (left.kind === 'number' && right.kind === 'number') {
    const joined = numberValue(
      Math.min(left.min, right.min),
      Math.max(left.max, right.max),
      left.isInteger && right.isInteger,
      left.expr != null && right.expr != null && left.expr === right.expr ? left.expr : null,
      left.linear != null && right.linear != null && sameLinear(left.linear, right.linear) ? left.linear : null,
      null,
      mergeProvenance(left, right),
    )
    if (left.cases == null && right.cases == null) return joined
    return withNumberCases(joined, [...numberBranches(left), ...numberBranches(right)])
  }
  if (left.kind === 'object' && right.kind === 'object') {
    const keys = new Set([...left.props.keys(), ...right.props.keys()])
    const props = new Map<string, Value>()
    for (const key of keys) {
      const leftProp = left.props.get(key)
      const rightProp = right.props.get(key)
      props.set(key, leftProp == null || rightProp == null ? unknown(`Property ${key} only exists on one branch`) : joinValues(leftProp, rightProp))
    }
    return {kind: 'object', props, expr: left.expr != null && left.expr === right.expr ? left.expr : null}
  }
  if (left.kind === 'array' && right.kind === 'array') {
    const length = joinValues(left.length, right.length)
    if (length.kind !== 'number') return unknown('Array branches had incompatible lengths')
    return {
      kind: 'array',
      length,
      elements: left.elements != null && right.elements != null && left.elements.length === right.elements.length
        ? left.elements.map((leftElement, index) => joinValues(leftElement, right.elements![index]!))
        : null,
      element: mergeElementValue(left.element, right.element),
      expr: left.expr != null && left.expr === right.expr ? left.expr : null,
      summary: sameArraySummary(left.summary, right.summary) ? left.summary : null,
    }
  }
  return unknown('Branches returned incompatible value shapes')
}

function binaryExpr(left: NumberValue, op: string, right: NumberValue) {
  if (left.expr == null || right.expr == null) return null
  return `(${left.expr} ${op} ${right.expr})`
}

function callExpr(name: string, values: NumberValue[]) {
  const parts: string[] = []
  for (const value of values) {
    if (value.expr == null) return null
    parts.push(value.expr)
  }
  return `${name}(${parts.join(', ')})`
}
