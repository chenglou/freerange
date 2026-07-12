import {resolve} from 'node:path'
import * as ts from 'typescript'
import {TypeScriptDiagnosticsError} from './diagnostics.ts'

export type CheckedSource = {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
}

// When no tsconfig is in scope, single-file analysis gets the recommended authoring
// checks. Project file mode uses the project's existing Program instead of this helper.
const fallbackOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
}

export function checkFile(file: string): CheckedSource {
  const absoluteFile = resolve(file)
  const program = ts.createProgram([absoluteFile], fallbackOptions)
  return checkedSource(program, absoluteFile, fallbackOptions)
}

export function checkSource(file: string, source: string): CheckedSource {
  const absoluteFile = resolve(file)
  const sourceFile = ts.createSourceFile(absoluteFile, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const defaultHost = ts.createCompilerHost(fallbackOptions)
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (requestedFile, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (resolve(requestedFile) === absoluteFile) return sourceFile
      return defaultHost.getSourceFile(requestedFile, languageVersion, onError, shouldCreateNewSourceFile)
    },
    fileExists: requestedFile => resolve(requestedFile) === absoluteFile || defaultHost.fileExists(requestedFile),
    readFile: requestedFile => resolve(requestedFile) === absoluteFile ? source : defaultHost.readFile(requestedFile),
  }
  const program = ts.createProgram([absoluteFile], fallbackOptions, host)
  return checkedSource(program, absoluteFile, fallbackOptions)
}

function checkedSource(program: ts.Program, file: string, options: ts.CompilerOptions): CheckedSource {
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    throw new TypeScriptDiagnosticsError(diagnostics, options, process.cwd())
  }
  const sourceFile = program.getSourceFile(file)
  if (sourceFile == null) throw new Error(`TypeScript did not load ${file}`)
  return {sourceFile, checker: program.getTypeChecker()}
}
