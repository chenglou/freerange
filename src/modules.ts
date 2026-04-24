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
  fitFunctions: Set<string>
  specsByFunction: Map<string, FitSpec[]>
  exports: Map<string, FitExportBinding<FitModule<TGlobal>>>
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
      exportedName: string
      specifier: string
      module: TModule
    }
  | {
      kind: 'unresolved'
      exportedName: string
      specifier: string
      reason: string
    }

export type FitExportBinding<TModule> =
  | {
      kind: 'local'
      localName: string
    }
  | {
      kind: 'reexport'
      exportedName: string
      specifier: string
      module: TModule
    }
  | {
      kind: 'unresolved'
      exportedName: string
      specifier: string
      reason: string
    }

export type FitResolvedExport<TModule> =
  | {
      kind: 'local'
      localName: string
      module: TModule
    }
  | {
      kind: 'unresolved'
      exportedName: string
      reason: string
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
  return parseFitModule(sourceId, displayPath(sourceId), sourceText, readGlobal)
}

export function resolveFitExport<TGlobal>(
  module: FitModule<TGlobal>,
  exportedName: string,
): FitResolvedExport<FitModule<TGlobal>> {
  return resolveFitExportInner(module, exportedName, new Set())
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
  const parseStart = performance.now()
  const module = parseFitModule(sourceId, displayPath(sourceId), sourceText, readGlobal, resolution.typeChecker, sourceFile)
  addTiming(timing, 'moduleParseMs', parseStart)
  modules.set(cacheKey, module)
  loadImports(module, modules, resolution, readGlobal, timing)
  loadReExports(module, modules, resolution, readGlobal, timing)
  return module
}

function parseFitModule<TGlobal>(
  sourceId: string,
  file: string,
  sourceText: string,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  typeChecker: ts.TypeChecker | null = null,
  sourceFile: ts.SourceFile = ts.createSourceFile(sourceId, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(sourceId)),
): FitModule<TGlobal> {
  const globals = new Map<string, TGlobal>()
  const functions = new Map<string, FitFunction>()
  const fitFunctions = new Set<string>()
  const specsByFunction = new Map<string, FitSpec[]>()
  const exports = new Map<string, FitExportBinding<FitModule<TGlobal>>>()
  const imports = new Map<string, FitImportBinding<FitModule<TGlobal>>>()

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) {
      const fn = {name: statement.name.text, node: statement, specNode: statement}
      const specs = parseFunctionFitSpecs(sourceText, fn.specNode, fn.node.parameters)
      functions.set(fn.name, fn)
      if (specs.length > 0) fitFunctions.add(fn.name)
      specsByFunction.set(fn.name, specs)
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        exports.set(fn.name, {kind: 'local', localName: fn.name})
      }
      continue
    }
    if (ts.isClassDeclaration(statement) && statement.name != null) {
      collectClassMemberFunctions(sourceText, statement, functions, fitFunctions, specsByFunction)
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      collectLocalExportDeclaration(statement, exports)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const functionInitializer = declaration.initializer == null ? null : supportedFunctionInitializer(declaration.initializer)
        if (functionInitializer != null) {
          const fn = {name: declaration.name.text, node: functionInitializer, specNode: statement}
          const specs = parseFunctionFitSpecs(sourceText, fn.specNode, fn.node.parameters)
          functions.set(fn.name, fn)
          if (specs.length > 0) fitFunctions.add(fn.name)
          specsByFunction.set(fn.name, specs)
        }
        if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
          exports.set(declaration.name.text, {kind: 'local', localName: declaration.name.text})
        }
      }
      const global = readGlobal(declaration)
      if (global == null) continue
      globals.set(global.name, global.value)
    }
  }

  return {sourceId, file, sourceFile, sourceText, typeChecker, globals, functions, fitFunctions, specsByFunction, exports, imports}
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
    const fn = {name: memberName, node: member, specNode: member}
    const specs = parseFunctionFitSpecs(sourceText, fn.specNode, fn.node.parameters)
    functions.set(fn.name, fn)
    if (specs.length > 0) fitFunctions.add(fn.name)
    specsByFunction.set(fn.name, specs)
  }
}

function classMemberFunctionName(className: string, member: ts.MethodDeclaration | ts.GetAccessorDeclaration): string | null {
  if (!ts.isIdentifier(member.name)) return null
  return `${className}.${member.name.text}`
}

function supportedFunctionInitializer(expression: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) ? expression : null
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
      module.imports.set(importClause.name.text, {
        kind: 'unresolved',
        exportedName: 'default',
        specifier,
        reason: importIsTypeOnly ? `Type-only imports cannot provide @fit helpers: ${specifier}` : 'default imports are not supported for @fit helpers',
      })
    }

    const namedBindings = importClause?.namedBindings
    if (namedBindings == null) continue
    if (ts.isNamespaceImport(namedBindings)) {
      module.imports.set(namedBindings.name.text, {
        kind: 'unresolved',
        exportedName: '*',
        specifier,
        reason: importIsTypeOnly ? `Type-only imports cannot provide @fit helpers: ${specifier}` : 'namespace imports are not supported for @fit helpers',
      })
      continue
    }
    if (!ts.isNamedImports(namedBindings)) continue

    for (const element of namedBindings.elements) {
      const localName = element.name.text
      const exportedName = element.propertyName?.text ?? localName
      if (statement.importClause?.isTypeOnly === true || element.isTypeOnly) {
        module.imports.set(localName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: `Type-only imports cannot provide @fit helpers: ${specifier}`,
        })
        continue
      }

      const resolved = resolveImport(module, specifier, resolution, timing)
      if (resolved.kind === 'unresolved') {
        module.imports.set(localName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: resolved.reason,
        })
        continue
      }

      const importedModule = loadModule(resolved.sourceId, modules, resolution, readGlobal, timing)
      module.imports.set(localName, {
        kind: 'resolved',
        exportedName,
        specifier,
        module: importedModule,
      })
    }
  }
}

function loadReExports<TGlobal>(
  module: FitModule<TGlobal>,
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
  timing: FitProjectLoadTiming | undefined,
) {
  for (const statement of module.sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    const moduleSpecifier = statement.moduleSpecifier
    if (moduleSpecifier == null || !ts.isStringLiteral(moduleSpecifier)) continue
    if (statement.exportClause == null || !ts.isNamedExports(statement.exportClause)) continue
    const specifier = moduleSpecifier.text

    for (const element of statement.exportClause.elements) {
      const exportName = element.name.text
      const exportedName = element.propertyName?.text ?? exportName
      if (statement.isTypeOnly || element.isTypeOnly) {
        module.exports.set(exportName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: `Type-only re-exports cannot provide @fit helpers: ${specifier}`,
        })
        continue
      }

      const resolved = resolveImport(module, specifier, resolution, timing)
      if (resolved.kind === 'unresolved') {
        module.exports.set(exportName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: resolved.reason,
        })
        continue
      }

      const exportedModule = loadModule(resolved.sourceId, modules, resolution, readGlobal, timing)
      module.exports.set(exportName, {
        kind: 'reexport',
        exportedName,
        specifier,
        module: exportedModule,
      })
    }
  }
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
  if (resolved.isExternalLibraryImport) {
    return {
      kind: 'unresolved',
      reason: `External package imports are not source-proved @fit helpers: ${specifier}`,
    }
  }
  if (isDeclarationExtension(resolved.extension)) {
    return {
      kind: 'unresolved',
      reason: `Declaration-only imports are not source-proved @fit helpers: ${specifier}`,
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

function resolveFitExportInner<TGlobal>(
  module: FitModule<TGlobal>,
  exportedName: string,
  seen: Set<string>,
): FitResolvedExport<FitModule<TGlobal>> {
  const key = `${module.sourceId}#${exportedName}`
  if (seen.has(key)) {
    return {
      kind: 'unresolved',
      exportedName,
      reason: `Cyclic re-export at ${module.file}#${exportedName}`,
    }
  }
  seen.add(key)

  const binding = module.exports.get(exportedName)
  if (binding == null) {
    return {
      kind: 'unresolved',
      exportedName,
      reason: `Imported symbol ${exportedName} is not exported by ${module.file}`,
    }
  }
  if (binding.kind === 'local') {
    return {kind: 'local', localName: binding.localName, module}
  }
  if (binding.kind === 'unresolved') {
    return {kind: 'unresolved', exportedName, reason: binding.reason}
  }
  return resolveFitExportInner(binding.module, binding.exportedName, seen)
}

function collectLocalExportDeclaration<TGlobal>(
  statement: ts.ExportDeclaration,
  exports: Map<string, FitExportBinding<FitModule<TGlobal>>>,
) {
  if (statement.moduleSpecifier != null) return
  if (statement.exportClause == null || !ts.isNamedExports(statement.exportClause)) return
  for (const element of statement.exportClause.elements) {
    const localName = element.propertyName?.text ?? element.name.text
    exports.set(element.name.text, {kind: 'local', localName})
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function createResolutionContext(paths: string[], timing: FitProjectLoadTiming | undefined): ResolutionContext {
  const configStart = performance.now()
  const configFile = findConfigFile(paths)
  const compilerOptions = configFile == null ? defaultCompilerOptions() : readCompilerOptions(configFile)
  addTiming(timing, 'configMs', configStart)

  const typeProgramStart = performance.now()
  const typeProgram = ts.createProgram(paths.map(toSourceId), {...compilerOptions, noEmit: true})
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

function readCompilerOptions(configFile: string): ts.CompilerOptions {
  return readParsedConfig(configFile).options
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

function isSupportedSourcePath(path: string) {
  return !path.endsWith('.d.ts')
    && !path.endsWith('.d.mts')
    && !path.endsWith('.d.cts')
    && (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.mts') || path.endsWith('.cts'))
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
