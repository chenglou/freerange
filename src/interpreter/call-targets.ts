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
  const member = binding.members.get(exportedName) ?? {module: binding.module, sourceName: exportedName}
  return resolveImportedCallTarget(`${namespace}.${exportedName}`, {
    kind: 'resolved',
    importedName: exportedName,
    sourceName: member.sourceName,
    specifier: binding.specifier,
    module: member.module,
  }, seen)
}

function resolveImportedCallTarget(
  localName: string,
  binding: Extract<ImportedBinding, {kind: 'resolved'}>,
  seen: Set<string>,
): InterpreterCallTarget {
  const sourceName = binding.sourceName
  const target = resolveIdentifierCallTarget(sourceName, binding.module, seen)
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
  const functionName = `${className}.${access.name.text}`
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
  const sourceFile = declaration.getSourceFile()
  if (sameProgramSourceFile(frame.program, sourceFile)) return frame.program
  return importedPrograms(frame.program).find(program => sameProgramSourceFile(program, sourceFile)) ?? null
}

function importedPrograms(program: Program): Program[] {
  const programs: Program[] = []
  for (const binding of program.imports.values()) {
    if (binding.kind === 'resolved' || binding.kind === 'namespace') programs.push(binding.module)
    if (binding.kind !== 'namespace') continue
    for (const member of binding.members.values()) programs.push(member.module)
  }
  return programs
}

function sameProgramSourceFile(program: Program, sourceFile: ts.SourceFile) {
  return program.sourceFile === sourceFile || program.sourceId === sourceFile.fileName
}

function importedClassBinding(className: string, classProgram: Program, callerProgram: Program): {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>} | null {
  for (const [localName, binding] of callerProgram.imports) {
    if (binding.kind !== 'resolved') continue
    if (binding.module !== classProgram) continue
    if (binding.sourceName === className || binding.importedName === className) return {localName, binding}
  }
  return null
}
