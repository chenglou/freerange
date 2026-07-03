import * as ts from 'typescript'
import type {FunctionID, ModuleBindingID} from '../ir/ids.ts'
import type {
  BlockIR,
  FunctionIR,
  ModuleBindingCategory,
  ModuleBindingIR,
  SourceSpan,
} from '../ir/program.ts'
import {addInstruction, addSite, LoweringStop, terminate, type FunctionContext, type MutableBlock} from './context.ts'
import {lowerExpression, valueKind} from './expression.ts'
import {lowerStatement} from './statements.ts'

export type ModuleScan = {
  bindings: ModuleBindingIR[]
  bindingsBySymbol: Map<ts.Symbol, ModuleBindingID>
  // A direct eval call exists somewhere in the file. Besides poisoning bindings (below),
  // calls through top-level function bindings stop lowering: eval can reassign a function
  // binding at runtime, and TypeScript's static no-reassignment check cannot see into the
  // eval string.
  directEval: boolean
}

// Classifies every top-level binding by one rule: a function may trust the binding's value
// only when every possible write to it is accounted for. The scan reads the entire file's
// text — bodies of functions the analyzer rejects included — so a write hiding inside
// unsupported code still demotes the binding.
export function scanModuleBindings(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ModuleScan {
  const bindings: ModuleBindingIR[] = []
  const bindingsBySymbol = new Map<ts.Symbol, ModuleBindingID>()
  const constness: boolean[] = []
  const register = (name: ts.Identifier, category: ModuleBindingCategory, isConst: boolean): void => {
    const symbol = checker.getSymbolAtLocation(name)
    if (symbol == null) return
    bindingsBySymbol.set(symbol, bindings.length)
    bindings.push({name: name.text, category})
    constness.push(isConst)
  }

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      for (const declarator of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declarator.name)) continue
        register(declarator.name, declaredCategory(declarator.name, checker), isConst)
      }
      continue
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause == null || clause.isTypeOnly) continue
      if (clause.name != null) register(clause.name, {kind: 'import'}, true)
      const named = clause.namedBindings
      if (named != null && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (!element.isTypeOnly) register(element.name, {kind: 'import'}, true)
        }
      }
      if (named != null && ts.isNamespaceImport(named)) register(named.name, {kind: 'import'}, true)
    }
  }

  // Demote bindings that functions write. A direct eval call can assign any non-const
  // binding through a string no scanner reads, so its presence demotes every let binding;
  // const stays safe because assigning a const throws even inside eval.
  const writtenInsideFunctions = new Set<ModuleBindingID>()
  const directEval = containsDirectEval(sourceFile)
  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (insideFunction) {
      for (const written of moduleWritesIn(node, checker, bindingsBySymbol)) writtenInsideFunctions.add(written)
    }
    const enteringFunction = insideFunction || ts.isFunctionLike(node)
    ts.forEachChild(node, child => { visit(child, enteringFunction) })
  }
  visit(sourceFile, false)

  for (let binding = 0; binding < bindings.length; binding++) {
    // An eval string can assign a value of ANY type — the declared type constrains only
    // the writes the type checker can see — so eval-poisoned bindings become opaque, not
    // declared-kind. Ordinary function writes below are type-checked, so those keep the
    // declared kind.
    if (directEval && !constness[binding]!) {
      bindings[binding]!.category = {kind: 'opaque'}
      continue
    }
    if (writtenInsideFunctions.has(binding)) demote(bindings, binding, directEval)
  }
  return {bindings, bindingsBySymbol, directEval}
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
  functionsBySymbol: Map<ts.Symbol, FunctionID>,
  scan: ModuleScan,
  sites: SourceSpan[],
): FunctionIR {
  const entry: MutableBlock = {loopHeader: null, parameters: [], instructions: [], terminator: null}
  const context: FunctionContext = {
    sourceFile,
    checker,
    functionsBySymbol,
    moduleBindingsBySymbol: scan.bindingsBySymbol,
    directEval: scan.directEval,
    sites,
    nextValue: 0,
    currentBlock: entry,
    blocks: [entry],
    bindings: new Map(),
    parameters: [],
  }
  const statements = sourceFile.statements
  let index = 0
  // The file's second and last catch of LoweringStop: unlike a declared function, the
  // initializer keeps everything lowered so far — the binding values before the stop are
  // the product.
  try {
    for (; index < statements.length; index++) {
      const statement = statements[index]!
      if (skippedAtTopLevel(statement)) continue
      if (ts.isVariableStatement(statement)) {
        lowerTopLevelDeclarations(statement, context, scan)
        continue
      }
      lowerStatement(statement, context)
    }
    if (context.currentBlock.terminator == null) {
      terminate(context.currentBlock, {kind: 'return', value: null, site: addSite(context, sourceFile)})
    }
  } catch (error) {
    if (!(error instanceof LoweringStop)) throw error
    const site = addSite(context, error.node)
    for (const block of context.blocks) {
      if (block.terminator == null) terminate(block, {kind: 'stop', site, reason: error.reason})
    }
    for (; index < statements.length; index++) {
      const statement = statements[index]!
      for (const written of allModuleWritesIn(statement, checker, scan.bindingsBySymbol)) {
        demote(scan.bindings, written, scan.directEval)
      }
    }
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
  return {kind: 'lowered', name: 'module initialization', parameters: [], entry: 0, blocks}
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

function containsDirectEval(root: ts.Node): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isDirectEvalCallee(node.expression)) found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

// `(eval)(...)` is still direct eval — parentheses preserve the reference — and the
// TypeScript-only wrappers `eval!(...)`, `(eval as any)(...)`, `(eval satisfies Function)(...)`
// erase to direct eval in the emitted JavaScript. Truly indirect forms — `(0, eval)(...)`,
// an alias like `const run = eval`, tagged `` eval`...` `` — run in global scope and cannot
// reach module bindings, so missing them is correct, not a hole.
function isDirectEvalCallee(callee: ts.Expression): boolean {
  let current: ts.Expression = callee
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return ts.isIdentifier(current) && current.text === 'eval'
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
// stable identity. When a direct eval call exists, even the declared kind is untrustworthy —
// e.g. `const flag = pick()` in the never-lowered remainder, where eval may have reassigned
// `pick` to return anything before the const initialized — so the demotion goes all the way
// to opaque.
function demote(bindings: ModuleBindingIR[], binding: ModuleBindingID, directEval: boolean): void {
  const category = bindings[binding]!.category
  switch (category.kind) {
    case 'value': {
      bindings[binding]!.category = directEval
        ? {kind: 'opaque'}
        : {kind: 'kind', declaredKind: category.declaredKind}
      break
    }
    case 'identity': {
      bindings[binding]!.category = {kind: 'opaque'}
      break
    }
    case 'kind': {
      if (directEval) bindings[binding]!.category = {kind: 'opaque'}
      break
    }
    case 'import':
    case 'opaque':
      break
  }
}
