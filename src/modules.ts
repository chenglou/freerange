import * as ts from 'typescript'
import {
  parseFunctionBodyFitSpecIndex,
  parseFunctionFitSpecs,
  parseTopLevelFitSpecIndex,
  type FitBodySpecIndex,
  type FitSpec,
} from './parser.ts'
import {
  createTypeContractTemplateIndex,
  type TypeContractTemplateIndex,
} from './type-contracts.ts'
import {
  classMemberFunctionName,
  isClassFunctionNode,
  isFunctionImplementation,
  isInlineFunction,
  type FunctionImplementationNode,
  type InlineFunctionNode,
} from './function-shape.ts'
import {formatTypeScriptDiagnostics} from './ts-diagnostics.ts'

export type FitFunction = {
  name: string
  node: FunctionImplementationNode
  specNode: ts.Node
  explicitSpecs: FitSpec[]
  bodySpecs: FitBodySpecIndex
}

export type FitProjectIndex<TGlobal> = {
  files: Map<string, FitProjectFile<TGlobal>>
  filesBySourceFile: Map<ts.SourceFile, FitProjectFile<TGlobal>>
  compilerOptions: ts.CompilerOptions
  rootNames: string[]
  // The program these files were parsed and bound by. Contract type-checking
  // builds its own program over contract-spliced twins, but shares these
  // already-parsed SourceFiles (lib.d.ts dominates) instead of re-reading the
  // world. Absent only on the standalone parse path that has no program.
  typeProgram?: ts.Program
}

export type FitProjectFile<TGlobal> = {
  project: FitProjectIndex<TGlobal>
  sourceId: string
  file: string
  sourceFile: ts.SourceFile
  sourceText: string
  typeChecker: ts.TypeChecker | null
  typeContracts: TypeContractTemplateIndex
}

export type FitFile<TGlobal> = FitProjectFile<TGlobal> & {
  globals: Map<string, TGlobal>
  functions: Map<string, FitFunction>
  callAliases: Map<string, FitCallAlias>
  unsupportedCallAliases: Map<string, string>
  topLevelBodySpecs: FitBodySpecIndex
  imports: Map<string, FitImportBinding<FitFile<TGlobal>>>
}

export type FitProject<TGlobal> = FitProjectIndex<TGlobal> & {
  entries: FitFile<TGlobal>[]
  configFile: string | null
}

export type FitProjectLoadTiming = {
  configMs: number
  typeProgramMs: number
  typeCheckerMs: number
  fileReadMs: number
  fileParseMs: number
  importResolveMs: number
}

export type FitImportBinding<TFile> =
  | {
      kind: 'resolved'
      importedName: string
      sourceName: string
      specifier: string
      file: TFile
    }
  | {
      kind: 'namespace'
      importedName: '*'
      specifier: string
      file: TFile
      members: Map<string, FitImportSource<TFile>>
    }
  | {
      kind: 'unresolved'
      exportedName: string
      specifier: string
      reason: string
    }

export type FitImportSource<TFile> = {
  sourceName: string
  file: TFile
}

export type FitCallAlias =
  | {
      kind: 'math'
      name: string
    }
  | {
      kind: 'identifier'
      name: string
    }
  | {
      kind: 'namespace-member'
      namespace: string
      exportedName: string
    }

export type TopLevelGlobalReader<TGlobal> = (declaration: ts.VariableDeclaration) => {name: string; value: TGlobal} | null

export class TypeScriptUserlandError extends Error {
  constructor(readonly diagnostics: readonly ts.Diagnostic[]) {
    super(formatTypeScriptDiagnostics(diagnostics))
    this.name = 'TypeScriptUserlandError'
  }
}

type LoadFitProjectOptions = {
  timing?: FitProjectLoadTiming
}

type ResolutionContext = {
  compilerOptions: ts.CompilerOptions
  configFile: string | null
  configDiagnostics: readonly ts.Diagnostic[]
  cache: ts.ModuleResolutionCache
  typeProgram: ts.Program
  typeChecker: ts.TypeChecker
  rootNames: string[]
  // Package sources reached through declaration maps (and their internal
  // imports). Their authors already typechecked them; their diagnostics are
  // not the user's preflight errors.
  packageSources: Set<string>
}

type ResolvedImport =
  | {kind: 'source'; sourceId: string}
  | {kind: 'unresolved'; reason: string}

export function loadFitProject<TGlobal>(
  paths: string[],
  readGlobal: TopLevelGlobalReader<TGlobal>,
  options: LoadFitProjectOptions = {},
): FitProject<TGlobal> {
  const resolution = createResolutionContext(paths, options.timing)
  throwOnUserlandTypeDiagnostics(resolution)
  const project: FitProject<TGlobal> = {
    entries: [],
    files: new Map(),
    filesBySourceFile: new Map(),
    compilerOptions: resolution.compilerOptions,
    rootNames: resolution.rootNames,
    configFile: resolution.configFile,
    typeProgram: resolution.typeProgram,
  }

  for (const sourceFile of resolution.typeProgram.getSourceFiles()) {
    if (!isSupportedFitSourceFile(sourceFile)) continue
    parseProjectSourceFile(sourceFile, project, resolution)
  }

  project.entries = paths.map(path => loadProjectFile(toSourceId(path), project, resolution, readGlobal, options.timing))
  return project
}

export function createFitProjectLoadTiming(): FitProjectLoadTiming {
  return {
    configMs: 0,
    typeProgramMs: 0,
    typeCheckerMs: 0,
    fileReadMs: 0,
    fileParseMs: 0,
    importResolveMs: 0,
  }
}

export function resolveFitProjectPaths(paths: string[]): {paths: string[]; configFile: string | null} {
  if (paths.length > 0) return {paths, configFile: findConfigFile(paths)}
  const configFile = findConfigFile([])
  if (configFile == null) return {paths: [], configFile: null}
  const parsed = readParsedConfig(configFile)
  return {
    paths: parsed.fileNames.filter(isSupportedSourcePath).map(displayPath),
    configFile,
  }
}

export function buildFitSourceFile<TGlobal>(
  file: string,
  sourceText: string,
  readGlobal: TopLevelGlobalReader<TGlobal>,
): FitFile<TGlobal> {
  const sourceId = toSourceId(file)
  const compilerOptions = defaultCompilerOptions()
  const host = ts.createCompilerHost(compilerOptions)
  const baseGetSourceFile = host.getSourceFile.bind(host)
  const baseReadFile = host.readFile.bind(host)
  const baseFileExists = host.fileExists.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === sourceId) return ts.createSourceFile(sourceId, sourceText, languageVersion, true, scriptKindForFile(sourceId))
    return baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  }
  host.readFile = fileName => fileName === sourceId ? sourceText : baseReadFile(fileName)
  host.fileExists = fileName => fileName === sourceId ? true : baseFileExists(fileName)
  const typeProgram = ts.createProgram([sourceId], compilerOptions, host)
  const typeChecker = typeProgram.getTypeChecker()
  const sourceFile = typeProgram.getSourceFile(sourceId)
    ?? ts.createSourceFile(sourceId, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(sourceId))
  throwOnUserlandTypeDiagnostics({typeProgram, configDiagnostics: []})
  const project: FitProjectIndex<TGlobal> = {files: new Map(), filesBySourceFile: new Map(), compilerOptions, rootNames: [sourceId], typeProgram}
  const fitFile = parseFitFile(sourceId, displayPath(sourceId), sourceText, readGlobal, typeChecker, sourceFile, typeProgram.getSyntacticDiagnostics(sourceFile), project)
  project.files.set(cacheKeyFor(sourceId), fitFile)
  project.filesBySourceFile.set(sourceFile, fitFile)
  return fitFile
}

function throwOnSyntaxDiagnostics(sourceFile: ts.SourceFile, diagnostics: readonly ts.Diagnostic[] = sourceFileParseDiagnostics(sourceFile)) {
  if (diagnostics.length === 0) return
  throw new TypeScriptUserlandError(diagnostics.map(diagnostic => diagnostic.file == null && diagnostic.start != null ? {...diagnostic, file: sourceFile} : diagnostic))
}

function sourceFileParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as ts.SourceFile & {parseDiagnostics?: readonly ts.Diagnostic[]}).parseDiagnostics ?? []
}

function throwOnUserlandTypeDiagnostics(source: Pick<ResolutionContext, 'typeProgram' | 'configDiagnostics'> & {packageSources?: Set<string>}) {
  const packageSources = source.packageSources ?? new Set<string>()
  const diagnostics = [
    ...source.configDiagnostics,
    ...ts.getPreEmitDiagnostics(source.typeProgram).filter(diagnostic =>
      diagnostic.file == null || !packageSources.has(normalizePath(diagnostic.file.fileName))),
  ]
  if (diagnostics.length === 0) return
  throw new TypeScriptUserlandError(diagnostics)
}

function parseProjectSourceFile<TGlobal>(
  sourceFile: ts.SourceFile,
  project: FitProject<TGlobal>,
  resolution: ResolutionContext,
): FitProjectFile<TGlobal> {
  const sourceId = normalizePath(sourceFile.fileName)
  const cacheKey = cacheKeyFor(sourceId)
  const existing = project.files.get(cacheKey)
  if (existing != null) return existing
  const fitFile = parseTypeFile(sourceId, displayPath(sourceId), sourceFile.text, resolution.typeChecker, sourceFile, project)
  project.files.set(cacheKey, fitFile)
  project.filesBySourceFile.set(sourceFile, fitFile)
  return fitFile
}

function loadProjectFile<TGlobal>(
  file: string,
  project: FitProject<TGlobal>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
): FitFile<TGlobal> {
  const sourceId = toSourceId(file)
  const cacheKey = cacheKeyFor(sourceId)
  const existing = project.files.get(cacheKey)
  if (existing != null && isFitFile(existing)) return existing
  let sourceText = existing?.sourceText
  if (sourceText == null) {
    const readStart = performance.now()
    sourceText = ts.sys.readFile(sourceId)
    addTiming(timing, 'fileReadMs', readStart)
  }
  if (sourceText == null) throw new Error(`Could not read ${displayPath(sourceId)}`)

  const sourceFile = existing?.sourceFile ?? resolution.typeProgram.getSourceFile(sourceId)
    ?? ts.createSourceFile(sourceId, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(sourceId))
  const programSourceFile = resolution.typeProgram.getSourceFile(sourceId)
  const syntaxDiagnostics = programSourceFile == null
    ? sourceFileParseDiagnostics(sourceFile)
    : resolution.typeProgram.getSyntacticDiagnostics(programSourceFile)
  const parseStart = performance.now()
  const typeChecker = programSourceFile == null ? null : resolution.typeChecker
  const fitFile = parseFitFile(sourceId, displayPath(sourceId), sourceText, readGlobal, typeChecker, sourceFile, syntaxDiagnostics, project, existing?.typeContracts)
  addTiming(timing, 'fileParseMs', parseStart)
  project.files.set(cacheKey, fitFile)
  project.filesBySourceFile.set(sourceFile, fitFile)
  loadImports(fitFile, project, resolution, readGlobal, timing)
  return fitFile
}

function isFitFile<TGlobal>(file: FitProjectFile<TGlobal>): file is FitFile<TGlobal> {
  return 'functions' in file
}

function parseTypeFile<TGlobal>(
  sourceId: string,
  file: string,
  sourceText: string,
  typeChecker: ts.TypeChecker | null,
  sourceFile: ts.SourceFile,
  project: FitProjectIndex<TGlobal>,
): FitProjectFile<TGlobal> {
  return {
    project,
    sourceId,
    file,
    sourceFile,
    sourceText,
    typeChecker,
    typeContracts: createTypeContractTemplateIndex(sourceText, sourceFile),
  }
}

function parseFitFile<TGlobal>(
  sourceId: string,
  file: string,
  sourceText: string,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  typeChecker: ts.TypeChecker | null = null,
  sourceFile: ts.SourceFile = ts.createSourceFile(sourceId, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(sourceId)),
  syntaxDiagnostics?: readonly ts.Diagnostic[],
  project: FitProjectIndex<TGlobal> = {files: new Map(), filesBySourceFile: new Map(), compilerOptions: defaultCompilerOptions(), rootNames: [sourceId]},
  typeContracts: TypeContractTemplateIndex = createTypeContractTemplateIndex(sourceText, sourceFile),
): FitFile<TGlobal> {
  throwOnSyntaxDiagnostics(sourceFile, syntaxDiagnostics)

  const globals = new Map<string, TGlobal>()
  const functions = new Map<string, FitFunction>()
  const callAliases = new Map<string, FitCallAlias>()
  const unsupportedCallAliases = new Map<string, string>()
  const imports = new Map<string, FitImportBinding<FitFile<TGlobal>>>()

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (!isFunctionImplementation(statement)) continue
      const isDefaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      const functionName = statement.name?.text ?? (isDefaultExport ? 'default' : null)
      if (functionName == null) continue
      collectFitFunction(sourceText, file, functionName, statement, statement, functions)
      continue
    }
    if (ts.isClassDeclaration(statement) && statement.name != null) {
      collectClassMemberFunctions(sourceText, file, statement, functions)
      continue
    }
    if (ts.isExportDeclaration(statement)) continue
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const functionInitializer = supportedFunctionInitializer(statement.expression)
      if (functionInitializer == null) {
        const alias = callAliasFromExpression(statement.expression)
        if (alias != null) callAliases.set('default', alias)
        continue
      }
      collectFitFunction(sourceText, file, 'default', functionInitializer, statement, functions)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    const isConst = isConstVariableStatement(statement)
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const functionInitializer = declaration.initializer == null ? null : supportedFunctionInitializer(declaration.initializer)
        if (functionInitializer != null) {
          collectFitFunction(sourceText, file, declaration.name.text, functionInitializer, statement, functions)
        }
        const alias = functionInitializer == null && declaration.initializer != null
          ? callAliasFromExpression(declaration.initializer)
          : null
        if (alias != null) collectCallAlias(declaration.name.text, alias, isConst, callAliases, unsupportedCallAliases)
      } else if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer != null && isIdentifierText(declaration.initializer, 'Math')) {
        for (const alias of mathDestructuringAliases(declaration.name)) {
          collectCallAlias(alias.localName, {kind: 'math', name: alias.exportedName}, isConst, callAliases, unsupportedCallAliases)
        }
      }
      const global = readGlobal(declaration)
      if (global == null) continue
      globals.set(global.name, global.value)
    }
  }

  const topLevelBodySpecs = parseTopLevelFitSpecIndex(
    sourceText,
    sourceFile,
    new Set([...functions.values()].map(fn => fn.node)),
  )
  return {project, sourceId, file, sourceFile, sourceText, typeChecker, globals, functions, callAliases, unsupportedCallAliases, topLevelBodySpecs, typeContracts, imports}
}

function collectClassMemberFunctions(
  sourceText: string,
  file: string,
  declaration: ts.ClassDeclaration,
  functions: Map<string, FitFunction>,
) {
  for (const member of declaration.members) {
    if (!isClassFunctionNode(member) || !isFunctionImplementation(member)) continue
    const memberName = classMemberFunctionName(declaration.name!.text, member)
    if (memberName == null) continue
    collectFitFunction(sourceText, file, memberName, member, member, functions)
  }
}

function collectFitFunction(
  sourceText: string,
  file: string,
  name: string,
  node: FunctionImplementationNode,
  specNode: ts.Node,
  functions: Map<string, FitFunction>,
) {
  if (functions.has(name)) throw new Error(`Unsupported duplicate function implementation ${name} in ${file}`)
  const explicitSpecs = parseFunctionFitSpecs(sourceText, specNode, node.parameters)
  const bodySpecs = parseFunctionBodyFitSpecIndex(sourceText, node)
  const fn = {name, node, specNode, explicitSpecs, bodySpecs}
  functions.set(fn.name, fn)
}

function supportedFunctionInitializer(expression: ts.Expression): InlineFunctionNode | null {
  return isInlineFunction(expression) ? expression : null
}

function isConstVariableStatement(statement: ts.VariableStatement) {
  return (ts.getCombinedNodeFlags(statement.declarationList) & ts.NodeFlags.Const) !== 0
}

function collectCallAlias(
  localName: string,
  alias: FitCallAlias,
  isConst: boolean,
  callAliases: Map<string, FitCallAlias>,
  unsupportedCallAliases: Map<string, string>,
) {
  if (isConst) callAliases.set(localName, alias)
  else unsupportedCallAliases.set(localName, mutableCallAliasReason(localName))
}

function mutableCallAliasReason(name: string) {
  return `${name} is a mutable helper alias; Freerange only follows const helper aliases`
}

function callAliasFromExpression(expression: ts.Expression): FitCallAlias | null {
  const unwrapped = unwrapAliasExpression(expression)
  if (ts.isIdentifier(unwrapped)) return {kind: 'identifier', name: unwrapped.text}
  if (!ts.isPropertyAccessExpression(unwrapped)) return null
  if (!ts.isIdentifier(unwrapped.name)) return null
  if (isIdentifierText(unwrapped.expression, 'Math')) return {kind: 'math', name: unwrapped.name.text}
  if (ts.isIdentifier(unwrapped.expression)) {
    return {kind: 'namespace-member', namespace: unwrapped.expression.text, exportedName: unwrapped.name.text}
  }
  return null
}

function unwrapAliasExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrapAliasExpression(expression.expression)
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return unwrapAliasExpression(expression.expression)
  }
  if (ts.isNonNullExpression(expression)) return unwrapAliasExpression(expression.expression)
  return expression
}

function isIdentifierText(node: ts.Node, text: string): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === text
}

function mathDestructuringAliases(pattern: ts.ObjectBindingPattern): {localName: string; exportedName: string}[] {
  const aliases: {localName: string; exportedName: string}[] = []
  for (const element of pattern.elements) {
    if (element.dotDotDotToken != null || element.initializer != null) continue
    if (!ts.isIdentifier(element.name)) continue
    const exportedName = element.propertyName == null
      ? element.name.text
      : ts.isIdentifier(element.propertyName) ? element.propertyName.text : null
    if (exportedName == null) continue
    aliases.push({localName: element.name.text, exportedName})
  }
  return aliases
}

function loadImports<TGlobal>(
  file: FitFile<TGlobal>,
  project: FitProject<TGlobal>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
) {
  for (const statement of file.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const importClause = statement.importClause
    const importIsTypeOnly = importClause?.isTypeOnly === true
    if (importClause?.name != null) {
      file.imports.set(importClause.name.text, importIsTypeOnly
        ? unresolvedImport('default', specifier, `Type-only imports cannot provide @fit helpers: ${specifier}`)
        : sourceImportBinding(file, project, resolution, readGlobal, timing, importClause.name, 'default', specifier))
    }

    const namedBindings = importClause?.namedBindings
    if (namedBindings == null) continue
    if (ts.isNamespaceImport(namedBindings)) {
      file.imports.set(namedBindings.name.text, importIsTypeOnly
        ? unresolvedImport('*', specifier, `Type-only imports cannot provide @fit helpers: ${specifier}`)
        : sourceNamespaceImportBinding(file, project, resolution, readGlobal, timing, namedBindings.name, specifier))
      continue
    }
    if (!ts.isNamedImports(namedBindings)) continue

    for (const element of namedBindings.elements) {
      const localName = element.name.text
      const exportedName = element.propertyName?.text ?? localName
      if (statement.importClause?.isTypeOnly === true || element.isTypeOnly) {
        file.imports.set(localName, unresolvedImport(exportedName, specifier, `Type-only imports cannot provide @fit helpers: ${specifier}`))
        continue
      }

      file.imports.set(localName, sourceImportBinding(file, project, resolution, readGlobal, timing, element.name, exportedName, specifier))
    }
  }
}

function unresolvedImport<TGlobal>(exportedName: string, specifier: string, reason: string): FitImportBinding<FitFile<TGlobal>> {
  return {kind: 'unresolved', exportedName, specifier, reason}
}

function sourceImportBinding<TGlobal>(
  file: FitFile<TGlobal>,
  project: FitProject<TGlobal>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
  localIdentifier: ts.Identifier,
  importedName: string,
  specifier: string,
): FitImportBinding<FitFile<TGlobal>> {
  const target = sourceImportSourceFromSymbol(resolution.typeChecker.getSymbolAtLocation(localIdentifier), project, resolution, readGlobal, timing)
  if (target != null) return {kind: 'resolved', importedName, specifier, ...target}

  const resolved = resolveImport(file, specifier, resolution, timing)
  if (resolved.kind === 'unresolved') return unresolvedImport(importedName, specifier, resolved.reason)
  const importedFile = loadProjectFile(resolved.sourceId, project, resolution, readGlobal, timing)
  return {kind: 'resolved', importedName, sourceName: importedName, specifier, file: importedFile}
}

function sourceNamespaceImportBinding<TGlobal>(
  file: FitFile<TGlobal>,
  project: FitProject<TGlobal>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
  namespaceIdentifier: ts.Identifier,
  specifier: string,
): FitImportBinding<FitFile<TGlobal>> {
  const resolved = resolveImport(file, specifier, resolution, timing)
  if (resolved.kind === 'unresolved') return unresolvedImport('*', specifier, resolved.reason)
  const importedFile = loadProjectFile(resolved.sourceId, project, resolution, readGlobal, timing)
  return {
    kind: 'namespace',
    importedName: '*',
    specifier,
    file: importedFile,
    members: sourceNamespaceMembers(project, resolution, readGlobal, timing, namespaceIdentifier),
  }
}

function sourceNamespaceMembers<TGlobal>(
  project: FitProject<TGlobal>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
  namespaceIdentifier: ts.Identifier,
): Map<string, FitImportSource<FitFile<TGlobal>>> {
  const members = new Map<string, FitImportSource<FitFile<TGlobal>>>()
  const symbol = resolution.typeChecker.getSymbolAtLocation(namespaceIdentifier)
  const target = symbol != null && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? resolution.typeChecker.getAliasedSymbol(symbol)
    : symbol
  const exports = target == null ? [] : resolution.typeChecker.getExportsOfModule(target)
  for (const exported of exports) {
    const source = sourceImportSourceFromSymbol(exported, project, resolution, readGlobal, timing)
    if (source != null) members.set(exported.name, source)
  }
  return members
}

function sourceImportSourceFromSymbol<TGlobal>(
  symbol: ts.Symbol | undefined,
  project: FitProject<TGlobal>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
): FitImportSource<FitFile<TGlobal>> | null {
  const target = symbol != null && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? resolution.typeChecker.getAliasedSymbol(symbol)
    : symbol
  const declaration = target?.valueDeclaration ?? target?.declarations?.find(isSourceImportDeclaration)
  if (declaration == null || !isSourceImportDeclaration(declaration)) return null
  const sourceName = sourceNameForDeclaration(declaration)
  if (sourceName == null) return null
  const sourceId = sourceIdForDeclaration(declaration)
  if (sourceId == null) return null
  return {
    sourceName,
    file: loadProjectFile(sourceId, project, resolution, readGlobal, timing),
  }
}

function isSourceImportDeclaration(node: ts.Declaration): node is ts.FunctionDeclaration | ts.VariableDeclaration | ts.ClassDeclaration | ts.ExportAssignment {
  return ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node) || ts.isExportAssignment(node)
}

function sourceNameForDeclaration(declaration: ts.FunctionDeclaration | ts.VariableDeclaration | ts.ClassDeclaration | ts.ExportAssignment): string | null {
  if (ts.isFunctionDeclaration(declaration)) return declaration.name?.text ?? (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) ? 'default' : null)
  if (ts.isVariableDeclaration(declaration)) return ts.isIdentifier(declaration.name) ? declaration.name.text : null
  if (ts.isClassDeclaration(declaration)) return declaration.name?.text ?? (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) ? 'default' : null)
  return 'default'
}

function sourceIdForDeclaration(declaration: ts.Declaration): string | null {
  const sourceFile = declaration.getSourceFile()
  const sourceId = sourceFile.isDeclarationFile ? sourceFromDeclarationMap(sourceFile.fileName) : normalizePath(sourceFile.fileName)
  return sourceId != null && isSupportedSourcePath(sourceId) && fileExists(sourceId) && !isNodeModulesPath(sourceId)
    ? sourceId
    : null
}

function resolveImport<TGlobal>(file: FitFile<TGlobal>, specifier: string, resolution: ResolutionContext, timing: FitProjectLoadTiming | undefined): ResolvedImport {
  const start = performance.now()
  const result = ts.resolveModuleName(specifier, file.sourceId, resolution.compilerOptions, ts.sys, resolution.cache)
  addTiming(timing, 'importResolveMs', start)
  const resolved = result.resolvedModule
  if (resolved == null) {
    return {
      kind: 'unresolved',
      reason: `Could not resolve ${specifier} from ${file.file} with TypeScript module resolution`,
    }
  }
  if (isDeclarationExtension(resolved.extension)) {
    const sourceId = sourceFromDeclarationMap(resolved.resolvedFileName)
    if (sourceId != null) return {kind: 'source', sourceId}
    if (resolved.isExternalLibraryImport) {
      return {
        kind: 'unresolved',
        reason: `External package imports cannot be checked as @fit helpers: ${specifier}`,
      }
    }
    return {
      kind: 'unresolved',
      reason: `Declaration-only imports cannot be checked as @fit helpers: ${specifier}`,
    }
  }
  if (resolved.isExternalLibraryImport) {
    return {
      kind: 'unresolved',
      reason: `External package imports cannot be checked as @fit helpers: ${specifier}`,
    }
  }
  if (!isSupportedSourceExtension(resolved.extension)) {
    return {
      kind: 'unresolved',
      reason: `Only TypeScript source imports are supported for @fit helpers: ${specifier}`,
    }
  }
  return {kind: 'source', sourceId: normalizePath(resolved.resolvedFileName)}
}

function isSupportedFitSourceFile(sourceFile: ts.SourceFile) {
  return !sourceFile.isDeclarationFile
    && isSupportedSourcePath(sourceFile.fileName)
    && !isNodeModulesPath(sourceFile.fileName)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function createResolutionContext(paths: string[], timing: FitProjectLoadTiming | undefined): ResolutionContext {
  const configStart = performance.now()
  const configFile = findConfigFile(paths)
  const parsedConfig = configFile == null ? null : readParsedConfig(configFile)
  const compilerOptions = parsedConfig?.options ?? defaultCompilerOptions()
  addTiming(timing, 'configMs', configStart)

  const typeProgramStart = performance.now()
  const cache = ts.createModuleResolutionCache(cwd(), cacheKeyFor, compilerOptions)
  // Imports into packages that ship declaration maps resolve to their real
  // sources; those must be program members so their files get a type checker.
  // Emit-layout options would reject roots outside the project (TS6059) and
  // are meaningless for this in-memory, never-emitted program.
  const discovered = discoverDeclarationMappedSources(typeProgramRootNames(paths, parsedConfig), compilerOptions, cache)
  const rootNames = [...new Set([...typeProgramRootNames(paths, parsedConfig), ...discovered.mapped])]
  const programOptions: ts.CompilerOptions = {...compilerOptions, noEmit: true}
  delete programOptions.rootDir
  delete programOptions.composite
  delete programOptions.declaration
  delete programOptions.declarationMap
  delete programOptions.declarationDir
  delete programOptions.emitDeclarationOnly
  delete programOptions.tsBuildInfoFile
  delete programOptions.incremental
  const typeProgram = ts.createProgram(rootNames, programOptions)
  addTiming(timing, 'typeProgramMs', typeProgramStart)

  const typeCheckerStart = performance.now()
  const typeChecker = typeProgram.getTypeChecker()
  addTiming(timing, 'typeCheckerMs', typeCheckerStart)

  return {
    compilerOptions,
    configFile,
    configDiagnostics: parsedConfig?.errors ?? [],
    cache,
    typeProgram,
    typeChecker,
    rootNames,
    packageSources: discovered.packageSources,
  }
}

// A cheap syntactic walk over the static import graph, following declaration
// maps into package sources. Only the mapped entry files need returning: the
// program pulls their internal module graphs itself.
function discoverDeclarationMappedSources(rootNames: string[], compilerOptions: ts.CompilerOptions, cache: ts.ModuleResolutionCache): {mapped: string[]; packageSources: Set<string>} {
  const seen = new Set<string>()
  const mapped = new Set<string>()
  const packageSources = new Set<string>()
  const queue: {file: string; insidePackage: boolean}[] = rootNames.map(file => ({file, insidePackage: false}))
  while (queue.length > 0) {
    const {file, insidePackage} = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (insidePackage) packageSources.add(file)
    const text = readFile(file)
    if (text == null) continue
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
    for (const statement of sourceFile.statements) {
      const specifier = importedModuleSpecifier(statement)
      if (specifier == null) continue
      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys, cache).resolvedModule
      if (resolved == null) continue
      if (isDeclarationExtension(resolved.extension)) {
        const source = sourceFromDeclarationMap(resolved.resolvedFileName)
        if (source != null) {
          mapped.add(source)
          queue.push({file: source, insidePackage: true})
        }
        continue
      }
      if (isSupportedSourceExtension(resolved.extension)) {
        queue.push({file: normalizePath(resolved.resolvedFileName), insidePackage})
      }
    }
  }
  return {mapped: [...mapped], packageSources}
}

function importedModuleSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    const specifier = statement.moduleSpecifier
    return specifier != null && ts.isStringLiteral(specifier) ? specifier.text : null
  }
  return null
}

function typeProgramRootNames(paths: string[], parsedConfig: ts.ParsedCommandLine | null) {
  const requested = paths.map(toSourceId)
  if (parsedConfig == null) return requested
  return [...new Set([...parsedConfig.fileNames.map(normalizePath), ...requested])]
}

function addTiming(timing: FitProjectLoadTiming | undefined, key: keyof FitProjectLoadTiming, start: number) {
  if (timing == null) return
  timing[key] += performance.now() - start
}

function findConfigFile(paths: string[]): string | null {
  for (const path of paths) {
    const sourceId = toSourceId(path)
    const configFile = ts.findConfigFile(dirname(sourceId), fileExists, 'tsconfig.json')
    if (configFile != null) return normalizePath(configFile)
  }
  const configFile = ts.findConfigFile(cwd(), fileExists, 'tsconfig.json')
  return configFile == null ? null : normalizePath(configFile)
}

function readParsedConfig(configFile: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(configFile, readFile)
  if (read.error != null) return {
    options: defaultCompilerOptions(),
    fileNames: [],
    errors: [read.error],
  }
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configFile))
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    jsx: ts.JsxEmit.Preserve,
  }
}

function scriptKindForFile(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.json')) return ts.ScriptKind.JSON
  return ts.ScriptKind.TS
}

function isDeclarationExtension(extension: string) {
  return extension === ts.Extension.Dts || extension === ts.Extension.Dmts || extension === ts.Extension.Dcts
}

function isSupportedSourceExtension(extension: string) {
  return extension === ts.Extension.Ts
    || extension === ts.Extension.Tsx
    || extension === ts.Extension.Mts
    || extension === ts.Extension.Cts
}

function sourceFromDeclarationMap(declarationFile: string): string | null {
  const mapFile = declarationMapPath(declarationFile)
  if (mapFile == null) return null
  const mapText = readFile(mapFile)
  if (mapText == null) return null

  let map: unknown
  try {
    map = JSON.parse(mapText)
  } catch {
    return null
  }

  const sourceRoot = declarationMapSourceRoot(map)
  const sources = declarationMapSources(map)
  if (sources == null || sources.length !== 1) return null
  const source = sources[0]!
  const sourceId = resolveSourceMapSource(mapFile, sourceRoot, source)

  // A declaration map is the package's own pointer to its sources; for an
  // installed package those live inside node_modules on purpose. Callers that
  // only want project-local files apply their own location filter.
  return sourceId != null && isSupportedSourcePath(sourceId) && fileExists(sourceId)
    ? sourceId
    : null
}

function declarationMapPath(declarationFile: string): string | null {
  const normalized = normalizePath(declarationFile)
  const sidecar = `${normalized}.map`
  if (fileExists(sidecar)) return sidecar

  const text = readFile(normalized)
  if (text == null) return null
  const match = /\/\/# sourceMappingURL=([^\s*]+)/.exec(text)
  if (match?.[1] == null || match[1].includes('://')) return null
  const mapFile = normalizePath(ts.sys.resolvePath(`${dirname(normalized)}/${match[1]}`))
  return fileExists(mapFile) ? mapFile : null
}

function declarationMapSources(map: unknown): string[] | null {
  if (typeof map !== 'object' || map == null || !('sources' in map)) return null
  const sources = map.sources
  return Array.isArray(sources) && sources.every(source => typeof source === 'string') ? sources : null
}

function declarationMapSourceRoot(map: unknown): string {
  if (typeof map !== 'object' || map == null || !('sourceRoot' in map)) return ''
  return typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
}

function resolveSourceMapSource(mapFile: string, sourceRoot: string, source: string): string | null {
  if (source.includes('://')) return null
  const base = dirname(mapFile)
  const root = sourceRoot === ''
    ? base
    : isAbsolutePath(sourceRoot)
      ? sourceRoot
      : `${base}/${sourceRoot}`
  return normalizePath(ts.sys.resolvePath(isAbsolutePath(source) ? source : `${root}/${source}`))
}

function isSupportedSourcePath(path: string) {
  return !path.endsWith('.d.ts')
    && !path.endsWith('.d.mts')
    && !path.endsWith('.d.cts')
    && (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.mts') || path.endsWith('.cts'))
}

function isAbsolutePath(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(normalizePath(path))
}

function isNodeModulesPath(path: string) {
  return normalizePath(path).split('/').includes('node_modules')
}

function toSourceId(path: string) {
  return normalizePath(ts.sys.resolvePath(path))
}

function displayPath(sourceId: string) {
  const root = cwd()
  if (sourceId === root) return '.'
  if (sourceId.startsWith(`${root}/`)) return sourceId.slice(root.length + 1)
  return sourceId
}

function cwd() {
  return normalizePath(ts.sys.getCurrentDirectory())
}

function dirname(path: string) {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/')
}

function cacheKeyFor(path: string) {
  const normalized = normalizePath(path)
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase()
}

function fileExists(file: string) {
  return ts.sys.fileExists(file)
}

function readFile(file: string) {
  return ts.sys.readFile(file)
}
