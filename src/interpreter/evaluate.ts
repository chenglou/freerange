import * as ts from 'typescript'
import {
  ambientIdentifierBound,
  ambientPropertyBound,
} from '../ambient-bounds.ts'
import type {
  Program,
} from '../check-types.ts'
import {
  bindingNames,
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from '../binding-patterns.ts'
import {
  emptyArraySummary,
  filterOrigin,
  isDefinitelyEmptyArray,
  mapOrigin,
} from '../array-summary.ts'
import {
  additionIsExact,
  addNumbers,
  arrayAsCollection,
  arrayElement,
  arrayLength,
  arraySummary,
  binaryNumberComputation,
  collectionValue,
  divideNumbers,
  freshReferenceIds,
  fixedTupleValue,
  gridOfNumber,
  integerValued,
  joinValues,
  possiblyNaN,
  literalKey,
  literalValue,
  maxArrayLength,
  mergeArraySummary,
  mergeElementValue,
  moduloNumbers,
  multiplyNumbers,
  negateNumber,
  numberWithComputation,
  nullValue,
  nullableValue,
  numberValue,
  powerNumbers,
  referenceIdsOverlap,
  subtractNumbers,
  tupleElements,
  unknown,
  unknownArray,
  unknownArrayLength,
  unknownObject,
  valueWithAssumptions,
  valueWithDefaultedUndefined,
  withCombinedNumberCaseInfo,
  withNumberCaseLoss,
  withNumberCases,
  unaryNumberComputation,
  type Assumption,
  type ArraySummary,
  type ArrayValue,
  type BranchArm,
  type LinearConstraint,
  type LiteralPrimitive,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {additionalAssumptions, assumptionMentionsRoot, linearConstraints, mergeAssumptions} from '../assumptions.ts'
import {mergeBranchArms} from '../branch-context.ts'
import {
  adjacentElementAccessFacts,
  valueWithRebasedElementPath,
} from '../indexed-facts.ts'
import {indexedElementPathValue} from '../loop-summary.ts'
import {
  linearConstant,
  linearSubtract,
  numericLiteralValue,
} from '../linear.ts'
import {
  builtinCallName,
  evaluateBuiltinCall,
} from '../builtins.ts'
import {
  functionImplementationReference,
  functionHasInstanceThisInput,
  isInlineFunction,
  type FunctionImplementationRef,
  type FunctionImplementationNode,
  type InlineFunctionNode,
} from '../function-shape.ts'
import {type FitFunction} from '../modules.ts'
import type {EvaluatedOperand, PreparedCall} from '../prepared-call.ts'
import {programFunctionEnv} from '../program-env.ts'
import {
  valueFromClassInstanceType,
  valueFromNodeType,
  valueFromProjectCallReturnType,
  valueFromTypeNode,
} from '../shapes.ts'
import {
  valueAtFunctionReturnBoundary,
  valueAtNodeTypeBoundary,
  valueAtTypeNodeBoundary,
} from '../type-boundaries.ts'
import {localizeContainerLiteralValue, localizeValue} from '../value-localize.ts'
import {mapSequenceAddition} from '../sequence-relation.ts'
import {
  childFrame,
  deriveFrame,
  frameWithActiveCall,
  frameWithProgram,
  interpreterPolicy,
  joinFrameEnvs,
  noteEffect,
  noteUnsupported,
  rootFrame,
  type InterpreterCall,
  type InterpreterClaim,
  type InterpreterFlow,
  type InterpreterFrame,
  type InterpreterHooks,
  type InterpreterLoopClaim,
  type InterpreterOutput,
  type InterpreterReturnCase,
  type InterpreterStart,
  type InterpreterState,
  type InterpreterStateCase,
  type LoopFrame,
} from './context.ts'
import {
  exactInteger,
  pathFromExpression as pathFromSourceExpression,
  readArrayIndexValue,
  readPath,
  readPropertyValue,
  replaceValueEverywhere,
  valueExpr,
  valuePathExpression,
  writePath,
  type ValuePath,
} from './value-path.ts'
import {
  compoundAssignmentOperator,
  indexedForLoopShape,
  isAssignmentOperator,
  propertyNameText,
  unwrapExpression,
  type IndexedForLoopShape,
} from './source-syntax.ts'
import {expressionRootNames} from '../source-expressions.ts'
import {
  functionEffects,
  lengthBearingConstructorNames,
  mutationRootsForProgram,
  type FunctionEffects,
} from './function-effects.ts'
import {
  classifyPlatformGlobalCall,
  classifyPlatformMethodCall,
  retainedArgumentIndexes,
  type PlatformCallbackEffect,
  type PlatformCallEffect,
} from './platform-effects.ts'
import {evaluateSymbolicLoop, type LoopAnalysisContext} from './loop-transfer.ts'
import {expressionIsRepeatable} from './expression-effects.ts'
import {
  branchFrame,
  compareNumbers,
  isComparisonOperator,
} from './refine.ts'
import {admitsNaN, comparisonConstraint, mayBeInfinite, nonNegativeConstraints, proveComparisonPlain, proveNonNegativeFromConstraints, reachableNumberCasePairs, reachableNumberCases} from '../proof.ts'
import {formatRange} from '../reporting.ts'
import {
  forgetRoot,
  rootMentionPattern,
} from './forget.ts'
import {evaluateMathCall, evaluateMathProperty} from './math.ts'
import {evaluateNumberCasePairs} from './number-cases.ts'
import {
  defaultLibraryOwner,
  elementAccessHasSourceAccessor,
  isDefaultLibraryMemberAccess,
  isDefaultLibrarySymbol,
  propertyAccessHasSourceAccessor,
  resolveCallTarget,
  type InterpreterCallTarget,
} from './call-targets.ts'
import {auditBranchCondition, auditConditionalSelector, auditNullishFallback} from './audit.ts'
import {
  blockScopedNames,
  forOfBodyScopedNames,
  forOfItemName,
  forOfScopedNames,
  restoreScopedValues,
  saveScopedValues,
} from './scope.ts'
import {
  adoptJoinedState,
  consumeStateCases,
  envWithAssumptions,
  frameForStateCase,
  hasStateCases,
  joinStateCaseEnvs,
  reachableStateCases,
  setStateCases,
  stateCaseBudget,
  stateCaseBudgetMessage,
  stateCasesFromFrame,
  summarizeOverBudgetReturnCases,
  type StateCaseSetResult,
} from './state-cases.ts'

type InterpreterValueResult = {
  value: Value
  state: InterpreterState
  output: InterpreterOutput
}

type InterpreterBodyResult = InterpreterValueResult & {
  returnCases?: InterpreterReturnCase[]
}

type InterpreterTopLevelResult = {
  state: InterpreterState
  output: InterpreterOutput
}

type InterpreterExecutionInput = InterpreterStart & {
  hooks?: InterpreterHooks
}

function freshBranchId(frame: InterpreterFrame) {
  return frame.branchIds.next++
}

function branchArm(branchId: number, arm: number): BranchArm {
  return {branchId, arm}
}

type IndexedForLoopBound = {
  length: NumberValue
  expression: ts.Expression
  origin: IndexedForLoopOrigin | null
}

type IndexedForLoopOrigin = {
  source: ArrayValue
  sourceExpr: string
}

export function evaluateInterpreterFunction(input: {
  program: Program
  functionName: string
}): InterpreterValueResult {
  const {program, functionName} = input
  const frame = interpreterFrame({
    program,
    env: programFunctionEnv(program),
    stack: [],
    assumptions: [],
  })
  const fn = program.functions.get(functionName)
  if (fn == null) {
    return {
      value: noteUnsupported(frame, `Unknown function ${functionName}`),
      state: interpreterState(frame),
      output: frame.output,
    }
  }
  const value = invokeFitFunction(fn, [], frame, program, frame.env)
  return {value, state: interpreterState(frame), output: frame.output}
}

export function evaluateInterpreterFunctionBody(input: InterpreterExecutionInput & {
  fn: FitFunction
}): InterpreterBodyResult {
  const {program, fn} = input
  const frame = interpreterFrame(input)
  bindInstanceThis(fn, program, frame.env)
  const result = evaluateFunctionNodeBodyResult(fn.name, fn.node, frame)
  return {
    value: result.value,
    state: interpreterState(frame),
    output: frame.output,
    ...(result.returnCases == null ? {} : {returnCases: result.returnCases}),
  }
}

export function evaluateInterpreterTopLevel(input: InterpreterExecutionInput): InterpreterTopLevelResult {
  const frame = interpreterFrame(input)
  evaluateStatements(topLevelExecutableStatements(input.program.sourceFile.statements), frame)
  return {state: interpreterState(frame), output: frame.output}
}

export function evaluateInterpreterTopLevelAnnotations(input: InterpreterExecutionInput): InterpreterTopLevelResult {
  const frame = interpreterFrame(input)
  for (const statement of topLevelExecutableStatements(input.program.sourceFile.statements)) {
    evaluateStatement(statement, frame)
  }
  return {state: interpreterState(frame), output: frame.output}
}

export function evaluateInterpreterExpression(input: InterpreterExecutionInput & {
  expression: ts.Expression
}): InterpreterValueResult {
  const frame = interpreterFrame(input)
  const value = evaluateExpression(input.expression, frame)
  return {value, state: interpreterState(frame), output: frame.output}
}

function interpreterFrame(input: InterpreterExecutionInput): InterpreterFrame {
  return rootFrame(input, interpreterPolicy(input.hooks))
}

function interpreterState(frame: InterpreterFrame): InterpreterState {
  return {
    env: frame.env,
    assumptions: frame.assumptions,
    branches: frame.branches,
    caseAssumptions: frame.caseAssumptions,
    changedRoots: frame.changedRoots,
    separateBranches: frame.separateBranches,
  }
}

function topLevelExecutableStatements(statements: ts.NodeArray<ts.Statement>): ts.NodeArray<ts.Statement> {
  const executable: ts.Statement[] = []
  for (const statement of statements) {
    if (topLevelDeclarationOnly(statement)) continue
    if (ts.isExportAssignment(statement)) {
      executable.push(ts.factory.createExpressionStatement(statement.expression))
      continue
    }
    executable.push(statement)
  }
  return ts.factory.createNodeArray(executable)
}

function topLevelDeclarationOnly(statement: ts.Statement) {
  return ts.isImportDeclaration(statement)
    || ts.isExportDeclaration(statement)
    || ts.isFunctionDeclaration(statement)
    || ts.isClassDeclaration(statement)
    || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || ts.isModuleDeclaration(statement)
    || ts.isEnumDeclaration(statement)
}

function invokeFitFunction(
  fn: FitFunction,
  argumentValues: (Value | undefined)[],
  caller: InterpreterFrame,
  program: Program,
  baseEnv: Map<string, Value>,
  thisValue?: Value,
): Value {
  const env = new Map(baseEnv)
  bindInstanceThis(fn, program, env, thisValue)
  const prepared = prepareFunctionNodeInvocation(
    fn.name,
    fn.node,
    argumentValues.map(value => value == null ? null : {value, sourceText: null}),
    frameWithProgram(caller, program, env, fn.name),
    'unknown',
  )
  return prepared.kind === 'invalid'
    ? noteUnsupported(caller, prepared.reason, fn.node)
    : evaluateFunctionNodeBody(fn.name, fn.node, prepared.frame)
}

function prepareFitFunctionInvocation(
  fn: FitFunction,
  arguments_: EvaluatedOperand[],
  caller: InterpreterFrame,
  program: Program,
  thisValue?: Value,
): {kind: 'valid'; frame: InterpreterFrame; prepared: PreparedCall} | {kind: 'invalid'; reason: string} {
  const env = programFunctionEnv(program)
  bindInstanceThis(fn, program, env, thisValue)
  const prepared = prepareFunctionNodeInvocation(
    fn.name,
    fn.node,
    arguments_,
    frameWithProgram(caller, program, env, fn.name),
    'invalid',
  )
  if (prepared.kind === 'invalid') return prepared
  const entryEnv = new Map(prepared.frame.env)
  const boundValues = new Map<string, Value>()
  for (const param of fn.node.parameters) {
    for (const name of bindingNames(param.name)) {
      const value = prepared.frame.env.get(name)
      if (value == null) throw new Error(`Missing final parameter binding ${name} in ${fn.name}`)
      boundValues.set(name, value)
      entryEnv.set(name, localizeValue(value, name, {preserveLinear: true}))
    }
  }
  return {
    kind: 'valid',
    frame: prepared.frame,
    prepared: {
      entryEnv,
      callSite: {
        parameterSourceTexts: prepared.parameterSourceTexts,
        boundValues,
      },
    },
  }
}

function bindInstanceThis(fn: FitFunction, program: Program, env: Map<string, Value>, thisValue?: Value) {
  if (!functionHasInstanceThisInput(fn)) return
  const fallback = classInstanceThisValue(fn, program) ?? unknownObject('this')
  const value = thisValue == null
    ? env.get('this') ?? fallback
    : valueWithTypeFallback(localizeValue(thisValue, 'this', {preserveLinear: true}), fallback)
  env.set('this', value)
}

function classInstanceThisValue(fn: FitFunction, program: Program): Value | null {
  const classNode = ts.isMethodDeclaration(fn.node)
    || ts.isConstructorDeclaration(fn.node)
    || ts.isGetAccessorDeclaration(fn.node)
    || ts.isSetAccessorDeclaration(fn.node)
    ? fn.node.parent
    : null
  if (classNode == null || !ts.isClassDeclaration(classNode)) return null
  return valueFromClassInstanceType('this', classNode, program)
}

function invokeInlineFunction(
  name: string,
  fn: InlineFunctionNode,
  argumentValues: (Value | undefined)[],
  caller: InterpreterFrame,
): Value {
  const prepared = prepareFunctionNodeInvocation(
    name,
    fn,
    argumentValues.map(value => value == null ? null : {value, sourceText: null}),
    childFrame(caller, new Map(caller.env), name),
    'unknown',
  )
  return prepared.kind === 'invalid'
    ? noteUnsupported(caller, prepared.reason, fn)
    : evaluateFunctionNodeBody(name, fn, prepared.frame)
}

function evaluateFunctionNodeBody(
  name: string,
  fn: FunctionImplementationNode,
  frame: InterpreterFrame,
): Value {
  return evaluateFunctionNodeBodyResult(name, fn, frame).value
}

function evaluateFunctionNodeBodyResult(
  name: string,
  fn: FunctionImplementationNode,
  frame: InterpreterFrame,
): {value: Value; returnCases?: InterpreterReturnCase[]} {
  if (ts.isArrowFunction(fn) && ts.isExpression(fn.body)) return {value: evaluateReturnExpression(fn.body, fn, frame)}
  if (!ts.isBlock(fn.body)) return {value: noteUnsupported(frame, `Function ${name} body is unsupported`, fn.body)}
  const flow = evaluateStatements(fn.body.statements, frame)
  if (flow.kind === 'return' || flow.kind === 'return-cases') {
    const value = completedFlowValue(flow, frame)
    return value == null
      ? {value: noteUnsupported(frame, `Function ${name} did not return`, fn.body)}
      : {
        value,
        ...(flow.kind === 'return-cases' ? {returnCases: flow.cases} : {}),
      }
  }
  return {value: noteUnsupported(frame, `Function ${name} did not return`, fn.body)}
}

type PreparedFunctionNodeInvocation =
  | {kind: 'valid'; frame: InterpreterFrame; parameterSourceTexts: (string | null)[]}
  | {kind: 'invalid'; reason: string}

function prepareFunctionNodeInvocation(
  name: string,
  fn: FunctionImplementationNode,
  arguments_: (EvaluatedOperand | null)[],
  frame: InterpreterFrame,
  missingRequired: 'invalid' | 'unknown',
): PreparedFunctionNodeInvocation {
  const parameterSourceTexts: (string | null)[] = []
  let argumentIndex = 0
  for (const param of fn.parameters) {
    if (bindingPatternHasUnsupportedParameterParts(param.name)) {
      return {kind: 'invalid', reason: `Unsupported parameter binding in ${name}: ${param.name.getText(frame.program.sourceFile)}`}
    }
    let input: EvaluatedOperand
    if (param.dotDotDotToken != null) {
      const restValues: Value[] = []
      const restSourceTexts: string[] = []
      let hasAllSourceText = true
      for (; argumentIndex < arguments_.length; argumentIndex++) {
        const argument = arguments_[argumentIndex]
        if (argument == null) continue
        restValues.push(argument.value)
        if (argument.sourceText == null) hasAllSourceText = false
        else restSourceTexts.push(argument.sourceText)
      }
      input = {
        value: restParameterValue(restValues, param.name.getText(frame.program.sourceFile)),
        sourceText: hasAllSourceText ? `[${restSourceTexts.join(', ')}]` : null,
      }
    } else {
      const argument = arguments_[argumentIndex] ?? null
      argumentIndex++
      const initialized = initializeParameterInput(argument, param, frame, missingRequired)
      if (initialized.kind === 'invalid') return initialized
      input = initialized.input
    }
    bindPattern(param.name, parameterValue(param, input.value, frame), frame)
    parameterSourceTexts.push(input.sourceText)
  }
  return {kind: 'valid', frame, parameterSourceTexts}
}

function initializeParameterInput(
  argument: EvaluatedOperand | null,
  param: ts.ParameterDeclaration,
  frame: InterpreterFrame,
  missingRequired: 'invalid' | 'unknown',
): {kind: 'valid'; input: EvaluatedOperand} | {kind: 'invalid'; reason: string} {
  if (argument == null) {
    if (param.initializer != null) {
      return {
        kind: 'valid',
        input: {
          value: evaluateExpression(param.initializer, frame),
          sourceText: param.initializer.getText(frame.program.sourceFile),
        },
      }
    }
    if (missingRequired === 'unknown') {
      return {kind: 'valid', input: {value: unknownParamPatternValue(param, frame), sourceText: null}}
    }
    if (param.questionToken != null) return {kind: 'valid', input: {value: nullValue('undefined'), sourceText: 'undefined'}}
    return {kind: 'invalid', reason: `Call omitted required parameter ${param.name.getText(frame.program.sourceFile)}`}
  }
  if (param.initializer == null) return {kind: 'valid', input: argument}
  switch (defaultUse(argument.value)) {
    case 'never':
      return {kind: 'valid', input: argument}
    case 'always':
      return {
        kind: 'valid',
        input: {
          value: evaluateExpression(param.initializer, frame),
          sourceText: param.initializer.getText(frame.program.sourceFile),
        },
      }
    case 'maybe': {
      const beforeEnv = new Map(frame.env)
      const beforeAssumptions = [...frame.assumptions]
      const defaultFrame = childFrame(frame, new Map(frame.env), '<default>')
      const fallback = evaluateExpression(param.initializer, defaultFrame)
      frame.env = joinFrameEnvs(beforeEnv, defaultFrame.env)
      frame.assumptions = beforeAssumptions
      return {
        kind: 'valid',
        input: {
          value: valueWithDefaultedUndefined(argument.value, fallback),
          sourceText: null,
        },
      }
    }
  }
}

function defaultUse(value: Value): 'never' | 'always' | 'maybe' {
  if (value.kind === 'null' && value.expr === 'undefined') return 'always'
  if (value.kind === 'nullable' && (value.absent === 'undefined' || value.absent === 'nullish')) return 'maybe'
  return 'never'
}

function restParameterValue(values: Value[], expr: string): ArrayValue {
  return fixedTupleValue(values, expr)
}

function bindingPatternHasUnsupportedParameterParts(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return false
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    if (element.dotDotDotToken != null || element.initializer != null) return true
    if (bindingPatternHasUnsupportedParameterParts(element.name)) return true
  }
  return false
}

function parameterValue(param: ts.ParameterDeclaration, value: Value, frame: InterpreterFrame): Value {
  const expr = ts.isIdentifier(param.name) ? param.name.text : param.name.getText(frame.program.sourceFile)
  return valueAtTypeNodeBoundary(value, expr, param.type, param.name, frame.program)
}

function unknownParamPatternValue(param: ts.ParameterDeclaration, frame: InterpreterFrame): Value {
  const expr = ts.isIdentifier(param.name) ? param.name.text : param.name.getText(frame.program.sourceFile)
  const shape = valueFromTypeNode(expr, param.type, frame.program) ?? valueFromNodeType(expr, param.name, frame.program)
  if (shape != null) return shape
  return unknown(`Parameter ${expr} needs a TypeScript type or an explicit @fit range`)
}

function bindPattern(name: ts.BindingName, value: Value, frame: InterpreterFrame) {
  if (ts.isIdentifier(name)) {
    frame.env.set(name.text, value)
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (element.dotDotDotToken != null) {
        noteUnsupported(frame, 'Object rest binding is unsupported', element)
        continue
      }
      const propertyName = bindingElementPropertyName(element)
      const typed = valueFromNodeType(element.name.getText(frame.program.sourceFile), element.name, frame.program)
      const prop = propertyName == null
        ? unknown(`Unsupported binding property ${element.getText(frame.program.sourceFile)}`)
        : patternPropertyValue(value, propertyName, typed)
      bindPattern(element.name, prop, frame)
    }
    return
  }
  forEachArrayBindingElement(name, (elementName, index, isRest) => {
    if (isRest) {
      noteUnsupported(frame, 'Array rest binding is unsupported', elementName)
      bindPattern(elementName, unknown('Array rest binding is unsupported'), frame)
      return
    }
    const typed = valueFromNodeType(elementName.getText(frame.program.sourceFile), elementName, frame.program)
    bindPattern(elementName, valueWithTypeFallback(readArrayIndexValue(value, index, `${valueExpr(value) ?? 'param'}[${index}]`), typed), frame)
  })
}

function evaluateStatements(statements: ts.NodeArray<ts.Statement>, frame: InterpreterFrame, startIndex = 0): InterpreterFlow {
  for (let index = startIndex; index < statements.length; index++) {
    if (hasStateCases(frame)) return evaluatePartitionedStatements(statements, frame, index)
    const statement = statements[index]!
    if (ts.isIfStatement(statement)) {
      const flow = evaluateIfStatement(statement, frame, statements, index + 1)
      if (flow.kind !== 'fallthrough') return flow
      continue
    }
    if (ts.isSwitchStatement(statement)) {
      const flow = evaluateSwitchStatement(statement, frame, statements, index + 1)
      if (flow.kind !== 'fallthrough') return flow
      continue
    }
    const flow = evaluateStatement(statement, frame)
    if (flow.kind !== 'fallthrough') return flow
  }
  return {kind: 'fallthrough'}
}

function evaluatePartitionedStatements(statements: ts.NodeArray<ts.Statement>, frame: InterpreterFrame, startIndex: number): InterpreterFlow {
  const cases = consumeStateCases(frame)
  const completedCases: InterpreterReturnCase[] = []
  const fallthroughCases: InterpreterStateCase[] = []

  for (const stateCase of cases) {
    const caseFrame = frameForStateCase(frame, stateCase)
    const flow = evaluateStatements(statements, caseFrame, startIndex)
    if (flow.kind === 'fallthrough') {
      fallthroughCases.push(...stateCasesFromFrame(caseFrame))
      continue
    }
    completedCases.push(...returnCasesFromFlow(flow, caseFrame))
  }

  const completed = returnFlowFromCases(completedCases, frame)
  if (fallthroughCases.length === 0) {
    if (completed != null && completed.kind === 'return-cases') {
      const adopted = adoptJoinedState(frame, completed.cases)
      if (adopted.kind === 'overflow') noteStateCaseBudget(frame, adopted)
    }
    return completed ?? {kind: 'exit'}
  }
  if (completed == null) {
    const applied = setStateCases(frame, fallthroughCases)
    if (applied.kind === 'overflow') noteStateCaseBudget(frame, applied)
    return {kind: 'fallthrough'}
  }
  const applied = setStateCases(frame, fallthroughCases)
  if (applied.kind === 'overflow') noteStateCaseBudget(frame, applied)
  return joinCompletedFlows(completed, {kind: 'fallthrough'}, frame)
}

function noteStateCaseBudget(frame: InterpreterFrame, overflow: Extract<StateCaseSetResult, {kind: 'overflow'}>) {
  noteUnsupported(frame, stateCaseBudgetMessage(overflow.count, overflow.limit))
}

function evaluateStatement(statement: ts.Statement, frame: InterpreterFrame): InterpreterFlow {
  if (ts.isVariableStatement(statement)) {
    evaluateVariableStatement(statement, frame)
    return {kind: 'fallthrough'}
  }
  if (ts.isReturnStatement(statement)) {
    return returnFlow(statement.expression == null ? noteUnsupported(frame, 'Empty return', statement) : evaluateReturnExpression(statement.expression, statement, frame), frame)
  }
  if (ts.isExpressionStatement(statement)) {
    evaluateExpression(statement.expression, frame)
    return {kind: 'fallthrough'}
  }
  if (ts.isForOfStatement(statement)) return evaluateForOfStatement(statement, frame)
  if (ts.isForStatement(statement)) return evaluateForStatement(statement, frame)
  if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
    return {kind: 'return', value: noteUnsupported(frame, 'While and do loops are unsupported', statement)}
  }
  if (ts.isBlock(statement)) return evaluateStatements(statement.statements, frame)
  if (ts.isIfStatement(statement)) return evaluateIfStatement(statement, frame)
  if (ts.isSwitchStatement(statement)) return evaluateSwitchStatement(statement, frame)
  if (ts.isThrowStatement(statement)) return {kind: 'exit'}
  return returnFlow(noteUnsupported(frame, `Unsupported statement in ${frame.stack.at(-1) ?? '<unknown>'}: ${statement.getText(frame.program.sourceFile)}`, statement), frame)
}

function evaluateVariableStatement(statement: ts.VariableStatement, frame: InterpreterFrame) {
  for (const declaration of statement.declarationList.declarations) evaluateVariableDeclaration(statement, declaration, frame)
}

function evaluateVariableDeclaration(statement: ts.VariableStatement, declaration: ts.VariableDeclaration, frame: InterpreterFrame) {
  const claim: InterpreterClaim = {kind: 'variable', statement, declaration}
  const value = declaration.initializer == null
    ? unknown(`Uninitialized local ${declaration.name.getText(frame.program.sourceFile)}`)
    : evaluateClaim(claim, frame, () => evaluateWithObjectPath(frame, variableObjectPath(declaration), () => evaluateExpression(declaration.initializer!, frame)))
  const boundValue = declarationValue(declaration, value, frame)
  bindPattern(declaration.name, boundValue, frame)
  afterClaim(claim, boundValue, frame)
}

function declarationValue(declaration: ts.VariableDeclaration, value: Value, frame: InterpreterFrame): Value {
  const expr = ts.isIdentifier(declaration.name) ? declaration.name.text : declaration.name.getText(frame.program.sourceFile)
  const shaped = declaration.type == null
    ? value
    : valueAtTypeNodeBoundary(value, expr, declaration.type, declaration.name, frame.program)
  if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) return shaped
  return isContainerLiteralInitializer(declaration.initializer) ? localizeContainerLiteralValue(shaped, declaration.name.text, {preserveLinear: true}) : shaped
}

function isContainerLiteralInitializer(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  return ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)
}

function variableObjectPath(declaration: ts.VariableDeclaration): string[] | undefined {
  return ts.isIdentifier(declaration.name) ? [declaration.name.text] : undefined
}

function evaluateReturnExpression(expression: ts.Expression, node: ts.Node, frame: InterpreterFrame): Value {
  const claim: InterpreterClaim = {kind: 'return', node, expression}
  const value = evaluateClaim(claim, frame, () => evaluateWithObjectPath(frame, ['return'], () => evaluateExpression(expression, frame)))
  const fn = ts.isFunctionLike(node) ? node : nearestFunctionLike(node)
  const shaped = fn == null
    ? value
    : valueAtFunctionReturnBoundary(value, 'return', fn, frame.program)
  afterClaim(claim, shaped, frame)
  return shaped
}

function returnFlow(value: Value, frame: InterpreterFrame): InterpreterFlow {
  return {
    kind: 'return-cases',
    cases: [{
      value,
      env: new Map(frame.env),
      assumptions: [...frame.assumptions],
      branches: [...frame.branches],
      caseAssumptions: [...frame.caseAssumptions],
      changedRoots: new Set(frame.changedRoots),
      separateBranches: frame.separateBranches,
    }],
  }
}

function nearestFunctionLike(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node.parent
  while (current != null) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return null
}

function evaluateClaim(claim: InterpreterClaim, frame: InterpreterFrame, evaluate: () => Value): Value {
  return frame.policy.hooks?.evaluateClaim?.(claim, frame, evaluate) ?? evaluate()
}

function afterClaim(claim: InterpreterClaim, value: Value, frame: InterpreterFrame) {
  frame.policy.hooks?.afterClaim?.(claim, value, frame)
}

function evaluateWithObjectPath<T>(frame: InterpreterFrame, path: string[] | undefined, evaluate: () => T): T {
  if (path == null) return evaluate()
  const previous = frame.objectPath
  frame.objectPath = path
  try {
    return evaluate()
  } finally {
    if (previous == null) delete frame.objectPath
    else frame.objectPath = previous
  }
}

function evaluateIfStatement(
  statement: ts.IfStatement,
  frame: InterpreterFrame,
  continuation?: ts.NodeArray<ts.Statement>,
  nextIndex = 0,
): InterpreterFlow {
  auditBranchCondition(statement.expression, auditReadFrame(frame), evaluateExpression)
  const truthValues = evaluateConditionTruthiness(statement.expression, frame, 'Branch condition')
  if (truthValues == null) return returnFlow(unknown(`Unsupported branch condition: ${nodeText(statement.expression, frame)}`), frame)
  const truth = singleBooleanValue(truthValues)
  if (truth === true) return evaluateConditionalBranch(statement.thenStatement, frame)
  if (truth === false) return statement.elseStatement == null ? {kind: 'fallthrough'} : evaluateConditionalBranch(statement.elseStatement, frame)

  const repeatable = expressionIsRepeatable(statement.expression, frame.program)
  const branchId = freshBranchId(frame)
  const thenFrame = controlFlowBranchFrame(
    frame,
    statement.expression,
    true,
    '<if-true>',
    branchArm(branchId, 0),
    repeatable,
  )
  const elseFrame = controlFlowBranchFrame(
    frame,
    statement.expression,
    false,
    '<if-false>',
    branchArm(branchId, 1),
    repeatable,
  )
  const thenEntryEnv = new Map(thenFrame.env)
  const elseEntryEnv = new Map(elseFrame.env)
  const thenFlow = evaluateConditionalBranchWithContinuation(statement.thenStatement, thenFrame, continuation, nextIndex)
  const elseFlow: InterpreterFlow = statement.elseStatement == null
    ? {kind: 'fallthrough'}
    : evaluateConditionalBranchWithContinuation(statement.elseStatement, elseFrame, continuation, nextIndex)
  if (thenFlow.kind !== 'fallthrough' && elseFlow.kind !== 'fallthrough') {
    return joinCompletedFlows(flowWithFrameContext(thenFlow, thenFrame), flowWithFrameContext(elseFlow, elseFrame), frame)
  }
  if (continuation != null) {
    if (thenFlow.kind !== 'fallthrough') {
      return joinCompletedFlows(flowWithFrameContext(thenFlow, thenFrame), flowWithFrameContext(evaluateStatements(continuation, elseFrame, nextIndex), elseFrame), frame)
    }
    if (elseFlow.kind !== 'fallthrough') {
      return joinCompletedFlows(flowWithFrameContext(evaluateStatements(continuation, thenFrame, nextIndex), thenFrame), flowWithFrameContext(elseFlow, elseFrame), frame)
    }
  }
  if (thenFlow.kind !== 'fallthrough') {
    const adopted = setStateCases(
      frame,
      closedBranchStateCases(frame, elseFrame, elseEntryEnv, '<if-false>'),
    )
    if (adopted.kind === 'overflow') noteStateCaseBudget(frame, adopted)
    return {kind: 'fallthrough'}
  }
  if (elseFlow.kind !== 'fallthrough') {
    const adopted = setStateCases(
      frame,
      closedBranchStateCases(frame, thenFrame, thenEntryEnv, '<if-true>'),
    )
    if (adopted.kind === 'overflow') noteStateCaseBudget(frame, adopted)
    return {kind: 'fallthrough'}
  }
  if (frame.loopStack.length > 0) {
    frame.env = joinStateCaseEnvs([
      ...closedBranchStateCases(frame, thenFrame, thenEntryEnv, '<if-true>'),
      ...closedBranchStateCases(frame, elseFrame, elseEntryEnv, '<if-false>'),
    ])
    return {kind: 'fallthrough'}
  }
  const applied = setStateCases(frame, [
    ...closedBranchStateCases(frame, thenFrame, thenEntryEnv, '<if-true>'),
    ...closedBranchStateCases(frame, elseFrame, elseEntryEnv, '<if-false>'),
  ])
  if (applied.kind === 'overflow') noteStateCaseBudget(frame, applied)
  return {kind: 'fallthrough'}
}

function closedBranchStateCases(
  parent: InterpreterFrame,
  branch: InterpreterFrame,
  entryEnv: Map<string, Value>,
  label: string,
): InterpreterStateCase[] {
  return stateCasesFromFrame(branch).map(stateCase => {
    const env = new Map(stateCase.env)
    const changedRoots = new Set(stateCase.changedRoots)
    for (const [name, entryValue] of entryEnv) {
      if (stateCase.env.get(name) !== entryValue) {
        changedRoots.add(name)
        continue
      }
      const parentValue = parent.env.get(name)
      if (parentValue != null) env.set(name, parentValue)
    }
    return {
      ...stateCase,
      env,
      assumptions: [...parent.assumptions],
      caseAssumptions: mergeAssumptions(
        stateCase.caseAssumptions,
        additionalAssumptions(parent.assumptions, stateCase.assumptions),
      ),
      changedRoots,
      separateBranches: stateCase.separateBranches || parent.partitioned,
      label: stateCase.label ?? label,
    }
  })
}

function controlFlowBranchFrame(
  frame: InterpreterFrame,
  condition: ts.Expression,
  truth: boolean,
  name: string,
  arm: BranchArm,
  refine: boolean,
) {
  const branch = refine
    ? branchFrame(frame, condition, truth, name, evaluateExpression)
    : childFrame(frame, new Map(frame.env), name)
  branch.caseAssumptions = mergeAssumptions(
    frame.caseAssumptions,
    additionalAssumptions(frame.assumptions, branch.assumptions),
  )
  branch.branches = mergeBranchArms(branch.branches, [arm])
  return branch
}

function joinBranchFrameEnvs(left: InterpreterFrame, right: InterpreterFrame): Map<string, Value> {
  return joinFrameEnvs(envWithAssumptions(left.env, left.assumptions), envWithAssumptions(right.env, right.assumptions))
}

function flowWithFrameContext(flow: InterpreterFlow, frame: InterpreterFrame): InterpreterFlow {
  if (flow.kind === 'return') {
    return {
      kind: 'return',
      value: valueWithAssumptions(flow.value, frame.assumptions, frame.branches),
    }
  }
  if (flow.kind === 'return-cases') {
    return {
      kind: 'return-cases',
      cases: flow.cases.map(stateCase => ({
        ...stateCase,
        value: valueWithAssumptions(
          stateCase.value,
          mergeAssumptions(stateCase.assumptions, stateCase.caseAssumptions),
          stateCase.branches,
        ),
      })),
    }
  }
  return flow
}

function joinCompletedFlows(left: InterpreterFlow, right: InterpreterFlow, frame: InterpreterFrame): InterpreterFlow {
  return returnFlowFromCases([
    ...returnCasesFromFlow(left, frame),
    ...returnCasesFromFlow(right, frame),
  ], frame) ?? {kind: 'exit'}
}

function completedFlowValue(flow: InterpreterFlow, frame: InterpreterFrame): Value | null {
  if (flow.kind === 'exit') return null
  if (flow.kind === 'return') return flow.value
  if (flow.kind === 'return-cases') return joinedReturnCaseValue(flow.cases)
  return unknown(`Function ${frame.stack.at(-1) ?? '<unknown>'} did not return`)
}

function returnCasesFromFlow(flow: InterpreterFlow, frame: InterpreterFrame): InterpreterReturnCase[] {
  if (flow.kind === 'exit') return []
  if (flow.kind === 'return') {
    return [{
      value: flow.value,
      env: new Map(frame.env),
      assumptions: [...frame.assumptions],
      branches: [...frame.branches],
      caseAssumptions: [...frame.caseAssumptions],
      changedRoots: new Set(frame.changedRoots),
      separateBranches: frame.separateBranches,
    }]
  }
  if (flow.kind === 'return-cases') return flow.cases
  return [{
    value: unknown(`Function ${frame.stack.at(-1) ?? '<unknown>'} did not return`),
    env: new Map(frame.env),
    assumptions: [...frame.assumptions],
    branches: [...frame.branches],
    caseAssumptions: [...frame.caseAssumptions],
    changedRoots: new Set(frame.changedRoots),
    separateBranches: frame.separateBranches,
  }]
}

function returnFlowFromCases(cases: InterpreterReturnCase[], frame: InterpreterFrame): InterpreterFlow | null {
  const reachable = reachableStateCases(cases)
  if (reachable.length === 0) return null
  const budget = stateCaseBudget(reachable)
  if (budget.kind === 'overflow') {
    const message = stateCaseBudgetMessage(budget.count, budget.limit)
    noteUnsupported(frame, message)
    return {kind: 'return-cases', cases: [summarizeOverBudgetReturnCases(reachable, message)]}
  }
  return {kind: 'return-cases', cases: reachable}
}

function joinedReturnCaseValue(cases: InterpreterReturnCase[]): Value | null {
  const [first, ...rest] = cases
  if (first == null) return null
  let value = valueWithAssumptions(
    first.value,
    mergeAssumptions(first.assumptions, first.caseAssumptions),
    first.branches,
  )
  for (const stateCase of rest) {
    value = joinValues(
      value,
      valueWithAssumptions(
        stateCase.value,
        mergeAssumptions(stateCase.assumptions, stateCase.caseAssumptions),
        stateCase.branches,
      ),
    )
  }
  return cases.some(stateCase => stateCase.separateBranches)
    ? valueWithSeparateBranchLoss(value)
    : value
}

function valueWithSeparateBranchLoss(value: Value): Value {
  if (value.kind === 'number') {
    return withNumberCaseLoss(value, {kind: 'separate-branches'})
  }
  if (value.kind === 'object') {
    return {
      ...value,
      props: new Map([...value.props].map(([name, prop]) => [
        name,
        valueWithSeparateBranchLoss(prop),
      ])),
    }
  }
  if (value.kind === 'array') {
    return value.layout === 'tuple'
      ? {...value, elements: value.elements.map(valueWithSeparateBranchLoss)}
      : {
        ...value,
        length: valueWithSeparateBranchLoss(value.length) as NumberValue,
        element: value.element == null ? null : valueWithSeparateBranchLoss(value.element),
      }
  }
  if (value.kind === 'nullable') {
    return {...value, present: valueWithSeparateBranchLoss(value.present)}
  }
  return value
}

function evaluateBranch(statement: ts.Statement, frame: InterpreterFrame): InterpreterFlow {
  return ts.isBlock(statement) ? evaluateStatements(statement.statements, frame) : evaluateStatement(statement, frame)
}

function evaluateConditionalBranchWithContinuation(
  statement: ts.Statement,
  frame: InterpreterFrame,
  continuation: ts.NodeArray<ts.Statement> | undefined,
  nextIndex: number,
): InterpreterFlow {
  return continuation != null && ts.isIfStatement(statement)
    ? evaluateIfStatement(statement, frame, continuation, nextIndex)
    : evaluateConditionalBranch(statement, frame)
}

function evaluateConditionalBranch(statement: ts.Statement, frame: InterpreterFrame): InterpreterFlow {
  frame.conditionalDepth++
  try {
    return evaluateBranch(statement, frame)
  } finally {
    frame.conditionalDepth--
  }
}

function evaluateSwitchStatement(
  statement: ts.SwitchStatement,
  frame: InterpreterFrame,
  continuation?: ts.NodeArray<ts.Statement>,
  nextIndex = 0,
): InterpreterFlow {
  const discriminant = evaluateExpression(statement.expression, frame)
  if (discriminant.kind !== 'literal') {
    return {kind: 'return', value: noteUnsupported(frame, `Switch expected a finite literal discriminant: ${statement.expression.getText(frame.program.sourceFile)}`, statement.expression)}
  }
  const caseValues = switchCaseLiteralValues(statement, frame)
  if ('error' in caseValues) return {kind: 'return', value: noteUnsupported(frame, caseValues.error, statement)}

  const allCaseKeys = new Set([...caseValues.values()].map(literalKey))
  const remaining = new Map(discriminant.values.map(value => [literalKey(value), value]))
  let pendingValues: LiteralPrimitive[] = []
  let joined: InterpreterFlow | null = null
  const branchId = freshBranchId(frame)
  let nextArm = 0

  for (const clause of statement.caseBlock.clauses) {
    if (ts.isCaseClause(clause)) {
      pendingValues.push(caseValues.get(clause)!)
      if (clause.statements.length === 0) continue
    }

    const branchValues = ts.isDefaultClause(clause)
      ? switchDefaultValues(remaining, pendingValues, allCaseKeys)
      : switchMatchingValues(remaining, pendingValues)
    pendingValues = []
    if (branchValues.length === 0) continue

    const branch = switchLiteralFrame(
      frame,
      statement.expression,
      branchValues,
      branchArm(branchId, nextArm++),
    )
    const flow = evaluateSwitchClauseStatements(clause.statements, branch)
    if (flow.kind === 'fallthrough') {
      return {kind: 'return', value: noteUnsupported(frame, `Switch fallthrough is not supported: ${statement.expression.getText(frame.program.sourceFile)}`, clause)}
    }
    joined = joined == null ? flow : joinCompletedFlows(joined, flow, frame)
    for (const value of branchValues) remaining.delete(literalKey(value))
  }

  if (pendingValues.length > 0) {
    return {kind: 'return', value: noteUnsupported(frame, `Switch fallthrough is not supported: ${statement.expression.getText(frame.program.sourceFile)}`, statement.caseBlock)}
  }
  if (joined == null) return {kind: 'fallthrough'}
  if (remaining.size === 0) return joined
  if (continuation == null || nextIndex >= continuation.length) {
    return {kind: 'return', value: noteUnsupported(frame, `Switch did not cover every finite literal case: ${statement.expression.getText(frame.program.sourceFile)}`, statement.expression)}
  }
  return joinCompletedFlows(
    joined,
    evaluateStatements(
      continuation,
      switchLiteralFrame(
        frame,
        statement.expression,
        [...remaining.values()],
        branchArm(branchId, nextArm),
      ),
      nextIndex,
    ),
    frame,
  )
}

function switchCaseLiteralValues(statement: ts.SwitchStatement, frame: InterpreterFrame): Map<ts.CaseClause, LiteralPrimitive> | {error: string} {
  const values = new Map<ts.CaseClause, LiteralPrimitive>()
  for (const clause of statement.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue
    const value = switchCaseLiteralValue(clause.expression)
    if (value == null) {
      return {error: `Switch case expected a finite literal: ${clause.expression.getText(frame.program.sourceFile)}`}
    }
    values.set(clause, value)
  }
  return values
}

function switchCaseLiteralValue(expression: ts.Expression): LiteralPrimitive | null {
  const current = unwrapExpression(expression)
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false
  return null
}

function switchDefaultValues(
  remaining: Map<string, LiteralPrimitive>,
  pendingValues: LiteralPrimitive[],
  allCaseKeys: Set<string>,
): LiteralPrimitive[] {
  return uniqueLiteralValues([
    ...switchMatchingValues(remaining, pendingValues),
    ...[...remaining.entries()]
      .filter(([key]) => !allCaseKeys.has(key))
      .map(([, value]) => value),
  ])
}

function switchMatchingValues(remaining: Map<string, LiteralPrimitive>, caseValues: LiteralPrimitive[]): LiteralPrimitive[] {
  const values: LiteralPrimitive[] = []
  for (const value of caseValues) {
    const remainingValue = remaining.get(literalKey(value))
    if (remainingValue != null) values.push(remainingValue)
  }
  return uniqueLiteralValues(values)
}

function uniqueLiteralValues(values: LiteralPrimitive[]): LiteralPrimitive[] {
  const seen = new Set<string>()
  const result: LiteralPrimitive[] = []
  for (const value of values) {
    const key = literalKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function switchLiteralFrame(
  frame: InterpreterFrame,
  expression: ts.Expression,
  values: LiteralPrimitive[],
  arm: BranchArm,
): InterpreterFrame {
  const branch = childFrame(frame, new Map(frame.env), '<switch>')
  branch.branches = mergeBranchArms(branch.branches, [arm])
  const path = pathFromSourceExpression(expression, indexExpression => evaluateExpression(indexExpression, branch))
  if (path == null) return branch
  const current = readPath(path, branch, expression)
  if (current.kind !== 'literal') return branch
  const keys = new Set(values.map(literalKey))
  const next = literalValue(current.values.filter(value => keys.has(literalKey(value))), current.expr, current.origin)
  if (next.kind === 'literal') writePath(path, next, branch)
  return branch
}

function evaluateSwitchClauseStatements(statements: ts.NodeArray<ts.Statement>, frame: InterpreterFrame): InterpreterFlow {
  if (statements.length === 1 && ts.isBlock(statements[0]!)) return evaluateStatements(statements[0]!.statements, frame)
  return evaluateStatements(statements, frame)
}

function evaluateForOfStatement(statement: ts.ForOfStatement, frame: InterpreterFrame): InterpreterFlow {
  const claim: InterpreterLoopClaim = {kind: 'for-of', statement, factRoots: new Set()}
  return evaluateLoop(claim, frame, () => evaluateForOfStatementCore(statement, frame, claim))
}

function evaluateLoop(claim: InterpreterLoopClaim, frame: InterpreterFrame, evaluate: () => InterpreterFlow): InterpreterFlow {
  return frame.policy.hooks?.evaluateLoop?.(claim, frame, evaluate) ?? evaluate()
}

function evaluateForOfStatementCore(statement: ts.ForOfStatement, frame: InterpreterFrame, claim: InterpreterLoopClaim): InterpreterFlow {
  if (statement.awaitModifier != null) return {kind: 'return', value: noteUnsupported(frame, 'for await is unsupported', statement)}
  const source = evaluateExpression(statement.expression, frame)
  if (source.kind !== 'array') return {kind: 'return', value: noteUnsupported(frame, `for..of expected an array source, but ${statement.expression.getText(frame.program.sourceFile)} is not proven array-valued`, statement.expression)}
  const elements = tupleElements(source)
  if (elements == null) return evaluateSymbolicForOfStatement(statement, source, frame, claim)
  const itemName = forOfItemName(statement.initializer)
  const scopedNames = [...forOfScopedNames(statement.initializer), ...forOfBodyScopedNames(statement.statement)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const sourceExpr = sourceExpression(source, statement.expression, frame)
  if (itemName != null) frame.loopStack.push({source, sourceExpr, mode: 'finite', appends: []})
  try {
    for (const element of elements) {
      bindForOfInitializer(statement.initializer, element, frame)
      const flow = evaluateBranch(statement.statement, frame)
      if (flow.kind !== 'fallthrough') return flow
    }
  } finally {
    if (itemName != null) frame.loopStack.pop()
    restoreScopedValues(frame.env, scopedValues)
  }
  return {kind: 'fallthrough'}
}

function evaluateSymbolicForOfStatement(statement: ts.ForOfStatement, source: ArrayValue, frame: InterpreterFrame, claim: InterpreterLoopClaim): InterpreterFlow {
  if (!ts.isBlock(statement.statement)) return {kind: 'return', value: noteUnsupported(frame, 'Abstract for..of supports block bodies only', statement.statement)}
  const iterationRoots = forOfScopedNames(statement.initializer)
  if (iterationRoots.length === 0) return {kind: 'return', value: noteUnsupported(frame, 'Abstract for..of supports simple variable bindings only', statement.initializer)}
  const body = statement.statement
  const scopedNames = [...iterationRoots, ...blockScopedNames(body)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const sourceExpr = sourceExpression(source, statement.expression, frame)
  const item = arrayElement(source) ?? unknown(`${sourceExpr}[] was not inferred`)
  try {
    const outcome = evaluateSymbolicLoop({
      claim,
      body,
      source,
      sourceExpr,
      sourceRoots: expressionRootNames(statement.expression, []),
      sourceKind: 'collection',
      count: arrayLength(source),
      iterationAssumptions: [],
      bindIteration: target => bindForOfInitializer(statement.initializer, item, target),
      iterationRoots,
    }, frame, loopAnalysisContext)
    if (outcome.kind === 'function-unknown') return {kind: 'return', value: outcome.value}
  } finally {
    restoreScopedValues(frame.env, scopedValues)
  }
  return {kind: 'fallthrough'}
}

const loopAnalysisContext: LoopAnalysisContext = {
  evaluateExpression: (expression, frame) => evaluateExpression(expression, frame),
  evaluateStatement: (statement, frame) => evaluateBranch(statement, frame),
  conditionTruth: (condition, frame) => {
    const truthValues = evaluateConditionTruthiness(condition, frame, 'Branch condition')
    return truthValues == null ? null : singleBooleanValue(truthValues)
  },
  refinedBranchFrame: (frame, condition, truth, name) => branchFrame(frame, condition, truth, name, evaluateExpression),
}

function evaluateForStatement(statement: ts.ForStatement, frame: InterpreterFrame): InterpreterFlow {
  const claim: InterpreterLoopClaim = {kind: 'for', statement, factRoots: new Set()}
  return evaluateLoop(claim, frame, () => evaluateForStatementCore(statement, frame, claim))
}

function evaluateForStatementCore(statement: ts.ForStatement, frame: InterpreterFrame, claim: InterpreterLoopClaim): InterpreterFlow {
  const shape = indexedForLoopShape(statement)
  if (shape == null) {
    return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loops support for (let i = 0; i < limit; i++) style loops', statement)}
  }
  if (!ts.isBlock(statement.statement)) return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loops support block bodies only', statement.statement)}
  const boundExpression = shape.source.kind === 'array' ? shape.source.lengthExpression : shape.source.expression
  if (!expressionIsRepeatable(boundExpression, frame.program)) {
    return {kind: 'return', value: noteUnsupported(frame, `Indexed loop bound has effects or unknown behavior: ${boundExpression.getText(frame.program.sourceFile)}`, boundExpression)}
  }
  const bound = evaluateIndexedForLoopBound(shape, frame)
  if ('error' in bound) return {kind: 'return', value: bound.error}
  if (!integerValued(bound.length) || bound.length.min < 0) return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loop limit expected a non-negative integer', statement.condition ?? statement)}

  const body = statement.statement
  const scopedNames = [shape.indexName, ...blockScopedNames(body)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const length = indexedLoopLength(bound.length, bound.expression, frame)
  const indexValue = indexedElementPathValue(shape.indexName, length)
  const loop = indexedForLoopContext(bound, length, frame)
  try {
    const outcome = evaluateSymbolicLoop({
      claim,
      body,
      source: loop.source,
      sourceExpr: loop.sourceExpr,
      sourceRoots: expressionRootNames(
        shape.source.kind === 'array' ? shape.source.expression : bound.expression,
        [],
      ),
      sourceKind: bound.origin == null ? 'count' : 'collection',
      count: length,
      iterationAssumptions: indexedElementAssumptions(indexValue, length),
      bindIteration: target => {
        target.env.set(shape.indexName, indexValue)
      },
      iterationRoots: [shape.indexName],
    }, frame, loopAnalysisContext)
    if (outcome.kind === 'function-unknown') return {kind: 'return', value: outcome.value}
  } finally {
    restoreScopedValues(frame.env, scopedValues)
  }
  return {kind: 'fallthrough'}
}

function indexedElementAssumptions(value: NumberValue, length: NumberValue): LinearConstraint[] {
  const lower = comparisonConstraint(value, '>=', numberValue(0, 0, 0, '0', linearConstant(0)))
  const upper = comparisonConstraint(value, '<', length)
  return [lower, upper].filter((fact): fact is LinearConstraint => fact != null)
}

function indexedForLoopContext(bound: IndexedForLoopBound, length: NumberValue, frame: InterpreterFrame): LoopFrame {
  const expr = bound.origin?.sourceExpr ?? bound.expression.getText(frame.program.sourceFile)
  const source = bound.origin == null
    ? unknownArray(expr, length)
    : {...bound.origin.source, length}
  return {source, sourceExpr: expr, mode: 'symbolic', appends: []}
}

function evaluateIndexedForLoopBound(shape: IndexedForLoopShape, frame: InterpreterFrame): IndexedForLoopBound | {error: Value} {
  if (shape.source.kind === 'limit') {
    const length = evaluateExpression(shape.source.expression, frame)
    return length.kind === 'number'
      ? {length, expression: shape.source.expression, origin: null}
      : {error: noteUnsupported(frame, 'Indexed for loop limit expected a number', shape.source.expression)}
  }

  const source = evaluateExpression(shape.source.expression, frame)
  if (source.kind !== 'array') return {error: noteUnsupported(frame, 'Indexed for loop source expected an array', shape.source.expression)}
  return {
    length: arrayLength(source),
    expression: shape.source.lengthExpression,
    origin: {source, sourceExpr: sourceExpression(source, shape.source.expression, frame)},
  }
}

function indexedLoopLength(limit: NumberValue, expression: ts.Expression, frame: InterpreterFrame): NumberValue {
  const expr = limit.expr ?? expression.getText(frame.program.sourceFile)
  const min = Math.max(0, limit.min)
  const max = Math.max(0, limit.max)
  return numberValue(min, max, 0, expr, limit.linear, null, limit.origin)
}

function bindForOfInitializer(initializer: ts.ForInitializer, value: Value, frame: InterpreterFrame) {
  if (ts.isVariableDeclarationList(initializer)) {
    const declaration = initializer.declarations[0]
    if (declaration == null || initializer.declarations.length !== 1) {
      noteUnsupported(frame, 'for..of supports one loop binding', initializer)
      return
    }
    bindPattern(declaration.name, valueAtNodeTypeBoundary(value, declaration.name.getText(frame.program.sourceFile), declaration.name, frame.program), frame)
    return
  }
  const path = pathFromExpression(initializer, frame)
  if (path == null) {
    noteUnsupported(frame, `Unsupported for..of assignment target ${initializer.getText(frame.program.sourceFile)}`, initializer)
    return
  }
  writePath(
    path,
    valueAtNodeTypeBoundary(value, initializer.getText(frame.program.sourceFile), initializer, frame.program),
    frame,
    initializer,
  )
}

function evaluateExpression(expression: ts.Expression, frame: InterpreterFrame): Value {
  if (ts.isParenthesizedExpression(expression)) return evaluateExpression(expression.expression, frame)
  if (ts.isNonNullExpression(expression)) return evaluateNonNullExpression(expression, frame)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    const original = evaluateExpression(expression.expression, frame)
    const adapted = valueAtNodeTypeBoundary(
      original,
      expression.getText(frame.program.sourceFile),
      expression,
      frame.program,
    )
    return adapted.kind === 'unknown' && adapted !== original
      ? noteUnsupported(frame, adapted.reason, expression)
      : adapted
  }

  const path = frame.policy.hooks?.evaluatePath?.(expression, frame)
  if (path != null) return path

  const numeric = numericLiteralValue(expression)
  if (numeric != null) return numberValue(numeric, numeric, gridOfNumber(numeric), nodeText(expression, frame), linearConstant(numeric))
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return literalValue([expression.text], nodeText(expression, frame))
  if (ts.isTemplateExpression(expression)) {
    for (const span of expression.templateSpans) evaluateExpression(span.expression, frame)
    return noteUnsupported(frame, `Template string ${nodeText(expression, frame)}`, expression)
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return literalValue([true], 'true')
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return literalValue([false], 'false')
  if (expression.kind === ts.SyntaxKind.NullKeyword) return nullValue('null')
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return frame.env.get('this') ?? noteUnsupported(frame, 'Unknown identifier this', expression)
  if (ts.isIdentifier(expression)) return readIdentifier(expression, frame)
  if (ts.isPropertyAccessExpression(expression)) return evaluatePropertyAccess(expression, frame)
  if (ts.isElementAccessExpression(expression)) return evaluateElementAccess(expression, frame)
  if (ts.isObjectLiteralExpression(expression)) return evaluateObjectLiteral(expression, frame)
  if (ts.isArrayLiteralExpression(expression)) return evaluateArrayLiteral(expression, frame)
  if (ts.isVoidExpression(expression)) return evaluateVoidExpression(expression, frame)
  if (ts.isPrefixUnaryExpression(expression)) return evaluatePrefixUnary(expression, frame)
  if (ts.isPostfixUnaryExpression(expression)) return evaluateIncrementDecrement(expression, frame)
  if (ts.isDeleteExpression(expression)) {
    havocRoots(frame, expressionRootNames(expression.expression, []))
    return noteUnsupported(frame, `Unsupported delete ${expression.getText(frame.program.sourceFile)}`, expression)
  }
  if (ts.isTypeOfExpression(expression)) return evaluateTypeOfExpression(expression, frame)
  if (ts.isBinaryExpression(expression)) return evaluateBinaryExpression(expression, frame)
  if (ts.isConditionalExpression(expression)) return evaluateConditionalExpression(expression, frame)
  if (ts.isCallExpression(expression)) return evaluateCallExpression(expression, frame)
  if (ts.isNewExpression(expression)) return evaluateNewExpression(expression, frame)
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return noteUnsupported(frame, 'Function value cannot be materialized yet', expression)
  // An expression form the interpreter does not read may still contain writes
  // (e.g. an assignment nested in an unsupported construct): forget every root
  // it mentions before reporting it, so no stale fact survives.
  havocRoots(frame, expressionRootNames(expression, []))
  return noteUnsupported(frame, `Unsupported expression ${expression.getText(frame.program.sourceFile)}`, expression)
}

function evaluateNonNullExpression(expression: ts.NonNullExpression, frame: InterpreterFrame): Value {
  const value = evaluateExpression(expression.expression, frame)
  if (value.kind === 'nullable') return value.present
  if (value.kind === 'null') return noteUnsupported(frame, `Non-null assertion did not prove ${expression.expression.getText(frame.program.sourceFile)} present`, expression)
  return value
}

function evaluateNewExpression(expression: ts.NewExpression, frame: InterpreterFrame): Value {
  const constructorName = newExpressionConstructorName(expression)
  if (
    constructorName != null
    && lengthBearingConstructorNames.has(constructorName)
    && isDefaultLibrarySymbol(expression.expression, frame.program)
  ) {
    return evaluateLengthBearingNewExpression(expression, constructorName, frame)
  }
  if (!ts.isIdentifier(unwrapExpression(expression.expression))) {
    evaluateExpression(expression.expression, frame)
  }
  const arguments_ = expression.arguments ?? ts.factory.createNodeArray()
  const operands = evaluateInvocationOperands(arguments_, frame)
  if (operands.kind === 'invalid') return noteUnsupported(frame, operands.reason, expression)
  expression.arguments?.forEach((argument, index) => {
    const source = ts.isSpreadElement(argument) ? argument.expression : argument
    const value = operands.arguments[index]?.value
    if (!valueCanBeMutated(value)) return
    havocExpressionAliases(frame, source)
    havocReferenceAliases(frame, valueReferenceIds(value))
  })
  return noteUnsupported(frame, `Unsupported new expression ${expression.getText(frame.program.sourceFile)}`, expression)
}

function newExpressionConstructorName(expression: ts.NewExpression): string | null {
  if (ts.isIdentifier(expression.expression)) return expression.expression.text
  return null
}

function evaluateLengthBearingNewExpression(expression: ts.NewExpression, constructorName: string, frame: InterpreterFrame): Value {
  if (expression.arguments == null || expression.arguments.length !== 1) {
    return noteUnsupported(frame, `${constructorName} constructor expected one length argument`, expression)
  }
  const length = evaluateExpression(expression.arguments[0]!, frame)
  if (length.kind !== 'number') return noteUnsupported(frame, `${constructorName} length expected a number`, expression.arguments[0])
  const expr = expression.getText(frame.program.sourceFile)
  return unknownArray(expr, length)
}

function evaluateVoidExpression(expression: ts.VoidExpression, frame: InterpreterFrame): Value {
  evaluateExpression(expression.expression, frame)
  return nullValue('undefined')
}

function readIdentifier(expression: ts.Identifier, frame: InterpreterFrame): Value {
  if (expression.text === 'undefined') return nullValue('undefined')
  if (expression.text === 'Infinity') return numberValue(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, null, 'Infinity')
  const ambient = ambientIdentifierBound(expression, frame.program)
  if (ambient != null) return ambient
  return frame.env.get(expression.text) ?? noteUnsupported(frame, `Unknown identifier ${expression.text}`, expression)
}

function evaluatePropertyAccess(expression: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  if (
    ts.isIdentifier(expression.expression)
    && expression.expression.text === 'Math'
    && isDefaultLibrarySymbol(expression.expression, frame.program)
    && isDefaultLibraryMemberAccess(expression, frame.program)
  ) {
    const value = evaluateMathProperty(expression.name.text, expression.getText(frame.program.sourceFile))
    if (value != null) return value
  }
  if (!hasQuestionDotToken(expression)) {
    const ambient = ambientPropertyBound(expression, frame.program)
    if (ambient != null) return ambient
  }
  if (propertyAccessHasSourceAccessor(expression, 'get', frame.program)) {
    evaluateExpression(expression.expression, frame)
    havocExpressionAliases(frame, expression.expression)
    return noteUnsupported(frame, `Class getter call is not analyzed: ${expression.getText(frame.program.sourceFile)}`, expression)
  }
  const target = evaluateExpression(expression.expression, frame)
  const optional = hasQuestionDotToken(expression)
  if (target.kind === 'nullable' && optional) {
    const typed = valueFromNodeType(expression.getText(frame.program.sourceFile), expression, frame.program)
    if (typed != null) return typed
    const present = readPropertyValue(target.present, expression.name.text, expression.getText(frame.program.sourceFile))
    return nullableValue(present, expression.getText(frame.program.sourceFile), 'undefined')
  }
  if (target.kind === 'null' && optional) return nullValue('undefined')
  if (target.kind === 'nullable') return noteUnsupported(frame, `Nullable value ${target.expr ?? expression.expression.getText(frame.program.sourceFile)} was not proven present`, expression.expression)
  const text = expression.getText(frame.program.sourceFile)
  const typed = valueFromNodeType(text, expression, frame.program)
  if (!canReadProperty(target, expression.name.text)) {
    if (typed != null) return typed
    return noteUnsupported(frame, `Property access expected an object path${expression.name.text === 'length' ? ' or array length' : ''}: ${expression.getText(frame.program.sourceFile)}`, expression.expression)
  }
  return valueWithTypeFallback(readPropertyValue(target, expression.name.text, text), typed)
}

function evaluateElementAccess(expression: ts.ElementAccessExpression, frame: InterpreterFrame): Value {
  if (elementAccessHasSourceAccessor(expression, 'get', frame.program)) {
    evaluateExpression(expression.expression, frame)
    if (expression.argumentExpression != null) evaluateExpression(expression.argumentExpression, frame)
    havocExpressionAliases(frame, expression.expression)
    return noteUnsupported(frame, `Class getter call is not analyzed: ${expression.getText(frame.program.sourceFile)}`, expression)
  }
  const target = evaluateExpression(expression.expression, frame)
  const optional = hasQuestionDotToken(expression)
  if (target.kind === 'nullable' && optional) {
    const present = evaluatePresentElementAccess(target.present, expression, frame)
    return nullableValue(present, expression.getText(frame.program.sourceFile), 'undefined')
  }
  if (target.kind === 'null' && optional) return nullValue('undefined')
  if (target.kind === 'nullable') return noteUnsupported(frame, `Nullable value ${target.expr ?? expression.expression.getText(frame.program.sourceFile)} was not proven present`, expression.expression)
  return evaluatePresentElementAccess(target, expression, frame)
}

function evaluatePresentElementAccess(target: Value, expression: ts.ElementAccessExpression, frame: InterpreterFrame): Value {
  if (expression.argumentExpression == null) return noteUnsupported(frame, 'Element access without an index is unsupported', expression)
  if (target.kind !== 'array' && target.kind !== 'nullable') {
    const typed = valueFromNodeType(expression.getText(frame.program.sourceFile), expression, frame.program)
    if (typed != null) return typed
    return noteUnsupported(frame, `Element access expected an array path: ${expression.expression.getText(frame.program.sourceFile)}`, expression.expression)
  }
  const targetPath = pathFromExpression(expression.expression, frame)
  if (
    currentLoop(frame) != null
    && target.kind === 'array'
    && target.layout === 'tuple'
    && targetPath != null
    && expressionMentionsArrayLength(expression.argumentExpression, targetPath.root)
  ) {
    return noteUnsupported(frame, 'Array length-derived index on local arrays inside loops is not supported', expression.argumentExpression)
  }
  const index = evaluateExpression(expression.argumentExpression, frame)
  const finiteCase = finiteArrayElementAccess(target, index, expression, frame)
  if (finiteCase != null) return finiteCase
  const exactIndex = exactInteger(index)
  if (exactIndex == null) return symbolicArrayElementAccess(target, index, expression, frame)
  const text = expression.getText(frame.program.sourceFile)
  if (
    target.kind === 'array'
    && target.layout === 'collection'
  ) {
    if (exactIndex < 0 || exactIndex >= maxArrayLength) {
      return noteUnsupported(frame, `Array index ${exactIndex} is not a JavaScript array index`, expression.argumentExpression)
    }
    const exact = numberValue(exactIndex, exactIndex, 0, String(exactIndex), linearConstant(exactIndex))
    const upper = proveComparisonPlain(exact, '<', target.length, frame.assumptions)
    if (exactIndex >= target.length.max) return nullValue('undefined')
    if (target.element == null) {
      return valueWithTypeFallback(
        unknown(`${text} was not inferred`),
        valueFromNodeType(text, expression, frame.program),
      )
    }
    const sourceName = target.expr ?? expression.expression.getText(frame.program.sourceFile)
    const element = valueWithRebasedElementPath(
      target.element,
      `${sourceName}[]`,
      text,
      `${target.referenceIds.join(',')}[${exactIndex}]`,
    )
    return upper.status === 'pass' ? element : nullableValue(element, text, 'undefined')
  }
  return valueWithTypeFallback(readArrayIndexValue(target, exactIndex, text), valueFromNodeType(text, expression, frame.program))
}

function expressionMentionsArrayLength(expression: ts.Expression | undefined, root: string): boolean {
  if (expression == null) return false
  if (
    ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'length'
    && pathFromSourceExpression(expression.expression, () => unknown('index'))?.root === root
  ) return true
  for (const child of expression.getChildren()) {
    if (ts.isExpression(child) && expressionMentionsArrayLength(child, root)) return true
  }
  return false
}

function canReadProperty(target: Value, name: string) {
  if (target.kind === 'object') return true
  if (target.kind === 'array' && name === 'length') return true
  if (target.kind === 'nullable') return canReadProperty(target.present, name)
  return false
}

function valueWithTypeFallback(value: Value, typed: Value | null): Value {
  return value.kind === 'unknown' && typed != null && unknownCanUseTypeFallback(value.reason) ? typed : value
}

function patternPropertyValue(value: Value, propertyName: string, typed: Value | null): Value {
  if (value.kind === 'object') {
    const prop = value.props.get(propertyName)
    if (prop != null) return prop
    if (typed != null && value.expr != null) return localizeValue(typed, `${value.expr}.${propertyName}`)
  }
  return valueWithTypeFallback(readPropertyValue(value, propertyName, `${valueExpr(value) ?? 'param'}.${propertyName}`), typed)
}

function unknownCanUseTypeFallback(reason: string) {
  return reason.includes(' was not inferred')
    || reason.startsWith('Property ')
    || reason.startsWith('Parameter ')
}

function symbolicArrayElementAccess(target: Value, index: Value, expression: ts.ElementAccessExpression, frame: InterpreterFrame): Value {
  if (target.kind === 'nullable') return symbolicArrayElementAccess(target.present, index, expression, frame)
  if (target.kind !== 'array') return noteUnsupported(frame, `Element access expected an array path: ${expression.expression.getText(frame.program.sourceFile)}`, expression.expression)
  if (index.kind !== 'number') return noteUnsupported(frame, `Array index ${expression.argumentExpression?.getText(frame.program.sourceFile) ?? '<missing>'} expected a number`, expression.argumentExpression ?? expression)
  const lower = proveComparisonPlain(index, '>=', numberValue(0, 0, 0, '0', linearConstant(0)), frame.assumptions)
  const length = arrayLength(target)
  const upper = proveComparisonPlain(index, '<', length, frame.assumptions)
  if (lower.status !== 'pass' || upper.status !== 'pass') {
    return noteUnsupported(frame, `Array index ${formatRange(index)} was not proven inside length ${formatRange(length)}; prove 0 <= index < length or use a finite literal index`, expression.argumentExpression ?? expression)
  }
  if (expression.argumentExpression == null) return unknown('Element access without an index is unsupported')
  const sourceName = target.expr ?? expression.expression.getText(frame.program.sourceFile)
  const indexText = expression.argumentExpression.getText(frame.program.sourceFile)
  const accessExpr = `${sourceName}[${indexText}]`
  const adjacentFacts = adjacentElementAccessFacts(target, index, sourceName, indexText, accessExpr, frame.assumptions)
  if (adjacentFacts.length > 0) frame.assumptions = mergeAssumptions(frame.assumptions, adjacentFacts)
  const targetElement = arrayElement(target)
  const element = targetElement == null
    ? valueFromNodeType(expression.getText(frame.program.sourceFile), expression, frame.program) ?? unknown(`${sourceName}[] was not inferred`)
    : valueWithRebasedElementPath(targetElement, `${sourceName}[]`, accessExpr)
  addValueRangeAssumptions(element, frame)
  return element
}

function addValueRangeAssumptions(value: Value, frame: InterpreterFrame) {
  if (value.kind === 'number') {
    const lower = Number.isFinite(value.min)
      ? comparisonConstraint(value, '>=', numberValue(value.min, value.min, gridOfNumber(value.min), String(value.min), linearConstant(value.min)), undefined, 'code')
      : null
    const upper = Number.isFinite(value.max)
      ? comparisonConstraint(value, '<=', numberValue(value.max, value.max, gridOfNumber(value.max), String(value.max), linearConstant(value.max)), undefined, 'code')
      : null
    frame.assumptions = mergeAssumptions(frame.assumptions, lower == null ? [] : [lower], upper == null ? [] : [upper])
    return
  }
  if (value.kind === 'object') {
    for (const prop of value.props.values()) addValueRangeAssumptions(prop, frame)
    return
  }
  if (value.kind === 'array') {
    addValueRangeAssumptions(arrayLength(value), frame)
    const element = arrayElement(value)
    if (element != null) addValueRangeAssumptions(element, frame)
    return
  }
  if (value.kind === 'nullable') addValueRangeAssumptions(value.present, frame)
}

function finiteArrayElementAccess(target: Value, index: Value, expression: ts.ElementAccessExpression, frame: InterpreterFrame): Value | null {
  if (target.kind === 'nullable') return finiteArrayElementAccess(target.present, index, expression, frame)
  const elements = target.kind === 'array' ? tupleElements(target) : null
  if (elements == null || index.kind !== 'number' || index.cases == null) return null
  let result: Value | null = null
  for (const branch of reachableNumberCases(index, frame.assumptions)) {
    const choice = exactInteger(branch.value)
    if (choice == null) return null
    const value = elements[choice]
    if (value == null) return noteUnsupported(frame, `Array index ${choice} was outside ${expression.expression.getText(frame.program.sourceFile)}`, expression.argumentExpression ?? expression)
    const branchValue = valueWithAssumptions(value, branch.caseAssumptions)
    result = result == null ? branchValue : joinValues(result, branchValue)
  }
  return result
}

function hasQuestionDotToken(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
  return (expression as {questionDotToken?: ts.QuestionDotToken}).questionDotToken != null
}

function evaluateObjectLiteral(expression: ts.ObjectLiteralExpression, frame: InterpreterFrame): Value {
  const props = new Map<string, Value>()
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = evaluateExpression(property.expression, frame)
      if (spread.kind === 'object') {
        for (const [name, value] of spread.props) props.set(name, value)
        continue
      }
      noteUnsupported(frame, `Object spread expected an object: ${property.getText(frame.program.sourceFile)}`, property)
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const path = objectPropertyPath(frame, property.name.text)
      const claim: InterpreterClaim = {kind: 'object-property', property, path}
      const value = evaluateClaim(claim, frame, () => readIdentifier(property.name, frame))
      props.set(property.name.text, value)
      afterClaim(claim, value, frame)
      continue
    }
    // Accessors replace plain read/write semantics for the whole object: a later
    // property write would silently bypass the setter in the model, so the
    // object as a whole is not tracked.
    if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
      return noteUnsupported(frame, `Unsupported object property ${property.getText(frame.program.sourceFile)}`, property)
    }
    if (!ts.isPropertyAssignment(property)) {
      noteUnsupported(frame, `Unsupported object property ${property.getText(frame.program.sourceFile)}`, property)
      continue
    }
    const name = propertyNameText(property.name)
    if (name == null) {
      noteUnsupported(frame, `Unsupported object property name ${property.name.getText(frame.program.sourceFile)}`, property.name)
      continue
    }
    const path = objectPropertyPath(frame, name)
    const claim: InterpreterClaim = {kind: 'object-property', property, path}
    const value = evaluateClaim(claim, frame, () => evaluateWithObjectPath(frame, path, () => evaluateExpression(property.initializer, frame)))
    props.set(name, value)
    afterClaim(claim, value, frame)
  }
  return {kind: 'object', referenceIds: freshReferenceIds(), props, expr: expression.getText(frame.program.sourceFile)}
}

function objectPropertyPath(frame: InterpreterFrame, propertyName: string): string[] {
  return [...(frame.objectPath ?? []), propertyName]
}

function evaluateArrayLiteral(expression: ts.ArrayLiteralExpression, frame: InterpreterFrame): Value {
  let length = numberValue(0, 0, 0, '0', linearConstant(0))
  let elements: Value[] | null = []
  let element: Value | null = null
  for (const item of expression.elements) {
    if (ts.isSpreadElement(item)) {
      const spread = evaluateExpression(item.expression, frame)
      if (spread.kind === 'array') {
        length = addNumbers(length, arrayLength(spread))
        const spreadElements = tupleElements(spread)
        elements = elements == null || spreadElements == null ? null : [...elements, ...spreadElements]
        const spreadElement = arrayElement(spread)
        if (spreadElement != null) element = mergeElementValue(element, spreadElement)
        continue
      }
      noteUnsupported(frame, `Array spread expected an array: ${item.getText(frame.program.sourceFile)}`, item)
      continue
    }
    const value = evaluateExpression(item, frame)
    length = addNumbers(length, numberValue(1, 1, 0, '1', linearConstant(1)))
    if (elements != null) elements.push(value)
    element = mergeElementValue(element, value)
  }
  if (elements != null) {
    length = numberValue(elements.length, elements.length, 0, String(elements.length), linearConstant(elements.length))
  }
  const expr = expression.getText(frame.program.sourceFile)
  const evaluated = elements == null
    ? collectionValue(length, element, expr)
    : fixedTupleValue(elements, expr)
  return valueAtNodeTypeBoundary(evaluated, expr, expression, frame.program)
}

function evaluatePrefixUnary(expression: ts.PrefixUnaryExpression, frame: InterpreterFrame): Value {
  if (expression.operator === ts.SyntaxKind.ExclamationToken) return evaluateLogicalNot(expression, frame)
  if (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken) {
    return evaluateIncrementDecrement(expression, frame)
  }
  const value = evaluateExpression(expression.operand, frame)
  if (value.kind !== 'number') return noteUnsupported(frame, `Unary ${expression.getText(frame.program.sourceFile)} expected a number`, expression)
  if (expression.operator === ts.SyntaxKind.PlusToken) return value
  if (expression.operator === ts.SyntaxKind.MinusToken) {
    return numberWithComputation(
      negateNumber(value, `-${value.expr ?? expression.operand.getText(frame.program.sourceFile)}`),
      unaryNumberComputation('negate', value),
    )
  }
  return noteUnsupported(frame, `Unsupported unary expression ${expression.getText(frame.program.sourceFile)}`, expression)
}

// ++x / x++ / --x / x-- are assignments: the write must land even when the old
// value is not numeric. Prefix forms evaluate to the new value, postfix to the old.
function evaluateIncrementDecrement(expression: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression, frame: InterpreterFrame): Value {
  const accessorReceiver = sourceAccessorWriteReceiver(expression.operand, frame)
  if (accessorReceiver != null) {
    evaluateAccessorReference(expression.operand, accessorReceiver, frame)
    havocExpressionAliases(frame, accessorReceiver)
    return noteUnsupported(frame, `Class setter call is not analyzed: ${expression.getText(frame.program.sourceFile)}`, expression)
  }
  const path = pathFromExpression(expression.operand, frame)
  if (path == null) {
    const value = noteUnsupported(frame, `Unsupported update target ${expression.operand.getText(frame.program.sourceFile)}`, expression)
    havocRoots(frame, expressionRootNames(expression.operand, []))
    return value
  }
  const old = readPath(path, frame, expression)
  const one = numberValue(1, 1, 0, '1', linearConstant(1))
  const next = old.kind === 'number'
    ? evaluateNumberBinary(
        expression.operator === ts.SyntaxKind.PlusPlusToken
          ? ts.SyntaxKind.PlusToken
          : ts.SyntaxKind.MinusToken,
        old,
        one,
        frame,
        expression,
      )
    : noteUnsupported(frame, `Update ${expression.getText(frame.program.sourceFile)} expected a number`, expression)
  if (assignmentHasExternalEffect(path, expression.operand, frame)) {
    noteEffect(frame, `assignment mutates ${valuePathExpression(path)}: ${expression.getText()}`, expression)
  }
  writePath(path, next, frame)
  return ts.isPrefixUnaryExpression(expression) ? next : old
}

function evaluateTypeOfExpression(expression: ts.TypeOfExpression, frame: InterpreterFrame): Value {
  return literalValue(typeOfValues(evaluateExpression(expression.expression, frame)), expression.getText(frame.program.sourceFile))
}

function typeOfValues(value: Value): string[] {
  if (value.kind === 'number') return ['number']
  if (value.kind === 'literal') return value.values.map(item => typeof item)
  if (value.kind === 'null') return [value.expr === 'undefined' ? 'undefined' : 'object']
  if (value.kind === 'nullable') return [...typeOfValues(value.present), ...absentTypeOfValues(value.absent)]
  if (value.kind === 'unknown') return ['number', 'string', 'boolean', 'object', 'undefined']
  return ['object']
}

function absentTypeOfValues(absent: 'null' | 'undefined' | 'nullish'): string[] {
  if (absent === 'null') return ['object']
  if (absent === 'undefined') return ['undefined']
  return ['object', 'undefined']
}

function evaluateBinaryExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  if (isAssignmentOperator(expression.operatorToken.kind)) return evaluateAssignmentExpression(expression, frame)
  if (isComparisonOperator(expression.operatorToken.kind)) return evaluateComparisonExpression(expression, frame)
  if (isLogicalOperator(expression.operatorToken.kind)) return evaluateLogicalExpression(expression, frame)
  if (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return evaluateNullishCoalescing(expression, frame)
  const left = evaluateExpression(expression.left, frame)
  const right = evaluateExpression(expression.right, frame)
  if (left.kind !== 'number' || right.kind !== 'number') {
    return noteUnsupported(frame, `Binary expression ${expression.getText(frame.program.sourceFile)} expected numbers`, expression)
  }
  return evaluateNumberBinary(expression.operatorToken.kind, left, right, frame, expression)
}

function evaluateLogicalNot(expression: ts.PrefixUnaryExpression, frame: InterpreterFrame): Value {
  const values = truthinessValues(evaluateExpression(expression.operand, frame))
  if (values == null) return noteUnsupported(frame, `Logical expression ${expression.getText(frame.program.sourceFile)} expected a boolean-like value`, expression)
  return literalValue(uniqueBooleanValues(values.map(value => !value)), expression.getText(frame.program.sourceFile))
}

function evaluateLogicalExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const left = evaluateExpression(expression.left, frame)
  const leftValues = truthinessValues(left)
  if (leftValues == null) return noteUnsupported(frame, `Logical expression ${expression.getText(frame.program.sourceFile)} expected boolean-like values`, expression)
  const truth = singleBooleanValue(leftValues)
  const and = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  if (truth != null) {
    if ((and && !truth) || (!and && truth)) return left
    return evaluateExpression(expression.right, frame)
  }
  const skippedEnv = new Map(frame.env)
  const rightFrame = childFrame(frame, new Map(frame.env), '<logical-right>')
  const right = evaluateExpression(expression.right, rightFrame)
  if (!expressionIsRepeatable(expression.right, frame.program)) {
    frame.env = joinFrameEnvs(skippedEnv, rightFrame.env)
  }
  return joinValues(left, valueWithAssumptions(right, rightFrame.assumptions))
}

function isLogicalOperator(kind: ts.SyntaxKind) {
  return kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken
}

function truthinessValues(value: Value): boolean[] | null {
  if (value.kind === 'literal') return uniqueBooleanValues(value.values.map(Boolean))
  if (value.kind === 'null') return [false]
  if (value.kind === 'number') {
    if (value.min > 0 || value.max < 0) return [true]
    if (value.min === 0 && value.max === 0) return [false]
    return [true, false]
  }
  return null
}

function evaluateConditionTruthiness(expression: ts.Expression, frame: InterpreterFrame, label: string): boolean[] | null {
  const issueCount = frame.output.issues.length
  const values = truthinessValues(evaluateExpression(expression, frame))
  if (values != null) return values
  if (frame.output.issues.length === issueCount) noteUnsupported(frame, `${label} ${nodeText(expression, frame)} expected boolean-like values`, expression)
  return null
}

function singleBooleanValue(values: boolean[]): boolean | null {
  return values.length === 1 ? values[0]! : null
}

function uniqueBooleanValues(values: boolean[]) {
  return [...new Set(values)]
}

function evaluateNullishCoalescing(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const left = evaluateExpression(expression.left, frame)
  if (left.kind === 'nullable') {
    const skippedEnv = new Map(frame.env)
    const rightFrame = childFrame(frame, new Map(frame.env), '<nullish-right>')
    const right = evaluateExpression(expression.right, rightFrame)
    if (!expressionIsRepeatable(expression.right, frame.program)) {
      frame.env = joinFrameEnvs(skippedEnv, rightFrame.env)
    }
    return joinValues(left.present, valueWithAssumptions(right, rightFrame.assumptions))
  }
  if (left.kind === 'null') return evaluateExpression(expression.right, frame)
  auditNullishFallback(expression, left, frame)
  return left
}

function evaluateNumberBinary(
  kind: ts.SyntaxKind,
  left: NumberValue,
  right: NumberValue,
  frame: InterpreterFrame,
  expression: ts.Expression,
): Value {
  const cases = evaluateNumberCasePairs(
    left,
    right,
    frame.assumptions,
    (leftCase, rightCase, assumptions) => {
      const caseFrame = deriveFrame(frame, {
        env: frame.env,
        stateCases: null,
        assumptions,
      })
      const value = evaluatePlainNumberBinary(kind, leftCase, rightCase, caseFrame, expression)
      return valueWithAssumptions(
        value,
        additionalAssumptions(assumptions, caseFrame.assumptions),
      )
    },
  )
  if (cases != null) {
    return cases.kind === 'number'
      ? withCombinedNumberCaseInfo(cases, left, right)
      : cases
  }
  const result = evaluatePlainNumberBinary(kind, left, right, frame, expression)
  return result.kind === 'number'
    ? withCombinedNumberCaseInfo(result, left, right)
    : result
}

function computedBinary(
  op: '+' | '-' | '*' | '/' | '%' | '**',
  value: NumberValue,
  left: NumberValue,
  right: NumberValue,
): NumberValue {
  return numberWithComputation(value, binaryNumberComputation(op, left, right))
}

function computedBinaryValue(
  op: '+' | '-' | '*' | '/' | '%' | '**',
  value: Value,
  left: NumberValue,
  right: NumberValue,
): Value {
  return value.kind === 'number' ? computedBinary(op, value, left, right) : value
}

function evaluatePlainNumberBinary(
  kind: ts.SyntaxKind,
  left: NumberValue,
  right: NumberValue,
  frame: InterpreterFrame,
  expression: ts.Expression,
): Value {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: {
      const result = computedBinary('+', addNumbers(left, right), left, right)
      publishRoundedMonotoneFacts(result, '+', left, right, frame)
      return result
    }
    case ts.SyntaxKind.MinusToken: {
      const result = computedBinary('-', subtractNumbers(left, right), left, right)
      publishRoundedMonotoneFacts(result, '-', left, right, frame)
      return result
    }
    case ts.SyntaxKind.AsteriskToken:
      return computedBinary('*', multiplyNumbers(left, right), left, right)
    case ts.SyntaxKind.SlashToken:
      return computedBinaryValue('/', divideNumbers(left, right), left, right)
    case ts.SyntaxKind.PercentToken: {
      const result = computedBinaryValue('%', moduloNumbers(left, right), left, right)
      if (result.kind === 'number' && !possiblyNaN(result) && result.linear != null && right.linear != null) {
        const upper = comparisonConstraint(result, '<', right, `${result.expr} < ${right.expr}`)
        if (upper != null) frame.assumptions = mergeAssumptions(frame.assumptions, [upper])
      }
      return result
    }
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return computedBinaryValue('**', powerNumbers(left, right), left, right)
    default:
      return noteUnsupported(frame, `Unsupported numeric operator ${expression.getText(frame.program.sourceFile)}`, expression)
  }
}

// A rounded sum or difference still compares against its own operands:
// rounding is monotone and each operand is a double, so fl(x + d) >= x
// whenever d >= 0. Published eagerly so later goals can chain through the
// result, e.g. `container >= containee + padding` reaching
// `container >= containee` needs the recorded edge. Exact results skip this:
// their algebraic form already subsumes it.
function publishRoundedMonotoneFacts(result: Value, op: '+' | '-', left: NumberValue, right: NumberValue, frame: InterpreterFrame) {
  if (result.kind !== 'number' || result.linear == null || result.expr == null) return
  // A NaN result fails the comparison the fact asserts: NaN operands, or the
  // mixed infinities the op itself can collapse (Infinity - Infinity).
  if (admitsNaN(left, frame.assumptions) || admitsNaN(right, frame.assumptions)) return
  const positiveClash = mayBeInfinite(left, op === '-' ? 'positive' : 'positive', frame.assumptions)
    && mayBeInfinite(right, op === '-' ? 'positive' : 'negative', frame.assumptions)
  const negativeClash = mayBeInfinite(left, 'negative', frame.assumptions)
    && mayBeInfinite(right, op === '-' ? 'negative' : 'positive', frame.assumptions)
  if (positiveClash || negativeClash) return
  if (additionIsExact(left, right)) return
  const facts: LinearConstraint[] = []
  const push = (fact: LinearConstraint | null) => {
    if (fact != null) facts.push(fact)
  }
  if (op === '+') {
    // The >= pair carries the corpus's sign chains; the <= mirror images are
    // goal-time recoverable and not worth growing every Farkas call for.
    if (right.min >= 0) push(comparisonConstraint(result, '>=', left, `${result.expr} >= ${left.expr ?? '?'}`))
    if (left.min >= 0) push(comparisonConstraint(result, '>=', right, `${result.expr} >= ${right.expr ?? '?'}`))
  } else {
    if (right.min >= 0) push(comparisonConstraint(result, '<=', left, `${result.expr} <= ${left.expr ?? '?'}`))
    if (right.max <= 0) push(comparisonConstraint(result, '>=', left, `${result.expr} >= ${left.expr ?? '?'}`))
    // The difference's sign: a >= b makes the real difference nonnegative,
    // and rounding cannot cross zero (fl(0) is 0 and rounding is monotone).
    // One direct Farkas query keeps this cheap on the hot path.
    if (result.min < 0 && signFromFacts(left, right, frame.assumptions)) {
      const zero = numberValue(0, 0, 0, '0', linearConstant(0))
      push(comparisonConstraint(result, '>=', zero, `${result.expr} >= 0`))
    }
  }
  if (facts.length > 0) frame.assumptions = mergeAssumptions(frame.assumptions, facts)
}

function signFromFacts(left: NumberValue, right: NumberValue, assumptions: Assumption[]): boolean {
  if (left.min >= right.max) return true
  const diff = linearSubtract(left.linear, right.linear)
  if (diff == null) return false
  return proveNonNegativeFromConstraints(diff, false, linearConstraints(assumptions).flatMap(nonNegativeConstraints))
}

function evaluateAssignmentExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const accessorReceiver = sourceAccessorWriteReceiver(expression.left, frame)
  if (accessorReceiver != null) {
    evaluateAccessorReference(expression.left, accessorReceiver, frame)
    const right = evaluateExpression(expression.right, frame)
    havocExpressionAliases(frame, accessorReceiver)
    havocReferenceAliases(frame, valueReferenceIds(right))
    return noteUnsupported(frame, `Class setter call is not analyzed: ${expression.getText(frame.program.sourceFile)}`, expression)
  }
  const path = pathFromExpression(expression.left, frame)
  if (path == null) {
    const value = noteUnsupported(frame, `Unsupported assignment target ${expression.left.getText(frame.program.sourceFile)}`, expression.left)
    evaluateExpression(expression.right, frame)
    havocRoots(frame, expressionRootNames(expression.left, []))
    return value
  }
  const right = evaluateExpression(expression.right, frame)
  const assigned = assignedValue(expression.operatorToken.kind, path, right, frame, expression)
  const value = valueAtNodeTypeBoundary(
    assigned,
    expression.left.getText(frame.program.sourceFile),
    expression.left,
    frame.program,
  )
  const unsupportedWrite = unsupportedArrayWrite(path, frame)
  if (unsupportedWrite != null) {
    const result = noteUnsupported(frame, unsupportedWrite.reason, expression.left)
    havocReferenceAliases(frame, valueReferenceIds(unsupportedWrite.container))
    havocRoots(frame, expressionRootNames(expression.left, []))
    return result
  }
  if (assignmentHasExternalEffect(path, expression.left, frame)) {
    noteEffect(frame, `assignment mutates ${valuePathExpression(path)}: ${expression.getText()}`, expression)
  }
  writePath(path, value, frame)
  return value
}

function unsupportedArrayWrite(
  path: ValuePath,
  frame: InterpreterFrame,
): {reason: string; container: ArrayValue} | null {
  let current = frame.env.get(path.root)
  const prefix: ValuePath = {root: path.root, segments: []}
  for (const segment of path.segments) {
    if (current == null || current.kind === 'unknown') return null
    if (segment.kind === 'prop') {
      current = readPropertyValue(current, segment.name, valuePathExpression({...prefix, segments: [...prefix.segments, segment]}))
      prefix.segments.push(segment)
      continue
    }
    if (current.kind !== 'array') return null
    const indexedPath = {...prefix, segments: [...prefix.segments, segment]}
    if (segment.index < 0 || segment.index >= maxArrayLength) {
      return {
        reason: `Array index ${segment.index} is not a JavaScript array index`,
        container: current,
      }
    }
    if (current.layout === 'collection') {
      return {
        reason: `Indexed writes to collections are unsupported: ${valuePathExpression(indexedPath)}`,
        container: current,
      }
    }
    if (segment.index >= current.elements.length) {
      return {
        reason: `Fixed tuple ${valuePathExpression(prefix)} has no element at index ${segment.index}`,
        container: current,
      }
    }
    current = current.elements[segment.index]
    prefix.segments.push(segment)
  }
  return null
}

function sourceAccessorWriteReceiver(expression: ts.Expression, frame: InterpreterFrame): ts.Expression | null {
  const current = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(current) && propertyAccessHasSourceAccessor(current, 'set', frame.program)) {
    return current.expression
  }
  if (ts.isElementAccessExpression(current) && elementAccessHasSourceAccessor(current, 'set', frame.program)) {
    return current.expression
  }
  return null
}

function evaluateAccessorReference(expression: ts.Expression, receiver: ts.Expression, frame: InterpreterFrame) {
  evaluateExpression(receiver, frame)
  const current = unwrapExpression(expression)
  if (ts.isElementAccessExpression(current) && current.argumentExpression != null) {
    evaluateExpression(current.argumentExpression, frame)
  }
}

function assignedValue(kind: ts.SyntaxKind, path: ValuePath, right: Value, frame: InterpreterFrame, expression: ts.BinaryExpression): Value {
  if (kind === ts.SyntaxKind.EqualsToken) return right
  if (kind === ts.SyntaxKind.PlusEqualsToken) return evaluateCompoundPlus(path, right, frame, expression)
  const operator = compoundAssignmentOperator(kind)
  if (operator == null) return noteUnsupported(frame, `Unsupported assignment operator ${expression.getText(frame.program.sourceFile)}`, expression)
  const left = readPath(path, frame, expression)
  if (operator === 'conditional') return joinValues(left, right)
  if (left.kind !== 'number' || right.kind !== 'number') {
    return noteUnsupported(frame, `Compound assignment ${expression.getText(frame.program.sourceFile)} expected numbers`, expression)
  }
  return evaluateNumberBinary(operator, left, right, frame, expression)
}

// Writes through targets the interpreter cannot resolve must still land somewhere:
// forget every root the target expression mentions, so no stale value survives a
// write we could not model. Roots not bound in this frame have no facts to forget.
function havocRoots(frame: InterpreterFrame, names: string[]) {
  for (const name of new Set(names)) {
    if (!frame.env.has(name)) continue
    forgetRoot(frame.env, name)
    forgetRootAssumptions(frame, name)
  }
}

function valueReferenceIds(value: Value | null | undefined): readonly number[] {
  if (value == null) return []
  if (value.kind === 'object' || value.kind === 'array') return value.referenceIds
  if (value.kind === 'nullable') return valueReferenceIds(value.present)
  return []
}

function valueContainsReferenceIds(value: Value, referenceIds: readonly number[]): boolean {
  if ((value.kind === 'object' || value.kind === 'array') && referenceIdsOverlap(value.referenceIds, referenceIds)) return true
  if (value.kind === 'object') {
    for (const prop of value.props.values()) if (valueContainsReferenceIds(prop, referenceIds)) return true
  }
  if (value.kind === 'array') {
    if (value.layout === 'tuple') {
      for (const element of value.elements) if (valueContainsReferenceIds(element, referenceIds)) return true
    } else if (value.element != null && valueContainsReferenceIds(value.element, referenceIds)) return true
  }
  return value.kind === 'nullable' && valueContainsReferenceIds(value.present, referenceIds)
}

function havocReferenceAliases(frame: InterpreterFrame, referenceIds: readonly number[]) {
  if (referenceIds.length === 0) return
  const roots: string[] = []
  for (const [root, value] of frame.env) {
    if (valueContainsReferenceIds(value, referenceIds)) roots.push(root)
  }
  havocRoots(frame, roots)
}

function valueForAliasExpression(expression: ts.Expression, frame: InterpreterFrame): Value | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return frame.env.get(current.text) ?? null
  if (current.kind === ts.SyntaxKind.ThisKeyword) return frame.env.get('this') ?? null
  if (ts.isPropertyAccessExpression(current)) {
    const receiver = valueForAliasExpression(current.expression, frame)
    return receiver == null ? null : readPropertyValue(receiver, current.name.text, current.getText(frame.program.sourceFile))
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression != null) {
    const receiver = valueForAliasExpression(current.expression, frame)
    if (receiver == null) return null
    const index = numericLiteralValue(current.argumentExpression)
    if (index != null && Number.isInteger(index)) {
      return readArrayIndexValue(receiver, index, current.getText(frame.program.sourceFile))
    }
    if (receiver.kind === 'array') return arrayElement(receiver)
  }
  return null
}

function havocExpressionAliases(frame: InterpreterFrame, expression: ts.Expression) {
  const value = valueForAliasExpression(expression, frame)
  havocRoots(frame, expressionRootNames(expression, []))
  havocReferenceAliases(frame, valueReferenceIds(value))
}

function havocArrayElementAliases(frame: InterpreterFrame, expression: ts.Expression) {
  const referenceIds = arrayElementReferenceIds(frame, expression)
  havocRoots(frame, expressionRootNames(expression, []))
  havocReferenceAliases(frame, referenceIds)
}

function arrayElementReferenceIds(frame: InterpreterFrame, expression: ts.Expression): readonly number[] {
  const value = valueForAliasExpression(expression, frame)
  const array = value?.kind === 'array' ? value : null
  const referenceIds: number[] = []
  for (const referenceId of valueReferenceIds(array == null ? null : arrayElement(array))) {
    if (!referenceIds.includes(referenceId)) referenceIds.push(referenceId)
  }
  return referenceIds
}

// A given precondition (`given input.width: 0..10`) is recorded as a standing
// linear assumption keyed by its path text. That assumption is only true at
// entry, not after the body mutates the path, so forgetting the env value is
// not enough — the assumption must be dropped too, or a re-read of the path
// gets re-narrowed back into range. Drop every assumption naming the root.
function forgetRootAssumptions(frame: InterpreterFrame, root: string) {
  if (frame.assumptions.length === 0) return
  const mentionsRoot = rootMentionPattern(root)
  const kept = frame.assumptions.filter(constraint => !assumptionMentionsRoot(constraint, mentionsRoot))
  if (kept.length !== frame.assumptions.length) frame.assumptions = kept
}

// Callee bodies evaluate in their own environment; what they change in the
// caller's world arrives through their effect summary: forget the receiver
// when the callee writes through this, forget each argument the callee mutates
// or retains, and forget the same-module roots it writes.
function applyFunctionCallEffects(
  effects: FunctionEffects,
  argumentExpressions: readonly ts.Expression[],
  parameters: readonly ts.ParameterDeclaration[],
  receiverExpression: ts.Expression | null,
  frame: InterpreterFrame,
) {
  const certain = effects.mutations.certain
  const uncertain = effects.mutations.uncertain
  if (certain.thisValue || uncertain.thisValue) {
    if (receiverExpression != null) havocExpressionAliases(frame, receiverExpression)
    else havocRoots(frame, ['this'])
  }
  const hasSpread = argumentExpressions.some(argument => ts.isSpreadElement(argument))
  for (const index of new Set([...certain.paramIndexes, ...uncertain.paramIndexes])) {
    const rest = parameters[index]?.dotDotDotToken != null
    const targets = hasSpread
      ? argumentExpressions
      : rest
        ? argumentExpressions.slice(index)
        : argumentExpressions[index] == null ? [] : [argumentExpressions[index]]
    for (const argument of targets) {
      havocExpressionAliases(frame, ts.isSpreadElement(argument) ? argument.expression : argument)
    }
  }
  const certainOuterRoots = mutationRootsForProgram(certain, frame.program)
  const uncertainOuterRoots = mutationRootsForProgram(uncertain, frame.program)
  havocRoots(frame, [...new Set([...certainOuterRoots, ...uncertainOuterRoots])])
}

// Inline callbacks run per element on a copy of the caller's environment, so
// reads stay precise; writes to captured locals and mutations of the elements
// fed through the callback's parameters are applied here instead.
function applyCallbackEffects(
  callback: FunctionImplementationRef,
  receiverExpression: ts.Expression | null,
  thisExpression: ts.Expression | null,
  frame: InterpreterFrame,
  elementParamIndexes: readonly number[] = [0],
  receiverParamIndexes: readonly number[] = [2],
): FunctionEffects {
  const effects = functionEffects(callback)
  applyFunctionCallEffects(effects, [], callback.node.parameters, thisExpression, frame)
  const mutated = new Set([
    ...effects.mutations.certain.paramIndexes,
    ...effects.mutations.uncertain.paramIndexes,
  ])
  if (receiverExpression != null) {
    if (elementParamIndexes.some(index => mutated.has(index))) havocArrayElementAliases(frame, receiverExpression)
    if (receiverParamIndexes.some(index => mutated.has(index))) havocExpressionAliases(frame, receiverExpression)
  }
  return effects
}

// The array value read before the callback ran: its length is still exact
// (element mutation cannot change it), but element facts belong to the first
// iteration only once the callback mutates its parameters.
function sourceAfterCallback(
  source: ArrayValue,
  effects: FunctionEffects,
  callback: PlatformCallbackEffect,
): ArrayValue {
  const mutated = new Set([
    ...effects.mutations.certain.paramIndexes,
    ...effects.mutations.uncertain.paramIndexes,
  ])
  const mutatesSource = callback.parameterSources.some((sources, index) =>
    mutated.has(index) && sources.some(source => source.kind === 'receiver'))
  if (mutatesSource) return unknownArray(source.expr ?? 'callback source')
  const mutatesElement = callback.parameterSources.some((sources, index) =>
    mutated.has(index) && sources.some(source => source.kind === 'receiver-elements'))
  if (!mutatesElement) return source
  return collectionValue(arrayLength(source), null, source.expr, source.referenceIds)
}

function valueCanBeMutated(value: Value | undefined): boolean {
  if (value == null) return true
  if (value.kind === 'object' || value.kind === 'array' || value.kind === 'unknown') return true
  if (value.kind === 'nullable') return valueCanBeMutated(value.present)
  return false
}

// A call to something the interpreter cannot see may write through or retain
// any reference handed to it: the receiver, every mutable argument, and
// whatever a passed callback touches. Numbers, strings, and booleans carry no
// reference back, so their roots keep their facts.
function applyUnknownCallEffects(
  expression: ts.CallExpression,
  target: ts.Expression,
  argumentValues: (Value | undefined)[],
  receiverValue: Value | null,
  frame: InterpreterFrame,
) {
  const receiverElementReferenceIds = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
    ? arrayElementReferenceIds(frame, target.expression)
    : []
  const havocAllInputs = () => {
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      havocExpressionAliases(frame, target.expression)
      havocReferenceAliases(frame, valueReferenceIds(receiverValue))
    }
    expression.arguments.forEach((argument, index) => {
      const argumentExpression = ts.isSpreadElement(argument) ? argument.expression : argument
      if (isInlineFunction(unwrapExpression(argumentExpression))) return
      if (valueCanBeMutated(argumentValues[index])) {
        havocExpressionAliases(frame, argumentExpression)
        havocReferenceAliases(frame, valueReferenceIds(argumentValues[index]))
      }
    })
  }
  havocAllInputs()
  for (const argument of expression.arguments) {
    const argumentExpression = unwrapExpression(ts.isSpreadElement(argument) ? argument.expression : argument)
    const callback = passedFunctionReference(argumentExpression, frame)
    if (callback == null) continue
    const callbackEffects = functionEffects(callback)
    applyFunctionCallEffects(callbackEffects, [], callback.node.parameters, null, frame)
    if (callbackEffects.mutations.certain.paramIndexes.size > 0 || callbackEffects.mutations.uncertain.paramIndexes.size > 0) {
      havocAllInputs()
      // The callback mutates the elements it runs over; forget the bindings that
      // alias the receiver's held objects too (e.g. arr.forEach mutating box in
      // `const arr = [box]`).
      havocReferenceAliases(frame, receiverElementReferenceIds)
    }
  }
}

function passedFunctionReference(expression: ts.Expression, frame: InterpreterFrame): FunctionImplementationRef | null {
  if (isInlineFunction(expression)) return functionImplementationReference(frame.program, expression)
  if (!ts.isIdentifier(expression)) return null
  const resolved = resolveCallTarget(expression, frame.program)
  return resolved.kind === 'function'
    ? functionImplementationReference(resolved.program, resolved.fn.node)
    : null
}

function userBindingForCallTarget(target: ts.Expression, frame: InterpreterFrame): boolean {
  if (!ts.isIdentifier(target)) return false
  if (frame.env.has(target.text)) return true
  return resolveCallTarget(target, frame.program).kind === 'function'
}

function assignmentHasExternalEffect(path: ValuePath, target: ts.Expression, frame: InterpreterFrame) {
  if (path.segments.length > 0) return true
  const current = unwrapExpression(target)
  if (!ts.isIdentifier(current)) return true
  const checker = frame.program.typeChecker
  if (checker == null) return true
  let symbol = checker.getSymbolAtLocation(current)
  if (symbol == null) return true
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration == null) return true
  for (let owner = declaration.parent; owner != null && !ts.isSourceFile(owner); owner = owner.parent) {
    if (ts.isFunctionLike(owner)) return false
  }
  return true
}

function evaluateCompoundPlus(path: ValuePath, right: Value, frame: InterpreterFrame, expression: ts.Expression): Value {
  const left = readPath(path, frame, expression)
  if (left.kind !== 'number' || right.kind !== 'number') return stringishCompoundPlus(left, right, expression) ?? noteUnsupported(frame, `Compound assignment ${expression.getText(frame.program.sourceFile)} expected numbers`, expression)
  return evaluateNumberBinary(ts.SyntaxKind.PlusToken, left, right, frame, expression)
}

function stringishCompoundPlus(left: Value, right: Value, expression: ts.Expression): Value | null {
  return valueCanBeString(left) || valueCanBeString(right) ? unknown(`Stringish assignment changed ${expression.getText()}`) : null
}

function valueCanBeString(value: Value): boolean {
  return value.kind === 'literal' && value.values.some(item => typeof item === 'string')
}

function evaluateComparisonExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const left = evaluateExpression(expression.left, frame)
  const right = evaluateExpression(expression.right, frame)
  if (left.kind === 'number' && right.kind === 'number' && left.min === left.max && right.min === right.max) {
    return literalValue([compareNumbers(left.min, expression.operatorToken.kind, right.min)], expression.getText(frame.program.sourceFile))
  }
  if (left.kind === 'number' && right.kind === 'number') {
    const proved = provedNumberComparison(left, right, expression.operatorToken.kind, frame)
    if (proved != null) return literalValue([proved], expression.getText(frame.program.sourceFile))
  }
  if (left.kind === 'literal' && right.kind === 'literal' && isEqualityComparison(expression.operatorToken.kind)) {
    return literalValue(compareLiteralSets(left.values, right.values, expression.operatorToken.kind), expression.getText(frame.program.sourceFile))
  }
  return literalValue([true, false], expression.getText(frame.program.sourceFile))
}

function provedNumberComparison(left: NumberValue, right: NumberValue, kind: ts.SyntaxKind, frame: InterpreterFrame): boolean | null {
  const op = comparisonOperatorFromKind(kind)
  if (op == null) return null
  let result: boolean | null = null
  for (const pair of reachableNumberCasePairs(left, right, frame.assumptions)) {
    const proof = proveComparisonPlain(pair.left, op.op, pair.right, pair.assumptions)
    if (proof.status === 'unknown') return null
    const current = op.negated ? proof.status === 'fail' : proof.status === 'pass'
    if (result != null && result !== current) return null
    result = current
  }
  return result
}

function comparisonOperatorFromKind(kind: ts.SyntaxKind): {op: '==' | '>=' | '<=' | '>' | '<'; negated: boolean} | null {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return {op: '==', negated: false}
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return {op: '==', negated: true}
    case ts.SyntaxKind.LessThanToken:
      return {op: '<', negated: false}
    case ts.SyntaxKind.LessThanEqualsToken:
      return {op: '<=', negated: false}
    case ts.SyntaxKind.GreaterThanToken:
      return {op: '>', negated: false}
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return {op: '>=', negated: false}
    default:
      return null
  }
}

function isEqualityComparison(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken
}

function compareLiteralSets(left: LiteralPrimitive[], right: LiteralPrimitive[], kind: ts.SyntaxKind): boolean[] {
  const values: boolean[] = []
  const negated = kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken
  for (const leftValue of left) {
    for (const rightValue of right) {
      values.push((literalKey(leftValue) === literalKey(rightValue)) !== negated)
    }
  }
  return values
}

function evaluateConditionalExpression(expression: ts.ConditionalExpression, frame: InterpreterFrame): Value {
  auditConditionalSelector(expression, auditReadFrame(frame), evaluateExpression)
  const truthValues = evaluateConditionTruthiness(expression.condition, frame, 'Conditional expression')
  if (truthValues == null) return unknown(`Unsupported conditional condition: ${nodeText(expression.condition, frame)}`)
  const truth = singleBooleanValue(truthValues)
  if (truth === true) return evaluateExpression(expression.whenTrue, frame)
  if (truth === false) return evaluateExpression(expression.whenFalse, frame)
  const repeatable = expressionIsRepeatable(expression.condition, frame.program)
  const branchId = freshBranchId(frame)
  const trueFrame = controlFlowBranchFrame(
    frame,
    expression.condition,
    true,
    '<conditional-true>',
    branchArm(branchId, 0),
    repeatable,
  )
  const falseFrame = controlFlowBranchFrame(
    frame,
    expression.condition,
    false,
    '<conditional-false>',
    branchArm(branchId, 1),
    repeatable,
  )
  const trueValue = valueWithAssumptions(
    evaluateExpression(expression.whenTrue, trueFrame),
    trueFrame.caseAssumptions,
    trueFrame.branches,
  )
  const falseValue = valueWithAssumptions(
    evaluateExpression(expression.whenFalse, falseFrame),
    falseFrame.caseAssumptions,
    falseFrame.branches,
  )
  if (
    !expressionIsRepeatable(expression.whenTrue, frame.program)
    || !expressionIsRepeatable(expression.whenFalse, frame.program)
  ) {
    frame.env = joinBranchFrameEnvs(trueFrame, falseFrame)
  }
  return joinValues(trueValue, falseValue)
}

function auditReadFrame(frame: InterpreterFrame): InterpreterFrame {
  return deriveFrame(frame, {
    env: new Map(frame.env),
    stateCases: null,
    output: {
      issues: [],
      effects: [],
      audits: frame.output.audits,
    },
  })
}

function evaluateCallExpression(expression: ts.CallExpression, frame: InterpreterFrame): Value {
  const target = unwrapExpression(expression.expression)
  // Catalog names are ordinary identifiers: the user's own binding — a local,
  // a module function, or an import — always wins over the catalog meaning.
  if (builtinCallName(expression) != null && !userBindingForCallTarget(target, frame)) {
    const ambient = evaluateBuiltinCall({
      expression,
      evaluateExpression: current => evaluateExpression(current, frame),
      expressionText: current => nodeText(current, frame),
    })
    if (ambient != null) return ambient
  }
  let returnTypeFallback: Value | null | undefined
  const fallback = () => {
    returnTypeFallback ??= valueFromProjectCallReturnType(expression.getText(frame.program.sourceFile), expression, frame.program)
    return returnTypeFallback
  }
  if (
    ts.isPropertyAccessExpression(target)
    && ts.isIdentifier(target.expression)
    && target.expression.text === 'Math'
    && isDefaultLibrarySymbol(target.expression, frame.program)
    && isDefaultLibraryMemberAccess(target, frame.program)
  ) {
    return evaluateMathCall(target.name.text, evaluatedArguments(expression.arguments, frame), frame, expression)
  }
  const defaultLibraryMethod = ts.isPropertyAccessExpression(target) && isDefaultLibraryMemberAccess(target, frame.program)
  let platformRejectionReason: string | null = null
  if (defaultLibraryMethod) {
    const owner = defaultLibraryOwner(target, frame.program)
    const classification = classifyPlatformMethodCall(owner, target.name.text, expression.arguments.length)
    if (classification.kind === 'supported') {
      const effect = classification.effect
      const operands = evaluatePlatformMethodOperands(expression, target, frame)
      if (operands.kind === 'invalid') return noteUnsupported(frame, operands.reason, expression)
      const receiver = operands.receiver?.value
      if (receiver == null) return noteUnsupported(frame, 'Platform method receiver was not evaluated', expression)
      const argumentValues = operands.arguments.map(argument => argument.value)
      const handled = evaluateKnownPlatformMethod(expression, target, owner, effect, receiver, argumentValues, frame)
      if (handled != null) return handled
      applyPlatformMethodRuntimeEffects(expression, target, effect, receiver, argumentValues, frame)
      const typed = fallback()
      if (typed?.kind === 'object' || typed?.kind === 'array') return typed
      return noteUnsupported(frame, `Platform call is not interpreted: ${expression.getText(frame.program.sourceFile)}`, expression)
    }
    if (classification.kind === 'unsupported') platformRejectionReason = classification.reason
  }
  if (isInlineFunction(target)) {
    const operands = evaluateInvocationOperands(expression.arguments, frame)
    if (operands.kind === 'invalid') return noteUnsupported(frame, operands.reason, expression)
    const prepared = prepareFunctionNodeInvocation(
      '<iife>',
      target,
      operands.arguments,
      childFrame(frame, new Map(frame.env), '<iife>'),
      'invalid',
    )
    if (prepared.kind === 'invalid') return noteUnsupported(frame, prepared.reason, expression)
    const result = evaluateFunctionNodeBody('<iife>', target, prepared.frame)
    applyFunctionCallEffects(
      functionEffects(functionImplementationReference(frame.program, target)),
      expression.arguments,
      target.parameters,
      null,
      frame,
    )
    return result
  }
  const resolved = resolveCallTarget(target, frame.program)
  if (resolved.kind === 'math') {
    return evaluateMathCall(resolved.name, evaluatedArguments(expression.arguments, frame), frame, expression)
  }
  if (resolved.kind === 'function') return evaluateResolvedFunctionCall(expression, target.getText(frame.program.sourceFile), resolved, fallback(), frame)
  // Supported platform globals use their shared effect description. Deliberate
  // rejections and calls we cannot classify receive the unknown-call treatment.
  const platformGlobal = ts.isPropertyAccessExpression(target)
    && ts.isIdentifier(target.expression)
    && isDefaultLibrarySymbol(target.expression, frame.program)
    && isDefaultLibraryMemberAccess(target, frame.program)
    ? classifyPlatformGlobalCall(target.expression.text, target.name.text, expression.arguments.length)
    : {kind: 'unrecognized'} as const
  if (platformGlobal.kind === 'unsupported') platformRejectionReason = platformGlobal.reason
  const factPreservingGlobal = platformGlobal.kind === 'supported'
    && !platformGlobal.effect.mutatesReceiver
    && platformGlobal.effect.mutatesArgumentIndexes.length === 0
    && platformGlobal.effect.callbacks.length === 0
  const platformNamespace = ts.isPropertyAccessExpression(target)
    && ts.isIdentifier(target.expression)
    && isDefaultLibrarySymbol(target.expression, frame.program)
  let receiverExpression: ts.Expression | null = null
  let receiver: Value | null = null
  if (!platformNamespace && ts.isPropertyAccessExpression(target)) {
    if (propertyAccessHasSourceAccessor(target, 'get', frame.program)) {
      evaluateExpression(target, frame)
    } else {
      receiverExpression = target.expression
      receiver = evaluateExpression(receiverExpression, frame)
    }
  } else if (ts.isElementAccessExpression(target)) {
    if (elementAccessHasSourceAccessor(target, 'get', frame.program)) {
      evaluateExpression(target, frame)
    } else {
      receiverExpression = target.expression
      receiver = evaluateExpression(receiverExpression, frame)
      if (target.argumentExpression != null) evaluateExpression(target.argumentExpression, frame)
    }
  } else if (!ts.isIdentifier(target)) {
    evaluateExpression(target, frame)
  }
  const operands = evaluateInvocationOperands(
    expression.arguments,
    frame,
    receiver == null || receiverExpression == null
      ? null
      : {value: receiver, sourceText: receiverExpression.getText(frame.program.sourceFile)},
  )
  if (operands.kind === 'invalid') return noteUnsupported(frame, operands.reason, expression)
  const argumentValues = operands.arguments.map(argument => argument.value)
  if (!factPreservingGlobal) applyUnknownCallEffects(expression, target, argumentValues, receiver, frame)
  const platformRejection = platformRejectionReason == null
    ? null
    : noteUnsupported(frame, platformRejectionReason, expression)
  const unresolvedFallback = fallback()
  if (unresolvedFallback?.kind === 'object' || unresolvedFallback?.kind === 'array') return unresolvedFallback
  return platformRejection ?? noteUnsupported(frame, resolved.reason, expression)
}

function evaluateKnownPlatformMethod(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  owner: ReturnType<typeof defaultLibraryOwner>,
  effect: PlatformCallEffect,
  receiver: Value,
  argumentValues: Value[],
  frame: InterpreterFrame,
): Value | null {
  if (owner !== 'Array' && owner !== 'ReadonlyArray') return null
  if (target.name.text === 'push') return evaluatePushCall(expression, target, receiver, argumentValues, frame)
  const mutation = evaluateArrayMutationCall(expression, target, effect, receiver, frame)
  if (mutation != null) return mutation
  if (target.name.text === 'at') return evaluateArrayAtCall(expression, receiver, argumentValues, frame)
  if (target.name.text === 'map') return evaluateMapCall(expression, target, effect, receiver, frame)
  if (target.name.text === 'filter') return evaluateFilterCall(expression, target, effect, receiver, frame)
  if (target.name.text === 'every') return evaluateEverySomeCall(expression, target, effect, receiver, 'every', frame)
  if (target.name.text === 'some') return evaluateEverySomeCall(expression, target, effect, receiver, 'some', frame)
  return null
}

function evaluatePlatformMethodOperands(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  frame: InterpreterFrame,
): EvaluatedInvocationOperands {
  const receiver = evaluateExpression(target.expression, frame)
  return evaluateInvocationOperands(
    expression.arguments,
    frame,
    {value: receiver, sourceText: target.expression.getText(frame.program.sourceFile)},
    argument => {
      const current = unwrapExpression(argument)
      if (isInlineFunction(current) || passedFunctionReference(current, frame) != null) {
        return unknown('Function value')
      }
      return evaluateExpression(argument, frame)
    },
  )
}

function applyPlatformMethodRuntimeEffects(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  effect: PlatformCallEffect,
  receiver: Value,
  argumentValues: Value[],
  frame: InterpreterFrame,
) {
  if (effect.mutatesReceiver) {
    havocExpressionAliases(frame, target.expression)
    havocReferenceAliases(frame, valueReferenceIds(receiver))
  }
  for (const index of effect.mutatesArgumentIndexes) {
    const argument = expression.arguments[index]
    if (argument == null) continue
    const source = ts.isSpreadElement(argument) ? argument.expression : argument
    havocExpressionAliases(frame, source)
    havocReferenceAliases(frame, valueReferenceIds(argumentValues[index]))
  }
  for (const index of retainedArgumentIndexes(effect, expression.arguments.length)) {
    const argument = expression.arguments[index]
    if (argument == null) continue
    const source = ts.isSpreadElement(argument) ? argument.expression : argument
    havocExpressionAliases(frame, source)
    havocReferenceAliases(frame, valueReferenceIds(argumentValues[index]))
  }
  for (const callback of effect.callbacks) {
    applyPlatformCallbackRuntimeEffect(expression, target, callback, frame)
  }
}

function applyPlatformCallbackRuntimeEffect(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  callback: PlatformCallbackEffect,
  frame: InterpreterFrame,
): FunctionEffects | null {
  const argument = expression.arguments[callback.argumentIndex]
  const callbackExpression = argument == null
    ? null
    : unwrapExpression(ts.isSpreadElement(argument) ? argument.expression : argument)
  const callbackRef = callbackExpression == null ? null : passedFunctionReference(callbackExpression, frame)
  const elementParams: number[] = []
  const receiverParams: number[] = []
  callback.parameterSources.forEach((sources, index) => {
    if (sources.some(source => source.kind === 'receiver-elements')) elementParams.push(index)
    if (sources.some(source => source.kind === 'receiver')) receiverParams.push(index)
  })
  const thisArgument = callback.thisSource?.kind === 'argument'
    ? expression.arguments[callback.thisSource.index] ?? null
    : null
  const thisExpression = thisArgument != null && !ts.isSpreadElement(thisArgument) ? thisArgument : null
  if (callbackRef != null) {
    return applyCallbackEffects(
      callbackRef,
      target.expression,
      thisExpression,
      frame,
      elementParams,
      receiverParams,
    )
  }
  if (elementParams.length > 0) havocArrayElementAliases(frame, target.expression)
  if (receiverParams.length > 0) havocExpressionAliases(frame, target.expression)
  if (thisExpression != null) havocExpressionAliases(frame, thisExpression)
  return null
}

function evaluateArrayMutationCall(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  effect: PlatformCallEffect,
  receiver: Value,
  frame: InterpreterFrame,
): Value | null {
  if (target.name.text !== 'reverse' && target.name.text !== 'sort' && target.name.text !== 'splice') return null
  if (receiver.kind !== 'array') {
    havocExpressionAliases(frame, target.expression)
    return noteUnsupported(frame, `${target.name.text} expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  }
  if (target.name.text === 'sort') {
    const comparator = effect.callbacks[0]
    if (comparator != null) applyPlatformCallbackRuntimeEffect(expression, target, comparator, frame)
  }
  noteEffect(frame, `${target.name.text} mutates ${target.expression.getText(frame.program.sourceFile)}: ${expression.getText()}`, expression)
  if (target.name.text === 'splice') {
    const targetExpr = target.expression.getText(frame.program.sourceFile)
    const next = collectionValue(
      unknownArrayLength(targetExpr),
      null,
      targetExpr,
      receiver.referenceIds,
    )
    replaceValueEverywhere(frame.env, receiver, next)
    havocRoots(frame, expressionRootNames(target.expression, []))
    return unknownArray(expression.getText(frame.program.sourceFile))
  }
  const next = {...arrayAsCollection(receiver), summary: null}
  replaceValueEverywhere(frame.env, receiver, next)
  return next
}

function evaluateResolvedFunctionCall(
  expression: ts.CallExpression,
  callName: string,
  target: Extract<InterpreterCallTarget, {kind: 'function'}>,
  fallback: Value | null,
  frame: InterpreterFrame,
  thisValue?: Value,
  receiverExpression?: ts.Expression,
): Value {
  const result = evaluateResolvedFunctionCallResult(expression, callName, target, fallback, frame, thisValue)
  // The call happened in every outcome above (including the recursion cut), so
  // its effects on the caller's world apply unconditionally.
  applyFunctionCallEffects(
    functionEffects(functionImplementationReference(target.program, target.fn.node)),
    expression.arguments,
    target.fn.node.parameters,
    receiverExpression ?? null,
    frame,
  )
  return result
}

function evaluateResolvedFunctionCallResult(
  expression: ts.CallExpression,
  callName: string,
  target: Extract<InterpreterCallTarget, {kind: 'function'}>,
  fallback: Value | null,
  frame: InterpreterFrame,
  thisValue?: Value,
): Value {
  const receiver = thisValue == null ? null : {value: thisValue, sourceText: null}
  const operands = evaluateInvocationOperands(expression.arguments, frame, receiver)
  if (operands.kind === 'invalid') {
    const unsupported = noteUnsupported(frame, operands.reason, expression)
    return fallback ?? unsupported
  }
  const resolvedThisValue = operands.receiver?.value
  const callKey = `${target.program.sourceId}#${target.fn.name}`
  if (frame.activeCalls.has(callKey)) {
    const unsupported = noteUnsupported(frame, `Recursive helper inlining is unsupported at ${target.fn.name}`, expression)
    return fallback ?? unsupported
  }
  const prepared = prepareFitFunctionInvocation(
    target.fn,
    operands.arguments,
    frameWithActiveCall(frame, callKey),
    target.program,
    resolvedThisValue,
  )
  if (prepared.kind === 'invalid') {
    const unsupported = noteUnsupported(frame, prepared.reason, expression)
    return fallback ?? unsupported
  }
  const hooked = evaluateHookedCall({
    expression,
    callName,
    target,
    prepared: prepared.prepared,
    fallback,
    ...(resolvedThisValue == null ? {} : {thisValue: resolvedThisValue}),
  }, frame)
  if (hooked != null) return withFreshCallAlternatives(hooked, frame)
  return valueWithTypeFallback(
    evaluateFunctionNodeBody(target.fn.name, target.fn.node, prepared.frame),
    fallback,
  )
}

function withFreshCallAlternatives(value: Value, frame: InterpreterFrame): Value {
  if (
    value.kind !== 'number'
    || value.cases == null
    || value.cases.length <= 1
    || value.cases.some(numberCase => numberCase.branches.length > 0)
  ) return value
  const branchId = freshBranchId(frame)
  return withNumberCases(value, value.cases.map((numberCase, arm) => ({
    ...numberCase,
    branches: [branchArm(branchId, arm)],
  })))
}

function evaluateHookedCall(call: InterpreterCall, frame: InterpreterFrame): Value | null {
  return frame.policy.hooks?.evaluateCall?.(call, frame) ?? null
}

function evaluateArrayAtCall(expression: ts.CallExpression, receiver: Value, argumentValues: Value[], frame: InterpreterFrame): Value {
  if (receiver.kind !== 'array') return noteUnsupported(frame, 'Array.at expected an array', expression.expression)
  const offset = argumentValues.length === 1 ? exactInteger(argumentValues[0]!) : null
  if (offset == null || !Number.isInteger(offset) || offset >= 0) return noteUnsupported(frame, 'Array.at only supports constant negative indexes', expression.arguments[0] ?? expression)

  const requiredLength = -offset
  if (arrayLength(receiver).min < requiredLength) return noteUnsupported(frame, `Array.at(${offset}) expected length >= ${requiredLength}`, expression)
  const elements = tupleElements(receiver)
  if (elements != null) {
    const value = elements[elements.length + offset]
    return value ?? noteUnsupported(frame, `Array.at(${offset}) has no matching element`, expression)
  }
  return arrayElement(receiver) ?? noteUnsupported(frame, `Array.at(${offset}) element values are not tracked`, expression)
}

function evaluatePushCall(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  receiver: Value,
  values: Value[],
  frame: InterpreterFrame,
): Value {
  if (receiver.kind !== 'array') return noteUnsupported(frame, `push expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  noteEffect(frame, `push mutates ${target.expression.getText(frame.program.sourceFile)}: ${expression.getText()}`, expression)
  const loop = currentLoop(frame)
  if (loop?.mode === 'symbolic' && expression.arguments.length !== 1) return noteUnsupported(frame, 'Abstract loop push supports one item per iteration', expression)
  let element: Value | null = arrayElement(receiver)
  for (const value of values) element = mergeElementValue(element, value)
  const symbolicLength = loop?.mode === 'symbolic' ? symbolicLoopAppendLength(receiver, loop) : null
  const previousLength = arrayLength(receiver)
  const nextLength = numberValue(
    previousLength.min + values.length,
    previousLength.max + values.length,
    0,
    `${receiver.expr ?? target.expression.getText(frame.program.sourceFile)}.length`,
    previousLength.min === previousLength.max
      ? linearConstant(previousLength.min + values.length)
      : null,
  )
  const path = pathFromSourceExpression(target.expression, () => unknown('dynamic path'))
  const summary = loop == null || path == null || path.segments.length !== 0
    ? null
    : loopPushSummary(receiver, path.root, loop, frame)
  if (loop != null && path != null && path.segments.length === 0) {
    loop.appends.push({
      arrayName: path.root,
      element: values[0] ?? null,
      base: receiver,
    })
  }
  const next = collectionValue(
    symbolicLength ?? nextLength,
    element,
    receiver.expr,
    receiver.referenceIds,
    summary,
  )
  replaceValueEverywhere(frame.env, receiver, next)
  return next.length
}

function symbolicLoopAppendLength(current: ArrayValue, loop: LoopFrame): NumberValue {
  const currentLength = arrayLength(current)
  const sourceLength = arrayLength(loop.source)
  if (currentLength.min === 0 && currentLength.max === 0) return sourceLength
  return addNumbers(currentLength, sourceLength)
}

function currentLoop(frame: InterpreterFrame) {
  return frame.loopStack.at(-1) ?? null
}

function loopPushSummary(current: ArrayValue, arrayName: string, loop: LoopFrame, frame: InterpreterFrame): ArraySummary | null {
  const firstAppend = loop.appends.find(append => append.arrayName === arrayName)
  const startedEmpty = isDefinitelyEmptyArray(firstAppend?.base ?? current)
  const currentSummary = arraySummary(current)
  if (!startedEmpty || (firstAppend != null && currentSummary?.origin == null)) return null
  const filtered = frame.conditionalDepth > 0 || currentSummary?.origin?.kind === 'subsequence'
  const origin = filtered
    ? filterOrigin(loop.source, loop.sourceExpr)
    : mapOrigin(loop.source, loop.sourceExpr)
  return emptyArraySummary(origin)
}

function evaluateEverySomeCall(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  effect: PlatformCallEffect,
  source: Value,
  kind: 'every' | 'some',
  frame: InterpreterFrame,
): Value {
  if (source.kind !== 'array') return noteUnsupported(frame, `${kind} expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  const callbackEffects = effect.callbacks[0] == null
    ? null
    : applyPlatformCallbackRuntimeEffect(expression, target, effect.callbacks[0], frame)
  if (callbackFn == null || !isInlineFunction(callbackFn)) {
    return noteUnsupported(frame, `${kind} callback must be an inline function`, callback ?? expression)
  }
  const text = expression.getText(frame.program.sourceFile)
  if (arrayLength(source).max === 0) return literalValue([kind === 'every'], text)
  if (callbackEffects == null) return noteUnsupported(frame, `${kind} callback effects were not resolved`, callback)
  const effectiveSource = sourceAfterCallback(source, callbackEffects, effect.callbacks[0]!)
  const sourceExpr = sourceExpression(effectiveSource, target.expression, frame)
  const effectiveLength = arrayLength(effectiveSource)
  const item = arrayElement(effectiveSource) ?? unknown(`${sourceExpr}[] was not inferred`)
  const index = indexedElementPathValue(`${kind}Index(${sourceExpr})`, effectiveLength)
  const raw = invokeInlineFunction(`<${kind}-predicate>`, callbackFn, [item, index, effectiveSource], frame)
  const refined = valueWithAssumptions(raw, indexedElementAssumptions(index, effectiveLength))
  const truth = truthinessValues(refined)
  if (truth == null) return literalValue([true, false], text)
  if (truth.every(value => value === true)) {
    if (kind === 'every') return literalValue([true], text)
    if (effectiveLength.min >= 1) return literalValue([true], text)
    return literalValue([true, false], text)
  }
  if (truth.every(value => value === false)) {
    if (kind === 'some') return literalValue([false], text)
    if (effectiveLength.min >= 1) return literalValue([false], text)
    return literalValue([true, false], text)
  }
  return literalValue([true, false], text)
}

function evaluateMapCall(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  effect: PlatformCallEffect,
  source: Value,
  frame: InterpreterFrame,
): Value {
  if (source.kind !== 'array') return noteUnsupported(frame, `map expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  const callbackEffects = effect.callbacks[0] == null
    ? null
    : applyPlatformCallbackRuntimeEffect(expression, target, effect.callbacks[0], frame)
  if (callbackFn == null || !isInlineFunction(callbackFn)) {
    return noteUnsupported(frame, 'map callback must be an inline function', callback ?? expression)
  }
  if (callbackEffects == null) return noteUnsupported(frame, 'map callback effects were not resolved', callback)
  const effectiveSource = sourceAfterCallback(source, callbackEffects, effect.callbacks[0]!)
  const sourceExpr = sourceExpression(effectiveSource, target.expression, frame)
  const abstractElement = evaluateMapElement(effectiveSource, sourceExpr, callbackFn, frame)
  // A pure field rename keeps the rows' adjacency story: the same facts hold
  // under the output names. This is how other field vocabularies reach the
  // catalog: rows.map(row => ({top: row.y, height: row.size})).
  const renamed = projectSummaryThroughRename(arraySummary(effectiveSource), callbackFn)
  return collectionValue(
    arrayLength(effectiveSource),
    abstractElement,
    expression.getText(frame.program.sourceFile),
    freshReferenceIds(),
    mergeArraySummary(emptyArraySummary(mapOrigin(effectiveSource, sourceExpr)), renamed),
  )
}

type RenamePair = {inputPath: string[]; outputPath: string[]}

// The output-field → input-field mapping of a callback that only relabels:
// every property initializer is a property chain on the element parameter
// (recursively through nested object literals). Computed fields are simply
// unmapped; a spread hides the field set, so nothing maps.
function pureRenamePairs(callbackFn: FunctionImplementationNode): RenamePair[] | null {
  const parameter = callbackFn.parameters[0]
  if (parameter == null || !ts.isIdentifier(parameter.name)) return null
  const body = ts.isArrowFunction(callbackFn) && ts.isExpression(callbackFn.body)
    ? callbackFn.body
    : singleReturnExpression(callbackFn)
  if (body == null) return null
  const literal = unwrapExpression(body)
  if (!ts.isObjectLiteralExpression(literal)) return null
  const pairs: RenamePair[] = []
  return collectRenamePairs(literal, parameter.name.text, [], pairs) ? pairs : null
}

function collectRenamePairs(literal: ts.ObjectLiteralExpression, parameterName: string, prefix: string[], pairs: RenamePair[]): boolean {
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) return false
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    const outputPath = [...prefix, property.name.text]
    const initializer = unwrapExpression(property.initializer)
    if (ts.isObjectLiteralExpression(initializer)) {
      if (!collectRenamePairs(initializer, parameterName, outputPath, pairs)) return false
      continue
    }
    const inputPath = parameterPropertyChain(initializer, parameterName)
    if (inputPath != null) pairs.push({inputPath, outputPath})
  }
  return true
}

function parameterPropertyChain(expression: ts.Expression, parameterName: string): string[] | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return current.text === parameterName ? [] : null
  if (!ts.isPropertyAccessExpression(current)) return null
  const parent = parameterPropertyChain(current.expression, parameterName)
  return parent == null ? null : [...parent, current.name.text]
}

function singleReturnExpression(callbackFn: FunctionImplementationNode): ts.Expression | null {
  if (!ts.isBlock(callbackFn.body) || callbackFn.body.statements.length !== 1) return null
  const statement = callbackFn.body.statements[0]!
  return ts.isReturnStatement(statement) ? statement.expression ?? null : null
}

function projectSummaryThroughRename(summary: ArraySummary | null, callbackFn: FunctionImplementationNode): ArraySummary | null {
  if (summary == null) return null
  const pairs = pureRenamePairs(callbackFn)
  if (pairs == null || pairs.length === 0) return null
  const renameOutput = (inputPath: string[]): string[] | null =>
    pairs.find(pair => samePathParts(pair.inputPath, inputPath))?.outputPath ?? null

  const projected: ArraySummary = {relations: [], advances: [], lastEnd: null, extentEnds: []}
  for (const relation of summary.relations) {
    const left = renameOutput(relation.left.path)
    if (left == null) continue
    if (relation.kind === 'adjacent-comparison') {
      const terms = relation.right.terms.map(term => {
        const path = renameOutput(term.path)
        return path == null ? null : {...term, path}
      })
      if (terms.some(term => term == null)) continue
      projected.relations.push({
        ...relation,
        left: {...relation.left, path: left},
        right: {...relation.right, terms: terms as typeof relation.right.terms},
      })
      continue
    }
    const right = mapSequenceAddition(relation.right, term => {
      const path = renameOutput(term.path)
      return path == null ? null : {...term, path}
    })
    if (right != null) projected.relations.push({...relation, left: {...relation.left, path: left}, right})
  }
  for (const advance of summary.advances) {
    const path = renameOutput(advance.prop.split('.').filter(part => part.length > 0))
    if (path != null) projected.advances.push({...advance, prop: path.join('.')})
  }
  if (summary.lastEnd != null) {
    const positionPath = renameOutput(summary.lastEnd.positionPath)
    const sizePath = renameOutput(summary.lastEnd.sizePath)
    if (positionPath != null && sizePath != null) {
      projected.lastEnd = {...summary.lastEnd, positionPath, sizePath}
    }
  }
  for (const fact of summary.extentEnds) {
    const positionPath = renameOutput(fact.positionPath)
    const sizePath = renameOutput(fact.sizePath)
    if (positionPath != null && sizePath != null) projected.extentEnds.push({...fact, positionPath, sizePath})
  }
  return projected.relations.length === 0 && projected.advances.length === 0 && projected.lastEnd == null && projected.extentEnds.length === 0
    ? null
    : projected
}

function samePathParts(left: string[], right: string[]) {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function evaluateMapElement(source: ArrayValue, sourceExpr: string, callbackFn: InlineFunctionNode, frame: InterpreterFrame): Value | null {
  const length = arrayLength(source)
  const item = arrayElement(source) ?? unknown(`${sourceExpr}[] was not inferred`)
  const index = indexedElementPathValue(`mapIndex(${sourceExpr})`, length)
  const value = invokeInlineFunction(
    '<map-element>',
    callbackFn,
    [
      item,
      index,
      source,
    ],
    frame,
  )
  return valueWithAssumptions(value, indexedElementAssumptions(index, length))
}

function evaluateFilterCall(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  effect: PlatformCallEffect,
  source: Value,
  frame: InterpreterFrame,
): Value {
  if (source.kind !== 'array') return noteUnsupported(frame, `filter expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  const callbackEffects = effect.callbacks[0] == null
    ? null
    : applyPlatformCallbackRuntimeEffect(expression, target, effect.callbacks[0], frame)
  if (callbackFn == null || !isInlineFunction(callbackFn)) {
    return noteUnsupported(frame, 'filter callback must be an inline function', callback ?? expression)
  }
  if (callbackEffects == null) return noteUnsupported(frame, 'filter callback effects were not resolved', callback)
  const effectiveSource = sourceAfterCallback(source, callbackEffects, effect.callbacks[0]!)
  const sourceExpr = sourceExpression(effectiveSource, target.expression, frame)
  const element = filteredElement(effectiveSource, sourceExpr, callbackFn, frame)
  const summary = emptyArraySummary(filterOrigin(effectiveSource, sourceExpr))
  const text = expression.getText(frame.program.sourceFile)
  const length = filteredLength(effectiveSource, callbackFn, frame, text)
  addLengthAtMostSourceFact(length, arrayLength(effectiveSource), frame)
  return collectionValue(length, element, text, freshReferenceIds(), summary)
}

function addLengthAtMostSourceFact(length: NumberValue, sourceLength: NumberValue, frame: InterpreterFrame) {
  const fact = comparisonConstraint(length, '<=', sourceLength, `${length.expr ?? 'length'} <= ${sourceLength.expr ?? 'source length'}`)
  if (fact != null) frame.assumptions = mergeAssumptions(frame.assumptions, [fact])
}

function filteredLength(source: ArrayValue, callbackFn: InlineFunctionNode, frame: InterpreterFrame, text: string): NumberValue {
  const sourceLength = arrayLength(source)
  const fallback = numberValue(0, sourceLength.max, 0, `${text}.length`)
  if (sourceLength.max === 0) return numberValue(0, 0, 0, `${text}.length`)
  const sourceExpr = source.expr ?? text
  const item = arrayElement(source) ?? unknown(`${sourceExpr}[] was not inferred`)
  const index = indexedElementPathValue(`filterIndex(${sourceExpr})`, sourceLength)
  const raw = invokeInlineFunction('<filter-predicate>', callbackFn, [item, index, source], frame)
  const refined = valueWithAssumptions(raw, indexedElementAssumptions(index, sourceLength))
  const truth = truthinessValues(refined)
  if (truth == null) return fallback
  if (truth.every(value => value === true)) {
    return numberValue(sourceLength.min, sourceLength.max, 0, `${text}.length`, sourceLength.linear)
  }
  if (truth.every(value => value === false)) {
    return numberValue(0, 0, 0, `${text}.length`)
  }
  return fallback
}

function filteredElement(source: ArrayValue, sourceExpr: string, callbackFn: InlineFunctionNode, frame: InterpreterFrame): Value | null {
  const predicate = callbackPredicateExpression(callbackFn)
  const sourceElement = arrayElement(source)
  if (predicate == null || !expressionIsRepeatable(predicate, frame.program)) return sourceElement
  const element = sourceElement ?? unknown(`${sourceExpr}[] was not inferred`)
  const callbackFrame = childFrame(frame, new Map(frame.env), '<filter-predicate>')
  const prepared = prepareFunctionNodeInvocation(
    '<filter-predicate>',
    callbackFn,
    [{value: element, sourceText: null}, null, {value: source, sourceText: null}],
    callbackFrame,
    'unknown',
  )
  if (prepared.kind === 'invalid') return sourceElement
  const itemName = firstIdentifierParameterName(callbackFn)
  if (itemName == null) return sourceElement
  const trueFrame = branchFrame(prepared.frame, predicate, true, '<filter-true>', evaluateExpression)
  const refined = trueFrame.env.get(itemName)
  return refined == null ? sourceElement : valueWithAssumptions(refined, trueFrame.assumptions)
}

function callbackPredicateExpression(callbackFn: InlineFunctionNode): ts.Expression | null {
  if (ts.isArrowFunction(callbackFn) && ts.isExpression(callbackFn.body)) return callbackFn.body
  if (!ts.isBlock(callbackFn.body) || callbackFn.body.statements.length !== 1) return null
  const statement = callbackFn.body.statements[0]!
  return ts.isReturnStatement(statement) ? statement.expression ?? null : null
}

function firstIdentifierParameterName(callbackFn: InlineFunctionNode): string | null {
  const first = callbackFn.parameters[0]
  return first != null && ts.isIdentifier(first.name) ? first.name.text : null
}

function sourceExpression(source: ArrayValue, expression: ts.Expression, frame: InterpreterFrame): string {
  return source.expr ?? expression.getText(frame.program.sourceFile)
}

type EvaluatedInvocationOperands =
  | {kind: 'valid'; receiver: EvaluatedOperand | null; arguments: EvaluatedOperand[]}
  | {kind: 'invalid'; reason: string}

function evaluateInvocationOperands(
  args: ts.NodeArray<ts.Expression>,
  frame: InterpreterFrame,
  receiver: EvaluatedOperand | null = null,
  evaluateArgument: (argument: ts.Expression) => Value = argument => evaluateExpression(argument, frame),
): EvaluatedInvocationOperands {
  const captured: {root: string; sourceText: string | null; receiver: boolean}[] = []
  let nextOperandIndex = 0
  const capture = (value: Value, sourceText: string | null, isReceiver = false) => {
    let root = `\0call-operand-${nextOperandIndex++}`
    while (frame.env.has(root)) root = `\0call-operand-${nextOperandIndex++}`
    frame.env.set(root, value)
    captured.push({root, sourceText, receiver: isReceiver})
  }
  if (receiver != null) capture(receiver.value, receiver.sourceText, true)

  let invalidReason: string | null = null
  for (const argument of args) {
    if (!ts.isSpreadElement(argument)) {
      capture(evaluateArgument(argument), argument.getText())
      continue
    }
    const spread = evaluateExpression(argument.expression, frame)
    const elements = spread.kind === 'array' ? tupleElements(spread) : null
    if (elements == null) {
      invalidReason ??= `Call spread needs an exact tuple: ${argument.getText()}`
      continue
    }
    const spreadText = argument.expression.getText()
    for (let index = 0; index < elements.length; index++) capture(elements[index]!, `${spreadText}[${index}]`)
  }

  let resolvedReceiver: EvaluatedOperand | null = null
  const arguments_: EvaluatedOperand[] = []
  for (const operand of captured) {
    const value = frame.env.get(operand.root)
    frame.env.delete(operand.root)
    if (value == null) return {kind: 'invalid', reason: 'Call operand was lost during evaluation'}
    if (operand.receiver) resolvedReceiver = {value, sourceText: operand.sourceText}
    else arguments_.push({value, sourceText: operand.sourceText})
  }
  if (invalidReason != null) return {kind: 'invalid', reason: invalidReason}
  return {kind: 'valid', receiver: resolvedReceiver, arguments: arguments_}
}

function evaluatedArguments(args: ts.NodeArray<ts.Expression>, frame: InterpreterFrame): Value[] {
  return args.map(arg => evaluateExpression(arg, frame))
}

function pathFromExpression(expression: ts.Expression, frame: InterpreterFrame): ValuePath | null {
  return pathFromSourceExpression(expression, indexExpression => evaluateExpression(indexExpression, frame))
}

function nodeText(node: ts.Node, frame: InterpreterFrame) {
  return node.getSourceFile() === frame.program.sourceFile
    ? node.getText(frame.program.sourceFile)
    : node.getText()
}
