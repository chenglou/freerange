import * as ts from 'typescript'

export type DiagnosticLevel = 'error' | 'warning' | 'suggestion'

type DiagnosticLocation = {
  file: string
  line: number
  column: number
}

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
  return usePrettyOutput(options['pretty'])
    ? ts.formatDiagnosticsWithColorAndContext(diagnostics, host)
    : ts.formatDiagnostics(diagnostics, host)
}

export function usePrettyOutput(configured?: unknown): boolean {
  if (typeof configured === 'boolean') return configured
  const noColor = process.env['NO_COLOR']
  if (noColor != null && noColor !== '') return false
  const forceColor = process.env['FORCE_COLOR']
  if (forceColor != null && forceColor !== '') return true
  return ts.sys.writeOutputIsTTY?.() === true
}

export function color(code: number, text: string | number): string {
  return `\u001B[${code}m${text}\u001B[0m`
}

export function formatDiagnosticPrefix(
  location: DiagnosticLocation,
  level: DiagnosticLevel,
  rule: string,
  pretty: boolean,
): string {
  const formattedLocation = formatDiagnosticLocation(location, pretty)
  const separator = pretty ? ' - ' : ': '
  const levelColor = level === 'error' ? 91 : level === 'warning' ? 93 : 96
  const formattedLevel = pretty ? color(levelColor, level) : level
  const ruleLabel = ` [${rule}]: `
  return `${formattedLocation}${separator}${formattedLevel}${pretty ? color(90, ruleLabel) : ruleLabel}`
}

export function formatDiagnosticLocation(location: DiagnosticLocation, pretty: boolean): string {
  const {file, line, column} = location
  return pretty
    ? `${color(96, file)}:${color(93, line)}:${color(93, column)}`
    : `${file}(${line},${column})`
}
