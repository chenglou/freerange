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
import {declaredKindOf, nodeSpan, type DeclaredKind, type FunctionIR, type FunctionLowering, type SourceSpan} from '../ir/program.ts'
import {assertAccepted} from './accept.ts'
import {addSite, LoweringStop, sealBlocks, terminate, unsupported, type FunctionContext, type MutableBlock, type TopLevelFunction} from './context.ts'
import {lowerExpression, valueKind} from './expression.ts'
import {declaredKind, type ModuleScan} from './module.ts'

export type LoweredStyleSlot = {property: string; lowering: FunctionLowering; site: number}

export function lowerStyleSlots(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
): LoweredStyleSlot[] {
  const slots: LoweredStyleSlot[] = []
  const reassigned = reassignedSymbols(sourceFile, checker)
  const slotName = (property: string | null, node: ts.Node): string => {
    const {line, character} = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${property == null ? 'style' : `style.${property}`} at ${line + 1}:${character + 1}`
  }
  const recordSkip = (property: string | null, node: ts.Node, reason: LoweringStop['reason']): void => {
    sites.push(nodeSpan(sourceFile, node))
    slots.push({
      property: property ?? '(whole object)',
      lowering: {kind: 'unsupported', name: slotName(property, node), site: sites.length - 1, reason},
      site: sites.length - 1,
    })
  }
  const lowerSlot = (property: string, expression: ts.Expression): void => {
    sites.push(nodeSpan(sourceFile, expression))
    const site = sites.length - 1
    // Two attempts, both discarded wholesale on a stop, like lowerSource's per-function
    // catch. The first follows const chains; an inlined initializer can still hit a
    // construct the vetting walk let through (e.g. a ternary whose condition is a bare
    // number), and without the retry that stop would demote a slot the plain treatment
    // analyzes fine — the gallery run lost six NaN findings to exactly that.
    for (const followConsts of [true, false]) {
      try {
        slots.push({
          property,
          lowering: lowerSlotFunction(slotName(property, expression), expression, sourceFile, checker, functionsBySymbol, scan, sites, reassigned, followConsts),
          site,
        })
        return
      } catch (error) {
        if (!(error instanceof LoweringStop)) throw error
        if (followConsts) continue
        sites.push(nodeSpan(sourceFile, error.node))
        slots.push({property, lowering: {kind: 'unsupported', name: slotName(property, expression), site: sites.length - 1, reason: error.reason}, site})
      }
    }
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
  reassigned: Set<ts.Symbol>,
  followConsts: boolean,
): FunctionIR {
  assertAccepted(expression)
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
  const dependencies = collectSlotDependencies(expression, sourceFile, checker, scan, functionsBySymbol, reassigned, followConsts)
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
  for (const [symbol, use] of dependencies.parameters) slotParameter(symbol, use)
  // The inlined consts lower first, oldest declaration first, so a later initializer that
  // reads an earlier const finds it already bound (a const can only reference consts
  // declared above it).
  for (const {symbol, initializer} of dependencies.prelude) {
    context.bindings.set(symbol, lowerExpression(initializer, context))
  }
  // Sever the two regions. The const lines and the style line are two observation moments
  // of the same mutable inputs — body statements the pass never reads run in between — so
  // every input the style expression itself mentions gets a second, fresh instance here.
  // The consts' RESULTS still flow (a value held in a binding is genuinely the old value),
  // but nothing LEARNED about the prelude's reads can transfer to the style line's own
  // reads: a review round produced three false claims through exactly that transfer — a
  // comparison on a cached property narrowing the record the style line re-reads, a module
  // let narrowed across an elided reset() call, and a stale length guard discharging the
  // style line's asserted element read. Both instances carry the same declared-kind
  // assumptions, and the printed assumes dedupe by text.
  if (dependencies.prelude.length > 0) {
    const reseeded = new Set<ts.Symbol>()
    for (const {symbol, node} of valueUseIdentifiers(expression, sourceFile, checker)) {
      if (!dependencies.parameters.has(symbol) || reseeded.has(symbol)) continue
      reseeded.add(symbol)
      slotParameter(symbol, node)
    }
  }
  const value = lowerExpression(expression, context)
  terminate(context.currentBlock, {kind: 'return', value, site: addSite(context, expression)})
  return {kind: 'lowered', name, parameters: context.parameters, returnPropertyNames: null, entry: 0, blocks: sealBlocks(context.blocks, name)}
}

type SlotDependencies = {
  // Variables that stay inputs of the synthetic function, classified by declared type.
  parameters: Map<ts.Symbol, ts.Identifier>
  // Body-local consts whose initializers are lowered into the synthetic function instead,
  // sorted by declaration position.
  prelude: Array<{symbol: ts.Symbol; initializer: ts.Expression}>
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
// Two hazards make the walk refuse to inline for the whole slot, reverting it to the
// plain parameter treatment (one read per region, no cross-moment transfer). First, a
// leaf variable that some statement may write (`let scale = 2; ... scale = 0`, or any of
// the mutation forms reassignedSymbols marks): the const captured the value at its own
// line, the slot reads the value now, and modeling both reads as one parameter would
// treat two possibly different values as equal — the analysis could then claim that
// `width - width` is exactly 0 when the two reads straddled a write. Second, a module
// binding that holds a record or array, even one nothing ever writes: the binding is
// shared state the fresh-instance severing cannot copy, and its contents can change
// through aliases no scan closes. Separately from these whole-slot refusals, a const
// whose own value is not a primitive never inlines (see the vetting below) — that rule
// is per-const, not a poison.
function collectSlotDependencies(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  scan: ModuleScan,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  reassigned: Set<ts.Symbol>,
  followConsts: boolean,
): SlotDependencies {
  const collect = (allowInlining: boolean): SlotDependencies & {followingPoisoned: boolean} => {
    const parameters = new Map<ts.Symbol, ts.Identifier>()
    const inlined = new Map<ts.Symbol, {initializer: ts.Expression; position: number}>()
    let followingPoisoned = false
    const pending = valueUseIdentifiers(expression, sourceFile, checker)
    while (pending.length > 0) {
      const {symbol, node} = pending.pop()!
      if (parameters.has(symbol) || inlined.has(symbol)) continue
      const moduleBinding = scan.bindingsBySymbol.get(symbol)
      if (moduleBinding != null || functionsBySymbol.has(symbol)) {
        // Module bindings are shared state the severing cannot copy: a read relocated
        // into the synthetic function sidesteps the module channel's version stamps (no
        // call inside the synthetic function ever advances them), so a fact learned from
        // a const-line read could discharge an obligation on the style line's own read.
        // Two cases poison the following outright: a binding some code writes (a module
        // `let` assigned anywhere), and a binding holding a record or array — the binding
        // itself never changes, but its CONTENTS can, through aliases no write scan
        // closes (a review round popped a module record's array inside a body-called
        // function and a stale length guard discharged the style line's asserted read).
        // Primitive never-written module constants stay free: genuinely immutable, so a
        // fact about them is true at both observation moments.
        if (moduleBinding != null && (reassigned.has(symbol) || !primitiveDeclaredKind(declaredKindOf(scan.bindings[moduleBinding]!.category)))) {
          followingPoisoned = true
        }
        continue
      }
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (declaration == null) continue
      // Imports and lib globals: their declarations live in other files.
      if (declaration.getSourceFile() !== sourceFile) continue
      // The write check comes BEFORE the inlining attempt: a const object whose property
      // the body writes (`const sizeRef = {current: {w: 4}}; ... sizeRef.current.w = 9`)
      // must not inline either — the inlined literal would carry the stale 4 as an exact
      // value while the style line reads the 9.
      if (reassigned.has(symbol)) {
        followingPoisoned = true
        parameters.set(symbol, node)
        continue
      }
      // Only a primitive-valued const may inline. A const holding an object or array —
      // even via a bare alias like `const stale = props.sizes` — would hand the style
      // line the instance observed at the const's line, defeating the fresh-instance
      // severing: facts tied to that instance (a valid-index relation, a narrowing)
      // would connect the two observation moments again.
      const primitiveConst = primitiveType(checker.getTypeAtLocation(declaration))
      const initializer = allowInlining && primitiveConst && inlined.size < inlinedConstCap ? inlinableConstInitializer(declaration) : null
      if (initializer != null) {
        inlined.set(symbol, {initializer, position: declaration.pos})
        pending.push(...valueUseIdentifiers(initializer, sourceFile, checker))
        continue
      }
      parameters.set(symbol, node)
    }
    const prelude = [...inlined.entries()]
      .sort((a, b) => a[1].position - b[1].position)
      .map(([symbol, entry]) => ({symbol, initializer: entry.initializer}))
    return {parameters, prelude, followingPoisoned}
  }
  const first = collect(followConsts)
  if (first.followingPoisoned && first.prelude.length > 0) return collect(false)
  return first
}

// A number, boolean, or string: a value, not a container — it cannot be mutated through
// an alias, so carrying it across the two observation moments is sound.
function primitiveType(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike)) !== 0
}

function primitiveDeclaredKind(declared: DeclaredKind | null): boolean {
  return declared != null && (declared.kind === 'number' || declared.kind === 'boolean' || declared.kind === 'opaque')
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
// Object and array literals are deliberately NOT inlinable. A literal carries exact
// contents (`const sizeRef = {current: {w: 4}}` knows w is 4), and exact contents can go
// stale through an alias the write scan cannot see — `const alias = sizeRef;
// alias.current.w = 0` marks alias, never sizeRef, and no syntactic scan closes aliasing
// in general (a review round produced four distinct evasions: alias binding, destructured
// alias, for-of loop variable, mutated array elements). Primitives cannot alias, so a
// followed chain may carry exactness only through primitive bindings. Property and
// element reads that root at a PARAMETER stay inlinable because their result is the
// declared-kind range, not an exact value — a range that covers the value before and
// after any type-preserving mutation, so staleness cannot falsify it.
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

// Every variable some code may write between a const's line and the style line. Direct
// writes: `x = 5`, `x += 1`, `x++`. Property writes count against the variable at the
// base of the path — `sizeRef.current.w = 5` marks sizeRef — because a const computed
// from sizeRef before that line and a style value reading sizeRef after it would
// otherwise be treated as seeing the same numbers. Mutation without assignment syntax
// counts too: a method call may mutate its receiver (`items.push(job)` marks items;
// Math is exempt), and a call may mutate an object handed to it
// (`Object.assign(sizeRef.current, patch)` — any argument whose type is not a plain
// number, boolean, or string marks its base variable). Built once per file; closures are
// covered because the walk descends into every function body. A const chain that leans
// on a marked variable is not inlined — see collectSlotDependencies.
function reassignedSymbols(sourceFile: ts.SourceFile, checker: ts.TypeChecker): Set<ts.Symbol> {
  const written = new Set<ts.Symbol>()
  const record = (node: ts.Node): void => {
    let target = node
    while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) || ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target)) {
      target = target.expression
    }
    if (!ts.isIdentifier(target)) return
    const symbol = checker.getSymbolAtLocation(target)
    if (symbol != null) written.add(symbol)
  }
  const primitiveArgument = (argument: ts.Expression): boolean => {
    const flags = checker.getTypeAtLocation(argument).flags
    return (flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike
      | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0
  }
  // An assignment target can be a destructuring pattern — `[obj.x] = arr`,
  // `({y: obj.z} = src)` — which parses as an array or object literal in assignment
  // position; every leaf target inside gets recorded.
  const recordTarget = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) recordTarget(ts.isSpreadElement(element) ? element.expression : element)
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const member of node.properties) {
        if (ts.isPropertyAssignment(member)) recordTarget(member.initializer)
        else if (ts.isShorthandPropertyAssignment(member)) recordTarget(member.name)
        else if (ts.isSpreadAssignment(member)) recordTarget(member.expression)
      }
      return
    }
    record(node)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      recordTarget(node.left)
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      record(node.operand)
    }
    if (ts.isDeleteExpression(node)) record(node.expression)
    // `for (existing of items)` and `for (existing in obj)` assign the pre-declared
    // variable each iteration without any `=` token.
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      recordTarget(node.initializer)
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const receiverIsMath = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Math'
      if (ts.isPropertyAccessExpression(node.expression) && !receiverIsMath) record(node.expression.expression)
      if (!receiverIsMath) {
        for (const argument of node.arguments ?? []) {
          if (!primitiveArgument(argument)) record(argument)
        }
      }
    }
    // A tagged template is a call in disguise: the tag function receives the interpolated
    // values and may mutate any object among them.
    if (ts.isTaggedTemplateExpression(node)) {
      record(node.tag)
      if (ts.isTemplateExpression(node.template)) {
        for (const span of node.template.templateSpans) {
          if (!primitiveArgument(span.expression)) record(span.expression)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return written
}
