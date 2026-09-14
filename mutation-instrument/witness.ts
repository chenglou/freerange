// A child of witness-run.ts (scoring@witness-v1 R-S2, R-S3 (a) and (b), R-D1(ii)): runs one recorded caller-derived sweep,
// unchanged, against a copy's spliced original tree with the recorder in collect mode. The sweep imports its modules from a
// wrapper tree, written by witness-run.ts, whose files re-export the spliced tree and wrap each exported function:
//   import * as original from '<run>/work/original/contracts/menuGeometry.ts'
//   export * from '<run>/work/original/contracts/menuGeometry.ts'
//   export const menuHoverCorridorProperties = globalThis.__witness.wrap(3, original.menuHoverCorridorProperties)
// Calls between functions inside the spliced tree don't go through the wrappers, so each wrapped call is one call by the
// sweep. Per call of an entry this child keeps the sites at level 3 or above, whether a domain line of the entry reached
// level 2 or above, which caller rules of the entry the arguments violate, and, among calls that fire no domain line, up to
// `reservoir` encoded argument lists per (site, rule-violation mask), and per site the calls that raise it to level 2 or above.
// usage: bun witness.ts '<job json>'   (writes job.out; the sweep's own output goes to this process's stdout)
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {violatedRules, type CallerRuleFile, type CallerRulePlan} from './callers.ts'
import type {Value} from './domain.ts'
import {domainLines} from './domain-lines.ts'
import {decodeJson, encodeJson} from './encode.ts'
import {decodePlan} from './plan-file.ts'
import {BUDGET, createRecorder, resetRecorder} from './recorder.ts'
import type {WitnessEntryOutput, WitnessJob, WitnessSetOutput, WitnessSiteOutput} from './types.ts'

const started = performance.now()
const job = decodeJson(process.argv[2] ?? '') as WitnessJob
const plan = decodePlan(readFileSync(job.plan, 'utf8'))
const copy = plan.copies.find((candidate) => candidate.copy === job.copy)
if (copy == null) throw new Error(`no copy ${job.copy} in ${job.plan}`)
const sites = copy.sites
const recorder = createRecorder(sites, plan.stepBudget)
// Collect mode: no site throws DISCARD, so a call runs past its domain lines, and the record reads afterwards whether one fired.
recorder.setEntry([])
;(globalThis as Record<string, unknown>)['__fr'] = recorder
const ruleFile: CallerRuleFile = job.callerRules == null ? {version: 'none', rules: []} : decodeJson(readFileSync(job.callerRules, 'utf8')) as CallerRuleFile

type Outcome = 'returned' | 'threw' | 'budget'
// raised: per site, the calls that raise it to level 2 or above and fire no domain line
type EntryState = {rules: CallerRulePlan[]; domainSites: Uint8Array; sites: (WitnessSiteOutput | null)[]; raised: Uint32Array; output: WitnessEntryOutput}

const states: EntryState[] = copy.entries.map((entry) => {
  const rules: CallerRulePlan[] = []
  for (const rule of ruleFile.rules) {
    if (!rule.entries.some((target) => target.family === job.family && target.copy === job.copy && target.file === entry.file && target.entry === entry.name)) continue
    rules.push({id: rule.id, text: rule.text, sources: rule.sources, conditions: rule.conditions})
  }
  const lines = domainLines(copy, entry)
  const domainSites = new Uint8Array(sites.length)
  for (const site of sites) if (lines.has(`${site.file}:${site.line}`)) domainSites[site.index] = 1
  const output: WitnessEntryOutput = {
    name: entry.name, rules: rules.map((rule) => rule.id), calls: 0, inDomain: 0, degenerate: 0, unclassified: 0, overBudget: 0, threw: 0, domainLineFired: 0,
    sites: [], raised: [], ruleChecks: rules.map((rule) => ({id: rule.id, checked: 0, violations: 0, firstViolation: null})),
  }
  return {rules, domainSites, sites: new Array<WitnessSiteOutput | null>(sites.length).fill(null), raised: new Uint32Array(sites.length), output}
})

// packing sweep.ts's degenerate widths: the container widths of allWidths (sweep.ts:64) and the card section's column widths (:255).
const DEGENERATE_WIDTHS = [0, 0.5, 1, 1e6]
const DEGENERATE_COLUMN_WIDTHS = [0, 0.5, 1e6]
type Tier = 'in-domain' | 'degenerate' | 'unclassified'
let gridTier: Tier = 'unclassified'

function tierOf(widths: number[], value: Value): Tier {
  if (typeof value !== 'number') return 'unclassified'
  return widths.includes(value) ? 'degenerate' : 'in-domain'
}

/**
 * The packing sweep tier of one call, from the argument that carries its section's width: clampOrigin's nearEdge + farEdge
 * (the viewport, sweep.ts:133-134), packRows' and equalColumnWidth's width, masonryColumnCount's and packMasonry's
 * containerInnerSizeX, and the card helpers' columnWidth. gridLayout and gridHeight take the tier of the equalColumnWidth
 * call sweep.ts makes before them for the same width and grid config.
 */
function packingTier(name: string, args: Value[]): Tier {
  switch (name) {
    case 'clampOrigin': {
      const nearEdge = args[2]
      const farEdge = args[3]
      return typeof nearEdge === 'number' && typeof farEdge === 'number' ? tierOf(DEGENERATE_WIDTHS, nearEdge + farEdge) : 'unclassified'
    }
    case 'packRows': return tierOf(DEGENERATE_WIDTHS, args[1])
    case 'equalColumnWidth':
      gridTier = tierOf(DEGENERATE_WIDTHS, args[0])
      return gridTier
    case 'gridLayout':
    case 'gridHeight':
      return gridTier
    case 'masonryCardHeight':
    case 'masonryStyleCardHeight':
      return tierOf(DEGENERATE_COLUMN_WIDTHS, args[0])
    case 'masonryColumnCount': return tierOf(DEGENERATE_WIDTHS, args[2])
    case 'packMasonry': return tierOf(DEGENERATE_WIDTHS, args[3])
    default: return 'unclassified'
  }
}

function record(state: EntryState, args: Value[], outcome: Outcome) {
  const output = state.output
  output.calls += 1
  switch (job.tiers === 'packing-in-domain' ? packingTier(output.name, args) : 'in-domain') {
    case 'degenerate':
      output.degenerate += 1
      return
    case 'unclassified':
      output.unclassified += 1
      return
    case 'in-domain':
      output.inDomain += 1
      break
  }
  // R-D1(ii) checks a rule on every in-domain witness call, whatever the call did.
  let mask = 0
  for (let bit = 0; bit < state.rules.length; bit++) {
    const check = output.ruleChecks[bit]!
    check.checked += 1
    if (violatedRules([state.rules[bit]!], args).length === 0) continue
    mask |= 1 << bit
    check.violations += 1
    check.firstViolation ??= encodeJson(args)
  }
  // A call past the step budget stopped partway, so its site levels are incomplete: like the lattice, it witnesses nothing.
  if (outcome === 'budget') {
    output.overBudget += 1
    return
  }
  if (outcome === 'threw') output.threw += 1
  let domainLineFired = false
  for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
    const site = recorder.touched[touchedIndex]!
    if (state.domainSites[site] === 1 && recorder.levels[site]! >= 2) domainLineFired = true
  }
  if (domainLineFired) {
    output.domainLineFired += 1
  } else {
    for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
      const site = recorder.touched[touchedIndex]!
      if (recorder.levels[site]! >= 2) state.raised[site]! += 1
    }
  }
  let encoded: string | null = null
  for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
    const siteIndex = recorder.touched[touchedIndex]!
    if (recorder.levels[siteIndex]! < 3) continue
    let witness = state.sites[siteIndex] ?? null
    if (witness == null) {
      const site = sites[siteIndex]!
      witness = {site: siteIndex, key: site.key, file: site.file, line: site.line, firing: 0, withoutDomainLine: 0, reservoirs: []}
      state.sites[siteIndex] = witness
    }
    witness.firing += 1
    if (domainLineFired) continue
    witness.withoutDomainLine += 1
    let reservoir = witness.reservoirs.find((candidate) => candidate.mask === mask)
    if (reservoir == null) {
      reservoir = {mask, count: 0, inputs: []}
      witness.reservoirs.push(reservoir)
    }
    reservoir.count += 1
    if (reservoir.inputs.length < job.reservoir) reservoir.inputs.push(encoded ??= encodeJson(args))
  }
}

let depth = 0
function wrap(entryIndex: number, fn: (...args: Value[]) => unknown) {
  const state = states[entryIndex]
  if (state == null) throw new Error(`no entry ${entryIndex} in copy ${job.copy}`)
  return (...args: Value[]): unknown => {
    if (depth > 0) return fn(...args)
    depth += 1
    resetRecorder(recorder)
    const call: {outcome: Outcome} = {outcome: 'returned'}
    try {
      return fn(...args)
    } catch (error) {
      call.outcome = error === BUDGET ? 'budget' : 'threw'
      throw error
    } finally {
      depth -= 1
      record(state, args, call.outcome)
    }
  }
}
;(globalThis as Record<string, unknown>)['__witness'] = {wrap}

function sha1(text: string) {
  return createHash('sha1').update(text).digest('hex')
}

const scriptText = readFileSync(job.script, 'utf8')
let executed = job.script
let executedText = scriptText
if (job.substitute != null) {
  const {from, to} = job.substitute
  const occurrences = scriptText.split(from).length - 1
  if (occurrences !== 1) throw new Error(`${job.script}: expected exactly one occurrence of ${JSON.stringify(from)}, found ${occurrences}`)
  executedText = scriptText.replace(from, () => to)
  writeFileSync(job.derivedScript, executedText)
  executed = job.derivedScript
}
process.argv.splice(2, process.argv.length - 2, ...job.args)
await import(executed)
const output: WitnessSetOutput = {
  family: job.family, copy: job.copy, set: job.set, script: job.script, scriptSha1: sha1(scriptText), executed, executedSha1: sha1(executedText), args: job.args,
  ms: performance.now() - started, maxRssKb: process.resourceUsage().maxRSS,
  entries: states.map((state) => {
    const raised = []
    for (let site = 0; site < sites.length; site++) {
      const count = state.raised[site]!
      if (count > 0) raised.push({site, key: sites[site]!.key, file: sites[site]!.file, line: sites[site]!.line, withoutDomainLine: count})
    }
    return {...state.output, sites: state.sites.filter((site): site is WitnessSiteOutput => site != null), raised}
  }),
}
writeFileSync(job.out, encodeJson(output))
