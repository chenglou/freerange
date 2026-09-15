// Runs `fr` flag off and flag on (FREERANGE_SWEEP=1) over Plan A mutant trees and their originals, for runtime-sweeps M2, and
// flag on over plan-c writers' patched trees, for M4a. It records outputs and sidecars; the counting happens afterwards.
//
//   bun eval/sweep-mutants.ts --freerange <checkout> --corpus <corpus> --scratch <scratchpad root> --runs m7,m1c,m2,m3,m4
//     --concurrency 2 --out <dir> --phase pilot|full [--pilot 16] [--budget-minutes 50]
//   bun eval/sweep-mutants.ts --freerange <checkout> --writers <writer-paths.txt> --concurrency 2 --out <dir>
//
// M2 trees: the corpus unit's tree with the mutant's changed files replaced by the plan's mutant sources, refused unless
// every replaced file's original sha1 equals the corpus file's and every other mutant file equals the corpus tree
// (lib/mutant-trees.ts). `fr` runs on every analyzed file of the unit, at most `concurrency` processes at a time.
// Phases: `pilot` runs the originals and the first `pilot` mutants of each run in kills.tsv order, projects the full set's
// wall time from the pilot means, and writes sample.json: every mutant when the projection fits `budget-minutes`, otherwise
// each run's keys sorted by sha256('runtime-sweeps-m2-2026-09-15|' + key), the largest prefix that fits, apportioned by run
// size, with P1-P7 always included. `full` runs sample.json's keys that mutants.jsonl doesn't have yet.
import {createHash} from 'node:crypto'
import {appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {basename, join, resolve} from 'node:path'
import {loadManifest, readJsonFile, type CorpusUnit} from './lib/manifest.ts'
import {copyPaths, errorFindings, planMutantTree, type CopyFile, type MutantFile} from './lib/mutant-trees.ts'
import {runMeasured, type MeasuredRun} from './lib/process.ts'
import {readSweepJson} from './lib/sweep.ts'

const RUN_DIRECTORIES: Record<string, string> = {
  m7: '20260914T072511Z-mj-prealpha-m7',
  m1c: '20260913T151313Z-virtualization-src-m1c',
  m2: '20260913T151722Z-popovers-m2',
  m3: '20260913T161752Z-frames-m3',
  m4: '20260913T172639Z-packing-m4',
}
const SAMPLE_SEED = 'runtime-sweeps-m2-2026-09-15|'
const FR_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
// A cap on mutants per run, far above the largest recorded run (m7, 901 rows).
const MAX_MUTANTS_PER_RUN = 10_000

type Options = {freerange: string; corpus: string; scratch: string; runs: string[]; writers: string | null; concurrency: number; out: string; phase: 'pilot' | 'full'; pilot: number; budgetMinutes: number}

function parseOptions(argv: string[]): Options {
  const options: Options = {freerange: '', corpus: '', scratch: '', runs: [], writers: null, concurrency: 2, out: '', phase: 'pilot', pilot: 16, budgetMinutes: 50}
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!
    const value = (): string => {
      const next = argv[++index]
      if (next == null) throw new Error(`${name} needs a value`)
      return next
    }
    switch (name) {
      case '--freerange': options.freerange = resolve(value()); break
      case '--corpus': options.corpus = resolve(value()); break
      case '--scratch': options.scratch = resolve(value()); break
      case '--runs': options.runs = value().split(','); break
      case '--writers': options.writers = resolve(value()); break
      case '--concurrency': options.concurrency = Number(value()); break
      case '--out': options.out = resolve(value()); break
      case '--phase': {
        const phase = value()
        if (phase !== 'pilot' && phase !== 'full') throw new Error('--phase takes pilot or full')
        options.phase = phase
        break
      }
      case '--pilot': options.pilot = Number(value()); break
      case '--budget-minutes': options.budgetMinutes = Number(value()); break
      default: throw new Error(`unknown option ${name}`)
    }
  }
  if (options.freerange === '' || options.out === '') throw new Error('--freerange and --out are required')
  if (options.writers == null && options.scratch === '') throw new Error('--scratch is required for Plan A mutant runs')
  if (!(options.concurrency >= 1 && options.concurrency <= 2)) throw new Error('--concurrency must be 1 or 2')
  for (const run of options.runs) if (RUN_DIRECTORIES[run] == null) throw new Error(`unknown run ${run}`)
  return options
}

function sha1(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

function safeName(text: string): string {
  return text.replaceAll('/', '__')
}

/** Runs `tasks` with at most `concurrency` in flight; each task starts `fr` processes one after another. */
async function pool<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers: Promise<void>[] = []
  for (let worker = 0; worker < concurrency; worker++) {
    workers.push((async () => {
      while (next < items.length) {
        const item = items[next++]!
        await task(item)
      }
    })())
  }
  await Promise.all(workers)
}

// -- One tree -------------------------------------------------------------------------

type RunSummary = {exit: number | null; timedOut: boolean; wallSeconds: number; maxRssBytes: number | null; coverage: boolean; typeScriptError: boolean}

function summarize(run: MeasuredRun): RunSummary {
  return {exit: run.exitCode, timedOut: run.timedOut, wallSeconds: run.wallMs / 1000, maxRssBytes: run.maxRssBytes, coverage: run.stdout.split('\n').some(line => line.startsWith('coverage: ')), typeScriptError: /error TS\d+/.test(run.stderr)}
}

type FileResult = {
  file: string
  off: RunSummary & {errors: string[]}
  on: RunSummary & {sweepKeys: string[]; internal: string[]; sweepStatus: string | null}
}

/** Printed sweep counterexample keys: `<file>|<function>|<condition>|<occurrence>`, plus `|<caller>` for a call site. */
function printedKeys(jsonPath: string): {sweepKeys: string[]; internal: string[]; sweepStatus: string | null} {
  const json = readSweepJson(jsonPath)
  if (json == null) return {sweepKeys: [], internal: [], sweepStatus: null}
  const sweepKeys: string[] = []
  const internal: string[] = []
  for (const site of json.sites) {
    if (site.action === 'warning') sweepKeys.push(site.key)
    if (site.action === 'call-site warning') sweepKeys.push(`${site.key}|${site.caller ?? ''}`)
    if (site.action === 'internal') internal.push(site.key)
  }
  return {sweepKeys, internal, sweepStatus: json.status.kind}
}

async function runTree(freerange: string, treeDirectory: string, files: string[], rawDirectory: string, flags: {off: boolean}): Promise<FileResult[]> {
  mkdirSync(rawDirectory, {recursive: true})
  const frPath = join(freerange, 'fr.ts')
  const results: FileResult[] = []
  for (const file of files) {
    const rawBase = join(rawDirectory, safeName(file))
    let off: FileResult['off'] = {exit: null, timedOut: false, wallSeconds: 0, maxRssBytes: null, coverage: false, typeScriptError: false, errors: []}
    if (flags.off) {
      const run = await runMeasured([process.execPath, frPath, file], treeDirectory, {timeoutMs: FR_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES})
      writeFileSync(`${rawBase}.off.stdout.txt`, run.stdout)
      writeFileSync(`${rawBase}.off.stderr.txt`, run.stderr)
      off = {...summarize(run), errors: errorFindings(run.stdout)}
    }
    const jsonPath = `${rawBase}.sweep.json`
    const on = await runMeasured([process.execPath, frPath, file], treeDirectory, {timeoutMs: FR_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES}, true, {FREERANGE_SWEEP: '1', FREERANGE_SWEEP_JSON: jsonPath})
    writeFileSync(`${rawBase}.on.stdout.txt`, on.stdout)
    writeFileSync(`${rawBase}.on.stderr.txt`, on.stderr)
    results.push({file, off, on: {...summarize(on), ...printedKeys(jsonPath)}})
  }
  return results
}

function prepareTree(corpus: string, unit: CorpusUnit, nodeModules: Record<string, string>, treeDirectory: string): void {
  rmSync(treeDirectory, {recursive: true, force: true})
  cpSync(join(corpus, unit.tree), treeDirectory, {recursive: true})
  if (unit.nodeModules != null) {
    const directory = nodeModules[unit.nodeModules]
    if (directory == null) throw new Error(`no node_modules for ${unit.nodeModules}`)
    symlinkSync(directory, join(treeDirectory, 'node_modules'))
  }
}

// -- M2 ---------------------------------------------------------------------------------

type PlanCopy = {copy: string; files: CopyFile[]}
type PlanMutant = {key: string; copy: string; files: MutantFile[]; changedFiles: string[]}
type KillRow = {mutant: string; copy: string; behavior_diffs: string; 'kill_noise@abs1e-9': string; killing_lines: string; planted?: string}

function readTsv(path: string): Array<Record<string, string>> {
  const [header, ...lines] = readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0)
  const columns = header!.split('\t')
  return lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [columns[index]!, value])))
}

type MutantTask = {run: string; kill: KillRow; mutant: PlanMutant; copy: PlanCopy; unit: CorpusUnit}

function loadRun(scratchRoot: string, run: string, units: CorpusUnit[]): MutantTask[] {
  const directory = join(scratchRoot, 'freerange-focus', 'plan-a', 'runs', RUN_DIRECTORIES[run]!)
  const plan = readJsonFile<{copies: PlanCopy[]; mutants: PlanMutant[]}>(join(directory, 'plan.json'))
  const kills = readTsv(join(directory, 'kills.tsv')) as unknown as KillRow[]
  if (kills.length > MAX_MUTANTS_PER_RUN) throw new Error(`${run}: ${kills.length} mutants, above the cap of ${MAX_MUTANTS_PER_RUN}`)
  const slice = run === 'm7' ? 'mj-gallery' : 'families'
  const unitOfCopy = new Map<string, CorpusUnit>()
  for (const copy of plan.copies) {
    // A copy's files can sit in several units' import closures, e.g. MidUI.ts; the copy's unit is the one that analyzes one of them.
    const matches = units.filter(unit => {
      const paths = unit.slice === slice ? copyPaths(copy.files, unit.provenance.sources) : null
      return paths != null && [...paths.values()].some(path => unit.analyze.includes(path))
    })
    if (matches.length !== 1) throw new Error(`${run}: copy ${copy.copy} matches ${matches.length} corpus units`)
    unitOfCopy.set(copy.copy, matches[0]!)
  }
  return kills.map(kill => {
    const mutant = plan.mutants.find(candidate => candidate.key === kill.mutant)
    const copy = plan.copies.find(candidate => candidate.copy === kill.copy)
    if (mutant == null || copy == null) throw new Error(`${run}: kills.tsv row ${kill.mutant} has no plan mutant or copy`)
    return {run, kill, mutant, copy, unit: unitOfCopy.get(copy.copy)!}
  })
}

async function runM2(options: Options): Promise<void> {
  const {units} = loadManifest(options.corpus)
  const nodeModules = readJsonFile<Record<string, string>>(join(options.corpus, 'node-modules.json'))
  mkdirSync(options.out, {recursive: true})
  const tasks = options.runs.flatMap(run => loadRun(options.scratch, run, units))
  const mutantsPath = join(options.out, 'mutants.jsonl')
  const originalsPath = join(options.out, 'originals.jsonl')
  const done = new Set(existsSync(mutantsPath) ? readFileSync(mutantsPath, 'utf8').split('\n').filter(line => line.length > 0).map(line => (JSON.parse(line) as {run: string; key: string})).map(row => `${row.run}|${row.key}`) : [])
  const originalsDone = new Set(existsSync(originalsPath) ? readFileSync(originalsPath, 'utf8').split('\n').filter(line => line.length > 0).map(line => (JSON.parse(line) as {unit: string}).unit) : [])

  const runMutant = async (task: MutantTask): Promise<void> => {
    const started = performance.now()
    const treeDirectory = join(options.out, 'work', task.run, safeName(task.mutant.key))
    const rawDirectory = join(options.out, 'raw', task.run, safeName(task.mutant.key))
    const plan = planMutantTree(task.copy.files, task.mutant.files, task.mutant.changedFiles, task.unit.provenance.sources)
    const base = {run: task.run, key: task.mutant.key, unit: task.unit.id, behaviorDiffs: task.kill.behavior_diffs === '' ? 0 : Number(task.kill.behavior_diffs), recordedKill: task.kill['kill_noise@abs1e-9'] === 'true', planted: task.kill.planted === 'true', killingLines: task.kill.killing_lines}
    let refused: string | null = plan.kind === 'refused' ? plan.reason : null
    let files: FileResult[] = []
    if (plan.kind === 'tree') {
      prepareTree(options.corpus, task.unit, nodeModules, treeDirectory)
      for (const replacement of plan.replacements) {
        if (sha1(replacement.from) !== replacement.sha1) {
          refused = `the mutant source ${basename(replacement.from)} differs from the plan's sha1`
          break
        }
        writeFileSync(join(treeDirectory, replacement.path), readFileSync(replacement.from))
      }
      if (refused == null) files = await runTree(options.freerange, treeDirectory, task.unit.analyze, rawDirectory, {off: true})
      rmSync(treeDirectory, {recursive: true, force: true})
    }
    appendFileSync(mutantsPath, `${JSON.stringify({...base, refused, files, wallSeconds: (performance.now() - started) / 1000})}\n`)
  }

  const involvedUnits = [...new Map(tasks.map(task => [task.unit.id, task.unit])).values()]
  await pool(involvedUnits.filter(unit => !originalsDone.has(unit.id)), options.concurrency, async unit => {
    const started = performance.now()
    const treeDirectory = join(options.out, 'work', 'originals', unit.id)
    prepareTree(options.corpus, unit, nodeModules, treeDirectory)
    const files = await runTree(options.freerange, treeDirectory, unit.analyze, join(options.out, 'raw', 'originals', unit.id), {off: true})
    rmSync(treeDirectory, {recursive: true, force: true})
    appendFileSync(originalsPath, `${JSON.stringify({unit: unit.id, files, wallSeconds: (performance.now() - started) / 1000})}\n`)
  })

  const samplePath = join(options.out, 'sample.json')
  if (options.phase === 'pilot') {
    const pilot = options.runs.flatMap(run => tasks.filter(task => task.run === run).slice(0, options.pilot))
    await pool(pilot.filter(task => !done.has(`${task.run}|${task.mutant.key}`)), options.concurrency, runMutant)
    const rows = readFileSync(mutantsPath, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as {run: string; key: string; wallSeconds: number})
    const meanOf = (run: string) => {
      const pilotRows = rows.filter(row => row.run === run).slice(0, options.pilot)
      return pilotRows.reduce((total, row) => total + row.wallSeconds, 0) / Math.max(1, pilotRows.length)
    }
    const sizes = Object.fromEntries(options.runs.map(run => [run, tasks.filter(task => task.run === run).length]))
    const means = Object.fromEntries(options.runs.map(run => [run, meanOf(run)]))
    const projectMinutes = (fraction: number) => options.runs.reduce((total, run) => total + Math.floor(fraction * sizes[run]!) * means[run]!, 0) / options.concurrency / 60
    const fullMinutes = projectMinutes(1)
    let fraction = 1
    if (fullMinutes > options.budgetMinutes) {
      let low = 0
      let high = 1
      for (let step = 0; step < 40; step++) {
        const middle = (low + high) / 2
        if (projectMinutes(middle) <= options.budgetMinutes) low = middle
        else high = middle
      }
      fraction = low
    }
    const keys: Record<string, string[]> = {}
    for (const run of options.runs) {
      const runKeys = tasks.filter(task => task.run === run).map(task => task.mutant.key)
      const ordered = [...runKeys].sort((left, right) => createHash('sha256').update(SAMPLE_SEED + left).digest('hex').localeCompare(createHash('sha256').update(SAMPLE_SEED + right).digest('hex')))
      const kept = fraction === 1 ? runKeys : ordered.slice(0, Math.floor(fraction * runKeys.length))
      const planted = tasks.filter(task => task.run === run && task.kill.planted === 'true').map(task => task.mutant.key)
      keys[run] = [...new Set([...kept, ...planted])]
    }
    writeFileSync(samplePath, `${JSON.stringify({writtenAt: new Date().toISOString(), pilotMeansSeconds: means, sizes, concurrency: options.concurrency, projectedFullMinutes: fullMinutes, budgetMinutes: options.budgetMinutes, fraction, rule: fraction === 1 ? 'every mutant' : `sha256('${SAMPLE_SEED}' + key) order, largest prefix fitting the budget, apportioned by run size, planted mutants included`, keys}, null, 1)}\n`)
    console.log(`pilot: projected full set ${fullMinutes.toFixed(1)} min at concurrency ${options.concurrency}; sample fraction ${fraction.toFixed(4)}`)
    return
  }
  if (!existsSync(samplePath)) throw new Error('run --phase pilot first; sample.json is missing')
  const sample = readJsonFile<{keys: Record<string, string[]>}>(samplePath)
  const selected = tasks.filter(task => (sample.keys[task.run] ?? []).includes(task.mutant.key) && !done.has(`${task.run}|${task.mutant.key}`))
  console.log(`full: ${selected.length} mutants to run`)
  await pool(selected, options.concurrency, runMutant)
}

// -- M4a ----------------------------------------------------------------------------------

async function runWriters(options: Options): Promise<void> {
  mkdirSync(options.out, {recursive: true})
  const runDirectories = readFileSync(options.writers!, 'utf8').split('\n').map(line => line.trim()).filter(line => line.startsWith('/'))
  const items: Array<{writer: string; directory: string; copy: string; path: string}> = []
  for (const directory of runDirectories) {
    const writer = basename(directory).split('-').at(-1)!
    const plan = readJsonFile<{copies: Array<{copy: string; files: Array<{path: string}>}>}>(join(directory, 'plan.json'))
    for (const copy of plan.copies) for (const file of copy.files) items.push({writer, directory, copy: copy.copy, path: file.path})
  }
  const rowsPath = join(options.out, 'writers.jsonl')
  await pool(items, options.concurrency, async item => {
    const tree = join(item.directory, 'work', 'fr', item.copy)
    const applied = join(item.directory, 'work', 'applied', item.path)
    const checked = existsSync(join(tree, item.path)) && existsSync(applied) && sha1(join(tree, item.path)) === sha1(applied)
    let files: FileResult[] = []
    if (checked) files = await runTree(options.freerange, tree, [item.path], join(options.out, 'raw', item.writer, item.copy), {off: false})
    appendFileSync(rowsPath, `${JSON.stringify({...item, treeMatchesApplied: checked, files})}\n`)
  })
}

const options = parseOptions(process.argv.slice(2))
if (options.writers != null) await runWriters(options)
else await runM2(options)
