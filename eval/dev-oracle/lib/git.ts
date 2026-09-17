// Read-only git access to the owners' clones, plus `git worktree add --detach` for this harness's own trees.
import {spawnSync} from 'node:child_process'

export type GitResult = {ok: boolean; stdout: string; stderr: string}

export function git(directory: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', directory, ...args], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})
  return {ok: result.status === 0, stdout: result.stdout, stderr: result.stderr}
}

// The full hash of `revision` as a commit, or null when the clone doesn't have it.
export function resolveCommit(clone: string, revision: string): string | null {
  const result = git(clone, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
  return result.ok ? result.stdout.trim() : null
}

// The file's content at `commit`, or null when the path doesn't exist there.
export function showFile(clone: string, commit: string, path: string): string | null {
  const result = git(clone, ['show', `${commit}:${path}`])
  return result.ok ? result.stdout : null
}

export function filesIdentical(clone: string, left: string, right: string, path: string): boolean {
  return spawnSync('git', ['-C', clone, 'diff', '--quiet', left, right, '--', path]).status === 0
}
