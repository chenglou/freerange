import * as ts from 'typescript'
import type {ImportedBinding, Program} from '../check-types.ts'
import type {FitFunction} from '../modules.ts'
import type {InterpreterFrame} from './context.ts'

export type InterpreterCallTarget =
  | {kind: 'math'; name: string}
  | {
      kind: 'function'
      program: Program
      functionName: string
      fn: FitFunction
      imported?: {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>}
    }
  | {kind: 'unresolved'; reason: string}

export function resolveCallTarget(target: ts.Expression, program: Program): InterpreterCallTarget {
  if (ts.isIdentifier(target)) return resolveIdentifierCallTarget(target.text, program)
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    return resolveNamespaceMemberCallTarget(target.expression.text, target.name.text, program, new Set())
  }
  return {kind: 'unresolved', reason: `Unsupported call ${target.getText()}`}
}

function resolveIdentifierCallTarget(name: string, program: Program, seen = new Set<string>()): InterpreterCallTarget {
  const local = program.functions.get(name)
  if (local != null) return {kind: 'function', program, functionName: name, fn: local}

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
  const functionName = classMemberFunctionName(className, access.name.text, member.declaration)
  const fn = program.functions.get(functionName)
  if (fn == null) return null
  const imported = program === frame.program ? null : importedClassBinding(className, program, frame.program)
  return {
    kind: 'function',
    program,
    functionName,
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
  return classFunctionTarget(declaration, access.name.text, program)
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
  return classFunctionTarget(declaration, access.name.text, program)
}

function classFunctionTarget(
  declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  memberName: string,
  program: Program,
): Extract<InterpreterCallTarget, {kind: 'function'}> | null {
  const parent = declaration.parent
  if (!ts.isClassDeclaration(parent) || parent.name == null) return null
  const memberProgram = programForSourceFile(declaration.getSourceFile(), program)
  if (memberProgram == null) return null
  const functionName = classMemberFunctionName(parent.name.text, memberName, declaration)
  const fn = memberProgram.functions.get(functionName)
  return fn == null ? null : {kind: 'function', program: memberProgram, functionName, fn}
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
  const functionName = `${declaration.name.text}.constructor`
  const fn = constructorProgram.functions.get(functionName)
  return fn == null ? null : {kind: 'function', program: constructorProgram, functionName, fn}
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

function classMemberFunctionName(
  className: string,
  memberName: string,
  declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | null,
) {
  const owner = declaration != null && hasModifier(declaration, ts.SyntaxKind.StaticKeyword) ? `${className}.static` : className
  if (declaration != null && ts.isSetAccessorDeclaration(declaration)) return `${owner}.set.${memberName}`
  return `${owner}.${memberName}`
}

function symbolDeclaration(symbol: ts.Symbol | undefined, checker: ts.TypeChecker | null): ts.Declaration | undefined {
  if (symbol == null) return undefined
  const resolved = checker != null && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return resolved.valueDeclaration ?? resolved.declarations?.[0]
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
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
