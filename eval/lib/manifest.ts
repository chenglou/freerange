// The corpus layout the scorer reads: <corpus>/manifest.json lists units, and each unit has a unit.json with its analyzed
// files, provenance and ground truth, plus a tree/ directory that is copied to a work directory and analyzed with that
// directory as the working directory.
import {existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

// A slice groups units that come from one source, e.g. `synthetic` for the example corpus.
export type Slice = string

// One stored input that makes an assert fire on the unmutated code: call `entry`, exported (or export-shimmed) from
// `entryFile`, with `args`, a JavaScript array literal of the arguments.
export type Example = {
  entryFile: string
  entry: string
  args: string
  source: string
}

// Each evidence field is null when the unit's source doesn't provide that kind of evidence.
export type GroundTruthSite = {
  key: string
  file: string
  line: number | null
  owner: string
  text: string
  labels: {reader: string; stricter: string} | null
  lattice: {run: string; domain: string; inputsReached: number; firing: {none: number; abs1e9: number; literal: number}; byCause: Record<string, number>} | null
  // firing counts every firing input of the witness sets; withoutDomainLine counts those where no domain line (a leading
  // assert or a substituted callee requirement) fired in the same call, the only ones that can be in-domain.
  witness: {run: string; sets: string[]; firing: number; withoutDomainLine: number} | null
  kills: {run: string; rule: string; count: number; generated: number; planted: number; mutants: string[]} | null
  catching: boolean
  replay: {report: string; stage: string; stageCommit: string; firesAtStage: boolean; evidence: Record<string, unknown>} | null
  examples: Example[]
}

export type CorpusUnit = {
  id: string
  slice: Slice
  family: string
  tree: string
  analyze: string[]
  tsconfig: boolean
  nodeModules: string | null
  packages: string[]
  unresolvedImports: string[]
  provenance: {sources: Array<{path: string; from: string; sha1: string}>; runs: string[]; notes: string[]}
  recordedFindings: Array<{file: string; revision: string; lines: string[]}>
  groundTruth: GroundTruthSite[]
}

export type CorpusManifest = {
  version: string
  builtAt: string
  scratchRoot: string
  counting: Record<string, string>
  slices: Record<string, {status: string; units: number; description: string}>
  skipped: Array<{id: string; reason: string}>
  units: Array<{id: string; slice: Slice; family: string; unitFile: string}>
}

// A manifest past this size is a builder bug, not a corpus.
export const maxUnits = 2_000

export function validateManifest(manifest: CorpusManifest, cap = maxUnits): void {
  if (manifest.units.length > cap) throw new Error(`manifest lists ${manifest.units.length} units, above the cap of ${cap}`)
  const seen = new Set<string>()
  for (const unit of manifest.units) {
    if (seen.has(unit.id)) throw new Error(`duplicate unit id ${unit.id}`)
    seen.add(unit.id)
  }
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown as T
}

export function loadManifest(corpusRoot: string): {manifest: CorpusManifest; units: CorpusUnit[]} {
  const manifest = readJsonFile<CorpusManifest>(join(corpusRoot, 'manifest.json'))
  validateManifest(manifest)
  const units = manifest.units.map(entry => readJsonFile<CorpusUnit>(join(corpusRoot, entry.unitFile)))
  return {manifest, units}
}

// The first tsconfig.json at or above a directory, the way Freerange resolves its configuration from the working
// directory (src/typescript/project.ts findTypeScriptConfig). The walk stops at the root or after maxDepth parents.
export function findConfigUpward(start: string, maxDepth = 256): string | null {
  let current = start
  for (let depth = 0; depth <= maxDepth; depth++) {
    const candidate = join(current, 'tsconfig.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}
