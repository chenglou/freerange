import * as ts from 'typescript'
import type {FunctionID} from '../ir/ids.ts'
import type {BlockIR, FunctionIR, FunctionLowering, ProgramIR, SourceSpan, ValueTypeIR} from '../ir/program.ts'
import type {CheckedSource} from '../typescript/check.ts'
import {assertAccepted, evalMention} from './accept.ts'
import {addSite, LoweringStop, requiredSymbol, terminate, unsupported, type FunctionContext, type MutableBlock} from './context.ts'
import {valueKind} from './expression.ts'
import {lowerModuleInitializer, scanModuleBindings, type ModuleScan} from './module.ts'
import {lowerStatements} from './statements.ts'

export function lowerSource(checked: CheckedSource): ProgramIR {
  const {sourceFile, checker} = checked
  const declarations: ts.FunctionDeclaration[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) declarations.push(statement)
  }
  // The one file-wide rejection: an eval string can rewrite bindings that every function's
  // report depends on, so no function in the file is analyzed.
  const evalNode = evalMention(sourceFile)
  if (evalNode != null) {
    const sites: SourceSpan[] = [{start: evalNode.getStart(sourceFile), end: evalNode.getEnd()}]
    const initializerEntry: BlockIR = {
      loopHeader: null,
      parameters: [],
      instructions: [],
      terminator: {kind: 'stop', site: 0, reason: {kind: 'evalInFile'}},
    }
    return {
      file: sourceFile.fileName,
      lineStarts: [...sourceFile.getLineStarts()],
      sites,
      functions: declarations.map(declaration => ({
        kind: 'unsupported',
        name: declaration.name!.text,
        site: 0,
        reason: {kind: 'evalInFile'},
      })),
      moduleBindings: [],
      initializer: {kind: 'lowered', name: 'module initialization', parameters: [], entry: 0, blocks: [initializerEntry]},
    }
  }
  const functionsBySymbol = new Map<ts.Symbol, FunctionID>()
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index]!
    // This loop runs outside the per-function catch below, so a missing symbol here is an
    // invariant crash, not a recorded reason: a declaration name that type-checked always
    // has a symbol.
    const symbol = checker.getSymbolAtLocation(declaration.name!)
    if (symbol == null) throw new Error(`Function declaration ${declaration.name!.text} has no TypeScript symbol`)
    functionsBySymbol.set(symbol, index)
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
      sites.push({start: error.node.getStart(sourceFile), end: error.node.getEnd()})
      functions.push({kind: 'unsupported', name: declaration.name!.text, site: sites.length - 1, reason: error.reason})
    }
  }
  const initializer = lowerModuleInitializer(sourceFile, checker, functionsBySymbol, scan, sites)
  return {
    file: sourceFile.fileName,
    lineStarts: [...sourceFile.getLineStarts()],
    sites,
    functions,
    moduleBindings: scan.bindings,
    initializer,
  }
}

function lowerFunction(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, FunctionID>,
  scan: ModuleScan,
  sites: SourceSpan[],
): FunctionIR {
  if (declaration.body == null) throw unsupported(declaration, {kind: 'functionWithoutBody'})
  assertAccepted(declaration, checker)
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
  let objectParameterCount = 0
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) throw unsupported(parameter.name, {kind: 'destructuredParameter'})
    const type = lowerParameterType(parameter, checker)
    if (type.kind === 'object' && ++objectParameterCount > 1) {
      throw unsupported(parameter, {kind: 'multipleObjectParameters'})
    }
    const value = context.nextValue++
    context.bindings.set(requiredSymbol(parameter.name, checker), value)
    context.parameters.push({value, name: parameter.name.text, type})
  }
  lowerStatements(declaration.body.statements, context)
  if (context.currentBlock.terminator == null) {
    if (!returnsVoid) throw unsupported(declaration, {kind: 'missingReturn'})
    terminate(context.currentBlock, {kind: 'return', value: null, site: addSite(context, declaration)})
  }
  const blocks: BlockIR[] = []
  for (const block of context.blocks) {
    if (block.terminator == null) throw unsupported(declaration, {kind: 'missingReturn'})
    blocks.push({
      loopHeader: block.loopHeader,
      parameters: block.parameters,
      instructions: block.instructions,
      terminator: block.terminator,
    })
  }
  return {
    kind: 'lowered',
    name: declaration.name!.text,
    parameters: context.parameters,
    entry: 0,
    blocks,
  }
}

function lowerParameterType(parameter: ts.ParameterDeclaration, checker: ts.TypeChecker): ValueTypeIR {
  const type = checker.getTypeAtLocation(parameter)
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return {kind: 'number'}
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    throw unsupported(parameter, {kind: 'parameterType', typeText: checker.typeToString(type)})
  }
  const properties: string[] = []
  for (const property of checker.getPropertiesOfType(type)) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, parameter)
    if ((property.flags & ts.SymbolFlags.Optional) !== 0 || (propertyType.flags & ts.TypeFlags.NumberLike) === 0) {
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
