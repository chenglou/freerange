// The parent, and the only process that loads the TypeScript library. One command runs a whole milestone:
//   1 plan domains per exported function of each copy, and splice asserts to disk for copies and mutant trees
//   2 abort if a mutant's sites differ from its copy's; digest every entry's input sequence twice. With --plan-only the
//     run stops here, before any function under test runs.
//   3 baseline pass over the originals, and verify its firings on the uninstrumented originals
//   4 project the mutant pass and refuse past the registered maximum. With --baseline-only the run stops here, so the
//     known-false lists can be frozen from the originals' firings before any mutant runs.
//   5 mutant pass: at most `children` child processes, one per mutant
//   6 replay the recorded kills this run missed, and call the registered first killing inputs on the uninstrumented trees
//   7 Freerange's own findings on the copies, then the report
// usage: bun mutation-instrument/run.ts --rules <rules.json> --out <run dir> [--mutants key,key] [--baseline-only | --plan-only]
import {createHash} from 'node:crypto'
import {appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {exportedEntries, loadProgram} from './analyze.ts'
import {DOMAIN_VERSION, MAX_ARRAY_LENGTH, NUMBER_CAP, type Value} from './domain.ts'
import {decodeJson, encodeJson, formatCall} from './encode.ts'
import {framesHarnessCall} from './frames-harness.ts'
import {instrumentSource} from './instrument.ts'
import {compileLattice, DIGEST_START, digestValue, inputAt} from './lattice.ts'
import {harnessCall} from './popovers-harness.ts'
import {writeReport} from './report.ts'
import {normalizedMutants, type CopyRule, type FramesReference, type KeyedMutantRule, type PlantedReference, type Rules, type SysmutRow} from './rules.ts'
import {CRITERION_RULE, type BaselineLine, type CallLine, type ChildLine, type CopyPlan, type DoneLine, type EntryPlan, type FilePlan, type Job, type MutantPlan, type Plan, type ReplayLine, type Site, type VerifyLine} from './types.ts'

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
if (rulesPath == null || outDir == null) throw new Error('usage: bun mutation-instrument/run.ts --rules <rules.json> --out <run dir> [--mutants key,key] [--baseline-only | --plan-only]')
if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`)
const subset = option('--mutants')?.split(',') ?? null
const baselineOnly = process.argv.includes('--baseline-only')
const planOnly = process.argv.includes('--plan-only')

const rulesText = readFileSync(rulesPath, 'utf8')
const rules = decodeJson(rulesText) as Rules
const scratch = rules.data.scratch
// Lists published before the milestone must exist before anything runs; lists frozen from the baseline-only run must
// exist before a run with a mutant pass.
for (const list of rules.data.knownFalse) {
  const required = list.stage === 'before-baseline' ? !planOnly : !planOnly && !baselineOnly
  if (required && !existsSync(join(scratch, list.path))) throw new Error(`the known-false list ${list.path} (${list.stage}) must exist before this run`)
}
const checks: [string, unknown, unknown][] = [
  ['domain.version', rules.domain.version, DOMAIN_VERSION], ['domain.cap', rules.domain.cap, NUMBER_CAP], ['domain.maxArrayLength', rules.domain.maxArrayLength, MAX_ARRAY_LENGTH],
  ['execution.heartbeatEveryInputs', rules.execution.heartbeatEveryInputs, HEARTBEAT_EVERY_INPUTS], ['noise criterion', rules.rules.noise.criterion, 'noise@abs1e-9'],
]
for (const [name, registered, implemented] of checks) if (registered !== implemented) throw new Error(`registered ${name} ${String(registered)} differs from the implementation's ${String(implemented)}`)
mkdirSync(join(outDir, 'work', 'original'), {recursive: true})
mkdirSync(join(outDir, 'work', 'mutants'))
const realOut = realpathSync(outDir)
const settings = {budget: rules.lattice.budget, seed: rules.lattice.seed, p0Inputs: rules.lattice.p0Inputs, p2ProductMax: rules.lattice.p2ProductMax}

const instrumentFiles = readdirSync(INSTRUMENT_DIR).filter((name) => name.endsWith('.ts')).sort()
const gitHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim()
const gitDirty = Bun.spawnSync(['git', 'status', '--porcelain', '--', '.'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim()
const meta: Record<string, unknown> = {
  id: rules.id,
  family: rules.family,
  measured_on: rules.measured_on,
  domains: rules.domains_label,
  subset,
  baselineOnly,
  planOnly,
  instrumentSha1: sha1(instrumentFiles.map((name) => `${name}\n${readFileSync(join(INSTRUMENT_DIR, name), 'utf8')}`).join('\n')),
  instrumentCommit: gitHead,
  instrumentDirty: gitDirty !== '',
  bun: Bun.version,
  rulesPath,
  rulesSha1: sha1(rulesText),
  knownFalse: rules.data.knownFalse.map((list) => ({...list, sha1: existsSync(join(scratch, list.path)) ? sha1(readFileSync(join(scratch, list.path))) : null})),
  settings,
  children: rules.execution.children,
  started: new Date().toISOString(),
}
const writeMeta = () => writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`)
writeMeta()

// -- 1, 2: plan and instrument ------------------------------------------------

function writeFileWithDirs(path: string, text: string) {
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, text)
}

function copyFileWithDirs(from: string, to: string) {
  mkdirSync(dirname(to), {recursive: true})
  copyFileSync(from, to)
}

function planCopy(rule: CopyRule): CopyPlan {
  const dir = realpathSync(join(scratch, rule.dir))
  const sources = rule.files.map((file) => join(dir, file.path))
  const program = loadProgram(sources)
  const root = join(realOut, 'work', 'original', rule.id)
  if (rule.tsconfig != null) copyFileWithDirs(join(dir, rule.tsconfig), join(root, rule.tsconfig))
  const files: FilePlan[] = []
  const sites: Site[] = []
  const entries: EntryPlan[] = []
  rule.files.forEach((fileRule, index) => {
    const source = sources[index]!
    const text = readFileSync(source, 'utf8')
    const instrumented = join(root, fileRule.path)
    const {output, sites: fileSites} = instrumentSource(text, source, fileRule.name, sites.length)
    writeFileWithDirs(instrumented, output)
    files.push({file: fileRule.name, path: fileRule.path, source, sourceSha1: sha1(text), instrumented})
    sites.push(...fileSites)
    for (const analyzed of exportedEntries(program, source, fileRule.name, entries.length)) {
      const {leakAsserts, ...entry} = analyzed
      const own = fileSites.filter((site) => site.leading && site.functionName === entry.name).map((site) => site.index)
      const leakSites = leakAsserts.map((position) => {
        const site = fileSites.find((candidate) => candidate.line === position.line && candidate.column === position.column)
        if (site == null) throw new Error(`${rule.id}/${fileRule.name}: no site at ${position.line}:${position.column} for ${entry.name}'s leak rule`)
        return site.index
      })
      entries.push({...entry, discardSites: [...own, ...leakSites], leakSites, phases: {p0: 0, p1: 0, p2: 0}, digest: 0})
    }
  })
  const names = entries.map((entry) => entry.name)
  if (new Set(names).size !== names.length) throw new Error(`copy ${rule.id}: two exported functions share a name`)
  return {copy: rule.id, files, sites, entries}
}

function applyChanges(text: string, changes: {from: string; to: string}[], label: string) {
  let result = text
  for (const change of changes) {
    const occurrences = result.split(change.from).length - 1
    if (occurrences !== 1) throw new Error(`${label}: expected exactly one occurrence of ${JSON.stringify(change.from)}, found ${occurrences}`)
    result = result.replace(change.from, change.to)
  }
  return result
}

function planMutant(item: KeyedMutantRule, copy: CopyPlan, copyRule: CopyRule): MutantPlan {
  const root = join(realOut, 'work', 'mutants', item.key)
  const tree = copy.files.map((file) => {
    if ('tree' in item) {
      const source = join(scratch, item.tree, file.path)
      return {base: file, source, text: readFileSync(source, 'utf8')}
    }
    if ('replace' in item) {
      const source = item.replace.file === file.file ? item.replace.path : file.source
      return {base: file, source, text: readFileSync(source, 'utf8')}
    }
    // Change-table mutants are written out, every file of the tree, so the uninstrumented tree can be imported.
    const changes = item.changes.filter((change) => change.file === file.path)
    const text = applyChanges(readFileSync(file.source, 'utf8'), changes, `${item.key}/${file.file}`)
    const source = join(root, 'source', file.path)
    writeFileWithDirs(source, text)
    return {base: file, source, text}
  })
  const changedFiles = tree.filter((file) => sha1(file.text) !== file.base.sourceSha1).map((file) => file.base.file)
  if (changedFiles.length === 0) throw new Error(`${item.key}: the mutant tree is identical to copy ${copy.copy}`)
  if (copyRule.tsconfig != null) {
    const tsconfig = join(realpathSync(join(scratch, copyRule.dir)), copyRule.tsconfig)
    copyFileWithDirs(tsconfig, join(root, copyRule.tsconfig))
    if (!('tree' in item) && !('replace' in item)) copyFileWithDirs(tsconfig, join(root, 'source', copyRule.tsconfig))
  }
  const files: FilePlan[] = []
  const mutantSites: Site[] = []
  for (const file of tree) {
    const {output, sites} = instrumentSource(file.text, file.source, file.base.file, mutantSites.length)
    mutantSites.push(...sites)
    const instrumented = join(root, file.base.path)
    writeFileWithDirs(instrumented, output)
    files.push({file: file.base.file, path: file.base.path, source: file.source, sourceSha1: sha1(file.text), instrumented})
  }
  const differs = mutantSites.length !== copy.sites.length || mutantSites.some((site, index) => site.key !== copy.sites[index]!.key || site.line !== copy.sites[index]!.line)
  if (differs) throw new Error(`site check: ${item.key} has ${mutantSites.length} sites against ${copy.sites.length} in copy ${copy.copy}, or different keys or lines; aborting before any child starts`)
  return {key: item.key, id: item.id, copy: item.copy, family: item.family, files, changedFiles}
}

const allMutants = normalizedMutants(rules)
const selected = subset == null ? allMutants : allMutants.filter((item) => subset.includes(item.key))
log(`plan: ${rules.data.copies.length} copies, ${selected.length} mutants`)
const copies = rules.data.copies.map(planCopy)
const mutants: MutantPlan[] = []
const mutantHashes = createHash('sha1')
for (const item of selected) {
  const copy = copies.find((candidate) => candidate.copy === item.copy)
  const copyRule = rules.data.copies.find((candidate) => candidate.id === item.copy)
  if (copy == null || copyRule == null) throw new Error(`${item.key}: unknown copy ${item.copy}`)
  const mutant = planMutant(item, copy, copyRule)
  mutantHashes.update(`${mutant.key}\n${mutant.files.map((file) => file.sourceSha1).join('\n')}\n`)
  mutants.push(mutant)
}
meta['inputSha1'] = {copies: Object.fromEntries(copies.map((copy) => [copy.copy, Object.fromEntries(copy.files.map((file) => [file.file, file.sourceSha1]))])), mutants: mutantHashes.digest('hex')}
meta['siteCheck'] = `${mutants.length} of ${mutants.length} mutants have their copy's site keys and lines`
for (const copy of copies) {
  for (const entry of copy.entries) {
    if (entry.unsupported != null) continue
    entry.phases = compileLattice(entry, settings).phases
  }
}
const planPath = join(realOut, 'plan.json')
writeFileSync(planPath, encodeJson({settings, copies, mutants} satisfies Plan))

// Digest from the plan as children decode it, twice in this process.
const plan = decodeJson(readFileSync(planPath, 'utf8')) as Plan
for (const copy of plan.copies) {
  for (const entry of copy.entries) {
    if (entry.unsupported != null) continue
    const digests: number[] = []
    for (let pass = 0; pass < 2; pass++) {
      const lattice = compileLattice(entry, settings)
      let digest = DIGEST_START
      for (let index = 0; index < settings.budget; index++) digest = digestValue(digest, inputAt(lattice, index).args)
      digests.push(digest)
    }
    if (digests[0] !== digests[1]) throw new Error(`determinism: ${copy.copy}.${entry.name} digests ${digests.join(' and ')} differ within one process`)
    entry.digest = digests[0]!
  }
}
writeFileSync(planPath, encodeJson(plan))
log(`plan written: ${plan.copies.map((copy) => `${copy.copy} ${copy.entries.length} entries ${copy.sites.length} sites`).join('; ')}`)

let maxChildRssKb = 0
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

if (planOnly) {
  for (const copy of plan.copies) {
    for (const entry of copy.entries) {
      const callee = entry.preconditions.filter((precondition) => precondition.origin === 'callee' && precondition.use !== 'unparsed').length
      log(`plan ${copy.copy}.${entry.name}: ${entry.unsupported ?? `phases ${JSON.stringify(entry.phases)}, ${entry.preconditions.length} preconditions (${callee} substituted from callees), ${entry.relations.length} relations, leak sites ${entry.leakSites.length}, digest ${entry.digest}`}`)
    }
  }
  finishMeta('complete: plan only, no function under test ran')
  process.exit(0)
}

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

const noteChild = (run: ChildRun) => {
  if (run.done != null) maxChildRssKb = Math.max(maxChildRssKb, run.done.maxRssKb)
}
const heartbeatTimeoutMs = rules.execution.heartbeatTimeoutSeconds * 1000

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
  for (const entry of plan.copies.find((copy) => copy.copy === mutant.copy)!.entries) {
    if (entry.unsupported == null) seconds += (settings.budget * 2 * (costNs.get(`${mutant.copy}.${entry.name}`) ?? 0)) / 1e9
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
const callTargets = new Map<string, string>()
for (const target of rules.firstKillCalls) for (const key of target.mutants) callTargets.set(key, target.entry)
const firstKills: {mutant: string; entry: string; site: number; input: string}[] = []
const mutantPassStart = performance.now()
let nextMutant = 0
async function mutantWorker() {
  while (nextMutant < plan.mutants.length) {
    const mutant = plan.mutants[nextMutant++]!
    const hardLimitMs = (3 * childProjectionSeconds(mutant) + 30) * 1000
    const run = await runChild({mode: 'mutant', plan: planPath, mutant: mutant.key}, hardLimitMs, heartbeatTimeoutMs, (line) => {
      if (line.type !== 'result') return
      if (line.kills.some((site) => site.first[CRITERION_RULE] != null)) criterionKilled.add(line.mutant)
      if (callTargets.get(line.mutant) === line.entry) {
        for (const kill of line.kills) {
          const input = kill.first[CRITERION_RULE]?.input
          if (input != null) firstKills.push({mutant: line.mutant, entry: line.entry, site: kill.site, input})
        }
      }
      appendFileSync(resultsPath, `${encodeJson(line)}\n`)
    })
    noteChild(run)
    const failed = run.exitCode !== 0 || run.timedOut != null || run.done == null
    mutantRuns.push({mutant: mutant.key, ms: run.ms, exitCode: run.exitCode, timedOut: run.timedOut, maxRssKb: run.done?.maxRssKb ?? null})
    if (failed) appendFileSync(resultsPath, `${encodeJson({type: 'failure', mutant: mutant.key, base: mutant.copy, exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr})}\n`)
    if (mutantRuns.length % 25 === 0 || failed) log(`mutants done ${mutantRuns.length}/${plan.mutants.length}${failed ? `; ${mutant.key} failed: exit ${run.exitCode} ${run.timedOut ?? ''}` : ''}`)
  }
}
await Promise.all(Array.from({length: rules.execution.children}, mutantWorker))
writeFileSync(join(outDir, 'children.json'), `${JSON.stringify(mutantRuns, null, 1)}\n`)
meta['mutantPass'] = {seconds: (performance.now() - mutantPassStart) / 1000, projectedSeconds, children: mutantRuns.length}
writeMeta()

// -- 6: replay misses, first-kill calls ----------------------------------------------------

const replayPath = join(outDir, 'replay.jsonl')
const plannedKeys = new Set(plan.mutants.map((mutant) => mutant.key))

async function replay(key: string, entry: string, args: Value[]): Promise<ReplayLine | null> {
  let result: ReplayLine | null = null
  await runChild({mode: 'replay', plan: planPath, mutant: key, entry, args: encodeJson(args)}, 60_000, 60_000, (line) => {
    if (line.type === 'replay') result = line
  })
  return result
}

/** One encoded input through the uninstrumented original and mutant trees of `key`. */
async function uninstrumentedCall(key: string, entry: string, args: string): Promise<CallLine | null> {
  let call: CallLine | null = null
  await runChild({mode: 'call', plan: planPath, mutant: key, entry, args}, 60_000, 60_000, (line) => {
    if (line.type === 'call') call = line
  })
  return call
}

if (rules.replay.kind === 'sweep-first') {
  type SweepOutput = {failures: {fn: string; label: string; line: number; firstCall: string; firstArgs: string}[]; evaluations: number}
  const reference = decodeJson(readFileSync(join(scratch, rules.data.reference), 'utf8')) as SysmutRow[]
  const misses = reference.filter((row) => plannedKeys.has(row.id) && row.sweep.caught && !criterionKilled.has(row.id))
  log(`replay: ${misses.length} recorded sweep kills missed under the criterion rules`)
  const sweepDir = join(scratch, rules.replay.sweepCopyDir)
  for (const row of misses) {
    const sweep = Bun.spawnSync(['bun', 'sweep/run.ts', row.family, row.path, '--first'], {cwd: sweepDir, timeout: 300_000})
    let parsed: SweepOutput | null = null
    try {
      parsed = JSON.parse(sweep.stdout.toString()) as SweepOutput
    } catch {
      parsed = null
    }
    const first = parsed?.failures[0] ?? null
    const outcome = first == null ? null : await replay(row.id, first.firstCall, JSON.parse(first.firstArgs) as Value[])
    appendFileSync(replayPath, `${encodeJson({mutant: row.id, sweepExit: sweep.exitCode, sweepFirst: first, sweepEvaluations: parsed?.evaluations ?? null, replay: outcome})}\n`)
  }
} else if (rules.family === 'frames') {
  // Recorded catches come from the inv/ sweep. A field input recorded through a sidebar frame replays on the frame the
  // uninstrumented original returns for that sidebar call, so original and mutant receive one argument list.
  const reference = decodeJson(readFileSync(join(scratch, rules.data.reference), 'utf8')) as FramesReference
  let replayed = 0
  for (const copyRule of rules.data.copies) {
    for (const id of copyRule.expectedKills ?? []) {
      const key = `${copyRule.id}/${id}`
      if (!plannedKeys.has(key) || criterionKilled.has(key)) continue
      for (const recorded of reference.mutants.find((candidate) => candidate.id === id)?.sweep.catches ?? []) {
        for (const example of recorded.examples) {
          const call = framesHarnessCall(recorded.family, example)
          let source = `sweep ${recorded.family}/${recorded.mode} ${recorded.file}:${recorded.line} (${recorded.numbering} numbering)`
          let args: Value[] | null = call.args
          if (call.frameFrom != null) {
            const frameCall = await uninstrumentedCall(key, call.frameFrom.entry, encodeJson(call.frameFrom.args))
            const frame = frameCall?.original.value ?? null
            source += `; frame returned by the uninstrumented original's ${formatCall(call.frameFrom.entry, call.frameFrom.args)}`
            args = frame == null || frame.endsWith('…') ? null : [decodeJson(frame) as Value, ...call.args.slice(1)]
          }
          replayed += 1
          appendFileSync(replayPath, `${encodeJson({mutant: key, copy: copyRule.id, id, source, helper: `${recorded.family}/${recorded.mode}`, entry: call.entry, args: encodeJson(args ?? call.args), replay: args == null ? null : await replay(key, call.entry, args)})}\n`)
        }
      }
    }
  }
  log(`replay: ${replayed} recorded inputs of missed expected kills`)
} else {
  const reference = decodeJson(readFileSync(join(scratch, rules.data.reference), 'utf8')) as PlantedReference
  let replayed = 0
  for (const copyRule of rules.data.copies) {
    const signature = copyRule.signature
    if (signature == null) continue
    for (const id of [...(copyRule.expectedKills ?? []), ...(copyRule.staticOnly ?? [])]) {
      const key = `${copyRule.id}/${id}`
      if (!plannedKeys.has(key) || criterionKilled.has(key)) continue
      const mutant = reference.mutants.find((candidate) => candidate.id === id)
      const examples: {source: string; helper: string; entry: string; args: Value[]}[] = []
      for (const recorded of [...(mutant?.sweep?.catches ?? []), ...(mutant?.hindsightSweep?.catches ?? [])]) {
        examples.push({source: `sweep ${recorded.kind}@${recorded.file}.ts:${recorded.line} (${recorded.numbering} numbering)`, helper: recorded.helper, ...harnessCall(recorded.helper, signature, recorded.example)})
      }
      for (const staticOnly of reference.staticOnly.filter((candidate) => candidate.id === id)) examples.push({source: `static-only input: ${staticOnly.source}`, helper: staticOnly.entry, entry: staticOnly.entry, args: staticOnly.args})
      for (const example of examples) {
        replayed += 1
        appendFileSync(replayPath, `${encodeJson({mutant: key, copy: copyRule.id, id, source: example.source, helper: example.helper, entry: example.entry, args: encodeJson(example.args), replay: await replay(key, example.entry, example.args)})}\n`)
      }
    }
  }
  log(`replay: ${replayed} recorded inputs of missed expected kills`)
}

const callsPath = join(outDir, 'calls.jsonl')
for (const target of firstKills) {
  const call = await uninstrumentedCall(target.mutant, target.entry, target.input)
  appendFileSync(callsPath, `${encodeJson({...target, call})}\n`)
}
log(`first-kill calls: ${firstKills.length}`)

// -- 7: Freerange findings on the copies, report ------------------------------------------

const frRevision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: dirname(FR)}).stdout.toString().trim()
for (const copy of plan.copies) {
  for (const file of copy.files) {
    if (!copy.entries.some((entry) => entry.file === file.file)) continue
    // From the copy directory, as the families' own runs call fr, e.g. `bun fr.ts src/MidUI/PageFrame.ts` in frames/inv.
    const copyDir = file.source.slice(0, file.source.length - file.path.length)
    const findings = Bun.spawnSync(['bun', FR, file.path], {cwd: copyDir, timeout: 300_000})
    writeFileSync(join(outDir, `fr-${copy.copy}-${file.file}.txt`), `fr revision ${frRevision}\n${findings.stdout.toString()}${findings.stderr.toString()}`)
  }
}
meta['freerange'] = {revision: frRevision, command: 'bun fr.ts <file> (cwd: the copy directory)'}
finishMeta('complete')
log('report')
await writeReport(outDir, rules)
log(`done in ${((performance.now() - wallStart) / 1000).toFixed(1)} s`)
