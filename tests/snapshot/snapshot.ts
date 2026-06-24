export function normalizeSnapshot(text: string) {
  return text.trimEnd() + '\n'
}

export async function verifySnapshot(path: string, actualText: string, label: string) {
  const actual = normalizeSnapshot(actualText)
  if (snapshotUpdateRequested()) {
    await Bun.write(path, actual)
    return true
  }
  const expected = normalizeSnapshot(await Bun.file(path).text())
  if (actual === expected) return true
  console.error(`${label}: snapshot changed`)
  console.error(formatSnapshotDiff(expected, actual))
  return false
}

export function formatSnapshotDiff(expectedText: string, actualText: string) {
  const expected = snapshotLines(expectedText)
  const actual = snapshotLines(actualText)
  let start = 0
  while (start < expected.length && start < actual.length && expected[start] === actual[start]) start += 1

  let expectedEnd = expected.length
  let actualEnd = actual.length
  while (
    expectedEnd > start
    && actualEnd > start
    && expected[expectedEnd - 1] === actual[actualEnd - 1]
  ) {
    expectedEnd -= 1
    actualEnd -= 1
  }

  const contextStart = Math.max(0, start - 2)
  const contextEnd = Math.min(expected.length, expectedEnd + 2)
  const lines = [
    `@@ expected ${lineRange(start, expectedEnd)}, actual ${lineRange(start, actualEnd)} @@`,
  ]
  for (const line of expected.slice(contextStart, start)) lines.push(`  ${line}`)
  addChangedLines(lines, '-', expected.slice(start, expectedEnd))
  addChangedLines(lines, '+', actual.slice(start, actualEnd))
  for (const line of expected.slice(expectedEnd, contextEnd)) lines.push(`  ${line}`)
  return lines.join('\n')
}

function snapshotLines(text: string) {
  const normalized = normalizeSnapshot(text)
  return normalized.slice(0, -1).split('\n')
}

function lineRange(start: number, end: number) {
  if (start === end) return `${start + 1}`
  return `${start + 1}-${end}`
}

function addChangedLines(lines: string[], prefix: '-' | '+', changed: string[]) {
  const limit = 16
  for (const line of changed.slice(0, limit)) lines.push(`${prefix} ${line}`)
  if (changed.length > limit) lines.push(`${prefix} ... ${changed.length - limit} more lines`)
}

export function snapshotUpdateRequested() {
  return Bun.argv.includes('--update') || Bun.env['FREERANGE_UPDATE_SNAPSHOTS'] === '1'
}
