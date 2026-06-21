export function formatTestDiagnostics(value: unknown) {
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  const text = JSON.stringify(value, (key, current: unknown) => {
    if (key === 'obligation' || key === 'trace' || key === 'detail') return undefined
    return current
  }, 2) ?? String(value)
  const lines = text.split('\n')
  const limit = 80
  if (lines.length <= limit) return text
  return [...lines.slice(0, limit), `... ${lines.length - limit} more lines`].join('\n')
}
