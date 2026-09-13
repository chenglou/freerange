// The registered rules file a milestone runs under (plan-a/registered/<milestone>.json), its reference records, and the
// mutant list both run.ts and report.ts derive from it.
import {readFileSync} from 'node:fs'
import {basename, join} from 'node:path'
import type {Value} from './domain.ts'
import {decodeJson} from './encode.ts'
import type {HarnessSignature} from './popovers-harness.ts'

// A copy is a directory of files that import each other; each file has a logical name that site keys carry.
export type CopyRule = {
  id: string
  dir: string
  files: {name: string; path: string}[] // path: inside the copy directory, e.g. `src/MidUI/PageFrame.ts`
  // A tsconfig.json inside the copy, copied to the root of every spliced tree so the copy's `@/…` path aliases resolve there
  tsconfig?: string
  role: string
  criterion: boolean // scored for criterion 1; a hindsight copy is reported, not scored
  signature?: HarnessSignature // popovers: which entry signatures recorded sweep inputs replay through
  expectedKills?: string[] // popovers: mutant ids the registered kill clause requires on this copy
  staticOnly?: string[] // popovers: mutant ids whose only recorded catch is static, checked at their registered input
}

type MutantBase = {id: string; copy: string; family: string; author: string}
// tree: a directory holding every file of the copy under the same names; replace: the copy with one file swapped;
// changes: exact text edits applied to the copy's files, each `from` occurring exactly once.
export type MutantRule = MutantBase & ({tree: string} | {replace: {file: string; path: string}} | {changes: {file: string; from: string; to: string}[]})
type MutantsRule = {kind: 'list'; items: MutantRule[]} | {kind: 'sysmut-record'; record: string; dir: string}

// stage before-baseline: published before any run of the milestone; after-baseline: frozen from the baseline-only run.
export type KnownFalseRule = {label: string; path: string; stage: 'before-baseline' | 'after-baseline'; criterion: boolean; copies: string[]}

export type Rules = {
  id: string
  family: 'virtualization' | 'popovers' | 'frames' | 'packing'
  measured_on: string
  domains_label: string
  data: {
    scratch: string
    copies: CopyRule[]
    mutants: MutantsRule
    reference: string
    knownFalse: KnownFalseRule[]
    referenceRun?: string
    sweepEntries?: string[]
    designSweepEntries?: string[]
  }
  // domain@v3-callers adds callerRules (the rule file and its sha1) and dropList (the witness run's list of dropped rules)
  domain: {version: string; cap: number; maxArrayLength: number; callerRules?: {path: string; sha1: string}; dropList?: string}
  lattice: {budget: number; seed: number; p0Inputs: number; p2ProductMax: number}
  rules: {noise: {criterion: string}}
  // stepBudget: the most loop body entries one call may run; absent in registrations before m4-packing, which had no loops
  execution: {children: number; heartbeatEveryInputs: number; heartbeatTimeoutSeconds: number; projectionMaxMinutes: number; stepBudget?: number}
  replay: {kind: 'sweep-first'; sweepCopyDir: string} | {kind: 'recorded-examples'}
  firstKillCalls: {mutants: string[]; entry: string}[]
  predictions: Record<string, unknown>
}

// virtualization-skeptic/rerun/sysmut_results.json
export type SysmutRow = {
  id: string
  family: string
  base: string
  fn: string
  line: number
  op: string
  after: string
  path: string
  diff: {n: number; diffs: number}
  sweep: {caught: boolean; label?: string; fn?: string; line?: number; evals?: number}
}

// plan-a/m2-prep/reference-popovers.json, built from the dense sweep's results/mutants.json and the skeptic's files.
export type RecordedCatch = {helper: string; kind: string; file: string; line: number; numbering: string; source: string; count: number; phases: string[]; example: Record<string, Value>}
export type PlantedMutant = {
  id: string
  helper: string
  bugClass: string
  description: string
  author: string
  copies: string[]
  sweep: {caught: boolean; catches: RecordedCatch[]} | null
  hindsightSweep: {caught: boolean; catches: RecordedCatch[]; note: string} | null
  sparse: {key: string; n: number}[] | null
  static: Record<string, boolean | null>
  behaviorExample: {entry: string; args: Value[]; original: Value; mutant: Value} | null
}
export type PlantedReference = {sources: Record<string, {path: string; sha1: string}>; mutants: PlantedMutant[]; staticOnly: {id: string; entry: string; rule: string; args: Value[]; source: string}[]}

// plan-a/m3-prep/reference-frames.json, built from the frames sweep's results/mutants.json and results/sweep-M*.json, the
// static runs recorded there, and the skeptic's real-caller classification (experiment-frames-skeptic.md correction 4).
// A recorded catch is one (sweep family, mode, assert line) whose failure count rose above the unmutated inv/ sweep; lines
// use inv/ numbering and `file` is the copy file's logical name, e.g. `NewSidebarLayout`.
export type FramesRecordedCatch = {family: string; mode: string; file: string; line: number; numbering: string; label: string; count: number; baselineCount: number; examples: Value[][]}
export type FramesMutant = {
  id: string
  bugClass: string
  file: string
  note: string
  sweep: {caught: boolean; caughtOnlyOutOfDomain: boolean; evaluations: number; catches: FramesRecordedCatch[]; outOfDomain: FramesRecordedCatch[]}
  static: {typescript: boolean; freerangeAsWritten: boolean; freerangeReshaped: boolean}
  realCallers: {changesBehavior: boolean; basis: string}
}
export type FramesReference = {sources: Record<string, {path: string; sha1: string}>; mutants: FramesMutant[]}

// plan-a/m4-prep/reference-packing.json, built from the packing sweep's out/mutants.json and per-mutant sweep outputs
// (mutants/<id>/sweep-<copy>.json and packing-skeptic/extra/<id>/sweep-<copy>.json, each run with --first), the static runs
// recorded there, and the skeptic's notes on its six extra mutants. A recorded catch is one sweep section's first failing
// tag on the mutant tree: in-domain, or degenerate and absent from the unmutated copy's sweep. Lines use `numbering`'s copy.
export type PackingRecordedCatch = {section: string; tag: string; file: string; line: number; numbering: string; tier: 'in-domain' | 'degenerate'; count: number; example: Record<string, Value>}
export type PackingMutant = {
  id: string
  author: 'experimenter' | 'skeptic'
  klass: string
  description: string
  file: string // logical name of the changed copy file, e.g. `masonry`
  copies: string[]
  sweep: Record<string, {caughtInDomain: boolean; catches: PackingRecordedCatch[]}> // per copy the mutant exists on
  static: {typescript: boolean; freerangeAsWritten: string[]; freerangeReshaped: string[]}
  skepticNote: string | null
}
// A static-only catch is checked at its registered input shape: some criterion-rule first killing input of `entry` whose
// argument `argumentIndex` is below `below`, e.g. m10 at a masonryCardHeight column width below 1 px.
export type PackingStaticOnly = {id: string; entry: string; argumentIndex: number; below: number; condition: string; source: string}
export type PackingReference = {sources: Record<string, {path: string; sha1: string}>; mutants: PackingMutant[]; staticOnly: PackingStaticOnly[]}

export type KeyedMutantRule = MutantRule & {key: string}

/** Every mutant the rules name, with its key: the sysmut id for a record, `copy/id` for a list. */
export function normalizedMutants(rules: Rules): KeyedMutantRule[] {
  const mutants = rules.data.mutants
  if (mutants.kind === 'list') return mutants.items.map((item) => ({...item, key: `${item.copy}/${item.id}`}))
  const rows = decodeJson(readFileSync(join(rules.data.scratch, mutants.record), 'utf8')) as SysmutRow[]
  return rows.map((row) => ({id: row.id, copy: row.base, family: row.family, author: 'skeptic_sysmut.ts', replace: {file: row.base, path: join(rules.data.scratch, mutants.dir, basename(row.path))}, key: row.id}))
}
