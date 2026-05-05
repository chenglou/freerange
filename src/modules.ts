import * as ts from 'typescript'
import {parseFunctionFitSpecs, type FitSpec} from './parser.ts'

export type FitFunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration

export type FitFunction = {
  name: string
  node: FitFunctionNode
  specNode: ts.Node
}

export type FitModule<TGlobal> = {
  sourceId: string
  file: string
  sourceFile: ts.SourceFile
  sourceText: string
  typeChecker: ts.TypeChecker | null
  globals: Map<string, TGlobal>
  functions: Map<string, FitFunction>
  callAliases: Map<string, FitCallAlias>
  unsupportedCallAliases: Map<string, string>
  fitFunctions: Set<string>
  specsByFunction: Map<string, FitSpec[]>
  imports: Map<string, FitImportBinding<FitModule<TGlobal>>>
}

export type FitProject<TGlobal> = {
  entries: FitModule<TGlobal>[]
  modules: Map<string, FitModule<TGlobal>>
  configFile: string | null
}

export type FitProjectLoadTiming = {
  configMs: number
  typeProgramMs: number
  typeCheckerMs: number
  fileReadMs: number
  moduleParseMs: number
  importResolveMs: number
}

export type FitImportBinding<TModule> =
  | {
      kind: 'resolved'
      importedName: string
      sourceName: string
      specifier: string
      module: TModule
    }
  | {
      kind: 'namespace'
      importedName: '*'
      specifier: string
      module: TModule
      members: Map<string, FitImportSource<TModule>>
    }
  | {
      kind: 'unresolved'
      exportedName: string
      specifier: string
      reason: string
    }

export type FitImportSource<TModule> = {
  sourceName: string
  module: TModule
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

type LoadFitProjectOptions = {
  timing?: FitProjectLoadTiming
}

type ResolutionContext = {
  compilerOptions: ts.CompilerOptions
  configFile: string | null
  cache: ts.ModuleResolutionCache
  typeProgram: ts.Program
  typeChecker: ts.TypeChecker
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
  const modules = new Map<string, FitModule<TGlobal>>()
  const entries = paths.map(path => loadModule(path, modules, resolution, readGlobal, options.timing))
  return {entries, modules, configFile: resolution.configFile}
}

export function createFitProjectLoadTiming(): FitProjectLoadTiming {
  return {
    configMs: 0,
    typeProgramMs: 0,
    typeCheckerMs: 0,
    fileReadMs: 0,
    moduleParseMs: 0,
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

export function buildFitSourceModule<TGlobal>(
  file: string,
  sourceText: string,
  readGlobal: TopLevelGlobalReader<TGlobal>,
): FitModule<TGlobal> {
  const sourceId = toSourceId(file)
  const sourceFile = ts.createSourceFile(sourceId, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(sourceId))
  return parseFitModule(sourceId, displayPath(sourceId), sourceText, readGlobal, null, sourceFile)
}

function throwOnSyntaxDiagnostics(
  file: string,
  sourceFile: ts.SourceFile,
  diagnostics: readonly ts.Diagnostic[] = sourceFileParseDiagnostics(sourceFile),
) {
  if (diagnostics.length === 0) return
  const lines = diagnostics.map(diagnostic => formatSyntaxDiagnostic(file, sourceFile, diagnostic))
  throw new Error(lines.length === 1 ? lines[0]! : [`Syntax errors in ${file}:`, ...lines.map(line => `  ${line}`)].join('\n'))
}

function formatSyntaxDiagnostic(file: string, sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  const code = `TS${diagnostic.code}`
  if (diagnostic.start == null) return `Syntax error in ${file} ${code}: ${message}`
  const {line, character} = sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
  return `Syntax error in ${file}:${line + 1}:${character + 1} ${code}: ${message}`
}

function sourceFileParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as ts.SourceFile & {parseDiagnostics?: readonly ts.Diagnostic[]}).parseDiagnostics ?? []
}

function loadModule<TGlobal>(
  file: string,
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
): FitModule<TGlobal> {
  const sourceId = toSourceId(file)
  const cacheKey = cacheKeyFor(sourceId)
  const existing = modules.get(cacheKey)
  if (existing != null) return existing

  const readStart = performance.now()
  const sourceText = ts.sys.readFile(sourceId)
  addTiming(timing, 'fileReadMs', readStart)
  if (sourceText == null) throw new Error(`Could not read ${displayPath(sourceId)}`)

  const sourceFile = resolution.typeProgram.getSourceFile(sourceId)
  const syntaxDiagnostics = sourceFile == null ? null : resolution.typeProgram.getSyntacticDiagnostics(sourceFile)
  const parseStart = performance.now()
  const module = parseFitModule(sourceId, displayPath(sourceId), sourceText, readGlobal, sourceFile == null ? null : resolution.typeChecker, sourceFile, syntaxDiagnostics ?? undefined)
  addTiming(timing, 'moduleParseMs', parseStart)
  modules.set(cacheKey, module)
  loadImports(module, modules, resolution, readGlobal, timing)
  return module
}

function parseFitModule<TGlobal>(
  sourceId: string,
  file: string,
  sourceText: string,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  typeChecker: ts.TypeChecker | null = null,
  sourceFile: ts.SourceFile = ts.createSourceFile(sourceId, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(sourceId)),
  syntaxDiagnostics?: readonly ts.Diagnostic[],
): FitModule<TGlobal> {
  throwOnSyntaxDiagnostics(file, sourceFile, syntaxDiagnostics)

  const globals = new Map<string, TGlobal>()
  const functions = new Map<string, FitFunction>()
  const callAliases = new Map<string, FitCallAlias>()
  const unsupportedCallAliases = new Map<string, string>()
  const fitFunctions = new Set<string>()
  const specsByFunction = new Map<string, FitSpec[]>()
  const imports = new Map<string, FitImportBinding<FitModule<TGlobal>>>()

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const isDefaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      const functionName = statement.name?.text ?? (isDefaultExport ? 'default' : null)
      if (functionName == null) continue
      collectFitFunction(sourceText, functionName, statement, statement, functions, fitFunctions, specsByFunction)
      continue
    }
    if (ts.isClassDeclaration(statement) && statement.name != null) {
      collectClassMemberFunctions(sourceText, statement, functions, fitFunctions, specsByFunction)
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
      collectFitFunction(sourceText, 'default', functionInitializer, statement, functions, fitFunctions, specsByFunction)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    const isConst = isConstVariableStatement(statement)
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const functionInitializer = declaration.initializer == null ? null : supportedFunctionInitializer(declaration.initializer)
        if (functionInitializer != null) {
          collectFitFunction(sourceText, declaration.name.text, functionInitializer, statement, functions, fitFunctions, specsByFunction)
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

  return {sourceId, file, sourceFile, sourceText, typeChecker, globals, functions, callAliases, unsupportedCallAliases, fitFunctions, specsByFunction, imports}
}

function collectClassMemberFunctions(
  sourceText: string,
  declaration: ts.ClassDeclaration,
  functions: Map<string, FitFunction>,
  fitFunctions: Set<string>,
  specsByFunction: Map<string, FitSpec[]>,
) {
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member)) continue
    if (member.body == null) continue
    const memberName = classMemberFunctionName(declaration.name!.text, member)
    if (memberName == null) continue
    collectFitFunction(sourceText, memberName, member, member, functions, fitFunctions, specsByFunction)
  }
}

function collectFitFunction(
  sourceText: string,
  name: string,
  node: FitFunctionNode,
  specNode: ts.Node,
  functions: Map<string, FitFunction>,
  fitFunctions: Set<string>,
  specsByFunction: Map<string, FitSpec[]>,
) {
  const fn = {name, node, specNode}
  const specs = parseFunctionFitSpecs(sourceText, fn.specNode, fn.node.parameters)
  functions.set(fn.name, fn)
  if (specs.length > 0) fitFunctions.add(fn.name)
  specsByFunction.set(fn.name, specs)
}

function classMemberFunctionName(className: string, member: ts.MethodDeclaration | ts.GetAccessorDeclaration): string | null {
  if (!ts.isIdentifier(member.name)) return null
  return `${className}.${member.name.text}`
}

function supportedFunctionInitializer(expression: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) ? expression : null
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
  module: FitModule<TGlobal>,
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
) {
  for (const statement of module.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const importClause = statement.importClause
    const importIsTypeOnly = importClause?.isTypeOnly === true
    if (importClause?.name != null) {
      module.imports.set(importClause.name.text, importIsTypeOnly
        ? unresolvedImport('default', specifier, `Type-only imports cannot provide @fit helpers: ${specifier}`)
        : sourceImportBinding(module, modules, resolution, readGlobal, timing, importClause.name, 'default', specifier))
    }

    const namedBindings = importClause?.namedBindings
    if (namedBindings == null) continue
    if (ts.isNamespaceImport(namedBindings)) {
      module.imports.set(namedBindings.name.text, importIsTypeOnly
        ? unresolvedImport('*', specifier, `Type-only imports cannot provide @fit helpers: ${specifier}`)
        : sourceNamespaceImportBinding(module, modules, resolution, readGlobal, timing, namedBindings.name, specifier))
      continue
    }
    if (!ts.isNamedImports(namedBindings)) continue

    for (const element of namedBindings.elements) {
      const localName = element.name.text
      const exportedName = element.propertyName?.text ?? localName
      if (statement.importClause?.isTypeOnly === true || element.isTypeOnly) {
        module.imports.set(localName, unresolvedImport(exportedName, specifier, `Type-only imports cannot provide @fit helpers: ${specifier}`))
        continue
      }

      module.imports.set(localName, sourceImportBinding(module, modules, resolution, readGlobal, timing, element.name, exportedName, specifier))
    }
  }
}

function unresolvedImport<TGlobal>(exportedName: string, specifier: string, reason: string): FitImportBinding<FitModule<TGlobal>> {
  return {kind: 'unresolved', exportedName, specifier, reason}
}

function sourceImportBinding<TGlobal>(
  module: FitModule<TGlobal>,
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
  localIdentifier: ts.Identifier,
  importedName: string,
  specifier: string,
): FitImportBinding<FitModule<TGlobal>> {
  const target = sourceImportSourceFromSymbol(resolution.typeChecker.getSymbolAtLocation(localIdentifier), modules, resolution, readGlobal, timing)
  if (target != null) return {kind: 'resolved', importedName, specifier, ...target}

  const resolved = resolveImport(module, specifier, resolution, timing)
  if (resolved.kind === 'unresolved') return unresolvedImport(importedName, specifier, resolved.reason)
  const importedModule = loadModule(resolved.sourceId, modules, resolution, readGlobal, timing)
  return {kind: 'resolved', importedName, sourceName: importedName, specifier, module: importedModule}
}

function sourceNamespaceImportBinding<TGlobal>(
  module: FitModule<TGlobal>,
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
  namespaceIdentifier: ts.Identifier,
  specifier: string,
): FitImportBinding<FitModule<TGlobal>> {
  const resolved = resolveImport(module, specifier, resolution, timing)
  if (resolved.kind === 'unresolved') return unresolvedImport('*', specifier, resolved.reason)
  const importedModule = loadModule(resolved.sourceId, modules, resolution, readGlobal, timing)
  return {
    kind: 'namespace',
    importedName: '*',
    specifier,
    module: importedModule,
    members: sourceNamespaceMembers(modules, resolution, readGlobal, timing, namespaceIdentifier),
  }
}

function sourceNamespaceMembers<TGlobal>(
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
  namespaceIdentifier: ts.Identifier,
): Map<string, FitImportSource<FitModule<TGlobal>>> {
  const members = new Map<string, FitImportSource<FitModule<TGlobal>>>()
  const symbol = resolution.typeChecker.getSymbolAtLocation(namespaceIdentifier)
  const target = symbol != null && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? resolution.typeChecker.getAliasedSymbol(symbol)
    : symbol
  const exports = target == null ? [] : resolution.typeChecker.getExportsOfModule(target)
  for (const exported of exports) {
    const source = sourceImportSourceFromSymbol(exported, modules, resolution, readGlobal, timing)
    if (source != null) members.set(exported.name, source)
  }
  return members
}

function sourceImportSourceFromSymbol<TGlobal>(
  symbol: ts.Symbol | undefined,
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
): FitImportSource<FitModule<TGlobal>> | null {
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
    module: loadModule(sourceId, modules, resolution, readGlobal, timing),
  }
}

function isSourceImportDeclaration(node: ts.Declaration): node is ts.FunctionDeclaration | ts.VariableDeclaration | ts.ExportAssignment {
  return ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isExportAssignment(node)
}

function sourceNameForDeclaration(declaration: ts.FunctionDeclaration | ts.VariableDeclaration | ts.ExportAssignment): string | null {
  if (ts.isFunctionDeclaration(declaration)) return declaration.name?.text ?? (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) ? 'default' : null)
  if (ts.isVariableDeclaration(declaration)) return ts.isIdentifier(declaration.name) ? declaration.name.text : null
  return 'default'
}

function sourceIdForDeclaration(declaration: ts.Declaration): string | null {
  const sourceFile = declaration.getSourceFile()
  const sourceId = sourceFile.isDeclarationFile ? sourceFromDeclarationMap(sourceFile.fileName) : normalizePath(sourceFile.fileName)
  return sourceId != null && isSupportedSourcePath(sourceId) && fileExists(sourceId) && !isNodeModulesPath(sourceId)
    ? sourceId
    : null
}

function resolveImport<TGlobal>(module: FitModule<TGlobal>, specifier: string, resolution: ResolutionContext, timing: FitProjectLoadTiming | undefined): ResolvedImport {
  const start = performance.now()
  const result = ts.resolveModuleName(specifier, module.sourceId, resolution.compilerOptions, ts.sys, resolution.cache)
  addTiming(timing, 'importResolveMs', start)
  const resolved = result.resolvedModule
  if (resolved == null) {
    return {
      kind: 'unresolved',
      reason: `Could not resolve ${specifier} from ${module.file} with TypeScript module resolution`,
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
  const typeProgram = ts.createProgram(typeProgramRootNames(paths, parsedConfig), {...compilerOptions, noEmit: true})
  addTiming(timing, 'typeProgramMs', typeProgramStart)

  const typeCheckerStart = performance.now()
  const typeChecker = typeProgram.getTypeChecker()
  addTiming(timing, 'typeCheckerMs', typeCheckerStart)

  return {
    compilerOptions,
    configFile,
    cache: ts.createModuleResolutionCache(cwd(), cacheKeyFor, compilerOptions),
    typeProgram,
    typeChecker,
  }
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

  return sourceId != null && isSupportedSourcePath(sourceId) && fileExists(sourceId) && !isNodeModulesPath(sourceId)
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
