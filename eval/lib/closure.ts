// The project-local import closure of a set of files, e.g. a layout file plus the type and value modules it imports, so
// a corpus unit type-checks on its own. Bare specifiers (packages) aren't copied; they are listed so the unit can declare
// the node_modules it needs. The walk visits each file once and stops at a file cap.
import {dirname, join, normalize} from 'node:path'
import * as ts from 'typescript'

export type SourceReader = (path: string) => string | null

export type ImportClosure = {
  files: Map<string, string>
  packages: string[]
  unresolved: string[]
  capped: boolean
}

// Corpus units hold a handful of files; the cap only has to stop a closure that pulls in an application.
export const defaultMaxClosureFiles = 400

const extensions = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx']

function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function resolveSpecifier(from: string, specifier: string, read: SourceReader, aliasPrefix: string | null): {path: string; text: string} | null {
  let base: string
  if (specifier.startsWith('.')) {
    base = normalize(join(dirname(from), specifier))
  } else if (aliasPrefix != null && specifier.startsWith('@/')) {
    base = normalize(join(aliasPrefix, specifier.slice(2)))
  } else {
    return null
  }
  const withoutJs = base.replace(/\.js$/, '')
  for (const extension of extensions) {
    const candidate = `${withoutJs}${extension}`
    const text = read(candidate)
    if (text != null) return {path: candidate, text}
  }
  return null
}

export function importClosure(entries: string[], read: SourceReader, options: {aliasPrefix: string | null; maxFiles?: number}): ImportClosure {
  const maxFiles = options.maxFiles ?? defaultMaxClosureFiles
  const files = new Map<string, string>()
  const packages = new Set<string>()
  const unresolved: string[] = []
  const queue: string[] = []
  let capped = false
  for (const entry of entries) {
    const text = read(entry)
    if (text == null) {
      unresolved.push(entry)
      continue
    }
    files.set(entry, text)
    queue.push(entry)
  }
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index]!
    const info = ts.preProcessFile(files.get(from)!, true, true)
    for (const imported of info.importedFiles) {
      const specifier = imported.fileName
      if (!specifier.startsWith('.') && !(options.aliasPrefix != null && specifier.startsWith('@/'))) {
        packages.add(packageName(specifier))
        continue
      }
      const resolved = resolveSpecifier(from, specifier, read, options.aliasPrefix)
      if (resolved == null || resolved.path === '') {
        unresolved.push(`${from}: ${specifier}`)
        continue
      }
      if (files.has(resolved.path)) continue
      if (files.size >= maxFiles) {
        capped = true
        break
      }
      files.set(resolved.path, resolved.text)
      queue.push(resolved.path)
    }
    if (capped) break
  }
  return {files, packages: [...packages].sort(), unresolved, capped}
}
