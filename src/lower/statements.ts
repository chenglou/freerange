import * as ts from 'typescript'
import type {BlockID, ValueID} from '../ir/ids.ts'
import {
  addInstruction,
  addSite,
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
import {identifierAssignment, lowerBranchingCondition, lowerExpression, lowerStatementExpression, requireBooleanCondition, valueKind} from './expression.ts'

export function lowerStatements(statements: readonly ts.Statement[], context: FunctionContext): void {
  for (const statement of statements) {
    if (context.currentBlock.terminator != null) throw unsupported(statement, {kind: 'statementAfterReturn'})
    lowerStatement(statement, context)
  }
}

export function lowerStatement(statement: ts.Statement, context: FunctionContext): void {
  if (ts.isVariableStatement(statement)) {
    lowerVariableDeclarationList(statement.declarationList, context)
    return
  }
  if (ts.isReturnStatement(statement)) {
    let value = statement.expression == null ? null : lowerExpression(statement.expression, context)
    // A bare `return` in a function that returns a value IS `return undefined` — the
    // common early exit in a `T | undefined` function. In void functions (and the module
    // initializer) the return stays valueless.
    if (value == null) {
      const enclosing = ts.findAncestor(statement, ts.isFunctionDeclaration)
      const signature = enclosing == null ? undefined : context.checker.getSignatureFromDeclaration(enclosing)
      const returnType = signature == null ? null : context.checker.getReturnTypeOfSignature(signature)
      const returnsVoid = returnType == null || (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
      if (!returnsVoid) {
        value = addInstruction(context, statement, {kind: 'nullishConstant', sentinel: 'undefined'})
      }
    }
    terminate(context.currentBlock, {kind: 'return', value, site: addSite(context, statement)})
    return
  }
  if (ts.isExpressionStatement(statement)) {
    lowerStatementExpression(statement.expression, context)
    return
  }
  if (ts.isIfStatement(statement)) {
    lowerIfStatement(statement, context)
    return
  }
  if (ts.isForOfStatement(statement)) {
    lowerForOfStatement(statement, context)
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
  throw unsupported(statement, {kind: 'statementForm', syntax: ts.SyntaxKind[statement.kind]})
}

function lowerIfStatement(statement: ts.IfStatement, context: FunctionContext): void {
  const bindingsBeforeBranch = new Map(context.bindings)
  const whenTrue = createBlock(context)
  const whenFalse = createBlock(context)
  lowerBranchingCondition(statement.expression, whenTrue, whenFalse, context)

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
    site: addSite(context, statement),
  })
  terminate(falseBranch.block, {
    kind: 'jump',
    target: {block: continuation, arguments: changed.map(symbol => requiredBranchBinding(symbol, falseBranch.bindings))},
    site: addSite(context, statement),
  })
  context.currentBlock = context.blocks[continuation]!
  context.bindings = new Map(bindingsBeforeBranch)
  for (let index = 0; index < changed.length; index++) {
    context.bindings.set(changed[index]!, context.currentBlock.parameters[index]!)
  }
}

// `for (const x of arr)` desugars to a counter loop: a synthetic counter rides the loop
// header as an extra block parameter (block parameters are plain ValueIDs, no symbol
// needed), the header compares it against the array's length, and the body's element read
// is in bounds by construction — the guard, the 0 start, and the +1 step are all
// synthetic values nothing can reassign. An empty array prunes the body entirely.
function lowerForOfStatement(statement: ts.ForOfStatement, context: FunctionContext): void {
  if (!ts.isVariableDeclarationList(statement.initializer)
    || statement.initializer.declarations.length !== 1
    || !ts.isIdentifier(statement.initializer.declarations[0]!.name)) {
    throw unsupported(statement.initializer, {kind: 'variableDeclarationShape'})
  }
  const elementName = statement.initializer.declarations[0]!.name
  const elementType = context.checker.getTypeAtLocation(elementName)
  if (valueKind(elementType, context.checker) == null) {
    throw unsupported(elementName, {kind: 'valueType', typeText: context.checker.typeToString(elementType)})
  }
  const arrayType = context.checker.getTypeAtLocation(statement.expression)
  const arrayKind = valueKind(arrayType, context.checker)
  if (arrayKind !== 'array' && arrayKind !== 'tuple') {
    throw unsupported(statement.expression, {kind: 'valueType', typeText: context.checker.typeToString(arrayType)})
  }
  const array = lowerExpression(statement.expression, context)
  const zero = addInstruction(context, statement, {kind: 'constant', value: 0})

  const bindingsBeforeLoop = new Map(context.bindings)
  const assigned = assignedSymbols([statement.statement], context.checker)
  const carried = [...bindingsBeforeLoop.keys()].filter(symbol => assigned.has(symbol))
  const header = createBlock(context, carried.length + 1, addSite(context, statement))
  terminate(context.currentBlock, {
    kind: 'jump',
    target: {
      block: header,
      arguments: [...carried.map(symbol => requiredBranchBinding(symbol, bindingsBeforeLoop)), zero],
    },
    site: addSite(context, statement),
  })

  context.currentBlock = context.blocks[header]!
  context.bindings = new Map(bindingsBeforeLoop)
  for (let index = 0; index < carried.length; index++) {
    context.bindings.set(carried[index]!, context.currentBlock.parameters[index]!)
  }
  const counter = context.currentBlock.parameters[carried.length]!
  const length = addInstruction(context, statement, {kind: 'arrayLength', array})
  const condition = addInstruction(context, statement, {kind: 'compare', operator: 'lessThan', left: counter, right: length})
  const conditionBindings = new Map(context.bindings)
  const body = createBlock(context)
  const exit = createBlock(context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: body, arguments: []},
    whenFalse: {block: exit, arguments: []},
    site: addSite(context, statement),
  })

  context.currentBlock = context.blocks[body]!
  context.bindings = new Map(conditionBindings)
  context.bindings.set(
    requiredSymbol(elementName, context.checker),
    addInstruction(context, statement, {kind: 'arrayIndex', array, index: counter, asserted: true, provenBounds: true}),
  )
  lowerStatement(statement.statement, context)
  if (context.currentBlock.terminator == null) {
    const one = addInstruction(context, statement, {kind: 'constant', value: 1})
    const next = addInstruction(context, statement, {kind: 'binary', operator: 'add', left: counter, right: one})
    terminate(context.currentBlock, {
      kind: 'jump',
      target: {
        block: header,
        arguments: [...carried.map(symbol => requiredBranchBinding(symbol, context.bindings)), next],
      },
      site: addSite(context, statement),
    })
  }

  context.currentBlock = context.blocks[exit]!
  context.bindings = new Map(conditionBindings)
}

function lowerForStatement(statement: ts.ForStatement, context: FunctionContext): void {
  if (statement.initializer != null) {
    if (ts.isVariableDeclarationList(statement.initializer)) {
      lowerVariableDeclarationList(statement.initializer, context)
    } else {
      lowerStatementExpression(statement.initializer, context)
    }
  }
  if (statement.condition == null) throw unsupported(statement, {kind: 'forLoopWithoutCondition'})
  if (statement.incrementor == null) throw unsupported(statement, {kind: 'forLoopWithoutIncrementor'})
  requireBooleanCondition(statement.condition, context.checker)

  const bindingsBeforeLoop = new Map(context.bindings)
  const assigned = assignedSymbols([statement.condition, statement.statement, statement.incrementor], context.checker)
  const carried = [...bindingsBeforeLoop.keys()].filter(symbol => assigned.has(symbol))
  const header = createBlock(context, carried.length, addSite(context, statement))
  terminate(context.currentBlock, {
    kind: 'jump',
    target: {block: header, arguments: carried.map(symbol => requiredBranchBinding(symbol, bindingsBeforeLoop))},
    site: addSite(context, statement),
  })

  context.currentBlock = context.blocks[header]!
  context.bindings = new Map(bindingsBeforeLoop)
  for (let index = 0; index < carried.length; index++) {
    context.bindings.set(carried[index]!, context.currentBlock.parameters[index]!)
  }
  const conditionBindings = new Map(context.bindings)
  const body = createBlock(context)
  const exit = createBlock(context)
  lowerBranchingCondition(statement.condition, body, exit, context)

  context.currentBlock = context.blocks[body]!
  context.bindings = new Map(conditionBindings)
  lowerStatement(statement.statement, context)
  if (context.currentBlock.terminator == null) {
    lowerStatementExpression(statement.incrementor, context)
    terminate(context.currentBlock, {
      kind: 'jump',
      target: {block: header, arguments: carried.map(symbol => requiredBranchBinding(symbol, context.bindings))},
      site: addSite(context, statement),
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
    // `const {pos, dest} = config` lowers to one read of the source and one property read
    // per name. Only plain shorthand or renamed identifier elements — no defaults, no rest.
    if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer != null) {
      const source = lowerExpression(declaration.initializer, context)
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name) || element.dotDotDotToken != null || element.initializer != null) {
          throw unsupported(element, {kind: 'variableDeclarationShape'})
        }
        const property = element.propertyName == null
          ? element.name.text
          : ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : null
        if (property == null) throw unsupported(element, {kind: 'variableDeclarationShape'})
        const elementType = context.checker.getTypeAtLocation(element.name)
        const sourceType = context.checker.getTypeAtLocation(declaration.initializer)
        const propertySymbol = context.checker.getPropertyOfType(sourceType, property)
        // Optional properties stay out: the record value may not carry them (see
        // requireAccessedPropertyKind).
        if (propertySymbol != null && (propertySymbol.flags & ts.SymbolFlags.Optional) !== 0) {
          throw unsupported(element, {kind: 'valueType', typeText: context.checker.typeToString(elementType)})
        }
        if (valueKind(elementType, context.checker) == null) {
          throw unsupported(element, {kind: 'valueType', typeText: context.checker.typeToString(elementType)})
        }
        const value = addInstruction(context, element, {kind: 'property', object: source, property})
        context.bindings.set(requiredSymbol(element.name, context.checker), value)
      }
      continue
    }
    if (!ts.isIdentifier(declaration.name) || declaration.initializer == null) {
      throw unsupported(declaration, {kind: 'variableDeclarationShape'})
    }
    const value = lowerExpression(declaration.initializer, context)
    // A variable whose declared type mixes kinds, e.g. `let u: unknown = 5` later reassigned
    // to a boolean, lets branches rebind it to different kinds that would meet at the
    // engine's block join instead of stopping here. The check runs after the initializer
    // lowers, so an unsupported construct inside the initializer keeps its own more precise
    // site (a ternary mixing kinds reports the ternary, not the whole declaration).
    const declaredType = context.checker.getTypeAtLocation(declaration.name)
    if (valueKind(declaredType, context.checker) == null) {
      throw unsupported(declaration.type ?? declaration.name, {
        kind: 'valueType',
        typeText: context.checker.typeToString(declaredType),
      })
    }
    context.bindings.set(requiredSymbol(declaration.name, context.checker), value)
  }
}

function assignedSymbols(nodes: ts.Node[], checker: ts.TypeChecker): Set<ts.Symbol> {
  const symbols = new Set<ts.Symbol>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    // Shares the lowering's recognizer, so a form that lowers an assignment is carried
    // across loop back edges by construction.
    const assignment = identifierAssignment(node)
    if (assignment != null) symbols.add(requiredSymbol(assignment.target, checker))
    ts.forEachChild(node, visit)
  }
  for (const node of nodes) visit(node)
  return symbols
}
