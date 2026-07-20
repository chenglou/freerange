import * as ts from 'typescript'
import type {ModuleBindingID} from '../ir/ids.ts'
import {
  declaredKindOf,
  holdsMutableStructure,
  moduleInitializerName,
  type DeclaredKind,
  type DeclaredNumberInterval,
  type DeclaredVariant,
  type FunctionIR,
  type InitializerSkip,
  type ModuleBindingCategory,
  type ModuleBindingIR,
  type SourceSpan,
} from '../ir/program.ts'
import {assertAccepted} from './accept.ts'
import {numericLiteralValue} from './literals.ts'
import {declaredOnlyInDeclarationFiles} from './platform.ts'
import {addInstruction, addSite, createFunctionContext, LoweringStop, restoreLowering, sealBlocks, snapshotLowering, terminate, type FunctionContext, type TopLevelFunction} from './context.ts'
import {lowerExpression, nonMissingUnionMembers, tagLiteralValues, taggedUnionProperty, valueKind} from './expression.ts'
import {lowerStatement} from './statements.ts'

export type ModuleScan = {
  bindings: ModuleBindingIR[]
  bindingsBySymbol: Map<ts.Symbol, ModuleBindingID>
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
        if (ts.isIdentifier(declarator.name)) {
          register(declarator.name, declaredCategory(declarator.name, checker))
          continue
        }
        // `const {cols} = gridSize` at the top level: each destructured name is its own
        // module binding, categorized by its element type like any declarator.
        if (ts.isObjectBindingPattern(declarator.name)) {
          for (const element of declarator.name.elements) {
            if (ts.isIdentifier(element.name)) register(element.name, declaredCategory(element.name, checker))
          }
        }
      }
      continue
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause == null || clause.isTypeOnly) continue
      if (clause.name != null) register(clause.name, importedCategory(clause.name, checker))
      const named = clause.namedBindings
      if (named != null && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (!element.isTypeOnly) register(element.name, importedCategory(element.name, checker))
        }
      }
      // A namespace import reads as property accesses on the namespace object; no single
      // constant value describes the binding, so it stays a plain import.
      if (named != null && ts.isNamespaceImport(named)) register(named.name, {kind: 'import'})
    }
  }

  // Demote bindings that functions write.
  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (insideFunction) demoteModuleWritesInNode(node, checker, bindingsBySymbol, bindings)
    const enteringFunction = insideFunction || ts.isFunctionLike(node)
    ts.forEachChild(node, child => { visit(child, enteringFunction) })
  }
  visit(sourceFile, false)
  return {bindings, bindingsBySymbol}
}

// The category of one imported name. A named or default import whose target resolves to a
// const declarator with a plain numeric-literal initializer in a project .ts file, e.g.
// `export const INPUT_ROW_HEIGHT = 54` in a neighboring file, carries that exact value
// into this file. Everything else — `let` exports, computed initializers, .d.ts
// declarations, unresolved modules — stays a plain import whose reads stop.
//
// Soundness of trusting the literal WITHOUT analyzing the exporting module:
//   - No rebinding. Assigning to a const throws a TypeError at runtime (module code is
//     always strict), and a module binding is not a property of any reachable object, so
//     no other code can alias-write it either. The binding holds the literal for the
//     module's entire lifetime once initialized. (TypeScript separately flags writes to
//     imports in the analyzed file, and the whole-file type gate already rejects those.)
//   - No torn reads during module initialization. const bindings sit in the temporal dead
//     zone until their declaration runs, so in an import cycle a read that beats the
//     exporting declaration throws a ReferenceError rather than yielding undefined or a
//     stale value. A throw ends the path: the module never finishes loading, so every
//     claim about code past the read is vacuously true — the same argument the
//     initializer-skip note in lowerModuleInitializer makes.
//   - The exporting file's own analysis result (skipped statements, rejected functions,
//     demoted bindings) cannot matter: the initializer IS the literal, so nothing that
//     file computes feeds the value. An initializer beyond a literal (`export const
//     ROW_HEIGHT_TOTAL = INPUT_ROW_HEIGHT + 8`) would depend on that file's module
//     evaluation, which is exactly why the acceptance stops at literals.
// The remaining assumption, shared with the rest of the analyzer: the code runs under ES
// module semantics (or a transpilation that preserves const and live-binding behavior).
function importedCategory(name: ts.Identifier, checker: ts.TypeChecker): ModuleBindingCategory {
  const symbol = checker.getSymbolAtLocation(name)
  if (symbol == null || (symbol.flags & ts.SymbolFlags.Alias) === 0) return {kind: 'import'}
  const target = checker.getAliasedSymbol(symbol)
  const declaration = target.valueDeclaration
  if (declaration == null || !ts.isVariableDeclaration(declaration)) return {kind: 'import'}
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return {kind: 'import'}
  if (declaration.getSourceFile().isDeclarationFile) return {kind: 'import'}
  if (declaration.initializer == null) return {kind: 'import'}
  const value = numericLiteralValue(declaration.initializer)
  return value == null ? {kind: 'import'} : {kind: 'importedConstant', value}
}

// Demotes module bindings the given node itself writes (not its children's writes; the
// caller walks). Missing a write-position form would publish a stale value.
function demoteModuleWritesInNode(
  node: ts.Node,
  checker: ts.TypeChecker,
  bindingsBySymbol: Map<ts.Symbol, ModuleBindingID>,
  bindings: ModuleBindingIR[],
  written?: boolean[],
): void {
  const record = (binding: ModuleBindingID): void => {
    demote(bindings, binding)
    if (written != null) written[binding] = true
  }
  const target = (expression: ts.Expression): void => {
    // An assignment target can be a plain identifier or a destructuring pattern; every
    // identifier inside a pattern is conservatively a write.
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression)
      const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
      if (binding != null) record(binding)
      return
    }
    const visitPattern = (child: ts.Node): void => {
      // The shorthand `x` in `({x} = source)` resolves to the contextual type's PROPERTY
      // symbol via getSymbolAtLocation; the assigned variable needs the dedicated resolver.
      if (ts.isShorthandPropertyAssignment(child)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(child)
        const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
        if (binding != null) record(binding)
        ts.forEachChild(child, visitPattern)
        return
      }
      if (ts.isIdentifier(child)) {
        const symbol = checker.getSymbolAtLocation(child)
        const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
        if (binding != null) record(binding)
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
  const context = createFunctionContext(sourceFile, checker, functionsBySymbol, scan.bindingsBySymbol, sites)
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
      assertAccepted(statement)
      if (ts.isVariableStatement(statement)) {
        lowerTopLevelDeclarations(statement, context, scan)
        continue
      }
      lowerStatement(statement, context)
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      restoreLowering(context, recovery)
      lowerSupportedArgumentsOfSkippedTopLevelCall(statement, error, context)
      skips.push({site: addSite(context, error.node), reason: error.reason})
      // Demote what the statement writes directly, then reset every slot the statement
      // could have changed — its own scalar targets and, when it can execute unknown
      // code, scalars written by functions in this file. Without the reset, a later
      // analyzed statement would compute from the stale pre-skip value and publish the
      // result through a fresh binding that nothing demotes. Structural bindings (records,
      // tuples, arrays — nullish-wrapped included) are additionally ALL havocked: a
      // skipped statement can mutate one without any write-position mention of its
      // binding — `Object.assign(config, overrides)` holds the binding in argument
      // position, `scores.push(999)` in receiver position, and an alias variant mentions
      // it nowhere — so no mention scan is sound for them. Scalars are copied on read.
      // Reset one only when this statement writes it directly or can execute code that
      // reaches one of the file's known scalar writes.
      const effects = scanSkippedModuleEffects(
        statement,
        checker,
        scan.bindingsBySymbol,
        scan.bindings,
      )
      for (let binding = 0; binding < scan.bindings.length; binding++) {
        const category = scan.bindings[binding]!.category
        const declared = declaredKindOf(category)
        if (effects.directWrites[binding] === true
          || (category.kind === 'kind' && effects.invokesUnknownCode)
          || (declared != null && holdsMutableStructure(declared))) {
          addInstruction(context, statement, {kind: 'moduleHavoc', binding})
        }
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
      assertions: [],
      returnPropertyNames: null,
      parameters: [],
      entry: 0,
      blocks: sealBlocks(context.blocks, moduleInitializerName),
    },
    skips,
  }
}

function containsArrayLiteral(root: ts.Node): boolean {
  if (ts.isArrayLiteralExpression(root)) return true
  let found = false
  ts.forEachChild(root, child => {
    if (!found && containsArrayLiteral(child)) found = true
  })
  return found
}

// A function's body and parameter defaults run later. A computed object-method name runs
// while the surrounding object literal is built, so it remains part of the current walk.
function forEachImmediatelyEvaluatedChild(node: ts.Node, visit: (child: ts.Node) => void): void {
  if (ts.isFunctionLike(node)) {
    if (node.name != null && ts.isComputedPropertyName(node.name)) {
      visit(node.name.expression)
    }
    return
  }
  ts.forEachChild(node, visit)
}

// A direct top-level call evaluates its arguments before invoking the callee. When the
// outer call is unsupported, keep each fully lowered argument up to the first unsupported
// one. The outer call remains an initializer skip, and later arguments are not retained
// because the unsupported argument may throw before JavaScript reaches them.
function lowerSupportedArgumentsOfSkippedTopLevelCall(
  statement: ts.Statement,
  stop: LoweringStop,
  context: FunctionContext,
): void {
  if (!ts.isExpressionStatement(statement)) return
  let expression = statement.expression
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  if (!ts.isCallExpression(expression)
    || expression !== stop.node
    || expression.questionDotToken != null
    || !plainCallTarget(expression.expression)) return
  for (const argument of expression.arguments) {
    const recovery = snapshotLowering(context)
    try {
      lowerExpression(argument, context)
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      restoreLowering(context, recovery)
      return
    }
  }
}

function plainCallTarget(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return true
  if (ts.isParenthesizedExpression(expression)) return plainCallTarget(expression.expression)
  return ts.isPropertyAccessExpression(expression)
    && expression.questionDotToken == null
    && plainCallTarget(expression.expression)
}

function lowerTopLevelDeclarations(statement: ts.VariableStatement, context: FunctionContext, scan: ModuleScan): void {
  for (const declarator of statement.declarationList.declarations) {
    if (declarator.initializer == null) throw new LoweringStop(declarator, {kind: 'variableDeclarationShape'})
    // `const {cols} = gridSize`: one read of the source, one property read and module
    // write per name — the same lowering destructuring gets inside functions, aimed at
    // module slots.
    if (ts.isObjectBindingPattern(declarator.name)) {
      const source = lowerExpression(declarator.initializer, context)
      for (const element of declarator.name.elements) {
        if (!ts.isIdentifier(element.name) || element.dotDotDotToken != null || element.initializer != null) {
          throw new LoweringStop(element, {kind: 'variableDeclarationShape'})
        }
        const property = element.propertyName == null
          ? element.name.text
          : ts.isIdentifier(element.propertyName) ? element.propertyName.text : null
        if (property == null) throw new LoweringStop(element, {kind: 'variableDeclarationShape'})
        const elementType = context.checker.getTypeAtLocation(element.name)
        if (valueKind(elementType, context.checker) == null) {
          throw new LoweringStop(element, {kind: 'valueType', typeText: context.checker.typeToString(elementType)})
        }
        const symbol = context.checker.getSymbolAtLocation(element.name)
        const binding = symbol == null ? undefined : scan.bindingsBySymbol.get(symbol)
        if (binding == null) throw new LoweringStop(element, {kind: 'variableDeclarationShape'})
        const value = addInstruction(context, element, {kind: 'property', object: source, property})
        addInstruction(context, element, {kind: 'moduleWrite', binding, value})
      }
      continue
    }
    if (!ts.isIdentifier(declarator.name)) {
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
  // Only NAMED function declarations pass: those become program.functions entries, so
  // unsupported code inside them keeps the fully-analyzed publish gate honest. An
  // anonymous `export default function` has no name to collect under, so it falls through
  // to ordinary statement lowering, which records it as an initializer skip — otherwise
  // its body would be runtime code invisible to every gate.
  return (ts.isFunctionDeclaration(statement) && statement.name != null)
    || ts.isImportDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || ts.isInterfaceDeclaration(statement)
    || ts.isExportDeclaration(statement)
}

function scanSkippedModuleEffects(
  root: ts.Node,
  checker: ts.TypeChecker,
  bindingsBySymbol: Map<ts.Symbol, ModuleBindingID>,
  bindings: ModuleBindingIR[],
): {directWrites: boolean[]; invokesUnknownCode: boolean} {
  const directWrites: boolean[] = []
  let invokesUnknownCode = false
  const visit = (node: ts.Node): void => {
    demoteModuleWritesInNode(node, checker, bindingsBySymbol, bindings, directWrites)
    // Property reads and primitive operators are absent on purpose: the accepted object
    // model already excludes getters, Proxies, and custom coercion. `using` stays
    // conservative; Freerange does not model end-of-scope disposal.
    invokesUnknownCode ||= ts.isCallExpression(node)
      || ts.isNewExpression(node)
      || ts.isTaggedTemplateExpression(node)
      || ts.isAwaitExpression(node)
      || ts.isYieldExpression(node)
      || ts.isForOfStatement(node)
      || ts.isSpreadElement(node)
      || ts.isArrayBindingPattern(node)
      || (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0)
      || (ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
          || (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && containsArrayLiteral(node.left))))
      || ts.isJsxElement(node)
      || ts.isJsxSelfClosingElement(node)
      || ts.isJsxFragment(node)
      || ts.isClassDeclaration(node)
      || ts.isClassExpression(node)
    // A never-lowered declarator counts as a write to its own binding.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const symbol = checker.getSymbolAtLocation(node.name)
      const binding = symbol == null ? undefined : bindingsBySymbol.get(symbol)
      if (binding != null) {
        demote(bindings, binding)
        directWrites[binding] = true
      }
    }
    forEachImmediatelyEvaluatedChild(node, visit)
  }
  visit(root)
  return {directWrites, invokesUnknownCode}
}

function declaredCategory(name: ts.Identifier, checker: ts.TypeChecker): ModuleBindingCategory {
  const declared = declaredKind(checker.getTypeAtLocation(name), checker, [])
  return declared == null ? {kind: 'opaque'} : {kind: 'value', declaredKind: declared}
}

// The properties of one record type. A property whose type cannot be represented becomes
// opaque so the record can keep claims about its supported properties. An empty property
// set is rejected: `{}` and index-signature-only types have no named values to track.
function declaredRecordProperties(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: ts.Type[],
): Array<{name: string; declared: DeclaredKind}> | null {
  if (cutByAncestor(seen, type)) return null
  const properties: Array<{name: string; declared: DeclaredKind}> = []
  for (const property of checker.getPropertiesOfType(type)) {
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0
    const walked = declaredKind(
      checker.getTypeOfSymbol(property),
      checker,
      [...seen, type],
    )
    // A property the walk cannot classify — a recursive route, a mixed-literal union, a
    // DOM element — becomes an opaque leaf instead of vetoing the whole record: the value
    // is carried without claims, and a read that needs more than carrying is gated at the
    // read position (numeric use rejects at lowering; a modeled-kind read of the
    // unclassified value stops at the kind-mismatch backstop). The record's NUMERIC
    // contract survives its weird neighbors. Properties the project did not write —
    // inherited from a lib interface the project type extends — are boundary leaves for
    // the same reason whole lib types are: without this, `interface SizedElement extends
    // HTMLElement` floods the report with assumes lines about clientWidth and friends.
    const opaqueLeaf: DeclaredKind = {kind: 'opaque'}
    const propertyDeclared = declaredOnlyInDeclarationFiles(property) ? opaqueLeaf : (walked ?? opaqueLeaf)
    // `session?: boolean` reads as boolean | undefined, which is exactly what the missing-
    // value machinery models. The analysis deliberately represents absence and explicit
    // undefined alike: ordinary reads cannot distinguish them, and supported `in` checks
    // treat an optional as unknown presence. Object literals fill omitted optionals with
    // an explicit undefined value so joins keep the property.
    properties.push({
      name: property.name,
      declared: optional ? wrapOptional(propertyDeclared) : propertyDeclared,
    })
  }
  if (properties.length === 0) return null
  return properties
}

// The declared kind of an optional property: its type with the undefined sentinel added.
// An already-nullable type gains the sentinel (folded into 'both' when null was there);
// everything else wraps.
function wrapOptional(declared: DeclaredKind): DeclaredKind {
  if (declared.kind === 'nullish') {
    return {
      kind: 'nullish',
      inner: declared.inner,
      sentinels: declared.sentinels === 'null' || declared.sentinels === 'both' ? 'both' : 'undefined',
    }
  }
  return {kind: 'nullish', inner: declared, sentinels: 'undefined'}
}

// One union member as variants: its values for the union's tag property plus its record
// walk. A member whose tag is a single literal gives one variant; a tag written as a
// union of literals (`type: 'desktopCollapsedNav' | 'desktopExpandedNav'`, or a plain
// boolean — the checker's `true | false`) expands into one variant per literal, all
// sharing the member's record shape, so the check machinery only ever sees single-literal
// tags. The expansion is bounded by the literals the author wrote. The tag rides along
// inside each variant's record as an ordinary leaf; the union structure carries which
// value it is.
function declaredTaggedVariants(
  member: ts.Type,
  tagProperty: string,
  checker: ts.TypeChecker,
  seen: ts.Type[],
): DeclaredVariant[] | null {
  const tag = checker.getPropertyOfType(member, tagProperty)
  if (tag == null) return null
  const literals = tagLiteralValues(checker.getTypeOfSymbol(tag))
  if (literals == null) return null
  const properties = declaredRecordProperties(member, checker, seen)
  if (properties == null) return null
  return literals.map(tagValue => ({tagValue, properties}))
}

// The classification walk is pure over the type, and the checker interns types, so one
// walk per (type, remaining depth) suffices. The type graph is a DAG with heavy sharing,
// and the walk previously ran once per PATH — exponential in the depth cap; a profile
// caught 35 million property resolutions over ~216 distinct types in one file, all of
// lowering's residual cost. Cached nulls matter as much as hits: rejection walks repeat
// too.
//
// Two disciplines make a memoized answer bit-identical to the walk it replaces. Depth is
// part of the key, because the cap makes deep results budget-dependent. A nested result is
// stored only when its walk never cut against an IN-PROGRESS ancestor (seen.includes) —
// such a cut can make the result depend on which path reached it. A top-level walk starts
// with no ancestors, so its answer is context-free even when the walk later encounters a
// cycle and may always be stored. Depth-cap cuts are deterministic per depth too.
const declaredKindByDepth = new WeakMap<ts.Type, Array<DeclaredKind | null>>()
// Bumped at every in-progress-ancestor cut; a walk whose subtree bumped it is not stored.
let ancestorCuts = 0

function cutByAncestor(seen: ts.Type[], type: ts.Type): boolean {
  if (seen.length >= 8) return true
  if (seen.includes(type)) {
    ancestorCuts += 1
    return true
  }
  return false
}

export function declaredKind(type: ts.Type, checker: ts.TypeChecker, seen: ts.Type[]): DeclaredKind | null {
  const depth = seen.length
  let byDepth = declaredKindByDepth.get(type)
  if (byDepth == null) {
    byDepth = []
    declaredKindByDepth.set(type, byDepth)
  }
  const cached = byDepth[depth]
  if (cached !== undefined) return cached
  const cutsBefore = ancestorCuts
  const walked = declaredKindUncached(type, checker, seen)
  if (depth === 0 || ancestorCuts === cutsBefore) byDepth[depth] = walked
  return walked
}

function declaredKindUncached(type: ts.Type, checker: ts.TypeChecker, seen: ts.Type[]): DeclaredKind | null {
  switch (valueKind(type, checker)) {
    case 'number': {
      const interval = numericLiteralInterval(type)
      return interval === 'nonFinite' ? null : {kind: 'number', interval}
    }
    case 'boolean': return {kind: 'boolean'}
    // `number | null` and friends: the declared kind wraps the non-missing part, keeping
    // which sentinels the type admits for seeding and report prose.
    case 'nullable': {
      if (!type.isUnion()) return null
      const rest = nonMissingUnionMembers(type)
      if (rest.length === 0) return null
      // A nullable wrapper can hide the recursive edge from the exact-type ancestor
      // check. Cut before expanding the same record or tagged union again.
      if (rest.some(member => seen.includes(member))) {
        ancestorCuts += 1
        return null
      }
      let inner: DeclaredKind | null
      if (rest.length === 1) {
        inner = declaredKind(rest[0]!, checker, seen)
      } else {
        // `'compact' | 'wide' | undefined`, `4 | 8 | undefined`, `boolean | null` (the
        // checker splits boolean into true | false): several non-missing members are
        // fine when they collapse to one scalar kind, the same rule valueKind applies
        // to the bare union. Structural members keep the exactly-one rule — two record
        // shapes under a nullish wrapper are a tagged union, not a nullable record.
        const members = rest.map(member => declaredKind(member, checker, seen))
        inner = joinScalarDeclaredKinds(members)
        // `owner: null | LightboxOwnerRoute` where the inner is itself a union of tagged
        // shapes: the non-missing members classify as one tagged union, and maybeNullish
        // carries it like any other inner.
        const restTagProperty = inner == null ? taggedUnionProperty(rest, checker) : null
        if (restTagProperty != null) {
          const unionVariants: DeclaredVariant[] = []
          let allClassified = true
          for (const member of rest) {
            const variants = declaredTaggedVariants(member, restTagProperty, checker, seen)
            if (variants == null) {
              allClassified = false
              break
            }
            unionVariants.push(...variants)
          }
          const [firstVariant, ...restVariants] = unionVariants
          if (allClassified && firstVariant != null) {
            inner = {kind: 'taggedUnion', tagProperty: restTagProperty, variants: [firstVariant, ...restVariants]}
          }
        }
      }
      if (inner == null) return null
      const admitsNull = type.types.some(member => (member.flags & ts.TypeFlags.Null) !== 0)
      const admitsUndefined = type.types.some(member => (member.flags & ts.TypeFlags.Undefined) !== 0)
      return {kind: 'nullish', inner, sentinels: admitsNull && admitsUndefined ? 'both' : admitsNull ? 'null' : 'undefined'}
    }
    // Strings and other claim-free kinds are carried, not rejected: a record with an id
    // keeps its numeric contract.
    case 'opaque':
      return {kind: 'opaque'}
    case 'array': {
      const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
      if (element == null) return null
      const elementKind = declaredKind(element, checker, [...seen, type])
      return elementKind == null ? null : {kind: 'array', element: elementKind}
    }
    case 'tuple': {
      if (cutByAncestor(seen, type)) return null
      // The tuple target's elementFlags say what each written position is: required,
      // optional ([number, number?]), or a rest element ([number, ...number[]]). The type
      // ARGUMENTS alone cannot: an optional slot and a rest slot each contribute one
      // argument, so counting arguments read both examples as fixed pairs — the engine
      // seeded .length as exactly 2 and published 'return is a finite integer number
      // from 2 through 2' for a bare pair.length return, which the LEGAL cast-free
      // caller passing [5] falsifies with every printed assumes line holding. Only
      // all-required tuples keep the exact positional model; a tuple with any optional,
      // rest, or variadic position leaves the classified subset (owner decision: reject
      // rather than model an arity range — no measured corpus function uses the shapes,
      // and widening later is cheap).
      if (tupleHasOptionalOrRestPositions(type, checker)) return null
      const elements: DeclaredKind[] = []
      for (const elementType of checker.getTypeArguments(type as ts.TypeReference)) {
        const element = declaredKind(elementType, checker, [...seen, type])
        if (element == null) return null
        elements.push(element)
      }
      if (elements.length === 0) return null
      return {kind: 'tuple', elements}
    }
    case 'object': {
      // A record type the PROJECT did not write — HTMLDivElement, a library's config
      // interface, anything declared only in .d.ts files — is carried as an opaque leaf,
      // not contracted: walking a DOM interface would flood the report with hundreds of
      // assumes lines about properties nobody reads, and the project cannot uphold
      // contracts on shapes it does not own. (Math and friends never reach here — value
      // reads of them are gated elsewhere.)
      if (declaredOnlyInDeclarationFiles(type.getSymbol() ?? type.aliasSymbol)) return {kind: 'opaque'}
      // A recursive property becomes opaque. The ancestor check catches direct recursion;
      // the depth cap catches recursive generics, whose every level is a fresh
      // instantiation that exact type identity cannot recognize.
      const properties = declaredRecordProperties(type, checker, seen)
      return properties == null ? null : {kind: 'record', properties}
    }
    case 'taggedUnion': {
      if (!type.isUnion()) return null
      const tagProperty = taggedUnionProperty(type.types, checker)
      if (tagProperty == null) return null
      const variants: DeclaredVariant[] = []
      for (const member of type.types) {
        const memberVariants = declaredTaggedVariants(member, tagProperty, checker, seen)
        if (memberVariants == null) return null
        variants.push(...memberVariants)
      }
      const [firstVariant, ...restVariants] = variants
      if (firstVariant == null) return null
      return {kind: 'taggedUnion', tagProperty, variants: [firstVariant, ...restVariants]}
    }
    case null: return null
  }
}

function numericLiteralInterval(type: ts.Type): DeclaredNumberInterval | 'nonFinite' | null {
  const members = type.isUnion() ? type.types : [type]
  if (!members.every(member =>
    (member.flags & ts.TypeFlags.NumberLiteral) !== 0
    && (member.flags & ts.TypeFlags.EnumLiteral) === 0)) return null
  let lower = Infinity
  let upper = -Infinity
  let integer = true
  for (const member of members) {
    const value = (member as ts.NumberLiteralType).value
    if (!Number.isFinite(value)) return 'nonFinite'
    lower = Math.min(lower, value)
    upper = Math.max(upper, value)
    integer = integer && Number.isInteger(value)
  }
  return members.length === 0 ? null : {lower, upper, integer}
}

function joinScalarDeclaredKinds(members: Array<DeclaredKind | null>): DeclaredKind | null {
  const first = members[0]
  if (first == null) return null
  switch (first.kind) {
    case 'number': {
      let interval = first.interval
      for (let index = 1; index < members.length; index++) {
        const member = members[index]
        if (member?.kind !== 'number') return null
        if (interval == null || member.interval == null) {
          interval = null
        } else {
          interval = {
            lower: Math.min(interval.lower, member.interval.lower),
            upper: Math.max(interval.upper, member.interval.upper),
            integer: interval.integer && member.interval.integer,
          }
        }
      }
      return {kind: 'number', interval}
    }
    case 'boolean': return members.every(member => member?.kind === 'boolean') ? first : null
    case 'opaque': return members.every(member => member?.kind === 'opaque') ? first : null
    case 'record':
    case 'nullish':
    case 'tuple':
    case 'array':
    case 'taggedUnion': return null
  }
}

// Whether a tuple type has a position that is not plainly required: optional
// ([number, number?]), rest ([number, ...number[]]), or an unresolved generic spread
// (TypeScript's Variadic flag). Such a tuple's runtime length is a range rather than the
// written position count, so the declared-kind classification leaves the type out; the
// parameter rejection calls this to attach the rewrite hint to its message.
export function tupleHasOptionalOrRestPositions(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (!checker.isTupleType(type)) return false
  return (type as ts.TupleTypeReference).target.elementFlags.some(flags => (flags & ts.ElementFlags.Required) === 0)
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
    // A write to an import is a type error the whole-file gate rejects, so this arm should
    // be unreachable — but a demoted constant must never keep publishing its value, so it
    // falls back to a plain import whose reads stop.
    case 'importedConstant': {
      bindings[binding]!.category = {kind: 'import'}
      break
    }
    case 'kind':
    case 'import':
    case 'opaque':
      break
  }
}
