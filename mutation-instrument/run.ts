// The parent, and the only process that loads the TypeScript library. One command runs a whole milestone:
//   1 plan domains per exported function of each base, and splice asserts to disk for bases and mutants
//   2 abort if a mutant's sites differ from its base; digest every entry's input sequence twice
//   3 baseline pass over the originals, and verify its firings on the uninstrumented originals
//   4 project the mutant pass and refuse past the registered maximum. With --baseline-only the run stops here, so the
//     known-false list can be frozen from the originals' firings before any mutant runs.
//   5 mutant pass: at most `children` child processes, one per mutant
//   6 replay the recorded sweep kills this run missed
//   7 Freerange's own findings on the bases, then the report
// usage: bun mutation-instrument/run.ts --rules <m1.json> --out <run dir> [--mutants s001,s158] [--baseline-only]
import {createHash} from 'node:crypto'
import {appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {basename, dirname, join} from 'node:path'
import {exportedEntries, loadProgram} from './analyze.ts'
import {DOMAIN_VERSION, MAX_ARRAY_LENGTH, NUMBER_CAP, type Value} from './domain.ts'
import {decodeJson, encodeJson} from './encode.ts'
import {instrumentSource} from './instrument.ts'
import {compileLattice, DIGEST_START, digestValue, inputAt} from './lattice.ts'
import {writeReport, type ReferenceRow, type Rules} from './report.ts'
import {CRITERION_RULE, type BaselineLine, type BasePlan, type ChildLine, type DoneLine, type Job, type MutantPlan, type Plan, type ReplayLine, type VerifyLine} from './types.ts'

const WORKER = realpathSync(new URL('./worker.ts', import.meta.url).pathname)
const FR = realpathSync(new URL('../fr.ts', import.meta.url).pathname)
const INSTRUMENT_DIR = dirname(WORKER)
const HEARTBEAT_EVERY_INPUTS = 1024
const STARTUP_SECONDS = 0.3

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] ?? null
}

function sha1(text: string | Buffer) {
  return createHash('sha1').update(text).digest('hex')
}

function log(line: string) {
  console.log(`[${new Date().toISOString()}] ${line}`)
}

const wallStart = performance.now()
const rulesPath = option('--rules')
const outDir = option('--out')
if (rulesPath == null || outDir == null) throw new Error('usage: bun mutation-instrument/run.ts --rules <m1.json> --out <run dir> [--mutants s001,s158] [--baseline-only]')
if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`)
const subset = option('--mutants')?.split(',') ?? null
const baselineOnly = process.argv.includes('--baseline-only')

const rulesText = readFileSync(rulesPath, 'utf8')
const rules = decodeJson(rulesText) as Rules
const scratch = rules.data.scratch
const basesDir = realpathSync(join(scratch, rules.data.basesDir))
const knownFalsePath = join(scratch, rules.data.knownFalse)
// The known-false list is frozen from a baseline-only run's firings, so only a run with a mutant pass requires it.
if (!baselineOnly && !existsSync(knownFalsePath)) throw new Error(`the known-false list ${knownFalsePath} must be frozen before a run with a mutant pass`)
const checks: [string, unknown, unknown][] = [
  ['domain.version', rules.domain.version, DOMAIN_VERSION], ['domain.cap', rules.domain.cap, NUMBER_CAP], ['domain.maxArrayLength', rules.domain.maxArrayLength, MAX_ARRAY_LENGTH],
  ['execution.heartbeatEveryInputs', rules.execution.heartbeatEveryInputs, HEARTBEAT_EVERY_INPUTS], ['noise criterion', rules.rules.noise.criterion, 'noise@abs1e-9'],
]
for (const [name, registered, implemented] of checks) if (registered !== implemented) throw new Error(`registered ${name} ${String(registered)} differs from the implementation's ${String(implemented)}`)
mkdirSync(join(outDir, 'work', 'original'), {recursive: true})
mkdirSync(join(outDir, 'work', 'mutants'))
const settings = {budget: rules.lattice.budget, seed: rules.lattice.seed, p0Inputs: rules.lattice.p0Inputs, p2ProductMax: rules.lattice.p2ProductMax}

const instrumentFiles = readdirSync(INSTRUMENT_DIR).filter((name) => name.endsWith('.ts')).sort()
const gitHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim()
const gitDirty = Bun.spawnSync(['git', 'status', '--porcelain', '--', '.'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim()
const meta: Record<string, unknown> = {
  measured_on: rules.measured_on,
  domains: rules.domains_label,
  subset,
  baselineOnly,
  instrumentSha1: sha1(instrumentFiles.map((name) => `${name}\n${readFileSync(join(INSTRUMENT_DIR, name), 'utf8')}`).join('\n')),
  instrumentCommit: gitHead,
  instrumentDirty: gitDirty !== '',
  bun: Bun.version,
  rulesPath,
  rulesSha1: sha1(rulesText),
  knownFalsePath,
  knownFalseSha1: existsSync(knownFalsePath) ? sha1(readFileSync(knownFalsePath)) : null,
  settings,
  children: rules.execution.children,
  started: new Date().toISOString(),
}
const writeMeta = () => writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`)
writeMeta()

// -- 1, 2: plan and instrument ------------------------------------------------

const reference = decodeJson(readFileSync(join(scratch, rules.data.referenceRecord), 'utf8')) as ReferenceRow[]
const selected = subset == null ? reference : reference.filter((row) => subset.includes(row.id))
log(`plan: ${rules.data.bases.length} bases, ${selected.length} mutants`)
const baseSources = rules.data.bases.map((base) => join(basesDir, `base_${base}.ts`))
const program = loadProgram(baseSources)
const bases: BasePlan[] = rules.data.bases.map((base, index) => {
  const source = baseSources[index]!
  const text = readFileSync(source, 'utf8')
  const {output, sites} = instrumentSource(text, source, base)
  const instrumented = join(realpathSync(outDir), 'work', 'original', `${base}.ts`)
  writeFileSync(instrumented, output)
  const entries = exportedEntries(program, source).map((entry) => ({...entry, phases: {p0: 0, p1: 0, p2: 0}, digest: 0}))
  return {base, source, sourceSha1: sha1(text), instrumented, sites, entries}
})
const mutants: MutantPlan[] = []
const mutantHashes = createHash('sha1')
for (const row of selected) {
  const base = bases.find((candidate) => candidate.base === row.base)
  if (base == null) throw new Error(`${row.id}: unknown base ${row.base}`)
  const source = join(basesDir, basename(row.path))
  const text = readFileSync(source, 'utf8')
  mutantHashes.update(`${row.id}\n${text}\n`)
  const {output, sites} = instrumentSource(text, source, row.base)
  const differs = sites.length !== base.sites.length || sites.some((site, index) => site.key !== base.sites[index]!.key || site.line !== base.sites[index]!.line)
  if (differs) throw new Error(`site check: ${row.id} has ${sites.length} sites against ${base.sites.length} in base_${row.base}.ts, or different keys or lines; aborting before any child starts`)
  const instrumented = join(realpathSync(outDir), 'work', 'mutants', `${row.id}.ts`)
  writeFileSync(instrumented, output)
  mutants.push({id: row.id, base: row.base, family: row.family, source, sourceSha1: sha1(text), instrumented})
}
meta['inputSha1'] = {bases: Object.fromEntries(bases.map((base) => [base.base, base.sourceSha1])), mutants: mutantHashes.digest('hex')}
meta['siteCheck'] = `${mutants.length} of ${mutants.length} mutants have their base's site keys and lines`
for (const base of bases) {
  for (const entry of base.entries) {
    if (entry.unsupported != null) continue
    entry.phases = compileLattice(entry, settings).phases
  }
}
const planPath = join(realpathSync(outDir), 'plan.json')
writeFileSync(planPath, encodeJson({settings, bases, mutants} satisfies Plan))

// Digest from the plan as children decode it, twice in this process.
const plan = decodeJson(readFileSync(planPath, 'utf8')) as Plan
for (const base of plan.bases) {
  for (const entry of base.entries) {
    if (entry.unsupported != null) continue
    const digests: number[] = []
    for (let pass = 0; pass < 2; pass++) {
      const lattice = compileLattice(entry, settings)
      let digest = DIGEST_START
      for (let index = 0; index < settings.budget; index++) digest = digestValue(digest, inputAt(lattice, index).args)
      digests.push(digest)
    }
    if (digests[0] !== digests[1]) throw new Error(`determinism: ${base.base}.${entry.name} digests ${digests.join(' and ')} differ within one process`)
    entry.digest = digests[0]!
  }
}
writeFileSync(planPath, encodeJson(plan))
log(`plan written: ${plan.bases.map((base) => `${base.base} ${base.entries.length} entries ${base.sites.length} sites`).join('; ')}`)

// -- child processes ------------------------------------------------------------

type ChildRun = {exitCode: number | null; timedOut: string | null; stderr: string; done: DoneLine | null; ms: number}

async function runChild(job: Job, hardLimitMs: number, heartbeatTimeoutMs: number, onLine: (line: ChildLine) => void): Promise<ChildRun> {
  const childStart = performance.now()
  const child = Bun.spawn(['bun', WORKER, encodeJson(job)], {stdout: 'pipe', stderr: 'pipe'})
  let lastSeen = performance.now()
  let timedOut: string | null = null
  let done: DoneLine | null = null
  const timer = setInterval(() => {
    const now = performance.now()
    if (now - lastSeen > heartbeatTimeoutMs) timedOut ??= `no output for ${Math.round((now - lastSeen) / 1000)} s`
    if (now - childStart > hardLimitMs) timedOut ??= `past the hard limit of ${Math.round(hardLimitMs / 1000)} s`
    if (timedOut != null) child.kill('SIGKILL')
  }, 500)
  const stderrText = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    lastSeen = performance.now()
    pending += decoder.decode(chunk.value, {stream: true})
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = decodeJson(pending.slice(0, newline)) as ChildLine
      pending = pending.slice(newline + 1)
      if (line.type === 'done') done = line
      onLine(line)
      newline = pending.indexOf('\n')
    }
  }
  const exitCode = await child.exited
  clearInterval(timer)
  const stderr = await stderrText
  return {exitCode, timedOut, stderr: stderr.slice(-4000), done, ms: performance.now() - childStart}
}

let maxChildRssKb = 0
const noteChild = (run: ChildRun) => {
  if (run.done != null) maxChildRssKb = Math.max(maxChildRssKb, run.done.maxRssKb)
}
const heartbeatTimeoutMs = rules.execution.heartbeatTimeoutSeconds * 1000

function finishMeta(status: string) {
  const parentMaxRssKb = process.resourceUsage().maxRSS
  meta['wallSeconds'] = (performance.now() - wallStart) / 1000
  meta['parentMaxRssKb'] = parentMaxRssKb
  meta['maxChildRssKb'] = maxChildRssKb
  meta['concurrentRssBoundKb'] = parentMaxRssKb + rules.execution.children * maxChildRssKb
  meta['finished'] = new Date().toISOString()
  meta['status'] = status
  writeMeta()
}

// -- 3: baseline, and its firings on the uninstrumented originals ----------------

log('baseline pass')
const baselinePath = join(outDir, 'baseline.jsonl')
const baselineLines: BaselineLine[] = []
const baselineRun = await runChild({mode: 'baseline', plan: planPath}, 30 * 60 * 1000, heartbeatTimeoutMs, (line) => {
  if (line.type !== 'baseline') return
  baselineLines.push(line)
  appendFileSync(baselinePath, `${encodeJson(line)}\n`)
})
noteChild(baselineRun)
meta['baselineChild'] = {exitCode: baselineRun.exitCode, timedOut: baselineRun.timedOut, ms: baselineRun.ms, maxRssKb: baselineRun.done?.maxRssKb ?? null, stderr: baselineRun.stderr}
writeMeta()
if (baselineRun.exitCode !== 0 || baselineRun.timedOut != null) throw new Error(`baseline child failed: exit ${baselineRun.exitCode}, ${baselineRun.timedOut ?? ''}\n${baselineRun.stderr}`)

const verifyPath = join(outDir, 'verify.jsonl')
for (const line of baselineLines) {
  for (const firing of line.firings) {
    const first = firing.first[CRITERION_RULE]
    if (first == null) continue
    let verify: VerifyLine | null = null
    if (first.input != null) {
      await runChild({mode: 'verify', plan: planPath, base: line.base, entry: line.entry, args: first.input}, 60_000, 60_000, (childLine) => {
        if (childLine.type === 'verify') verify = childLine
      })
    }
    appendFileSync(verifyPath, `${encodeJson({base: line.base, entry: line.entry, site: firing.site, verify})}\n`)
  }
}

// -- 4: projection -----------------------------------------------------------------

const costNs = new Map(baselineLines.map((line) => [`${line.base}.${line.entry}`, line.nsPerCall]))
const childProjectionSeconds = (mutant: MutantPlan) => {
  let seconds = STARTUP_SECONDS
  for (const entry of plan.bases.find((base) => base.base === mutant.base)!.entries) {
    if (entry.unsupported == null) seconds += (settings.budget * 2 * (costNs.get(`${mutant.base}.${entry.name}`) ?? 0)) / 1e9
  }
  return seconds
}
let projectedSeconds = 0
for (const mutant of plan.mutants) projectedSeconds += childProjectionSeconds(mutant)
projectedSeconds /= rules.execution.children
meta['projection'] = {mutantPassSeconds: projectedSeconds, limitSeconds: rules.execution.projectionMaxMinutes * 60, costNsPerCall: Object.fromEntries(costNs)}
writeMeta()
log(`projection: mutant pass ${projectedSeconds.toFixed(1)} s with ${rules.execution.children} children`)
if (projectedSeconds > rules.execution.projectionMaxMinutes * 60) {
  meta['status'] = 'refused: projection above the registered maximum'
  writeMeta()
  throw new Error(`refusing: projected ${projectedSeconds.toFixed(0)} s is above ${rules.execution.projectionMaxMinutes} minutes`)
}

if (baselineOnly) {
  for (const line of baselineLines) {
    const criterionSites = line.firings.filter((firing) => firing.first[CRITERION_RULE] != null).length
    log(`baseline ${line.base}.${line.entry}: ${line.discarded} of ${line.inputs} inputs discarded; firing sites: ${line.firings.length} under noise@none, ${criterionSites} under noise@abs1e-9; throws ${line.throws.count}; non-finite returns ${line.nonFiniteReturns.count}`)
  }
  finishMeta('complete: baseline only, no mutant pass')
  log(`done in ${((performance.now() - wallStart) / 1000).toFixed(1)} s`)
  process.exit(0)
}

// -- 5: mutant pass --------------------------------------------------------------

log('mutant pass')
const resultsPath = join(outDir, 'results.jsonl')
const criterionKilled = new Set<string>()
const mutantRuns: Record<string, unknown>[] = []
const mutantPassStart = performance.now()
let nextMutant = 0
async function mutantWorker() {
  while (nextMutant < plan.mutants.length) {
    const mutant = plan.mutants[nextMutant++]!
    const hardLimitMs = (3 * childProjectionSeconds(mutant) + 30) * 1000
    const run = await runChild({mode: 'mutant', plan: planPath, mutant: mutant.id}, hardLimitMs, heartbeatTimeoutMs, (line) => {
      if (line.type !== 'result') return
      if (line.kills.some((site) => site.first[CRITERION_RULE] != null)) criterionKilled.add(line.mutant)
      appendFileSync(resultsPath, `${encodeJson(line)}\n`)
    })
    noteChild(run)
    const failed = run.exitCode !== 0 || run.timedOut != null || run.done == null
    mutantRuns.push({mutant: mutant.id, ms: run.ms, exitCode: run.exitCode, timedOut: run.timedOut, maxRssKb: run.done?.maxRssKb ?? null})
    if (failed) appendFileSync(resultsPath, `${encodeJson({type: 'failure', mutant: mutant.id, base: mutant.base, exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr})}\n`)
    if (mutantRuns.length % 25 === 0 || failed) log(`mutants done ${mutantRuns.length}/${plan.mutants.length}${failed ? `; ${mutant.id} failed: exit ${run.exitCode} ${run.timedOut ?? ''}` : ''}`)
  }
}
await Promise.all(Array.from({length: rules.execution.children}, mutantWorker))
writeFileSync(join(outDir, 'children.json'), `${JSON.stringify(mutantRuns, null, 1)}\n`)
meta['mutantPass'] = {seconds: (performance.now() - mutantPassStart) / 1000, projectedSeconds, children: mutantRuns.length}
writeMeta()

// -- 6: replay misses ---------------------------------------------------------------------

type SweepOutput = {failures: {fn: string; label: string; line: number; firstCall: string; firstArgs: string}[]; evaluations: number}
const replayPath = join(outDir, 'replay.jsonl')
const misses = selected.filter((row) => row.sweep.caught && !criterionKilled.has(row.id))
log(`replay: ${misses.length} recorded sweep kills missed under the criterion rules`)
const sweepDir = join(scratch, rules.data.sweepCopyDir)
for (const row of misses) {
  const sweep = Bun.spawnSync(['bun', 'sweep/run.ts', row.family, row.path, '--first'], {cwd: sweepDir, timeout: 300_000})
  let parsed: SweepOutput | null = null
  try {
    parsed = JSON.parse(sweep.stdout.toString()) as SweepOutput
  } catch {
    parsed = null
  }
  const first = parsed?.failures[0] ?? null
  let replay: ReplayLine | null = null
  if (first != null) {
    const args = JSON.parse(first.firstArgs) as Value[]
    await runChild({mode: 'replay', plan: planPath, mutant: row.id, entry: first.firstCall, args: encodeJson(args)}, 60_000, 60_000, (line) => {
      if (line.type === 'replay') replay = line
    })
  }
  appendFileSync(replayPath, `${encodeJson({mutant: row.id, sweepExit: sweep.exitCode, sweepFirst: first, sweepEvaluations: parsed?.evaluations ?? null, replay})}\n`)
}

// -- 7: Freerange findings on the bases, report ------------------------------------------

const frRevision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: dirname(FR)}).stdout.toString().trim()
for (const base of plan.bases) {
  const findings = Bun.spawnSync(['bun', FR, basename(base.source)], {cwd: basesDir, timeout: 300_000})
  writeFileSync(join(outDir, `fr-${base.base}.txt`), `fr revision ${frRevision}\n${findings.stdout.toString()}${findings.stderr.toString()}`)
}
meta['freerange'] = {revision: frRevision, command: 'bun fr.ts base_<base>.ts (cwd basesDir)'}
finishMeta('complete')
log('report')
await writeReport(outDir, rules, reference)
log(`done in ${((performance.now() - wallStart) / 1000).toFixed(1)} s`)
