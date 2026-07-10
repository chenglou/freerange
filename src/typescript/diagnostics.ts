import * as ts from 'typescript'

export class TypeScriptDiagnosticsError extends Error {
  constructor(
    readonly diagnostics: readonly ts.Diagnostic[],
    readonly options: ts.CompilerOptions,
    readonly currentDirectory: string,
  ) {
    super(formatTypeScriptDiagnostics(diagnostics, {...options, pretty: false}, currentDirectory))
    this.name = 'TypeScriptDiagnosticsError'
  }
}

export function formatTypeScriptDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  options: ts.CompilerOptions,
  currentDirectory: string,
): string {
  const host: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => currentDirectory,
    getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? file => file : file => file.toLowerCase(),
    getNewLine: () => ts.sys.newLine,
  }
  return usePrettyDiagnostics(options)
    ? ts.formatDiagnosticsWithColorAndContext(diagnostics, host)
    : ts.formatDiagnostics(diagnostics, host)
}

function usePrettyDiagnostics(options: ts.CompilerOptions): boolean {
  const configured = options['pretty']
  if (typeof configured === 'boolean') return configured
  const noColor = process.env['NO_COLOR']
  if (noColor != null && noColor !== '') return false
  const forceColor = process.env['FORCE_COLOR']
  if (forceColor != null && forceColor !== '') return true
  return ts.sys.writeOutputIsTTY?.() === true
}
