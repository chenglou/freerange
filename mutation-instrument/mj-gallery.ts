// Family mj-gallery (plan-a/registered/m7-mj-gallery.json): mj-gallery's own layout asserts at a pinned prealpha commit, one
// copy per in-scope file of a detached worktree, run against astmut@v1's operator mutants (astmut.ts) and seven hand-planted
// tooltip mutants whose recorded sweep catches make up the kill clause. The registration's layout differs from the families
// before it, so this module turns it into the Rules that run.ts, report.ts and scoring.ts read:
//   copies.list[i]                  data.copies[i]: the worktree as the directory, its tsconfig copied into spliced trees, each
//                                   file named by its basename (e.g. `tooltipLayout`), entries per file, export@v1 names,
//                                   excluded entries, and the worktree's node_modules for a copy that imports a package
//   the astmut table's valid rows   change-table mutants keyed `<copy>/<id>`, e.g. `c13-tooltip/m7-c13-tooltip-042`
//   criterion1.planted              change-table mutants keyed `<copy>/P1` … `<copy>/P7`
//   knownFalse                      the before-baseline criterion list and the unscored after-baseline list, over every copy
// Every in-scope file is checked against source.fileSha1, and the before-baseline list against its registered sha1.
import {createHash} from 'node:crypto'
import {existsSync, readFileSync} from 'node:fs'
import {basename, extname, join} from 'node:path'
import {decodeJson} from './encode.ts'
import type {CopyRule, MutantRule, Rules, ScoringRegistration} from './rules.ts'

// Registered order step 3: astmut@v1 generation into freerange-focus/plan-a/m7-prep/astmut/. astmut.ts writes table.json there.
export const ASTMUT_DIR = 'freerange-focus/plan-a/m7-prep/astmut'

export type AstmutOperator = 'O1' | 'O2' | 'O3' | 'O4' | 'O5' | 'O6' | 'O7' | 'O8' | 'O9'
// One generated mutant. status valid: planned. duplicate: E1, the mutated file equals the original's or an earlier mutant's
// of the copy (duplicateOf names which). invalid: E2, the mutated file has TypeScript syntax diagnostics.
export type AstmutRow = {
  id: string // m7-<copy>-<ordinal>, in source order then operator order, e.g. m7-c02-midui-004
  copy: string
  file: string // the file's path in the worktree
  function: string // the scope function or constant that holds the changed node
  line: number // 1-based, of the changed node's start
  column: number
  operator: AstmutOperator
  before: string // the changed node's text, e.g. `Math.min` or `<=`
  after: string
  sha1: string // of the whole mutated file, before export@v1
  status: 'valid' | 'duplicate' | 'invalid'
  duplicateOf: string | null
  diagnostics: string[]
  change: {file: string; from: string; to: string} // `from` occurs exactly once in the pinned file
  widenedAcrossLines: boolean // no text on the changed node's lines was unique, so `from` spans neighbouring lines
}
export type AstmutCopy = {copy: string; file: string; scopeFunctions: string[]; scopeConstants: string[]; generated: number; droppedUnchangedText: number; duplicates: number; invalid: number; valid: number}
export type AstmutTable = {version: 'astmut@v1'; registration: {path: string; sha1: string}; generator: {commit: string; dirty: boolean; sha1: string}; copies: AstmutCopy[]; rows: AstmutRow[]; checks: string[]}

type LabelGroups = Record<string, number[]> // logical file name to assert lines, e.g. {CoachmarkLayout: [48, 49, 53]}
export type MjGalleryPlant = {id: string; flag: string; changes: {file: string; from: string; to: string}[]; recorded: string}
export type MjGalleryWitnessSet = {name: string; script: string; scriptSha1: string; args: string[]; substitute: {from: string; to: string} | null; tiers: 'all'; copies: string[]}

export type MjGalleryRegistration = {
  id: string
  family: 'mj-gallery'
  measured_on: string
  domains_label: string
  data: {scratch: string}
  source: {commit: string; worktree: string; fileSha1: Record<string, string>}
  // nodeModules: present (as a description) on a copy whose spliced tree roots link the worktree's node_modules
  copies: {list: {id: string; files: {path: string; entries: boolean}[]; exportShim?: string[]; excludedEntries?: string[]; nodeModules?: string}[]}
  labels: {inScope: {precondition: LabelGroups; real: LabelGroups; realRestatedUnderStricter: LabelGroups; restated: LabelGroups}}
  domain: {version: string; cap: number; maxArrayLength: number}
  lattice: {budget: number; seed: number; p0Inputs: number; p2ProductMax: number}
  rules: {noiseCriterion: string}
  execution: {children: number; heartbeatEveryInputs: number; heartbeatTimeoutSeconds: number; projectionMaxMinutes: number; stepBudget: number}
  knownFalse: {beforeBaseline: {label: string; path: string; sha1: string; criterion: boolean}; afterBaseline: {label: string; path: string; criterion: boolean}}
  criterion1: {planted: MjGalleryPlant[]}
  scoringWitness: {version: string; gates: ScoringRegistration['gates']; reservoir: number; witnessSets: MjGalleryWitnessSet[]}
  predictions: Record<string, unknown>
}

export type MjGalleryExtras = {registration: MjGalleryRegistration; worktree: string; astmutTable: string; astmutTableSha1: string; plants: {id: string; copy: string; flag: string; recorded: string}[]}

function sha1(text: string | Buffer) {
  return createHash('sha1').update(text).digest('hex')
}

export function mjGalleryRules(registration: MjGalleryRegistration): Rules {
  const scratch = registration.data.scratch
  // e.g. "S/wt/m7-prealpha-93b9935807, created with `git -C … worktree add --detach …`"
  const worktreeMatch = /^S\/(\S+?),/.exec(registration.source.worktree)
  if (worktreeMatch == null) throw new Error(`source.worktree doesn't start with an S/ path: ${registration.source.worktree}`)
  const worktree = worktreeMatch[1]!
  const worktreeDir = join(scratch, worktree)
  const copies = registration.copies.list.map((copy) => {
    for (const file of copy.files) {
      const expected = registration.source.fileSha1[file.path]
      const actual = sha1(readFileSync(join(worktreeDir, file.path)))
      if (actual !== expected) throw new Error(`${copy.id}: ${file.path} sha1 ${actual} differs from the registered ${expected ?? '(none)'}`)
    }
    const rule: CopyRule = {
      id: copy.id, dir: worktree, tsconfig: 'tsconfig.json', role: `prealpha ${registration.source.commit.slice(0, 10)}`, criterion: true,
      files: copy.files.map((file) => ({name: basename(file.path, extname(file.path)), path: file.path, entries: file.entries})),
    }
    if (copy.exportShim != null) rule.exportShim = copy.exportShim
    if (copy.excludedEntries != null) rule.excludedEntries = copy.excludedEntries
    if (copy.nodeModules != null) rule.nodeModules = join(worktreeDir, 'node_modules')
    return rule
  })

  const tablePath = join(ASTMUT_DIR, 'table.json')
  if (!existsSync(join(scratch, tablePath))) throw new Error(`no astmut@v1 table at ${tablePath}: run astmut.ts first`)
  const tableText = readFileSync(join(scratch, tablePath), 'utf8')
  const table = decodeJson(tableText) as AstmutTable
  const items: MutantRule[] = []
  for (const row of table.rows) if (row.status === 'valid') items.push({id: row.id, copy: row.copy, family: row.operator, author: 'astmut@v1', changes: [row.change]})
  const plants = registration.criterion1.planted.map((plant) => {
    const copy = copies.find((candidate) => plant.changes.every((change) => candidate.files.some((file) => file.path === change.file)))
    if (copy == null) throw new Error(`plant ${plant.id} changes a file that no copy holds`)
    items.push({id: plant.id, copy: copy.id, family: 'planted', author: 'hand-planted (had seen the asserts)', changes: plant.changes})
    return {id: plant.id, copy: copy.id, flag: plant.flag, recorded: plant.recorded}
  })

  const before = registration.knownFalse.beforeBaseline
  const after = registration.knownFalse.afterBaseline
  if (existsSync(join(scratch, before.path)) && sha1(readFileSync(join(scratch, before.path))) !== before.sha1) throw new Error(`${before.path}: sha1 differs from the registered ${before.sha1}`)
  const copyIds = copies.map((copy) => copy.id)
  const execution = registration.execution
  return {
    id: registration.id,
    family: 'mj-gallery',
    measured_on: registration.measured_on,
    domains_label: registration.domains_label,
    data: {
      scratch, copies, mutants: {kind: 'list', items}, reference: tablePath,
      knownFalse: [
        {label: before.label, path: before.path, stage: 'before-baseline', criterion: before.criterion, copies: copyIds},
        {label: after.label, path: after.path, stage: 'after-baseline', criterion: after.criterion, copies: copyIds},
      ],
    },
    domain: {version: registration.domain.version, cap: registration.domain.cap, maxArrayLength: registration.domain.maxArrayLength},
    lattice: registration.lattice,
    rules: {noise: {criterion: registration.rules.noiseCriterion}},
    execution: {children: execution.children, heartbeatEveryInputs: execution.heartbeatEveryInputs, heartbeatTimeoutSeconds: execution.heartbeatTimeoutSeconds, projectionMaxMinutes: execution.projectionMaxMinutes, stepBudget: execution.stepBudget},
    replay: {kind: 'recorded-examples'},
    firstKillCalls: [],
    predictions: registration.predictions,
    mjGallery: {registration, worktree, astmutTable: tablePath, astmutTableSha1: sha1(tableText), plants},
  }
}
