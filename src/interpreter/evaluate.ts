import * as ts from 'typescript'
import {
  ambientIdentifierFact,
  ambientPropertyFact,
} from '../ambient-facts.ts'
import type {
  ArrayCallbackFunction,
  ImportedBinding,
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
  mergeAssumptions,
  literalValue,
  mergeArraySummary,
  mergeElementValue,
  moduloNumbers,
  multiplyNumbers,
  numberBranches,
  nullValue,
  nullableValue,
  numberValue,
  powerNumbers,
  subtractNumbers,
  tupleElements,
  unknown,
  unknownArray,
  unknownNumber,
  unknownObject,
  valueWithAssumptions,
  valueWithDefaultedUndefined,
  withNumberCases,
  type ArrayValue,
  type LinearConstraint,
  type LiteralPrimitive,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {combineNumberCases} from '../guarded-facts.ts'
import {
  adjacentElementAccessFacts,
  valueWithRebasedElementPath,
} from '../indexed-facts.ts'
import {
  applySegmentedStackCursorUpdate,
  conditionalPushLength,
  indexedElementPathValue,
  loopElementFromPush,
  pushedElementValue,
  segmentedStackElement,
  segmentedStackSummary,
  type GuardedLoopPush,
  type LoopExtremum,
} from '../loop-summary.ts'
import {readGuardedLoopPushes, type LoopSourceContext} from '../loop-source.ts'
import {
  linearConstant,
  numericLiteralValue,
  sameExpressionText,
} from '../linear.ts'
import {functionHasInstanceThisInput} from '../function-shape.ts'
import {type FitFunction, type FitFunctionNode} from '../modules.ts'
import {
  valueFromCallReturnShape,
  valueFromFunctionReturnShape,
  valueFromSyntaxTypeShape,
  valueWithStructuralFallback,
} from '../shapes.ts'
import {localizeContainerLiteralValue, localizeValue} from '../value-localize.ts'
import {
  childFrame,
  frameWithActiveCall,
  frameWithProgram,
  joinFrameEnvs,
  noteUnsupported,
  rootFrame,
  type InterpreterCall,
  type InterpreterAudit,
  type InterpreterClaim,
  type InterpreterFlow,
  type InterpreterFrame,
  type InterpreterHooks,
  type InterpreterIssue,
  type InterpreterLoopClaim,
  type LoopFrame,
  type LoopAppend,
} from './context.ts'
import {
  exactInteger,
  pathFromExpression as pathFromSourceExpression,
  readArrayIndexValue,
  readPath,
  readPropertyValue,
  valueExpr,
  valuePathExpression,
  writePath,
  type ValuePath,
} from './value-path.ts'
import {
  expressionCursorPaths,
  expressionIndexPaths,
  indexedForLoopShape,
  isAssignmentOperator,
  isPushCallExpression,
  isSideEffectFreeExpression,
  propertyNameText,
  symbolicForOfBranchSupported,
  unwrapExpression,
  type IndexedForLoopShape,
} from './source-syntax.ts'
import {
  indexedElementAssumptions,
  indexedLoopValue,
  loopElementPathExpression,
} from './loop-values.ts'
import {
  captureLoopBodyEffect,
  finalizeLoopEffects,
  pendingLoopEffects,
  type PendingLoopEffects,
} from './loop-effects.ts'
import {
  branchFrame,
  compareNumbers,
  isComparisonOperator,
  literalBoolean,
} from './refine.ts'
import {comparisonConstraint, proveComparisonPlain} from '../proof.ts'
import {publicFitText} from '../parser.ts'
import {
  formatArraySummary,
  formatRange,
} from '../reporting.ts'
import {
  forgetRoot,
  forgetRoots,
  forgettableMutationRoots,
  isForgettableForStatement,
  isForgettableReadExpression,
} from './forgettable-loop.ts'
import {evaluateMathCall} from './math.ts'
import {auditBranchCondition, auditConditionalSelector, auditNullishFallback} from './audit.ts'
import {
  blockScopedNames,
  forOfBodyScopedNames,
  forOfItemName,
  forOfScopedNames,
  restoreScopedValues,
  saveScopedValues,
} from './scope.ts'

export type InterpreterFunctionResult = {
  value: Value
  issues: InterpreterIssue[]
  audits: InterpreterAudit[]
}

export type InterpreterBodyResult = InterpreterFunctionResult & {
  env: Map<string, Value>
  assumptions: LinearConstraint[]
}

type LoopBodyHandlers = {
  loopLabel: string
  unsupportedBodyMessage: (statement: ts.Statement) => string
  unsupportedAfterEffectMessage: (statement: ts.Statement) => string
  beforeStatement?: (order: number) => void
  handlePush: (expression: ts.CallExpression & {expression: ts.PropertyAccessExpression}, order: number) => Value | null
  handleIf: (statement: ts.IfStatement, order: number) => Value | null
}

type InterpreterCallTarget =
  | {kind: 'math'; name: string}
  | {
      kind: 'function'
      program: Program
      functionName: string
      fn: FitFunction
      imported?: {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>}
    }
  | {kind: 'unresolved'; reason: string}

type IndexedForLoopBound = {
  length: NumberValue
  expression: ts.Expression
  origin: IndexedForLoopOrigin | null
}

type IndexedForLoopOrigin = {
  source: ArrayValue
  sourceExpr: string
}

type IndexedAppendRecord = {
  path: ValuePath
  count: number
  initialEmpty: boolean
  conditional: boolean
}

type IndexedAppendResult =
  | {kind: 'ok'; append: LoopAppend | null; initialEmpty: boolean; conditional: boolean}
  | {kind: 'error'; value: Value}

type IndexedForBodyContext = {
  indexName: string
  length: NumberValue
  source: ArrayValue | null
  order: number
  loop: LoopFrame
  appendedArrays: Map<string, IndexedAppendRecord>
}

export function evaluateInterpreterFunction(program: Program, functionName: string): InterpreterFunctionResult {
  const frame = rootFrame(program)
  const fn = program.functions.get(functionName)
  if (fn == null) {
    return {
      value: noteUnsupported(frame, `Unknown function ${functionName}`),
      issues: frame.issues,
      audits: frame.audits,
    }
  }
  const value = invokeFitFunction(fn, [], frame, program, frame.env)
  return {value, issues: frame.issues, audits: frame.audits}
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
  const value = evaluateFunctionNodeBody(fn.name, fn.node, frame)
  return {value, env: frame.env, issues: frame.issues, audits: frame.audits, assumptions: frame.assumptions}
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
  return {value: unknown('Top-level did not return'), env: frame.env, issues: frame.issues, audits: frame.audits, assumptions: frame.assumptions}
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
  return {value, env: frame.env, issues: frame.issues, audits: frame.audits, assumptions: frame.assumptions}
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
    audits: [],
    stack,
    activeCalls: new Set(),
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
    ? valueWithStructuralFallback(env.get('this') ?? fallback, fallback)
    : valueWithStructuralFallback(localizeValue(thisValue, 'this', {preserveLinear: true}), fallback)
  env.set('this', value)
}

function classInstanceThisValue(fn: FitFunction, program: Program): Value | null {
  const classNode = ts.isMethodDeclaration(fn.node) || ts.isGetAccessorDeclaration(fn.node) ? fn.node.parent : null
  if (classNode == null || !ts.isClassDeclaration(classNode)) return null

  const props = new Map<string, Value>()
  for (const member of classNode.members) {
    if (ts.isPropertyDeclaration(member)) {
      const name = propertyNameText(member.name)
      if (name == null) continue
      const expr = `this.${name}`
      props.set(name, valueFromSyntaxTypeShape(expr, member.type, program, new Set()) ?? unknownNumber(expr))
      continue
    }
    if (!ts.isConstructorDeclaration(member)) continue
    for (const param of member.parameters) {
      if (!isParameterProperty(param) || !ts.isIdentifier(param.name)) continue
      const expr = `this.${param.name.text}`
      props.set(param.name.text, valueFromSyntaxTypeShape(expr, param.type, program, new Set()) ?? unknownNumber(expr))
    }
  }
  return {kind: 'object', props, expr: 'this'}
}

function isParameterProperty(param: ts.ParameterDeclaration) {
  return ts.canHaveModifiers(param) && ts.getModifiers(param)?.some(modifier =>
    modifier.kind === ts.SyntaxKind.PublicKeyword
    || modifier.kind === ts.SyntaxKind.PrivateKeyword
    || modifier.kind === ts.SyntaxKind.ProtectedKeyword
    || modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
  ) === true
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
  if (ts.isArrowFunction(fn) && ts.isExpression(fn.body)) return evaluateReturnExpression(fn.body, fn, frame)
  if (fn.body == null) return noteUnsupported(frame, `Function ${name} has no body`, fn)
  if (!ts.isBlock(fn.body)) return noteUnsupported(frame, `Function ${name} body is unsupported`, fn.body)
  const flow = evaluateStatements(fn.body.statements, frame)
  return flow.kind === 'return' ? flow.value : noteUnsupported(frame, `Function ${name} did not return`, fn.body)
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
  return valueWithStructuralFallback(value, valueFromSyntaxTypeShape(expr, param.type, frame.program, new Set()))
}

function unknownParamPatternValue(param: ts.ParameterDeclaration, frame: InterpreterFrame): Value {
  const shape = ts.isIdentifier(param.name)
    ? valueFromSyntaxTypeShape(param.name.text, param.type, frame.program, new Set())
    : null
  if (shape != null) return shape
  const name = param.name
  if (ts.isIdentifier(name)) return unknownNumber(name.text)
  if (ts.isArrayBindingPattern(name)) return unknownArray('param')
  return unknownObject('param')
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
      const prop = propertyName == null
        ? unknown(`Unsupported binding property ${element.getText(frame.program.sourceFile)}`)
        : readPropertyValue(value, propertyName, `${valueExpr(value) ?? 'param'}.${propertyName}`)
      bindPattern(element.name, prop, frame)
    }
    return
  }
  forEachArrayBindingElement(name, (elementName, index, isRest) => {
    if (isRest) {
      noteUnsupported(frame, 'Array rest binding is unsupported', elementName)
      bindPattern(elementName, unknownArray('rest'), frame)
      return
    }
    bindPattern(elementName, readArrayIndexValue(value, index, `${valueExpr(value) ?? 'param'}[${index}]`), frame)
  })
}

function evaluateStatements(statements: ts.NodeArray<ts.Statement>, frame: InterpreterFrame, startIndex = 0): InterpreterFlow {
  for (let index = startIndex; index < statements.length; index++) {
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

function evaluateStatement(statement: ts.Statement, frame: InterpreterFrame): InterpreterFlow {
  if (ts.isVariableStatement(statement)) {
    evaluateVariableStatement(statement, frame)
    return {kind: 'fallthrough'}
  }
  if (ts.isReturnStatement(statement)) {
    return {kind: 'return', value: statement.expression == null ? noteUnsupported(frame, 'Empty return', statement) : evaluateReturnExpression(statement.expression, statement, frame)}
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
  return {kind: 'return', value: noteUnsupported(frame, `Unsupported statement in ${frame.stack.at(-1) ?? '<unknown>'}: ${statement.getText(frame.program.sourceFile)}`, statement)}
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
  const shaped = valueWithStructuralFallback(value, valueFromSyntaxTypeShape(expr, declaration.type, frame.program, new Set()))
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
  const shaped = valueWithStructuralFallback(value, returnTypeShape(node, frame))
  afterClaim(claim, shaped, frame)
  return shaped
}

function returnTypeShape(node: ts.Node, frame: InterpreterFrame): Value | null {
  const fn = ts.isFunctionLike(node) ? node : nearestFunctionLike(node)
  return fn == null ? null : valueFromFunctionReturnShape('return', fn, frame.program)
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
  const truth = literalBoolean(evaluateExpression(statement.expression, frame))
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
    frame.env = elseFrame.env
    return {kind: 'fallthrough'}
  }
  if (elseFlow.kind !== 'fallthrough') {
    frame.env = thenFrame.env
    return {kind: 'fallthrough'}
  }
  frame.env = joinBranchFrameEnvs(thenFrame, elseFrame)
  return {kind: 'fallthrough'}
}

function joinBranchFrameEnvs(left: InterpreterFrame, right: InterpreterFrame): Map<string, Value> {
  return joinFrameEnvs(envWithAssumptions(left.env, left.assumptions), envWithAssumptions(right.env, right.assumptions))
}

function envWithAssumptions(env: Map<string, Value>, assumptions: LinearConstraint[]): Map<string, Value> {
  const next = new Map<string, Value>()
  for (const [name, value] of env) next.set(name, valueWithAssumptions(value, assumptions))
  return next
}

function flowWithAssumptions(flow: InterpreterFlow, assumptions: LinearConstraint[]): InterpreterFlow {
  return flow.kind === 'return' ? {kind: 'return', value: valueWithAssumptions(flow.value, assumptions)} : flow
}

function joinCompletedFlows(left: InterpreterFlow, right: InterpreterFlow, frame: InterpreterFrame): InterpreterFlow {
  const leftValue = completedFlowValue(left, frame)
  const rightValue = completedFlowValue(right, frame)
  if (leftValue == null && rightValue == null) return {kind: 'exit'}
  if (leftValue == null) return {kind: 'return', value: rightValue!}
  if (rightValue == null) return {kind: 'return', value: leftValue}
  return {kind: 'return', value: joinValues(leftValue, rightValue)}
}

function completedFlowValue(flow: InterpreterFlow, frame: InterpreterFrame): Value | null {
  if (flow.kind === 'exit') return null
  if (flow.kind === 'return') return flow.value
  return unknown(`Function ${frame.stack.at(-1) ?? '<unknown>'} did not return`)
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
  const next = literalValue(current.values.filter(value => keys.has(literalKey(value))), current.expr, current.provenance)
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
  if (itemName != null) frame.loopStack.push({source, sourceExpr, mode: 'finite', statementIndex: 0, appends: []})
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
  const itemName = forOfItemName(statement.initializer)
  if (itemName == null) return {kind: 'return', value: noteUnsupported(frame, 'Abstract for..of supports simple variable bindings only', statement.initializer)}
  const scopedNames = [...forOfScopedNames(statement.initializer), ...blockScopedNames(statement.statement)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const sourceExpr = sourceExpression(source, statement.expression, frame)
  const item = source.element ?? unknownObject(`${sourceExpr}[]`)
  const loop: LoopFrame = {source, sourceExpr, mode: 'symbolic', statementIndex: 0, appends: []}
  const effects = pendingLoopEffects()
  const guardedPushes: GuardedLoopPush[] = []
  frame.loopStack.push(loop)
  try {
    bindForOfInitializer(statement.initializer, item, frame)
    const bodyError = evaluateLoopBodyEffects(statement.statement.statements, effects, {
      loopLabel: 'Abstract for..of',
      beforeStatement: order => {
        loop.statementIndex = order
      },
      handlePush: expression => {
        evaluateExpression(expression, frame)
        return null
      },
      handleIf: child => evaluateSymbolicForOfIf(child, loop, effects, guardedPushes, frame),
      unsupportedAfterEffectMessage: child => `Abstract for..of scalar cursor/extrema updates must stay after all local bindings and append pushes: ${child.getText(frame.program.sourceFile)}`,
      unsupportedBodyMessage: child => `Abstract for..of expected a simple append/reducer body: local bindings, direct array.push(value), supported if guards, and final scalar cursor/extrema updates; got ${child.getText(frame.program.sourceFile)}`,
    }, frame)
    if (bodyError != null) return {kind: 'return', value: bodyError}
    const error = finalizeLoopEffectsAndGuardedPushes(loop, effects, guardedPushes, 'Abstract for..of', frame)
    if (error != null) return {kind: 'return', value: error}
    finalizeSymbolicLoopAppendedArrays(loop, frame)
    addLoopFactRoots(claim, loop, effects, guardedPushes)
  } finally {
    frame.loopStack.pop()
    restoreScopedValues(frame.env, scopedValues)
  }
  return {kind: 'fallthrough'}
}

function evaluateSymbolicForOfIf(
  statement: ts.IfStatement,
  loop: LoopFrame,
  effects: PendingLoopEffects,
  guardedPushes: GuardedLoopPush[],
  frame: InterpreterFrame,
): Value | null {
  const guarded = readGuardedPushAfterExtrema(statement, loop, effects, 'Abstract for..of', frame)
  if (guarded != null) {
    guardedPushes.push(...guarded)
    return null
  }
  if (hasPendingLoopEffects(effects)) return noteUnsupported(frame, `Abstract for..of scalar cursor/extrema updates can only be followed by guarded pushes with safe resets: ${statement.getText(frame.program.sourceFile)}`, statement)
  return evaluateSymbolicForOfGuard(statement, frame)
}

function evaluateSymbolicForOfGuard(statement: ts.IfStatement, frame: InterpreterFrame): Value | null {
  if (!symbolicForOfBranchSupported(statement)) {
    return noteUnsupported(frame, `Abstract for..of guarded bodies only support local bindings and direct push calls: ${statement.getText(frame.program.sourceFile)}`, statement)
  }
  const flow = evaluateIfStatement(statement, frame)
  if (flow.kind === 'fallthrough') return null
  return flow.kind === 'return' ? flow.value : noteUnsupported(frame, 'Abstract for..of loop control flow is unsupported', statement)
}

function finalizeSymbolicLoopAppendedArrays(loop: LoopFrame, frame: InterpreterFrame) {
  const seen = new Set<string>()
  for (const append of loop.appends) {
    if (seen.has(append.arrayName)) continue
    seen.add(append.arrayName)
    if (!append.conditional) continue
    const value = frame.env.get(append.arrayName)
    if (value?.kind !== 'array') continue
    const length = conditionalPushLength(append.arrayName, loop.source.length, append.base.length)
    addLengthAtMostSourceFact(length, loop.source.length, frame)
    frame.env.set(append.arrayName, {
      ...value,
      length,
      elements: null,
    })
  }
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

  const scopedNames = [shape.indexName, ...blockScopedNames(statement.statement)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const length = indexedLoopLength(bound.length, bound.expression, frame)
  const indexValue = indexedElementPathValue(shape.indexName, length)
  frame.env.set(shape.indexName, indexValue)
  frame.assumptions = mergeAssumptions(frame.assumptions, indexedElementAssumptions(indexValue, length))
  const loop = indexedForLoopContext(bound, length, frame)
  const effects = pendingLoopEffects()
  const guardedPushes: GuardedLoopPush[] = []
  frame.loopStack.push(loop)
  try {
    const appendedArrays = new Map<string, IndexedAppendRecord>()
    const bodyError = evaluateLoopBodyEffects(statement.statement.statements, effects, {
      loopLabel: 'Indexed for loop',
      handlePush: (expression, order) => evaluateIndexedForPushStatement(expression, {
        indexName: shape.indexName,
        length,
        source: bound.origin?.source ?? null,
        order,
        loop,
          appendedArrays,
        }, frame),
      handleIf: (child, order) => evaluateIndexedForIf(child, {
        indexName: shape.indexName,
        length,
        source: bound.origin?.source ?? null,
        order,
        loop,
        appendedArrays,
      }, effects, guardedPushes, frame),
      unsupportedAfterEffectMessage: child => `Indexed for loop scalar cursor/extrema updates must stay after all local bindings and append pushes: ${child.getText(frame.program.sourceFile)}`,
      unsupportedBodyMessage: child => `Indexed for loop expected a simple append/reducer body: local bindings, direct array.push(value), supported if guards, and final scalar cursor/extrema updates; got ${child.getText(frame.program.sourceFile)}`,
    }, frame)
    if (bodyError != null) return {kind: 'return', value: bodyError}
    const cursorError = finalizeLoopEffectsAndGuardedPushes(loop, effects, guardedPushes, 'Indexed for loop', frame)
    if (cursorError != null) return {kind: 'return', value: cursorError}
    finalizeIndexedAppendedArrays(appendedArrays, bound.origin, frame)
    addLoopFactRoots(claim, loop, effects, guardedPushes)
    for (const record of appendedArrays.values()) claim.factRoots.add(record.path.root)
  } finally {
    frame.loopStack.pop()
    restoreScopedValues(frame.env, scopedValues)
  }
  return {kind: 'fallthrough'}
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

function evaluateIndexedForPushStatement(
  expression: ts.CallExpression & {expression: ts.PropertyAccessExpression},
  context: IndexedForBodyContext,
  frame: InterpreterFrame,
): Value | null {
  const pushPath = pathFromExpression(expression.expression.expression, frame)
  if (pushPath == null) return noteUnsupported(frame, `Unsupported push target ${expression.expression.expression.getText(frame.program.sourceFile)}`, expression.expression.expression)
  const result = evaluateIndexedForPush(expression, pushPath, context.indexName, context.length, context.source, context.order, frame)
  if (result.kind === 'error') return result.value
  if (result.append != null) context.loop.appends.push(result.append)
  rememberIndexedAppend(context.appendedArrays, pushPath, result.initialEmpty, result.conditional)
  return null
}

function evaluateIndexedForIf(
  statement: ts.IfStatement,
  context: IndexedForBodyContext,
  effects: PendingLoopEffects,
  guardedPushes: GuardedLoopPush[],
  frame: InterpreterFrame,
): Value | null {
  const guarded = readGuardedPushAfterExtrema(statement, context.loop, effects, 'Indexed for loop', frame)
  if (guarded != null) {
    guardedPushes.push(...guarded)
    return null
  }
  if (hasPendingLoopEffects(effects)) return noteUnsupported(frame, `Indexed for loop scalar cursor updates can only be followed by guarded pushes with safe resets: ${statement.getText(frame.program.sourceFile)}`, statement)
  return evaluateIndexedForGuardedStatement(statement, context, frame)
}

function evaluateIndexedForGuardedStatement(
  statement: ts.IfStatement,
  context: IndexedForBodyContext,
  frame: InterpreterFrame,
): Value | null {
  if (statement.elseStatement != null) return noteUnsupported(frame, 'Indexed for loop guarded pushes do not support else branches', statement.elseStatement)
  if (!isSideEffectFreeExpression(statement.expression)) return noteUnsupported(frame, 'Indexed for loop guards must be side-effect-free', statement.expression)
  const thenFrame = branchFrame(frame, statement.expression, true, '<indexed-if-true>', evaluateExpression)
  const elseFrame = branchFrame(frame, statement.expression, false, '<indexed-if-false>', evaluateExpression)
  thenFrame.conditionalDepth++
  try {
    const error = evaluateIndexedForGuardedBody(statement.thenStatement, context, thenFrame)
    if (error != null) return error
  } finally {
    thenFrame.conditionalDepth--
  }
  frame.env = joinBranchFrameEnvs(thenFrame, elseFrame)
  return null
}

function evaluateIndexedForGuardedBody(
  statement: ts.Statement,
  context: IndexedForBodyContext,
  frame: InterpreterFrame,
): Value | null {
  const statements = ts.isBlock(statement) ? statement.statements : [statement]
  for (const child of statements) {
    if (ts.isVariableStatement(child)) {
      for (const declaration of child.declarationList.declarations) evaluateVariableDeclaration(child, declaration, frame)
      continue
    }
    if (ts.isExpressionStatement(child) && isPushCallExpression(child.expression)) {
      const error = evaluateIndexedForPushStatement(child.expression, context, frame)
      if (error != null) return error
      continue
    }
    if (ts.isIfStatement(child)) {
      const error = evaluateIndexedForGuardedStatement(child, context, frame)
      if (error != null) return error
      continue
    }
    return noteUnsupported(frame, `Indexed for loop guarded bodies only support local bindings and direct push calls: ${child.getText(frame.program.sourceFile)}`, child)
  }
  return null
}

function indexedForLoopContext(bound: IndexedForLoopBound, length: NumberValue, frame: InterpreterFrame): LoopFrame {
  const expr = bound.origin?.sourceExpr ?? bound.expression.getText(frame.program.sourceFile)
  const source = bound.origin == null
    ? unknownArray(expr, length)
    : {...bound.origin.source, length}
  return {source, sourceExpr: expr, mode: 'symbolic', statementIndex: 0, appends: []}
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

function evaluateLoopBodyEffects(
  statements: ts.NodeArray<ts.Statement> | ts.Statement[],
  effects: PendingLoopEffects,
  handlers: LoopBodyHandlers,
  frame: InterpreterFrame,
): Value | null {
  let sawEffect = false
  for (let order = 0; order < statements.length; order++) {
    const child = statements[order]!
    handlers.beforeStatement?.(order)
    const effect = captureLoopBodyEffect(child, order, effects, handlers.loopLabel, frame, evaluateExpression)
    if (effect.kind === 'unsupported') return effect.value
    if (effect.kind === 'captured') {
      sawEffect = true
      continue
    }
    if (ts.isVariableStatement(child)) {
      if (sawEffect) return noteUnsupported(frame, handlers.unsupportedAfterEffectMessage(child), child)
      for (const declaration of child.declarationList.declarations) evaluateVariableDeclaration(child, declaration, frame)
      continue
    }
    if (ts.isExpressionStatement(child) && isPushCallExpression(child.expression)) {
      if (sawEffect) return noteUnsupported(frame, handlers.unsupportedAfterEffectMessage(child), child)
      const error = handlers.handlePush(child.expression, order)
      if (error != null) return error
      continue
    }
    if (ts.isIfStatement(child)) {
      const error = handlers.handleIf(child, order)
      if (error != null) return error
      continue
    }
    const forgottenRoots = forgettableMutationRoots(child, frame.env)
    if (forgottenRoots != null) {
      forgetRoots(frame.env, forgottenRoots)
      continue
    }
    if (sawEffect) return noteUnsupported(frame, handlers.unsupportedAfterEffectMessage(child), child)
    return noteUnsupported(frame, handlers.unsupportedBodyMessage(child), child)
  }
  return null
}

function readGuardedPushAfterExtrema(
  statement: ts.IfStatement,
  loop: LoopFrame,
  effects: PendingLoopEffects,
  loopLabel: string,
  frame: InterpreterFrame,
): GuardedLoopPush[] | null {
  if (!hasPendingLoopEffects(effects)) return null
  if (effects.scalarAdds.size > 0 || effects.conditionalScalarAdds.size > 0 || effects.extrema.size === 0) return null
  const pushes = readGuardedLoopPushes(statement, loopSourceContext(frame), loop.source.length, loopExtrema(effects))
  if (pushes == null) return null
  if (pushes.length > 1) {
    noteUnsupported(frame, `${loopLabel} guarded scalar flushes support one pushed array`, statement)
    return null
  }
  return pushes
}

function hasPendingLoopEffects(effects: PendingLoopEffects) {
  return effects.scalarAdds.size > 0 || effects.conditionalScalarAdds.size > 0 || effects.extrema.size > 0
}

function addLoopFactRoots(
  claim: InterpreterLoopClaim,
  loop: LoopFrame,
  effects: PendingLoopEffects,
  guardedPushes: GuardedLoopPush[],
) {
  for (const append of loop.appends) claim.factRoots.add(append.arrayName)
  for (const push of guardedPushes) claim.factRoots.add(push.arrayName)
  for (const targetName of effects.scalarAdds.keys()) claim.factRoots.add(targetName)
  for (const targetName of effects.conditionalScalarAdds.keys()) claim.factRoots.add(targetName)
  for (const targetName of effects.extrema.keys()) claim.factRoots.add(targetName)
}

function loopExtrema(effects: PendingLoopEffects): Map<string, LoopExtremum> {
  const extrema = new Map<string, LoopExtremum>()
  for (const [targetName, extremum] of effects.extrema) extrema.set(targetName, extremum)
  return extrema
}

function loopSourceContext(frame: InterpreterFrame): LoopSourceContext {
  return {
    env: frame.env,
    sourceFile: frame.program.sourceFile,
    evaluateExpression: (expression, env) => evaluateExpression(expression, {...frame, env}),
    bindVariableStatement: (statement, env) => {
      const localFrame = {...frame, env}
      for (const declaration of statement.declarationList.declarations) evaluateVariableDeclaration(statement, declaration, localFrame)
    },
    isSideEffectFreeExpression,
  }
}

function finalizeLoopEffectsAndGuardedPushes(
  loop: LoopFrame,
  effects: PendingLoopEffects,
  guardedPushes: GuardedLoopPush[],
  loopLabel: string,
  frame: InterpreterFrame,
): Value | null {
  if (guardedPushes.length > 0) return finalizeGuardedLoopPushes(loop, guardedPushes, effects, loopLabel, frame)
  return finalizeLoopEffects(loop, effects, loopLabel, frame)
}

function finalizeGuardedLoopPushes(
  loop: LoopFrame,
  pushes: GuardedLoopPush[],
  effects: PendingLoopEffects,
  loopLabel: string,
  frame: InterpreterFrame,
): Value | null {
  if (pushes.length === 0) return null
  const guardedArrays = new Set(pushes.map(push => push.arrayName))
  if (loop.appends.some(append => guardedArrays.has(append.arrayName))) {
    return noteUnsupported(frame, `${loopLabel} guarded scalar flushes cannot mix with unguarded pushes to the same array`)
  }
  if (effects.scalarAdds.size > 0 || effects.conditionalScalarAdds.size > 0) {
    return noteUnsupported(frame, `${loopLabel} guarded scalar flushes support scalar extrema only`)
  }
  const extrema = loopExtrema(effects)
  for (const push of pushes) {
    const target = frame.env.get(push.arrayName)
    if (target?.kind !== 'array') return noteUnsupported(frame, `${loopLabel} guarded push expected ${push.arrayName} to be an array`)
    const length = conditionalPushLength(push.arrayName, loop.source.length, target.length)
    const baseElement = loopElementFromPush(push, new Map(), extrema, loop.source.length, frame.env, frame.assumptions)
    const element = segmentedStackElement(push, baseElement, loop.source.length, frame.env)
    writePath({root: push.arrayName, segments: []}, {
      ...target,
      length,
      elements: null,
      element: pushedElementValue(target, element),
      summary: mergeArraySummary(target.summary, segmentedStackSummary(push, element)),
    }, frame)
    applySegmentedStackCursorUpdate(push, element, loop.source.length, frame.env)
    if (target.length.min === 0 && target.length.max === 0) {
      const fact = comparisonConstraint(length, '<=', loop.source.length, `${length.expr ?? push.arrayName + '.length'} <= ${loop.source.length.expr ?? 'loop length'}`)
      if (fact != null) frame.assumptions = mergeAssumptions(frame.assumptions, [fact])
    }
  }
  return null
}

function indexedLoopLength(limit: NumberValue, expression: ts.Expression, frame: InterpreterFrame): NumberValue {
  const expr = limit.expr ?? expression.getText(frame.program.sourceFile)
  const min = Math.max(0, limit.min)
  const max = Math.max(0, limit.max)
  return numberValue(min, max, true, expr, limit.linear, null, limit.provenance)
}

function evaluateIndexedForPush(
  expression: ts.CallExpression & {expression: ts.PropertyAccessExpression},
  path: ValuePath,
  indexName: string,
  length: NumberValue,
  source: ArrayValue | null,
  order: number,
  frame: InterpreterFrame,
): IndexedAppendResult {
  const current = readPath(path, frame, expression.expression.expression)
  if (current.kind !== 'array') return {kind: 'error', value: noteUnsupported(frame, `push expected an array: ${expression.expression.expression.getText(frame.program.sourceFile)}`, expression.expression.expression)}
  if (source != null && current === source) return {kind: 'error', value: noteUnsupported(frame, 'Indexed for loop cannot push into its source array', expression)}
  if (expression.arguments.length !== 1) return {kind: 'error', value: noteUnsupported(frame, 'Indexed for loop push supports one item per iteration', expression)}
  const argument = expression.arguments[0]!
  const rawElement = evaluateExpression(argument, frame)
  const targetExpr = valuePathExpression(path)
  const element = indexedLoopValue(rawElement, indexName, targetExpr, [], length)
  const lengthValue = current.length.min === 0 && current.length.max === 0 ? length : addNumbers(current.length, length)
  const initialEmpty = current.length.min === 0 && current.length.max === 0
  writePath(path, {
    ...current,
    length: lengthValue,
    elements: null,
    element: mergeElementValue(current.element, element),
  }, frame)
  frame.assumptions = mergeAssumptions(frame.assumptions, ...expressionIndexPaths(argument, indexName).map(indexPath => {
    return indexedElementAssumptions(indexedElementPathValue(loopElementPathExpression(targetExpr, indexPath), length), length)
  }))
  return {
    kind: 'ok',
    initialEmpty,
    conditional: frame.conditionalDepth > 0,
    append: path.segments.length === 0 ? {
      arrayName: path.root,
      order,
      conditional: frame.conditionalDepth > 0,
      length: lengthValue,
      element,
      base: current,
      cursorPaths: expressionCursorPaths(argument),
    } : null,
  }
}

function rememberIndexedAppend(records: Map<string, IndexedAppendRecord>, path: ValuePath, initialEmpty: boolean, conditional: boolean) {
  const key = valuePathExpression(path)
  const current = records.get(key)
  records.set(key, current == null ? {path, count: 1, initialEmpty, conditional} : {
    ...current,
    count: current.count + 1,
    conditional: current.conditional || conditional,
  })
}

function finalizeIndexedAppendedArrays(records: Map<string, IndexedAppendRecord>, origin: IndexedForLoopOrigin | null, frame: InterpreterFrame) {
  for (const record of records.values()) {
    const value = readPath(record.path, frame)
    if (value.kind !== 'array') continue
    const length = record.conditional && record.initialEmpty && origin != null
      ? conditionalPushLength(valuePathExpression(record.path), origin.source.length)
      : value.length
    if (length !== value.length && origin != null) addLengthAtMostSourceFact(length, origin.source.length, frame)
    const summary = origin != null && record.count === 1 && record.initialEmpty
      ? mergeArraySummary(value.summary, emptyArraySummary(record.conditional ? filterOrigin(origin.source, origin.sourceExpr) : mapOrigin(origin.source, origin.sourceExpr)))
      : value.summary
    writePath(record.path, {...value, length, elements: null, summary}, frame)
  }
}

function bindForOfInitializer(initializer: ts.ForInitializer, value: Value, frame: InterpreterFrame) {
  if (ts.isVariableDeclarationList(initializer)) {
    const declaration = initializer.declarations[0]
    if (declaration == null || initializer.declarations.length !== 1) {
      noteUnsupported(frame, 'for..of supports one loop binding', initializer)
      return
    }
    bindPattern(declaration.name, value, frame)
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
  if (ts.isNonNullExpression(expression)) return evaluateExpression(expression.expression, frame)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return evaluateExpression(expression.expression, frame)
  }

  const numeric = numericLiteralValue(expression)
  if (numeric != null) return numberValue(numeric, numeric, Number.isInteger(numeric), nodeText(expression, frame), linearConstant(numeric))
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return literalValue([expression.text], nodeText(expression, frame))
  if (ts.isTemplateExpression(expression)) return noteUnsupported(frame, `Template string ${nodeText(expression, frame)}`, expression)
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
  if (ts.isTypeOfExpression(expression)) return evaluateTypeOfExpression(expression, frame)
  if (ts.isBinaryExpression(expression)) return evaluateBinaryExpression(expression, frame)
  if (ts.isConditionalExpression(expression)) return evaluateConditionalExpression(expression, frame)
  if (ts.isCallExpression(expression)) return evaluateCallExpression(expression, frame)
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return noteUnsupported(frame, 'Function value cannot be materialized yet', expression)
  return noteUnsupported(frame, `Unsupported expression ${expression.getText(frame.program.sourceFile)}`, expression)
}

function evaluateVoidExpression(expression: ts.VoidExpression, frame: InterpreterFrame): Value {
  evaluateExpression(expression.expression, frame)
  return nullValue('undefined')
}

function readIdentifier(expression: ts.Identifier, frame: InterpreterFrame): Value {
  if (expression.text === 'undefined') return nullValue('undefined')
  if (expression.text === 'Infinity') return numberValue(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false, 'Infinity')
  const ambient = ambientIdentifierFact(expression, frame.program)
  if (ambient != null) return ambient
  return frame.env.get(expression.text) ?? noteUnsupported(frame, `Unknown identifier ${expression.text}`, expression)
}

function evaluatePropertyAccess(expression: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  if (!hasQuestionDotToken(expression)) {
    const ambient = ambientPropertyFact(expression, frame.program)
    if (ambient != null) return ambient
  }
  const getter = classMemberFunctionForPropertyAccess(expression, frame)
  if (getter != null && ts.isGetAccessorDeclaration(getter.fn.node)) {
    const receiver = evaluateExpression(expression.expression, frame)
    const fallback = valueFromFunctionReturnShape(expression.getText(frame.program.sourceFile), getter.fn.node, getter.program)
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
    if (hooked != null) return hooked
    return valueWithStructuralFallback(
      invokeFitFunction(getter.fn, [], frame, getter.program, rootFrame(getter.program).env, receiver),
      fallback,
    )
  }
  const target = evaluateExpression(expression.expression, frame)
  const optional = hasQuestionDotToken(expression)
  if (target.kind === 'nullable' && optional) {
    const present = readPropertyValue(target.present, expression.name.text, expression.getText(frame.program.sourceFile))
    return nullableValue(present, expression.getText(frame.program.sourceFile), 'undefined')
  }
  if (target.kind === 'null' && optional) return nullValue('undefined')
  if (target.kind === 'nullable') return noteUnsupported(frame, `Nullable value ${target.expr ?? expression.expression.getText(frame.program.sourceFile)} was not proven present`, expression.expression)
  if (!canReadProperty(target, expression.name.text)) {
    return noteUnsupported(frame, `Property access expected an object path${expression.name.text === 'length' ? ' or array length' : ''}: ${expression.getText(frame.program.sourceFile)}`, expression.expression)
  }
  return readPropertyValue(target, expression.name.text, expression.getText(frame.program.sourceFile))
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
  return readArrayIndexValue(target, exactIndex, expression.getText(frame.program.sourceFile))
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

function symbolicArrayElementAccess(target: Value, index: Value, expression: ts.ElementAccessExpression, frame: InterpreterFrame): Value {
  if (target.kind === 'nullable') return symbolicArrayElementAccess(target.present, index, expression, frame)
  if (target.kind !== 'array') return noteUnsupported(frame, `Element access expected an array path: ${expression.expression.getText(frame.program.sourceFile)}`, expression.expression)
  if (index.kind !== 'number') return noteUnsupported(frame, `Array index ${expression.argumentExpression?.getText(frame.program.sourceFile) ?? '<missing>'} expected a number`, expression.argumentExpression ?? expression)
  const lower = proveComparisonPlain(index, '>=', numberValue(0, 0, true, '0', linearConstant(0)), frame.assumptions)
  const upper = proveComparisonPlain(index, '<', target.length, frame.assumptions)
  if (lower.status !== 'pass' || upper.status !== 'pass') {
    return noteUnsupported(frame, `Array index ${formatRange(index)} was not proven inside length ${formatRange(target.length)}; prove 0 <= index < length or use a finite literal index`, expression.argumentExpression ?? expression)
  }
  if (expression.argumentExpression == null) return unknownNumber(expression.getText(frame.program.sourceFile))
  const sourceName = target.expr ?? expression.expression.getText(frame.program.sourceFile)
  const indexText = expression.argumentExpression.getText(frame.program.sourceFile)
  const accessExpr = `${sourceName}[${indexText}]`
  const adjacentFacts = adjacentElementAccessFacts(target, index, sourceName, indexText, accessExpr, frame.assumptions)
  if (adjacentFacts.length > 0) frame.assumptions = mergeAssumptions(frame.assumptions, adjacentFacts)
  const element = target.element == null
    ? unknownNumber(expression.getText(frame.program.sourceFile))
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
    layout: 'collection',
    length,
    elements,
    element,
    expr: expression.getText(frame.program.sourceFile),
    summary: null,
  }
}

function evaluatePrefixUnary(expression: ts.PrefixUnaryExpression, frame: InterpreterFrame): Value {
  if (expression.operator === ts.SyntaxKind.ExclamationToken) return evaluateLogicalNot(expression, frame)
  const value = evaluateExpression(expression.operand, frame)
  if (value.kind !== 'number') return noteUnsupported(frame, `Unary ${expression.getText(frame.program.sourceFile)} expected a number`, expression)
  if (expression.operator === ts.SyntaxKind.PlusToken) return value
  if (expression.operator === ts.SyntaxKind.MinusToken) {
    return numberValue(-value.max, -value.min, value.isInteger, `-${value.expr ?? expression.operand.getText(frame.program.sourceFile)}`)
  }
  return noteUnsupported(frame, `Unsupported unary expression ${expression.getText(frame.program.sourceFile)}`, expression)
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
    case ts.SyntaxKind.PercentToken:
      return moduloNumbers(left, right)
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return powerNumbers(left, right)
    default:
      return noteUnsupported(frame, `Unsupported numeric operator ${expression.getText(frame.program.sourceFile)}`, expression)
  }
}

function evaluateAssignmentExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const path = pathFromExpression(expression.left, frame)
  if (path == null) return noteUnsupported(frame, `Unsupported assignment target ${expression.left.getText(frame.program.sourceFile)}`, expression.left)
  const right = evaluateExpression(expression.right, frame)
  const value = expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
    ? evaluateCompoundPlus(path, right, frame, expression)
    : right
  writePath(path, value, frame)
  return value
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
  if (left.kind === 'literal' && right.kind === 'literal' && isEqualityComparison(expression.operatorToken.kind)) {
    return literalValue(compareLiteralSets(left.values, right.values, expression.operatorToken.kind), expression.getText(frame.program.sourceFile))
  }
  return literalValue([true, false], expression.getText(frame.program.sourceFile))
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
  const truth = literalBoolean(evaluateExpression(expression.condition, frame))
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
    audits: frame.audits,
    stack: frame.stack,
    activeCalls: new Set(frame.activeCalls),
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
  const nonEmptyValue = condition.emptyWhenTrue ? falseValue : trueValue
  if (emptyValue.expr == null || nonEmptyValue.expr == null) return null
  return extentEndSummaryValue(condition.array, emptyValue.expr, nonEmptyValue.expr)
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

function extentEndSummaryValue(array: ArrayValue, emptyExpr: string, nonEmptyExpr?: string): NumberValue | null {
  const extentEnds = array.summary?.extentEnds ?? []
  return extentEnds.find(fact =>
    sameExpressionText(fact.emptyExpr, emptyExpr)
    && (nonEmptyExpr == null || sameExpressionText(fact.nonEmptyExpr, nonEmptyExpr))
  )?.value ?? null
}

function evaluateCallExpression(expression: ts.CallExpression, frame: InterpreterFrame): Value {
  const target = unwrapExpression(expression.expression)
  if (ts.isIdentifier(target) && target.text === 'lastEnd') return evaluateLastEndCall(expression, frame)
  if (ts.isIdentifier(target) && target.text === 'extentEnd') return evaluateExtentEndCall(expression, frame)
  const fallback = valueFromCallReturnShape(expression.getText(frame.program.sourceFile), expression, frame.program)
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'Math') {
    return valueWithStructuralFallback(evaluateMathCall(target.name.text, evaluatedArguments(expression.arguments, frame), frame, expression), fallback)
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'push') return evaluatePushCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target)) {
    const mutation = evaluateArrayMutationCall(expression, target, frame)
    if (mutation != null) return mutation
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'at') return evaluateArrayAtCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'map') return evaluateMapCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'filter') return evaluateFilterCall(expression, target, frame)
  if (isInlineFunction(target)) return invokeInlineFunction('<iife>', target, evaluatedArguments(expression.arguments, frame), frame)
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
      }, fallback, frame, receiver)
    }
  }
  const resolved = resolveCallTarget(target, frame.program)
  if (resolved.kind === 'math') {
    return valueWithStructuralFallback(evaluateMathCall(resolved.name, evaluatedArguments(expression.arguments, frame), frame, expression), fallback)
  }
  if (resolved.kind === 'function') return evaluateResolvedFunctionCall(expression, target.getText(frame.program.sourceFile), resolved, fallback, frame)
  if (fallback?.kind === 'object' || fallback?.kind === 'array') return fallback
  return noteUnsupported(frame, resolved.reason, expression)
}

function evaluateLastEndCall(expression: ts.CallExpression, frame: InterpreterFrame): Value {
  const targetExpression = expression.arguments[0]
  if (targetExpression == null || expression.arguments.length !== 1) return noteUnsupported(frame, 'lastEnd expects one array', expression)
  const target = evaluateExpression(targetExpression, frame)
  if (target.kind !== 'array') return noteUnsupported(frame, 'lastEnd expected an array', targetExpression)
  return target.summary?.lastEnd ?? unknown(lastEndFailureReason(nodeText(targetExpression, frame), target))
}

function evaluateExtentEndCall(expression: ts.CallExpression, frame: InterpreterFrame): Value {
  const targetExpression = expression.arguments[0]
  const emptyExpression = expression.arguments[1]
  if (targetExpression == null || emptyExpression == null || expression.arguments.length !== 2) {
    return noteUnsupported(frame, 'extentEnd expects extentEnd(rows, emptyValue)', expression)
  }
  const target = evaluateExpression(targetExpression, frame)
  if (target.kind !== 'array') return noteUnsupported(frame, 'extentEnd expected an array', targetExpression)
  const empty = evaluateExpression(emptyExpression, frame)
  if (empty.kind !== 'number' || empty.expr == null) return noteUnsupported(frame, 'extentEnd expected a known empty value', emptyExpression)

  if (target.length.max === 0) return empty
  if (target.length.min >= 1 && target.summary?.lastEnd != null) return target.summary.lastEnd
  return extentEndSummaryValue(target, empty.expr) ?? unknown(extentEndFailureReason(nodeText(targetExpression, frame), empty.expr, target))
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

function evaluateArrayMutationCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value | null {
  if (target.name.text !== 'reverse' && target.name.text !== 'sort' && target.name.text !== 'splice') return null
  if (!expression.arguments.every(isSideEffectFreeExpression)) return noteUnsupported(frame, `Unsupported array mutation arguments: ${expression.getText(frame.program.sourceFile)}`, expression)
  const path = pathFromExpression(target.expression, frame)
  if (path == null) return noteUnsupported(frame, `Unsupported array mutation target ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const current = readPath(path, frame, target.expression)
  if (current.kind !== 'array') return noteUnsupported(frame, `${target.name.text} expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  if (target.name.text === 'splice') {
    forgetRoot(frame.env, path.root)
    return frame.env.get(path.root) ?? unknownArray(valuePathExpression(path))
  }
  const next = {...current, elements: null, summary: null}
  writePath(path, next, frame)
  return next
}

function evaluateResolvedFunctionCall(
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
  return valueWithStructuralFallback(
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
      order: loop.statementIndex,
      conditional: frame.conditionalDepth > 0,
      length: symbolicLength ?? nextLength,
      element: values[0] ?? null,
      base: current,
      cursorPaths: expressionCursorPaths(expression.arguments[0]),
    })
  }
  const next: ArrayValue = {
    ...current,
    length: symbolicLength ?? nextLength,
    elements: loop?.mode === 'symbolic' ? null : elements,
    element,
    summary: mergeArraySummary(current.summary, currentLoopPushSummary(frame)),
  }
  writePath(path, next, frame)
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

function evaluateMapCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const source = evaluateExpression(target.expression, frame)
  if (source.kind !== 'array') return noteUnsupported(frame, `map expected an array: ${target.expression.getText(frame.program.sourceFile)}`, target.expression)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, 'map callback must be an inline function', callback ?? expression)
  const sourceExpr = sourceExpression(source, target.expression, frame)
  const abstractElement = evaluateMapElement(source, sourceExpr, callbackFn, frame)
  return {
    kind: 'array',
    layout: 'collection',
    length: source.length,
    elements: null,
    element: abstractElement,
    expr: expression.getText(frame.program.sourceFile),
    summary: emptyArraySummary(mapOrigin(source, sourceExpr)),
  }
}

function evaluateMapElement(source: ArrayValue, sourceExpr: string, callbackFn: ArrayCallbackFunction, frame: InterpreterFrame): Value | null {
  const item = source.element ?? unknownObject(`${sourceExpr}[]`)
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
  const sourceExpr = sourceExpression(source, target.expression, frame)
  const summary = emptyArraySummary(filterOrigin(source, sourceExpr))
  const length = numberValue(0, source.length.max, true, `${expression.getText(frame.program.sourceFile)}.length`)
  const element = filteredElement(source, sourceExpr, callbackFn, frame)
  addLengthAtMostSourceFact(length, source.length, frame)
  return {
    kind: 'array',
    layout: 'collection',
    length,
    elements: null,
    element,
    expr: expression.getText(frame.program.sourceFile),
    summary,
  }
}

function filteredElement(source: ArrayValue, sourceExpr: string, callbackFn: ArrayCallbackFunction, frame: InterpreterFrame): Value | null {
  const element = source.element ?? unknownObject(`${sourceExpr}[]`)
  const predicate = callbackPredicateExpression(callbackFn)
  if (predicate == null) return source.element
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

function addLengthAtMostSourceFact(length: NumberValue, sourceLength: NumberValue, frame: InterpreterFrame) {
  const fact = comparisonConstraint(length, '<=', sourceLength)
  if (fact != null) frame.assumptions = mergeAssumptions(frame.assumptions, [fact])
}

function sourceExpression(source: ArrayValue, expression: ts.Expression, frame: InterpreterFrame): string {
  return source.expr ?? expression.getText(frame.program.sourceFile)
}

function evaluatedArguments(args: ts.NodeArray<ts.Expression>, frame: InterpreterFrame): Value[] {
  return args.map(arg => evaluateExpression(arg, frame))
}

function resolveCallTarget(target: ts.Expression, program: Program): InterpreterCallTarget {
  if (ts.isIdentifier(target)) return resolveIdentifierCallTarget(target.text, program)
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    return resolveNamespaceMemberCallTarget(target.expression.text, target.name.text, program, new Set())
  }
  return {kind: 'unresolved', reason: `Unsupported call ${target.getText(program.sourceFile)}`}
}

function resolveIdentifierCallTarget(name: string, program: Program, seen = new Set<string>()): InterpreterCallTarget {
  const local = program.functions.get(name)
  if (local != null) return {kind: 'function', program, functionName: name, fn: local}

  const key = `${program.sourceId}#${name}`
  if (seen.has(key)) return {kind: 'unresolved', reason: `Cyclic call alias at ${program.file}#${name}`}
  seen.add(key)

  const alias = program.callAliases.get(name)
  if (alias != null) {
    if (alias.kind === 'math') return {kind: 'math', name: alias.name}
    if (alias.kind === 'identifier') return resolveIdentifierCallTarget(alias.name, program, seen)
    return resolveNamespaceMemberCallTarget(alias.namespace, alias.exportedName, program, seen)
  }

  const unsupportedAlias = program.unsupportedCallAliases.get(name)
  if (unsupportedAlias != null) return {kind: 'unresolved', reason: unsupportedAlias}

  const binding = program.imports.get(name)
  if (binding == null) return {kind: 'unresolved', reason: `Unknown function ${name}`}
  if (binding.kind === 'unresolved') return {kind: 'unresolved', reason: binding.reason}
  if (binding.kind === 'namespace') return {kind: 'unresolved', reason: `Unsupported namespace call ${name}`}
  return resolveImportedCallTarget(name, binding, seen)
}

function resolveNamespaceMemberCallTarget(namespace: string, exportedName: string, program: Program, seen: Set<string>): InterpreterCallTarget {
  const binding = program.imports.get(namespace)
  if (binding == null || binding.kind === 'resolved') return {kind: 'unresolved', reason: `Unsupported call ${namespace}.${exportedName}`}
  if (binding.kind === 'unresolved') return {kind: 'unresolved', reason: binding.reason}
  const member = binding.members.get(exportedName) ?? {module: binding.module, sourceName: exportedName}
  return resolveImportedCallTarget(`${namespace}.${exportedName}`, {
    kind: 'resolved',
    importedName: exportedName,
    sourceName: member.sourceName,
    specifier: binding.specifier,
    module: member.module,
  }, seen)
}

function resolveImportedCallTarget(
  localName: string,
  binding: Extract<ImportedBinding, {kind: 'resolved'}>,
  seen: Set<string>,
): InterpreterCallTarget {
  const sourceName = binding.sourceName
  const target = resolveIdentifierCallTarget(sourceName, binding.module, seen)
  if (target.kind === 'unresolved') return {kind: 'unresolved', reason: `${localName} resolved to ${sourceName}: ${target.reason}`}
  if (target.kind === 'math') return target
  return {
    ...target,
    imported: target.imported ?? {localName, binding},
  }
}

function pathFromExpression(expression: ts.Expression, frame: InterpreterFrame): ValuePath | null {
  return pathFromSourceExpression(expression, indexExpression => evaluateExpression(indexExpression, frame))
}

function classMemberFunctionForPropertyAccess(
  access: ts.PropertyAccessExpression,
  frame: InterpreterFrame,
): {program: Program; functionName: string; fn: FitFunction; imported?: {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>}} | null {
  const member = classMemberForPropertyAccess(access, frame)
  if (member == null) return null
  const program = programForClassMember(member.declaration, frame)
  if (program == null) return null
  const className = member.className
  const functionName = `${className}.${access.name.text}`
  const fn = program.functions.get(functionName)
  if (fn == null) return null
  const imported = program === frame.program ? null : importedClassBinding(className, program, frame.program)
  return {
    program,
    functionName,
    fn,
    ...(imported == null ? {} : {imported}),
  }
}

function classMemberForPropertyAccess(access: ts.PropertyAccessExpression, frame: InterpreterFrame): {className: string; declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | null} | null {
  const checker = frame.program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (
    declaration != null
    && (ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration))
    && ts.isClassDeclaration(declaration.parent)
    && declaration.parent.name != null
  ) {
    return {className: declaration.parent.name.text, declaration}
  }

  if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const current = frame.stack.at(-1)
    const dot = current?.indexOf('.') ?? -1
    if (current != null && dot > 0) return {className: current.slice(0, dot), declaration: null}
  }

  return null
}

function programForClassMember(declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | null, frame: InterpreterFrame): Program | null {
  if (declaration == null) return frame.program
  const sourceFile = declaration.getSourceFile()
  if (sameProgramSourceFile(frame.program, sourceFile)) return frame.program
  return importedPrograms(frame.program).find(program => sameProgramSourceFile(program, sourceFile)) ?? null
}

function importedPrograms(program: Program): Program[] {
  const programs: Program[] = []
  for (const binding of program.imports.values()) {
    if (binding.kind === 'resolved' || binding.kind === 'namespace') programs.push(binding.module)
    if (binding.kind !== 'namespace') continue
    for (const member of binding.members.values()) programs.push(member.module)
  }
  return programs
}

function sameProgramSourceFile(program: Program, sourceFile: ts.SourceFile) {
  return program.sourceFile === sourceFile || program.sourceId === sourceFile.fileName
}

function importedClassBinding(className: string, classProgram: Program, callerProgram: Program): {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>} | null {
  for (const [localName, binding] of callerProgram.imports) {
    if (binding.kind !== 'resolved') continue
    if (binding.module !== classProgram) continue
    if (binding.sourceName === className || binding.importedName === className) return {localName, binding}
  }
  return null
}

function isInlineFunction(expression: ts.Expression): expression is ArrayCallbackFunction {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
}

function nodeText(node: ts.Node, frame: InterpreterFrame) {
  return node.getSourceFile() === frame.program.sourceFile
    ? node.getText(frame.program.sourceFile)
    : node.getText()
}
