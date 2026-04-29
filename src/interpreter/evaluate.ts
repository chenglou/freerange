import * as ts from 'typescript'
import type {
  ArrayCallbackFunction,
  Program,
} from '../check-types.ts'
import {
  bindingElementPropertyName,
  bindingNames,
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
  mergeAssumptions,
  literalValue,
  mergeArraySummary,
  mergeElementValue,
  moduloNumbers,
  multiplyNumbers,
  nullValue,
  numberValue,
  powerNumbers,
  conditionalRunningSumNumber,
  runningExtremumNumber,
  runningSumNumber,
  subtractNumbers,
  unknown,
  unknownArray,
  unknownNumber,
  unknownObject,
  linearNameForExpression,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {
  indexedElementPathValue,
  sequenceSummaryFromLoopPush,
  type LoopExtremum,
  type LoopPush,
  type LoopScalarUpdate,
} from '../loop-summary.ts'
import {
  linearConstant,
  linearVariable,
  numericLiteralValue,
} from '../linear.ts'
import {resolveFitExport, type FitFunction, type FitFunctionNode} from '../modules.ts'
import type {ComparisonOperator} from '../parser.ts'
import {valueFromSyntaxTypeShape} from '../shapes.ts'
import {expressionRootName} from '../source-expressions.ts'
import {localizeFreshContainerValue} from '../value-localize.ts'
import {
  comparisonConstraint,
  conditionalRunningSumFacts,
} from '../proof.ts'
import {
  childFrame,
  frameWithProgram,
  joinFrameEnvs,
  noteUnsupported,
  rootFrame,
  type InterpreterFlow,
  type InterpreterFrame,
  type InterpreterIssue,
  type InterpreterLoopContext,
  type InterpreterLoopPush,
} from './context.ts'

export type InterpreterFunctionResult = {
  value: Value
  issues: InterpreterIssue[]
}

export type InterpreterBodyResult = InterpreterFunctionResult & {
  env: Map<string, Value>
  assumptions: LinearConstraint[]
}

type PathSegment =
  | {kind: 'prop'; name: string}
  | {kind: 'index'; index: number}

type ValuePath = {
  root: string
  segments: PathSegment[]
}

type PendingAbstractScalarAdd = {
  increment: NumberValue
  order: number
}

type PendingAbstractConditionalScalarAdd = PendingAbstractScalarAdd

type PendingAbstractExtremum = LoopExtremum & {
  candidateExpression: ts.Expression
}

type PendingAbstractReducers = {
  adds: Map<string, PendingAbstractScalarAdd>
  conditionalAdds: Map<string, PendingAbstractConditionalScalarAdd>
  extrema: Map<string, PendingAbstractExtremum>
}

type AbstractLoopReducerCapture =
  | {kind: 'captured'}
  | {kind: 'unsupported'; value: Value}
  | {kind: 'none'}

type AbstractLoopScalarAdd = {
  targetName: string
  increment: NumberValue
  incrementExpression: ts.Expression
}

type IndexedForLoopShape = {
  indexName: string
  source: IndexedForLoopSource
}

type IndexedForLoopSource =
  | {kind: 'limit'; expression: ts.Expression}
  | {kind: 'array'; expression: ts.Expression; lengthExpression: ts.Expression}

type IndexedForLoopBound = {
  length: NumberValue
  expression: ts.Expression
  origin: IndexedForLoopOrigin | null
}

type IndexedForLoopOrigin = {
  source: ArrayValue
  sourceExpr: string
}

type IndexedForPushRecord = {
  path: ValuePath
  count: number
  initialEmpty: boolean
  conditional: boolean
}

type IndexedForPushResult =
  | {kind: 'ok'; push: InterpreterLoopPush | null; initialEmpty: boolean; conditional: boolean}
  | {kind: 'error'; value: Value}

type IndexedForGuardedContext = {
  indexName: string
  length: NumberValue
  source: ArrayValue | null
  order: number
  loop: InterpreterLoopContext
  pushedArrays: Map<string, IndexedForPushRecord>
}

export function evaluateInterpreterFunction(program: Program, functionName: string): InterpreterFunctionResult {
  const frame = rootFrame(program)
  const fn = program.functions.get(functionName)
  if (fn == null) {
    return {
      value: noteUnsupported(frame, `Unknown function ${functionName}`),
      issues: frame.issues,
    }
  }
  const value = invokeFitFunction(fn, [], frame, program, frame.env)
  return {value, issues: frame.issues}
}

export function evaluateInterpreterFunctionBody(
  program: Program,
  fn: FitFunction,
  env: Map<string, Value>,
  stack: string[] = [fn.name],
  assumptions: LinearConstraint[] = [],
): InterpreterBodyResult {
  const frame: InterpreterFrame = {
    program,
    env: new Map(env),
    issues: [],
    stack,
    loopStack: [],
    conditionalDepth: 0,
    assumptions: [...assumptions],
  }
  const value = evaluateFunctionNodeBody(fn.name, fn.node, frame)
  return {value, env: frame.env, issues: frame.issues, assumptions: frame.assumptions}
}

function invokeFitFunction(
  fn: FitFunction,
  argumentValues: (Value | undefined)[],
  caller: InterpreterFrame,
  program: Program,
  baseEnv: Map<string, Value>,
): Value {
  return invokeFunctionNode(fn.name, fn.node, argumentValues, frameWithProgram(caller, program, new Map(baseEnv), fn.name))
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
  if (ts.isArrowFunction(fn) && ts.isExpression(fn.body)) return evaluateExpression(fn.body, frame)
  if (fn.body == null) return noteUnsupported(frame, `Function ${name} has no body`)
  if (!ts.isBlock(fn.body)) return noteUnsupported(frame, `Function ${name} body is unsupported`)
  const flow = evaluateStatements(fn.body.statements, frame)
  return flow.kind === 'return' ? flow.value : noteUnsupported(frame, `Function ${name} did not return`)
}

function bindParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>, argumentValues: (Value | undefined)[], frame: InterpreterFrame) {
  for (let index = 0; index < parameters.length; index++) {
    const param = parameters[index]!
    const argument = argumentValues[index]
    const value = argument ?? (param.initializer == null ? unknownParamPatternValue(param, frame) : evaluateExpression(param.initializer, frame))
    bindPattern(param.name, value, frame)
  }
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
        noteUnsupported(frame, 'Object rest binding is unsupported')
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
      noteUnsupported(frame, 'Array rest binding is unsupported')
      bindPattern(elementName, unknownArray('rest'), frame)
      return
    }
    bindPattern(elementName, readArrayIndexValue(value, index, `${valueExpr(value) ?? 'param'}[${index}]`), frame)
  })
}

function evaluateStatements(statements: ts.NodeArray<ts.Statement>, frame: InterpreterFrame): InterpreterFlow {
  for (const statement of statements) {
    const flow = evaluateStatement(statement, frame)
    if (flow.kind !== 'fallthrough') return flow
  }
  return {kind: 'fallthrough'}
}

function evaluateStatement(statement: ts.Statement, frame: InterpreterFrame): InterpreterFlow {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) evaluateVariableDeclaration(declaration, frame)
    return {kind: 'fallthrough'}
  }
  if (ts.isReturnStatement(statement)) {
    return {kind: 'return', value: statement.expression == null ? unknown('Empty return') : evaluateExpression(statement.expression, frame)}
  }
  if (ts.isExpressionStatement(statement)) {
    evaluateExpression(statement.expression, frame)
    return {kind: 'fallthrough'}
  }
  if (ts.isForOfStatement(statement)) return evaluateForOfStatement(statement, frame)
  if (ts.isForStatement(statement)) return evaluateForStatement(statement, frame)
  if (ts.isBlock(statement)) return evaluateStatements(statement.statements, frame)
  if (ts.isIfStatement(statement)) return evaluateIfStatement(statement, frame)
  noteUnsupported(frame, `Unsupported statement ${statement.getText(frame.program.sourceFile)}`)
  return {kind: 'fallthrough'}
}

function evaluateVariableDeclaration(declaration: ts.VariableDeclaration, frame: InterpreterFrame) {
  const value = declaration.initializer == null
    ? unknown(`Uninitialized local ${declaration.name.getText(frame.program.sourceFile)}`)
    : evaluateExpression(declaration.initializer, frame)
  bindPattern(declaration.name, declarationValue(declaration.name, value, declaration.initializer), frame)
}

function declarationValue(name: ts.BindingName, value: Value, initializer: ts.Expression | undefined): Value {
  if (!ts.isIdentifier(name) || initializer == null) return value
  return isFreshContainerInitializer(initializer) ? localizeFreshContainerValue(value, name.text, {preserveLinear: true}) : value
}

function isFreshContainerInitializer(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  return ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)
}

function evaluateIfStatement(statement: ts.IfStatement, frame: InterpreterFrame): InterpreterFlow {
  const truth = literalBoolean(evaluateExpression(statement.expression, frame))
  if (truth === true) return evaluateConditionalBranch(statement.thenStatement, frame)
  if (truth === false) return statement.elseStatement == null ? {kind: 'fallthrough'} : evaluateConditionalBranch(statement.elseStatement, frame)

  const thenFrame = branchFrame(frame, statement.expression, true, '<if-true>')
  const elseFrame = branchFrame(frame, statement.expression, false, '<if-false>')
  const thenFlow = evaluateConditionalBranch(statement.thenStatement, thenFrame)
  const elseFlow: InterpreterFlow = statement.elseStatement == null ? {kind: 'fallthrough'} : evaluateConditionalBranch(statement.elseStatement, elseFrame)
  if (thenFlow.kind === 'return' && elseFlow.kind === 'return') return {kind: 'return', value: joinValues(thenFlow.value, elseFlow.value)}
  if (thenFlow.kind === 'return') {
    frame.env = elseFrame.env
    return {kind: 'fallthrough'}
  }
  if (elseFlow.kind === 'return') {
    frame.env = thenFrame.env
    return {kind: 'fallthrough'}
  }
  frame.env = joinFrameEnvs(thenFrame.env, elseFrame.env)
  return {kind: 'fallthrough'}
}

function evaluateBranch(statement: ts.Statement, frame: InterpreterFrame): InterpreterFlow {
  return ts.isBlock(statement) ? evaluateStatements(statement.statements, frame) : evaluateStatement(statement, frame)
}

function evaluateConditionalBranch(statement: ts.Statement, frame: InterpreterFrame): InterpreterFlow {
  frame.conditionalDepth++
  try {
    return evaluateBranch(statement, frame)
  } finally {
    frame.conditionalDepth--
  }
}

function evaluateForOfStatement(statement: ts.ForOfStatement, frame: InterpreterFrame): InterpreterFlow {
  if (statement.awaitModifier != null) return {kind: 'return', value: noteUnsupported(frame, 'for await is unsupported')}
  const source = evaluateExpression(statement.expression, frame)
  if (source.kind !== 'array') return {kind: 'return', value: noteUnsupported(frame, `for..of expected an array: ${statement.expression.getText(frame.program.sourceFile)}`)}
  if (source.elements == null) return evaluateAbstractForOfStatement(statement, source, frame)
  const itemName = forOfItemName(statement.initializer)
  const scopedNames = [...forOfScopedNames(statement.initializer), ...forOfBodyScopedNames(statement.statement)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const sourceExpr = sourceExpression(source, statement.expression, frame)
  if (itemName != null) frame.loopStack.push({source, sourceExpr, abstract: false, statementIndex: 0, pushes: []})
  try {
    for (const element of source.elements) {
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

function evaluateAbstractForOfStatement(statement: ts.ForOfStatement, source: ArrayValue, frame: InterpreterFrame): InterpreterFlow {
  if (!ts.isBlock(statement.statement)) return {kind: 'return', value: noteUnsupported(frame, 'Abstract for..of supports block bodies only')}
  const itemName = forOfItemName(statement.initializer)
  if (itemName == null) return {kind: 'return', value: noteUnsupported(frame, 'Abstract for..of supports simple variable bindings only')}
  const scopedNames = [...forOfScopedNames(statement.initializer), ...blockScopedNames(statement.statement)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const sourceExpr = sourceExpression(source, statement.expression, frame)
  const item = source.element ?? unknownObject(`${sourceExpr}[]`)
  const loop: InterpreterLoopContext = {source, sourceExpr, abstract: true, statementIndex: 0, pushes: []}
  const reducers = pendingAbstractReducers()
  frame.loopStack.push(loop)
  try {
    bindForOfInitializer(statement.initializer, item, frame)
    let sawScalarUpdate = false
    for (let index = 0; index < statement.statement.statements.length; index++) {
      const child = statement.statement.statements[index]!
      loop.statementIndex = index
      const reducer = captureAbstractLoopReducer(child, index, reducers, 'Abstract for..of', frame)
      if (reducer.kind === 'unsupported') return {kind: 'return', value: reducer.value}
      if (reducer.kind === 'captured') {
        sawScalarUpdate = true
        continue
      }
      if (sawScalarUpdate) {
        return {kind: 'return', value: noteUnsupported(frame, `Abstract for..of scalar cursor updates must be the final body statements: ${child.getText(frame.program.sourceFile)}`)}
      }
      if (ts.isVariableStatement(child)) {
        for (const declaration of child.declarationList.declarations) evaluateVariableDeclaration(declaration, frame)
        continue
      }
      if (ts.isExpressionStatement(child) && isPushCallExpression(child.expression)) {
        evaluateExpression(child.expression, frame)
        continue
      }
      if (ts.isIfStatement(child)) {
        if (!abstractLoopBranchSupported(child)) {
          return {kind: 'return', value: noteUnsupported(frame, `Abstract for..of guarded bodies only support local bindings and direct push calls: ${child.getText(frame.program.sourceFile)}`)}
        }
        const flow = evaluateIfStatement(child, frame)
        if (flow.kind !== 'fallthrough') return flow
        continue
      }
      return {kind: 'return', value: noteUnsupported(frame, `Abstract for..of body only supports local bindings and direct push calls: ${child.getText(frame.program.sourceFile)}`)}
    }
    const error = finalizeAbstractLoop(loop, reducers, 'Abstract for..of', frame)
    if (error != null) return {kind: 'return', value: error}
  } finally {
    frame.loopStack.pop()
    restoreScopedValues(frame.env, scopedValues)
  }
  return {kind: 'fallthrough'}
}

function evaluateForStatement(statement: ts.ForStatement, frame: InterpreterFrame): InterpreterFlow {
  const shape = indexedForLoopShape(statement)
  if (shape == null) return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loops support for (let i = 0; i < limit; i++) style loops')}
  if (!ts.isBlock(statement.statement)) return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loops support block bodies only')}
  const bound = evaluateIndexedForLoopBound(shape, frame)
  if ('error' in bound) return {kind: 'return', value: bound.error}
  if (!bound.length.isInteger || bound.length.min < 0) return {kind: 'return', value: noteUnsupported(frame, 'Indexed for loop limit expected a non-negative integer')}

  const scopedNames = [shape.indexName, ...blockScopedNames(statement.statement)]
  const scopedValues = saveScopedValues(frame.env, scopedNames)
  const length = indexedLoopLength(bound.length, bound.expression, frame)
  const indexValue = indexedElementPathValue(shape.indexName, length)
  frame.env.set(shape.indexName, indexValue)
  frame.assumptions = mergeAssumptions(frame.assumptions, indexedElementAssumptions(indexValue, length))
  const loop = indexedForLoopContext(bound, length, frame)
  const reducers = pendingAbstractReducers()
  try {
    const pushedArrays = new Map<string, IndexedForPushRecord>()
    let sawScalarUpdate = false
    for (let order = 0; order < statement.statement.statements.length; order++) {
      const child = statement.statement.statements[order]!
      const reducer = captureAbstractLoopReducer(child, order, reducers, 'Indexed for loop', frame)
      if (reducer.kind === 'unsupported') return {kind: 'return', value: reducer.value}
      if (reducer.kind === 'captured') {
        sawScalarUpdate = true
        continue
      }
      if (sawScalarUpdate) {
        return {kind: 'return', value: noteUnsupported(frame, `Indexed for loop scalar cursor updates must be the final body statements: ${child.getText(frame.program.sourceFile)}`)}
      }
      if (ts.isVariableStatement(child)) {
        for (const declaration of child.declarationList.declarations) evaluateVariableDeclaration(declaration, frame)
        continue
      }
      if (ts.isExpressionStatement(child) && isPushCallExpression(child.expression)) {
        const pushPath = pathFromExpression(child.expression.expression.expression, frame)
        if (pushPath == null) return {kind: 'return', value: noteUnsupported(frame, `Unsupported push target ${child.expression.expression.expression.getText(frame.program.sourceFile)}`)}
        const push = evaluateIndexedForPush(child.expression, pushPath, shape.indexName, length, bound.origin?.source ?? null, order, frame)
        if (push.kind === 'error') return {kind: 'return', value: push.value}
        if (push.push != null) loop.pushes.push(push.push)
        rememberIndexedForPush(pushedArrays, pushPath, push.initialEmpty, push.conditional)
        continue
      }
      if (ts.isIfStatement(child)) {
        const guardError = evaluateIndexedForGuardedStatement(child, {
          indexName: shape.indexName,
          length,
          source: bound.origin?.source ?? null,
          order,
          loop,
          pushedArrays,
        }, frame)
        if (guardError != null) return {kind: 'return', value: guardError}
        continue
      }
      return {kind: 'return', value: noteUnsupported(frame, `Indexed for loop body only supports local bindings and direct push calls: ${child.getText(frame.program.sourceFile)}`)}
    }
    const cursorError = finalizeAbstractLoop(loop, reducers, 'Indexed for loop', frame)
    if (cursorError != null) return {kind: 'return', value: cursorError}
    finalizeIndexedForPushedArrays(pushedArrays, bound.origin, frame)
  } finally {
    restoreScopedValues(frame.env, scopedValues)
  }
  return {kind: 'fallthrough'}
}

function evaluateIndexedForGuardedStatement(
  statement: ts.IfStatement,
  context: IndexedForGuardedContext,
  frame: InterpreterFrame,
): Value | null {
  if (statement.elseStatement != null) return noteUnsupported(frame, 'Indexed for loop guarded pushes do not support else branches')
  if (!isSideEffectFreeExpression(statement.expression)) return noteUnsupported(frame, 'Indexed for loop guards must be side-effect-free')
  const thenFrame = branchFrame(frame, statement.expression, true, '<indexed-if-true>')
  const elseFrame = branchFrame(frame, statement.expression, false, '<indexed-if-false>')
  thenFrame.conditionalDepth++
  try {
    const error = evaluateIndexedForGuardedBody(statement.thenStatement, context, thenFrame)
    if (error != null) return error
  } finally {
    thenFrame.conditionalDepth--
  }
  frame.env = joinFrameEnvs(thenFrame.env, elseFrame.env)
  return null
}

function evaluateIndexedForGuardedBody(
  statement: ts.Statement,
  context: IndexedForGuardedContext,
  frame: InterpreterFrame,
): Value | null {
  const statements = ts.isBlock(statement) ? statement.statements : [statement]
  for (const child of statements) {
    if (ts.isVariableStatement(child)) {
      for (const declaration of child.declarationList.declarations) evaluateVariableDeclaration(declaration, frame)
      continue
    }
    if (ts.isExpressionStatement(child) && isPushCallExpression(child.expression)) {
      const pushPath = pathFromExpression(child.expression.expression.expression, frame)
      if (pushPath == null) return noteUnsupported(frame, `Unsupported push target ${child.expression.expression.expression.getText(frame.program.sourceFile)}`)
      const push = evaluateIndexedForPush(child.expression, pushPath, context.indexName, context.length, context.source, context.order, frame)
      if (push.kind === 'error') return push.value
      if (push.push != null) context.loop.pushes.push(push.push)
      rememberIndexedForPush(context.pushedArrays, pushPath, push.initialEmpty, push.conditional)
      continue
    }
    if (ts.isIfStatement(child)) {
      const error = evaluateIndexedForGuardedStatement(child, context, frame)
      if (error != null) return error
      continue
    }
    return noteUnsupported(frame, `Indexed for loop guarded bodies only support local bindings and direct push calls: ${child.getText(frame.program.sourceFile)}`)
  }
  return null
}

function indexedForLoopContext(bound: IndexedForLoopBound, length: NumberValue, frame: InterpreterFrame): InterpreterLoopContext {
  const expr = bound.origin?.sourceExpr ?? bound.expression.getText(frame.program.sourceFile)
  const source = bound.origin == null
    ? unknownArray(expr, length)
    : {...bound.origin.source, length}
  return {source, sourceExpr: expr, abstract: true, statementIndex: 0, pushes: []}
}

function evaluateIndexedForLoopBound(shape: IndexedForLoopShape, frame: InterpreterFrame): IndexedForLoopBound | {error: Value} {
  if (shape.source.kind === 'limit') {
    const length = evaluateExpression(shape.source.expression, frame)
    return length.kind === 'number'
      ? {length, expression: shape.source.expression, origin: null}
      : {error: noteUnsupported(frame, 'Indexed for loop limit expected a number')}
  }

  const source = evaluateExpression(shape.source.expression, frame)
  if (source.kind !== 'array') return {error: noteUnsupported(frame, 'Indexed for loop source expected an array')}
  return {
    length: source.length,
    expression: shape.source.lengthExpression,
    origin: {source, sourceExpr: sourceExpression(source, shape.source.expression, frame)},
  }
}

function indexedForLoopShape(statement: ts.ForStatement): IndexedForLoopShape | null {
  if (statement.initializer == null || !ts.isVariableDeclarationList(statement.initializer)) return null
  if (statement.initializer.declarations.length !== 1) return null
  const declaration = statement.initializer.declarations[0]
  if (declaration == null || !ts.isIdentifier(declaration.name) || declaration.initializer == null) return null
  if (numericLiteralValue(declaration.initializer) !== 0) return null
  const indexName = declaration.name.text
  if (statement.condition == null || statement.incrementor == null) return null
  const condition = unwrapExpression(statement.condition)
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null
  if (!isIdentifierNamed(condition.left, indexName)) return null
  if (!indexedLoopIncrements(statement.incrementor, indexName)) return null
  return {indexName, source: indexedForLoopSource(condition.right)}
}

function indexedForLoopSource(expression: ts.Expression): IndexedForLoopSource {
  const current = unwrapExpression(expression)
  return ts.isPropertyAccessExpression(current) && current.name.text === 'length'
    ? {kind: 'array', expression: current.expression, lengthExpression: current}
    : {kind: 'limit', expression}
}

function indexedLoopIncrements(expression: ts.Expression, indexName: string): boolean {
  const current = unwrapExpression(expression)
  if ((ts.isPostfixUnaryExpression(current) || ts.isPrefixUnaryExpression(current))
    && current.operator === ts.SyntaxKind.PlusPlusToken
    && ts.isIdentifier(current.operand)
    && current.operand.text === indexName) return true
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken) return false
  return isIdentifierNamed(current.left, indexName) && numericLiteralValue(current.right) === 1
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
): IndexedForPushResult {
  const current = readPath(path, frame)
  if (current.kind !== 'array') return {kind: 'error', value: noteUnsupported(frame, `push expected an array: ${expression.expression.expression.getText(frame.program.sourceFile)}`)}
  if (source != null && current === source) return {kind: 'error', value: noteUnsupported(frame, 'Indexed for loop cannot push into its source array')}
  if (expression.arguments.length !== 1) return {kind: 'error', value: noteUnsupported(frame, 'Indexed for loop push supports one item per iteration')}
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
    push: path.segments.length === 0 ? {
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

function rememberIndexedForPush(records: Map<string, IndexedForPushRecord>, path: ValuePath, initialEmpty: boolean, conditional: boolean) {
  const key = valuePathExpression(path)
  const current = records.get(key)
  records.set(key, current == null ? {path, count: 1, initialEmpty, conditional} : {
    ...current,
    count: current.count + 1,
    conditional: current.conditional || conditional,
  })
}

function finalizeIndexedForPushedArrays(records: Map<string, IndexedForPushRecord>, origin: IndexedForLoopOrigin | null, frame: InterpreterFrame) {
  for (const record of records.values()) {
    const value = readPath(record.path, frame)
    if (value.kind !== 'array') continue
    const summary = origin != null && record.count === 1 && record.initialEmpty
      ? mergeArraySummary(value.summary, emptyArraySummary(record.conditional ? filterOrigin(origin.source, origin.sourceExpr) : mapOrigin(origin.source, origin.sourceExpr)))
      : value.summary
    writePath(record.path, {...value, elements: null, summary}, frame)
  }
}

function indexedLoopValue(value: Value, indexName: string, arrayExpr: string, path: string[], length: NumberValue): Value {
  if (value.kind === 'number' && value.expr === indexName) return indexedElementPathValue(loopElementPathExpression(arrayExpr, path), length)
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, indexedLoopValue(prop, indexName, arrayExpr, [...path, name], length))
    return {...value, props}
  }
  if (value.kind === 'array') {
    return {
      ...value,
      elements: value.elements == null ? null : value.elements.map(element => indexedLoopValue(element, indexName, arrayExpr, [...path, '[]'], length)),
      element: value.element == null ? null : indexedLoopValue(value.element, indexName, arrayExpr, [...path, '[]'], length),
    }
  }
  if (value.kind === 'nullable') return {...value, present: indexedLoopValue(value.present, indexName, arrayExpr, path, length)}
  return value
}

function indexedElementAssumptions(value: NumberValue, length: NumberValue): LinearConstraint[] {
  const lower = comparisonConstraint(value, '>=', numberValue(0, 0, true, '0', linearConstant(0)))
  const upper = comparisonConstraint(value, '<', length)
  return [lower, upper].filter((fact): fact is LinearConstraint => fact != null)
}

function expressionIndexPaths(expression: ts.Expression | undefined, indexName: string, path: string[] = []): string[][] {
  if (expression == null) return []
  const unwrapped = unwrapExpression(expression)
  if (isIdentifierNamed(unwrapped, indexName)) return [path]
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const paths: string[][] = []
    for (const property of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text === indexName) paths.push([...path, property.name.text])
        continue
      }
      if (!ts.isPropertyAssignment(property)) continue
      const name = propertyNameText(property.name)
      if (name == null) continue
      paths.push(...expressionIndexPaths(property.initializer, indexName, [...path, name]))
    }
    return paths
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap(element => ts.isSpreadElement(element)
      ? expressionIndexPaths(element.expression, indexName, [...path, '[]'])
      : expressionIndexPaths(element, indexName, [...path, '[]']))
  }
  return []
}

function pendingAbstractReducers(): PendingAbstractReducers {
  return {
    adds: new Map(),
    conditionalAdds: new Map(),
    extrema: new Map(),
  }
}

function captureAbstractLoopReducer(
  statement: ts.Statement,
  order: number,
  reducers: PendingAbstractReducers,
  loopLabel: string,
  frame: InterpreterFrame,
): AbstractLoopReducerCapture {
  if (isUnsupportedConditionalLoopScalarElse(statement, frame)) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} conditional running sums do not support else branches`)}
  }
  const conditionalAdd = readAbstractConditionalLoopScalarAdd(statement, frame)
  if (conditionalAdd != null) return captureAbstractLoopScalarAdd(conditionalAdd, order, reducers, loopLabel, frame, true)

  const scalarAdd = readAbstractLoopScalarAdd(statement, frame)
  if (scalarAdd != null) return captureAbstractLoopScalarAdd(scalarAdd, order, reducers, loopLabel, frame, false)

  const extremum = readAbstractLoopExtremumAssignment(statement, frame)
  if (extremum == null) return {kind: 'none'}
  if (abstractLoopTargetAlreadyUpdated(extremum.targetName, reducers)) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar cursor already updates ${extremum.targetName}`)}
  }
  if (referencesAnyIdentifier(extremum.candidateExpression, abstractLoopUpdatedTargets(reducers))) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar extrema candidates cannot depend on an earlier scalar update`)}
  }
  reducers.extrema.set(extremum.targetName, extremum)
  return {kind: 'captured'}
}

function captureAbstractLoopScalarAdd(
  add: AbstractLoopScalarAdd,
  order: number,
  reducers: PendingAbstractReducers,
  loopLabel: string,
  frame: InterpreterFrame,
  conditional: boolean,
): AbstractLoopReducerCapture {
  if (abstractLoopTargetAlreadyUpdated(add.targetName, reducers)) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar cursor already updates ${add.targetName}`)}
  }
  if (referencesAnyIdentifier(add.incrementExpression, abstractLoopUpdatedTargets(reducers))) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar cursor increments cannot depend on an earlier cursor update`)}
  }
  const target = {increment: add.increment, order}
  if (conditional) reducers.conditionalAdds.set(add.targetName, target)
  else reducers.adds.set(add.targetName, target)
  return {kind: 'captured'}
}

function readAbstractLoopScalarAdd(statement: ts.Statement, frame: InterpreterFrame): AbstractLoopScalarAdd | null {
  if (!ts.isExpressionStatement(statement)) return null
  const expression = unwrapExpression(statement.expression)
  if (!ts.isBinaryExpression(expression)) return null
  const targetName = identifierTargetName(expression.left)
  if (targetName == null) return null
  const incrementExpression = scalarIncrementExpression(expression, targetName)
  if (incrementExpression == null || referencesIdentifier(incrementExpression, targetName)) return null
  const increment = evaluateExpression(incrementExpression, frame)
  return increment.kind === 'number' ? {targetName, increment, incrementExpression} : null
}

function readAbstractConditionalLoopScalarAdd(statement: ts.Statement, frame: InterpreterFrame): AbstractLoopScalarAdd | null {
  if (!ts.isIfStatement(statement) || statement.elseStatement != null || !isSideEffectFreeExpression(statement.expression)) return null
  return readAbstractLoopScalarAdd(singleStatement(statement.thenStatement), frame)
}

function readAbstractLoopExtremumAssignment(statement: ts.Statement, frame: InterpreterFrame): PendingAbstractExtremum | null {
  if (!ts.isExpressionStatement(statement)) return null
  const expression = unwrapExpression(statement.expression)
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const targetName = identifierTargetName(expression.left)
  if (targetName == null) return null
  const call = unwrapExpression(expression.right)
  if (!ts.isCallExpression(call)) return null
  const target = unwrapExpression(call.expression)
  if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression) || target.expression.text !== 'Math') return null
  if (target.name.text !== 'min' && target.name.text !== 'max') return null
  if (call.arguments.length !== 2) return null
  const left = call.arguments[0]!
  const right = call.arguments[1]!
  const candidateExpression =
    isIdentifierNamed(left, targetName) ? right
      : isIdentifierNamed(right, targetName) ? left
        : null
  if (candidateExpression == null || referencesIdentifier(candidateExpression, targetName)) return null
  const candidate = evaluateExpression(candidateExpression, frame)
  return candidate.kind === 'number'
    ? {targetName, kind: target.name.text, candidate, candidateExpression}
    : null
}

function isUnsupportedConditionalLoopScalarElse(statement: ts.Statement, frame: InterpreterFrame): boolean {
  return ts.isIfStatement(statement)
    && statement.elseStatement != null
    && isSideEffectFreeExpression(statement.expression)
    && readAbstractLoopScalarAdd(singleStatement(statement.thenStatement), frame) != null
}

function singleStatement(statement: ts.Statement): ts.Statement {
  return ts.isBlock(statement) && statement.statements.length === 1 ? statement.statements[0]! : statement
}

function scalarIncrementExpression(expression: ts.BinaryExpression, targetName: string): ts.Expression | null {
  if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) return expression.right
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const right = unwrapExpression(expression.right)
  if (!ts.isBinaryExpression(right) || right.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
  if (isIdentifierNamed(right.left, targetName)) return right.right
  if (isIdentifierNamed(right.right, targetName)) return right.left
  return null
}

function identifierTargetName(expression: ts.Expression): string | null {
  const target = unwrapExpression(expression)
  return ts.isIdentifier(target) ? target.text : null
}

function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const target = unwrapExpression(expression)
  return ts.isIdentifier(target) && target.text === name
}

function referencesAnyIdentifier(expression: ts.Expression, names: Set<string>): boolean {
  for (const name of names) {
    if (referencesIdentifier(expression, name)) return true
  }
  return false
}

function abstractLoopUpdatedTargets(reducers: PendingAbstractReducers): Set<string> {
  return new Set([...reducers.adds.keys(), ...reducers.conditionalAdds.keys(), ...reducers.extrema.keys()])
}

function abstractLoopTargetAlreadyUpdated(targetName: string, reducers: PendingAbstractReducers): boolean {
  return reducers.adds.has(targetName) || reducers.conditionalAdds.has(targetName) || reducers.extrema.has(targetName)
}

function referencesIdentifier(node: ts.Node, name: string): boolean {
  let found = false
  const visit = (current: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(current) && current.text === name) {
      found = true
      return
    }
    if (current !== node && isFunctionLikeWithBody(current)) return
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node))
    && node.body != null
}

function isSideEffectFreeExpression(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return true
  if (ts.isPropertyAccessExpression(current)) return isSideEffectFreeExpression(current.expression)
  if (ts.isElementAccessExpression(current)) return current.argumentExpression != null
    && isSideEffectFreeExpression(current.expression)
    && isSideEffectFreeExpression(current.argumentExpression)
  if (ts.isNumericLiteral(current) || ts.isStringLiteral(current) || current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isPrefixUnaryExpression(current)) return isSideEffectFreeExpression(current.operand)
  if (ts.isBinaryExpression(current)) return !isAssignmentOperator(current.operatorToken.kind)
    && isSideEffectFreeExpression(current.left)
    && isSideEffectFreeExpression(current.right)
  if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) return isSideEffectFreeExpression(current.expression)
  return false
}

function abstractLoopBranchSupported(statement: ts.Statement): boolean {
  if (ts.isBlock(statement)) return statement.statements.every(abstractLoopBranchSupported)
  if (ts.isVariableStatement(statement)) return true
  if (ts.isExpressionStatement(statement)) return isPushCallExpression(statement.expression)
  if (ts.isIfStatement(statement)) {
    return abstractLoopBranchSupported(statement.thenStatement)
      && (statement.elseStatement == null || abstractLoopBranchSupported(statement.elseStatement))
  }
  return false
}

function finalizeAbstractLoop(
  loop: InterpreterLoopContext,
  reducers: PendingAbstractReducers,
  loopLabel: string,
  frame: InterpreterFrame,
): Value | null {
  if (reducers.adds.size === 0 && reducers.conditionalAdds.size === 0 && reducers.extrema.size === 0) return null
  if (reducers.conditionalAdds.size > 0 && (reducers.adds.size > 0 || reducers.extrema.size > 0 || loop.pushes.length > 0)) {
    return noteUnsupported(frame, `${loopLabel} conditional running sums support guarded scalar updates only`)
  }
  if (reducers.extrema.size > 0 && (reducers.adds.size > 0 || loop.pushes.length > 0)) {
    return noteUnsupported(frame, `${loopLabel} scalar extrema support extrema updates only`)
  }
  const updates = new Map<string, LoopScalarUpdate>()
  for (const [targetName, pending] of reducers.adds) {
    const start = frame.env.get(targetName)
    if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar cursor expected ${targetName} to be a number`)
    updates.set(targetName, {
      start,
      increment: pending.increment,
      end: runningSumNumber(start, loop.source.length, pending.increment),
    })
  }
  for (const [targetName, pending] of reducers.conditionalAdds) {
    const start = frame.env.get(targetName)
    if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar cursor expected ${targetName} to be a number`)
    const end = conditionalRunningSumNumber(targetName, start, loop.source.length, pending.increment)
    updates.set(targetName, {start, increment: pending.increment, end})
    frame.assumptions = mergeAssumptions(frame.assumptions, conditionalRunningSumFacts(end, start, loop.source.length, pending.increment))
  }
  for (const [targetName, extremum] of reducers.extrema) {
    const start = frame.env.get(targetName)
    if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar extremum expected ${targetName} to be a number`)
    frame.env.set(targetName, runningExtremumNumber(extremum.kind, targetName, start, loop.source.length, extremum.candidate))
  }

  const cursorError = applyAbstractLoopCursorFacts(loop, reducers.adds, updates, loopLabel, frame)
  if (cursorError != null) return cursorError
  for (const [targetName, update] of updates) frame.env.set(targetName, update.end)
  return null
}

function applyAbstractLoopCursorFacts(
  loop: InterpreterLoopContext,
  pendingAdds: Map<string, PendingAbstractScalarAdd>,
  updates: Map<string, LoopScalarUpdate>,
  loopLabel: string,
  frame: InterpreterFrame,
): Value | null {
  const arrayNames = new Set(loop.pushes.map(push => push.arrayName))
  for (const arrayName of arrayNames) {
    const target = frame.env.get(arrayName)
    if (target?.kind !== 'array') continue
    let summary = target.summary
    const pushes = loop.pushes.filter(item => item.arrayName === arrayName)
    let element = pushes[0]?.base.element ?? null
    for (const push of pushes) {
      const loopPush = abstractLoopPushShape(push, updates)
      for (const cursorPath of loopPush.cursorPaths) {
        const pending = pendingAdds.get(cursorPath.targetName)
        if (pending != null && pending.order <= push.order) {
          return noteUnsupported(frame, `${loopLabel} scalar cursor ${cursorPath.targetName} must be pushed before it is updated`)
        }
      }
      element = mergeElementValue(element, abstractLoopPushElement(push, updates))
      if (!push.conditional) {
        const update = loopPush.topName == null ? undefined : updates.get(loopPush.topName)
        summary = mergeArraySummary(summary, sequenceSummaryFromLoopPush(loopPush, update, {
          assumptions: [],
          resolveNumber: expr => resolveNumberFromEnv(expr, frame),
        }))
      }
    }
    writePath({root: arrayName, segments: []}, {
      ...target,
      element,
      summary,
    }, frame)
  }
  return null
}

function abstractLoopPushShape(push: InterpreterLoopContext['pushes'][number], updates: Map<string, LoopScalarUpdate>): LoopPush {
  const cursorPaths = push.cursorPaths.filter(cursorPath => updates.has(cursorPath.targetName))
  const topPath = cursorPaths[0]?.path ?? null
  return {
    arrayName: push.arrayName,
    length: push.length,
    element: push.element,
    topName: cursorPaths[0]?.targetName ?? null,
    topPath,
    height: topPath == null ? null : heightValueForTopPath(push.element, topPath),
    cursorPaths,
  }
}

function abstractLoopPushElement(push: InterpreterLoopContext['pushes'][number], updates: Map<string, LoopScalarUpdate>): Value | null {
  let element = push.element
  for (const cursorPath of push.cursorPaths) {
    const update = updates.get(cursorPath.targetName)
    if (update == null || element == null) continue
    const expr = loopElementPathExpression(push.arrayName, cursorPath.path)
    element = setLoopElementPathValue(element, cursorPath.path, loopCursorElementValue(update, expr))
  }
  return element
}

function setLoopElementPathValue(value: Value, path: string[], replacement: Value): Value {
  const [head, ...tail] = path
  if (head == null) return replacement
  if (head === '[]' && value.kind === 'array') {
    return {
      ...value,
      elements: value.elements == null ? null : value.elements.map(element => setLoopElementPathValue(element, tail, replacement)),
      element: value.element == null ? replacement : setLoopElementPathValue(value.element, tail, replacement),
    }
  }
  if (value.kind !== 'object') return value
  const props = new Map(value.props)
  props.set(head, setLoopElementPathValue(props.get(head) ?? unknownObject(head), tail, replacement))
  return {...value, props}
}

function loopElementPathExpression(arrayName: string, path: string[]): string {
  let expr = `${arrayName}[]`
  for (const part of path) expr += part === '[]' ? '[]' : `.${part}`
  return expr
}

function heightValueForTopPath(value: Value | null, topPath: string[]): NumberValue | null {
  if (topPath.at(-1) !== 'top') return null
  const heightPath = [...topPath.slice(0, -1), 'height']
  const height = valueAtObjectPath(value, heightPath)
  return height?.kind === 'number' ? height : null
}

function valueAtObjectPath(value: Value | null, path: string[]): Value | null {
  if (value == null) return null
  const [head, ...tail] = path
  if (head == null) return value
  if (value.kind !== 'object') return null
  return valueAtObjectPath(value.props.get(head) ?? null, tail)
}

function loopCursorElementValue(update: LoopScalarUpdate, expr: string): NumberValue {
  if (update.increment.min < 0) return unknownNumber(expr)
  return numberValue(
    update.start.min,
    update.end.max,
    update.start.isInteger && update.increment.isInteger,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}

function resolveNumberFromEnv(expr: string, frame: InterpreterFrame): NumberValue | null {
  const value = frame.env.get(expr)
  return value?.kind === 'number' ? value : null
}

function expressionCursorPaths(expression: ts.Expression | undefined, path: string[] = []): {path: string[]; targetName: string}[] {
  if (expression == null) return []
  const unwrapped = unwrapExpression(expression)
  if (ts.isIdentifier(unwrapped)) return [{path, targetName: unwrapped.text}]
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const paths: {path: string[]; targetName: string}[] = []
    for (const property of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        paths.push({path: [...path, property.name.text], targetName: property.name.text})
        continue
      }
      if (!ts.isPropertyAssignment(property)) continue
      const name = propertyNameText(property.name)
      if (name == null) continue
      paths.push(...expressionCursorPaths(property.initializer, [...path, name]))
    }
    return paths
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap(element => ts.isSpreadElement(element)
      ? expressionCursorPaths(element.expression, [...path, '[]'])
      : expressionCursorPaths(element, [...path, '[]']))
  }
  return []
}

function forOfItemName(initializer: ts.ForInitializer): string | null {
  if (!ts.isVariableDeclarationList(initializer)) return null
  const declaration = initializer.declarations[0]
  return declaration != null && ts.isIdentifier(declaration.name) ? declaration.name.text : null
}

function forOfScopedNames(initializer: ts.ForInitializer): string[] {
  if (!ts.isVariableDeclarationList(initializer)) return []
  return initializer.declarations.flatMap(declaration => bindingNames(declaration.name))
}

function forOfBodyScopedNames(statement: ts.Statement): string[] {
  return ts.isBlock(statement) ? blockScopedNames(statement) : []
}

function saveScopedValues(env: Map<string, Value>, names: string[]): Map<string, Value | null> {
  const values = new Map<string, Value | null>()
  for (const name of names) values.set(name, env.get(name) ?? null)
  return values
}

function restoreScopedValues(env: Map<string, Value>, values: Map<string, Value | null>) {
  for (const [name, value] of values) {
    if (value == null) env.delete(name)
    else env.set(name, value)
  }
}

function blockScopedNames(block: ts.Block): string[] {
  return block.statements.flatMap(statement => {
    if (!ts.isVariableStatement(statement)) return []
    return statement.declarationList.declarations.flatMap(declaration => bindingNames(declaration.name))
  })
}

function bindForOfInitializer(initializer: ts.ForInitializer, value: Value, frame: InterpreterFrame) {
  if (ts.isVariableDeclarationList(initializer)) {
    const declaration = initializer.declarations[0]
    if (declaration == null || initializer.declarations.length !== 1) {
      noteUnsupported(frame, 'for..of supports one loop binding')
      return
    }
    bindPattern(declaration.name, value, frame)
    return
  }
  const path = pathFromExpression(initializer, frame)
  if (path == null) {
    noteUnsupported(frame, `Unsupported for..of assignment target ${initializer.getText(frame.program.sourceFile)}`)
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
  if (numeric != null) return numberValue(numeric, numeric, Number.isInteger(numeric), expression.getText(frame.program.sourceFile), linearConstant(numeric))
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return literalValue([expression.text], expression.getText(frame.program.sourceFile))
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return literalValue([true], 'true')
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return literalValue([false], 'false')
  if (expression.kind === ts.SyntaxKind.NullKeyword) return nullValue('null')
  if (ts.isIdentifier(expression)) return readIdentifier(expression, frame)
  if (ts.isPropertyAccessExpression(expression)) return evaluatePropertyAccess(expression, frame)
  if (ts.isElementAccessExpression(expression)) return evaluateElementAccess(expression, frame)
  if (ts.isObjectLiteralExpression(expression)) return evaluateObjectLiteral(expression, frame)
  if (ts.isArrayLiteralExpression(expression)) return evaluateArrayLiteral(expression, frame)
  if (ts.isPrefixUnaryExpression(expression)) return evaluatePrefixUnary(expression, frame)
  if (ts.isBinaryExpression(expression)) return evaluateBinaryExpression(expression, frame)
  if (ts.isConditionalExpression(expression)) return evaluateConditionalExpression(expression, frame)
  if (ts.isCallExpression(expression)) return evaluateCallExpression(expression, frame)
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return noteUnsupported(frame, 'Function value cannot be materialized yet')
  return noteUnsupported(frame, `Unsupported expression ${expression.getText(frame.program.sourceFile)}`)
}

function readIdentifier(expression: ts.Identifier, frame: InterpreterFrame): Value {
  if (expression.text === 'undefined') return unknown('undefined value is outside the current interpreter surface')
  return frame.env.get(expression.text) ?? noteUnsupported(frame, `Unknown identifier ${expression.text}`)
}

function evaluatePropertyAccess(expression: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const target = evaluateExpression(expression.expression, frame)
  return readPropertyValue(target, expression.name.text, expression.getText(frame.program.sourceFile))
}

function readPropertyValue(target: Value, name: string, expr: string): Value {
  if (target.kind === 'object') return target.props.get(name) ?? unknownNumber(expr)
  if (target.kind === 'array' && name === 'length') return target.length
  if (target.kind === 'nullable') return readPropertyValue(target.present, name, expr)
  return unknown(`${expr} expected an object`)
}

function evaluateElementAccess(expression: ts.ElementAccessExpression, frame: InterpreterFrame): Value {
  const target = evaluateExpression(expression.expression, frame)
  if (expression.argumentExpression == null) return noteUnsupported(frame, 'Element access without an index is unsupported')
  const index = evaluateExpression(expression.argumentExpression, frame)
  const exactIndex = exactInteger(index)
  if (exactIndex == null) return target.kind === 'array' && target.element != null ? target.element : unknownNumber(expression.getText(frame.program.sourceFile))
  return readArrayIndexValue(target, exactIndex, expression.getText(frame.program.sourceFile))
}

function readArrayIndexValue(target: Value, index: number, expr: string): Value {
  if (target.kind === 'array') return target.elements?.[index] ?? target.element ?? unknownNumber(expr)
  if (target.kind === 'nullable') return readArrayIndexValue(target.present, index, expr)
  return unknown(`${expr} expected an array`)
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
      noteUnsupported(frame, `Object spread expected an object: ${property.getText(frame.program.sourceFile)}`)
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      props.set(property.name.text, readIdentifier(property.name, frame))
      continue
    }
    if (!ts.isPropertyAssignment(property)) {
      noteUnsupported(frame, `Unsupported object property ${property.getText(frame.program.sourceFile)}`)
      continue
    }
    const name = propertyNameText(property.name)
    if (name == null) {
      noteUnsupported(frame, `Unsupported object property name ${property.name.getText(frame.program.sourceFile)}`)
      continue
    }
    props.set(name, evaluateExpression(property.initializer, frame))
  }
  return {kind: 'object', props, expr: expression.getText(frame.program.sourceFile)}
}

function evaluateArrayLiteral(expression: ts.ArrayLiteralExpression, frame: InterpreterFrame): Value {
  const elements: Value[] = []
  let element: Value | null = null
  for (const item of expression.elements) {
    if (ts.isSpreadElement(item)) {
      const spread = evaluateExpression(item.expression, frame)
      if (spread.kind === 'array') {
        for (const spreadItem of spread.elements ?? []) {
          elements.push(spreadItem)
          element = mergeElementValue(element, spreadItem)
        }
        if (spread.element != null) element = mergeElementValue(element, spread.element)
        continue
      }
      noteUnsupported(frame, `Array spread expected an array: ${item.getText(frame.program.sourceFile)}`)
      continue
    }
    const value = evaluateExpression(item, frame)
    elements.push(value)
    element = mergeElementValue(element, value)
  }
  return {
    kind: 'array',
    length: numberValue(elements.length, elements.length, true, `${expression.getText(frame.program.sourceFile)}.length`, linearConstant(elements.length)),
    elements,
    element,
    expr: expression.getText(frame.program.sourceFile),
    summary: null,
  }
}

function evaluatePrefixUnary(expression: ts.PrefixUnaryExpression, frame: InterpreterFrame): Value {
  const value = evaluateExpression(expression.operand, frame)
  if (value.kind !== 'number') return noteUnsupported(frame, `Unary ${expression.getText(frame.program.sourceFile)} expected a number`)
  if (expression.operator === ts.SyntaxKind.PlusToken) return value
  if (expression.operator === ts.SyntaxKind.MinusToken) {
    return numberValue(-value.max, -value.min, value.isInteger, `-${value.expr ?? expression.operand.getText(frame.program.sourceFile)}`)
  }
  return noteUnsupported(frame, `Unsupported unary expression ${expression.getText(frame.program.sourceFile)}`)
}

function evaluateBinaryExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  if (isAssignmentOperator(expression.operatorToken.kind)) return evaluateAssignmentExpression(expression, frame)
  if (isComparisonOperator(expression.operatorToken.kind)) return evaluateComparisonExpression(expression, frame)
  const left = evaluateExpression(expression.left, frame)
  const right = evaluateExpression(expression.right, frame)
  if (left.kind !== 'number' || right.kind !== 'number') {
    return noteUnsupported(frame, `Binary expression ${expression.getText(frame.program.sourceFile)} expected numbers`)
  }
  return evaluateNumberBinary(expression.operatorToken.kind, left, right, frame, expression)
}

function evaluateNumberBinary(
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
      return noteUnsupported(frame, `Unsupported numeric operator ${expression.getText(frame.program.sourceFile)}`)
  }
}

function evaluateAssignmentExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const path = pathFromExpression(expression.left, frame)
  if (path == null) return noteUnsupported(frame, `Unsupported assignment target ${expression.left.getText(frame.program.sourceFile)}`)
  const right = evaluateExpression(expression.right, frame)
  const value = expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
    ? evaluateCompoundPlus(path, right, frame, expression)
    : right
  writePath(path, value, frame)
  return value
}

function evaluateCompoundPlus(path: ValuePath, right: Value, frame: InterpreterFrame, expression: ts.Expression): Value {
  const left = readPath(path, frame)
  if (left.kind !== 'number' || right.kind !== 'number') {
    return noteUnsupported(frame, `Compound assignment ${expression.getText(frame.program.sourceFile)} expected numbers`)
  }
  return addNumbers(left, right)
}

function evaluateComparisonExpression(expression: ts.BinaryExpression, frame: InterpreterFrame): Value {
  const left = evaluateExpression(expression.left, frame)
  const right = evaluateExpression(expression.right, frame)
  if (left.kind === 'number' && right.kind === 'number' && left.min === left.max && right.min === right.max) {
    return literalValue([compareNumbers(left.min, expression.operatorToken.kind, right.min)], expression.getText(frame.program.sourceFile))
  }
  return literalValue([true, false], expression.getText(frame.program.sourceFile))
}

function evaluateConditionalExpression(expression: ts.ConditionalExpression, frame: InterpreterFrame): Value {
  const truth = literalBoolean(evaluateExpression(expression.condition, frame))
  if (truth === true) return evaluateExpression(expression.whenTrue, frame)
  if (truth === false) return evaluateExpression(expression.whenFalse, frame)
  const trueFrame = branchFrame(frame, expression.condition, true, '<conditional-true>')
  const falseFrame = branchFrame(frame, expression.condition, false, '<conditional-false>')
  return joinValues(evaluateExpression(expression.whenTrue, trueFrame), evaluateExpression(expression.whenFalse, falseFrame))
}

function branchFrame(frame: InterpreterFrame, condition: ts.Expression, truth: boolean, name: string): InterpreterFrame {
  const branch = childFrame(frame, new Map(frame.env), name)
  refineCondition(branch, condition, truth)
  return branch
}

function refineCondition(frame: InterpreterFrame, condition: ts.Expression, truth: boolean) {
  const current = unwrapExpression(condition)
  if (ts.isBinaryExpression(current)) {
    refineBinaryCondition(frame, current, truth)
    return
  }
  refineLiteralTruthiness(frame, current, truth)
}

function refineBinaryCondition(frame: InterpreterFrame, expression: ts.BinaryExpression, truth: boolean) {
  const comparison = comparisonForSyntax(expression.operatorToken.kind, truth)
  if (comparison != null) {
    if (refineNumberPath(frame, expression.left, comparison, expression.right)) return
    refineNumberPath(frame, expression.right, flipComparison(comparison), expression.left)
  }
  const equalityTruth = equalityTruthForSyntax(expression.operatorToken.kind, truth)
  if (equalityTruth != null) {
    if (refineLiteralEquality(frame, expression.left, expression.right, equalityTruth)) return
    refineLiteralEquality(frame, expression.right, expression.left, equalityTruth)
  }
}

function refineNumberPath(frame: InterpreterFrame, targetExpression: ts.Expression, op: ComparisonOperator, otherExpression: ts.Expression): boolean {
  const path = pathFromExpression(targetExpression, frame)
  if (path == null) return false
  const current = readPath(path, frame)
  if (current.kind !== 'number') return false
  const other = evaluateExpression(otherExpression, frame)
  if (other.kind !== 'number' || other.min !== other.max) return false
  const next = narrowNumber(current, op, other.min)
  if (next === current) return false
  writePath(path, next, frame)
  return true
}

function narrowNumber(value: NumberValue, op: ComparisonOperator, other: number): NumberValue {
  switch (op) {
    case '==':
      return numberValue(other, other, Number.isInteger(other), value.expr, value.linear, null, value.provenance)
    case '>=':
      return numberValue(Math.max(value.min, other), value.max, value.isInteger, value.expr, value.linear, value.cases, value.provenance)
    case '>':
      return numberValue(Math.max(value.min, value.isInteger ? Math.floor(other) + 1 : other), value.max, value.isInteger, value.expr, value.linear, value.cases, value.provenance)
    case '<=':
      return numberValue(value.min, Math.min(value.max, other), value.isInteger, value.expr, value.linear, value.cases, value.provenance)
    case '<':
      return numberValue(value.min, Math.min(value.max, value.isInteger ? Math.ceil(other) - 1 : other), value.isInteger, value.expr, value.linear, value.cases, value.provenance)
  }
}

function refineLiteralTruthiness(frame: InterpreterFrame, expression: ts.Expression, truth: boolean) {
  const path = pathFromExpression(expression, frame)
  if (path == null) return
  const current = readPath(path, frame)
  if (current.kind !== 'literal') return
  writeLiteralFilter(frame, path, current, value => Boolean(value) === truth)
}

function refineLiteralEquality(frame: InterpreterFrame, targetExpression: ts.Expression, otherExpression: ts.Expression, equal: boolean): boolean {
  const path = pathFromExpression(targetExpression, frame)
  if (path == null) return false
  const current = readPath(path, frame)
  if (current.kind !== 'literal') return false
  const other = evaluateExpression(otherExpression, frame)
  if (other.kind !== 'literal') return false
  const keys = new Set(other.values.map(value => `${typeof value}:${String(value)}`))
  writeLiteralFilter(frame, path, current, value => keys.has(`${typeof value}:${String(value)}`) === equal)
  return true
}

function writeLiteralFilter(frame: InterpreterFrame, path: ValuePath, current: Extract<Value, {kind: 'literal'}>, keep: (value: string | boolean) => boolean) {
  const values = current.values.filter(keep)
  if (values.length === 0 || values.length === current.values.length) return
  const next = literalValue(values, current.expr, current.provenance)
  if (next.kind !== 'literal') return
  writePath(path, next, frame)
}

function evaluateCallExpression(expression: ts.CallExpression, frame: InterpreterFrame): Value {
  const target = unwrapExpression(expression.expression)
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'Math') {
    return evaluateMathCall(target.name.text, expression.arguments, frame, expression)
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'push') return evaluatePushCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'map') return evaluateMapCall(expression, target, frame)
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'filter') return evaluateFilterCall(expression, target, frame)
  if (isInlineFunction(target)) return invokeInlineFunction('<iife>', target, evaluatedArguments(expression.arguments, frame), frame)
  if (ts.isIdentifier(target)) {
    const local = frame.program.functions.get(target.text)
    if (local != null) return invokeFitFunction(local, evaluatedArguments(expression.arguments, frame), frame, frame.program, rootFrame(frame.program).env)
    const imported = importedFunction(target.text, frame.program)
    if (imported != null) return invokeFitFunction(imported.fn, evaluatedArguments(expression.arguments, frame), frame, imported.program, rootFrame(imported.program).env)
  }
  return noteUnsupported(frame, `Unsupported call ${expression.getText(frame.program.sourceFile)}`)
}

function evaluateMathCall(name: string, args: ts.NodeArray<ts.Expression>, frame: InterpreterFrame, expression: ts.CallExpression): Value {
  const values = args.map(arg => evaluateExpression(arg, frame))
  if (values.some(value => value.kind !== 'number')) return noteUnsupported(frame, `Math.${name} expected number arguments`)
  const numbers = values as NumberValue[]
  switch (name) {
    case 'min':
      return evaluateMathMinMax('min', numbers, frame, expression)
    case 'max':
      return evaluateMathMinMax('max', numbers, frame, expression)
    case 'floor':
      return evaluateUnaryMath(name, numbers, frame, value => value.isInteger ? value : numberValue(Math.floor(value.min), Math.floor(value.max), true, `floor(${value.expr ?? 'value'})`))
    case 'ceil':
      return evaluateUnaryMath(name, numbers, frame, value => value.isInteger ? value : numberValue(Math.ceil(value.min), Math.ceil(value.max), true, `ceil(${value.expr ?? 'value'})`))
    case 'round':
      return evaluateUnaryMath(name, numbers, frame, value => value.isInteger ? value : numberValue(Math.round(value.min), Math.round(value.max), true, `round(${value.expr ?? 'value'})`))
    case 'trunc':
      return evaluateUnaryMath(name, numbers, frame, value => value.isInteger ? value : numberValue(Math.trunc(value.min), Math.trunc(value.max), true, `trunc(${value.expr ?? 'value'})`))
    case 'sqrt':
      return evaluateUnaryMath(name, numbers, frame, value => value.min < 0 ? unknown('Math.sqrt expected a non-negative number') : numberValue(Math.sqrt(value.min), Math.sqrt(value.max), false, `sqrt(${value.expr ?? 'value'})`))
    case 'abs':
      return evaluateUnaryMath(name, numbers, frame, absNumber)
    case 'sign':
      return evaluateUnaryMath(name, numbers, frame, signNumber)
    default:
      return noteUnsupported(frame, `Unsupported Math.${name} call ${expression.getText(frame.program.sourceFile)}`)
  }
}

function evaluateMathMinMax(kind: 'min' | 'max', values: NumberValue[], frame: InterpreterFrame, _expression: ts.CallExpression): Value {
  if (values.length === 0) return noteUnsupported(frame, `Math.${kind} expected at least one argument`)
  return values.slice(1).reduce((current, value) => {
    return kind === 'min'
      ? numberValue(Math.min(current.min, value.min), Math.min(current.max, value.max), current.isInteger && value.isInteger, `min(${current.expr ?? 'left'}, ${value.expr ?? 'right'})`)
      : numberValue(Math.max(current.min, value.min), Math.max(current.max, value.max), current.isInteger && value.isInteger, `max(${current.expr ?? 'left'}, ${value.expr ?? 'right'})`)
  }, values[0]!)
}

function evaluateUnaryMath(name: string, values: NumberValue[], frame: InterpreterFrame, evaluate: (value: NumberValue) => Value): Value {
  if (values.length !== 1) return noteUnsupported(frame, `Math.${name} expected one argument`)
  return evaluate(values[0]!)
}

function absNumber(value: NumberValue): NumberValue {
  const max = Math.max(Math.abs(value.min), Math.abs(value.max))
  if (value.min >= 0) return value
  if (value.max <= 0) return numberValue(-value.max, -value.min, value.isInteger, `abs(${value.expr ?? 'value'})`)
  return numberValue(0, max, value.isInteger, `abs(${value.expr ?? 'value'})`)
}

function signNumber(value: NumberValue): NumberValue {
  if (value.min === 0 && value.max === 0) return numberValue(0, 0, true, `sign(${value.expr ?? 'value'})`)
  if (value.min > 0) return numberValue(1, 1, true, `sign(${value.expr ?? 'value'})`)
  if (value.max < 0) return numberValue(-1, -1, true, `sign(${value.expr ?? 'value'})`)
  if (value.min >= 0) return numberValue(0, 1, true, `sign(${value.expr ?? 'value'})`)
  if (value.max <= 0) return numberValue(-1, 0, true, `sign(${value.expr ?? 'value'})`)
  return numberValue(-1, 1, true, `sign(${value.expr ?? 'value'})`)
}

function evaluatePushCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const path = pathFromExpression(target.expression, frame)
  if (path == null) return noteUnsupported(frame, `Unsupported push target ${target.expression.getText(frame.program.sourceFile)}`)
  const current = readPath(path, frame)
  if (current.kind !== 'array') return noteUnsupported(frame, `push expected an array: ${target.expression.getText(frame.program.sourceFile)}`)
  const loop = currentLoop(frame)
  if (loop?.abstract === true && expression.arguments.length !== 1) return noteUnsupported(frame, 'Abstract loop push supports one item per iteration')
  const values = evaluatedArguments(expression.arguments, frame)
  const elements = current.elements == null ? [] : [...current.elements]
  elements.push(...values)
  let element: Value | null = current.element
  for (const value of values) element = mergeElementValue(element, value)
  const abstractLength = loop?.abstract === true ? abstractLoopPushLength(current, loop) : null
  const nextLength = current.elements == null
    ? numberValue(current.length.min + values.length, current.length.max + values.length, true, `${current.expr ?? target.expression.getText(frame.program.sourceFile)}.length`)
    : numberValue(elements.length, elements.length, true, `${current.expr ?? target.expression.getText(frame.program.sourceFile)}.length`, linearConstant(elements.length))
  if (loop?.abstract === true && path.segments.length === 0) {
    loop.pushes.push({
      arrayName: path.root,
      order: loop.statementIndex,
      conditional: frame.conditionalDepth > 0,
      length: abstractLength ?? nextLength,
      element: values[0] ?? null,
      base: current,
      cursorPaths: expressionCursorPaths(expression.arguments[0]),
    })
  }
  const next: ArrayValue = {
    ...current,
    length: abstractLength ?? nextLength,
    elements: loop?.abstract === true ? null : elements,
    element,
    summary: mergeArraySummary(current.summary, currentLoopPushSummary(frame)),
  }
  writePath(path, next, frame)
  return next.length
}

function isPushCallExpression(expression: ts.Expression): expression is ts.CallExpression & {expression: ts.PropertyAccessExpression} {
  return ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'push'
}

function abstractLoopPushLength(current: ArrayValue, loop: InterpreterLoopContext): NumberValue {
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
  if (source.kind !== 'array') return noteUnsupported(frame, `map expected an array: ${target.expression.getText(frame.program.sourceFile)}`)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, 'map callback must be an inline function')
  const sourceExpr = sourceExpression(source, target.expression, frame)
  const mapped: Value[] = []
  let finiteElement: Value | null = null
  if (source.elements != null) {
    for (let index = 0; index < source.elements.length; index++) {
      const item = source.elements[index]!
      const result = invokeInlineFunction(
        '<map>',
        callbackFn,
        [
          item,
          numberValue(index, index, true, `${index}`, linearConstant(index)),
          source,
        ],
        frame,
      )
      mapped.push(result)
      finiteElement = mergeElementValue(finiteElement, result)
    }
  }
  const abstractElement = evaluateMapElement(source, sourceExpr, callbackFn, frame)
  return {
    kind: 'array',
    length: source.length,
    elements: source.elements == null ? null : mapped,
    element: abstractElement ?? finiteElement,
    expr: expression.getText(frame.program.sourceFile),
    summary: emptyArraySummary(mapOrigin(source, sourceExpr)),
  }
}

function evaluateMapElement(source: ArrayValue, sourceExpr: string, callbackFn: ArrayCallbackFunction, frame: InterpreterFrame): Value | null {
  const item = source.element ?? unknownObject(`${sourceExpr}[]`)
  return invokeInlineFunction(
    '<map-element>',
    callbackFn,
    [
      item,
      indexedElementPathValue(`mapIndex(${sourceExpr})`, source.length),
      source,
    ],
    frame,
  )
}

function evaluateFilterCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const source = evaluateExpression(target.expression, frame)
  if (source.kind !== 'array') return noteUnsupported(frame, `filter expected an array: ${target.expression.getText(frame.program.sourceFile)}`)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, 'filter callback must be an inline function')
  const sourceExpr = sourceExpression(source, target.expression, frame)
  const summary = emptyArraySummary(filterOrigin(source, sourceExpr))
  if (source.elements == null) {
    return {
      kind: 'array',
      length: numberValue(0, source.length.max, true, `${expression.getText(frame.program.sourceFile)}.length`),
      elements: null,
      element: source.element,
      expr: expression.getText(frame.program.sourceFile),
      summary,
    }
  }

  const elements: Value[] = []
  let element: Value | null = null
  let sawUnknownPredicate = false
  for (let index = 0; index < source.elements.length; index++) {
    const item = source.elements[index]!
    const keep = invokeInlineFunction(
      '<filter>',
      callbackFn,
      [
        item,
        numberValue(index, index, true, `${index}`, linearConstant(index)),
        source,
      ],
      frame,
    )
    const truth = literalBoolean(keep)
    if (truth === false) continue
    if (truth == null) {
      sawUnknownPredicate = true
      element = mergeElementValue(element, item)
      continue
    }
    elements.push(item)
    element = mergeElementValue(element, item)
  }
  return {
    kind: 'array',
    length: numberValue(elements.length, sawUnknownPredicate ? source.elements.length : elements.length, true, `${expression.getText(frame.program.sourceFile)}.length`, sawUnknownPredicate ? null : linearConstant(elements.length)),
    elements: sawUnknownPredicate ? null : elements,
    element,
    expr: expression.getText(frame.program.sourceFile),
    summary,
  }
}

function sourceExpression(source: ArrayValue, expression: ts.Expression, frame: InterpreterFrame): string {
  return source.expr ?? expression.getText(frame.program.sourceFile)
}

function evaluatedArguments(args: ts.NodeArray<ts.Expression>, frame: InterpreterFrame): Value[] {
  return args.map(arg => evaluateExpression(arg, frame))
}

function importedFunction(name: string, program: Program): {program: Program; fn: FitFunction} | null {
  const binding = program.imports.get(name)
  if (binding?.kind !== 'resolved') return null
  const resolved = resolveFitExport(binding.module, binding.exportedName)
  if (resolved.kind === 'unresolved') return null
  const fn = resolved.module.functions.get(resolved.localName)
  return fn == null ? null : {program: resolved.module, fn}
}

function pathFromExpression(expression: ts.Expression, frame: InterpreterFrame): ValuePath | null {
  const unwrapped = unwrapExpression(expression)
  if (ts.isIdentifier(unwrapped)) return {root: unwrapped.text, segments: []}
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const parent = pathFromExpression(unwrapped.expression, frame)
    return parent == null ? null : {...parent, segments: [...parent.segments, {kind: 'prop', name: unwrapped.name.text}]}
  }
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression != null) {
    const parent = pathFromExpression(unwrapped.expression, frame)
    const index = exactInteger(evaluateExpression(unwrapped.argumentExpression, frame))
    return parent == null || index == null ? null : {...parent, segments: [...parent.segments, {kind: 'index', index}]}
  }
  const root = expressionRootName(unwrapped)
  return root == null ? null : {root, segments: []}
}

function valuePathExpression(path: ValuePath): string {
  let expr = path.root
  for (const segment of path.segments) {
    expr += segment.kind === 'prop' ? `.${segment.name}` : `[${segment.index}]`
  }
  return expr
}

function readPath(path: ValuePath, frame: InterpreterFrame): Value {
  const root = frame.env.get(path.root)
  if (root == null) return noteUnsupported(frame, `Unknown assignment root ${path.root}`)
  return readPathSegments(root, path.segments)
}

function readPathSegments(value: Value, segments: PathSegment[]): Value {
  const segment = segments[0]
  if (segment == null) return value
  if (segment.kind === 'prop') return readPathSegments(readPropertyValue(value, segment.name, `${valueExpr(value) ?? 'value'}.${segment.name}`), segments.slice(1))
  return readPathSegments(readArrayIndexValue(value, segment.index, `${valueExpr(value) ?? 'value'}[${segment.index}]`), segments.slice(1))
}

function writePath(path: ValuePath, value: Value, frame: InterpreterFrame) {
  const current = frame.env.get(path.root) ?? unknownObject(path.root)
  if (path.segments.length === 0) {
    frame.env.set(path.root, value)
    return
  }
  const containerPath = path.segments.slice(0, -1)
  const oldContainer = readPathSegments(current, containerPath)
  const updated = setPathSegments(current, path.segments, value)
  const newContainer = readPathSegments(updated, containerPath)
  if (oldContainer.kind === 'object' || oldContainer.kind === 'array') {
    for (const [name, envValue] of frame.env) {
      frame.env.set(name, replaceSharedValue(envValue, oldContainer, newContainer))
    }
  }
  frame.env.set(path.root, updated)
}

function setPathSegments(current: Value, segments: PathSegment[], value: Value): Value {
  const segment = segments[0]
  if (segment == null) return value
  if (segment.kind === 'prop') {
    if (current.kind === 'array' && segment.name === 'length' && value.kind === 'number') return {...current, length: value}
    const base = current.kind === 'object' ? current : unknownObject(valueExpr(current) ?? 'object')
    const props = new Map(base.props)
    props.set(segment.name, setPathSegments(props.get(segment.name) ?? unknownObject(segment.name), segments.slice(1), value))
    return {...base, props}
  }
  const base = current.kind === 'array' ? current : unknownArray(valueExpr(current) ?? 'array')
  const elements = base.elements == null ? [] : [...base.elements]
  while (elements.length <= segment.index) elements.push(unknownNumber(`${base.expr ?? 'array'}[${elements.length}]`))
  elements[segment.index] = setPathSegments(elements[segment.index]!, segments.slice(1), value)
  let element: Value | null = null
  for (const item of elements) element = mergeElementValue(element, item)
  return {
    ...base,
    elements,
    element,
    length: numberValue(elements.length, elements.length, true, `${base.expr ?? 'array'}.length`, linearConstant(elements.length)),
  }
}

function replaceSharedValue(value: Value, from: Value, to: Value): Value {
  if (value === from) return to
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    let changed = false
    for (const [name, prop] of value.props) {
      const next = replaceSharedValue(prop, from, to)
      if (next !== prop) changed = true
      props.set(name, next)
    }
    return changed ? {...value, props} : value
  }
  if (value.kind === 'array') {
    const elements = value.elements == null ? null : value.elements.map(element => replaceSharedValue(element, from, to))
    const element = value.element == null ? null : replaceSharedValue(value.element, from, to)
    const changed = element !== value.element
      || (elements != null && value.elements != null && elements.some((item, index) => item !== value.elements![index]))
    return changed ? {...value, elements, element} : value
  }
  if (value.kind === 'nullable') {
    const present = replaceSharedValue(value.present, from, to)
    return present === value.present ? value : {...value, present}
  }
  return value
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isNonNullExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) return unwrapExpression(expression.expression)
  return expression
}

function isInlineFunction(expression: ts.Expression): expression is ArrayCallbackFunction {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsToken || kind === ts.SyntaxKind.PlusEqualsToken
}

function isComparisonOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken
    || kind === ts.SyntaxKind.LessThanToken
    || kind === ts.SyntaxKind.LessThanEqualsToken
    || kind === ts.SyntaxKind.GreaterThanToken
    || kind === ts.SyntaxKind.GreaterThanEqualsToken
}

function comparisonForSyntax(kind: ts.SyntaxKind, truth: boolean): ComparisonOperator | null {
  const comparison = comparisonForSyntaxWhenTrue(kind)
  if (comparison == null) return null
  return truth ? comparison : negatedComparison(comparison)
}

function comparisonForSyntaxWhenTrue(kind: ts.SyntaxKind): ComparisonOperator | null {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return '=='
    case ts.SyntaxKind.LessThanToken:
      return '<'
    case ts.SyntaxKind.LessThanEqualsToken:
      return '<='
    case ts.SyntaxKind.GreaterThanToken:
      return '>'
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return '>='
    default:
      return null
  }
}

function negatedComparison(op: ComparisonOperator): ComparisonOperator | null {
  switch (op) {
    case '==':
      return null
    case '>=':
      return '<'
    case '>':
      return '<='
    case '<=':
      return '>'
    case '<':
      return '>='
  }
}

function flipComparison(op: ComparisonOperator): ComparisonOperator {
  switch (op) {
    case '==':
      return '=='
    case '>=':
      return '<='
    case '>':
      return '<'
    case '<=':
      return '>='
    case '<':
      return '>'
  }
}

function equalityTruthForSyntax(kind: ts.SyntaxKind, truth: boolean): boolean | null {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return truth
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return !truth
    default:
      return null
  }
}

function compareNumbers(left: number, kind: ts.SyntaxKind, right: number): boolean {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return left === right
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return left !== right
    case ts.SyntaxKind.LessThanToken:
      return left < right
    case ts.SyntaxKind.LessThanEqualsToken:
      return left <= right
    case ts.SyntaxKind.GreaterThanToken:
      return left > right
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return left >= right
    default:
      return false
  }
}

function literalBoolean(value: Value): boolean | null {
  return value.kind === 'literal' && value.values.length === 1 && typeof value.values[0] === 'boolean' ? value.values[0] : null
}

function exactInteger(value: Value): number | null {
  return value.kind === 'number' && value.min === value.max && value.isInteger ? value.min : null
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function valueExpr(value: Value): string | null {
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
