import * as ts from 'typescript'
import type {Program} from './check-types.ts'
import type {FitValueSpec} from './parser.ts'

export type FitValueSpecTypeEnv = {
  program: Program
  spec: FitValueSpec
  substitutions: Map<string, ts.TypeNode>
  seen: Set<string>
}

export type FitValueSpecResolvedType =
  | {
      kind: 'node'
      node: ts.TypeNode
      env: FitValueSpecTypeEnv
    }
  | {
      kind: 'members'
      members: ts.NodeArray<ts.TypeElement>
      env: FitValueSpecTypeEnv
    }
  | {
      kind: 'array'
      element: ts.TypeNode
      env: FitValueSpecTypeEnv
    }

export function createFitValueSpecTypeEnv(program: Program, spec: FitValueSpec): FitValueSpecTypeEnv {
  return {program, spec, substitutions: new Map(), seen: new Set()}
}

export function fitValueSpecTupleElementType(node: ts.TypeNode | ts.NamedTupleMember): ts.TypeNode | null {
  if (ts.isNamedTupleMember(node) || ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node)) return null
  return node
}

export function withResolvedFitValueSpecTypeReference<T>(
  node: ts.TypeReferenceNode,
  env: FitValueSpecTypeEnv,
  visit: (resolved: FitValueSpecResolvedType) => T,
): T | null {
  const substituted = substitutedTypeParameter(node, env)
  if (substituted != null) return visit({kind: 'node', node: substituted, env})

  const arrayElement = arrayElementTypeArgument(node)
  if (arrayElement != null) return visit({kind: 'array', element: arrayElement, env})

  const declaration = fitValueSpecTypeDeclaration(node, env.program)
  if (declaration == null) return null

  const key = fitValueSpecDeclarationKey(declaration, node)
  if (env.seen.has(key)) return null
  env.seen.add(key)
  try {
    const childEnv = childTypeEnv(env, declaration, node)
    return ts.isInterfaceDeclaration(declaration)
      ? visit({kind: 'members', members: declaration.members, env: childEnv})
      : visit({kind: 'node', node: declaration.type, env: childEnv})
  } finally {
    env.seen.delete(key)
  }
}

function substitutedTypeParameter(node: ts.TypeReferenceNode, env: FitValueSpecTypeEnv) {
  if (!ts.isIdentifier(node.typeName) || node.typeArguments != null) return null
  return env.substitutions.get(node.typeName.text) ?? null
}

function arrayElementTypeArgument(node: ts.TypeReferenceNode) {
  if (!ts.isIdentifier(node.typeName)) return null
  const name = node.typeName.text
  if (name !== 'Array' && name !== 'ReadonlyArray') return null
  return node.typeArguments?.[0] ?? null
}

function childTypeEnv(env: FitValueSpecTypeEnv, declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, node: ts.TypeReferenceNode): FitValueSpecTypeEnv {
  const substitutions = new Map(env.substitutions)
  const typeParameters = declaration.typeParameters ?? []
  for (const [index, parameter] of typeParameters.entries()) {
    const argument = node.typeArguments?.[index] ?? parameter.default
    if (argument != null) substitutions.set(parameter.name.text, argument)
  }
  return {...env, substitutions}
}

function fitValueSpecDeclarationKey(declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, node: ts.TypeReferenceNode) {
  return `${declaration.getSourceFile().fileName}:${declaration.pos}:${node.typeArguments?.map(argument => argument.getText()).join(',') ?? ''}`
}

function fitValueSpecTypeDeclaration(node: ts.TypeReferenceNode, program: Program): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  if (ts.isIdentifier(node.typeName)) {
    return localTypeDeclaration(program.sourceFile, node.typeName.text)
      ?? importedTypeDeclaration(program, node.typeName.text)
  }
  return importedNamespaceTypeDeclaration(program, node.typeName)
}

function localTypeDeclaration(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  for (const statement of sourceFile.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === name) return statement
  }
  return null
}

function importedTypeDeclaration(program: Program, localName: string): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  if (program.typeChecker == null) return null
  for (const statement of program.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const namedBindings = statement.importClause?.namedBindings
    if (namedBindings == null || !ts.isNamedImports(namedBindings)) continue
    for (const element of namedBindings.elements) {
      if (element.name.text !== localName) continue
      return typeDeclarationFromSymbol(program.typeChecker, program.typeChecker.getSymbolAtLocation(element.name))
    }
  }
  return null
}

function importedNamespaceTypeDeclaration(program: Program, name: ts.EntityName): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  if (program.typeChecker == null || !ts.isQualifiedName(name)) return null
  const namespace = leftmostIdentifier(name.left)
  if (namespace == null) return null
  const exportedName = rightmostName(name)
  for (const statement of program.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const namedBindings = statement.importClause?.namedBindings
    if (namedBindings == null || !ts.isNamespaceImport(namedBindings) || namedBindings.name.text !== namespace) continue
    const moduleSymbol = aliasedSymbol(program.typeChecker, program.typeChecker.getSymbolAtLocation(namedBindings.name))
    const exported = moduleSymbol == null ? undefined : program.typeChecker.getExportsOfModule(moduleSymbol).find(item => item.name === exportedName)
    const declaration = typeDeclarationFromSymbol(program.typeChecker, exported)
    if (declaration != null) return declaration
  }
  return null
}

function typeDeclarationFromSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  const target = aliasedSymbol(checker, symbol)
  const declaration = target?.declarations?.find(isSupportedTypeDeclaration) ?? null
  return declaration != null && isSupportedSourceFile(declaration.getSourceFile()) ? declaration : null
}

function aliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined) {
  return symbol != null && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
}

function isSupportedTypeDeclaration(node: ts.Declaration): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
}

function isSupportedSourceFile(sourceFile: ts.SourceFile) {
  return !sourceFile.isDeclarationFile
    && (sourceFile.fileName.endsWith('.ts') || sourceFile.fileName.endsWith('.tsx') || sourceFile.fileName.endsWith('.mts') || sourceFile.fileName.endsWith('.cts'))
    && !sourceFile.fileName.includes('/node_modules/')
}

function leftmostIdentifier(name: ts.EntityName): string | null {
  if (ts.isIdentifier(name)) return name.text
  return leftmostIdentifier(name.left)
}

function rightmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text
}
