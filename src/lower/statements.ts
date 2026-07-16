import * as ts from 'typescript'
import type {BlockID, ValueID} from '../ir/ids.ts'
import {
  addInstruction,
  addSite,
  bindingsVisibleAfterBranch,
  createBlock,
  mergeAtContinuation,
  requiredBranchBinding,
  requiredSymbol,
  terminate,
  unsupported,
  type FunctionContext,
  type MutableBlock,
} from './context.ts'
import {taggedUnionTagRead, identifierAssignment, lowerBranchingCondition, lowerExpression, lowerStatementExpression, requireBooleanCondition, valueKind} from './expression.ts'
import {declaredOnlyInDeclarationFiles} from './platform.ts'

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
  if (ts.isWhileStatement(statement)) {
    lowerWhileStatement(statement, context)
    return
  }
  if (ts.isContinueStatement(statement)) {
    lowerContinueStatement(statement, context)
    return
  }
  if (ts.isBlock(statement)) {
    lowerStatements(statement.statements, context)
    return
  }
  if (ts.isSwitchStatement(statement)) {
    lowerSwitchStatement(statement, context)
    return
  }
  // Guard clauses: `if (columns === 0) throw new Error('bad grid')`. The branch
  // refinement then proves the fall-through nonzero, and the thrown path simply ends.
  if (ts.isThrowStatement(statement)) {
    terminate(context.currentBlock, {kind: 'thrown', site: addSite(context, statement)})
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

  mergeAtContinuation([trueBranch, falseBranch], bindingsBeforeBranch, statement, context)
}

// Switch without fallthrough (owner decision): every non-empty case body must end in a
// top-level break or a return, stacked empty labels share the next body, default comes
// last. Under that rule a switch is exactly an if/else chain on ===, so the lowering is
// pure reuse — number subjects get the comparison narrowing (case 4 knows the subject is
// 4), string subjects get the unknown-boolean dispatch with both branches analyzed, and
// bodies that break merge at the exit with the same block-parameter machinery as if/else.
function lowerSwitchStatement(statement: ts.SwitchStatement, context: FunctionContext): void {
  const subjectType = context.checker.getTypeAtLocation(statement.expression)
  const subjectKind = valueKind(subjectType, context.checker)
  // switch (route.type) is tagged-union dispatch: the subject becomes the union value
  // itself and every case emits a tag check, so each body knows its exact shape — the
  // same narrowing the === spelling gets.
  const tagUnionExpression = taggedUnionTagRead(statement.expression, context)
  // A possibly-missing string subject (mode: string | undefined) dispatches like the ===
  // spelling does: the missing value simply matches no case, so the unknown-boolean arm
  // covers it. Every non-missing member must be a string for that to hold.
  const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
  const nullableOpaqueSubject = subjectKind === 'nullable' && subjectType.isUnion()
    && subjectType.types.every(member =>
      (member.flags & missingFlags) !== 0 || valueKind(member, context.checker) === 'opaque')
  if (tagUnionExpression == null && subjectKind !== 'number' && subjectKind !== 'opaque' && !nullableOpaqueSubject) {
    throw unsupported(statement.expression, {kind: 'switchSubject', typeText: context.checker.typeToString(subjectType)})
  }
  const subject = lowerExpression(tagUnionExpression ?? statement.expression, context)

  // Group stacked empty labels with the body they share; reject a default that is not the
  // last clause (JS would test later cases before running it — supporting that order buys
  // nothing over writing default last).
  type CaseGroup = {labels: ts.Expression[]; statements: ts.Statement[]; clause: ts.CaseOrDefaultClause}
  const groups: CaseGroup[] = []
  let pendingLabels: ts.Expression[] = []
  let defaultGroup: CaseGroup | null = null
  const clauses = statement.caseBlock.clauses
  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index]!
    if (ts.isDefaultClause(clause)) {
      if (index !== clauses.length - 1 || pendingLabels.length > 0) {
        throw unsupported(clause, {kind: 'switchDefaultNotLast'})
      }
      defaultGroup = {labels: [], statements: [...clause.statements], clause}
      continue
    }
    pendingLabels.push(clause.expression)
    if (clause.statements.length > 0) {
      groups.push({labels: pendingLabels, statements: [...clause.statements], clause})
      pendingLabels = []
    }
  }
  // Trailing empty labels with no body to share fall out of the switch at runtime; the
  // no-fallthrough rule wants that written as an explicit body, so they reject too.
  if (pendingLabels.length > 0) {
    throw unsupported(statement, {kind: 'switchFallthrough'})
  }

  const bindingsBefore = new Map(context.bindings)
  // Bodies that ended in a break continue after the switch, as does the no-match path
  // when there is no default; all of them merge at the continuation.
  const exits: Array<{block: MutableBlock; bindings: Map<ts.Symbol, ValueID>}> = []

  const lowerBody = (group: CaseGroup): void => {
    const body = group.statements
    const last = body[body.length - 1]
    const endsWithBreak = last != null && ts.isBreakStatement(last)
    lowerStatements(endsWithBreak ? body.slice(0, -1) : body, context)
    if (context.currentBlock.terminator == null) {
      if (!endsWithBreak) throw unsupported(group.clause, {kind: 'switchFallthrough'})
      exits.push({block: context.currentBlock, bindings: context.bindings})
    }
  }

  for (const group of groups) {
    const bodyBlock = createBlock(context)
    // Chain of label tests: each label's false edge goes to the next label, the last
    // label's false edge to the next group (or the default / the no-match exit).
    for (const label of group.labels) {
      const labelKind = valueKind(context.checker.getTypeAtLocation(label), context.checker)
      const effectiveSubjectKind = nullableOpaqueSubject ? 'opaque' : subjectKind
      if (tagUnionExpression == null && labelKind !== effectiveSubjectKind) {
        throw unsupported(label, {kind: 'switchLabel', typeText: context.checker.typeToString(context.checker.getTypeAtLocation(label))})
      }
      let condition: ValueID
      if (tagUnionExpression != null) {
        const unwrappedLabel = label
        if (!ts.isStringLiteral(unwrappedLabel) && !ts.isNoSubstitutionTemplateLiteral(unwrappedLabel)) {
          throw unsupported(label, {kind: 'switchLabel', typeText: context.checker.typeToString(context.checker.getTypeAtLocation(label))})
        }
        condition = addInstruction(context, label, {kind: 'tagCheck', union: subject, tagValue: unwrappedLabel.text, negated: false})
      } else {
        const labelValue = lowerExpression(label, context)
        condition = effectiveSubjectKind === 'number'
          ? addInstruction(context, label, {kind: 'compare', operator: 'equal', left: subject, right: labelValue})
          : addInstruction(context, label, {kind: 'unknownBoolean'})
      }
      const nextTest = createBlock(context)
      terminate(context.currentBlock, {
        kind: 'branch',
        condition,
        whenTrue: {block: bodyBlock, arguments: []},
        whenFalse: {block: nextTest, arguments: []},
        site: addSite(context, label),
      })
      context.currentBlock = context.blocks[nextTest]!
    }
    const afterTests = context.currentBlock
    const bindingsAtTests = new Map(context.bindings)
    context.currentBlock = context.blocks[bodyBlock]!
    context.bindings = new Map(bindingsBefore)
    lowerBody(group)
    context.currentBlock = afterTests
    context.bindings = bindingsAtTests
  }

  if (defaultGroup == null) {
    exits.push({block: context.currentBlock, bindings: context.bindings})
  } else {
    lowerBody(defaultGroup)
  }

  if (exits.length === 0) {
    // Every path returned; subsequent statements land in a terminated block, where the
    // statement-after-return rejection already speaks.
    return
  }
  if (exits.length === 1) {
    context.currentBlock = exits[0]!.block
    context.bindings = bindingsVisibleAfterBranch(bindingsBefore, exits[0]!.bindings)
    return
  }
  mergeAtContinuation(exits, bindingsBefore, statement, context)
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

  // The counter is a raw header parameter, not a symbol binding, so a continue cannot
  // observe a stale value: the bump is emitted fresh at each back edge (the body end here,
  // and every continue site).
  const advance = (advanceContext: FunctionContext): ValueID[] => {
    const one = addInstruction(advanceContext, statement, {kind: 'constant', value: 1})
    const next = addInstruction(advanceContext, statement, {kind: 'binary', operator: 'add', left: counter, right: one})
    return [next]
  }

  context.currentBlock = context.blocks[body]!
  context.bindings = new Map(conditionBindings)
  context.bindings.set(
    requiredSymbol(elementName, context.checker),
    addInstruction(context, statement, {
      kind: 'arrayIndex',
      array,
      index: counter,
      mode: 'bare',
    }),
  )
  context.loops.push({header, carried, advance})
  lowerStatement(statement.statement, context)
  context.loops.pop()
  if (context.currentBlock.terminator == null) {
    const extra = advance(context)
    terminate(context.currentBlock, {
      kind: 'jump',
      target: {
        block: header,
        arguments: [...carried.map(symbol => requiredBranchBinding(symbol, context.bindings)), ...extra],
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
  requireBooleanCondition(statement.condition, context.checker)

  const bindingsBeforeLoop = new Map(context.bindings)
  const scanned = statement.incrementor == null
    ? [statement.condition, statement.statement]
    : [statement.condition, statement.statement, statement.incrementor]
  const assigned = assignedSymbols(scanned, context.checker)
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

  // A continue runs the incrementor before jumping back, same as the normal body end —
  // JavaScript's order (continue in a for loop still advances the counter). An absent
  // incrementor makes the loop while-shaped; progress then lives in the body.
  const advance = (advanceContext: FunctionContext): ValueID[] => {
    if (statement.incrementor != null) lowerStatementExpression(statement.incrementor, advanceContext)
    return []
  }

  context.currentBlock = context.blocks[body]!
  context.bindings = new Map(conditionBindings)
  context.loops.push({header, carried, advance})
  lowerStatement(statement.statement, context)
  context.loops.pop()
  if (context.currentBlock.terminator == null) {
    advance(context)
    terminate(context.currentBlock, {
      kind: 'jump',
      target: {block: header, arguments: carried.map(symbol => requiredBranchBinding(symbol, context.bindings))},
      site: addSite(context, statement),
    })
  }

  context.currentBlock = context.blocks[exit]!
  context.bindings = conditionBindings
}

// `while (cond) body` is a for loop with no initializer and no incrementor: the same
// header/body/exit blocks, the same carried-binding block parameters, the same widening
// and fixed point at the header. Progress lives in the body's own assignments, so a body
// that never changes the condition's inputs converges to the non-exiting-loop stop.
function lowerWhileStatement(statement: ts.WhileStatement, context: FunctionContext): void {
  requireBooleanCondition(statement.expression, context.checker)

  const bindingsBeforeLoop = new Map(context.bindings)
  const assigned = assignedSymbols([statement.expression, statement.statement], context.checker)
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
  lowerBranchingCondition(statement.expression, body, exit, context)

  context.currentBlock = context.blocks[body]!
  context.bindings = new Map(conditionBindings)
  context.loops.push({header, carried, advance: () => []})
  lowerStatement(statement.statement, context)
  context.loops.pop()
  if (context.currentBlock.terminator == null) {
    terminate(context.currentBlock, {
      kind: 'jump',
      target: {block: header, arguments: carried.map(symbol => requiredBranchBinding(symbol, context.bindings))},
      site: addSite(context, statement),
    })
  }

  context.currentBlock = context.blocks[exit]!
  context.bindings = conditionBindings
}

// `continue` ends the current path the way `return` does, except the jump targets the
// innermost loop's header instead of leaving the function. The loop's advance step runs
// first (a for loop's incrementor, the for-of counter bump), then the carried bindings
// are read at their current values — exactly what the normal body-end back edge does.
function lowerContinueStatement(statement: ts.ContinueStatement, context: FunctionContext): void {
  if (statement.label != null) {
    throw unsupported(statement, {kind: 'statementForm', syntax: 'ContinueStatement with a label'})
  }
  const loop = context.loops[context.loops.length - 1]
  // TypeScript already rejects continue outside a loop; the guard keeps lowering total if
  // such a file ever reaches this point.
  if (loop == null) throw unsupported(statement, {kind: 'statementForm', syntax: 'ContinueStatement'})
  const extra = loop.advance(context)
  terminate(context.currentBlock, {
    kind: 'jump',
    target: {
      block: loop.header,
      arguments: [...loop.carried.map(symbol => requiredBranchBinding(symbol, context.bindings)), ...extra],
    },
    site: addSite(context, statement),
  })
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
        // Optional properties destructure like any other read now that the filling
        // invariant guarantees the record value carries them as maybe-undefined (the old
        // gate here predated the optionals milestone). Prototype members stay out via
        // the same ownership rule property reads use.
        if (propertySymbol != null && declaredOnlyInDeclarationFiles(propertySymbol)) {
          throw unsupported(element, {kind: 'prototypeMemberRead', property})
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
    const declaredValueKind = valueKind(declaredType, context.checker)
    if (declaredValueKind == null) {
      throw unsupported(declaration.type ?? declaration.name, {
        kind: 'valueType',
        typeText: context.checker.typeToString(declaredType),
      })
    }
    // An opaque-declared binding (`let u: unknown = 5`) erases its stored value: later
    // branches may write other kinds, and opaque ⊔ opaque joins where number ⊔ boolean
    // would crash. The initializer still lowered above, so its constructs stay vetted.
    const stored = declaredValueKind === 'opaque'
      ? addInstruction(context, declaration, {kind: 'opaqueConstant'})
      : value
    context.bindings.set(requiredSymbol(declaration.name, context.checker), stored)
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
