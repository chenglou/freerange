// The snapshot and fix trees of each eligible entry: one detached worktree per entry and tree, created on demand, with
// dependencies installed only where Freerange needs them, and the catching check inserted into it.
import {spawnSync} from 'node:child_process'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import * as ts from 'typescript'
import {sha1} from './entries.ts'
import {git} from './git.ts'

export function ensureWorktree(clone: string, commit: string, directory: string): {ok: boolean; detail: string} {
  if (existsSync(directory)) {
    const head = git(directory, ['rev-parse', 'HEAD'])
    if (!head.ok || head.stdout.trim() !== commit) return {ok: false, detail: `${directory} exists at ${head.stdout.trim()}, not ${commit}`}
    return {ok: true, detail: 'existing worktree'}
  }
  const added = git(clone, ['worktree', 'add', '--detach', directory, commit])
  return {ok: added.ok, detail: added.ok ? 'created' : added.stderr.trim()}
}

// Freerange builds the program from the tree's tsconfig, so a tree needs its packages when that tsconfig names `types`,
// or when the analyzed file imports a package. Relative imports and `node:` builtins need none. Null when nothing is needed.
export function dependencyNeed(treeRoot: string, fileText: string): string | null {
  const configPath = join(treeRoot, 'tsconfig.json')
  const reasons: string[] = []
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, path => readFileSync(path, 'utf8'))
    const compilerOptions: unknown = (config.config as {compilerOptions?: unknown} | undefined)?.compilerOptions
    const types: unknown = compilerOptions != null && typeof compilerOptions === 'object' ? (compilerOptions as {types?: unknown}).types : undefined
    if (Array.isArray(types) && types.length > 0) reasons.push(`tsconfig types ${types.map(String).join(', ')}`)
  }
  const packages = ts.preProcessFile(fileText, true, true).importedFiles
    .map(imported => imported.fileName)
    .filter(name => !name.startsWith('.') && !name.startsWith('/') && !name.startsWith('node:'))
  if (packages.length > 0) reasons.push(`imports ${[...new Set(packages)].join(', ')}`)
  return reasons.length === 0 ? null : reasons.join('; ')
}

export function ensureDependencies(treeRoot: string, need: string | null): {ok: boolean; detail: string} {
  if (need == null) return {ok: true, detail: 'none needed'}
  if (existsSync(join(treeRoot, 'node_modules'))) return {ok: true, detail: `present (${need})`}
  if (!existsSync(join(treeRoot, 'bun.lock')) && !existsSync(join(treeRoot, 'bun.lockb'))) return {ok: false, detail: `needed (${need}), but the tree has no bun lockfile`}
  const install = spawnSync('bun', ['install', '--frozen-lockfile'], {cwd: treeRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
  return {ok: install.status === 0, detail: `bun install --frozen-lockfile exited ${install.status ?? 'none'} (${need})${install.status === 0 ? '' : `: ${install.stderr.trim().split('\n').at(-1) ?? ''}`}`}
}

// Writes the inserted file into the tree when the tree still holds the commit's file; leaves it when the insertion is
// already there; refuses anything else. Returns the diff against the commit.
export function applyInsertion(treeRoot: string, path: string, pristineSha1: string, insertedText: string): {ok: boolean; detail: string; diff: string} {
  const filePath = join(treeRoot, path)
  const current = readFileSync(filePath, 'utf8')
  if (sha1(current) === sha1(insertedText)) return {ok: true, detail: 'already inserted', diff: git(treeRoot, ['diff', '--no-color', '--', path]).stdout}
  if (sha1(current) !== pristineSha1) return {ok: false, detail: `${filePath} holds neither the commit's file nor the insertion`, diff: ''}
  writeFileSync(filePath, insertedText)
  return {ok: true, detail: 'inserted', diff: git(treeRoot, ['diff', '--no-color', '--', path]).stdout}
}
