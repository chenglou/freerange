import * as ts from 'typescript'
import {parseFitSpecs, type FitSpec} from './parser.ts'

export type ModuleProgram<TGlobal, TContract> = {
  file: string
  sourceFile: ts.SourceFile
  sourceText: string
  globals: Map<string, TGlobal>
  functions: Map<string, ts.FunctionDeclaration>
  specsByFunction: Map<string, FitSpec[]>
  exports: Map<string, string>
  imports: Map<string, ModuleImportedBinding<ModuleProgram<TGlobal, TContract>>>
  contractCache: Map<string, TContract>
}

export type ModuleImportedBinding<TModule> =
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

export type TopLevelGlobalReader<TGlobal> = (declaration: ts.VariableDeclaration) => {name: string; value: TGlobal} | null

export async function loadFitPrograms<TGlobal, TContract>(
  paths: string[],
  contractCache: Map<string, TContract>,
  readGlobal: TopLevelGlobalReader<TGlobal>,
): Promise<ModuleProgram<TGlobal, TContract>[]> {
  const modules = new Map<string, ModuleProgram<TGlobal, TContract>>()
  const programs: ModuleProgram<TGlobal, TContract>[] = []
  for (const path of paths) {
    programs.push(await loadProgram(normalizePath(path), modules, contractCache, readGlobal))
  }
  return programs
}

export function buildFitProgram<TGlobal, TContract>(
  file: string,
  sourceText: string,
  contractCache: Map<string, TContract>,
  readGlobal: TopLevelGlobalReader<TGlobal>,
): ModuleProgram<TGlobal, TContract> {
  const normalized = normalizePath(file)
  const sourceFile = ts.createSourceFile(normalized, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const globals = new Map<string, TGlobal>()
  const functions = new Map<string, ts.FunctionDeclaration>()
  const specsByFunction = new Map<string, FitSpec[]>()
  const exports = new Map<string, string>()
  const imports = new Map<string, ModuleImportedBinding<ModuleProgram<TGlobal, TContract>>>()

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) {
      functions.set(statement.name.text, statement)
      specsByFunction.set(statement.name.text, parseFitSpecs(sourceText, statement))
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exports.set(statement.name.text, statement.name.text)
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

  return {file: normalized, sourceFile, sourceText, globals, functions, specsByFunction, exports, imports, contractCache}
}

async function loadProgram<TGlobal, TContract>(
  file: string,
  modules: Map<string, ModuleProgram<TGlobal, TContract>>,
  contractCache: Map<string, TContract>,
  readGlobal: TopLevelGlobalReader<TGlobal>,
): Promise<ModuleProgram<TGlobal, TContract>> {
  const normalized = normalizePath(file)
  const existing = modules.get(normalized)
  if (existing != null) return existing

  const sourceText = await Bun.file(normalized).text()
  const program = buildFitProgram(normalized, sourceText, contractCache, readGlobal)
  modules.set(normalized, program)
  await loadRelativeImports(program, modules, contractCache, readGlobal)
  return program
}

async function loadRelativeImports<TGlobal, TContract>(
  program: ModuleProgram<TGlobal, TContract>,
  modules: Map<string, ModuleProgram<TGlobal, TContract>>,
  contractCache: Map<string, TContract>,
  readGlobal: TopLevelGlobalReader<TGlobal>,
) {
  for (const statement of program.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const namedBindings = statement.importClause?.namedBindings
    if (namedBindings == null || !ts.isNamedImports(namedBindings)) continue

    for (const element of namedBindings.elements) {
      const localName = element.name.text
      const exportedName = element.propertyName?.text ?? localName
      if (!isRelativeSpecifier(specifier)) {
        program.imports.set(localName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: `Only relative named imports are supported for @fit helpers: ${specifier}`,
        })
        continue
      }

      const resolved = await resolveRelativeModule(program.file, specifier)
      if (resolved == null) {
        program.imports.set(localName, {
          kind: 'unresolved',
          exportedName,
          specifier,
          reason: `Could not resolve ${specifier} from ${program.file}`,
        })
        continue
      }

      const importedProgram = await loadProgram(resolved, modules, contractCache, readGlobal)
      program.imports.set(localName, {
        kind: 'resolved',
        exportedName,
        specifier,
        module: importedProgram,
      })
    }
  }
}

function collectLocalExportDeclaration(statement: ts.ExportDeclaration, exports: Map<string, string>) {
  if (statement.moduleSpecifier != null) return
  if (statement.exportClause == null || !ts.isNamedExports(statement.exportClause)) return
  for (const element of statement.exportClause.elements) {
    const localName = element.propertyName?.text ?? element.name.text
    exports.set(element.name.text, localName)
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function isRelativeSpecifier(specifier: string) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

async function resolveRelativeModule(fromFile: string, specifier: string): Promise<string | null> {
  const basePath = normalizePath(joinPath(dirname(fromFile), specifier))
  for (const candidate of relativeModuleCandidates(basePath)) {
    if (await canReadFile(candidate)) return candidate
  }
  return null
}

function relativeModuleCandidates(basePath: string): string[] {
  if (basePath.endsWith('.ts')) return [basePath]
  return [`${basePath}.ts`, `${basePath}/index.ts`]
}

async function canReadFile(path: string): Promise<boolean> {
  try {
    await Bun.file(path).text()
    return true
  } catch {
    return false
  }
}

function dirname(path: string) {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function joinPath(base: string, path: string) {
  if (base.length === 0) return path
  if (path.length === 0) return base
  return `${base}/${path}`
}

function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      else if (!absolute) parts.push(part)
      continue
    }
    parts.push(part)
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`
}
