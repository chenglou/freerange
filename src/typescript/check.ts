import {resolve} from 'node:path'
import * as ts from 'typescript'
import {TypeScriptDiagnosticsError} from './diagnostics.ts'

export type CheckedSource = {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  // Single-file analysis has no project config, so it gets the recommended authoring
  // checks. Project analysis respects the project's choices except for strict nullability.
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
}

export function checkFile(file: string): CheckedSource {
  const absoluteFile = resolve(file)
  const program = ts.createProgram([absoluteFile], compilerOptions)
  return checkedSource(program, absoluteFile)
}

export function checkSource(file: string, source: string): CheckedSource {
  const absoluteFile = resolve(file)
  const sourceFile = ts.createSourceFile(absoluteFile, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const defaultHost = ts.createCompilerHost(compilerOptions)
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (requestedFile, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (resolve(requestedFile) === absoluteFile) return sourceFile
      return defaultHost.getSourceFile(requestedFile, languageVersion, onError, shouldCreateNewSourceFile)
    },
    fileExists: requestedFile => resolve(requestedFile) === absoluteFile || defaultHost.fileExists(requestedFile),
    readFile: requestedFile => resolve(requestedFile) === absoluteFile ? source : defaultHost.readFile(requestedFile),
  }
  const program = ts.createProgram([absoluteFile], compilerOptions, host)
  return checkedSource(program, absoluteFile)
}

function checkedSource(program: ts.Program, file: string): CheckedSource {
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    throw new TypeScriptDiagnosticsError(diagnostics, compilerOptions, process.cwd())
  }
  const sourceFile = program.getSourceFile(file)
  if (sourceFile == null) throw new Error(`TypeScript did not load ${file}`)
  return {sourceFile, checker: program.getTypeChecker()}
}
