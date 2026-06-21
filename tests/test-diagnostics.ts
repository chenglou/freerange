export function formatTestDiagnostics(value: unknown) {
  if (typeof value === 'string') return boundTestDiagnostics(value)
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  const text = JSON.stringify(value, (key, current: unknown) => {
    if (key === 'obligation' || key === 'trace' || key === 'detail') return undefined
    if (current instanceof Map) {
      const collection: Map<unknown, unknown> = current
      return [...collection]
    }
    if (current instanceof Set) {
      const collection: Set<unknown> = current
      return [...collection]
    }
    return current
  }, 2) ?? String(value)
  return boundTestDiagnostics(text)
}

function boundTestDiagnostics(text: string) {
  const lines = text.split('\n')
  const limit = 80
  if (lines.length <= limit) return text
  return [...lines.slice(0, limit), `... ${lines.length - limit} more lines`].join('\n')
}

export function testDiagnosticError(message: string, diagnostics: unknown) {
  return new Error(`${message}\n${formatTestDiagnostics(diagnostics)}`)
}
