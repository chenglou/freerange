import * as ts from 'typescript'
import type {ModuleBindingID} from '../ir/ids.ts'
import {
  declaredKindOf,
  holdsMutableStructure,
  moduleInitializerName,
  type DeclaredKind,
  type DeclaredVariant,
  type FunctionIR,
  type InitializerSkip,
  type ModuleBindingCategory,
  type ModuleBindingIR,
  type SourceSpan,
} from '../ir/program.ts'
import {assertAccepted} from './accept.ts'
import {declaredOnlyInDeclarationFiles} from './platform.ts'
import {addInstruction, addSite, LoweringStop, restoreLowering, sealBlocks, snapshotLowering, terminate, type FunctionContext, type MutableBlock, type TopLevelFunction} from './context.ts'
import {lowerExpression, tagLiteralValues, taggedUnionProperty, valueKind} from './expression.ts'
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

// The exact value of a numeric-literal initializer, unwrapping parentheses and `as`
// assertions — both value-preserving, so `export const PILL_BUTTON = 40 as const`
// initializes to exactly 40. A leading minus on the literal is folded, e.g. `-1`.
// Anything else — arithmetic, identifier references, `Infinity` and `NaN` (identifiers,
// not literals) — returns null.
function numericLiteralValue(expression: ts.Expression): number | null {
  let unwrapped = expression
  while (ts.isParenthesizedExpression(unwrapped) || ts.isAsExpression(unwrapped)) unwrapped = unwrapped.expression
  if (ts.isNumericLiteral(unwrapped)) return Number(unwrapped.text)
  if (
    ts.isPrefixUnaryExpression(unwrapped)
    && unwrapped.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(unwrapped.operand)
  ) {
    return -Number(unwrapped.operand.text)
  }
  return null
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
      assertAccepted(statement)
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
      // through a fresh binding that nothing demotes. Structural bindings (records,
      // tuples, arrays — nullish-wrapped included) are additionally ALL havocked: a
      // skipped statement can mutate one without any write-position mention of its
      // binding — `Object.assign(config, overrides)` holds the binding in argument
      // position, `scores.push(999)` in receiver position, and an alias variant mentions
      // it nowhere — so no mention scan is sound for them. Scalars are copied on read;
      // only a write-position form can change one, and those are collected above.
      const havocked = new Set(scan.writtenInsideFunctions)
      for (const written of allModuleWritesIn(statement, checker, scan.bindingsBySymbol)) {
        demote(scan.bindings, written)
        havocked.add(written)
      }
      for (let binding = 0; binding < scan.bindings.length; binding++) {
        const declared = declaredKindOf(scan.bindings[binding]!.category)
        if (declared != null && holdsMutableStructure(declared)) havocked.add(binding)
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
      returnPropertyNames: null,
      parameters: [],
      entry: 0,
      blocks: sealBlocks(context.blocks, moduleInitializerName),
    },
    skips,
  }
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
function declaredRecordProperties(
  type: ts.Type,
  location: ts.Node,
  checker: ts.TypeChecker,
  seen: ts.Type[],
): Array<{name: string; declared: DeclaredKind}> | null {
  if (seen.length >= 8 || seen.includes(type)) return null
  const properties: Array<{name: string; declared: DeclaredKind}> = []
  for (const property of checker.getPropertiesOfType(type)) {
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0
    const walked = declaredKind(
      checker.getTypeOfSymbolAtLocation(property, location),
      location,
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
    // value machinery models; under exactOptionalPropertyTypes (which the analyzer forces)
    // a well-typed value's optional property is either absent or a T, never an explicit
    // undefined, so absent and the undefined sentinel provably coincide — the collapse is
    // sound even against future `in` checks (see current-decisions.md). Object literals
    // fill omitted optionals with an explicit undefined value, so joins keep the property.
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
  location: ts.Node,
  checker: ts.TypeChecker,
  seen: ts.Type[],
): DeclaredVariant[] | null {
  const tag = checker.getPropertyOfType(member, tagProperty)
  if (tag == null) return null
  const literals = tagLiteralValues(checker.getTypeOfSymbol(tag))
  if (literals == null) return null
  const properties = declaredRecordProperties(member, location, checker, seen)
  if (properties == null) return null
  return literals.map(tagValue => ({tagValue, properties}))
}

// The classification walk is pure over the type, and the checker interns types, so one
// walk per type identity suffices — without this, every function taking a ValidRoute-
// sized union re-walks its 17 variants through the checker's slow property queries. The
// location parameter does not affect the result for accepted types (instantiated
// generics are distinct type identities), so the cache keys on the type alone. Cached
// nulls matter as much as hits: rejection walks repeat too.
const declaredKindCache = new WeakMap<ts.Type, DeclaredKind | null>()

export function declaredKind(type: ts.Type, location: ts.Node, checker: ts.TypeChecker, seen: ts.Type[]): DeclaredKind | null {
  // Recursive walks (seen non-empty) must not poison the cache: a type reached inside a
  // cycle classifies null there, while the same type from the top may classify fine.
  if (seen.length === 0) {
    const cached = declaredKindCache.get(type)
    if (cached !== undefined) return cached
    const walked = declaredKindUncached(type, location, checker, seen)
    declaredKindCache.set(type, walked)
    return walked
  }
  return declaredKindUncached(type, location, checker, seen)
}

function declaredKindUncached(type: ts.Type, location: ts.Node, checker: ts.TypeChecker, seen: ts.Type[]): DeclaredKind | null {
  switch (valueKind(type, checker)) {
    case 'number': return {kind: 'number'}
    case 'boolean': return {kind: 'boolean'}
    // `number | null` and friends: the declared kind wraps the non-missing part, keeping
    // which sentinels the type admits for seeding and report prose.
    case 'nullable': {
      if (!type.isUnion()) return null
      const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
      const rest = type.types.filter(member => (member.flags & missingFlags) === 0)
      if (rest.length === 0) return null
      let inner: DeclaredKind | null
      if (rest.length === 1) {
        inner = declaredKind(rest[0]!, location, checker, seen)
      } else {
        // `'compact' | 'wide' | undefined`, `4 | 8 | undefined`, `boolean | null` (the
        // checker splits boolean into true | false): several non-missing members are
        // fine when they collapse to one scalar kind, the same rule valueKind applies
        // to the bare union. Structural members keep the exactly-one rule — two record
        // shapes under a nullish wrapper are a tagged union, not a nullable record.
        const members = rest.map(member => declaredKind(member, location, checker, seen))
        const first = members[0]
        inner = first != null
          && (first.kind === 'number' || first.kind === 'boolean' || first.kind === 'opaque')
          && members.every(member => member != null && member.kind === first.kind)
          ? first
          : null
        // `owner: null | LightboxOwnerRoute` where the inner is itself a union of tagged
        // shapes: the non-missing members classify as one tagged union, and maybeNullish
        // carries it like any other inner.
        const restTagProperty = inner == null ? taggedUnionProperty(rest, checker) : null
        if (restTagProperty != null) {
          const unionVariants: DeclaredVariant[] = []
          let allClassified = true
          for (const member of rest) {
            const variants = declaredTaggedVariants(member, restTagProperty, location, checker, seen)
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
      const elementKind = declaredKind(element, location, checker, [...seen, type])
      return elementKind == null ? null : {kind: 'array', element: elementKind}
    }
    case 'tuple': {
      if (seen.length >= 8 || seen.includes(type)) return null
      const elements: DeclaredKind[] = []
      for (const elementType of checker.getTypeArguments(type as ts.TypeReference)) {
        const element = declaredKind(elementType, location, checker, [...seen, type])
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
      // A recursive declared type (e.g. a linked list) would nest forever; the binding
      // stays opaque. The seen check catches direct recursion; the depth cap catches
      // recursive generics, whose every level is a fresh instantiation the seen check
      // cannot recognize (and whose instantiation chain would otherwise run away inside
      // the checker itself). No real state tree nests eight records deep.
      const properties = declaredRecordProperties(type, location, checker, seen)
      return properties == null ? null : {kind: 'record', properties}
    }
    case 'taggedUnion': {
      if (!type.isUnion()) return null
      const tagProperty = taggedUnionProperty(type.types, checker)
      if (tagProperty == null) return null
      const variants: DeclaredVariant[] = []
      for (const member of type.types) {
        const memberVariants = declaredTaggedVariants(member, tagProperty, location, checker, seen)
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
