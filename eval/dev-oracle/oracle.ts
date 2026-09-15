// The oracle arm on the benchmark dataset's development split: insert each eligible entry's recorded catching check as a
// console.assert at the same site of its snapshot tree (the fix's first parent) and its fix tree, run Freerange on both
// files, and score whether the verdict at that assert separates the defect from the fix. See README.md.
//
//   bun eval/dev-oracle/oracle.ts eligibility --entries <entries.jsonl> --readings <readings.json> --dev-eval <dir> [--repo <name>=<clone>]...
//   bun eval/dev-oracle/oracle.ts prepare     (the same options) --worktrees <dir> [--entry <id>]...
//   bun eval/dev-oracle/oracle.ts run         (the same options) --freerange <checkout> --run <new directory> [--env NAME=VALUE]... [--timeout-seconds 300]
//   bun eval/dev-oracle/oracle.ts score       --run <run directory>
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {extractAssertSites, normalizeConditionText} from '../lib/asserts.ts'
import {failedRunReason, joinVerdicts, parseFreerangeOutput, type RunOutcome, type Verdict} from '../lib/findings.ts'
import {findConfigUpward} from '../lib/manifest.ts'
import {runMeasured} from '../lib/process.ts'
import {readSweepJson, sweepColumn} from '../lib/sweep.ts'
import {defaultClones, evaluateEligibility, formatEligibility, type Eligibility, type SelectedCheck, type TreeRole} from './lib/eligibility.ts'
import {readEntries, readReadings, sha1} from './lib/entries.ts'
import {git, showFile} from './lib/git.ts'
import {insertAssert} from './lib/placement.ts'
import {addToTotals, emptyTotals, scoreEntry, type ReachTotals, type SweepResult, type TreeResult} from './lib/score.ts'
import {applyInsertion, dependencyNeed, ensureDependencies, ensureWorktree} from './lib/trees.ts'

type Options = {
  command: string
  entries: string
  readings: string
  devEval: string
  worktrees: string
  freerange: string
  run: string
  env: Map<string, string>
  timeoutMs: number
  clones: Map<string, string>
  only: Set<string> | null
}

function parseOptions(argv: string[]): Options {
  const options: Options = {command: argv[0] ?? '', entries: '', readings: '', devEval: '', worktrees: '', freerange: '', run: '', env: new Map(), timeoutMs: 300_000, clones: defaultClones(), only: null}
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index]!
    const value = (): string => {
      const next = argv[++index]
      if (next == null) throw new Error(`${name} needs a value`)
      return next
    }
    const pair = (): [string, string] => {
      const text = value()
      const at = text.indexOf('=')
      if (at <= 0) throw new Error(`${name} takes NAME=VALUE`)
      return [text.slice(0, at), text.slice(at + 1)]
    }
    switch (name) {
      case '--entries': options.entries = resolve(value()); break
      case '--readings': options.readings = resolve(value()); break
      case '--dev-eval': options.devEval = resolve(value()); break
      case '--worktrees': options.worktrees = resolve(value()); break
      case '--freerange': options.freerange = resolve(value()); break
      case '--run': options.run = resolve(value()); break
      case '--timeout-seconds': options.timeoutMs = Number(value()) * 1000; break
      case '--entry': (options.only ??= new Set()).add(value()); break
      case '--env': {
        const [key, envValue] = pair()
        if (!key.startsWith('FREERANGE_') || key === 'FREERANGE_SWEEP_JSON') throw new Error(`--env takes FREERANGE_* flags other than FREERANGE_SWEEP_JSON, not ${key}`)
        options.env.set(key, envValue)
        break
      }
      case '--repo': {
        const [key, clone] = pair()
        options.clones.set(key, resolve(clone))
        break
      }
      default: throw new Error(`unknown option ${name}`)
    }
  }
  return options
}

function requireOptions(options: Options, names: Array<keyof Options>): void {
  const missing = names.filter(name => options[name] === '')
  if (missing.length > 0) throw new Error(`${options.command} needs ${missing.map(name => `--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`).join(', ')}`)
}

function computeEligibility(options: Options): Eligibility {
  return evaluateEligibility(readEntries(options.entries), readReadings(options.readings), options.clones)
}

function writeEligibility(directory: string, eligibility: Eligibility): void {
  mkdirSync(directory, {recursive: true})
  writeFileSync(join(directory, 'eligibility.json'), `${JSON.stringify(eligibility, null, 1)}\n`)
  writeFileSync(join(directory, 'eligibility.md'), formatEligibility(eligibility))
}

type PreparedTree = {role: TreeRole; commit: string; worktree: string; dependencies: string; assertLine: number; firstInsertedLine: number; insertedLineCount: number; pristineSha1: string; insertedSha1: string; diffPath: string; diffSha1: string}

type PreparedEntry = {id: string; reach: string; checkIndex: number; condition: string; bindings: SelectedCheck['bindings']; placement: SelectedCheck['placement']; clone: string; locationSnapshotCommit: string | null; siteFileIdenticalAtLocationSnapshot: boolean | null; trees: Record<TreeRole, PreparedTree>; preparedAt: string; entriesSha1: string; readingsSha1: string}

type InsertionsFile = {rule: string; entries: PreparedEntry[]}

function readInsertions(devEval: string): InsertionsFile {
  const path = join(devEval, 'insertions.json')
  if (!existsSync(path)) return {rule: 'dev-oracle-insertions@v1', entries: []}
  return JSON.parse(readFileSync(path, 'utf8')) as InsertionsFile
}

const treeRoles: TreeRole[] = ['snapshot', 'fix']

function prepare(options: Options): number {
  requireOptions(options, ['entries', 'readings', 'devEval', 'worktrees'])
  const eligibility = computeEligibility(options)
  writeEligibility(options.devEval, eligibility)
  const insertions = readInsertions(options.devEval)
  let failed = 0
  for (const row of eligibility.rows) {
    if (!row.eligible || row.selected == null || (options.only != null && !options.only.has(row.id))) continue
    const selected = row.selected
    const trees: Partial<Record<TreeRole, PreparedTree>> = {}
    for (const role of treeRoles) {
      const tree = selected.trees[role]
      const worktree = join(options.worktrees, row.id, role)
      const step = (what: string, result: {ok: boolean; detail: string}): boolean => {
        console.log(`${row.id} ${role}: ${what}: ${result.detail}`)
        return result.ok
      }
      mkdirSync(dirname(worktree), {recursive: true})
      if (!step(`worktree at ${tree.commit.slice(0, 10)}`, ensureWorktree(selected.clone, tree.commit, worktree))) break
      const pristine = showFile(selected.clone, tree.commit, selected.placement.path)!
      const insertion = insertAssert(selected.placement.path, pristine, {function: selected.placement.function, anchor: selected.placement.anchor, position: selected.placement.position, condition: selected.condition, bindings: selected.bindings})
      if (insertion.kind === 'failed' || sha1(insertion.text) !== tree.insertedSha1) {
        step('insertion', {ok: false, detail: 'the insertion no longer reproduces the eligibility record'})
        break
      }
      const need = dependencyNeed(worktree, pristine)
      const dependencies = ensureDependencies(worktree, need)
      if (!step('dependencies', dependencies)) break
      const applied = applyInsertion(worktree, selected.placement.path, tree.pristineSha1, insertion.text)
      if (!step('insertion', applied)) break
      const diffPath = join(options.devEval, 'insertions', row.id, `${role}.diff`)
      mkdirSync(dirname(diffPath), {recursive: true})
      writeFileSync(diffPath, applied.diff)
      trees[role] = {role, commit: tree.commit, worktree, dependencies: dependencies.detail, assertLine: insertion.assertLine, firstInsertedLine: insertion.firstInsertedLine, insertedLineCount: insertion.insertedLineCount, pristineSha1: tree.pristineSha1, insertedSha1: tree.insertedSha1, diffPath, diffSha1: sha1(applied.diff)}
    }
    if (trees.snapshot == null || trees.fix == null) {
      failed++
      continue
    }
    const prepared: PreparedEntry = {
      id: row.id, reach: row.reach, checkIndex: selected.checkIndex, condition: selected.condition, bindings: selected.bindings, placement: selected.placement, clone: selected.clone,
      locationSnapshotCommit: selected.locationSnapshotCommit, siteFileIdenticalAtLocationSnapshot: selected.siteFileIdenticalAtLocationSnapshot,
      trees: {snapshot: trees.snapshot, fix: trees.fix}, preparedAt: new Date().toISOString(), entriesSha1: eligibility.entries.sha1, readingsSha1: eligibility.readings.sha1,
    }
    insertions.entries = [...insertions.entries.filter(entry => entry.id !== row.id), prepared]
  }
  writeFileSync(join(options.devEval, 'insertions.json'), `${JSON.stringify(insertions, null, 1)}\n`)
  console.log(`prepared ${insertions.entries.length} entries; ${failed} failed`)
  return failed === 0 ? 0 : 1
}

type VerdictRow = {
  entry: string
  reach: string
  tree: TreeRole
  commit: string
  worktree: string
  path: string
  assertLine: number
  condition: string
  verdict: Verdict
  reason: string
  finding: string | null
  counterexample: string | null
  sweep: SweepResult | null
  tsconfig: string | null
  exitCode: number | null
  timedOut: boolean
  wallSeconds: number | null
  maxRssBytes: number | null
  findings: number
  coverage: string
  failure: string
  findingLines: string[]
}

type RunInfo = {
  startedAt: string
  freerange: {directory: string; revision: string; dirtyFiles: number}
  harness: {directory: string; revision: string; dirtyFiles: number}
  bun: string
  env: Record<string, string>
  timeoutSeconds: number
  entries: Eligibility['entries']
  readings: Eligibility['readings']
  eligible: string[]
  notPrepared: string[]
  preparedNoLongerEligible: string[]
}

function dirtyCount(directory: string, paths: string[]): number {
  return git(directory, ['status', '--porcelain', '--', ...paths]).stdout.split('\n').filter(line => line.length > 0).length
}

async function runTree(options: Options, prepared: PreparedEntry, role: TreeRole): Promise<VerdictRow> {
  const tree = prepared.trees[role]
  const path = prepared.placement.path
  const base = {entry: prepared.id, reach: prepared.reach, tree: role, commit: tree.commit, worktree: tree.worktree, path, assertLine: tree.assertLine, condition: prepared.condition}
  const unanalyzed = (reason: string): VerdictRow => ({...base, verdict: 'not-analyzed', reason, finding: null, counterexample: null, sweep: null, tsconfig: null, exitCode: null, timedOut: false, wallSeconds: null, maxRssBytes: null, findings: 0, coverage: '', failure: reason, findingLines: []})
  const filePath = join(tree.worktree, path)
  const text = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  if (sha1(text) !== tree.insertedSha1) return unanalyzed(`${filePath} doesn't hold the recorded insertion (sha1 ${tree.insertedSha1})`)
  const site = extractAssertSites(path, text).find(candidate => candidate.line === tree.assertLine && candidate.text === normalizeConditionText(prepared.condition))
  if (site == null) return unanalyzed(`the site extractor finds no console.assert(${prepared.condition}) at line ${tree.assertLine}`)

  const rawBase = join(options.run, 'raw', prepared.id, role)
  mkdirSync(dirname(rawBase), {recursive: true})
  const sweepOn = (options.env.get('FREERANGE_SWEEP') ?? '') !== ''
  const env: Record<string, string> = Object.fromEntries(options.env)
  if (sweepOn) env['FREERANGE_SWEEP_JSON'] = `${rawBase}.sweep.json`
  const run = await runMeasured([process.execPath, join(options.freerange, 'fr.ts'), path], tree.worktree, {timeoutMs: options.timeoutMs, maxOutputBytes: 16 * 1024 * 1024}, true, env)
  writeFileSync(`${rawBase}.stdout.txt`, run.stdout)
  writeFileSync(`${rawBase}.stderr.txt`, run.stderr)
  const parsed = parseFreerangeOutput(run.stdout)
  const failure = failedRunReason({timedOut: run.timedOut, timeoutMs: options.timeoutMs, spawnError: run.spawnError, exitCode: run.exitCode, stderr: run.stderr, coverageLine: parsed.coverageLine})
  const outcome: RunOutcome = failure == null ? {kind: 'ran', output: parsed} : {kind: 'failed', reason: failure}
  const verdict = joinVerdicts([site], outcome).get(site.key)!
  let sweep: SweepResult | null = null
  if (sweepOn) {
    const column = sweepColumn(readSweepJson(`${rawBase}.sweep.json`), site, failure ?? '')
    sweep = {outcome: column.outcome, n: column.n, verified: column.verified, entry: column.entry, input: column.input, why: column.why}
  }
  return {
    ...base,
    verdict: verdict.verdict,
    reason: verdict.reason,
    finding: verdict.finding,
    counterexample: sweep != null && sweep.outcome === 'counterexample' && sweep.verified === true ? `${sweep.entry ?? '?'}(${sweep.input ?? ''})` : null,
    sweep,
    tsconfig: findConfigUpward(tree.worktree),
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    wallSeconds: run.wallMs / 1000,
    maxRssBytes: run.maxRssBytes,
    findings: parsed.findings.length,
    coverage: parsed.coverageLine ?? '',
    failure: failure ?? '',
    findingLines: run.stdout.split('\n').filter(line => line.includes(': error [') || line.includes(': warning [')),
  }
}

async function runArm(options: Options): Promise<number> {
  requireOptions(options, ['entries', 'readings', 'devEval', 'freerange', 'run'])
  if (!existsSync(join(options.freerange, 'fr.ts'))) throw new Error(`no fr.ts in ${options.freerange}`)
  if (existsSync(options.run)) throw new Error(`${options.run} exists; each run writes a new directory`)
  mkdirSync(options.run, {recursive: true})
  const eligibility = computeEligibility(options)
  writeEligibility(options.run, eligibility)
  const insertions = readInsertions(options.devEval)
  const eligibleRows = eligibility.rows.filter(row => row.eligible && row.selected != null)
  const preparedFor = (id: string): PreparedEntry | null => {
    const row = eligibleRows.find(candidate => candidate.id === id)
    const prepared = insertions.entries.find(entry => entry.id === id)
    if (row?.selected == null || prepared == null) return null
    const same = prepared.condition === row.selected.condition && treeRoles.every(role => prepared.trees[role].insertedSha1 === row.selected!.trees[role].insertedSha1 && prepared.trees[role].commit === row.selected!.trees[role].commit)
    return same ? prepared : null
  }
  const harnessDirectory = new URL('.', import.meta.url).pathname
  const info: RunInfo = {
    startedAt: new Date().toISOString(),
    freerange: {directory: options.freerange, revision: git(options.freerange, ['rev-parse', 'HEAD']).stdout.trim(), dirtyFiles: dirtyCount(options.freerange, ['src', 'fr.ts', 'package.json', 'bun.lock'])},
    harness: {directory: harnessDirectory, revision: git(harnessDirectory, ['rev-parse', 'HEAD']).stdout.trim(), dirtyFiles: dirtyCount(harnessDirectory, ['.', '../lib'])},
    bun: Bun.version,
    env: Object.fromEntries(options.env),
    timeoutSeconds: options.timeoutMs / 1000,
    entries: eligibility.entries,
    readings: eligibility.readings,
    eligible: eligibleRows.map(row => row.id),
    notPrepared: eligibleRows.filter(row => preparedFor(row.id) == null).map(row => row.id),
    preparedNoLongerEligible: insertions.entries.filter(entry => !eligibleRows.some(row => row.id === entry.id)).map(entry => entry.id),
  }
  writeFileSync(join(options.run, 'run.json'), `${JSON.stringify(info, null, 1)}\n`)
  writeFileSync(join(options.run, 'verdicts.jsonl'), '')
  for (const row of eligibleRows) {
    const prepared = preparedFor(row.id)
    if (prepared == null) continue
    for (const role of treeRoles) {
      const verdictRow = await runTree(options, prepared, role)
      appendFileSync(join(options.run, 'verdicts.jsonl'), `${JSON.stringify(verdictRow)}\n`)
      console.log(`${row.id} ${role}: ${verdictRow.verdict} (${verdictRow.reason.slice(0, 160)})`)
    }
  }
  writeScore(options.run)
  return 0
}

function treeResult(row: VerdictRow): TreeResult {
  return {verdict: row.verdict, reason: row.reason, finding: row.finding, sweep: row.sweep}
}

function describe(row: VerdictRow): string {
  const sweep = row.sweep == null ? '' : `; sweep ${row.sweep.outcome}${row.sweep.outcome === 'held' ? ` on ${row.sweep.n} inputs` : ''}${row.counterexample == null ? '' : ` ${row.counterexample}`}`
  return `${row.verdict}: ${row.reason}${sweep}`.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function writeScore(runDirectory: string): void {
  const info = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as RunInfo
  const rows = readFileSync(join(runDirectory, 'verdicts.jsonl'), 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as VerdictRow)
  const byReach = new Map<string, ReachTotals>([['static', emptyTotals()], ['sweep', emptyTotals()]])
  const entries: Array<{id: string; reach: string; snapshot: VerdictRow; fix: VerdictRow; score: ReturnType<typeof scoreEntry>}> = []
  for (const snapshot of rows.filter(row => row.tree === 'snapshot')) {
    const fix = rows.find(row => row.tree === 'fix' && row.entry === snapshot.entry)
    if (fix == null) continue
    addToTotals(byReach.get(snapshot.reach) ?? byReach.set(snapshot.reach, emptyTotals()).get(snapshot.reach)!, treeResult(snapshot), treeResult(fix))
    entries.push({id: snapshot.entry, reach: snapshot.reach, snapshot, fix, score: scoreEntry(treeResult(snapshot), treeResult(fix))})
  }
  const summary = {run: info, finishedAt: new Date().toISOString(), totals: Object.fromEntries(byReach), entries: entries.map(entry => ({id: entry.id, reach: entry.reach, snapshot: entry.snapshot.verdict, fix: entry.fix.verdict, ...entry.score})), maxRssBytes: rows.reduce((max, row) => Math.max(max, row.maxRssBytes ?? 0), 0), timeouts: rows.filter(row => row.timedOut).length}
  writeFileSync(join(runDirectory, 'score.json'), `${JSON.stringify(summary, null, 1)}\n`)

  const flags = Object.entries(info.env).map(([key, value]) => `${key}=${value}`).join(' ')
  const lines: string[] = []
  lines.push(`# Oracle arm score: Freerange ${info.freerange.revision.slice(0, 10)}, ${flags === '' ? 'no flags' : flags}`, '')
  lines.push(`- Freerange ${info.freerange.revision} (${info.freerange.dirtyFiles} dirty files under src, fr.ts, package.json, bun.lock); harness ${info.harness.revision} (${info.harness.dirtyFiles} dirty files under eval/dev-oracle and eval/lib); bun ${info.bun}; per-file timeout ${info.timeoutSeconds} s; environment: ${flags === '' ? 'none' : flags}`)
  lines.push(`- entries.jsonl: ${info.entries.count} lines, sha1 ${info.entries.sha1}; readings sha1 ${info.readings.sha1}`)
  lines.push(`- Eligible (eligibility.md in this run directory): ${info.eligible.length}. Run on both trees: ${entries.length}. Eligible but not prepared: ${info.notPrepared.length === 0 ? 'none' : info.notPrepared.join(', ')}. Prepared but no longer eligible: ${info.preparedNoLongerEligible.length === 0 ? 'none' : info.preparedNoLongerEligible.join(', ')}.`, '')
  lines.push('## Score by reach', '', 'Counting rule: one row per eligible entry run on both trees. Refuted on a tree: verdict can-be-false at the inserted assert, or a verified sweep counterexample there. Points at the defect: refuted on the snapshot tree and not on the fix tree. Proved on the fix tree: verdict proved. Not analyzed on either: verdict not-analyzed on the snapshot tree, the fix tree or both.', '')
  lines.push('| reach | entries | points at defect | refuted on snapshot | refuted on fix | proved on fix | not analyzed on either | not analyzed on snapshot | not analyzed on fix |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const [reach, totals] of byReach) {
    lines.push(`| ${reach} | ${totals.entries} | ${totals.pointsAtDefect} | ${totals.refutedOnSnapshot} | ${totals.refutedOnFix} | ${totals.provedOnFix} | ${totals.notAnalyzedOnEither} | ${totals.notAnalyzedOnSnapshot} | ${totals.notAnalyzedOnFix} |`)
  }
  lines.push('', '## Verdicts at the inserted assert', '', '| entry | reach | snapshot tree | fix tree | points at defect |', '|---|---|---|---|---|')
  for (const entry of entries) {
    lines.push(`| ${entry.id} | ${entry.reach} | ${entry.snapshot.commit.slice(0, 10)} ${describe(entry.snapshot)} | ${entry.fix.commit.slice(0, 10)} ${describe(entry.fix)} | ${entry.score.pointsAtDefect ? 'yes' : 'no'} |`)
  }
  lines.push('', '## Runtime and peak RSS per file', '', '| entry | tree | file | exit | wall s | max RSS MB | findings | failure |', '|---|---|---|---:|---:|---:|---:|---|')
  for (const row of rows) {
    lines.push(`| ${row.entry} | ${row.tree} | ${row.path}:${row.assertLine} | ${row.exitCode ?? ''} | ${row.wallSeconds?.toFixed(2) ?? ''} | ${row.maxRssBytes == null ? '' : (row.maxRssBytes / 1024 / 1024).toFixed(0)} | ${row.findings} | ${row.failure.replaceAll('|', '\\|')} |`)
  }
  lines.push('', `Totals: ${rows.length} Freerange runs, max RSS ${(summary.maxRssBytes / 1024 / 1024).toFixed(0)} MB, ${summary.timeouts} timeouts.`, '')
  writeFileSync(join(runDirectory, 'score.md'), `${lines.join('\n')}\n`)
  console.log(lines.join('\n'))
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2))
  switch (options.command) {
    case 'eligibility': {
      requireOptions(options, ['entries', 'readings', 'devEval'])
      const eligibility = computeEligibility(options)
      writeEligibility(options.devEval, eligibility)
      console.log(formatEligibility(eligibility))
      return 0
    }
    case 'prepare': return prepare(options)
    case 'run': return runArm(options)
    case 'score': {
      requireOptions(options, ['run'])
      writeScore(options.run)
      return 0
    }
    default: throw new Error(`unknown command ${options.command}; use eligibility, prepare, run or score`)
  }
}

process.exitCode = await main()
