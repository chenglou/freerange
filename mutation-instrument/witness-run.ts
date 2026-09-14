// scoring@witness-v1's witness run (plan-a/decision-domain.md R-X0 step 5): every registered witness set on every copy it
// names (witness.ts), then every stored witness input called on the uninstrumented copy (worker.ts verify-batch), then the
// witness tables and R-D1(ii)'s drop list. It runs the recorded sweeps, never the lattice, and changes no rule or list.
// usage: bun mutation-instrument/witness-run.ts --scoring <registered/w1-scoring.json>
//          the four families' witness sets, into the registered witness.runDir
//        bun mutation-instrument/witness-run.ts --rules <registered/m7-mj-gallery.json> --plan <run dir> --out <witness run dir>
//          an mj-gallery registration's scoringWitness sets, against the spliced original trees of that run's plan (m7's
//          baseline-only run), into --out
// Writes into the witness run directory, which must not exist yet:
//   wrappers/<family>-<copy>/...       the wrapper trees the sweeps import
//   <family>-<copy>-<set>.json, .log   each witness child's output and the sweep's own console output
//   verify-items-<family>-<copy>.json  the stored witness inputs, in table order
//   witness-<family>-<copy>.json       the witness table scoring.ts reads
//   drop-list.json, meta.json
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs'
import {basename, dirname, join} from 'node:path'
import type {CallerRuleFile} from './callers.ts'
import {runChild} from './children.ts'
import {domainLines} from './domain-lines.ts'
import {decodeJson, encodeJson} from './encode.ts'
import type {MjGalleryRegistration} from './mj-gallery.ts'
import {decodePlan} from './plan-file.ts'
import type {ScoringRegistration, WitnessSet} from './rules.ts'
import type {CopyPlan, Plan, VerifyItemLine, WitnessEntry, WitnessJob, WitnessSetOutput, WitnessTable} from './types.ts'

const WITNESS = realpathSync(new URL('./witness.ts', import.meta.url).pathname)
const INSTRUMENT_DIR = dirname(WITNESS)
const wallStart = performance.now()

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

// What one witness run runs, from registered/w1-scoring.json or from an mj-gallery registration's scoringWitness block.
type WitnessRunConfig = {
  scratch: string
  runDir: string
  scoring: {path: string; sha1: string}
  callerRules: {path: string; sha1: string} | null
  plans: Map<string, string> // family to plan.json, e.g. popovers to runs/20260913T151722Z-popovers-m2/plan.json
  sets: WitnessSet[]
  reservoir: number
  childHardLimitMinutes: number
  measuredOn: string
  planRun: {path: string; metaSha1: string} | null
}

function w1Config(path: string): WitnessRunConfig {
  const text = readFileSync(path, 'utf8')
  const registration = decodeJson(text) as ScoringRegistration
  const scratch = registration.data.scratch
  return {
    scratch, runDir: join(scratch, registration.witness.runDir), scoring: {path, sha1: sha1(text)}, callerRules: registration.witness.callerRules,
    plans: new Map(Object.entries(registration.witness.plans).map(([family, run]) => [family, join(scratch, run, 'plan.json')])),
    sets: registration.witness.sets, reservoir: registration.witness.reservoir, childHardLimitMinutes: registration.witness.childHardLimitMinutes,
    measuredOn: 'exposed development data: the recorded caller-derived sweeps of popovers, frames and packing against the domain@v2 runs\' spliced original trees; calibration, not a benchmark',
    planRun: null,
  }
}

function mjGalleryConfig(path: string, planRun: string, out: string): WitnessRunConfig {
  const text = readFileSync(path, 'utf8')
  const registration = decodeJson(text) as MjGalleryRegistration
  const witness = registration.scoringWitness
  const planMetaPath = join(planRun, 'meta.json')
  const planMeta = decodeJson(readFileSync(planMetaPath, 'utf8')) as Record<string, unknown>
  if (typeof planMeta['status'] !== 'string' || !planMeta['status'].startsWith('complete') || planMeta['rulesSha1'] !== sha1(text)) throw new Error(`${planRun} is not a complete run of ${path}`)
  return {
    scratch: registration.data.scratch, runDir: out, scoring: {path, sha1: sha1(text)}, callerRules: null,
    plans: new Map([[registration.family, join(planRun, 'plan.json')]]),
    sets: witness.witnessSets.map((set) => ({family: registration.family, name: set.name, script: set.script, scriptSha1: set.scriptSha1, args: set.args, substitute: set.substitute, tiers: set.tiers, copies: set.copies})),
    reservoir: witness.reservoir, childHardLimitMinutes: witness.gates.childHardLimitMinutes,
    measuredOn: `${registration.measured_on}; witness sets ${witness.witnessSets.map((set) => set.name).join(', ')} against the spliced original trees of ${planRun}`,
    planRun: {path: planRun, metaSha1: sha1(readFileSync(planMetaPath))},
  }
}

const scoringPath = option('--scoring')
const rulesPath = option('--rules')
const planRunPath = option('--plan')
const outPath = option('--out')
const config = scoringPath != null ? w1Config(scoringPath)
  : rulesPath != null && planRunPath != null && outPath != null ? mjGalleryConfig(rulesPath, realpathSync(planRunPath), outPath)
  : null
if (config == null) throw new Error('usage: bun mutation-instrument/witness-run.ts --scoring <registered/w1-scoring.json> | --rules <mj-gallery registration> --plan <run dir> --out <witness run dir>')
const scratch = config.scratch
const runDir = config.runDir
if (existsSync(runDir)) throw new Error(`refusing to overwrite ${runDir}`)
const callerRulesPath = config.callerRules == null ? null : join(scratch, config.callerRules.path)
const callerRulesText = callerRulesPath == null ? null : readFileSync(callerRulesPath, 'utf8')
if (config.callerRules != null && callerRulesText != null && sha1(callerRulesText) !== config.callerRules.sha1) throw new Error(`caller rules ${callerRulesPath}: sha1 ${sha1(callerRulesText)} differs from the registered ${config.callerRules.sha1}`)
for (const set of config.sets) {
  const scriptSha1 = sha1(readFileSync(join(scratch, set.script)))
  if (scriptSha1 !== set.scriptSha1) throw new Error(`witness set ${set.name}: ${set.script} sha1 ${scriptSha1} differs from the registered ${set.scriptSha1}`)
}
mkdirSync(join(runDir, 'outputs'), {recursive: true})

const instrumentFiles = readdirSync(INSTRUMENT_DIR).filter((name) => name.endsWith('.ts')).sort()
const meta: Record<string, unknown> = {
  scoring: config.scoring,
  callerRules: config.callerRules,
  planRun: config.planRun,
  instrumentCommit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim(),
  instrumentDirty: Bun.spawnSync(['git', 'status', '--porcelain', '--', '.'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim() !== '',
  instrumentSha1: sha1(instrumentFiles.map((name) => `${name}\n${readFileSync(join(INSTRUMENT_DIR, name), 'utf8')}`).join('\n')),
  bun: Bun.version,
  measured_on: config.measuredOn,
  started: new Date().toISOString(),
  status: 'running',
}
const writeMeta = () => writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`)
writeMeta()

const plans = new Map<string, {path: string; plan: Plan}>()
for (const [family, path] of config.plans) plans.set(family, {path, plan: decodePlan(readFileSync(path, 'utf8'))})

function planOf(family: string) {
  const found = plans.get(family)
  if (found == null) throw new Error(`no registered plan for family ${family}`)
  return found
}

function copyOf(plan: Plan, copyId: string): CopyPlan {
  const copy = plan.copies.find((candidate) => candidate.copy === copyId)
  if (copy == null) throw new Error(`no copy ${copyId} in the registered plan`)
  return copy
}

const pairs: {family: string; copy: string}[] = []
for (const set of config.sets) {
  for (const copyId of set.copies) if (!pairs.some((pair) => pair.family === set.family && pair.copy === copyId)) pairs.push({family: set.family, copy: copyId})
}

// -- wrapper trees ---------------------------------------------------------------

for (const pair of pairs) {
  const copy = copyOf(planOf(pair.family).plan, pair.copy)
  const wrapperRoot = join(runDir, 'wrappers', `${pair.family}-${pair.copy}`)
  for (const file of copy.files) {
    const lines = [`import * as original from ${JSON.stringify(file.instrumented)}`, `export * from ${JSON.stringify(file.instrumented)}`]
    copy.entries.forEach((entry, index) => {
      if (entry.file === file.file) lines.push(`export const ${entry.name} = globalThis.__witness.wrap(${index}, original.${entry.name})`)
    })
    const path = join(wrapperRoot, file.path)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, `${lines.join('\n')}\n`)
  }
  if (copy.nodeModules != null) symlinkSync(copy.nodeModules, join(wrapperRoot, 'node_modules'))
}

// -- witness children -------------------------------------------------------------------

type ChildRecord = {name: string; exitCode: number | null; timedOut: boolean; ms: number; maxRssKb: number | null}
const childRecords: ChildRecord[] = []
for (const set of config.sets) {
  for (const copyId of set.copies) {
    const name = `${set.family}-${copyId}-${set.name}`
    const wrapperDir = join(runDir, 'wrappers', `${set.family}-${copyId}`)
    const outputs = join(runDir, 'outputs', name)
    mkdirSync(outputs, {recursive: true})
    const resolvePlaceholders = (text: string) => text.replaceAll('{wrapper}', wrapperDir).replaceAll('{outputs}', outputs)
    const job: WitnessJob = {
      plan: planOf(set.family).path, family: set.family, copy: copyId, set: set.name, script: join(scratch, set.script), args: set.args.map(resolvePlaceholders),
      substitute: set.substitute == null ? null : {from: set.substitute.from, to: resolvePlaceholders(set.substitute.to)},
      derivedScript: join(outputs, basename(set.script)), tiers: set.tiers, callerRules: callerRulesPath, reservoir: config.reservoir, out: join(runDir, `${name}.json`),
    }
    log(`witness set ${name}`)
    const childStart = performance.now()
    const child = Bun.spawn(['bun', WITNESS, encodeJson(job)], {stdout: Bun.file(join(runDir, `${name}.log`)), stderr: Bun.file(join(runDir, `${name}.stderr.log`))})
    const limit = {timedOut: false}
    const timer = setTimeout(() => {
      limit.timedOut = true
      child.kill('SIGKILL')
    }, config.childHardLimitMinutes * 60_000)
    const exitCode = await child.exited
    clearTimeout(timer)
    const finished = existsSync(job.out)
    childRecords.push({name, exitCode, timedOut: limit.timedOut, ms: performance.now() - childStart, maxRssKb: finished ? (decodeJson(readFileSync(job.out, 'utf8')) as WitnessSetOutput).maxRssKb : null})
    meta['children'] = childRecords
    writeMeta()
    log(`witness set ${name}: exit ${exitCode} in ${((performance.now() - childStart) / 1000).toFixed(1)} s`)
    if (exitCode !== 0 || limit.timedOut || !finished) {
      meta['status'] = `failed: witness set ${name}`
      writeMeta()
      throw new Error(`witness set ${name} failed: exit ${exitCode}${limit.timedOut ? ', past the hard limit' : ''}; see ${name}.stderr.log`)
    }
  }
}

// -- uninstrumented calls and tables ----------------------------------------------------------

const tables: WitnessTable[] = []
const verifyRecords: {pair: string; items: number; exitCode: number | null; timedOut: string | null; ms: number; maxRssKb: number | null}[] = []
for (const pair of pairs) {
  const {path: planPath, plan} = planOf(pair.family)
  const copy = copyOf(plan, pair.copy)
  const outputs = config.sets.filter((set) => set.family === pair.family && set.copies.includes(pair.copy)).map((set) => ({set: set.name, path: join(runDir, `${pair.family}-${pair.copy}-${set.name}.json`)}))
  const decoded = outputs.map((output) => decodeJson(readFileSync(output.path, 'utf8')) as WitnessSetOutput)
  const items: {entry: string; args: string}[] = []
  for (const setOutput of decoded) {
    for (const entryOutput of setOutput.entries) {
      for (const siteOutput of entryOutput.sites) for (const reservoir of siteOutput.reservoirs) for (const input of reservoir.inputs) items.push({entry: entryOutput.name, args: input})
    }
  }
  const itemsPath = join(runDir, `verify-items-${pair.family}-${pair.copy}.json`)
  writeFileSync(itemsPath, JSON.stringify(items))
  const results = new Array<VerifyItemLine | null>(items.length).fill(null)
  log(`uninstrumented calls ${pair.family}-${pair.copy}: ${items.length} stored witness inputs`)
  const verifyRun = await runChild({mode: 'verify-batch', plan: planPath, base: pair.copy, items: itemsPath}, config.childHardLimitMinutes * 60_000, 60_000, (line) => {
    if (line.type === 'verify-item') results[line.item] = line
  })
  verifyRecords.push({pair: `${pair.family}-${pair.copy}`, items: items.length, exitCode: verifyRun.exitCode, timedOut: verifyRun.timedOut, ms: verifyRun.ms, maxRssKb: verifyRun.done?.maxRssKb ?? null})
  meta['verifyChildren'] = verifyRecords
  writeMeta()
  if (verifyRun.exitCode !== 0 || verifyRun.timedOut != null || results.some((result) => result == null)) {
    meta['status'] = `failed: uninstrumented calls of ${pair.family}-${pair.copy}`
    writeMeta()
    throw new Error(`uninstrumented calls of ${pair.family}-${pair.copy} failed: exit ${verifyRun.exitCode} ${verifyRun.timedOut ?? ''}\n${verifyRun.stderr}`)
  }

  const entries: WitnessEntry[] = []
  let item = 0
  for (const setOutput of decoded) {
    for (const entryOutput of setOutput.entries) {
      const plannedEntry = copy.entries.find((candidate) => candidate.name === entryOutput.name)
      if (plannedEntry == null) throw new Error(`witness output names ${entryOutput.name}, which copy ${pair.copy} doesn't export`)
      const lines = domainLines(copy, plannedEntry)
      let found = entries.find((candidate) => candidate.name === entryOutput.name)
      if (found == null) {
        found = {name: entryOutput.name, rules: entryOutput.rules, calls: 0, inDomain: 0, degenerate: 0, unclassified: 0, overBudget: 0, threw: 0, domainLineFired: 0, sites: [], ruleChecks: entryOutput.rules.map((id) => ({id, checked: 0, violations: 0, firstViolation: null}))}
        entries.push(found)
      }
      const entry = found
      entry.calls += entryOutput.calls
      entry.inDomain += entryOutput.inDomain
      entry.degenerate += entryOutput.degenerate
      entry.unclassified += entryOutput.unclassified
      entry.overBudget += entryOutput.overBudget
      entry.threw += entryOutput.threw
      entry.domainLineFired += entryOutput.domainLineFired
      entryOutput.ruleChecks.forEach((check, bit) => {
        const merged = entry.ruleChecks[bit]!
        if (merged.id !== check.id) throw new Error(`witness outputs of ${pair.copy}.${entry.name} order its caller rules differently`)
        merged.checked += check.checked
        merged.violations += check.violations
        merged.firstViolation ??= check.firstViolation
      })
      for (const siteOutput of entryOutput.sites) {
        let site = entry.sites.find((candidate) => candidate.key === siteOutput.key)
        if (site == null) {
          site = {key: siteOutput.key, file: siteOutput.file, line: siteOutput.line, firing: 0, withoutDomainLine: 0, reservoirs: []}
          entry.sites.push(site)
        }
        site.firing += siteOutput.firing
        site.withoutDomainLine += siteOutput.withoutDomainLine
        for (const reservoirOutput of siteOutput.reservoirs) {
          let reservoir = site.reservoirs.find((candidate) => candidate.mask === reservoirOutput.mask)
          if (reservoir == null) {
            reservoir = {mask: reservoirOutput.mask, count: 0, stored: 0, verified: 0, firstVerified: null, failures: []}
            site.reservoirs.push(reservoir)
          }
          reservoir.count += reservoirOutput.count
          for (const input of reservoirOutput.inputs) {
            const result = results[item]!
            item += 1
            reservoir.stored += 1
            if (result.fired.includes(`${site.file}:${site.line}`) && !result.fired.some((line) => lines.has(line))) {
              reservoir.verified += 1
              reservoir.firstVerified ??= input
            } else if (reservoir.failures.length < 3) {
              reservoir.failures.push({input, fired: result.fired, thrown: result.thrown})
            }
          }
        }
      }
    }
  }
  if (item !== items.length) throw new Error(`table of ${pair.family}-${pair.copy}: ${item} of ${items.length} stored inputs merged`)
  const table: WitnessTable = {family: pair.family, copy: pair.copy, sets: outputs.map((output) => ({set: output.set, output: output.path, outputSha1: sha1(readFileSync(output.path))})), entries}
  writeFileSync(join(runDir, `witness-${pair.family}-${pair.copy}.json`), encodeJson(table))
  tables.push(table)
}

// -- R-D1(ii): the drop list --------------------------------------------------------------------

const ruleFile: CallerRuleFile = callerRulesText == null ? {version: 'none', rules: []} : decodeJson(callerRulesText) as CallerRuleFile
const ruleRecords = ruleFile.rules.map((rule) => {
  const perEntry: {family: string; copy: string; entry: string; checked: number; violations: number; firstViolation: string | null}[] = []
  for (const table of tables) {
    for (const entry of table.entries) {
      for (const check of entry.ruleChecks) if (check.id === rule.id) perEntry.push({family: table.family, copy: table.copy, entry: entry.name, checked: check.checked, violations: check.violations, firstViolation: check.firstViolation})
    }
  }
  let checked = 0
  let violations = 0
  for (const record of perEntry) {
    checked += record.checked
    violations += record.violations
  }
  return {id: rule.id, text: rule.text, checked, violations, dropped: violations > 0, perEntry}
})
const dropList = {
  rule: 'R-D1(ii): a caller rule violated by at least one in-domain witness call of an entry it names, in any witness set on any copy, is dropped. A dropped rule is never rewritten; its entries keep domain@v2.',
  scoring: meta['scoring'],
  callerRules: meta['callerRules'],
  rules: ruleRecords,
  dropped: ruleRecords.filter((record) => record.dropped).map((record) => record.id),
}
const dropListText = `${JSON.stringify(dropList, null, 1)}\n`
writeFileSync(join(runDir, 'drop-list.json'), dropListText)
meta['dropList'] = {sha1: sha1(dropListText), dropped: dropList.dropped, checks: ruleRecords.map((record) => `${record.id}: ${record.violations} violations in ${record.checked} witness calls`)}
meta['tables'] = Object.fromEntries(pairs.map((pair) => [`${pair.family}-${pair.copy}`, sha1(readFileSync(join(runDir, `witness-${pair.family}-${pair.copy}.json`)))]))
meta['wallSeconds'] = (performance.now() - wallStart) / 1000
meta['parentMaxRssKb'] = process.resourceUsage().maxRSS
meta['finished'] = new Date().toISOString()
meta['status'] = 'complete'
writeMeta()
log(`drop list: ${dropList.dropped.length === 0 ? 'no rule dropped' : dropList.dropped.join(', ')}; ${ruleRecords.map((record) => `${record.id} ${record.violations}/${record.checked}`).join('; ')}`)
