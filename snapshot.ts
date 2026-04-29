export function normalizeSnapshot(text: string) {
  return text.trimEnd() + '\n'
}

export function displayWorkspaceFile(file: string) {
  const repoDir = new URL('.', import.meta.url).pathname
  const workspaceDir = repoDir.replace(/\/[^/]+\/$/, '/')
  if (file.startsWith(repoDir)) return file.slice(repoDir.length)
  if (file.startsWith(workspaceDir)) return `../${file.slice(workspaceDir.length)}`
  return file
}

export async function verifySnapshot(path: string, actualText: string, label: string) {
  const actual = normalizeSnapshot(actualText)
  if (Bun.argv.includes('--update')) {
    await Bun.write(path, actual)
    console.log(`${label}: updated`)
    return true
  }
  const expected = normalizeSnapshot(await Bun.file(path).text())
  if (actual === expected) {
    console.log(`${label}: matched`)
    return true
  }
  console.error(`${label}: snapshot changed`)
  console.error('\nExpected:\n' + expected)
  console.error('Actual:\n' + actual)
  return false
}
