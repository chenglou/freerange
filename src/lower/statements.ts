import * as ts from 'typescript'
import type {BlockID, ValueID} from '../ir/ids.ts'
import {
  bindingsVisibleAfterBranch,
  changedBindings,
  createBlock,
  requiredBranchBinding,
  requiredSymbol,
  terminate,
  unsupported,
  type FunctionContext,
  type MutableBlock,
} from './context.ts'
import {compoundAssignmentOperator, lowerExpression} from './expression.ts'

export function lowerStatements(statements: readonly ts.Statement[], context: FunctionContext): void {
  for (const statement of statements) {
    if (context.currentBlock.terminator != null) throw unsupported(statement, 'Statements after return')
    lowerStatement(statement, context)
  }
}

function lowerStatement(statement: ts.Statement, context: FunctionContext): void {
  if (ts.isVariableStatement(statement)) {
    lowerVariableDeclarationList(statement.declarationList, context)
    return
  }
  if (ts.isReturnStatement(statement) && statement.expression != null) {
    const value = lowerExpression(statement.expression, context)
    terminate(context.currentBlock, {kind: 'return', value})
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
