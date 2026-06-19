import * as ts from 'typescript'
import type {ImportedBinding, Program} from '../check-types.ts'
import type {FitFunction} from '../modules.ts'
import {
  functionImplementationForDeclaration,
  isClassFunctionNode,
} from '../function-shape.ts'

export type InterpreterCallTarget =
  | {kind: 'math'; name: string}
  | {
      kind: 'function'
      program: Program
      fn: FitFunction
      imported?: {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>}
    }
  | {
      kind: 'unresolved'
      cause: 'unknown-function' | 'unsupported-target' | 'unavailable-import'
      reason: string
    }

export type ResolvedFunctionTarget = Extract<InterpreterCallTarget, {kind: 'function'}>

export type DefaultLibraryOwner =
  | 'Array'
  | 'ReadonlyArray'
  | 'Map'
  | 'ReadonlyMap'
  | 'Set'
  | 'ReadonlySet'
  | 'String'
  | 'TypedArray'
  | 'Other'

export function resolveCallTarget(target: ts.Expression, program: Program): InterpreterCallTarget {
  const source = sourceFunctionTarget(target, program)
  if (source != null) return source
  if (ts.isIdentifier(target)) {
    if (!identifierAllowsIndexedFallback(target, program)) {
      return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported function value ${target.text}`}
    }
    return resolveIdentifierCallTarget(target.text, program)
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    if (!namespaceAccessAllowsIndexedFallback(target.expression, program)) {
      return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported call ${target.getText()}`}
    }
    return resolveNamespaceMemberCallTarget(target.expression.text, target.name.text, program, new Set())
  }
  return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported call ${target.getText()}`}
}

function sourceFunctionTarget(
  target: ts.Expression,
  program: Program,
): Extract<InterpreterCallTarget, {kind: 'function'}> | null {
  const checker = program.typeChecker
  if (checker == null) return null
  const symbolNode = ts.isPropertyAccessExpression(target) ? target.name : target
  const symbol = resolvedSymbol(checker.getSymbolAtLocation(symbolNode), checker)
  if (symbol == null) return null
  for (const declaration of symbol.declarations ?? []) {
    const node = functionImplementationForDeclaration(declaration)
    if (node == null) continue
    if (isClassFunctionNode(node)) continue
    const targetProgram = programForSourceFile(node.getSourceFile(), program)
    if (targetProgram == null || targetProgram !== program || !('functions' in targetProgram)) continue
    for (const fn of targetProgram.functions.values()) {
      if (fn.node === node) return {kind: 'function', program: targetProgram, fn}
    }
  }
  return null
}

function identifierAllowsIndexedFallback(identifier: ts.Identifier, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  const symbol = checker.getSymbolAtLocation(identifier)
  if (symbol == null) return true
  return symbol.declarations?.some(declaration =>
    declaration.getSourceFile() === program.sourceFile
    && (
      ts.isImportClause(declaration)
      || ts.isImportSpecifier(declaration)
      || ts.isNamespaceImport(declaration)
      || isTopLevelValueDeclaration(declaration)
    ),
  ) === true
}

function namespaceAccessAllowsIndexedFallback(identifier: ts.Identifier, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  const symbol = checker.getSymbolAtLocation(identifier)
  return symbol?.declarations?.some(declaration =>
    declaration.getSourceFile() === program.sourceFile && ts.isNamespaceImport(declaration),
  ) === true
}

function isTopLevelValueDeclaration(declaration: ts.Declaration) {
  if (
    ts.isFunctionDeclaration(declaration)
    || ts.isClassDeclaration(declaration)
    || ts.isExportAssignment(declaration)
  ) return declaration.parent === declaration.getSourceFile()
  if (!ts.isVariableDeclaration(declaration)) return false
  const statement = declaration.parent.parent
  return ts.isVariableStatement(statement) && statement.parent === declaration.getSourceFile()
}

function resolveIdentifierCallTarget(name: string, program: Program, seen = new Set<string>()): InterpreterCallTarget {
  const local = program.functions.get(name)
  if (local != null) return {kind: 'function', program, fn: local}

  const key = `${program.sourceId}#${name}`
  if (seen.has(key)) {
    return {kind: 'unresolved', cause: 'unsupported-target', reason: `Cyclic call alias at ${program.file}#${name}`}
  }
  seen.add(key)

  const alias = program.callAliases.get(name)
  if (alias != null) {
    if (alias.kind === 'math') return {kind: 'math', name: alias.name}
    if (alias.kind === 'identifier') return resolveIdentifierCallTarget(alias.name, program, seen)
    return resolveNamespaceMemberCallTarget(alias.namespace, alias.exportedName, program, seen)
  }

  const unsupportedAlias = program.unsupportedCallAliases.get(name)
  if (unsupportedAlias != null) return {kind: 'unresolved', cause: 'unsupported-target', reason: unsupportedAlias}

  const binding = program.imports.get(name)
  if (binding == null) return {kind: 'unresolved', cause: 'unknown-function', reason: `Unknown function ${name}`}
  if (binding.kind === 'unresolved') return {kind: 'unresolved', cause: 'unavailable-import', reason: binding.reason}
  if (binding.kind === 'namespace') {
    return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported namespace call ${name}`}
  }
  return resolveImportedCallTarget(name, binding, seen)
}

function resolveNamespaceMemberCallTarget(namespace: string, exportedName: string, program: Program, seen: Set<string>): InterpreterCallTarget {
  const binding = program.imports.get(namespace)
  if (binding == null || binding.kind === 'resolved') {
    return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported call ${namespace}.${exportedName}`}
  }
  if (binding.kind === 'unresolved') return {kind: 'unresolved', cause: 'unavailable-import', reason: binding.reason}
  const member = binding.members.get(exportedName) ?? {file: binding.file, sourceName: exportedName}
  return resolveImportedCallTarget(`${namespace}.${exportedName}`, {
    kind: 'resolved',
    importedName: exportedName,
    sourceName: member.sourceName,
    specifier: binding.specifier,
    file: member.file,
  }, seen)
}

function resolveImportedCallTarget(
  localName: string,
  binding: Extract<ImportedBinding, {kind: 'resolved'}>,
  seen: Set<string>,
): InterpreterCallTarget {
  const sourceName = binding.sourceName
  const target = resolveIdentifierCallTarget(sourceName, binding.file, seen)
  if (target.kind === 'unresolved') {
    return {...target, reason: `${localName} resolved to ${sourceName}: ${target.reason}`}
  }
  if (target.kind === 'math') return target
  return {
    ...target,
    imported: target.imported ?? {localName, binding},
  }
}

export function propertyAccessHasSourceAccessor(
  access: ts.PropertyAccessExpression,
  kind: 'get' | 'set',
  program: Program,
): boolean {
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  return symbol?.declarations?.some(declaration =>
    kind === 'get'
      ? ts.isGetAccessorDeclaration(declaration)
      : ts.isSetAccessorDeclaration(declaration)) === true
}

export function elementAccessHasSourceAccessor(
  access: ts.ElementAccessExpression,
  kind: 'get' | 'set',
  program: Program,
): boolean {
  const checker = program.typeChecker
  if (checker == null) return false
  const symbol = classElementAccessSymbol(access, checker)
  return symbol?.declarations?.some(declaration =>
    kind === 'get'
      ? ts.isGetAccessorDeclaration(declaration)
      : ts.isSetAccessorDeclaration(declaration)) === true
}

function classElementAccessSymbol(
  access: ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const argument = access.argumentExpression
  if (argument == null) return undefined
  if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
    return checker.getPropertyOfType(checker.getTypeAtLocation(access.expression), argument.text)
  }
  return checker.getSymbolAtLocation(argument)
}

export function isDefaultLibrarySymbol(node: ts.Node, program: Program): boolean {
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(node)
  if (symbol == null || checker == null) return false
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return resolved.declarations?.some(declaration =>
    program.project.typeProgram?.isSourceFileDefaultLibrary(declaration.getSourceFile()) === true,
  ) === true
}

export function isDefaultLibraryMemberAccess(access: ts.PropertyAccessExpression, program: Program): boolean {
  return isDefaultLibrarySymbol(access.name, program)
}

export function defaultLibraryOwner(
  access: ts.PropertyAccessExpression,
  program: Program,
): DefaultLibraryOwner {
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  if (symbol == null || checker == null) return 'Other'
  const resolved = resolvedSymbol(symbol, checker)
  for (const declaration of resolved?.declarations ?? []) {
    const owner = containingNamedDeclaration(declaration)
    const name = owner?.name != null && ts.isIdentifier(owner.name) ? owner.name.text : null
    if (name === 'Array' || name === 'ReadonlyArray' || name === 'Map' || name === 'ReadonlyMap'
      || name === 'Set' || name === 'ReadonlySet' || name === 'String') return name
    if (name != null && typedArrayNames.has(name)) return 'TypedArray'
  }
  return 'Other'
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  let current = symbol
  const seen = new Set<ts.Symbol>()
  while (current != null && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current)
    current = checker.getAliasedSymbol(current)
  }
  return current
}

function containingNamedDeclaration(declaration: ts.Declaration): ts.DeclarationStatement | ts.InterfaceDeclaration | null {
  for (let current: ts.Node | undefined = declaration.parent; current != null; current = current.parent) {
    if (ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current)) return current
    if (ts.isSourceFile(current)) return null
  }
  return null
}

const typedArrayNames = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
])

function programForSourceFile(sourceFile: ts.SourceFile, program: Program): Program | null {
  if (sameProgramSourceFile(program, sourceFile)) return program
  const projectFile = program.project.filesBySourceFile.get(sourceFile)
  if (projectFile != null && 'functions' in projectFile) return projectFile as Program
  return importedPrograms(program).find(imported => sameProgramSourceFile(imported, sourceFile)) ?? null
}

function importedPrograms(program: Program): Program[] {
  const programs: Program[] = []
  for (const binding of program.imports.values()) {
    if (binding.kind === 'resolved' || binding.kind === 'namespace') programs.push(binding.file)
    if (binding.kind !== 'namespace') continue
    for (const member of binding.members.values()) programs.push(member.file)
  }
  return programs
}

function sameProgramSourceFile(program: Program, sourceFile: ts.SourceFile) {
  return program.sourceFile === sourceFile || program.sourceId === sourceFile.fileName
}
