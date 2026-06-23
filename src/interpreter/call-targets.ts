import * as ts from 'typescript'
import type {ImportedBinding, Program} from '../check-types.ts'
import {defaultLibraryMemberIdentity, type FitFunction} from '../modules.ts'
import {
  functionImplementationForDeclaration,
  functionImplementationReference,
  isClassFunctionNode,
  isInlineFunction,
  type FunctionImplementationNode,
  type FunctionImplementationRef,
} from '../function-shape.ts'
import {isAssignmentOperator, unwrapExpression} from './source-syntax.ts'

export type InterpreterCallTarget =
  | {kind: 'platform-global'; base: string; name: string}
  | {
      kind: 'function'
      interpretation: 'interpreted'
      implementation: FunctionImplementationRef
      program: Program
      fn: FitFunction
      imported?: {localName: string; binding: Extract<ImportedBinding, {kind: 'resolved'}>}
    }
  | {
      kind: 'function'
      interpretation: 'effects-only'
      implementation: FunctionImplementationRef
    }
  | {
      kind: 'unresolved'
      cause: 'unknown-function' | 'unsupported-target' | 'unavailable-import'
      reason: string
    }

export type ResolvedFunctionTarget = Extract<InterpreterCallTarget, {interpretation: 'interpreted'}>

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
  const current = unwrapExpression(target)
  const mutableReason = ts.isIdentifier(current) ? mutableFunctionBindingReason(current, program) : null
  if (mutableReason != null) {
    return {
      kind: 'unresolved',
      cause: 'unsupported-target',
      reason: mutableReason,
    }
  }
  const implementation = sourceFunctionImplementation(target, program)
  const indexed = resolveIndexedCallTarget(target, program)
  if (implementation == null) return indexed
  if (
    indexed.kind === 'function'
    && indexed.interpretation === 'interpreted'
    && indexed.program === implementation.program
    && indexed.fn.node === implementation.node
  ) return indexed
  return {kind: 'function', interpretation: 'effects-only', implementation}
}

function resolveIndexedCallTarget(target: ts.Expression, program: Program): InterpreterCallTarget {
  if (ts.isIdentifier(target)) {
    if (!identifierAllowsIndexedFallback(target, program)) {
      return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported function value ${target.text}`}
    }
    return resolveIdentifierCallTarget(target.text, program)
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    if (
      isDefaultLibrarySymbol(target.expression, program)
      && isDefaultLibraryMemberAccess(target, program)
    ) {
      return {kind: 'platform-global', base: target.expression.text, name: target.name.text}
    }
    if (!namespaceAccessAllowsIndexedFallback(target.expression, program)) {
      return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported call ${target.getText()}`}
    }
    return resolveNamespaceMemberCallTarget(target.expression.text, target.name.text, program, new Set())
  }
  return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported call ${target.getText()}`}
}

function sourceFunctionImplementation(
  target: ts.Expression,
  program: Program,
): FunctionImplementationRef | null {
  const checker = program.typeChecker
  const current = unwrapExpression(target)
  if (isInlineFunction(current)) {
    if (!supportedSourceFunction(current)) return null
    const targetProgram = programForSourceFile(current.getSourceFile(), program)
    return targetProgram == null ? null : functionImplementationReference(targetProgram, current)
  }
  if (checker == null) return null
  if (
    !ts.isIdentifier(current)
    && !(ts.isPropertyAccessExpression(current) && isNamespaceImportAccess(current, checker))
  ) return null
  const symbolNode = ts.isPropertyAccessExpression(current) ? current.name : current
  const symbol = checker.getSymbolAtLocation(symbolNode)
  const implementation = symbol == null
    ? null
    : implementationForSymbol(symbol, program, checker, new Set())
  return implementation ?? importedFunctionImplementation(current, program)
}

export function callTargetImplementation(target: InterpreterCallTarget): FunctionImplementationRef | null {
  switch (target.kind) {
    case 'function':
      return target.implementation
    case 'platform-global':
    case 'unresolved':
      return null
  }
}

export function callTargetHasUserBinding(target: ts.Expression, program: Program): boolean {
  if (!ts.isIdentifier(target)) return false
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(target)
  if (symbol == null) return false
  return symbol.declarations?.some(declaration =>
    program.project.typeProgram?.isSourceFileDefaultLibrary(declaration.getSourceFile()) !== true,
  ) === true
}

export function mutableFunctionBindingReason(identifier: ts.Identifier, program: Program): string | null {
  const checker = program.typeChecker
  if (checker == null) return null
  let symbol = checker.getSymbolAtLocation(identifier)
  if (symbol == null) return null
  const seen = new Set<ts.Symbol>()
  while ((symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol)
    symbol = checker.getAliasedSymbol(symbol)
  }
  if (symbol.declarations?.some(declaration =>
    ts.isVariableDeclaration(declaration)
    && (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0) === true) {
    return program.unsupportedCallAliases.get(identifier.text)
      ?? `Mutable function binding ${identifier.text} is unsupported`
  }
  if (symbol.declarations?.some(ts.isFunctionDeclaration) !== true) return null
  return symbol.declarations.some(declaration =>
    sourceFileAssignsSymbol(declaration.getSourceFile(), symbol, checker))
    ? `Function declaration ${identifier.text} is reassigned and unsupported`
    : null
}

function sourceFileAssignsSymbol(sourceFile: ts.SourceFile, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  let assigned = false
  const inspectTarget = (expression: ts.Expression) => {
    for (const identifier of assignedIdentifiers(expression)) {
      if (checker.getSymbolAtLocation(identifier) === symbol) {
        assigned = true
        return
      }
    }
  }
  const visit = (current: ts.Node) => {
    if (assigned) return
    if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
      inspectTarget(current.left)
    } else if (
      (ts.isForOfStatement(current) || ts.isForInStatement(current))
      && !ts.isVariableDeclarationList(current.initializer)
    ) {
      inspectTarget(current.initializer)
    } else if (
      (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
      && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      inspectTarget(current.operand)
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return assigned
}

function assignedIdentifiers(expression: ts.Expression): ts.Identifier[] {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return [current]
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap(property => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name]
      if (ts.isPropertyAssignment(property)) return assignedIdentifiers(property.initializer)
      if (ts.isSpreadAssignment(property)) return assignedIdentifiers(property.expression)
      return []
    })
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap(element => {
      if (ts.isOmittedExpression(element)) return []
      return assignedIdentifiers(ts.isSpreadElement(element) ? element.expression : element)
    })
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignedIdentifiers(current.left)
  }
  return []
}

function implementationForSymbol(
  symbol: ts.Symbol,
  program: Program,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): FunctionImplementationRef | null {
  if (seen.has(symbol)) return null
  seen.add(symbol)
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const target = checker.getAliasedSymbol(symbol)
    return target === symbol ? null : implementationForSymbol(target, program, checker, seen)
  }
  for (const declaration of symbol.declarations ?? []) {
    const implementation = implementationForDeclaration(declaration, program, checker, seen)
    if (implementation != null) return implementation
  }
  return null
}

function implementationForDeclaration(
  declaration: ts.Declaration,
  program: Program,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): FunctionImplementationRef | null {
  if (ts.isVariableDeclaration(declaration)) {
    if (!variableDeclarationIsConst(declaration) || declaration.initializer == null) return null
    return implementationForAliasExpression(declaration.initializer, program, checker, seen)
  }
  const node = functionImplementationForDeclaration(declaration)
  if (node != null && supportedSourceFunction(node)) {
    const targetProgram = programForSourceFile(node.getSourceFile(), program)
    if (targetProgram == null) return null
    if (
      ts.isFunctionDeclaration(node)
      && node.name != null
      && mutableFunctionBindingReason(node.name, targetProgram) != null
    ) return null
    return functionImplementationReference(targetProgram, node)
  }
  if (ts.isExportAssignment(declaration) && !declaration.isExportEquals) {
    return implementationForAliasExpression(declaration.expression, program, checker, seen)
  }
  return null
}

function implementationForAliasExpression(
  expression: ts.Expression,
  program: Program,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): FunctionImplementationRef | null {
  const current = unwrapExpression(expression)
  if (isInlineFunction(current)) {
    if (!supportedSourceFunction(current)) return null
    const targetProgram = programForSourceFile(current.getSourceFile(), program)
    return targetProgram == null ? null : functionImplementationReference(targetProgram, current)
  }
  if (
    !ts.isIdentifier(current)
    && !(ts.isPropertyAccessExpression(current) && isNamespaceImportAccess(current, checker))
  ) return null
  if (ts.isIdentifier(current) && mutableFunctionBindingReason(current, program) != null) return null
  const symbolNode = ts.isPropertyAccessExpression(current) ? current.name : current
  const symbol = checker.getSymbolAtLocation(symbolNode)
  return symbol == null ? null : implementationForSymbol(symbol, program, checker, seen)
}

function supportedSourceFunction(node: FunctionImplementationNode): boolean {
  if (isClassFunctionNode(node)) return false
  return synchronousFunctionNode(node)
}

function synchronousFunctionNode(node: FunctionImplementationNode): boolean {
  if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true) {
    return false
  }
  return !('asteriskToken' in node) || node.asteriskToken == null
}

function variableDeclarationIsConst(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0
}

function isNamespaceImportAccess(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
  const base = unwrapExpression(access.expression)
  if (!ts.isIdentifier(base)) return false
  const symbol = checker.getSymbolAtLocation(base)
  return symbol?.declarations?.some(ts.isNamespaceImport) === true
}

function importedFunctionImplementation(
  target: ts.Identifier | ts.PropertyAccessExpression,
  program: Program,
): FunctionImplementationRef | null {
  let resolved: InterpreterCallTarget
  if (ts.isIdentifier(target)) {
    const binding = program.imports.get(target.text)
    if (binding == null || binding.kind !== 'resolved') return null
    resolved = resolveImportedCallTarget(target.text, binding, new Set())
  } else {
    const namespace = unwrapExpression(target.expression)
    if (!ts.isIdentifier(namespace)) return null
    const binding = program.imports.get(namespace.text)
    if (binding == null || binding.kind !== 'namespace') return null
    resolved = resolveNamespaceMemberCallTarget(namespace.text, target.name.text, program, new Set())
  }
  return resolved.kind === 'function'
    ? resolved.implementation
    : null
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
  const unsupportedAlias = program.unsupportedCallAliases.get(name)
  if (unsupportedAlias != null) return {kind: 'unresolved', cause: 'unsupported-target', reason: unsupportedAlias}

  const local = program.functions.get(name)
  if (local != null) {
    const mutableReason = ts.isFunctionDeclaration(local.node) && local.node.name != null
      ? mutableFunctionBindingReason(local.node.name, program)
      : null
    if (mutableReason != null) {
      return {kind: 'unresolved', cause: 'unsupported-target', reason: mutableReason}
    }
    if (!synchronousFunctionNode(local.node)) {
      return {kind: 'unresolved', cause: 'unsupported-target', reason: `Unsupported async or generator function ${name}`}
    }
    return {
      kind: 'function',
      interpretation: 'interpreted',
      implementation: functionImplementationReference(program, local.node),
      program,
      fn: local,
    }
  }

  const key = `${program.sourceId}#${name}`
  if (seen.has(key)) {
    return {kind: 'unresolved', cause: 'unsupported-target', reason: `Cyclic call alias at ${program.file}#${name}`}
  }
  seen.add(key)

  const alias = program.callAliases.get(name)
  if (alias != null) {
    if (alias.kind === 'platform-global') {
      return {kind: 'platform-global', base: alias.base, name: alias.name}
    }
    if (alias.kind === 'identifier') return resolveIdentifierCallTarget(alias.name, program, seen)
    return resolveNamespaceMemberCallTarget(alias.namespace, alias.exportedName, program, seen)
  }

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
  if (target.kind === 'platform-global' || target.interpretation === 'effects-only') return target
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
  return elementAccessPropertySymbols(access, checker).some(symbol =>
    symbol.declarations?.some(declaration =>
      kind === 'get'
        ? ts.isGetAccessorDeclaration(declaration)
        : ts.isSetAccessorDeclaration(declaration)) === true)
}

export function elementAccessPropertySymbols(
  access: ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): ts.Symbol[] {
  const receiverType = checker.getTypeAtLocation(access.expression)
  const propertyNames = literalPropertyNames(checker.getTypeAtLocation(access.argumentExpression))
  return propertyNames == null
    ? checker.getPropertiesOfType(receiverType)
    : propertyNames.flatMap(name => checker.getPropertyOfType(receiverType, name) ?? [])
}

function literalPropertyNames(type: ts.Type): string[] | null {
  if (type.isUnion()) {
    const names = type.types.flatMap(member => literalPropertyNames(member) ?? [])
    return names.length === type.types.length ? names : null
  }
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) return [(type as ts.StringLiteralType).value]
  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) return [String((type as ts.NumberLiteralType).value)]
  return null
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
  const checker = program.typeChecker
  if (checker == null || receiverHasSourceClass(access.expression, checker, program)) return false
  const identity = defaultLibraryMemberIdentity(checker.getSymbolAtLocation(access.name), checker, program.project)
  return identity != null
}

export function isDefaultLibraryElementAccess(access: ts.ElementAccessExpression, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return false
  if (receiverHasSourceClass(access.expression, checker, program)) return false
  const symbols = elementAccessPropertySymbols(access, checker)
  const identities = symbols.flatMap(symbol => {
    const identity = defaultLibraryMemberIdentity(symbol, checker, program.project)
    return identity == null ? [] : [identity]
  })
  return identities.length > 0
}

export function defaultLibraryOwner(
  access: ts.PropertyAccessExpression,
  program: Program,
): DefaultLibraryOwner {
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(access.name)
  if (symbol == null || checker == null) return 'Other'
  const owner = defaultLibraryMemberIdentity(symbol, checker, program.project)?.owner
  if (owner === 'Array' || owner === 'ReadonlyArray' || owner === 'Map' || owner === 'ReadonlyMap'
    || owner === 'Set' || owner === 'ReadonlySet' || owner === 'String') return owner
  if (owner != null && typedArrayNames.has(owner)) return 'TypedArray'
  return 'Other'
}

function receiverHasSourceClass(expression: ts.Expression, checker: ts.TypeChecker, program: Program): boolean {
  const hasSourceClass = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(hasSourceClass)
    return type.getSymbol()?.declarations?.some(declaration =>
      ts.isClassDeclaration(declaration)
      && program.project.typeProgram?.isSourceFileDefaultLibrary(declaration.getSourceFile()) !== true,
    ) === true
  }
  try {
    return hasSourceClass(checker.getTypeAtLocation(expression))
  } catch {
    return true
  }
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
  return program.sourceFile === sourceFile
}
