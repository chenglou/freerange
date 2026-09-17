// Reads the FREERANGE_SWEEP_JSON sidecar a flag-on `fr <file>` run writes (proto/runtime-sweeps src/sweep/report.ts) and
// joins its per-site outcomes to the scorer's sites by position: the sidecar and lib/asserts.ts both record the line and
// column where the `console.assert` call starts.
import {existsSync, readFileSync} from 'node:fs'

export type SweepSiteJson = {
  key: string
  line: number
  column: number
  function: string | null
  role: string
  staticVerdict: string
  outcome: string
  n: number
  level2: number
  level3: number
  first: {entry: string; index: number; input: string; margin: number | null; cause: string; verified: boolean} | null
  why: string | null
  action: string | null
  callLine: number | null
  caller: string | null
}

export type SweepJson = {status: {kind: string; reason?: string}; sites: SweepSiteJson[]}

// The verdicts.jsonl column: the site's pooled outcome, N, the highest recorder level of an in-domain firing (3 when some
// input fired at level >= 3, 2 at level 2 only, 1 when reached without firing, 0 otherwise), and the first input the report
// used, with whether it verified.
export type SweepColumn = {outcome: string; n: number; level: number; cause: string | null; entry: string | null; input: string | null; verified: boolean | null; why: string | null; action: string | null; staticVerdict: string | null}

export function readSweepJson(path: string): SweepJson | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as SweepJson
}

export function sweepColumn(json: SweepJson | null, site: {line: number; column: number}, runFailure: string): SweepColumn {
  if (json == null) return {outcome: 'not-run', n: 0, level: 0, cause: null, entry: null, input: null, verified: null, why: runFailure === '' ? 'no sweep JSON was written' : runFailure, action: null, staticVerdict: null}
  const found = json.sites.find(candidate => candidate.line === site.line && candidate.column === site.column)
  if (found == null) return {outcome: 'not-run', n: 0, level: 0, cause: null, entry: null, input: null, verified: null, why: json.status.kind === 'not-run' ? json.status.reason ?? 'the sweep did not run' : 'the sweep JSON has no site at this position', action: null, staticVerdict: null}
  const level = found.level3 > 0 ? 3 : found.level2 > 0 ? 2 : found.n > 0 ? 1 : 0
  return {outcome: found.outcome, n: found.n, level, cause: found.first?.cause ?? null, entry: found.first?.entry ?? null, input: found.first?.input ?? null, verified: found.first?.verified ?? null, why: found.why, action: found.action, staticVerdict: found.staticVerdict}
}
