import * as ts from 'typescript'
import type {
  BlockID,
  BlockIR,
  ComparisonOperator,
  FunctionID,
  FunctionIR,
  InstructionIR,
  ProgramIR,
  TerminatorIR,
  ValueID,
  ValueTypeIR,
} from './ir.ts'
import type {CheckedSource} from './typescript.ts'

type MutableBlock = {
  loopHeader: boolean
  parameters: ValueID[]
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

type WithoutResult<T> = T extends unknown ? Omit<T, 'result'> : never
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
  const entry: MutableBlock = {loopHeader: false, parameters: [], instructions: [], terminator: null}
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
    context.parameters.push({value, name: parameter.name.text, type})
  }
  lowerStatements(declaration.body.statements, context)
  if (context.currentBlock.terminator == null) {
    if (!functionReturnsVoid(declaration, checker)) throw unsupported(declaration, 'Function path without a return')
    terminate(context.currentBlock, {kind: 'return', value: null})
  }
  const blocks: BlockIR[] = []
  for (const block of context.blocks) {
    if (block.terminator == null) throw unsupported(declaration, 'Function path without a return')
    blocks.push({
      loopHeader: block.loopHeader,
      parameters: block.parameters,
      instructions: block.instructions,
      terminator: block.terminator,
    })
  }
  return {
    name: declaration.name!.text,
    parameters: context.parameters,
    entry: 0,
    blocks,
  }
}

function lowerStatements(statements: readonly ts.Statement[], context: FunctionContext): void {
  for (const statement of statements) {
    if (context.currentBlock.terminator != null) throw unsupported(statement, 'Statements after return')
    lowerStatement(statement, context)
  }
}

function lowerStatement(statement: ts.Statement, context: FunctionContext): void {
  if (ts.isVariableStatement(statement)) {
    lowerVariableStatement(statement, context)
    return
  }
  if (ts.isReturnStatement(statement) && statement.expression != null) {
    lowerReturnExpression(statement.expression, context)
    return
  }
  if (ts.isExpressionStatement(statement)) {
    lowerExpression(statement.expression, context)
    return
  }
  if (ts.isIfStatement(statement)) {
    lowerIfStatement(statement, context)
    return
  }
  if (ts.isForStatement(statement)) {
    lowerForStatement(statement, context)
    return
  }
  if (ts.isBlock(statement)) {
    lowerStatements(statement.statements, context)
    return
  }
  throw unsupported(statement, 'Statement')
}

function lowerVariableStatement(statement: ts.VariableStatement, context: FunctionContext): void {
  lowerVariableDeclarationList(statement.declarationList, context)
}

function lowerReturnExpression(expression: ts.Expression, context: FunctionContext): void {
  const value = lowerExpression(expression, context)
  terminate(context.currentBlock, {kind: 'return', value})
}

function lowerIfStatement(statement: ts.IfStatement, context: FunctionContext): void {
  const condition = lowerExpression(statement.expression, context)
  const bindingsBeforeBranch = new Map(context.bindings)
  const whenTrue = createBlock(context)
  const whenFalse = createBlock(context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: whenTrue, arguments: []},
    whenFalse: {block: whenFalse, arguments: []},
  })

  const trueBranch = lowerBranch(statement.thenStatement, whenTrue, bindingsBeforeBranch, context)
  const falseBranch = statement.elseStatement == null
    ? {block: context.blocks[whenFalse]!, bindings: new Map(bindingsBeforeBranch)}
    : lowerBranch(statement.elseStatement, whenFalse, bindingsBeforeBranch, context)
  const continuingBranches = [trueBranch, falseBranch].filter(branch => branch.block.terminator == null)
  if (continuingBranches.length === 0) {
    context.currentBlock = trueBranch.block
    context.bindings = bindingsBeforeBranch
    return
  }
  if (continuingBranches.length === 1) {
    const continuing = continuingBranches[0]!
    context.currentBlock = continuing.block
    context.bindings = bindingsVisibleAfterBranch(bindingsBeforeBranch, continuing.bindings)
    return
  }

  const changed = changedBindings(bindingsBeforeBranch, trueBranch.bindings, falseBranch.bindings)
  const continuation = createBlock(context, changed.length)
  terminate(trueBranch.block, {
    kind: 'jump',
    target: {block: continuation, arguments: changed.map(symbol => requiredBranchBinding(symbol, trueBranch.bindings))},
  })
  terminate(falseBranch.block, {
    kind: 'jump',
    target: {block: continuation, arguments: changed.map(symbol => requiredBranchBinding(symbol, falseBranch.bindings))},
  })
  context.currentBlock = context.blocks[continuation]!
  context.bindings = new Map(bindingsBeforeBranch)
  for (let index = 0; index < changed.length; index++) {
    context.bindings.set(changed[index]!, context.currentBlock.parameters[index]!)
  }
}

function lowerForStatement(statement: ts.ForStatement, context: FunctionContext): void {
  if (statement.initializer != null) {
    if (ts.isVariableDeclarationList(statement.initializer)) {
      lowerVariableDeclarationList(statement.initializer, context)
    } else {
      lowerExpression(statement.initializer, context)
    }
  }
  if (statement.condition == null) throw unsupported(statement, 'For loop without a condition')
  if (statement.incrementor == null) throw unsupported(statement, 'For loop without an incrementor')

  const bindingsBeforeLoop = new Map(context.bindings)
  const assigned = assignedSymbols([statement.condition, statement.statement, statement.incrementor], context.checker)
  const carried = [...bindingsBeforeLoop.keys()].filter(symbol => assigned.has(symbol))
  const header = createBlock(context, carried.length, true)
  terminate(context.currentBlock, {
    kind: 'jump',
    target: {block: header, arguments: carried.map(symbol => requiredBranchBinding(symbol, bindingsBeforeLoop))},
  })

  context.currentBlock = context.blocks[header]!
  context.bindings = new Map(bindingsBeforeLoop)
  for (let index = 0; index < carried.length; index++) {
    context.bindings.set(carried[index]!, context.currentBlock.parameters[index]!)
  }
  const condition = lowerExpression(statement.condition, context)
  const conditionBindings = new Map(context.bindings)
  const body = createBlock(context)
  const exit = createBlock(context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: body, arguments: []},
    whenFalse: {block: exit, arguments: []},
  })

  context.currentBlock = context.blocks[body]!
  context.bindings = new Map(conditionBindings)
  lowerStatement(statement.statement, context)
  if (context.currentBlock.terminator == null) {
    lowerExpression(statement.incrementor, context)
    terminate(context.currentBlock, {
      kind: 'jump',
      target: {block: header, arguments: carried.map(symbol => requiredBranchBinding(symbol, context.bindings))},
    })
  }

  context.currentBlock = context.blocks[exit]!
  context.bindings = conditionBindings
}

function lowerBranch(
  statement: ts.Statement,
  block: BlockID,
  bindings: Map<ts.Symbol, ValueID>,
  context: FunctionContext,
): {block: MutableBlock; bindings: Map<ts.Symbol, ValueID>} {
  context.currentBlock = context.blocks[block]!
  context.bindings = new Map(bindings)
  lowerStatement(statement, context)
  return {block: context.currentBlock, bindings: context.bindings}
}

function lowerExpression(expression: ts.Expression, context: FunctionContext): ValueID {
  const current = unwrap(expression)
  if (ts.isNumericLiteral(current)) {
    return addInstruction(context, {kind: 'constant', value: Number(current.text)})
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    const zero = addInstruction(context, {kind: 'constant', value: 0})
    const value = lowerExpression(current.operand, context)
    return addInstruction(context, {kind: 'binary', operator: 'subtract', left: zero, right: value})
  }
  if (ts.isConditionalExpression(current)) {
    const condition = lowerExpression(current.condition, context)
    const bindingsBeforeBranch = new Map(context.bindings)
    const whenTrue = createBlock(context)
    const whenFalse = createBlock(context)
    terminate(context.currentBlock, {
      kind: 'branch',
      condition,
      whenTrue: {block: whenTrue, arguments: []},
      whenFalse: {block: whenFalse, arguments: []},
    })
    context.currentBlock = context.blocks[whenTrue]!
    context.bindings = new Map(bindingsBeforeBranch)
    const trueValue = lowerExpression(current.whenTrue, context)
    const trueBlock = context.currentBlock
    const trueBindings = context.bindings
    context.currentBlock = context.blocks[whenFalse]!
    context.bindings = new Map(bindingsBeforeBranch)
    const falseValue = lowerExpression(current.whenFalse, context)
    const falseBlock = context.currentBlock
    const falseBindings = context.bindings
    const changed = changedBindings(bindingsBeforeBranch, trueBindings, falseBindings)
    const continuation = createBlock(context, changed.length + 1)
    terminate(trueBlock, {
      kind: 'jump',
      target: {
        block: continuation,
        arguments: [trueValue, ...changed.map(symbol => requiredBranchBinding(symbol, trueBindings))],
      },
    })
    terminate(falseBlock, {
      kind: 'jump',
      target: {
        block: continuation,
        arguments: [falseValue, ...changed.map(symbol => requiredBranchBinding(symbol, falseBindings))],
      },
    })
    context.currentBlock = context.blocks[continuation]!
    context.bindings = new Map(bindingsBeforeBranch)
    for (let index = 0; index < changed.length; index++) {
      context.bindings.set(changed[index]!, context.currentBlock.parameters[index + 1]!)
    }
    return context.currentBlock.parameters[0]!
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
    return addInstruction(context, {kind: 'object', properties})
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(current.left)
  ) {
    const object = lowerExpression(current.left.expression, context)
    const value = lowerExpression(current.right, context)
    return addInstruction(context, {kind: 'store', object, property: current.left.name.text, value})
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(current.left)
  ) {
    const symbol = requiredSymbol(current.left, context.checker)
    requiredBinding(symbol, current.left, context)
    const value = lowerExpression(current.right, context)
    context.bindings.set(symbol, value)
    return value
  }
  if (ts.isBinaryExpression(current) && ts.isIdentifier(current.left)) {
    const operator = compoundAssignmentOperator(current.operatorToken.kind)
    if (operator != null) {
      const symbol = requiredSymbol(current.left, context.checker)
      const left = requiredBinding(symbol, current.left, context)
      const right = lowerExpression(current.right, context)
      const value = addInstruction(context, {kind: 'binary', operator, left, right})
      context.bindings.set(symbol, value)
      return value
    }
  }
  if (
    (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
    && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isIdentifier(current.operand)
  ) {
    const symbol = requiredSymbol(current.operand, context.checker)
    const previous = requiredBinding(symbol, current.operand, context)
    const one = addInstruction(context, {kind: 'constant', value: 1})
    const value = addInstruction(context, {
      kind: 'binary',
      operator: current.operator === ts.SyntaxKind.PlusPlusToken ? 'add' : 'subtract',
      left: previous,
      right: one,
    })
    context.bindings.set(symbol, value)
    return ts.isPrefixUnaryExpression(current) ? value : previous
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
      ? addInstruction(context, {kind: 'binary', operator: arithmetic, left, right})
      : addInstruction(context, {kind: 'compare', operator: comparison!, left, right})
  }
  if (ts.isCallExpression(current)) {
    if (ts.isIdentifier(current.expression)) {
      const symbol = resolvedSymbol(context.checker.getSymbolAtLocation(current.expression), context.checker)
      const functionID = symbol == null ? undefined : context.functionsBySymbol.get(symbol)
      if (functionID == null) throw unsupported(current, `Function call ${current.expression.text}`)
      const arguments_ = current.arguments.map(argument => lowerExpression(argument, context))
      return addInstruction(context, {kind: 'call', function: functionID, arguments: arguments_})
    }
    if (ts.isPropertyAccessExpression(current.expression)) {
      const method = current.expression.name.text
      const standardMath = isStandardMathObject(current.expression.expression, context.checker)
      if (standardMath && method === 'floor' && current.arguments.length === 1) {
        requireNumberType(current.arguments[0]!, context.checker, 'Math.floor argument')
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, {kind: 'floor', value})
      }
      if (standardMath && (method === 'min' || method === 'max') && current.arguments.length > 0) {
        for (const argument of current.arguments) requireNumberType(argument, context.checker, `Math.${method} argument`)
        const values = current.arguments.map(argument => lowerExpression(argument, context))
        return addInstruction(context, {kind: method === 'min' ? 'minimum' : 'maximum', values})
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
    return addInstruction(context, {kind: 'property', object, property: current.name.text})
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

function addInstruction(context: FunctionContext, instruction: InstructionInput): ValueID {
  const result = context.nextValue++
  context.currentBlock.instructions.push({...instruction, result} as InstructionIR)
  return result
}

function createBlock(context: FunctionContext, parameterCount = 0, loopHeader = false): BlockID {
  const parameters: ValueID[] = []
  for (let index = 0; index < parameterCount; index++) parameters.push(context.nextValue++)
  const block: MutableBlock = {loopHeader, parameters, instructions: [], terminator: null}
  context.blocks.push(block)
  return context.blocks.length - 1
}

function lowerVariableDeclarationList(declarations: ts.VariableDeclarationList, context: FunctionContext): void {
  for (const declaration of declarations.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) {
      throw unsupported(declaration, 'Variables without identifier names and initializers')
    }
    const value = lowerExpression(declaration.initializer, context)
    context.bindings.set(requiredSymbol(declaration.name, context.checker), value)
  }
}

function assignedSymbols(nodes: ts.Node[], checker: ts.TypeChecker): Set<ts.Symbol> {
  const symbols = new Set<ts.Symbol>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (
      ts.isBinaryExpression(node)
      && ts.isIdentifier(node.left)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || compoundAssignmentOperator(node.operatorToken.kind) != null)
    ) {
      symbols.add(requiredSymbol(node.left, checker))
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isIdentifier(node.operand)
    ) {
      symbols.add(requiredSymbol(node.operand, checker))
    }
    ts.forEachChild(node, visit)
  }
  for (const node of nodes) visit(node)
  return symbols
}

function changedBindings(
  before: Map<ts.Symbol, ValueID>,
  whenTrue: Map<ts.Symbol, ValueID>,
  whenFalse: Map<ts.Symbol, ValueID>,
): ts.Symbol[] {
  const changed: ts.Symbol[] = []
  for (const [symbol, value] of before) {
    if (requiredBranchBinding(symbol, whenTrue) !== value || requiredBranchBinding(symbol, whenFalse) !== value) {
      changed.push(symbol)
    }
  }
  return changed
}

function bindingsVisibleAfterBranch(
  before: Map<ts.Symbol, ValueID>,
  branch: Map<ts.Symbol, ValueID>,
): Map<ts.Symbol, ValueID> {
  const visible = new Map(before)
  for (const symbol of before.keys()) visible.set(symbol, requiredBranchBinding(symbol, branch))
  return visible
}

function requiredBranchBinding(symbol: ts.Symbol, bindings: Map<ts.Symbol, ValueID>): ValueID {
  const value = bindings.get(symbol)
  if (value == null) throw new Error(`Missing binding ${symbol.name} after branch`)
  return value
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

function compoundAssignmentOperator(kind: ts.SyntaxKind): Extract<InstructionIR, {kind: 'binary'}>['operator'] | null {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken: return 'add'
    case ts.SyntaxKind.MinusEqualsToken: return 'subtract'
    case ts.SyntaxKind.AsteriskEqualsToken: return 'multiply'
    case ts.SyntaxKind.SlashEqualsToken: return 'divide'
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

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): {file: string; line: number; column: number} {
  const start = node.getStart(sourceFile)
  const position = sourceFile.getLineAndCharacterOfPosition(start)
  return {
    file: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
  }
}

function unsupported(node: ts.Node, description: string): Error {
  const location = sourceLocation(node.getSourceFile(), node)
  return new Error(`Unsupported ${description} at ${location.file}:${location.line}:${location.column}`)
}
