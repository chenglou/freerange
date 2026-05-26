import * as ts from 'typescript'

export function formatTypeScriptDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
  const host = formatDiagnosticsHost()
  return (shouldFormatPretty() ? ts.formatDiagnosticsWithColorAndContext(diagnostics, host) : ts.formatDiagnostics(diagnostics, host)).trimEnd()
}

function formatDiagnosticsHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: canonicalFileName,
    getCurrentDirectory: currentDirectory,
    getNewLine: () => '\n',
  }
}

function canonicalFileName(fileName: string) {
  const normalized = normalizePath(fileName)
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase()
}

function currentDirectory() {
  return normalizePath(ts.sys.getCurrentDirectory())
}

function shouldFormatPretty() {
  if (environmentVariable('NO_COLOR') !== '') return false
  if (environmentVariable('FORCE_COLOR') !== '') return true
  return ts.sys.writeOutputIsTTY?.() ?? false
}

function environmentVariable(name: string) {
  return (ts.sys as typeof ts.sys & {getEnvironmentVariable?: (name: string) => string | undefined}).getEnvironmentVariable?.(name) ?? ''
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/')
}
