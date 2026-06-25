import * as ts from 'typescript'
import type {
  BlockID,
  BlockIR,
  ComparisonOperator,
  FunctionIR,
  InstructionIR,
  ProgramIR,
  SourceSpan,
  TerminatorIR,
  ValueID,
} from './ir.ts'

type MutableBlock = {
  id: BlockID
  instructions: InstructionIR[]
  terminator: TerminatorIR | null
}

type FunctionContext = {
  sourceFile: ts.SourceFile
  nextValue: number
  nextBlock: number
  currentBlock: MutableBlock
  blocks: MutableBlock[]
  bindings: Map<string, ValueID>
  parameters: FunctionIR['parameters']
}

type WithoutResult<T> = T extends unknown ? Omit<T, 'result' | 'span'> : never
type InstructionInput = WithoutResult<InstructionIR>

export function lowerSource(file: string, source: string): ProgramIR {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions: FunctionIR[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) functions.push(lowerFunction(statement, sourceFile))
  }
  return {file, functions}
}

function lowerFunction(declaration: ts.FunctionDeclaration, sourceFile: ts.SourceFile): FunctionIR {
  if (declaration.body == null) throw unsupported(declaration, 'Function declarations need bodies')
  const entry: MutableBlock = {id: 0, instructions: [], terminator: null}
  const context: FunctionContext = {
    sourceFile,
    nextValue: 0,
    nextBlock: 1,
    currentBlock: entry,
    blocks: [entry],
    bindings: new Map(),
    parameters: [],
  }
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) throw unsupported(parameter.name, 'Destructured parameters')
    const value = context.nextValue++
    context.bindings.set(parameter.name.text, value)
    context.parameters.push({value, name: parameter.name.text, span: span(sourceFile, parameter)})
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
    throw unsupported(statement, 'Statement')
  }
  for (const block of context.blocks) {
    if (block.terminator == null) throw unsupported(declaration, `Function path without a return in block ${block.id}`)
  }
  return {
    name: declaration.name!.text,
    parameters: context.parameters,
    entry: entry.id,
    blocks: context.blocks as BlockIR[],
    span: span(sourceFile, declaration),
  }
}

function lowerVariableStatement(statement: ts.VariableStatement, context: FunctionContext): void {
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) {
      throw unsupported(declaration, 'Variables without identifier names and initializers')
    }
    const value = lowerExpression(declaration.initializer, context)
    context.bindings.set(declaration.name.text, value)
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
      whenTrue: whenTrue.id,
      whenFalse: whenFalse.id,
      span: span(context.sourceFile, current.condition),
    })
    context.currentBlock = whenTrue
    lowerReturnExpression(current.whenTrue, context)
    context.currentBlock = whenFalse
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
    const value = context.bindings.get(current.text)
    if (value == null) throw unsupported(current, `Unknown identifier ${current.text}`)
    return value
  }
  if (ts.isBinaryExpression(current)) {
    const arithmetic = arithmeticOperator(current.operatorToken.kind)
    const comparison = comparisonOperator(current.operatorToken.kind)
    if (arithmetic == null && comparison == null) {
      throw unsupported(current, `Binary operator ${current.operatorToken.getText(context.sourceFile)}`)
    }
    const left = lowerExpression(current.left, context)
    const right = lowerExpression(current.right, context)
    return arithmetic != null
      ? addInstruction(context, {kind: 'binary', operator: arithmetic, left, right}, current)
      : addInstruction(context, {kind: 'compare', operator: comparison!, left, right}, current)
  }
  if (ts.isCallExpression(current)) {
    if (ts.isIdentifier(current.expression)) {
      const arguments_ = current.arguments.map(argument => lowerExpression(argument, context))
      return addInstruction(context, {kind: 'call', functionName: current.expression.text, arguments: arguments_}, current)
    }
    if (ts.isPropertyAccessExpression(current.expression)) {
      const target = current.expression.getText(context.sourceFile)
      if (target === 'Math.floor' && current.arguments.length === 1) {
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, {kind: 'floor', value}, current)
      }
      if ((target === 'Math.min' || target === 'Math.max') && current.arguments.length > 0) {
        const values = current.arguments.map(argument => lowerExpression(argument, context))
        return addInstruction(context, {kind: target === 'Math.min' ? 'minimum' : 'maximum', values}, current)
      }
    }
  }
  throw unsupported(current, 'Expression')
}

function addInstruction(context: FunctionContext, instruction: InstructionInput, source: ts.Node): ValueID {
  const result = context.nextValue++
  context.currentBlock.instructions.push({...instruction, result, span: span(context.sourceFile, source)} as InstructionIR)
  return result
}

function createBlock(context: FunctionContext): MutableBlock {
  const block: MutableBlock = {id: context.nextBlock++, instructions: [], terminator: null}
  context.blocks.push(block)
  return block
}

function terminate(block: MutableBlock, terminator: TerminatorIR): void {
  if (block.terminator != null) throw new Error(`IR block ${block.id} already has a terminator`)
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
