// What eval/sweep-mutants.ts decides without running anything: which corpus unit a Plan A copy is, the files a mutant tree
// replaces (refusing a tree whose files don't match the corpus), and the differences between a mutant's output and its
// original's that make a mutant sweep-caught or static-caught (runtime-sweeps registration §2 M2).

export type CopyFile = {file: string; sourceSha1: string}
export type MutantFile = {file: string; source: string; sourceSha1: string}
export type UnitSource = {path: string; sha1: string}

/** The corpus path of each copy file, matched by sha1, or null when some copy file is not in the unit. */
export function copyPaths(copyFiles: CopyFile[], unitSources: UnitSource[]): Map<string, string> | null {
  const result = new Map<string, string>()
  for (const copyFile of copyFiles) {
    const source = unitSources.find(candidate => candidate.sha1 === copyFile.sourceSha1)
    if (source == null) return null
    result.set(copyFile.file, source.path)
  }
  return result
}

export type TreePlan = {kind: 'tree'; replacements: Array<{path: string; from: string; sha1: string}>} | {kind: 'refused'; reason: string}

/**
 * The replacements that turn a unit tree into a mutant tree. Check 1: every changed file's original sha1 (the copy file's)
 * equals the corpus file's. Check 2: every file of the mutant that isn't changed has the corpus file's sha1.
 */
export function planMutantTree(copyFiles: CopyFile[], mutantFiles: MutantFile[], changedFiles: string[], unitSources: UnitSource[]): TreePlan {
  const replacements: Array<{path: string; from: string; sha1: string}> = []
  for (const changed of changedFiles) {
    const original = copyFiles.find(candidate => candidate.file === changed)
    const mutant = mutantFiles.find(candidate => candidate.file === changed)
    if (original == null || mutant == null) return {kind: 'refused', reason: `the plan has no copy or mutant file ${changed}`}
    const corpus = unitSources.find(candidate => candidate.sha1 === original.sourceSha1)
    if (corpus == null) return {kind: 'refused', reason: `check 1: the original of ${changed} (sha1 ${original.sourceSha1}) is not a corpus file of the unit`}
    replacements.push({path: corpus.path, from: mutant.source, sha1: mutant.sourceSha1})
  }
  for (const mutant of mutantFiles) {
    if (changedFiles.includes(mutant.file)) continue
    const original = copyFiles.find(candidate => candidate.file === mutant.file)
    const corpus = original == null ? undefined : unitSources.find(candidate => candidate.sha1 === original.sourceSha1)
    if (corpus == null || mutant.sourceSha1 !== corpus.sha1) return {kind: 'refused', reason: `check 2: the unchanged file ${mutant.file} (sha1 ${mutant.sourceSha1}) differs from the corpus tree`}
  }
  return {kind: 'tree', replacements}
}

/** Keys the mutant's output has and the original's doesn't, in the mutant's order, each once. */
export function siteSetDifference(mutantKeys: string[], originalKeys: string[]): string[] {
  const original = new Set(originalKeys)
  return [...new Set(mutantKeys)].filter(key => !original.has(key))
}

/** Multiset difference: each mutant entry not matched by a distinct equal original entry, e.g. two equal findings against one. */
export function multisetDifference(mutant: string[], original: string[]): string[] {
  const remaining = new Map<string, number>()
  for (const entry of original) remaining.set(entry, (remaining.get(entry) ?? 0) + 1)
  const result: string[] = []
  for (const entry of mutant) {
    const count = remaining.get(entry) ?? 0
    if (count > 0) remaining.set(entry, count - 1)
    else result.push(entry)
  }
  return result
}

const findingPattern = /^(.+?)\((\d+),(\d+)\): (error|warning) \[([a-z-]+)\]: (.*)$/

/** Error-level findings of `fr` stdout as `rule|message` entries, e.g. `console-assert|could not prove … in f: x >= 0`. */
export function errorFindings(stdout: string): string[] {
  const result: string[] = []
  for (const line of stdout.split('\n')) {
    const match = findingPattern.exec(line)
    if (match != null && match[4] === 'error') result.push(`${match[5]!}|${match[6]!}`)
  }
  return result
}
