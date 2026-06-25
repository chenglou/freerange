import * as ts from 'typescript'
import type {
  BlockID,
  BlockIR,
  ComparisonOperator,
  FunctionID,
  FunctionIR,
  InstructionIR,
  ProgramIR,
  SourceSpan,
  TerminatorIR,
  ValueID,
  ValueTypeIR,
} from './ir.ts'
import type {CheckedSource} from './typescript.ts'

type MutableBlock = {
  instructions: InstructionIR[]
  terminator: TerminatorIR | null
}

type FunctionContext = {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
  functionsBySymbol: Map<ts.Symbol, FunctionID>
  nextValue: number
  currentBlock: MutableBlock
  blocks: MutableBlock[]
  bindings: Map<ts.Symbol, ValueID>
  parameters: FunctionIR['parameters']
}

type WithoutResult<T> = T extends unknown ? Omit<T, 'result' | 'span'> : never
type InstructionInput = WithoutResult<InstructionIR>

export function lowerSource(checked: CheckedSource): ProgramIR {
  const {sourceFile, checker} = checked
  const declarations: ts.FunctionDeclaration[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) declarations.push(statement)
  }
  const functionsBySymbol = new Map<ts.Symbol, FunctionID>()
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index]!
    functionsBySymbol.set(requiredSymbol(declaration.name!, checker), index)
  }
  const functions: FunctionIR[] = []
  for (const declaration of declarations) {
    functions.push(lowerFunction(declaration, sourceFile, checker, functionsBySymbol))
  }
  return {file: sourceFile.fileName, functions}
}

function lowerFunction(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, FunctionID>,
): FunctionIR {
  if (declaration.body == null) throw unsupported(declaration, 'Function declarations need bodies')
  const entry: MutableBlock = {instructions: [], terminator: null}
  const context: FunctionContext = {
    sourceFile,
    checker,
    functionsBySymbol,
    nextValue: 0,
    currentBlock: entry,
    blocks: [entry],
    bindings: new Map(),
    parameters: [],
  }
  let objectParameterCount = 0
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) throw unsupported(parameter.name, 'Destructured parameters')
    const type = lowerParameterType(parameter, checker)
    if (type.kind === 'object' && ++objectParameterCount > 1) {
      throw unsupported(parameter, 'More than one object parameter')
    }
    const value = context.nextValue++
    context.bindings.set(requiredSymbol(parameter.name, checker), value)
    context.parameters.push({value, name: parameter.name.text, type, span: span(sourceFile, parameter)})
  }
  for (const statement of declaration.body.statements) {
    if (context.currentBlock.terminator != null) throw unsupported(statement, 'Statements after return')
    if (ts.isVariableStatement(statement)) {
      lowerVariableStatement(statement, context)
      continue
    }
    if (ts.isReturnStatement(statement) && statement.expression != null) {
      lowerReturnExpression(statement.expression, context)
      continue
    }
    if (ts.isExpressionStatement(statement)) {
      lowerExpression(statement.expression, context)
      continue
    }
    throw unsupported(statement, 'Statement')
  }
  if (context.currentBlock.terminator == null) {
    if (!functionReturnsVoid(declaration, checker)) throw unsupported(declaration, 'Function path without a return')
    terminate(context.currentBlock, {kind: 'return', value: null, span: span(sourceFile, declaration.body)})
  }
  const blocks: BlockIR[] = []
  for (const block of context.blocks) {
    if (block.terminator == null) throw unsupported(declaration, 'Function path without a return')
    blocks.push({instructions: block.instructions, terminator: block.terminator})
  }
  return {
    name: declaration.name!.text,
    parameters: context.parameters,
    entry: 0,
    blocks,
    span: span(sourceFile, declaration),
  }
}

function lowerVariableStatement(statement: ts.VariableStatement, context: FunctionContext): void {
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) {
      throw unsupported(declaration, 'Variables without identifier names and initializers')
    }
    const value = lowerExpression(declaration.initializer, context)
    context.bindings.set(requiredSymbol(declaration.name, context.checker), value)
  }
}

function lowerReturnExpression(expression: ts.Expression, context: FunctionContext): void {
  const current = unwrap(expression)
  if (ts.isConditionalExpression(current)) {
    const condition = lowerExpression(current.condition, context)
    const whenTrue = createBlock(context)
    const whenFalse = createBlock(context)
    terminate(context.currentBlock, {
      kind: 'branch',
      condition,
      whenTrue,
      whenFalse,
      span: span(context.sourceFile, current.condition),
    })
    context.currentBlock = context.blocks[whenTrue]!
    lowerReturnExpression(current.whenTrue, context)
    context.currentBlock = context.blocks[whenFalse]!
    lowerReturnExpression(current.whenFalse, context)
    return
  }
  const value = lowerExpression(current, context)
  terminate(context.currentBlock, {kind: 'return', value, span: span(context.sourceFile, current)})
}

function lowerExpression(expression: ts.Expression, context: FunctionContext): ValueID {
  const current = unwrap(expression)
  if (ts.isNumericLiteral(current)) {
    return addInstruction(context, {kind: 'constant', value: Number(current.text)}, current)
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    const zero = addInstruction(context, {kind: 'constant', value: 0}, current)
    const value = lowerExpression(current.operand, context)
    return addInstruction(context, {kind: 'binary', operator: 'subtract', left: zero, right: value}, current)
  }
  if (ts.isIdentifier(current)) {
    return requiredBinding(requiredSymbol(current, context.checker), current, context)
  }
  if (ts.isObjectLiteralExpression(current)) {
    const properties = current.properties.map(property => {
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = context.checker.getShorthandAssignmentValueSymbol(property)
        if (symbol == null) throw unsupported(property, 'Shorthand property without a value symbol')
        return {name: property.name.text, value: requiredBinding(symbol, property.name, context)}
      }
      if (ts.isPropertyAssignment(property)) {
        return {name: propertyName(property.name), value: lowerExpression(property.initializer, context)}
      }
      throw unsupported(property, 'Object property')
    })
    return addInstruction(context, {kind: 'object', properties}, current)
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(current.left)
  ) {
    const object = lowerExpression(current.left.expression, context)
    const value = lowerExpression(current.right, context)
    return addInstruction(context, {kind: 'store', object, property: current.left.name.text, value}, current)
  }
  if (ts.isBinaryExpression(current)) {
    const arithmetic = arithmeticOperator(current.operatorToken.kind)
    const comparison = comparisonOperator(current.operatorToken.kind)
    if (arithmetic == null && comparison == null) {
      throw unsupported(current, `Binary operator ${current.operatorToken.getText(context.sourceFile)}`)
    }
    requireNumberType(current.left, context.checker, 'Left operand')
    requireNumberType(current.right, context.checker, 'Right operand')
    const left = lowerExpression(current.left, context)
    const right = lowerExpression(current.right, context)
    return arithmetic != null
      ? addInstruction(context, {kind: 'binary', operator: arithmetic, left, right}, current)
      : addInstruction(context, {kind: 'compare', operator: comparison!, left, right}, current)
  }
  if (ts.isCallExpression(current)) {
    if (ts.isIdentifier(current.expression)) {
      const symbol = resolvedSymbol(context.checker.getSymbolAtLocation(current.expression), context.checker)
      const functionID = symbol == null ? undefined : context.functionsBySymbol.get(symbol)
      if (functionID == null) throw unsupported(current, `Function call ${current.expression.text}`)
      const arguments_ = current.arguments.map(argument => lowerExpression(argument, context))
      return addInstruction(context, {kind: 'call', function: functionID, arguments: arguments_}, current)
    }
    if (ts.isPropertyAccessExpression(current.expression)) {
      const method = current.expression.name.text
      const standardMath = isStandardMathObject(current.expression.expression, context.checker)
      if (standardMath && method === 'floor' && current.arguments.length === 1) {
        requireNumberType(current.arguments[0]!, context.checker, 'Math.floor argument')
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, {kind: 'floor', value}, current)
      }
      if (standardMath && (method === 'min' || method === 'max') && current.arguments.length > 0) {
        for (const argument of current.arguments) requireNumberType(argument, context.checker, `Math.${method} argument`)
        const values = current.arguments.map(argument => lowerExpression(argument, context))
        return addInstruction(context, {kind: method === 'min' ? 'minimum' : 'maximum', values}, current)
      }
      throw unsupported(current, `Function call ${current.expression.getText(context.sourceFile)}`)
    }
  }
  if (ts.isPropertyAccessExpression(current)) {
    const objectType = context.checker.getTypeAtLocation(current.expression)
    if ((objectType.flags & ts.TypeFlags.Object) === 0) {
      throw unsupported(current.expression, `Property read from ${context.checker.typeToString(objectType)}`)
    }
    const object = lowerExpression(current.expression, context)
    return addInstruction(context, {kind: 'property', object, property: current.name.text}, current)
  }
  throw unsupported(current, 'Expression')
}

function lowerParameterType(parameter: ts.ParameterDeclaration, checker: ts.TypeChecker): ValueTypeIR {
  const type = checker.getTypeAtLocation(parameter)
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return {kind: 'number'}
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    throw unsupported(parameter, `Function parameter with type ${checker.typeToString(type)}`)
  }
  const properties: string[] = []
  for (const property of checker.getPropertiesOfType(type)) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, parameter)
    if ((property.flags & ts.SymbolFlags.Optional) !== 0 || (propertyType.flags & ts.TypeFlags.NumberLike) === 0) {
      throw unsupported(parameter, `Object parameter property ${property.name} with type ${checker.typeToString(propertyType)}`)
    }
    properties.push(property.name)
  }
  if (properties.length === 0) throw unsupported(parameter, 'Object parameter without numeric properties')
  return {kind: 'object', properties}
}

function functionReturnsVoid(declaration: ts.FunctionDeclaration, checker: ts.TypeChecker): boolean {
  const signature = checker.getSignatureFromDeclaration(declaration)
  if (signature == null) throw unsupported(declaration, 'Function without a TypeScript signature')
  const flags = checker.getReturnTypeOfSignature(signature).flags
  return (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
}

function requireNumberType(node: ts.Node, checker: ts.TypeChecker, description: string): void {
  const type = checker.getTypeAtLocation(node)
  if ((type.flags & ts.TypeFlags.NumberLike) === 0) throw unsupported(node, `${description} with type ${checker.typeToString(type)}`)
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | null {
  if (symbol == null) return null
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
}

function requiredSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol {
  const symbol = checker.getSymbolAtLocation(node)
  if (symbol == null) throw unsupported(node, 'Node without a TypeScript symbol')
  return symbol
}

function requiredBinding(symbol: ts.Symbol, node: ts.Identifier, context: FunctionContext): ValueID {
  const value = context.bindings.get(symbol)
  if (value == null) throw unsupported(node, `Unknown identifier ${node.text}`)
  return value
}

function isStandardMathObject(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'Math') return false
  const symbol = checker.getSymbolAtLocation(expression)
  const declarations = symbol?.declarations
  if (declarations == null || declarations.length === 0) return false
  return declarations.every(declaration => declaration.getSourceFile().isDeclarationFile)
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  throw unsupported(name, 'Computed object property name')
}

function addInstruction(context: FunctionContext, instruction: InstructionInput, source: ts.Node): ValueID {
  const result = context.nextValue++
  context.currentBlock.instructions.push({...instruction, result, span: span(context.sourceFile, source)} as InstructionIR)
  return result
}

function createBlock(context: FunctionContext): BlockID {
  const block: MutableBlock = {instructions: [], terminator: null}
  context.blocks.push(block)
  return context.blocks.length - 1
}

function terminate(block: MutableBlock, terminator: TerminatorIR): void {
  if (block.terminator != null) throw new Error('IR block already has a terminator')
  block.terminator = terminator
}

function arithmeticOperator(kind: ts.SyntaxKind): Extract<InstructionIR, {kind: 'binary'}>['operator'] | null {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return 'add'
    case ts.SyntaxKind.MinusToken: return 'subtract'
    case ts.SyntaxKind.AsteriskToken: return 'multiply'
    case ts.SyntaxKind.SlashToken: return 'divide'
    default: return null
  }
}

function comparisonOperator(kind: ts.SyntaxKind): ComparisonOperator | null {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken: return 'lessThan'
    case ts.SyntaxKind.LessThanEqualsToken: return 'lessThanOrEqual'
    case ts.SyntaxKind.GreaterThanToken: return 'greaterThan'
    case ts.SyntaxKind.GreaterThanEqualsToken: return 'greaterThanOrEqual'
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return 'equal'
    default: return null
  }
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression
  return current
}

function span(sourceFile: ts.SourceFile, node: ts.Node): SourceSpan {
  const start = node.getStart(sourceFile)
  const position = sourceFile.getLineAndCharacterOfPosition(start)
  return {
    file: sourceFile.fileName,
    start,
    end: node.getEnd(),
    line: position.line + 1,
    column: position.character + 1,
  }
}

function unsupported(node: ts.Node, description: string): Error {
  const location = span(node.getSourceFile(), node)
  return new Error(`Unsupported ${description} at ${location.file}:${location.line}:${location.column}`)
}
