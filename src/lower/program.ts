import * as ts from 'typescript'
import {moduleInitializerName, nodeSpan, type DeclaredKind, type FunctionIR, type FunctionLowering, type ProgramIR, type SourceSpan, type StyleSlotIR, type UnsupportedReason} from '../ir/program.ts'
import type {CheckedSource} from '../typescript/check.ts'
import {assertAccepted, evalMention, typeCheckSuppressionMention} from './accept.ts'
import {addSite, LoweringStop, requiredSymbol, sealBlocks, terminate, unsupported, type FunctionContext, type MutableBlock, type TopLevelFunction} from './context.ts'
import {valueKind} from './expression.ts'
import {declaredKind, lowerModuleInitializer, scanModuleBindings, type ModuleScan} from './module.ts'
import {lowerStatements} from './statements.ts'
import {lowerStyleSlots} from './style-slots.ts'

export function lowerSource(checked: CheckedSource, baseDirectory: string = process.cwd()): ProgramIR {
  const {sourceFile, checker} = checked
  const declarations: ts.FunctionDeclaration[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) declarations.push(statement)
  }
  // The two file-wide rejections. An eval string can rewrite bindings that every
  // function's report depends on, and a type-check suppression comment voids the checker's
  // word that every guarantee is built on — in both cases, no function in the file is
  // analyzed.
  const rejectFile = (span: SourceSpan, reason: UnsupportedReason): ProgramIR => ({
    file: sourceFile.fileName,
    baseDirectory,
    lineStarts: [...sourceFile.getLineStarts()],
    sites: [span],
    functions: declarations.map(declaration => ({
      kind: 'unsupported',
      name: declaration.name!.text,
      site: 0,
      reason,
    })),
    moduleBindings: [],
    initializer: {
      kind: 'lowered',
      name: moduleInitializerName,
      parameters: [],
      returnPropertyNames: null,
      entry: 0,
      blocks: [{loopHeader: null, parameters: [], instructions: [], terminator: {kind: 'stop', site: 0, reason}}],
    },
    initializerSkips: [],
    styleSlots: [],
  })
  const suppression = typeCheckSuppressionMention(sourceFile)
  if (suppression != null) return rejectFile(suppression, {kind: 'typeCheckSuppressed'})
  const evalNode = evalMention(sourceFile)
  if (evalNode != null) {
    return rejectFile(nodeSpan(sourceFile, evalNode), {kind: 'evalInFile'})
  }
  const functionsBySymbol = new Map<ts.Symbol, TopLevelFunction>()
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index]!
    // This loop runs outside the per-function catch below, so a missing symbol here is an
    // invariant crash, not a recorded reason: a declaration name that type-checked always
    // has a symbol.
    const symbol = checker.getSymbolAtLocation(declaration.name!)
    if (symbol == null) throw new Error(`Function declaration ${declaration.name!.text} has no TypeScript symbol`)
    functionsBySymbol.set(symbol, {id: index, declaration})
  }
  const scan = scanModuleBindings(sourceFile, checker)
  const sites: SourceSpan[] = []
  const functions: FunctionLowering[] = []
  for (const declaration of declarations) {
    // A failed function lowering discards the half-built FunctionContext wholesale; only
    // the name, the offending node's site, and the tagged reason survive.
    try {
      functions.push(lowerFunction(declaration, sourceFile, checker, functionsBySymbol, scan, sites))
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      sites.push(nodeSpan(sourceFile, error.node))
      functions.push({kind: 'unsupported', name: declaration.name!.text, site: sites.length - 1, reason: error.reason})
    }
  }
  const {initializer, skips} = lowerModuleInitializer(sourceFile, checker, functionsBySymbol, scan, sites)
  // Style slots come last so every declared function keeps its FunctionID; see StyleSlotIR.
  const styleSlots: StyleSlotIR[] = []
  if (sourceFile.fileName.endsWith('.tsx')) {
    for (const slot of lowerStyleSlots(sourceFile, checker, functionsBySymbol, scan, sites)) {
      functions.push(slot.lowering)
      const fn = functions.length - 1
      let fallbackFn: StyleSlotIR['fallbackFn'] = null
      if (slot.fallback != null) {
        functions.push(slot.fallback)
        fallbackFn = functions.length - 1
      }
      styleSlots.push({fn, fallbackFn, property: slot.property, site: slot.site})
    }
  }
  return {
    file: sourceFile.fileName,
    baseDirectory,
    lineStarts: [...sourceFile.getLineStarts()],
    sites,
    functions,
    moduleBindings: scan.bindings,
    initializer,
    initializerSkips: skips,
    styleSlots,
  }
}

function lowerFunction(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
): FunctionIR {
  if (declaration.body == null) throw unsupported(declaration, {kind: 'functionWithoutBody'})
  // An async body returns a Promise and a generator returns an iterator; lowering either
  // as if it ran synchronously would publish the body's values as the caller-visible
  // result. Rejected wholesale.
  if (declaration.asteriskToken != null || declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true) {
    throw unsupported(declaration, {kind: 'asyncOrGeneratorFunction'})
  }
  assertAccepted(declaration)
  const signature = checker.getSignatureFromDeclaration(declaration)
  // A type predicate (`shape is Circle`, `asserts x`) is the checker taking the author's
  // word: callers' narrowing then exposes properties the analysis cannot confirm the
  // value carries. Rejecting the declaring function stops every caller at the call.
  if (signature != null && checker.getTypePredicateOfSignature(signature) != null) {
    throw unsupported(declaration, {kind: 'typePredicate'})
  }
  const returnType = functionReturnType(declaration, checker)
  // `never` counts as returning nothing: the idiomatic annotation for an always-throwing
  // helper (`function fail(code: number): never`), whose paths all end in throw — the
  // always-throws analysis and the calleeAlwaysThrows caller stop handle the rest.
  const returnsVoid = (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0
  // Mixed return kinds (e.g. one branch returning a number and another a boolean) would
  // otherwise meet at the engine's return join instead of stopping here.
  if (!returnsVoid && valueKind(returnType, checker) == null) {
    throw unsupported(declaration.type ?? declaration, {kind: 'valueType', typeText: checker.typeToString(returnType)})
  }
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
  for (const parameter of declaration.parameters) {
    // `function area({width, height}: Size)` lowers as a synthetic record parameter plus
    // one property read per name — the same classification named parameters use, the
    // same reads body destructuring uses. Assumes lines name the parameter by its
    // pattern text ({width, height}.width is finite...). Defaults and rest inside the
    // pattern stay out, like the body form.
    if (ts.isObjectBindingPattern(parameter.name)) {
      const type = lowerParameterType(parameter, checker)
      // The pattern text becomes the parameter's report name; a pattern the author wrapped
      // across source lines would otherwise break the one-fact-per-line report format
      // (`assumes: {` and orphan fragments — a corpus census caught eight of these).
      const patternName = parameter.name.getText(sourceFile).replace(/\s+/g, ' ')
      if (parameter.initializer != null) {
        throw unsupported(parameter, {kind: 'parameterDefaultValue', name: patternName})
      }
      const value = context.nextValue++
      context.parameters.push({value, name: patternName, type})
      for (const element of parameter.name.elements) {
        if (!ts.isIdentifier(element.name) || element.dotDotDotToken != null || element.initializer != null) {
          throw unsupported(element, {kind: 'destructuredParameter'})
        }
        const property = element.propertyName == null
          ? element.name.text
          : ts.isIdentifier(element.propertyName) ? element.propertyName.text : null
        if (property == null) throw unsupported(element, {kind: 'destructuredParameter'})
        const read: MutableBlock['instructions'][number] = {
          kind: 'property',
          object: value,
          property,
          result: context.nextValue++,
          site: addSite(context, element),
        }
        entry.instructions.push(read)
        context.bindings.set(requiredSymbol(element.name, checker), read.result)
      }
      continue
    }
    if (!ts.isIdentifier(parameter.name)) throw unsupported(parameter.name, {kind: 'destructuredParameter'})
    // A rest parameter is one declaration for any number of arguments; the engine's
    // one-value-per-parameter seeding cannot represent that.
    if (parameter.dotDotDotToken != null) {
      throw unsupported(parameter, {kind: 'parameterType', typeText: `...${checker.typeToString(checker.getTypeAtLocation(parameter))}`})
    }
    const type = lowerParameterType(parameter, checker)
    // A default value applies whenever a caller omits the argument, and the analysis never
    // evaluates the initializer expression. A literal default that provably satisfies the
    // declared assumptions is safe to ignore: `zoom: number = 5` supplies a finite number,
    // exactly what the assumes line already states. Anything else — `= Infinity`,
    // `= readConfig()` — could falsify the seeding on the zero-argument call, so it
    // rejects. (Zero-argument calls within the file reject separately at the call site.)
    if (parameter.initializer != null && !defaultSatisfiesDeclaredAssumptions(parameter.initializer, type, checker)) {
      throw unsupported(parameter, {kind: 'parameterDefaultValue', name: parameter.name.text})
    }
    const value = context.nextValue++
    context.bindings.set(requiredSymbol(parameter.name, checker), value)
    context.parameters.push({value, name: parameter.name.text, type})
  }
  lowerStatements(declaration.body.statements, context)
  if (context.currentBlock.terminator == null) {
    if (!returnsVoid) {
      // A non-void path reaching the end without a return is a per-path STOP, not a
      // whole-function rejection: an exhaustive switch (or if-chain) over a tagged
      // union's variants makes the fall-out edge provably unreachable — the engine's tag
      // narrowing prunes it and the function analyzes clean, matching how TypeScript's
      // exhaustiveness accepts the same shape under noImplicitReturns. A genuinely
      // reachable fall-out reports as a stop with the returning paths' evidence kept.
      terminate(context.currentBlock, {kind: 'stop', site: addSite(context, declaration), reason: {kind: 'missingReturn'}})
    } else {
      terminate(context.currentBlock, {kind: 'return', value: null, site: addSite(context, declaration)})
    }
  }
  return {
    kind: 'lowered',
    name: declaration.name!.text,
    parameters: context.parameters,
    returnPropertyNames: declaredRecordReturnNames(returnType, checker),
    entry: 0,
    blocks: sealBlocks(context.blocks, declaration.name!.text),
  }
}

// The property names the declared return type exposes, for record returns — through a
// `| null` / `| undefined` wrapper too, since the record inside the wrapper is what
// callers read after their null check.
function declaredRecordReturnNames(returnType: ts.Type, checker: ts.TypeChecker): string[] | null {
  const kind = valueKind(returnType, checker)
  if (kind === 'object') return checker.getPropertiesOfType(returnType).map(property => property.name)
  if (kind === 'nullable' && returnType.isUnion()) {
    const missing = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    const rest = returnType.types.filter(member => (member.flags & missing) === 0)
    if (rest.length >= 1 && rest.every(member => valueKind(member, checker) === 'object')) {
      const names = new Set<string>()
      for (const member of rest) {
        for (const property of checker.getPropertiesOfType(member)) names.add(property.name)
      }
      return [...names]
    }
  }
  return null
}

function lowerParameterType(parameter: ts.ParameterDeclaration, checker: ts.TypeChecker): DeclaredKind {
  // The same recursive classification module bindings use: numbers, booleans, records
  // (opaque leaves included — an id: string property is carried, not rejected), nullable
  // wrappers, arrays, tuples, and bare opaque (a plain string parameter).
  const declared = declaredKind(checker.getTypeAtLocation(parameter), checker, [])
  if (declared == null) {
    throw unsupported(parameter, {kind: 'parameterType', typeText: checker.typeToString(checker.getTypeAtLocation(parameter))})
  }
  return declared
}

function defaultSatisfiesDeclaredAssumptions(initializer: ts.Expression, declared: DeclaredKind, checker: ts.TypeChecker): boolean {
  switch (declared.kind) {
    case 'number': {
      const literal = ts.isPrefixUnaryExpression(initializer) && initializer.operator === ts.SyntaxKind.MinusToken
        ? initializer.operand
        : initializer
      // Numeric literals cannot be NaN, but they can overflow to Infinity (`5e999`), and
      // numeric separators need stripping before Number can read the text.
      return ts.isNumericLiteral(literal) && Number.isFinite(Number(literal.text.replaceAll('_', '')))
    }
    case 'boolean':
      return initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword
    // Nothing is claimed about an opaque parameter, so any string default is fine — but
    // only a literal one: a call like `= readLabel()` could hide unvetted constructs.
    case 'opaque':
      return ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)
    case 'nullish': {
      // `deadline: number | null = null`: the null literal is one of the declared
      // sentinels, as provably inside the kind as `= 5` is for `number`. Any other
      // literal checks against the inner kind (`zoom: number | null = 5`). The
      // undefined check goes through the type's Undefined flag, not the identifier
      // text, because a shadowing binding named undefined would type differently.
      if (initializer.kind === ts.SyntaxKind.NullKeyword) {
        return declared.sentinels === 'null' || declared.sentinels === 'both'
      }
      if (ts.isIdentifier(initializer) && initializer.text === 'undefined'
        && (checker.getTypeAtLocation(initializer).flags & ts.TypeFlags.Undefined) !== 0) {
        return declared.sentinels === 'undefined' || declared.sentinels === 'both'
      }
      return defaultSatisfiesDeclaredAssumptions(initializer, declared.inner, checker)
    }
    case 'record':
    case 'tuple':
    case 'array':
    case 'taggedUnion':
      return false
  }
}

function functionReturnType(declaration: ts.FunctionDeclaration, checker: ts.TypeChecker): ts.Type {
  const signature = checker.getSignatureFromDeclaration(declaration)
  if (signature == null) throw unsupported(declaration, {kind: 'functionWithoutSignature'})
  return checker.getReturnTypeOfSignature(signature)
}
