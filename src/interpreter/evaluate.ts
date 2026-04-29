import * as ts from 'typescript'
import type {
  ArrayCallbackFunction,
  Program,
} from '../check-types.ts'
import {
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from '../binding-patterns.ts'
import {
  addNumbers,
  divideNumbers,
  joinValues,
  literalValue,
  mergeElementValue,
  moduloNumbers,
  multiplyNumbers,
  nullValue,
  numberValue,
  powerNumbers,
  subtractNumbers,
  unknown,
  unknownArray,
  unknownNumber,
  unknownObject,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {
  linearConstant,
  numericLiteralValue,
} from '../linear.ts'
import {resolveFitExport, type FitFunction, type FitFunctionNode} from '../modules.ts'
import type {ComparisonOperator} from '../parser.ts'
import {expressionRootName} from '../source-expressions.ts'
import {
  childFrame,
  frameWithProgram,
  joinFrameEnvs,
  noteUnsupported,
  rootFrame,
  type InterpreterFlow,
  type InterpreterFrame,
  type InterpreterIssue,
} from './context.ts'

export type InterpreterFunctionResult = {
  value: Value
  issues: InterpreterIssue[]
}

export type InterpreterBodyResult = InterpreterFunctionResult & {
  env: Map<string, Value>
}

type PathSegment =
  | {kind: 'prop'; name: string}
  | {kind: 'index'; index: number}

type ValuePath = {
  root: string
  segments: PathSegment[]
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

export function evaluateInterpreterFunctionBody(program: Program, fn: FitFunction, env: Map<string, Value>, stack: string[] = [fn.name]): InterpreterBodyResult {
  const frame: InterpreterFrame = {
    program,
    env: new Map(env),
    issues: [],
    stack,
  }
  const value = evaluateFunctionNodeBody(fn.name, fn.node, frame)
  return {value, env: frame.env, issues: frame.issues}
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
    const value = argument ?? (param.initializer == null ? unknownParamPatternValue(param.name) : evaluateExpression(param.initializer, frame))
    bindPattern(param.name, value, frame)
  }
}

function unknownParamPatternValue(name: ts.BindingName): Value {
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
  if (ts.isBlock(statement)) return evaluateStatements(statement.statements, frame)
  if (ts.isIfStatement(statement)) return evaluateIfStatement(statement, frame)
  noteUnsupported(frame, `Unsupported statement ${statement.getText(frame.program.sourceFile)}`)
  return {kind: 'fallthrough'}
}

function evaluateVariableDeclaration(declaration: ts.VariableDeclaration, frame: InterpreterFrame) {
  const value = declaration.initializer == null
    ? unknown(`Uninitialized local ${declaration.name.getText(frame.program.sourceFile)}`)
    : evaluateExpression(declaration.initializer, frame)
  bindPattern(declaration.name, value, frame)
}

function evaluateIfStatement(statement: ts.IfStatement, frame: InterpreterFrame): InterpreterFlow {
  const truth = literalBoolean(evaluateExpression(statement.expression, frame))
  if (truth === true) return evaluateBranch(statement.thenStatement, frame)
  if (truth === false) return statement.elseStatement == null ? {kind: 'fallthrough'} : evaluateBranch(statement.elseStatement, frame)

  const thenFrame = branchFrame(frame, statement.expression, true, '<if-true>')
  const elseFrame = branchFrame(frame, statement.expression, false, '<if-false>')
  const thenFlow = evaluateBranch(statement.thenStatement, thenFrame)
  const elseFlow: InterpreterFlow = statement.elseStatement == null ? {kind: 'fallthrough'} : evaluateBranch(statement.elseStatement, elseFrame)
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

function evaluateMapCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const source = evaluateExpression(target.expression, frame)
  if (source.kind !== 'array') return noteUnsupported(frame, `map expected an array: ${target.expression.getText(frame.program.sourceFile)}`)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, 'map callback must be an inline function')
  const elements = source.elements ?? (source.element == null ? [] : [source.element])
  const mapped: Value[] = []
  let element: Value | null = null
  for (let index = 0; index < elements.length; index++) {
    const item = elements[index]!
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
    element = mergeElementValue(element, result)
  }
  return {
    kind: 'array',
    length: numberValue(mapped.length, mapped.length, true, `${expression.getText(frame.program.sourceFile)}.length`, linearConstant(mapped.length)),
    elements: mapped,
    element,
    expr: expression.getText(frame.program.sourceFile),
    summary: null,
  }
}

function evaluateFilterCall(expression: ts.CallExpression, target: ts.PropertyAccessExpression, frame: InterpreterFrame): Value {
  const source = evaluateExpression(target.expression, frame)
  if (source.kind !== 'array') return noteUnsupported(frame, `filter expected an array: ${target.expression.getText(frame.program.sourceFile)}`)
  const callback = expression.arguments[0]
  const callbackFn = callback == null ? null : unwrapExpression(callback)
  if (callbackFn == null || !isInlineFunction(callbackFn)) return noteUnsupported(frame, 'filter callback must be an inline function')
  if (source.elements == null) {
    return {
      kind: 'array',
      length: numberValue(0, source.length.max, true, `${expression.getText(frame.program.sourceFile)}.length`),
      elements: null,
      element: source.element,
      expr: expression.getText(frame.program.sourceFile),
      summary: source.summary == null ? null : {...source.summary, origin: {kind: 'subsequence', sourceExpr: source.expr ?? target.expression.getText(frame.program.sourceFile)}},
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
    summary: source.summary == null ? null : {...source.summary, origin: {kind: 'subsequence', sourceExpr: source.expr ?? target.expression.getText(frame.program.sourceFile)}},
  }
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
