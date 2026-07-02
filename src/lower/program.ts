import * as ts from 'typescript'
import type {FunctionID} from '../ir/ids.ts'
import type {BlockIR, FunctionIR, ProgramIR, SourceSpan, ValueTypeIR} from '../ir/program.ts'
import type {CheckedSource} from '../typescript/check.ts'
import {requiredSymbol, terminate, unsupported, type FunctionContext, type MutableBlock} from './context.ts'
import {lowerStatements} from './statements.ts'

export function lowerSource(checked: CheckedSource): ProgramIR {
  const {sourceFile, checker} = checked
  const declarations: ts.FunctionDeclaration[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) declarations.push(statement)
  }
  const functionsBySymbol = new Map<ts.Symbol, FunctionID>()
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index]!
    functionsBySymbol.set(requiredSymbol(declaration.name!, checker), index)
  }
  const sites: SourceSpan[] = []
  const functions: FunctionIR[] = []
  for (const declaration of declarations) {
    functions.push(lowerFunction(declaration, sourceFile, checker, functionsBySymbol, sites))
  }
  return {file: sourceFile.fileName, lineStarts: [...sourceFile.getLineStarts()], sites, functions}
}

function lowerFunction(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, FunctionID>,
  sites: SourceSpan[],
): FunctionIR {
  if (declaration.body == null) throw unsupported(declaration, 'Function declarations need bodies')
  const entry: MutableBlock = {loopHeader: null, parameters: [], instructions: [], terminator: null}
  const context: FunctionContext = {
    sourceFile,
    checker,
    functionsBySymbol,
    sites,
    nextValue: 0,
    currentBlock: entry,
    blocks: [entry],
    bindings: new Map(),
    parameters: [],
  }
  let objectParameterCount = 0
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) throw unsupported(parameter.name, 'Destructured parameters')
    const type = lowerParameterType(parameter, checker)
    if (type.kind === 'object' && ++objectParameterCount > 1) {
      throw unsupported(parameter, 'More than one object parameter')
    }
    const value = context.nextValue++
    context.bindings.set(requiredSymbol(parameter.name, checker), value)
    context.parameters.push({value, name: parameter.name.text, type})
  }
  lowerStatements(declaration.body.statements, context)
  if (context.currentBlock.terminator == null) {
    if (!functionReturnsVoid(declaration, checker)) throw unsupported(declaration, 'Function path without a return')
    terminate(context.currentBlock, {kind: 'return', value: null})
  }
  const blocks: BlockIR[] = []
  for (const block of context.blocks) {
    if (block.terminator == null) throw unsupported(declaration, 'Function path without a return')
    blocks.push({
      loopHeader: block.loopHeader,
      parameters: block.parameters,
      instructions: block.instructions,
      terminator: block.terminator,
    })
  }
  return {
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
    throw unsupported(parameter, `Function parameter with type ${checker.typeToString(type)}`)
  }
  const properties: string[] = []
  for (const property of checker.getPropertiesOfType(type)) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, parameter)
    if ((property.flags & ts.SymbolFlags.Optional) !== 0 || (propertyType.flags & ts.TypeFlags.NumberLike) === 0) {
      throw unsupported(parameter, `Object parameter property ${property.name} with type ${checker.typeToString(propertyType)}`)
    }
    properties.push(property.name)
  }
  if (properties.length === 0) throw unsupported(parameter, 'Object parameter without numeric properties')
  return {kind: 'object', properties}
}

function functionReturnsVoid(declaration: ts.FunctionDeclaration, checker: ts.TypeChecker): boolean {
  const signature = checker.getSignatureFromDeclaration(declaration)
  if (signature == null) throw unsupported(declaration, 'Function without a TypeScript signature')
  const flags = checker.getReturnTypeOfSignature(signature).flags
  return (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
}
