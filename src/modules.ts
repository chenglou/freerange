import * as ts from 'typescript'
import {parseFitSpecs, type FitSpec} from './parser.ts'

export type FitModule<TGlobal> = {
  sourceId: string
  file: string
  sourceFile: ts.SourceFile
  sourceText: string
  globals: Map<string, TGlobal>
  functions: Map<string, ts.FunctionDeclaration>
  specsByFunction: Map<string, FitSpec[]>
  exports: Map<string, FitExportBinding<FitModule<TGlobal>>>
  imports: Map<string, FitImportBinding<FitModule<TGlobal>>>
}

export type FitProject<TGlobal> = {
  entries: FitModule<TGlobal>[]
  modules: Map<string, FitModule<TGlobal>>
  configFile: string | null
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

type ResolutionContext = {
  compilerOptions: ts.CompilerOptions
  configFile: string | null
  cache: ts.ModuleResolutionCache
}

type ResolvedImport =
  | {kind: 'source'; sourceId: string}
  | {kind: 'unresolved'; reason: string}

export function loadFitProject<TGlobal>(
  paths: string[],
  readGlobal: TopLevelGlobalReader<TGlobal>,
): FitProject<TGlobal> {
  const resolution = createResolutionContext(paths)
  const modules = new Map<string, FitModule<TGlobal>>()
  const entries = paths.map(path => loadModule(path, modules, resolution, readGlobal))
  return {entries, modules, configFile: resolution.configFile}
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
): FitModule<TGlobal> {
  const sourceId = toSourceId(file)
  const cacheKey = cacheKeyFor(sourceId)
  const existing = modules.get(cacheKey)
  if (existing != null) return existing

  const sourceText = ts.sys.readFile(sourceId)
  if (sourceText == null) throw new Error(`Could not read ${displayPath(sourceId)}`)

  const module = parseFitModule(sourceId, displayPath(sourceId), sourceText, readGlobal)
  modules.set(cacheKey, module)
  loadImports(module, modules, resolution, readGlobal)
  loadReExports(module, modules, resolution, readGlobal)
  return module
}

function parseFitModule<TGlobal>(
  sourceId: string,
  file: string,
  sourceText: string,
  readGlobal: TopLevelGlobalReader<TGlobal>,
): FitModule<TGlobal> {
  const sourceFile = ts.createSourceFile(sourceId, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(sourceId))
  const globals = new Map<string, TGlobal>()
  const functions = new Map<string, ts.FunctionDeclaration>()
  const specsByFunction = new Map<string, FitSpec[]>()
  const exports = new Map<string, FitExportBinding<FitModule<TGlobal>>>()
  const imports = new Map<string, FitImportBinding<FitModule<TGlobal>>>()

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) {
      functions.set(statement.name.text, statement)
      specsByFunction.set(statement.name.text, parseFitSpecs(sourceText, statement))
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        exports.set(statement.name.text, {kind: 'local', localName: statement.name.text})
      }
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      collectLocalExportDeclaration(statement, exports)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const global = readGlobal(declaration)
      if (global == null) continue
      globals.set(global.name, global.value)
    }
  }

  return {sourceId, file, sourceFile, sourceText, globals, functions, specsByFunction, exports, imports}
}

function loadImports<TGlobal>(
  module: FitModule<TGlobal>,
  modules: Map<string, FitModule<TGlobal>>,
  resolution: ResolutionContext,
  readGlobal: TopLevelGlobalReader<TGlobal>,
) {
  for (const statement of module.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const namedBindings = statement.importClause?.namedBindings
    if (namedBindings == null || !ts.isNamedImports(namedBindings)) continue

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

      const resolved = resolveImport(module, specifier, resolution)
      if (resolved.kind === 'unresolved') {
        module.imports.set(localName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: resolved.reason,
        })
        continue
      }

      const importedModule = loadModule(resolved.sourceId, modules, resolution, readGlobal)
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

      const resolved = resolveImport(module, specifier, resolution)
      if (resolved.kind === 'unresolved') {
        module.exports.set(exportName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: resolved.reason,
        })
        continue
      }

      const exportedModule = loadModule(resolved.sourceId, modules, resolution, readGlobal)
      module.exports.set(exportName, {
        kind: 'reexport',
        exportedName,
        specifier,
        module: exportedModule,
      })
    }
  }
}

function resolveImport<TGlobal>(module: FitModule<TGlobal>, specifier: string, resolution: ResolutionContext): ResolvedImport {
  const result = ts.resolveModuleName(specifier, module.sourceId, resolution.compilerOptions, ts.sys, resolution.cache)
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

function createResolutionContext(paths: string[]): ResolutionContext {
  const configFile = findConfigFile(paths)
  const compilerOptions = configFile == null ? defaultCompilerOptions() : readCompilerOptions(configFile)
  return {
    compilerOptions,
    configFile,
    cache: ts.createModuleResolutionCache(cwd(), cacheKeyFor, compilerOptions),
  }
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
  const read = ts.readConfigFile(configFile, readFile)
  if (read.error != null) return defaultCompilerOptions()
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configFile))
  return parsed.options
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
