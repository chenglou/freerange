import * as ts from 'typescript'
import {moduleInitializerName, nodeSpan, type FunctionIR, type FunctionLowering, type ProgramIR, type SourceSpan, type UnsupportedReason, type ValueTypeIR} from '../ir/program.ts'
import type {CheckedSource} from '../typescript/check.ts'
import {assertAccepted, evalMention, typeCheckSuppressionMention} from './accept.ts'
import {addSite, LoweringStop, requiredSymbol, sealBlocks, terminate, unsupported, type FunctionContext, type MutableBlock, type TopLevelFunction} from './context.ts'
import {valueKind} from './expression.ts'
import {lowerModuleInitializer, scanModuleBindings, type ModuleScan} from './module.ts'
import {lowerStatements} from './statements.ts'

export function lowerSource(checked: CheckedSource): ProgramIR {
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
      entry: 0,
      blocks: [{loopHeader: null, parameters: [], instructions: [], terminator: {kind: 'stop', site: 0, reason}}],
    },
    initializerSkips: [],
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
    // One of the two places a LoweringStop is caught. The half-built FunctionContext is
    // discarded wholesale; only the name, the offending node's site, and the tagged reason
    // survive.
    try {
      functions.push(lowerFunction(declaration, sourceFile, checker, functionsBySymbol, scan, sites))
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      sites.push(nodeSpan(sourceFile, error.node))
      functions.push({kind: 'unsupported', name: declaration.name!.text, site: sites.length - 1, reason: error.reason})
    }
  }
  const {initializer, skips} = lowerModuleInitializer(sourceFile, checker, functionsBySymbol, scan, sites)
  return {
    file: sourceFile.fileName,
    lineStarts: [...sourceFile.getLineStarts()],
    sites,
    functions,
    moduleBindings: scan.bindings,
    initializer,
    initializerSkips: skips,
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
  assertAccepted(declaration, checker)
  const signature = checker.getSignatureFromDeclaration(declaration)
  // A type predicate (`shape is Circle`, `asserts x`) is the checker taking the author's
  // word: callers' narrowing then exposes properties the analysis cannot confirm the
  // value carries. Rejecting the declaring function stops every caller at the call.
  if (signature != null && checker.getTypePredicateOfSignature(signature) != null) {
    throw unsupported(declaration, {kind: 'typePredicate'})
  }
  const returnType = functionReturnType(declaration, checker)
  const returnsVoid = (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
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
    if (!ts.isIdentifier(parameter.name)) throw unsupported(parameter.name, {kind: 'destructuredParameter'})
    const type = lowerParameterType(parameter, checker)
    const value = context.nextValue++
    context.bindings.set(requiredSymbol(parameter.name, checker), value)
    context.parameters.push({value, name: parameter.name.text, type})
  }
  lowerStatements(declaration.body.statements, context)
  if (context.currentBlock.terminator == null) {
    if (!returnsVoid) throw unsupported(declaration, {kind: 'missingReturn'})
    terminate(context.currentBlock, {kind: 'return', value: null, site: addSite(context, declaration)})
  }
  return {
    kind: 'lowered',
    name: declaration.name!.text,
    parameters: context.parameters,
    entry: 0,
    blocks: sealBlocks(context.blocks, declaration.name!.text),
  }
}

function lowerParameterType(parameter: ts.ParameterDeclaration, checker: ts.TypeChecker): ValueTypeIR {
  const type = checker.getTypeAtLocation(parameter)
  // Through valueKind, the one classification every other gate uses: a `1 | 2`
  // discriminant is a number here as everywhere else, and index signatures, callables,
  // and mixed shapes reject here instead of seeding a record the type licenses more
  // reads against than it carries.
  switch (valueKind(type, checker)) {
    case 'number': return {kind: 'number'}
    case 'nullable': {
      // Only number | null / number | undefined; missing-able records as parameters wait.
      const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
      const rest = type.isUnion() ? type.types.filter(member => (member.flags & missingFlags) === 0) : []
      if (rest.length === 1 && valueKind(rest[0]!, checker) === 'number') {
        const admitsNull = type.isUnion() && type.types.some(member => (member.flags & ts.TypeFlags.Null) !== 0)
        const admitsUndefined = type.isUnion() && type.types.some(member => (member.flags & ts.TypeFlags.Undefined) !== 0)
        return {kind: 'nullishNumber', sentinels: admitsNull && admitsUndefined ? 'both' : admitsNull ? 'null' : 'undefined'}
      }
      throw unsupported(parameter, {kind: 'parameterType', typeText: checker.typeToString(type)})
    }
    case 'array': {
      // number[] parameters only; element shapes and tuple parameters wait for a need.
      const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
      if (element != null && valueKind(element, checker) === 'number') return {kind: 'numberArray'}
      throw unsupported(parameter, {kind: 'parameterType', typeText: checker.typeToString(type)})
    }
    case 'object': break
    default: throw unsupported(parameter, {kind: 'parameterType', typeText: checker.typeToString(type)})
  }
  const properties: string[] = []
  for (const property of checker.getPropertiesOfType(type)) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, parameter)
    if ((property.flags & ts.SymbolFlags.Optional) !== 0 || valueKind(propertyType, checker) !== 'number') {
      throw unsupported(parameter, {
        kind: 'objectParameterProperty',
        property: property.name,
        typeText: checker.typeToString(propertyType),
      })
    }
    properties.push(property.name)
  }
  if (properties.length === 0) throw unsupported(parameter, {kind: 'objectParameterWithoutNumericProperties'})
  return {kind: 'object', properties}
}

function functionReturnType(declaration: ts.FunctionDeclaration, checker: ts.TypeChecker): ts.Type {
  const signature = checker.getSignatureFromDeclaration(declaration)
  if (signature == null) throw unsupported(declaration, {kind: 'functionWithoutSignature'})
  return checker.getReturnTypeOfSignature(signature)
}
