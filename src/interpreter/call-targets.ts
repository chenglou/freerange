import * as ts from 'typescript'
import type {ImportedBinding, Program} from '../check-types.ts'
import type {FitFunction} from '../modules.ts'
import {
  classMemberFunctionName,
  functionImplementationForDeclaration,
} from '../function-shape.ts'
import type {InterpreterFrame} from './context.ts'

export type InterpreterCallTarget =
  | {kind: 'math'; name: string}
  | {
      kind: 'function'
      program: Program
      fn: FitFunction
      imported?: {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>}
    }
  | {kind: 'unresolved'; reason: string}

export type ResolvedFunctionTarget = Extract<InterpreterCallTarget, {kind: 'function'}>

export function resolveCallTarget(target: ts.Expression, program: Program): InterpreterCallTarget {
  const source = sourceFunctionTarget(target, program)
  if (source != null) return source
  if (ts.isIdentifier(target)) {
    if (!identifierAllowsIndexedFallback(target, program)) {
      return {kind: 'unresolved', reason: `Unsupported function value ${target.text}`}
    }
    return resolveIdentifierCallTarget(target.text, program)
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    if (!namespaceAccessAllowsIndexedFallback(target.expression, program)) {
      return {kind: 'unresolved', reason: `Unsupported call ${target.getText()}`}
    }
    return resolveNamespaceMemberCallTarget(target.expression.text, target.name.text, program, new Set())
  }
  return {kind: 'unresolved', reason: `Unsupported call ${target.getText()}`}
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
  if (seen.has(key)) return {kind: 'unresolved', reason: `Cyclic call alias at ${program.file}#${name}`}
  seen.add(key)

  const alias = program.callAliases.get(name)
  if (alias != null) {
    if (alias.kind === 'math') return {kind: 'math', name: alias.name}
    if (alias.kind === 'identifier') return resolveIdentifierCallTarget(alias.name, program, seen)
    return resolveNamespaceMemberCallTarget(alias.namespace, alias.exportedName, program, seen)
  }

  const unsupportedAlias = program.unsupportedCallAliases.get(name)
  if (unsupportedAlias != null) return {kind: 'unresolved', reason: unsupportedAlias}

  const binding = program.imports.get(name)
  if (binding == null) return {kind: 'unresolved', reason: `Unknown function ${name}`}
  if (binding.kind === 'unresolved') return {kind: 'unresolved', reason: binding.reason}
  if (binding.kind === 'namespace') return {kind: 'unresolved', reason: `Unsupported namespace call ${name}`}
  return resolveImportedCallTarget(name, binding, seen)
}

function resolveNamespaceMemberCallTarget(namespace: string, exportedName: string, program: Program, seen: Set<string>): InterpreterCallTarget {
  const binding = program.imports.get(namespace)
  if (binding == null || binding.kind === 'resolved') return {kind: 'unresolved', reason: `Unsupported call ${namespace}.${exportedName}`}
  if (binding.kind === 'unresolved') return {kind: 'unresolved', reason: binding.reason}
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
  if (target.kind === 'unresolved') return {kind: 'unresolved', reason: `${localName} resolved to ${sourceName}: ${target.reason}`}
  if (target.kind === 'math') return target
  return {
    ...target,
    imported: target.imported ?? {localName, binding},
  }
}

export function classMemberFunctionForPropertyAccess(
  access: ts.PropertyAccessExpression,
  frame: InterpreterFrame,
): Extract<InterpreterCallTarget, {kind: 'function'}> | null {
  const member = classMemberForPropertyAccess(access, frame)
  if (member == null) return null
  const program = programForClassMember(member.declaration, frame)
  if (program == null) return null
  const className = member.className
  const functionName = member.declaration == null
    ? `${className}.${access.name.text}`
    : classMemberFunctionName(className, member.declaration)
  if (functionName == null) return null
  const fn = program.functions.get(functionName)
  if (fn == null) return null
  const imported = program === frame.program ? null : importedClassBinding(className, program, frame.program)
  return {
    kind: 'function',
    program,
    fn,
    ...(imported == null ? {} : {imported}),
  }
}

export function classMemberFunctionForPropertyAccessInProgram(
  access: ts.PropertyAccessExpression,
  program: Program,
): Extract<InterpreterCallTarget, {kind: 'function'}> | null {
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  const declaration = symbolDeclaration(symbol, checker)
  if (
    declaration == null
    || !ts.isMethodDeclaration(declaration)
    || !ts.isClassDeclaration(declaration.parent)
    || declaration.parent.name == null
  ) return null
  return classFunctionTarget(declaration, program)
}

export function classAccessorFunctionForPropertyAccessInProgram(
  access: ts.PropertyAccessExpression,
  kind: 'get' | 'set',
  program: Program,
): Extract<InterpreterCallTarget, {kind: 'function'}> | null {
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  const declaration = symbol?.declarations?.find(candidate => {
    switch (kind) {
      case 'get':
        return ts.isGetAccessorDeclaration(candidate)
      case 'set':
        return ts.isSetAccessorDeclaration(candidate)
    }
  })
  if (
    declaration == null
    || (!ts.isGetAccessorDeclaration(declaration) && !ts.isSetAccessorDeclaration(declaration))
    || !ts.isClassDeclaration(declaration.parent)
    || declaration.parent.name == null
  ) return null
  return classFunctionTarget(declaration, program)
}

function classFunctionTarget(
  declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  program: Program,
): Extract<InterpreterCallTarget, {kind: 'function'}> | null {
  const parent = declaration.parent
  if (!ts.isClassDeclaration(parent) || parent.name == null) return null
  const memberProgram = programForSourceFile(declaration.getSourceFile(), program)
  if (memberProgram == null) return null
  const functionName = classMemberFunctionName(parent.name.text, declaration)
  if (functionName == null) return null
  const fn = memberProgram.functions.get(functionName)
  return fn == null ? null : {kind: 'function', program: memberProgram, fn}
}

export function constructorFunctionForNewExpression(
  expression: ts.NewExpression,
  program: Program,
): Extract<InterpreterCallTarget, {kind: 'function'}> | null {
  const declaration = classDeclarationForNewExpression(expression, program)
  if (declaration == null || declaration.name == null) return null
  const constructor = declaration.members.find(ts.isConstructorDeclaration)
  if (constructor?.body == null) return null
  const constructorProgram = programForSourceFile(declaration.getSourceFile(), program)
  if (constructorProgram == null) return null
  const fn = constructorProgram.functions.get(`${declaration.name.text}.constructor`)
  return fn == null ? null : {kind: 'function', program: constructorProgram, fn}
}

export function classDeclarationForNewExpression(expression: ts.NewExpression, program: Program): ts.ClassDeclaration | null {
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(expression.expression)
  const declaration = symbolDeclaration(symbol, checker)
  return declaration != null && ts.isClassDeclaration(declaration) ? declaration : null
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

function symbolDeclaration(symbol: ts.Symbol | undefined, checker: ts.TypeChecker | null): ts.Declaration | undefined {
  const resolved = checker == null ? symbol : resolvedSymbol(symbol, checker)
  if (resolved == null) return undefined
  return resolved.valueDeclaration ?? resolved.declarations?.[0]
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

function classMemberForPropertyAccess(access: ts.PropertyAccessExpression, frame: InterpreterFrame): {className: string; declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | null} | null {
  const checker = frame.program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (
    declaration != null
    && (ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration))
    && ts.isClassDeclaration(declaration.parent)
    && declaration.parent.name != null
  ) {
    return {className: declaration.parent.name.text, declaration}
  }

  if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const current = frame.stack.at(-1)
    const dot = current?.indexOf('.') ?? -1
    if (current != null && dot > 0) return {className: current.slice(0, dot), declaration: null}
  }

  return null
}

function programForClassMember(declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | null, frame: InterpreterFrame): Program | null {
  if (declaration == null) return frame.program
  return programForSourceFile(declaration.getSourceFile(), frame.program)
}

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

function importedClassBinding(className: string, classProgram: Program, callerProgram: Program): {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>} | null {
  for (const [localName, binding] of callerProgram.imports) {
    if (binding.kind !== 'resolved') continue
    if (binding.file !== classProgram) continue
    if (binding.sourceName === className || binding.importedName === className) return {localName, binding}
  }
  return null
}
