import * as ts from 'typescript'
import {
  ambientIdentifierBound,
  ambientPropertyBound,
} from '../ambient-bounds.ts'
import type {
  ArrayCallbackFunction,
  Program,
} from '../check-types.ts'
import {
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from '../binding-patterns.ts'
import {
  emptyArraySummary,
  filterOrigin,
  mapOrigin,
} from '../array-summary.ts'
import {
  addNumbers,
  divideNumbers,
  joinValues,
  literalKey,
  literalValue,
  mergeArraySummary,
  mergeElementValue,
  moduloNumbers,
  multiplyNumbers,
  negateNumber,
  numberBranches,
  nullValue,
  nullableValue,
  numberValue,
  powerNumbers,
  subtractNumbers,
  tupleElements,
  unknown,
  unknownArray,
  unknownObject,
  valueWithAssumptions,
  valueWithDefaultedUndefined,
  withNumberCases,
  type ArraySummary,
  type ArrayValue,
  type LinearConstraint,
  type LiteralPrimitive,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {mergeAssumptions} from '../assumptions.ts'
import {combineNumberCases} from './state-cases.ts'
import {
  adjacentElementAccessFacts,
  valueWithRebasedElementPath,
} from '../indexed-facts.ts'
import {indexedElementPathValue} from '../loop-summary.ts'
import {
  linearConstant,
  numericLiteralValue,
} from '../linear.ts'
import {
  builtinCallName,
  evaluateBuiltinCall,
  extentEndSummaryValue,
} from '../builtins.ts'
import {functionHasInstanceThisInput} from '../function-shape.ts'
import {type FitFunction, type FitFunctionNode} from '../modules.ts'
import {
  valueFromClassInstanceType,
  valueFromFunctionReturnType,
  valueFromNodeType,
  valueFromProjectCallReturnType,
  valueFromTypeNode,
} from '../shapes.ts'
import {localizeContainerLiteralValue, localizeValue} from '../value-localize.ts'
import {
  childFrame,
  frameWithActiveCall,
  frameWithProgram,
  joinFrameEnvs,
  noteEffect,
  noteUnsupported,
  rootFrame,
  type InterpreterCall,
  type InterpreterAudit,
  type InterpreterClaim,
  type InterpreterEffect,
  type InterpreterFlow,
  type InterpreterFrame,
  type InterpreterHooks,
  type InterpreterIssue,
  type InterpreterLoopClaim,
  type InterpreterReturnCase,
  type InterpreterStateCase,
  type LoopFrame,
} from './context.ts'
import {
  exactInteger,
  pathFromExpression as pathFromSourceExpression,
  readArrayIndexValue,
  readPath,
  readPropertyValue,
  valueExpr,
  valuePathExpression,
  writeMutationPath,
  writePath,
  type ValuePath,
} from './value-path.ts'
import {
  compoundAssignmentOperator,
  indexedForLoopShape,
  isAssignmentOperator,
  isSideEffectFreeExpression,
  propertyNameText,
  unwrapExpression,
  type IndexedForLoopShape,
} from './source-syntax.ts'
import {expressionRootNames} from '../source-expressions.ts'
import {
  functionEffects,
  isPureGlobalMemberCall,
  lengthBearingConstructorNames,
  outerWriteRoot,
  type FunctionEffects,
  type FunctionLikeNode,
} from './function-effects.ts'
import {evaluateSymbolicLoop, type LoopAnalysisContext} from './loop-transfer.ts'
import {
  branchFrame,
  compareNumbers,
  isComparisonOperator,
} from './refine.ts'
import {comparisonConstraint, proveComparisonPlain} from '../proof.ts'
import {formatRange} from '../reporting.ts'
import {
  forgetRoot,
  forgetRoots,
  forgettableMutationRoots,
  isForgettableForStatement,
  isForgettableReadExpression,
} from './forgettable-loop.ts'
import {evaluateMathCall, evaluateMathProperty} from './math.ts'
import {
  classMemberFunctionForPropertyAccess,
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
  reachableStateCases,
  setStateCases,
  stateCaseBudget,
  stateCaseBudgetMessage,
  stateCasesFromFrame,
  summarizeOverBudgetReturnCases,
  type StateCaseSetResult,
} from './state-cases.ts'

type InterpreterFunctionResult = {
  value: Value
  issues: InterpreterIssue[]
  effects: InterpreterEffect[]
  audits: InterpreterAudit[]
}

type InterpreterBodyResult = InterpreterFunctionResult & {
  env: Map<string, Value>
  assumptions: LinearConstraint[]
  returnCases?: InterpreterReturnCase[]
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

export function evaluateInterpreterFunction(program: Program, functionName: string): InterpreterFunctionResult {
  const frame = rootFrame(program)
  const fn = program.functions.get(functionName)
  if (fn == null) {
    return {
      value: noteUnsupported(frame, `Unknown function ${functionName}`),
      issues: frame.issues,
      effects: frame.effects,
      audits: frame.audits,
    }
  }
  const value = invokeFitFunction(fn, [], frame, program, frame.env)
  return {value, issues: frame.issues, effects: frame.effects, audits: frame.audits}
}

export function evaluateInterpreterFunctionBody(
  program: Program,
  fn: FitFunction,
  env: Map<string, Value>,
  stack: string[] = [fn.name],
  assumptions: LinearConstraint[] = [],
  hooks?: InterpreterHooks,
): InterpreterBodyResult {
  const frame = interpreterFrame(program, env, stack, assumptions, hooks)
  bindInstanceThis(fn, program, frame.env)
  const result = evaluateFunctionNodeBodyResult(fn.name, fn.node, frame)
  return {
    value: result.value,
    env: frame.env,
    issues: frame.issues,
    effects: frame.effects,
    audits: frame.audits,
    assumptions: frame.assumptions,
    ...(result.returnCases == null ? {} : {returnCases: result.returnCases}),
  }
}

export function evaluateInterpreterTopLevel(
  program: Program,
  env: Map<string, Value>,
  stack: string[] = ['<top-level>'],
  assumptions: LinearConstraint[] = [],
  hooks?: InterpreterHooks,
): InterpreterBodyResult {
  const frame = interpreterFrame(program, env, stack, assumptions, hooks)
  evaluateStatements(topLevelExecutableStatements(program.sourceFile.statements), frame)
  return {value: unknown('Top-level did not return'), env: frame.env, issues: frame.issues, effects: frame.effects, audits: frame.audits, assumptions: frame.assumptions}
}

export function evaluateInterpreterExpression(
  program: Program,
  expression: ts.Expression,
  env: Map<string, Value>,
  stack: string[] = [],
  assumptions: LinearConstraint[] = [],
  hooks?: InterpreterHooks,
  objectPath?: string[],
): InterpreterBodyResult {
  const frame = interpreterFrame(program, env, stack, assumptions, hooks, objectPath)
  const value = evaluateExpression(expression, frame)
  return {value, env: frame.env, issues: frame.issues, effects: frame.effects, audits: frame.audits, assumptions: frame.assumptions}
}

function interpreterFrame(
  program: Program,
  env: Map<string, Value>,
  stack: string[],
  assumptions: LinearConstraint[],
  hooks?: InterpreterHooks,
  objectPath?: string[],
): InterpreterFrame {
  return {
    program,
    env: new Map(env),
    issues: [],
    effects: [],
    audits: [],
    stack,
    activeCalls: new Set(),
    localBindings: new Set(),
    loopStack: [],
    conditionalDepth: 0,
    assumptions: [...assumptions],
    ...(hooks == null ? {} : {hooks}),
    ...(objectPath == null ? {} : {objectPath}),
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
  return invokeFunctionNode(fn.name, fn.node, argumentValues, frameWithProgram(caller, program, env, fn.name))
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
  const classNode = ts.isMethodDeclaration(fn.node) || ts.isGetAccessorDeclaration(fn.node) ? fn.node.parent : null
  if (classNode == null || !ts.isClassDeclaration(classNode)) return null
  return valueFromClassInstanceType('this', classNode, program)
}

function invokeInlineFunction(
  name: string,
  fn: ArrayCallbackFunction,
  argumentValues: (Value | undefined)[],
  caller: InterpreterFrame,
): Value {
  return invokeFunctionNode(name, fn, argumentValues, childFrame(caller, new Map(caller.env), name))
}

function invokeFunctionNode(
  name: string,
  fn: FitFunctionNode | ArrayCallbackFunction,
  argumentValues: (Value | undefined)[],
  frame: InterpreterFrame,
): Value {
  bindParameters(fn.parameters, argumentValues, frame)
  return evaluateFunctionNodeBody(name, fn, frame)
}

function evaluateFunctionNodeBody(
  name: string,
  fn: FitFunctionNode | ArrayCallbackFunction,
  frame: InterpreterFrame,
): Value {
  return evaluateFunctionNodeBodyResult(name, fn, frame).value
}

function evaluateFunctionNodeBodyResult(
  name: string,
  fn: FitFunctionNode | ArrayCallbackFunction,
  frame: InterpreterFrame,
): {value: Value; returnCases?: InterpreterReturnCase[]} {
  if (ts.isArrowFunction(fn) && ts.isExpression(fn.body)) return {value: evaluateReturnExpression(fn.body, fn, frame)}
  if (fn.body == null) return {value: noteUnsupported(frame, `Function ${name} has no body`, fn)}
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

function bindParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>, argumentValues: (Value | undefined)[], frame: InterpreterFrame) {
  for (let index = 0; index < parameters.length; index++) {
    const param = parameters[index]!
    const argument = argumentValues[index]
    const value = parameterDefaultValue(argument ?? null, param, frame)
    bindPattern(param.name, parameterValue(param, value, frame), frame)
  }
}

function parameterDefaultValue(argument: Value | null, param: ts.ParameterDeclaration, frame: InterpreterFrame): Value {
  if (argument == null) return param.initializer == null ? unknownParamPatternValue(param, frame) : evaluateExpression(param.initializer, frame)
  if (param.initializer == null) return argument
  return valueWithDefaultedUndefined(argument, evaluateExpression(param.initializer, frame))
}

function parameterValue(param: ts.ParameterDeclaration, value: Value, frame: InterpreterFrame): Value {
  const expr = ts.isIdentifier(param.name) ? param.name.text : param.name.getText(frame.program.sourceFile)
  return valueWithTypeFallback(value, valueFromTypeNode(expr, param.type, frame.program) ?? valueFromNodeType(expr, param.name, frame.program))
}

function unknownParamPatternValue(param: ts.ParameterDeclaration, frame: InterpreterFrame): Value {
  const expr = ts.isIdentifier(param.name) ? param.name.text : param.name.getText(frame.program.sourceFile)
  const shape = valueFromTypeNode(expr, param.type, frame.program) ?? valueFromNodeType(expr, param.name, frame.program)
  if (shape != null) return shape
  return unknown(`Parameter ${expr} needs a TypeScript type or an explicit @fit range`)
}

function bindPattern(name: ts.BindingName, value: Value, frame: InterpreterFrame) {
  if (ts.isIdentifier(name)) {
    frame.localBindings.add(name.text)
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
  if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) return evaluateForgettableWhileStatement(statement, frame)
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
  const shaped = valueWithTypeFallback(value, valueFromTypeNode(expr, declaration.type, frame.program) ?? valueFromNodeType(expr, declaration.name, frame.program))
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
  const shaped = valueWithTypeFallback(value, returnTypeValue(node, frame))
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
    }],
  }
}

function returnTypeValue(node: ts.Node, frame: InterpreterFrame): Value | null {
  const fn = ts.isFunctionLike(node) ? node : nearestFunctionLike(node)
  return fn == null ? null : valueFromFunctionReturnType('return', fn, frame.program)
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
  return frame.hooks?.evaluateClaim?.(claim, frame, evaluate) ?? evaluate()
}

function afterClaim(claim: InterpreterClaim, value: Value, frame: InterpreterFrame) {
  frame.hooks?.afterClaim?.(claim, value, frame)
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

  const thenFrame = branchFrame(frame, statement.expression, true, '<if-true>', evaluateExpression)
  const elseFrame = branchFrame(frame, statement.expression, false, '<if-false>', evaluateExpression)
  const thenFlow = evaluateConditionalBranchWithContinuation(statement.thenStatement, thenFrame, continuation, nextIndex)
  const elseFlow: InterpreterFlow = statement.elseStatement == null
    ? {kind: 'fallthrough'}
    : evaluateConditionalBranchWithContinuation(statement.elseStatement, elseFrame, continuation, nextIndex)
  if (thenFlow.kind !== 'fallthrough' && elseFlow.kind !== 'fallthrough') {
    return joinCompletedFlows(flowWithAssumptions(thenFlow, thenFrame.assumptions), flowWithAssumptions(elseFlow, elseFrame.assumptions), frame)
  }
  if (continuation != null) {
    if (thenFlow.kind !== 'fallthrough') {
      return joinCompletedFlows(flowWithAssumptions(thenFlow, thenFrame.assumptions), flowWithAssumptions(evaluateStatements(continuation, elseFrame, nextIndex), elseFrame.assumptions), frame)
    }
    if (elseFlow.kind !== 'fallthrough') {
      return joinCompletedFlows(flowWithAssumptions(evaluateStatements(continuation, thenFrame, nextIndex), thenFrame.assumptions), flowWithAssumptions(elseFlow, elseFrame.assumptions), frame)
    }
  }
  if (thenFlow.kind !== 'fallthrough') {
    const adopted = adoptFrameState(frame, elseFrame)
    if (adopted.kind === 'overflow') noteStateCaseBudget(frame, adopted)
    return {kind: 'fallthrough'}
  }
  if (elseFlow.kind !== 'fallthrough') {
    const adopted = adoptFrameState(frame, thenFrame)
    if (adopted.kind === 'overflow') noteStateCaseBudget(frame, adopted)
    return {kind: 'fallthrough'}
  }
  if (frame.loopStack.length > 0) {
    frame.env = joinBranchFrameEnvs(thenFrame, elseFrame)
    return {kind: 'fallthrough'}
  }
  const applied = setStateCases(frame, [
    ...stateCasesFromFrame(thenFrame).map(stateCase => labeledStateCase(stateCase, '<if-true>')),
    ...stateCasesFromFrame(elseFrame).map(stateCase => labeledStateCase(stateCase, '<if-false>')),
  ])
  if (applied.kind === 'overflow') noteStateCaseBudget(frame, applied)
  return {kind: 'fallthrough'}
}

function joinBranchFrameEnvs(left: InterpreterFrame, right: InterpreterFrame): Map<string, Value> {
  return joinFrameEnvs(envWithAssumptions(left.env, left.assumptions), envWithAssumptions(right.env, right.assumptions))
}

function adoptFrameState(target: InterpreterFrame, source: InterpreterFrame): StateCaseSetResult {
  if (hasStateCases(source)) {
    return setStateCases(target, stateCasesFromFrame(source))
  }
  target.env = source.env
  target.assumptions = source.assumptions
  delete target.stateCases
  return {kind: 'ok'}
}

function labeledStateCase(stateCase: InterpreterStateCase, label: string): InterpreterStateCase {
  return {
    env: stateCase.env,
    assumptions: stateCase.assumptions,
    label: stateCase.label ?? label,
  }
}

function flowWithAssumptions(flow: InterpreterFlow, assumptions: LinearConstraint[]): InterpreterFlow {
  if (flow.kind === 'return') return {kind: 'return', value: valueWithAssumptions(flow.value, assumptions)}
  if (flow.kind === 'return-cases') {
    return {
      kind: 'return-cases',
      cases: flow.cases.map(stateCase => ({
        ...stateCase,
        value: valueWithAssumptions(stateCase.value, assumptions),
        assumptions: mergeAssumptions(stateCase.assumptions, assumptions),
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
    }]
  }
  if (flow.kind === 'return-cases') return flow.cases
  return [{
    value: unknown(`Function ${frame.stack.at(-1) ?? '<unknown>'} did not return`),
    env: new Map(frame.env),
    assumptions: [...frame.assumptions],
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
  let value = valueWithAssumptions(first.value, first.assumptions)
  for (const stateCase of rest) value = joinValues(value, valueWithAssumptions(stateCase.value, stateCase.assumptions))
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

    const branch = switchLiteralFrame(frame, statement.expression, branchValues)
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
  return joinCompletedFlows(joined, evaluateStatements(continuation, switchLiteralFrame(frame, statement.expression, [...remaining.values()]), nextIndex), frame)
}

function switchCaseLiteralValues(statement: ts.SwitchStatement, frame: InterpreterFrame): Map<ts.CaseClause, LiteralPrimitive> | {error: string} {
  const values = new Map<ts.CaseClause, LiteralPrimitive>()
  for (const clause of statement.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue
    const value = evaluateExpression(clause.expression, frame)
    if (value.kind !== 'literal' || value.values.length !== 1) {
      return {error: `Switch case expected a finite literal: ${clause.expression.getText(frame.program.sourceFile)}`}
    }
    values.set(clause, value.values[0]!)
  }
  return values
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

function switchLiteralFrame(frame: InterpreterFrame, expression: ts.Expression, values: LiteralPrimitive[]): InterpreterFrame {
  const branch = childFrame(frame, new Map(frame.env), '<switch>')
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
  return frame.hooks?.evaluateLoop?.(claim, frame, evaluate) ?? evaluate()
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
  const item = source.element ?? unknown(`${sourceExpr}[] was not inferred`)
  try {
    const outcome = evaluateSymbolicLoop({
      claim,
      body,
      source,
      sourceExpr,
      sourceRoot: pathFromExpression(statement.expression, frame)?.root ?? null,
      sourceKind: 'collection',
      count: source.length,
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
  if (shape == null) return evaluateForgettableForStatement(statement, frame)
  if (!ts.isBlock(statement.statement)) return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loops support block bodies only', statement.statement)}
  const bound = evaluateIndexedForLoopBound(shape, frame)
  if ('error' in bound) return {kind: 'return', value: bound.error}
  if (!bound.length.isInteger || bound.length.min < 0) return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loop limit expected a non-negative integer', statement.condition ?? statement)}

  const body = statement.statement
  const scopedNames = [shape.indexName, ...blockScopedNames(body)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const length = indexedLoopLength(bound.length, bound.expression, frame)
  const indexValue = indexedElementPathValue(shape.indexName, length)
  frame.assumptions = mergeAssumptions(frame.assumptions, indexedElementAssumptions(indexValue, length))
  const loop = indexedForLoopContext(bound, length, frame)
  try {
    const outcome = evaluateSymbolicLoop({
      claim,
      body,
      source: loop.source,
      sourceExpr: loop.sourceExpr,
      sourceRoot: bound.origin == null ? null : pathFromExpression(shape.source.kind === 'array' ? shape.source.expression : bound.expression, frame)?.root ?? null,
      sourceKind: bound.origin == null ? 'count' : 'collection',
      count: length,
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
  const lower = comparisonConstraint(value, '>=', numberValue(0, 0, true, '0', linearConstant(0)))
  const upper = comparisonConstraint(value, '<', length)
  return [lower, upper].filter((fact): fact is LinearConstraint => fact != null)
}

function evaluateForgettableForStatement(statement: ts.ForStatement, frame: InterpreterFrame): InterpreterFlow {
  if (!isForgettableForStatement(statement)) {
    return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loops support for (let i = 0; i < limit; i++) style loops', statement)}
  }
  const roots = forgettableMutationRoots(statement.statement, frame.env)
  if (roots == null) return {kind: 'return', value: noteUnsupported(frame, `Unsupported for loop body: ${statement.statement.getText(frame.program.sourceFile)}`, statement.statement)}
  forgetRoots(frame.env, roots)
  return {kind: 'fallthrough'}
}

function evaluateForgettableWhileStatement(statement: ts.WhileStatement | ts.DoStatement, frame: InterpreterFrame): InterpreterFlow {
  if (!isForgettableReadExpression(statement.expression)) {
    return {kind: 'return', value: noteUnsupported(frame, `Unsupported while condition: ${statement.expression.getText(frame.program.sourceFile)}`, statement.expression)}
  }
  const roots = forgettableMutationRoots(statement.statement, frame.env)
  if (roots == null) return {kind: 'return', value: noteUnsupported(frame, `Unsupported while loop body: ${statement.statement.getText(frame.program.sourceFile)}`, statement.statement)}
  forgetRoots(frame.env, roots)
  return {kind: 'fallthrough'}
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
    length: source.length,
    expression: shape.source.lengthExpression,
    origin: {source, sourceExpr: sourceExpression(source, shape.source.expression, frame)},
  }
}

function indexedLoopLength(limit: NumberValue, expression: ts.Expression, frame: InterpreterFrame): NumberValue {
  const expr = limit.expr ?? expression.getText(frame.program.sourceFile)
  const min = Math.max(0, limit.min)
  const max = Math.max(0, limit.max)
  return numberValue(min, max, true, expr, limit.linear, null, limit.origin)
}

function bindForOfInitializer(initializer: ts.ForInitializer, value: Value, frame: InterpreterFrame) {
  if (ts.isVariableDeclarationList(initializer)) {
    const declaration = initializer.declarations[0]
    if (declaration == null || initializer.declarations.length !== 1) {
      noteUnsupported(frame, 'for..of supports one loop binding', initializer)
      return
    }
    const typed = valueFromNodeType(declaration.name.getText(frame.program.sourceFile), declaration.name, frame.program)
    bindPattern(declaration.name, valueWithTypeFallback(value, typed), frame)
    return
  }
  const path = pathFromExpression(initializer, frame)
  if (path == null) {
    noteUnsupported(frame, `Unsupported for..of assignment target ${initializer.getText(frame.program.sourceFile)}`, initializer)
    return
  }
  writePath(path, value, frame)
}

function evaluateExpression(expression: ts.Expression, frame: InterpreterFrame): Value {
  if (ts.isParenthesizedExpression(expression)) return evaluateExpression(expression.expression, frame)
  if (ts.isNonNullExpression(expression)) return evaluateNonNullExpression(expression, frame)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return evaluateExpression(expression.expression, frame)
  }

  const path = frame.hooks?.evaluatePath?.(expression, frame)
  if (path != null) return path

  const numeric = numericLiteralValue(expression)
  if (numeric != null) return numberValue(numeric, numeric, Number.isInteger(numeric), nodeText(expression, frame), linearConstant(numeric))
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
  if (constructorName != null && lengthBearingConstructorNames.has(constructorName)) {
    return evaluateLengthBearingNewExpression(expression, constructorName, frame)
  }
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
  if (expression.text === 'Infinity') return numberValue(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false, 'Infinity')
  const ambient = ambientIdentifierBound(expression, frame.program)
  if (ambient != null) return ambient
  return frame.env.get(expression.text) ?? noteUnsupported(frame, `Unknown identifier ${expression.text}`, expression)
}

function evaluatePropertyAccess(expression: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  if (ts.isIdentifier(expression.expression) && expression.expression.text === 'Math') {
    const value = evaluateMathProperty(expression.name.text, expression.getText(frame.program.sourceFile))
    if (value != null) return value
  }
  if (!hasQuestionDotToken(expression)) {
    const ambient = ambientPropertyBound(expression, frame.program)
    if (ambient != null) return ambient
  }
  const getter = classMemberFunctionForPropertyAccess(expression, frame)
  if (getter != null && ts.isGetAccessorDeclaration(getter.fn.node)) {
    const receiver = evaluateExpression(expression.expression, frame)
    const fallback = valueFromFunctionReturnType(expression.getText(frame.program.sourceFile), getter.fn.node, getter.program)
    const hooked = evaluateHookedCall({
      expression,
      callName: expression.getText(frame.program.sourceFile),
      program: getter.program,
      functionName: getter.functionName,
      fn: getter.fn,
      argumentValues: [],
      fallback,
      ...(getter.imported == null ? {} : {imported: getter.imported}),
      thisValue: receiver,
    }, frame)
    if (hooked != null) {
      applyFunctionCallEffects(functionEffects(getter.fn.node, getter.program), [], [], expression.expression, frame)
      return hooked
    }
    const value = valueWithTypeFallback(
      invokeFitFunction(getter.fn, [], frame, getter.program, rootFrame(getter.program).env, receiver),
      fallback,
    )
    applyFunctionCallEffects(functionEffects(getter.fn.node, getter.program), [], [], expression.expression, frame)
    return value
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
    && target.elements != null
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
  const lower = proveComparisonPlain(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), frame.assumptions)
  const upper = proveComparisonPlain(index, '<', target.length, frame.assumptions)
  if (lower.status !== 'pass' || upper.status !== 'pass') {
    return noteUnsupported(frame, `Array index ${formatRange(index)} was not proven inside length ${formatRange(target.length)}; prove 0 <= index < length or use a finite literal index`, expression.argumentExpression ?? expression)
  }
  if (expression.argumentExpression == null) return unknown('Element access without an index is unsupported')
  const sourceName = target.expr ?? expression.expression.getText(frame.program.sourceFile)
  const indexText = expression.argumentExpression.getText(frame.program.sourceFile)
  const accessExpr = `${sourceName}[${indexText}]`
  const adjacentFacts = adjacentElementAccessFacts(target, index, sourceName, indexText, accessExpr, frame.assumptions)
  if (adjacentFacts.length > 0) frame.assumptions = mergeAssumptions(frame.assumptions, adjacentFacts)
  const element = target.element == null
    ? valueFromNodeType(expression.getText(frame.program.sourceFile), expression, frame.program) ?? unknown(`${sourceName}[] was not inferred`)
    : valueWithRebasedElementPath(target.element, `${sourceName}[]`, accessExpr)
  addValueRangeAssumptions(element, frame)
  return element
}

function addValueRangeAssumptions(value: Value, frame: InterpreterFrame) {
  if (value.kind === 'number') {
    const lower = Number.isFinite(value.min)
      ? comparisonConstraint(value, '>=', numberValue(value.min, value.min, Number.isInteger(value.min), String(value.min), linearConstant(value.min)), undefined, 'code')
      : null
    const upper = Number.isFinite(value.max)
      ? comparisonConstraint(value, '<=', numberValue(value.max, value.max, Number.isInteger(value.max), String(value.max), linearConstant(value.max)), undefined, 'code')
      : null
    frame.assumptions = mergeAssumptions(frame.assumptions, lower == null ? [] : [lower], upper == null ? [] : [upper])
    return
  }
  if (value.kind === 'object') {
    for (const prop of value.props.values()) addValueRangeAssumptions(prop, frame)
    return
  }
  if (value.kind === 'array') {
    addValueRangeAssumptions(value.length, frame)
    if (value.element != null) addValueRangeAssumptions(value.element, frame)
    return
  }
  if (value.kind === 'nullable') addValueRangeAssumptions(value.present, frame)
}

function finiteArrayElementAccess(target: Value, index: Value, expression: ts.ElementAccessExpression, frame: InterpreterFrame): Value | null {
  if (target.kind === 'nullable') return finiteArrayElementAccess(target.present, index, expression, frame)
  const elements = target.kind === 'array' ? tupleElements(target) : null
  if (elements == null || index.kind !== 'number' || index.cases == null) return null
  let result: Value | null = null
  for (const branch of numberBranches(index)) {
    const choice = exactInteger(branch.value)
    if (choice == null) return null
    const value = elements[choice]
    if (value == null) return noteUnsupported(frame, `Array index ${choice} was outside ${expression.expression.getText(frame.program.sourceFile)}`, expression.argumentExpression ?? expression)
    const branchValue = valueWithAssumptions(value, branch.assumptions)
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
  return {kind: 'object', props, expr: expression.getText(frame.program.sourceFile)}
}

function objectPropertyPath(frame: InterpreterFrame, propertyName: string): string[] {
  return [...(frame.objectPath ?? []), propertyName]
}

function evaluateArrayLiteral(expression: ts.ArrayLiteralExpression, frame: InterpreterFrame): Value {
  let length = numberValue(0, 0, true, '0', linearConstant(0))
  let elements: Value[] | null = []
  let element: Value | null = null
  for (const item of expression.elements) {
    if (ts.isSpreadElement(item)) {
      const spread = evaluateExpression(item.expression, frame)
      if (spread.kind === 'array') {
        length = addNumbers(length, spread.length)
        elements = elements == null || spread.elements == null ? null : [...elements, ...spread.elements]
        if (spread.element != null) element = mergeElementValue(element, spread.element)
        continue
      }
      noteUnsupported(frame, `Array spread expected an array: ${item.getText(frame.program.sourceFile)}`, item)
      continue
    }
    const value = evaluateExpression(item, frame)
    length = addNumbers(length, numberValue(1, 1, true, '1', linearConstant(1)))
    if (elements != null) elements.push(value)
    element = mergeElementValue(element, value)
  }
  if (elements != null) {
    length = numberValue(elements.length, elements.length, true, String(elements.length), linearConstant(elements.length))
  }
  return {
    kind: 'array',
    layout: elements == null ? 'collection' : 'tuple',
    length,
    elements,
    element,
    expr: expression.getText(frame.program.sourceFile),
    summary: null,
  }
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
    return negateNumber(value, `-${value.expr ?? expression.operand.getText(frame.program.sourceFile)}`)
  }
  return noteUnsupported(frame, `Unsupported unary expression ${expression.getText(frame.program.sourceFile)}`, expression)
}

// ++x / x++ / --x / x-- are assignments: the write must land even when the old
// value is not numeric. Prefix forms evaluate to the new value, postfix to the old.
function evaluateIncrementDecrement(expression: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression, frame: InterpreterFrame): Value {
  const path = pathFromExpression(expression.operand, frame)
  if (path == null) {
    const value = noteUnsupported(frame, `Unsupported update target ${expression.operand.getText(frame.program.sourceFile)}`, expression)
    havocRoots(frame, expressionRootNames(expression.operand, []))
    return value
  }
  const old = readPath(path, frame, expression)
  const one = numberValue(1, 1, true, '1', linearConstant(1))
  const next = old.kind === 'number'
    ? expression.operator === ts.SyntaxKind.PlusPlusToken ? addNumbers(old, one) : subtractNumbers(old, one)
    : noteUnsupported(frame, `Update ${expression.getText(frame.program.sourceFile)} expected a number`, expression)
  if (assignmentHasExternalEffect(path, frame)) {
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
  const leftValues = truthinessValues(evaluateExpression(expression.left, frame))
  if (leftValues == null) return noteUnsupported(frame, `Logical expression ${expression.getText(frame.program.sourceFile)} expected boolean-like values`, expression)
  const rightValues = truthinessValues(evaluateExpression(expression.right, frame))
  if (rightValues == null) return noteUnsupported(frame, `Logical expression ${expression.getText(frame.program.sourceFile)} expected boolean-like values`, expression)
  const values: boolean[] = []
  for (const left of leftValues) {
    for (const right of rightValues) {
      values.push(expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? left && right : left || right)
    }
  }
  return literalValue(uniqueBooleanValues(values), expression.getText(frame.program.sourceFile))
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
  const issueCount = frame.issues.length
  const values = truthinessValues(evaluateExpression(expression, frame))
  if (values != null) return values
  if (frame.issues.length === issueCount) noteUnsupported(frame, `${label} ${nodeText(expression, frame)} expected boolean-like values`, expression)
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
  if (left.kind === 'nullable') return joinValues(left.present, evaluateExpression(expression.right, frame))
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
  const plain = evaluatePlainNumberBinary(kind, left, right, frame, expression)
  if (plain.kind !== 'number') return plain
  return withNumberCases(plain, combineNumberCases(left, right, (leftCase, rightCase) =>
    evaluatePlainNumberBinary(kind, leftCase, rightCase, frame, expression)))
}

function evaluatePlainNumberBinary(
  kind: ts.SyntaxKind,
  left: NumberValue,
  right: NumberValue,
  frame: InterpreterFrame,
  expression: ts.Expression,
): Value {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
      return addNumbers(left, right)
    case ts.SyntaxKind.MinusToken:
      return subtractNumbers(left, right)
    case ts.SyntaxKind.AsteriskToken:
      return multiplyNumbers(left, right)
    case ts.SyntaxKind.SlashToken:
      return divideNumbers(left, right)
    case ts.SyntaxKind.PercentToken: {
      const result = moduloNumbers(left, right)
      if (result.kind === 'number' && result.linear != null && right.linear != null) {
        const upper = comparisonConstraint(result, '<', right, `${result.expr} < ${right.expr}`)
        if (upper != null) frame.assumptions = mergeAssumptions(frame.assumptions, [upper])
      }
      return result
    }
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return powerNumbers(left, right)
    default:
      return noteUnsupported(frame, `Unsupported numeric operator ${expression.getText(frame.program.sourceFile)}`, expression)
  }
}

function evaluateAssignmentExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const path = pathFromExpression(expression.left, frame)
  if (path == null) {
    const value = noteUnsupported(frame, `Unsupported assignment target ${expression.left.getText(frame.program.sourceFile)}`, expression.left)
    evaluateExpression(expression.right, frame)
    havocRoots(frame, expressionRootNames(expression.left, []))
    return value
  }
  const right = evaluateExpression(expression.right, frame)
  const value = assignedValue(expression.operatorToken.kind, path, right, frame, expression)
  if (assignmentHasExternalEffect(path, frame)) {
    noteEffect(frame, `assignment mutates ${valuePathExpression(path)}: ${expression.getText()}`, expression)
  }
  writePath(path, value, frame)
  return value
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
    if (frame.env.has(name)) forgetRoot(frame.env, name)
  }
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
  if (effects.mutatesThis) {
    if (receiverExpression != null) havocRoots(frame, expressionRootNames(receiverExpression, []))
    else havocRoots(frame, ['this'])
  }
  const hasSpread = argumentExpressions.some(argument => ts.isSpreadElement(argument))
  for (const index of effects.mutatesParams) {
    const rest = parameters[index]?.dotDotDotToken != null
    const targets = hasSpread
      ? argumentExpressions
      : rest
        ? argumentExpressions.slice(index)
        : argumentExpressions[index] == null ? [] : [argumentExpressions[index]]
    for (const argument of targets) {
      havocRoots(frame, expressionRootNames(ts.isSpreadElement(argument) ? argument.expression : argument, []))
    }
  }
  for (const key of effects.writesOuter) {
    const root = outerWriteRoot(key, frame.program.sourceId)
    if (root != null) havocRoots(frame, [root])
  }
}

// Inline callbacks run per element on a copy of the caller's environment, so
// reads stay precise; writes to captured locals and mutations of the elements
// fed through the callback's parameters are applied here instead.
function applyInlineCallbackEffects(callbackFn: FunctionLikeNode, receiverExpression: ts.Expression | null, frame: InterpreterFrame): FunctionEffects {
  const effects = functionEffects(callbackFn, frame.program)
  applyFunctionCallEffects(effects, [], callbackFn.parameters, null, frame)
  if (effects.mutatesParams.size > 0 && receiverExpression != null) {
    havocRoots(frame, expressionRootNames(receiverExpression, []))
  }
  return effects
}

// The array value read before the callback ran: its length is still exact
// (element mutation cannot change it), but element facts belong to the first
// iteration only once the callback mutates its parameters.
function sourceAfterCallback(source: ArrayValue, effects: FunctionEffects): ArrayValue {
  if (effects.mutatesParams.size === 0) return source
  return {...source, elements: null, element: null, summary: null}
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
  frame: InterpreterFrame,
) {
  const havocAllInputs = () => {
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      havocRoots(frame, expressionRootNames(target.expression, []))
    }
    expression.arguments.forEach((argument, index) => {
      const argumentExpression = ts.isSpreadElement(argument) ? argument.expression : argument
      if (isInlineFunction(unwrapExpression(argumentExpression))) return
      if (valueCanBeMutated(argumentValues[index])) havocRoots(frame, expressionRootNames(argumentExpression, []))
    })
  }
  havocAllInputs()
  for (const argument of expression.arguments) {
    const argumentExpression = unwrapExpression(ts.isSpreadElement(argument) ? argument.expression : argument)
    const callback = passedFunctionNode(argumentExpression, frame)
    if (callback == null) continue
    const callbackEffects = functionEffects(callback, frame.program)
    applyFunctionCallEffects(callbackEffects, [], callback.parameters, null, frame)
    if (callbackEffects.mutatesParams.size > 0) havocAllInputs()
  }
}

function passedFunctionNode(expression: ts.Expression, frame: InterpreterFrame): FunctionLikeNode | null {
  if (isInlineFunction(expression)) return expression
  if (!ts.isIdentifier(expression)) return null
  const resolved = resolveCallTarget(expression, frame.program)
  return resolved.kind === 'function' ? resolved.fn.node : null
}

function userBindingForCallTarget(target: ts.Expression, frame: InterpreterFrame): boolean {
  if (!ts.isIdentifier(target)) return false
  if (frame.env.has(target.text)) return true
  return resolveCallTarget(target, frame.program).kind === 'function'
}

function assignmentHasExternalEffect(path: ValuePath, frame: InterpreterFrame) {
  return path.segments.length > 0 || !frame.localBindings.has(path.root)
}

function evaluateCompoundPlus(path: ValuePath, right: Value, frame: InterpreterFrame, expression: ts.Expression): Value {
  const left = readPath(path, frame, expression)
  if (left.kind !== 'number' || right.kind !== 'number') return stringishCompoundPlus(left, right, expression) ?? noteUnsupported(frame, `Compound assignment ${expression.getText(frame.program.sourceFile)} expected numbers`, expression)
  return addNumbers(left, right)
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
  const direct = proveComparisonPlain(left, op.op, right, frame.assumptions)
  if (direct.status === 'pass') return op.negated ? false : true
  if (direct.status === 'fail') return op.negated ? true : false
  return null
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
  const extentEnd = evaluateExtentEndConditional(expression, frame)
  if (extentEnd != null) return extentEnd
  auditConditionalSelector(expression, auditReadFrame(frame), evaluateExpression)
  const truthValues = evaluateConditionTruthiness(expression.condition, frame, 'Conditional expression')
  if (truthValues == null) return unknown(`Unsupported conditional condition: ${nodeText(expression.condition, frame)}`)
  const truth = singleBooleanValue(truthValues)
  if (truth === true) return evaluateExpression(expression.whenTrue, frame)
  if (truth === false) return evaluateExpression(expression.whenFalse, frame)
  const trueFrame = branchFrame(frame, expression.condition, true, '<conditional-true>', evaluateExpression)
  const falseFrame = branchFrame(frame, expression.condition, false, '<conditional-false>', evaluateExpression)
  return joinValues(
    valueWithAssumptions(evaluateExpression(expression.whenTrue, trueFrame), trueFrame.assumptions),
    valueWithAssumptions(evaluateExpression(expression.whenFalse, falseFrame), falseFrame.assumptions),
  )
}

function auditReadFrame(frame: InterpreterFrame): InterpreterFrame {
  return {
    program: frame.program,
    env: new Map(frame.env),
    issues: [],
    effects: [],
    audits: frame.audits,
    stack: frame.stack,
    activeCalls: new Set(frame.activeCalls),
    localBindings: new Set(frame.localBindings),
    loopStack: [...frame.loopStack],
    conditionalDepth: frame.conditionalDepth,
    assumptions: [...frame.assumptions],
    ...(frame.hooks == null ? {} : {hooks: frame.hooks}),
    ...(frame.objectPath == null ? {} : {objectPath: [...frame.objectPath]}),
  }
}

function evaluateExtentEndConditional(expression: ts.ConditionalExpression, frame: InterpreterFrame): NumberValue | null {
  const condition = arrayLengthZeroCondition(expression.condition, frame)
  if (condition == null) return null

  const trueValue = evaluateExpression(expression.whenTrue, frame)
  const falseValue = evaluateExpression(expression.whenFalse, frame)
  if (trueValue.kind !== 'number' || falseValue.kind !== 'number') return null

  const emptyValue = condition.emptyWhenTrue ? trueValue : falseValue
  if (emptyValue.expr == null) return null
  return extentEndSummaryValue(condition.array, emptyValue.expr)
}

function arrayLengthZeroCondition(expression: ts.Expression, frame: InterpreterFrame): {array: ArrayValue; emptyWhenTrue: boolean} | null {
  if (!ts.isBinaryExpression(expression)) return null
  const leftLength = arrayFromLengthExpression(expression.left, frame)
  const rightLength = arrayFromLengthExpression(expression.right, frame)
  const leftZero = numericLiteralValue(expression.left) === 0
  const rightZero = numericLiteralValue(expression.right) === 0
  const op = expression.operatorToken.kind

  if (leftLength != null && rightZero && (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)) return {array: leftLength, emptyWhenTrue: true}
  if (rightLength != null && leftZero && (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)) return {array: rightLength, emptyWhenTrue: true}
  if (leftLength != null && rightZero && op === ts.SyntaxKind.GreaterThanToken) return {array: leftLength, emptyWhenTrue: false}
  if (rightLength != null && leftZero && op === ts.SyntaxKind.LessThanToken) return {array: rightLength, emptyWhenTrue: false}
  return null
}

function arrayFromLengthExpression(expression: ts.Expression, frame: InterpreterFrame): ArrayValue | null {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'length') return null
  const value = evaluateExpression(expression.expression, frame)
  return value.kind === 'array' ? value : null
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
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'Math') {
    return evaluateMathCall(target.name.text, evaluatedArguments(expression.arguments, frame), frame, expression)
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'push') return evaluatePushCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target)) {
    const mutation = evaluateArrayMutationCall(expression, target, frame)
    if (mutation != null) return mutation
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'at') return evaluateArrayAtCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'map') return evaluateMapCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'filter') return evaluateFilterCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'every') return evaluateEverySomeCall(expression, target, 'every', frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'some') return evaluateEverySomeCall(expression, target, 'some', frame)
  if (isInlineFunction(target)) {
    const result = invokeInlineFunction('<iife>', target, evaluatedArguments(expression.arguments, frame), frame)
    applyFunctionCallEffects(functionEffects(target, frame.program), expression.arguments, target.parameters, null, frame)
    return result
  }
  if (ts.isPropertyAccessExpression(target)) {
    const member = classMemberFunctionForPropertyAccess(target, frame)
    if (member != null && ts.isMethodDeclaration(member.fn.node)) {
      const receiver = evaluateExpression(target.expression, frame)
      return evaluateResolvedFunctionCall(expression, target.getText(frame.program.sourceFile), {
        kind: 'function',
        program: member.program,
        functionName: member.functionName,
        fn: member.fn,
        ...(member.imported == null ? {} : {imported: member.imported}),
      }, fallback(), frame, receiver, target.expression)
    }
  }
  const resolved = resolveCallTarget(target, frame.program)
  if (resolved.kind === 'math') {
    return evaluateMathCall(resolved.name, evaluatedArguments(expression.arguments, frame), frame, expression)
  }
  if (resolved.kind === 'function') return evaluateResolvedFunctionCall(expression, target.getText(frame.program.sourceFile), resolved, fallback(), frame)
  // Calls into real platform globals (console.log, JSON.stringify, ...) read
  // but never write caller state; everything else unseen gets the unknown-call
  // treatment.
  const pureGlobal = ts.isPropertyAccessExpression(target)
    && ts.isIdentifier(target.expression)
    && isPureGlobalMemberCall(target.expression.text, target.name.text)
  const argumentValues = evaluatedArguments(expression.arguments, frame)
  if (!pureGlobal) applyUnknownCallEffects(expression, target, argumentValues, frame)
  const unresolvedFallback = fallback()
  if (unresolvedFallback?.kind === 'object' || unresolvedFallback?.kind === 'array') return unresolvedFallback
  return noteUnsupported(frame, resolved.reason, expression)
}

function evaluateArrayMutationCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value | null {
  if (target.name.text !== 'reverse' && target.name.text !== 'sort' && target.name.text !== 'splice') return null
  if (!expression.arguments.every(isSideEffectFreeExpression)) {
    // The mutation still happens at runtime; forget the receiver before giving up.
    havocRoots(frame, expressionRootNames(target.expression, []))
    return noteUnsupported(frame, `Unsupported array mutation arguments: ${expression.getText(frame.program.sourceFile)}`, expression)
  }
  const path = pathFromExpression(target.expression, frame)
  if (path == null) {
    havocRoots(frame, expressionRootNames(target.expression, []))
    return noteUnsupported(frame, `Unsupported array mutation target ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  }
  const current = readPath(path, frame, target.expression)
  if (current.kind !== 'array') {
    havocRoots(frame, expressionRootNames(target.expression, []))
    return noteUnsupported(frame, `${target.name.text} expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  }
  noteEffect(frame, `${target.name.text} mutates ${valuePathExpression(path)}: ${expression.getText()}`, expression)
  if (target.name.text === 'splice') {
    forgetRoot(frame.env, path.root)
    return unknownArray(expression.getText(frame.program.sourceFile))
  }
  const next = {...current, elements: null, summary: null}
  writeMutationPath(path, next, frame)
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
    functionEffects(target.fn.node, target.program),
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
  const argumentValues = evaluatedArguments(expression.arguments, frame)
  const hooked = evaluateHookedCall({
    expression,
    callName,
    program: target.program,
    functionName: target.functionName,
    fn: target.fn,
    argumentValues,
    fallback,
    ...(target.imported == null ? {} : {imported: target.imported}),
    ...(thisValue == null ? {} : {thisValue}),
  }, frame)
  if (hooked != null) return hooked
  const callKey = `${target.program.sourceId}#${target.functionName}`
  if (frame.activeCalls.has(callKey)) {
    const unsupported = noteUnsupported(frame, `Recursive helper inlining is unsupported at ${target.functionName}`, expression)
    return fallback ?? unsupported
  }
  return valueWithTypeFallback(
    invokeFitFunction(target.fn, argumentValues, frameWithActiveCall(frame, callKey), target.program, rootFrame(target.program, frame.hooks).env, thisValue),
    fallback,
  )
}

function evaluateHookedCall(call: InterpreterCall, frame: InterpreterFrame): Value | null {
  return frame.hooks?.evaluateCall?.(call, frame) ?? null
}

function evaluateArrayAtCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const receiver = evaluateExpression(target.expression, frame)
  if (receiver.kind !== 'array') return noteUnsupported(frame, 'Array.at expected an array', target.expression)
  const offset = expression.arguments.length === 1 ? numericLiteralValue(expression.arguments[0]!) : null
  if (offset == null || !Number.isInteger(offset) || offset >= 0) return noteUnsupported(frame, 'Array.at only supports constant negative indexes', expression.arguments[0] ?? expression)

  const requiredLength = -offset
  if (receiver.length.min < requiredLength) return noteUnsupported(frame, `Array.at(${offset}) expected length >= ${requiredLength}`, expression)
  const elements = tupleElements(receiver)
  if (elements != null) {
    const value = elements[elements.length + offset]
    return value ?? noteUnsupported(frame, `Array.at(${offset}) has no matching element`, expression)
  }
  return receiver.element ?? noteUnsupported(frame, `Array.at(${offset}) element values are not tracked`, expression)
}

function evaluatePushCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const path = pathFromExpression(target.expression, frame)
  if (path == null) return noteUnsupported(frame, `Unsupported push target ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const current = readPath(path, frame, target.expression)
  if (current.kind !== 'array') return noteUnsupported(frame, `push expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  noteEffect(frame, `push mutates ${valuePathExpression(path)}: ${expression.getText()}`, expression)
  const loop = currentLoop(frame)
  if (loop?.mode === 'symbolic' && expression.arguments.length !== 1) return noteUnsupported(frame, 'Abstract loop push supports one item per iteration', expression)
  const values = evaluatedArguments(expression.arguments, frame)
  const elements = current.elements == null ? [] : [...current.elements]
  elements.push(...values)
  let element: Value | null = current.element
  for (const value of values) element = mergeElementValue(element, value)
  const symbolicLength = loop?.mode === 'symbolic' ? symbolicLoopAppendLength(current, loop) : null
  const nextLength = current.elements == null
    ? numberValue(current.length.min + values.length, current.length.max + values.length, true, `${current.expr ?? target.expression.getText(frame.program.sourceFile)}.length`)
    : numberValue(elements.length, elements.length, true, `${current.expr ?? target.expression.getText(frame.program.sourceFile)}.length`, linearConstant(elements.length))
  if (loop?.mode === 'symbolic' && path.segments.length === 0) {
    loop.appends.push({
      arrayName: path.root,
      element: values[0] ?? null,
      base: current,
    })
  }
  const next: ArrayValue = {
    ...current,
    length: symbolicLength ?? nextLength,
    elements: loop?.mode === 'symbolic' ? null : elements,
    element,
    summary: mergeArraySummary(current.summary, currentLoopPushSummary(frame)),
  }
  writeMutationPath(path, next, frame)
  return next.length
}

function symbolicLoopAppendLength(current: ArrayValue, loop: LoopFrame): NumberValue {
  if (current.length.min === 0 && current.length.max === 0) return loop.source.length
  return addNumbers(current.length, loop.source.length)
}

function currentLoop(frame: InterpreterFrame) {
  return frame.loopStack.at(-1) ?? null
}

function currentLoopPushSummary(frame: InterpreterFrame) {
  const loop = currentLoop(frame)
  if (loop == null) return null
  const origin = frame.conditionalDepth > 0
    ? filterOrigin(loop.source, loop.sourceExpr)
    : mapOrigin(loop.source, loop.sourceExpr)
  return emptyArraySummary(origin)
}

function evaluateEverySomeCall(
  expression: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  kind: 'every' | 'some',
  frame: InterpreterFrame,
): Value {
  const source = evaluateExpression(target.expression, frame)
  if (source.kind !== 'array') return noteUnsupported(frame, `${kind} expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, `${kind} callback must be an inline function`, callback ?? expression)
  const text = expression.getText(frame.program.sourceFile)
  if (source.length.max === 0) return literalValue([kind === 'every'], text)
  const callbackEffects = applyInlineCallbackEffects(callbackFn, target.expression, frame)
  const effectiveSource = sourceAfterCallback(source, callbackEffects)
  const sourceExpr = sourceExpression(effectiveSource, target.expression, frame)
  const item = effectiveSource.element ?? unknown(`${sourceExpr}[] was not inferred`)
  const index = indexedElementPathValue(`${kind}Index(${sourceExpr})`, effectiveSource.length)
  const raw = invokeInlineFunction(`<${kind}-predicate>`, callbackFn, [item, index, effectiveSource], frame)
  const refined = valueWithAssumptions(raw, indexedElementAssumptions(index, effectiveSource.length))
  const truth = truthinessValues(refined)
  if (truth == null) return literalValue([true, false], text)
  if (truth.every(value => value === true)) {
    if (kind === 'every') return literalValue([true], text)
    if (effectiveSource.length.min >= 1) return literalValue([true], text)
    return literalValue([true, false], text)
  }
  if (truth.every(value => value === false)) {
    if (kind === 'some') return literalValue([false], text)
    if (effectiveSource.length.min >= 1) return literalValue([false], text)
    return literalValue([true, false], text)
  }
  return literalValue([true, false], text)
}

function evaluateMapCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const source = evaluateExpression(target.expression, frame)
  if (source.kind !== 'array') return noteUnsupported(frame, `map expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, 'map callback must be an inline function', callback ?? expression)
  // Apply captured-write effects before the representative element run: later
  // iterations observe earlier mutations, so the representative must read the
  // already-forgotten state.
  const callbackEffects = applyInlineCallbackEffects(callbackFn, target.expression, frame)
  const effectiveSource = sourceAfterCallback(source, callbackEffects)
  const sourceExpr = sourceExpression(effectiveSource, target.expression, frame)
  const abstractElement = evaluateMapElement(effectiveSource, sourceExpr, callbackFn, frame)
  // A pure field rename keeps the rows' adjacency story: the same facts hold
  // under the output names. This is how other field vocabularies reach the
  // catalog: rows.map(row => ({top: row.y, height: row.size})).
  const renamed = projectSummaryThroughRename(effectiveSource.summary, callbackFn)
  return {
    kind: 'array',
    layout: 'collection',
    length: effectiveSource.length,
    elements: null,
    element: abstractElement,
    expr: expression.getText(frame.program.sourceFile),
    summary: mergeArraySummary(emptyArraySummary(mapOrigin(effectiveSource, sourceExpr)), renamed),
  }
}

type RenamePair = {inputPath: string[]; outputPath: string[]}

// The output-field → input-field mapping of a callback that only relabels:
// every property initializer is a property chain on the element parameter
// (recursively through nested object literals). Computed fields are simply
// unmapped; a spread hides the field set, so nothing maps.
function pureRenamePairs(callbackFn: FunctionLikeNode): RenamePair[] | null {
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

function singleReturnExpression(callbackFn: FunctionLikeNode): ts.Expression | null {
  if (callbackFn.body == null || !ts.isBlock(callbackFn.body) || callbackFn.body.statements.length !== 1) return null
  const statement = callbackFn.body.statements[0]!
  return ts.isReturnStatement(statement) ? statement.expression ?? null : null
}

function projectSummaryThroughRename(summary: ArraySummary | null, callbackFn: FunctionLikeNode): ArraySummary | null {
  if (summary == null) return null
  const pairs = pureRenamePairs(callbackFn)
  if (pairs == null || pairs.length === 0) return null
  const renameOutput = (inputPath: string[]): string[] | null =>
    pairs.find(pair => samePathParts(pair.inputPath, inputPath))?.outputPath ?? null

  const projected: ArraySummary = {relations: [], advances: [], lastEnd: null, extentEnds: []}
  for (const relation of summary.relations) {
    const left = renameOutput(relation.left.path)
    const terms = relation.right.terms.map(term => {
      const path = renameOutput(term.path)
      return path == null ? null : {...term, path}
    })
    if (left == null || terms.some(term => term == null)) continue
    projected.relations.push({
      ...relation,
      left: {...relation.left, path: left},
      right: {...relation.right, terms: terms as typeof relation.right.terms},
    })
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

function evaluateMapElement(source: ArrayValue, sourceExpr: string, callbackFn: ArrayCallbackFunction, frame: InterpreterFrame): Value | null {
  const item = source.element ?? unknown(`${sourceExpr}[] was not inferred`)
  const index = indexedElementPathValue(`mapIndex(${sourceExpr})`, source.length)
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
  return valueWithAssumptions(value, indexedElementAssumptions(index, source.length))
}

function evaluateFilterCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const source = evaluateExpression(target.expression, frame)
  if (source.kind !== 'array') return noteUnsupported(frame, `filter expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, 'filter callback must be an inline function', callback ?? expression)
  const callbackEffects = applyInlineCallbackEffects(callbackFn, target.expression, frame)
  const effectiveSource = sourceAfterCallback(source, callbackEffects)
  const sourceExpr = sourceExpression(effectiveSource, target.expression, frame)
  const element = filteredElement(effectiveSource, sourceExpr, callbackFn, frame)
  const summary = emptyArraySummary(filterOrigin(effectiveSource, sourceExpr))
  const text = expression.getText(frame.program.sourceFile)
  const length = filteredLength(effectiveSource, callbackFn, frame, text)
  addLengthAtMostSourceFact(length, effectiveSource.length, frame)
  return {
    kind: 'array',
    layout: 'collection',
    length,
    elements: null,
    element,
    expr: text,
    summary,
  }
}

function addLengthAtMostSourceFact(length: NumberValue, sourceLength: NumberValue, frame: InterpreterFrame) {
  const fact = comparisonConstraint(length, '<=', sourceLength, `${length.expr ?? 'length'} <= ${sourceLength.expr ?? 'source length'}`)
  if (fact != null) frame.assumptions = mergeAssumptions(frame.assumptions, [fact])
}

function filteredLength(source: ArrayValue, callbackFn: ArrayCallbackFunction, frame: InterpreterFrame, text: string): NumberValue {
  const fallback = numberValue(0, source.length.max, true, `${text}.length`)
  if (source.length.max === 0) return numberValue(0, 0, true, `${text}.length`)
  const sourceExpr = source.expr ?? text
  const item = source.element ?? unknown(`${sourceExpr}[] was not inferred`)
  const index = indexedElementPathValue(`filterIndex(${sourceExpr})`, source.length)
  const raw = invokeInlineFunction('<filter-predicate>', callbackFn, [item, index, source], frame)
  const refined = valueWithAssumptions(raw, indexedElementAssumptions(index, source.length))
  const truth = truthinessValues(refined)
  if (truth == null) return fallback
  if (truth.every(value => value === true)) {
    return numberValue(source.length.min, source.length.max, true, `${text}.length`, source.length.linear)
  }
  if (truth.every(value => value === false)) {
    return numberValue(0, 0, true, `${text}.length`)
  }
  return fallback
}

function filteredElement(source: ArrayValue, sourceExpr: string, callbackFn: ArrayCallbackFunction, frame: InterpreterFrame): Value | null {
  const predicate = callbackPredicateExpression(callbackFn)
  if (predicate == null || !isSideEffectFreeExpression(predicate)) return source.element
  const element = source.element ?? unknown(`${sourceExpr}[] was not inferred`)
  const callbackFrame = childFrame(frame, new Map(frame.env), '<filter-predicate>')
  bindParameters(callbackFn.parameters, [element, undefined, source], callbackFrame)
  const itemName = firstIdentifierParameterName(callbackFn)
  if (itemName == null) return source.element
  const trueFrame = branchFrame(callbackFrame, predicate, true, '<filter-true>', evaluateExpression)
  const refined = trueFrame.env.get(itemName)
  return refined == null ? source.element : valueWithAssumptions(refined, trueFrame.assumptions)
}

function callbackPredicateExpression(callbackFn: ArrayCallbackFunction): ts.Expression | null {
  if (ts.isArrowFunction(callbackFn) && ts.isExpression(callbackFn.body)) return callbackFn.body
  if (callbackFn.body == null || !ts.isBlock(callbackFn.body) || callbackFn.body.statements.length !== 1) return null
  const statement = callbackFn.body.statements[0]!
  return ts.isReturnStatement(statement) ? statement.expression ?? null : null
}

function firstIdentifierParameterName(callbackFn: ArrayCallbackFunction): string | null {
  const first = callbackFn.parameters[0]
  return first != null && ts.isIdentifier(first.name) ? first.name.text : null
}

function sourceExpression(source: ArrayValue, expression: ts.Expression, frame: InterpreterFrame): string {
  return source.expr ?? expression.getText(frame.program.sourceFile)
}

function evaluatedArguments(args: ts.NodeArray<ts.Expression>, frame: InterpreterFrame): Value[] {
  return args.map(arg => evaluateExpression(arg, frame))
}

function pathFromExpression(expression: ts.Expression, frame: InterpreterFrame): ValuePath | null {
  return pathFromSourceExpression(expression, indexExpression => evaluateExpression(indexExpression, frame))
}

function isInlineFunction(expression: ts.Expression): expression is ArrayCallbackFunction {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
}

function nodeText(node: ts.Node, frame: InterpreterFrame) {
  return node.getSourceFile() === frame.program.sourceFile
    ? node.getText(frame.program.sourceFile)
    : node.getText()
}
