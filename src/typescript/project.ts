import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'
import * as ts from 'typescript'
import {TypeScriptDiagnosticsError} from './diagnostics.ts'

export type LoadedTypeScriptProject = {
  rootDirectory: string
  parsed: ts.ParsedCommandLine
  program: ts.Program
}

export type ProjectSource = {
  project: LoadedTypeScriptProject
  sourceFile: ts.SourceFile
}

export function findTypeScriptConfig(searchFrom: string): string | null {
  return ts.findConfigFile(resolve(searchFrom), file => ts.sys.fileExists(file), 'tsconfig.json') ?? null
}

export function loadTypeScriptProjectGraph(configPath: string): LoadedTypeScriptProject[] {
  const loaded: LoadedTypeScriptProject[] = []
  const byConfigPath = new Map<string, LoadedTypeScriptProject | null>()

  const load = (requestedConfigPath: string): LoadedTypeScriptProject => {
    const absoluteConfigPath = resolve(requestedConfigPath)
    const existing = byConfigPath.get(absoluteConfigPath)
    if (existing === null) {
      throw new Error(`Circular TypeScript project reference involving ${absoluteConfigPath}`)
    }
    if (existing !== undefined) return existing
    byConfigPath.set(absoluteConfigPath, null)
    const parsed = parseConfig(absoluteConfigPath)
    requireStrictNullChecks(parsed.options, absoluteConfigPath)
    for (const reference of parsed.projectReferences ?? []) load(ts.resolveProjectReferencePath(reference))
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      configFileParsingDiagnostics: parsed.errors,
      ...(parsed.projectReferences == null ? {} : {projectReferences: parsed.projectReferences}),
    })
    const project = {
      rootDirectory: dirname(absoluteConfigPath),
      parsed,
      program,
    }
    byConfigPath.set(absoluteConfigPath, project)
    loaded.push(project)
    return project
  }

  load(configPath)
  return loaded
}

export function projectSources(projects: LoadedTypeScriptProject[]): ProjectSource[] {
  const sources = new Map<string, ProjectSource>()
  for (const project of projects) {
    for (const sourceFile of project.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile || sourceFile.fileName.includes(`${sep}node_modules${sep}`)) continue
      const absoluteFile = resolve(sourceFile.fileName)
      const existing = sources.get(absoluteFile)
      const candidate = {project, sourceFile}
      if (existing == null
        || ownershipScore(project, absoluteFile) > ownershipScore(existing.project, absoluteFile)) {
        sources.set(absoluteFile, candidate)
      }
    }
  }
  return [...sources.values()]
    .sort((left, right) => left.sourceFile.fileName.localeCompare(right.sourceFile.fileName))
}

function parseConfig(configPath: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new TypeScriptDiagnosticsError([diagnostic], {}, dirname(configPath))
    },
  })
  if (parsed == null) throw new Error(`TypeScript could not parse ${configPath}`)
  if (parsed.errors.length > 0) {
    throw new TypeScriptDiagnosticsError(parsed.errors, parsed.options, dirname(configPath))
  }
  return parsed
}

function requireStrictNullChecks(options: ts.CompilerOptions, configPath: string): void {
  // TypeScript 6 defaults strict mode on. An explicit strictNullChecks setting wins;
  // otherwise strict:false is the only way the effective option is disabled.
  const enabled = options.strictNullChecks ?? options.strict !== false
  if (enabled) return
  throw new Error(
    `freerange requires strictNullChecks. Enable "strict": true or "strictNullChecks": true in ${configPath}.`,
  )
}

function ownershipScore(project: LoadedTypeScriptProject, file: string): number {
  const path = relative(project.rootDirectory, file)
  const inside = path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  return inside ? project.rootDirectory.length : -1
}
