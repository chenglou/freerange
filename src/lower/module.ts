import * as ts from 'typescript'
import type {ModuleBindingID} from '../ir/ids.ts'
import {
  declaredKindOf,
  moduleInitializerName,
  type DeclaredKind,
  type FunctionIR,
  type InitializerSkip,
  type ModuleBindingCategory,
  type ModuleBindingIR,
  type SourceSpan,
} from '../ir/program.ts'
import {assertAccepted} from './accept.ts'
import {addInstruction, addSite, LoweringStop, restoreLowering, sealBlocks, snapshotLowering, terminate, type FunctionContext, type MutableBlock, type TopLevelFunction} from './context.ts'
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
      // the statement itself is skipped when the initializer reaches it, and functions
      // reading the name are rejected as unknown identifiers.
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
function moduleWritesIn(
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

// Lowers the module's top-level runtime code into one synthetic function. A statement that
// cannot lower is skipped — rolled back, recorded as an InitializerSkip, its possible
// writes demoted and havocked — and lowering continues, so the initializer covers the
// whole file and ends with a plain return.
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
  // Each statement gets its own catch: an unsupported one is skipped — its half-lowered
  // instructions and blocks rolled back — every binding it could write is demoted, and the
  // slots are havocked so later statements compute from covering values (owner-locked
  // whole-file publish). Soundness of continuing past a skip: if the skipped statement
  // throws or never returns at runtime, the module never finishes loading, so no exported
  // function can be called and every claim about them is vacuously true.
  for (const statement of statements) {
    if (skippedAtTopLevel(statement)) continue
    const recovery = snapshotLowering(context)
    try {
      assertAccepted(statement, checker)
      if (ts.isVariableStatement(statement)) {
        lowerTopLevelDeclarations(statement, context, scan)
        continue
      }
      lowerStatement(statement, context)
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      restoreLowering(context, recovery)
      skips.push({site: addSite(context, error.node), reason: error.reason})
      // Demote what the statement writes directly, then reset the slots of everything the
      // statement could have written — its own targets plus, since it may call any
      // function, every binding functions write. Without the reset, a later analyzed
      // statement would compute from the stale pre-skip value and publish the result
      // through a fresh binding that nothing demotes. Record bindings are additionally ALL
      // havocked: a skipped statement can mutate a record without any write-position
      // mention of its binding — `Object.assign(config, overrides)` holds the binding in
      // argument position, and an alias variant mentions it nowhere — so no mention scan
      // is sound for records. Scalars are copied on read; only a write-position form can
      // change one, and those are collected above.
      const havocked = new Set(scan.writtenInsideFunctions)
      for (const written of allModuleWritesIn(statement, checker, scan.bindingsBySymbol)) {
        demote(scan.bindings, written)
        havocked.add(written)
      }
      for (let binding = 0; binding < scan.bindings.length; binding++) {
        const declared = declaredKindOf(scan.bindings[binding]!.category)
        if (declared?.kind === 'record') havocked.add(binding)
      }
      for (const binding of havocked) {
        addInstruction(context, statement, {kind: 'moduleHavoc', binding})
      }
    }
  }
  if (context.currentBlock.terminator == null) {
    terminate(context.currentBlock, {kind: 'return', value: null, site: addSite(context, sourceFile)})
  }
  return {
    initializer: {
      kind: 'lowered',
      name: moduleInitializerName,
      parameters: [],
      entry: 0,
      blocks: sealBlocks(context.blocks, moduleInitializerName),
    },
    skips,
  }
}

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
  const declared = declaredKind(checker.getTypeAtLocation(name), name, checker, [])
  return declared == null ? {kind: 'opaque'} : {kind: 'value', declaredKind: declared}
}

// The declared kind of one type, or null when the type is not representable — which makes
// the binding opaque. Record shapes must be fully representable: every property required
// and itself of a representable kind, so `let cursor = {x: 0, y: 0}` qualifies while
// `let events = {keydown: KeyboardEvent | null}` does not (the leaf fails), and neither do
// arrays, functions, or Date (their method properties fail the same leaf check). An empty
// property set is rejected too — it covers `{}` and index-signature-only types, neither of
// which a record value can say anything about.
function declaredKind(type: ts.Type, location: ts.Node, checker: ts.TypeChecker, seen: ts.Type[]): DeclaredKind | null {
  switch (valueKind(type, checker)) {
    case 'number': return {kind: 'number'}
    case 'boolean': return {kind: 'boolean'}
    case 'object': {
      // A recursive declared type (e.g. a linked list) would nest forever; the binding
      // stays opaque. The seen check catches direct recursion; the depth cap catches
      // recursive generics, whose every level is a fresh instantiation the seen check
      // cannot recognize (and whose instantiation chain would otherwise run away inside
      // the checker itself). No real state tree nests eight records deep.
      if (seen.length >= 8 || seen.includes(type)) return null
      const properties: Array<{name: string; declared: DeclaredKind}> = []
      for (const property of checker.getPropertiesOfType(type)) {
        if ((property.flags & ts.SymbolFlags.Optional) !== 0) return null
        const propertyDeclared = declaredKind(
          checker.getTypeOfSymbolAtLocation(property, location),
          location,
          checker,
          [...seen, type],
        )
        if (propertyDeclared == null) return null
        properties.push({name: property.name, declared: propertyDeclared})
      }
      if (properties.length === 0) return null
      return {kind: 'record', properties}
    }
    case null: return null
  }
}

// A binding with an unaccounted write cannot publish its value: it keeps only its declared
// kind — some finite number, some boolean, some record of the declared shape.
function demote(bindings: ModuleBindingIR[], binding: ModuleBindingID): void {
  const category = bindings[binding]!.category
  switch (category.kind) {
    case 'value': {
      bindings[binding]!.category = {kind: 'kind', declaredKind: category.declaredKind}
      break
    }
    case 'kind':
    case 'import':
    case 'opaque':
      break
  }
}
