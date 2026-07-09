// The style-slot pass: every numeric value written into a JSX style attribute, e.g.
// `style={{width: computedWidth}}`, is a place where a bad number fails silently — React
// stringifies NaN and Infinity into invalid CSS that the browser drops without an error,
// so the element just loses that declaration. The pass finds each such slot and lowers the
// slot's expression as its own synthetic function: free variables that live in an enclosing
// function (component locals, props, hook results) become parameters classified by their
// declared type, exactly the treatment a real parameter gets, and the whole existing
// engine analyzes the result. The verdict on each slot is therefore conditional the same
// way a function report is — it holds when the assumed kinds hold — and a flagged slot
// reads as the requires line the extract-to-.ts rewrite would surface.
//
// The pass is syntactic and separate from function lowering: JSX itself never lowers, and
// nothing here feeds back into function or module analysis. Slots are appended to
// ProgramIR.functions after all declared functions (so call instructions inside a slot
// resolve same-file callees by their real FunctionIDs) and are listed in
// ProgramIR.styleSlots, which the report uses to keep them out of the ordinary entries.

import * as ts from 'typescript'
import {declaredKindOf, holdsMutableStructure, nodeSpan, type DeclaredKind, type FunctionIR, type FunctionLowering, type SourceSpan} from '../ir/program.ts'
import {assertAccepted} from './accept.ts'
import {addSite, createFunctionContext, LoweringStop, sealBlocks, terminate, unsupported, type TopLevelFunction} from './context.ts'
import {lowerExpression, valueKind} from './expression.ts'
import {declaredKind, type ModuleScan} from './module.ts'

export type LoweredStyleSlot = {
  property: string
  lowering: FunctionLowering
  fallback: FunctionLowering | null
  site: number
}

export function lowerStyleSlots(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
): LoweredStyleSlot[] {
  const slots: LoweredStyleSlot[] = []
  const slotName = (property: string | null, node: ts.Node): string => {
    const {line, character} = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${property == null ? 'style' : `style.${property}`} at ${line + 1}:${character + 1}`
  }
  const recordSkip = (property: string | null, node: ts.Node, reason: LoweringStop['reason']): void => {
    sites.push(nodeSpan(sourceFile, node))
    slots.push({
      property: property ?? '(whole object)',
      lowering: {kind: 'unsupported', name: slotName(property, node), site: sites.length - 1, reason},
      fallback: null,
      site: sites.length - 1,
    })
  }
  const lowerSlot = (property: string, expression: ts.Expression): void => {
    const name = slotName(property, expression)
    sites.push(nodeSpan(sourceFile, expression))
    const site = sites.length - 1
    const attempt = (followConsts: boolean): {lowering: FunctionLowering; followedConsts: boolean} => {
      const sitesBeforeAttempt = sites.length
      try {
        return lowerSlotFunction(name, expression, sourceFile, checker, functionsBySymbol, scan, sites, followConsts)
      } catch (error) {
        if (!(error instanceof LoweringStop)) throw error
        sites.length = sitesBeforeAttempt
        sites.push(nodeSpan(sourceFile, error.node))
        return {
          lowering: {kind: 'unsupported', name, site: sites.length - 1, reason: error.reason},
          followedConsts: false,
        }
      }
    }
    // Retain the plain-expression lowering whenever const following succeeded. The report
    // uses it only when the followed version reaches an analysis limitation, never when it
    // finds a real error such as an out-of-bounds read.
    const sitesBeforeFollowedAttempt = sites.length
    const followed = attempt(true)
    if (followed.lowering.kind === 'unsupported') {
      sites.length = sitesBeforeFollowedAttempt
      slots.push({property, lowering: attempt(false).lowering, fallback: null, site})
      return
    }
    const fallback = followed.followedConsts ? attempt(false).lowering : null
    slots.push({property, lowering: followed.lowering, fallback, site})
  }
  // A slot is checked when its value's type is a plain number or a number-when-present
  // union (`number | undefined`, the standard React conditional-style idiom — undefined
  // means the declaration is simply not applied, and the number arm carries the usual
  // hazards). The value's type is the trigger, not a property-name list, because a NaN
  // stringifies to invalid CSS on every property. String values are left alone except for
  // their template interpolations: in `width: `${percentage}%`` the interpolated number
  // carries the same silent failure.
  const numericWhenPresent = (type: ts.Type): boolean => {
    const kind = valueKind(type, checker)
    if (kind === 'number') return true
    if (kind !== 'nullable' || !type.isUnion()) return false
    const present = type.types.filter(member => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0)
    return present.length > 0 && present.every(member => valueKind(member, checker) === 'number')
  }
  const visitSlotValue = (property: string, value: ts.Expression): void => {
    if (ts.isTemplateExpression(value)) {
      for (const span of value.templateSpans) {
        // Templates stay plain-number only: an undefined interpolation renders the TEXT
        // "undefined" into the CSS — not the clean absent-declaration a direct undefined
        // value gets — so the when-present blessing would be wrong here.
        if (valueKind(checker.getTypeAtLocation(span.expression), checker) === 'number') lowerSlot(property, span.expression)
      }
      return
    }
    if (numericWhenPresent(checker.getTypeAtLocation(value))) lowerSlot(property, value)
  }
  const visitStyleAttribute = (attribute: ts.JsxAttribute): void => {
    const initializer = attribute.initializer
    if (initializer == null || !ts.isJsxExpression(initializer) || initializer.expression == null) return
    // Only a DOM tag (lowercase intrinsic name: div, span, canvas) renders its style
    // values as CSS. On a component, style is an ordinary prop — it usually reaches a DOM
    // tag eventually, but following it there is component-body analysis, deliberately not
    // taken on; the named skip keeps the census honest about how much rides on components.
    const tagName = attribute.parent.parent.tagName
    if (!ts.isIdentifier(tagName) || !/^[a-z]/.test(tagName.text)) {
      recordSkip(null, attribute, {kind: 'styleOnComponent'})
      return
    }
    const styleValue = initializer.expression
    // `style={precomputedStyle}` — the object is built elsewhere; nothing here names the
    // slots. Recorded so the coverage tally is honest about what the pass never saw.
    if (!ts.isObjectLiteralExpression(styleValue)) {
      recordSkip(null, styleValue, {kind: 'expressionForm', syntax: ts.SyntaxKind[styleValue.kind]})
      return
    }
    // A spread (or any other member form) can override the slots written after it at
    // runtime, so the whole object is skipped rather than checking slots that may not be
    // the effective values.
    // Validation happens for every member BEFORE any slot is produced: a dynamic key or a
    // spread anywhere in the object can override any sibling at runtime, so a whole-object
    // skip must not leave slots already emitted for earlier members (a review round caught
    // the skip firing only from the offending member onward).
    const members: Array<{name: string; value: ts.Expression}> = []
    for (const member of styleValue.properties) {
      if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
        recordSkip(null, member, {kind: 'expressionForm', syntax: ts.SyntaxKind[member.kind]})
        return
      }
      if (ts.isShorthandPropertyAssignment(member)) {
        members.push({name: member.name.text, value: member.name})
        continue
      }
      // A computed key whose text is statically known — the CSS-custom-property idiom
      // `['--loupe-image-left' as string]: offset` — is an ordinary named property.
      const keyText = literalKeyText(member.name)
      if (keyText == null) {
        recordSkip(null, member.name, {kind: 'computedPropertyName'})
        return
      }
      members.push({name: keyText, value: member.initializer})
    }
    for (const member of members) visitSlotValue(member.name, member.value)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'style') {
      visitStyleAttribute(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return slots
}

// The statically known text of a style property name: a plain identifier, a quoted
// string, or a computed key that peels (parens, as-casts, satisfies) to a string literal.
// Null means the key's text is only known at runtime.
function literalKeyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    let inner: ts.Expression = name.expression
    while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) {
      inner = inner.expression
    }
    if (ts.isStringLiteralLike(inner)) return inner.text
  }
  return null
}

function lowerSlotFunction(
  name: string,
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
  followConsts: boolean,
): {lowering: FunctionIR; followedConsts: boolean} {
  assertAccepted(expression)
  const context = createFunctionContext(sourceFile, checker, functionsBySymbol, scan.bindingsBySymbol, sites)
  const dependencies = collectSlotDependencies(expression, sourceFile, checker, scan, functionsBySymbol, followConsts)
  const slotParameter = (symbol: ts.Symbol, use: ts.Identifier): number => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? use
    const declared = declaredKind(checker.getTypeAtLocation(declaration), checker, [])
    if (declared == null) {
      throw unsupported(use, {kind: 'parameterType', typeText: checker.typeToString(checker.getTypeAtLocation(declaration))})
    }
    const value = context.nextValue++
    context.bindings.set(symbol, value)
    context.parameters.push({value, name: use.text, type: declared})
    return value
  }
  // An immutable const whose initializer is not followed is still one captured value, so it
  // is introduced once and shared by every source position that reads it.
  for (const [symbol, use] of dependencies.stableParameters) slotParameter(symbol, use)
  // Consecutive plain declarations use the same parameters for mutable inputs because no
  // code runs between them. After an intervening statement, the next group gets fresh
  // parameters. Earlier scalar const results remain bound: the stored number itself cannot
  // change even when the objects it was calculated from do.
  for (const {snapshotParameters, declarations} of dependencies.prelude) {
    for (const [parameter, use] of snapshotParameters) slotParameter(parameter, use)
    for (const {symbol, initializer} of declarations) {
      context.bindings.set(symbol, lowerExpression(initializer, context))
    }
  }
  for (const [symbol, use] of dependencies.resultParameters) slotParameter(symbol, use)
  const value = lowerExpression(expression, context)
  terminate(context.currentBlock, {kind: 'return', value, site: addSite(context, expression)})
  return {
    lowering: {kind: 'lowered', name, parameters: context.parameters, returnPropertyNames: null, entry: 0, blocks: sealBlocks(context.blocks, name)},
    followedConsts: dependencies.prelude.length > 0,
  }
}

type SlotDependencies = {
  // Immutable local consts whose definitions are not followed. Their exact calculation is
  // unknown, but the captured scalar value is stable across every later source position.
  stableParameters: Map<ts.Symbol, ts.Identifier>
  // Body-local consts whose initializers are lowered into the synthetic function instead,
  // grouped into consecutive runs and sorted by declaration position.
  prelude: Array<{
    snapshotParameters: Map<ts.Symbol, ts.Identifier>
    declarations: Array<{symbol: ts.Symbol; initializer: ts.Expression}>
  }>
  // Fresh mutable inputs read by the final style expression.
  resultParameters: Map<ts.Symbol, ts.Identifier>
}

// How many consts one slot may pull in. Layout math chains are short; a slot that needs
// more than this many is degenerate, and the cap only costs precision (the rest become
// assumed-by-type parameters), never a wrong claim.
const inlinedConstCap = 16

// What a slot expression depends on, walked transitively through body-local consts.
//
// A variable the slot mentions — a prop, a hook result, a component local — normally
// becomes a parameter of the synthetic function, taken at its declared type. But when the
// variable is a `const` whose initializer is itself analyzable math, e.g.
// `const naturalHeight = (width * job.height) / job.width`, parameter treatment would hide
// the division: the slot would see only "naturalHeight, a number". So such consts are
// inlined — their initializers lower into the synthetic function — and the walk continues
// into THEIR variables, until it bottoms out at variables that are not consts or not plain
// math. Those leaves become the parameters.
//
// Everything not collected here is deliberately left to the ordinary identifier
// resolution: module constants read exactly through the scan, same-file top-level
// functions resolve as callees, lib globals (Math, window, Infinity) have their own arms,
// and anything unresolvable rejects by name.
//
// Local inputs need no alias analysis. Consecutive plain declarations share one input
// snapshot; any intervening statement starts another, regardless of what the statement may
// mutate. A same-file or imported call therefore cannot carry stale facts forward. Shared
// module state still uses the module analysis: a written module binding or one holding a
// record/array makes the whole slot fall back to plain parameter treatment. Separately, a
// const whose own value is not a primitive never inlines (see the vetting below).
function collectSlotDependencies(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  scan: ModuleScan,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  followConsts: boolean,
): SlotDependencies {
  const collect = (allowInlining: boolean): SlotDependencies & {moduleReadPreventsFollowing: boolean} => {
    const inlined = new Map<ts.Symbol, {initializer: ts.Expression; position: number}>()
    const visited = new Set<ts.Symbol>()
    let moduleReadPreventsFollowing = false
    const pending = valueUseIdentifiers(expression, sourceFile, checker)
    while (pending.length > 0) {
      const {symbol} = pending.pop()!
      if (visited.has(symbol)) continue
      visited.add(symbol)
      const moduleBinding = scan.bindingsBySymbol.get(symbol)
      if (moduleBinding != null || functionsBySymbol.has(symbol)) {
        // Module reads do not become snapshot parameters. If a module binding or the value
        // inside it can change, lowering an earlier const and the style expression together
        // could incorrectly preserve a fact between them. A binding written inside a
        // function and any binding holding a record or array therefore prevent following.
        // An immutable scalar module value is safe wherever it is read.
        if (moduleBinding != null) {
          const category = scan.bindings[moduleBinding]!.category
          const immutableScalar = category.kind === 'importedConstant'
            || immutableDeclaredKind(declaredKindOf(category))
          if (scan.writtenInsideFunctions.has(moduleBinding) || !immutableScalar) {
            moduleReadPreventsFollowing = true
          }
        }
        continue
      }
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (declaration == null) continue
      // Imports and lib globals: their declarations live in other files.
      if (declaration.getSourceFile() !== sourceFile) continue
      // Only a primitive-valued const may inline. A const holding an object or array —
      // even via a bare alias like `const stale = props.sizes` — would carry one mutable
      // instance across declaration groups. A valid-index check or other fact from the
      // earlier group could then affect a later read of that same instance.
      const primitiveConst = primitiveType(checker.getTypeAtLocation(declaration))
      const initializer = allowInlining && primitiveConst && inlined.size < inlinedConstCap ? inlinableConstInitializer(declaration) : null
      if (initializer != null) {
        inlined.set(symbol, {initializer, position: declaration.pos})
        pending.push(...valueUseIdentifiers(initializer, sourceFile, checker))
      }
    }
    const stableParameters = new Map<ts.Symbol, ts.Identifier>()
    const collectSnapshotParameters = (root: ts.Expression, snapshot: Map<ts.Symbol, ts.Identifier>): void => {
      for (const {symbol, node} of valueUseIdentifiers(root, sourceFile, checker)) {
        if (inlined.has(symbol) || scan.bindingsBySymbol.has(symbol) || functionsBySymbol.has(symbol)) continue
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
        if (declaration == null || declaration.getSourceFile() !== sourceFile) continue
        if (stableScalarConst(declaration, checker)) stableParameters.set(symbol, node)
        else snapshot.set(symbol, node)
      }
    }
    const sortedPrelude = [...inlined.entries()]
      .sort((a, b) => a[1].position - b[1].position)
    const groups: Array<SlotDependencies['prelude'][number] & {key: ts.Node}> = []
    for (const [symbol, entry] of sortedPrelude) {
      const key = constDeclarationGroup(entry.initializer)
      let group = groups[groups.length - 1]
      if (group?.key !== key) {
        group = {key, snapshotParameters: new Map(), declarations: []}
        groups.push(group)
      }
      collectSnapshotParameters(entry.initializer, group.snapshotParameters)
      group.declarations.push({symbol, initializer: entry.initializer})
    }
    const prelude = groups.map(group => ({
      snapshotParameters: group.snapshotParameters,
      declarations: group.declarations,
    }))
    const resultParameters = new Map<ts.Symbol, ts.Identifier>()
    collectSnapshotParameters(expression, resultParameters)
    return {stableParameters, prelude, resultParameters, moduleReadPreventsFollowing}
  }
  const first = collect(followConsts)
  if (first.moduleReadPreventsFollowing && first.prelude.length > 0) return collect(false)
  return first
}

// A number, boolean, or string: a value, not a container — it cannot be mutated through
// an alias, so carrying it across intervening code is sound.
function primitiveType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(primitiveType)
  return (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike)) !== 0
}

function stableScalarConst(declaration: ts.Declaration, checker: ts.TypeChecker): boolean {
  if (!ts.isVariableDeclaration(declaration)
    || !ts.isIdentifier(declaration.name)
    || !ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return false
  return immutableDeclaredKind(declaredKind(checker.getTypeAtLocation(declaration), checker, []))
}

// Identifier-named variable declarations are evaluated consecutively, so their property
// reads see the same inputs under the analysis's ordinary record model. A call, assignment,
// branch, loop, return, destructuring declaration, or other intervening statement starts
// another group. The distinction is global: there is no attempt to decide which object the
// statement might mutate.
function constDeclarationGroup(initializer: ts.Expression): ts.Node {
  const declaration = initializer.parent
  if (!ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)) return initializer
  const statement = declaration.parent.parent
  if (!ts.isVariableStatement(statement)) return initializer
  const parent = statement.parent
  const statements = ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent)
    || ts.isCaseClause(parent) || ts.isDefaultClause(parent)
    ? parent.statements
    : null
  if (statements == null) return initializer
  const index = statements.indexOf(statement)
  if (index < 0 || !plainVariableStatement(statement)) return initializer
  let first = index
  while (first > 0 && plainVariableStatement(statements[first - 1]!)) first--
  return statements[first]!
}

function plainVariableStatement(statement: ts.Statement): boolean {
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.every(declaration =>
    ts.isIdentifier(declaration.name)
    && (declaration.initializer == null || expressionLowersPlainly(declaration.initializer)))
}

function immutableDeclaredKind(declared: DeclaredKind | null): boolean {
  return declared != null && !holdsMutableStructure(declared)
}

// A const the walk may inline: identifier-named (destructuring keeps parameter treatment),
// with an initializer built only from constructs known to lower without outside help.
function inlinableConstInitializer(declaration: ts.Declaration): ts.Expression | null {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null
  if (declaration.initializer == null) return null
  if (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return null
  return expressionLowersPlainly(declaration.initializer) ? declaration.initializer : null
}

// The constructs an initializer may contain and still be inlined: literals, arithmetic,
// comparisons, property and element reads, ternaries, Math calls. Anything else — other
// calls, arrows, casts, optional chains, assignments — keeps the const as an
// assumed-by-type parameter, exactly its treatment before inlining existed. A miss here
// costs precision, never a wrong claim.
//
// Object and array literals are deliberately NOT inlinable. Carrying one forward would
// preserve the same mutable instance across declaration groups, allowing a fact learned
// before an alias mutation to affect a later read. Scalar results cannot be mutated through
// aliases, so followed chains carry only those. Property and element reads remain
// inlinable because each declaration group receives a fresh input for the root object.
function expressionLowersPlainly(root: ts.Expression): boolean {
  let plain = true
  const visit = (node: ts.Node): void => {
    if (!plain || ts.isTypeNode(node)) return
    if (ts.isCallExpression(node)) {
      const mathCall = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Math'
      if (!mathCall || node.questionDotToken != null) {
        plain = false
        return
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (node.questionDotToken != null) {
        plain = false
        return
      }
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if ((operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment)
        || operator === ts.SyntaxKind.CommaToken) {
        plain = false
        return
      }
    } else if (ts.isPrefixUnaryExpression(node)) {
      if (node.operator !== ts.SyntaxKind.MinusToken && node.operator !== ts.SyntaxKind.ExclamationToken) {
        plain = false
        return
      }
    } else if (!(
      ts.isNumericLiteral(node) || ts.isStringLiteralLike(node)
      || ts.isTemplateExpression(node) || ts.isTemplateSpan(node)
      // Bare tokens appear as child nodes too — the `*` of a multiplication, the `?` and
      // `:` of a ternary. Operator acceptability is checked on the parent, so tokens pass.
      || ts.isToken(node)
      || ts.isIdentifier(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
      || ts.isConditionalExpression(node)
    )) {
      plain = false
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return plain
}

// The identifiers of `root` that are value reads: not the `b` of `a.b`, not literal
// property names, not names declared within `root` itself (an arrow parameter of a
// callback — bound locally, not a dependency).
function valueUseIdentifiers(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Array<{symbol: ts.Symbol; node: ts.Identifier}> {
  const found: Array<{symbol: ts.Symbol; node: ts.Identifier}> = []
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return
    if (ts.isIdentifier(node)) {
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return
      if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node)
      // No symbol: leave the identifier for lowering, which records its own missingSymbol.
      if (symbol == null) return
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (declaration != null && declaration.getSourceFile() === sourceFile
        && declaration.pos >= root.pos && declaration.end <= root.end) return
      found.push({symbol, node})
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}
