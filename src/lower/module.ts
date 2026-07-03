import * as ts from 'typescript'
import type {ModuleBindingID, SiteID} from '../ir/ids.ts'
import type {
  BlockIR,
  FunctionIR,
  ModuleBindingCategory,
  ModuleBindingIR,
  SourceSpan,
  UnsupportedReason,
} from '../ir/program.ts'
import {assertAccepted} from './accept.ts'
import {addInstruction, addSite, LoweringStop, terminate, type FunctionContext, type MutableBlock, type TopLevelFunction} from './context.ts'
import {lowerExpression, valueKind} from './expression.ts'
import {lowerStatement} from './statements.ts'

export type ModuleScan = {
  bindings: ModuleBindingIR[]
  bindingsBySymbol: Map<ts.Symbol, ModuleBindingID>
  // Bindings some function writes. A skipped top-level statement can call any function, so
  // these are havocked alongside the statement's own writes at every skip.
  writtenInsideFunctions: Set<ModuleBindingID>
}

// Classifies every top-level binding by one rule: a function may trust the binding's value
// only when every possible write to it is accounted for. The scan reads the entire file's
// text — bodies of functions the analyzer rejects included — so a write hiding inside
// unsupported code still demotes the binding.
export function scanModuleBindings(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ModuleScan {
  const bindings: ModuleBindingIR[] = []
  const bindingsBySymbol = new Map<ts.Symbol, ModuleBindingID>()
  const register = (name: ts.Identifier, category: ModuleBindingCategory): void => {
    const symbol = checker.getSymbolAtLocation(name)
    if (symbol == null) return
    bindingsBySymbol.set(symbol, bindings.length)
    bindings.push({name: name.text, category})
  }

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      // `var` is outside the accepted subset, so its names never become module bindings;
      // the statement itself stops the initializer when reached.
      if ((statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) continue
      for (const declarator of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declarator.name)) continue
        register(declarator.name, declaredCategory(declarator.name, checker))
      }
      continue
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause == null || clause.isTypeOnly) continue
      if (clause.name != null) register(clause.name, {kind: 'import'})
      const named = clause.namedBindings
      if (named != null && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (!element.isTypeOnly) register(element.name, {kind: 'import'})
        }
      }
      if (named != null && ts.isNamespaceImport(named)) register(named.name, {kind: 'import'})
    }
  }

  // Demote bindings that functions write.
  const writtenInsideFunctions = new Set<ModuleBindingID>()
  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (insideFunction) {
      for (const written of moduleWritesIn(node, checker, bindingsBySymbol)) writtenInsideFunctions.add(written)
    }
    const enteringFunction = insideFunction || ts.isFunctionLike(node)
    ts.forEachChild(node, child => { visit(child, enteringFunction) })
  }
  visit(sourceFile, false)

  for (let binding = 0; binding < bindings.length; binding++) {
    if (writtenInsideFunctions.has(binding)) demote(bindings, binding)
  }
  return {bindings, bindingsBySymbol, writtenInsideFunctions}
}

// The writes the given node itself performs to module bindings (not its children's writes;
// the caller walks). Any write-position form we do not recognize must count as a write —
// missing one publishes a stale value.
export function moduleWritesIn(
  node: ts.Node,
  checker: ts.TypeChecker,
  bindingsBySymbol: Map<ts.Symbol, ModuleBindingID>,
): ModuleBindingID[] {
  const written: ModuleBindingID[] = []
  const target = (expression: ts.Expression): void => {
    // An assignment target can be a plain identifier or a destructuring pattern; every
    // identifier inside a pattern is conservatively a write.
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression)
      const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
      if (binding != null) written.push(binding)
      return
    }
    const visitPattern = (child: ts.Node): void => {
      // The shorthand `x` in `({x} = source)` resolves to the contextual type's PROPERTY
      // symbol via getSymbolAtLocation; the assigned variable needs the dedicated resolver.
      if (ts.isShorthandPropertyAssignment(child)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(child)
        const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
        if (binding != null) written.push(binding)
        ts.forEachChild(child, visitPattern)
        return
      }
      if (ts.isIdentifier(child)) {
        const symbol = checker.getSymbolAtLocation(child)
        const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
        if (binding != null) written.push(binding)
        return
      }
      ts.forEachChild(child, visitPattern)
    }
    ts.forEachChild(expression, visitPattern)
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind
    if (kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment) target(node.left)
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isExpression(node.operand)
  ) {
    target(node.operand)
  }
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isExpression(node.initializer)) {
    target(node.initializer)
  }
  return written
}

// Lowers the module's top-level runtime code into one synthetic function. When a statement
// cannot lower, everything before it is kept and the open paths end with stop terminators;
// writes in the never-lowered statements demote their bindings' categories, since an
// unanalyzed write means the initialized value cannot be trusted.
export function lowerModuleInitializer(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
): {initializer: FunctionIR; skips: InitializerSkip[]} {
  const entry: MutableBlock = {loopHeader: null, parameters: [], instructions: [], terminator: null}
  const context: FunctionContext = {
    sourceFile,
    checker,
    functionsBySymbol,
    moduleBindingsBySymbol: scan.bindingsBySymbol,
    sites,
    nextValue: 0,
    currentBlock: entry,
    blocks: [entry],
    bindings: new Map(),
    parameters: [],
  }
  const skips: InitializerSkip[] = []
  const statements = sourceFile.statements
  // BLITZ: instead of stopping at the first unsupported statement, each statement gets its
  // own catch: an unsupported one is skipped — its half-lowered instructions and blocks
  // rolled back — and every binding it could write is demoted, so later reads cannot trust
  // values the skipped code might have changed. Runtime exceptions and ordering effects of
  // skipped statements are ignored; that is the blitz-grade unsoundness.
  for (const statement of statements) {
    if (skippedAtTopLevel(statement)) continue
    const recovery = {
      block: context.currentBlock,
      instructionCount: context.currentBlock.instructions.length,
      blockCount: context.blocks.length,
      bindings: new Map(context.bindings),
    }
    try {
      assertAccepted(statement, checker)
      if (ts.isVariableStatement(statement)) {
        lowerTopLevelDeclarations(statement, context, scan)
        continue
      }
      lowerStatement(statement, context)
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      context.blocks.length = recovery.blockCount
      recovery.block.instructions.length = recovery.instructionCount
      recovery.block.terminator = null
      context.currentBlock = recovery.block
      context.bindings = recovery.bindings
      skips.push({site: addSite(context, error.node), reason: error.reason})
      // Demote what the statement writes directly, then reset the slots of everything the
      // statement could have written — its own targets plus, since it may call any
      // function, every binding functions write. Without the reset, a later analyzed
      // statement would compute from the stale pre-skip value and publish the result
      // through a fresh binding that nothing demotes.
      const havocked = new Set(scan.writtenInsideFunctions)
      for (const written of allModuleWritesIn(statement, checker, scan.bindingsBySymbol)) {
        demote(scan.bindings, written)
        havocked.add(written)
      }
      for (const binding of havocked) {
        addInstruction(context, statement, {kind: 'moduleHavoc', binding})
      }
    }
  }
  if (context.currentBlock.terminator == null) {
    terminate(context.currentBlock, {kind: 'return', value: null, site: addSite(context, sourceFile)})
  }
  const blocks: BlockIR[] = []
  for (const block of context.blocks) {
    if (block.terminator == null) throw new Error('Module initializer block without a terminator')
    blocks.push({
      loopHeader: block.loopHeader,
      parameters: block.parameters,
      instructions: block.instructions,
      terminator: block.terminator,
    })
  }
  return {initializer: {kind: 'lowered', name: 'module initialization', parameters: [], entry: 0, blocks}, skips}
}

// A top-level statement the initializer's lowering skipped, with the construct that made it
// unsupported. The report lists these on the module initialization entry.
export type InitializerSkip = {site: SiteID; reason: UnsupportedReason}

function lowerTopLevelDeclarations(statement: ts.VariableStatement, context: FunctionContext, scan: ModuleScan): void {
  for (const declarator of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declarator.name) || declarator.initializer == null) {
      throw new LoweringStop(declarator, {kind: 'variableDeclarationShape'})
    }
    const symbol = context.checker.getSymbolAtLocation(declarator.name)
    const binding = symbol == null ? undefined : scan.bindingsBySymbol.get(symbol)
    if (binding == null) throw new LoweringStop(declarator, {kind: 'variableDeclarationShape'})
    const value = lowerExpression(declarator.initializer, context)
    addInstruction(context, declarator, {kind: 'moduleWrite', binding, value})
  }
}

function skippedAtTopLevel(statement: ts.Statement): boolean {
  // `export {alreadyDeclaredName}` and import declarations create bindings but run nothing.
  return ts.isFunctionDeclaration(statement)
    || ts.isImportDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || ts.isInterfaceDeclaration(statement)
    || ts.isExportDeclaration(statement)
}

function allModuleWritesIn(
  root: ts.Node,
  checker: ts.TypeChecker,
  bindingsBySymbol: Map<ts.Symbol, ModuleBindingID>,
): ModuleBindingID[] {
  const written: ModuleBindingID[] = []
  const visit = (node: ts.Node): void => {
    written.push(...moduleWritesIn(node, checker, bindingsBySymbol))
    // A never-lowered declarator counts as a write to its own binding.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const symbol = checker.getSymbolAtLocation(node.name)
      const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
      if (binding != null) written.push(binding)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return written
}

function declaredCategory(name: ts.Identifier, checker: ts.TypeChecker): ModuleBindingCategory {
  const kind = valueKind(checker.getTypeAtLocation(name), checker)
  switch (kind) {
    case 'number': return {kind: 'value', declaredKind: 'number'}
    case 'boolean': return {kind: 'value', declaredKind: 'boolean'}
    case 'object': return {kind: 'identity'}
    case null: return {kind: 'opaque'}
  }
}

// A binding with an unaccounted write cannot publish its value: numbers and booleans keep
// only their declared kind, and an object binding that may be reassigned is not even a
// stable identity.
function demote(bindings: ModuleBindingIR[], binding: ModuleBindingID): void {
  const category = bindings[binding]!.category
  switch (category.kind) {
    case 'value': {
      bindings[binding]!.category = {kind: 'kind', declaredKind: category.declaredKind}
      break
    }
    case 'identity': {
      bindings[binding]!.category = {kind: 'opaque'}
      break
    }
    case 'kind':
    case 'import':
    case 'opaque':
      break
  }
}
