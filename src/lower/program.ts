import * as ts from 'typescript'
import {finiteInputPaths} from '../ir/finite-inputs.ts'
import {moduleInitializerName, nodeSpan, type DeclaredKind, type FunctionIR, type FunctionLowering, type ProgramIR, type SourceSpan, type UnsupportedReason} from '../ir/program.ts'
import type {CheckedSource} from '../typescript/check.ts'
import {assertAccepted, evalMention, typeCheckSuppressionMention} from './accept.ts'
import {addInstructionAtSite, addSite, createFunctionContext, LoweringStop, requiredSymbol, sealBlocks, terminate, unsupported, type MutableBlock, type TopLevelFunction} from './context.ts'
import {lowerExpression, valueKind} from './expression.ts'
import {callableSignature, topLevelFunctionUnits} from './function-unit.ts'
import {parameterDefaultFits, parameterDefaultLiteral, type ParameterDefaultLiteral} from './literals.ts'
import {declaredKind, lowerModuleInitializer, scanModuleBindings, tupleHasOptionalOrRestPositions, type ModuleScan} from './module.ts'
import {scanStaticAnnotations, type StaticAnnotation} from './static-intrinsics.ts'
import {lowerStatements} from './statements.ts'

export function lowerSource(checked: CheckedSource, baseDirectory: string = process.cwd()): ProgramIR {
  const {sourceFile, program} = checked
  const checker = program.getTypeChecker()
  const declarations = topLevelFunctionUnits(sourceFile)
  const staticScan = scanStaticAnnotations(sourceFile, declarations, checker)
  const recordStaticAnnotationIssues = (sites: SourceSpan[]): ProgramIR['staticAnnotationIssues'] =>
    staticScan.outsideTopLevelFunctions.map(call => {
      sites.push(nodeSpan(sourceFile, call))
      return {kind: 'outsideTopLevelFunction', site: sites.length - 1}
    })
  // The two file-wide rejections. An eval string can rewrite bindings that every
  // function's report depends on, and a type-check suppression comment voids the checker's
  // word that every guarantee is built on — in both cases, no function in the file is
  // analyzed.
  const rejectFile = (span: SourceSpan, reason: UnsupportedReason): ProgramIR => {
    const sites = [span]
    const staticAnnotationIssues = recordStaticAnnotationIssues(sites)
    return {
      file: sourceFile.fileName,
      baseDirectory,
      lineStarts: [...sourceFile.getLineStarts()],
      sites,
      functions: declarations.map((unit, index) => ({
        kind: 'unsupported',
        name: unit.name.text,
        hasStaticAnnotations: staticScan.functions[index]!.length > 0,
        site: 0,
        reason,
      })),
      staticAnnotationIssues,
      moduleBindings: [],
      initializer: {
        kind: 'lowered',
        name: moduleInitializerName,
        assertions: [],
        parameters: [],
        returnPropertyNames: null,
        entry: 0,
        blocks: [{loopHeader: null, parameters: [], instructions: [], terminator: {kind: 'stop', site: 0, reason}}],
      },
      initializerSkips: [],
    }
  }
  const suppression = typeCheckSuppressionMention(sourceFile)
  if (suppression != null) return rejectFile(suppression, {kind: 'typeCheckSuppressed'})
  const evalNode = evalMention(sourceFile)
  if (evalNode != null) {
    return rejectFile(nodeSpan(sourceFile, evalNode), {kind: 'evalInFile'})
  }
  const functionsBySymbol = new Map<ts.Symbol, TopLevelFunction>()
  const scan = scanModuleBindings(sourceFile, checker)
  const topLevelFunctions: TopLevelFunction[] = []
  for (let index = 0; index < declarations.length; index++) {
    const unit = declarations[index]!
    // This loop runs outside the per-function catch below, so a missing symbol here is an
    // invariant crash, not a recorded reason: a declaration name that type-checked always
    // has a symbol.
    const symbol = checker.getSymbolAtLocation(unit.name)
    if (symbol == null) throw new Error(`Function ${unit.name.text} has no TypeScript symbol`)
    const binding = scan.bindingsBySymbol.get(symbol)
    if (unit.initializer != null && binding == null) {
      throw new Error(`Const-bound function ${unit.name.text} has no module binding`)
    }
    const fn: TopLevelFunction = {
      ...unit,
      id: index,
      binding: unit.initializer == null ? null : binding!,
      signature: callableSignature(unit, checker),
    }
    topLevelFunctions.push(fn)
    functionsBySymbol.set(symbol, fn)
  }
  const sites: SourceSpan[] = []
  const staticAnnotationIssues = recordStaticAnnotationIssues(sites)
  const functions: FunctionLowering[] = []
  for (let index = 0; index < topLevelFunctions.length; index++) {
    const declaration = topLevelFunctions[index]!
    const staticAnnotations = staticScan.functions[index]!
    // A failed function lowering discards the half-built FunctionContext wholesale; only
    // the name, annotation presence, offending node's site, and tagged reason survive.
    try {
      functions.push(lowerFunction(declaration, staticAnnotations, sourceFile, checker, program, functionsBySymbol, scan, sites))
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      sites.push(nodeSpan(sourceFile, error.node))
      functions.push({
        kind: 'unsupported',
        name: declaration.name.text,
        hasStaticAnnotations: staticAnnotations.length > 0,
        site: sites.length - 1,
        reason: error.reason,
      })
    }
  }
  const {initializer, skips} = lowerModuleInitializer(sourceFile, checker, program, functionsBySymbol, scan, sites)
  return {
    file: sourceFile.fileName,
    baseDirectory,
    lineStarts: [...sourceFile.getLineStarts()],
    sites,
    functions,
    staticAnnotationIssues,
    moduleBindings: scan.bindings,
    initializer,
    initializerSkips: skips,
  }
}

function lowerFunction(
  unit: TopLevelFunction,
  staticAnnotations: StaticAnnotation[],
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  program: ts.Program,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
): FunctionIR {
  const {declaration} = unit
  for (const annotation of staticAnnotations) {
    if (annotation.kind === 'invalid') {
      throw unsupported(annotation.node, {kind: 'staticAssertionForm', problem: annotation.problem})
    }
  }
  if (declaration.body == null) throw unsupported(declaration, {kind: 'functionWithoutBody'})
  // An async body returns a Promise and a generator returns an iterator; lowering either
  // as if it ran synchronously would publish the body's values as the caller-visible
  // result. Rejected wholesale.
  if ((!ts.isArrowFunction(declaration) && declaration.asteriskToken != null)
    || declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true) {
    throw unsupported(declaration, {kind: 'asyncOrGeneratorFunction'})
  }
  assertAccepted(declaration)
  const signature = unit.signature
  if (signature == null) {
    throw unsupported(unit.name, {
      kind: unit.initializer == null ? 'functionWithoutSignature' : 'constFunctionSignature',
    })
  }
  const returnType = checker.getReturnTypeOfSignature(signature)
  // `never` counts as returning nothing: the idiomatic annotation for an always-throwing
  // helper (`function fail(code: number): never`), whose paths all end in throw — the
  // always-throws analysis and the calleeAlwaysThrows caller stop handle the rest.
  const returnsVoid = (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0
  // Mixed return kinds (e.g. one branch returning a number and another a boolean) would
  // otherwise meet at the engine's return join instead of stopping here.
  if (!returnsVoid && valueKind(returnType, checker) == null) {
    throw unsupported(declaration.type ?? declaration, {kind: 'valueType', typeText: checker.typeToString(returnType)})
  }
  const context = createFunctionContext(
    sourceFile,
    checker,
    program,
    functionsBySymbol,
    scan.bindingsBySymbol,
    sites,
    staticAnnotations,
    returnsVoid,
  )
  const entry = context.currentBlock
  for (let parameterIndex = 0; parameterIndex < declaration.parameters.length; parameterIndex++) {
    const parameter = declaration.parameters[parameterIndex]!
    const parameterType = unit.initializer == null
      ? checker.getTypeAtLocation(parameter)
      : checker.getTypeOfSymbolAtLocation(signature.parameters[parameterIndex]!, signature.declaration!)
    // `function area({width, height}: Size)` lowers as a synthetic record parameter plus
    // one property read per name — the same classification named parameters use, the
    // same reads body destructuring uses. The report metadata below keeps the local
    // names, so a condition says `width` rather than `{width, height}.width`. Defaults
    // and rest inside the pattern stay out, like the body form.
    if (ts.isObjectBindingPattern(parameter.name)) {
      const type = lowerParameterType(parameter, parameterType, checker)
      // The pattern text becomes the parameter's report name; a pattern the author wrapped
      // across source lines would otherwise break the one-fact-per-line report format
      // (`assumes: {` and orphan fragments — a corpus census caught eight of these).
      const patternName = parameter.name.getText(sourceFile).replace(/\s+/g, ' ')
      if (parameter.initializer != null) {
        throw unsupported(parameter, {kind: 'parameterDefaultValue', name: patternName})
      }
      const value = context.nextValue++
      const bindings: Array<{property: string; local: string}> = []
      context.parameters.push({value, name: patternName, type, site: addSite(context, parameter), bindings})
      for (const element of parameter.name.elements) {
        if (!ts.isIdentifier(element.name) || element.dotDotDotToken != null || element.initializer != null) {
          throw unsupported(element, {kind: 'destructuredParameter'})
        }
        const property = element.propertyName == null
          ? element.name.text
          : ts.isIdentifier(element.propertyName) ? element.propertyName.text : null
        if (property == null) throw unsupported(element, {kind: 'destructuredParameter'})
        bindings.push({property, local: element.name.text})
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
      throw unsupported(parameter, {kind: 'parameterType', typeText: `...${checker.typeToString(checker.getTypeAtLocation(parameter))}`, optionalOrRestTuple: false})
    }
    let type = lowerParameterType(parameter, parameterType, checker)
    // A default value applies whenever a caller omits the argument. Literal defaults can
    // be represented exactly and checked against the declared assumptions: `zoom: number
    // = 5` supplies a finite number. Anything else — `= Infinity`, `= readConfig()` —
    // rejects because it could falsify those assumptions or hide unsupported behavior.
    if (parameter.initializer != null) {
      const default_ = parameterDefaultLiteral(parameter.initializer, checker)
      if (default_ == null || !parameterDefaultFits(default_, type)) {
        throw unsupported(parameter, {kind: 'parameterDefaultValue', name: parameter.name.text})
      }
      type = parameterBodyKind(type, default_)
    }
    const value = context.nextValue++
    context.bindings.set(requiredSymbol(parameter.name, checker), value)
    context.parameters.push({value, name: parameter.name.text, type, site: addSite(context, parameter), bindings: null})
  }
  lowerFiniteInputRequirements(context)
  if (ts.isBlock(declaration.body)) {
    lowerStatements(declaration.body.statements, context)
  } else {
    const value = lowerExpression(declaration.body, context)
    terminate(context.currentBlock, {
      kind: 'return',
      value: returnsVoid ? null : value,
      site: addSite(context, declaration.body),
    })
  }
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
    name: unit.name.text,
    assertions: context.assertions,
    parameters: context.parameters,
    returnPropertyNames: declaredRecordReturnNames(returnType, checker),
    entry: 0,
    blocks: sealBlocks(context.blocks, unit.name.text),
  }
}

function lowerFiniteInputRequirements(context: ReturnType<typeof createFunctionContext>): void {
  for (const parameter of context.parameters) {
    for (const properties of finiteInputPaths(parameter.type)) {
      let value = parameter.value
      for (const property of properties) {
        value = addInstructionAtSite(context, parameter.site, {kind: 'property', object: value, property})
      }
      const check = addInstructionAtSite(context, parameter.site, {
        kind: 'numberCheck',
        predicate: 'finite',
        value,
        purpose: 'finiteInput',
      })
      addInstructionAtSite(context, parameter.site, {kind: 'staticRequire', value: check, purpose: 'finiteInput'})
    }
  }
}

// JavaScript replaces undefined before the function body begins. A default of undefined
// leaves it possible; every other default removes it. Null remains an ordinary argument.
function parameterBodyKind(declared: DeclaredKind, default_: ParameterDefaultLiteral): DeclaredKind {
  if (declared.kind !== 'nullish' || declared.sentinels === 'null') return declared
  if (default_.kind === 'nullish' && default_.sentinel === 'undefined') return declared
  if (declared.sentinels === 'undefined') return declared.inner
  return {kind: 'nullish', inner: declared.inner, sentinels: 'null'}
}

function declaredRecordReturnNames(returnType: ts.Type, checker: ts.TypeChecker): string[] | null {
  const kind = valueKind(returnType, checker)
  if (kind === 'object') return checker.getPropertiesOfType(returnType).map(property => property.name)
  if (kind === 'nullable' && returnType.isUnion()) {
    const missing = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    const members = returnType.types.filter(member => (member.flags & missing) === 0)
    if (members.length > 0 && members.every(member => valueKind(member, checker) === 'object')) {
      const names = new Set<string>()
      for (const member of members) {
        for (const property of checker.getPropertiesOfType(member)) names.add(property.name)
      }
      return [...names]
    }
  }
  return null
}

function lowerParameterType(
  parameter: ts.ParameterDeclaration,
  type: ts.Type,
  checker: ts.TypeChecker,
): DeclaredKind {
  // The same recursive classification module bindings use: numbers, booleans, records
  // (opaque leaves included — an id: string property is carried, not rejected), nullable
  // wrappers, arrays, tuples, and bare opaque (a plain string parameter).
  const declared = declaredKind(type, checker, [])
  if (declared == null) {
    throw unsupported(parameter, {
      kind: 'parameterType',
      typeText: checker.typeToString(type),
      optionalOrRestTuple: tupleHasOptionalOrRestPositions(type, checker),
    })
  }
  return declared
}
