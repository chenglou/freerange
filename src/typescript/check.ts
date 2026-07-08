import {resolve} from 'node:path'
import * as ts from 'typescript'

export type CheckedSource = {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  strict: true,
  // Bare arr[i] must type T | undefined so the analyzer can tell an honest possibly-missing
  // read from an asserted arr[i]! — the decisions doc's stated regime for element reads.
  noUncheckedIndexedAccess: true,
  // The optionals soundness anchor: under this flag a well-typed optional property is
  // either absent or a T, never explicitly set to undefined, so the analyzer's collapse
  // of absence into the undefined sentinel is exact. The doc cites this flag; it must
  // actually be on (a review round caught it set in the survey harness but not here).
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  // Single-file .tsx analysis (the style-slot pass); a plain .ts file never contains JSX,
  // so the option is inert there. @types/react (a devDependency) supplies jsx-runtime.
  jsx: ts.JsxEmit.ReactJSX,
}

export function checkFile(file: string): CheckedSource {
  const absoluteFile = resolve(file)
  const program = ts.createProgram([absoluteFile], compilerOptions)
  return checkedSource(program, absoluteFile)
}

export function checkSource(file: string, source: string): CheckedSource {
  const absoluteFile = resolve(file)
  const sourceFile = ts.createSourceFile(absoluteFile, source, ts.ScriptTarget.ESNext, true, absoluteFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const host = ts.createCompilerHost(compilerOptions)
  const defaultGetSourceFile = host.getSourceFile.bind(host)
  const defaultFileExists = host.fileExists.bind(host)
  const defaultReadFile = host.readFile.bind(host)
  host.getSourceFile = (requestedFile, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (resolve(requestedFile) === absoluteFile) return sourceFile
    return defaultGetSourceFile(requestedFile, languageVersion, onError, shouldCreateNewSourceFile)
  }
  host.fileExists = requestedFile => resolve(requestedFile) === absoluteFile || defaultFileExists(requestedFile)
  host.readFile = requestedFile => resolve(requestedFile) === absoluteFile ? source : defaultReadFile(requestedFile)
  const program = ts.createProgram([absoluteFile], compilerOptions, host)
  return checkedSource(program, absoluteFile)
}

function checkedSource(program: ts.Program, file: string): CheckedSource {
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics))
  const sourceFile = program.getSourceFile(file)
  if (sourceFile == null) throw new Error(`TypeScript did not load ${file}`)
  return {sourceFile, checker: program.getTypeChecker()}
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics.map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (diagnostic.file == null || diagnostic.start == null) return `TypeScript: ${message}`
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}: TypeScript: ${message}`
  }).join('\n')
}
