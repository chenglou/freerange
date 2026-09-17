// FREERANGE_SWEEP: one test per cap of the registration's cap table, one per domain rule (D0 leading discards, F1, F2, F3,
// R1, browser globals), the precedence rows with planted static verdicts, the CLI text and exit codes, and the seven
// survival fixtures. Rule and cap tests call the sweep in-process with small limits; CLI tests spawn `fr` like
// project-report.test.ts.
import {expect, test} from 'bun:test'
import {spawn} from 'node:child_process'
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {analyzeCheckedSource, type DetailedAnalysis} from '../src/analyze.ts'
import {sweepStaticFindings} from '../src/project.ts'
import {requirementFor, staticVerdictLookup, sweepReport, type StaticFinding, type StaticVerdict, type SweepFinding} from '../src/sweep/report.ts'
import {DEFAULT_LIMITS, sweepFile, type SweepLimits} from '../src/sweep/run.ts'
import type {Site} from '../src/sweep/types.ts'
import {checkFile} from '../src/typescript/check.ts'

type SiteJson = {key: string; line: number; function: string | null; staticVerdict: StaticVerdict; outcome: string; n: number; level3: number; first: {entry: string; index: number; input: string; verified: boolean} | null; why: string | null; action: string | null; callLine: number | null}
type EntryJson = {name: string; status: string; drawn: number; inDomain: number; discards: {leading: number; F1: number; F3: number; R1: number}; overBudget: number; threw: number; discardSites: {line: number; cause: string}[]}
type SweepJson = {status: {kind: string; reason?: string; killed?: string | null}; entries: EntryJson[]; sites: SiteJson[]; caps: Record<string, number>; timing: {run: {ms: number; peakRssKb: number} | null}}

function writeFiles(directory: string, files: Record<string, string>) {
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
}

type InProcessOptions = {
  limits?: Partial<SweepLimits>
  filters?: 'base' | 'default'
  verdict?: (site: Site, real: StaticVerdict) => StaticVerdict
  mutate?: (detailed: DetailedAnalysis) => void
  staticFindings?: (real: StaticFinding[]) => StaticFinding[]
}

async function sweepInProcess(files: Record<string, string>, target: string, options: InProcessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-sweep-test-'))
  try {
    writeFiles(directory, files)
    const path = join(directory, target)
    const checked = checkFile(path)
    const detailed = analyzeCheckedSource(checked, directory)
    const realFindings = sweepStaticFindings(detailed)
    const staticFindings = options.staticFindings == null ? realFindings : options.staticFindings(realFindings)
    options.mutate?.(detailed)
    const real = staticVerdictLookup(detailed, staticFindings)
    const verdictOf = (site: Site) => options.verdict == null ? real(site) : options.verdict(site, real(site))
    const settings = {filters: options.filters ?? 'default', cap: 1e6, limits: {...DEFAULT_LIMITS, ...options.limits}}
    const run = await sweepFile(path, target, checked.sourceFile, checked.program, settings, (site) => requirementFor(verdictOf(site)))
    const report = sweepReport({run, verdictOf, detailed, staticFindings, sourceFile: checked.sourceFile, settings, level: 'warning', reportFile: target})
    return {report, json: report.json as SweepJson}
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
}

const siteAt = (json: SweepJson, line: number) => json.sites.find((site) => site.line === line)!
const sweepWarnings = (findings: SweepFinding[]) => findings.filter((finding) => finding.rule === 'console-assert-sweep')

// -- Caps --------------------------------------------------------------------------------

test('inputs per entry: a budget of 50 records exactly 50 calls', async () => {
  const {json} = await sweepInProcess({'identity.ts': `export function identity(value: number): number {
  const result = value
  console.assert(result >= -1e9)
  return result
}
`}, 'identity.ts', {limits: {inputsPerEntry: 50}})
  expect(json.entries[0]).toMatchObject({name: 'identity', status: 'run', drawn: 50, inDomain: 50})
  expect(siteAt(json, 3).n).toBe(50)
}, 30_000)

test('entries per file: 65 entries run 64 and leave 1 not run by the entry cap', async () => {
  const source = Array.from({length: 65}, (_, index) => `export function entry${index}(value: number): number { return value + ${index} }\n`).join('')
  const {report, json} = await sweepInProcess({'many.ts': source}, 'many.ts', {limits: {inputsPerEntry: 10}})
  expect(json.entries.filter((entry) => entry.status === 'run')).toHaveLength(64)
  expect(json.entries.filter((entry) => entry.status === 'not-run:entry cap').map((entry) => entry.name)).toEqual(['entry64'])
  expect(report.summaryLine).toBe('sweep: 64 of 65 functions run; 0 asserts held on at least 1,000 generated inputs; 0 counterexamples; 1 functions not run')
}, 30_000)

test('sites per file: 4,097 asserts leave the sweep not run, with a warning', async () => {
  const body = Array.from({length: 4097}, () => '  console.assert(result >= 0)\n').join('')
  const {report, json} = await sweepInProcess({'asserts.ts': `export function asserts(value: number): number {\n  const result = value\n${body}  return result\n}\n`}, 'asserts.ts')
  expect(json.status).toMatchObject({kind: 'not-run', reason: 'sweep of asserts.ts not run: 4097 asserts, above the cap of 4096'})
  expect(sweepWarnings(report.findings).map((finding) => finding.message)).toEqual(['sweep of asserts.ts not run: 4097 asserts, above the cap of 4096'])
}, 60_000)

test('loop ticks per call: a 2,000-iteration loop puts every input over budget and leaves the site not reached', async () => {
  const {json} = await sweepInProcess({'spin.ts': `export function spin(limit: number): number {
  let total = 0
  for (let index = 0; index < 2000; index++) total += 1
  console.assert(total >= limit)
  return total
}
`}, 'spin.ts', {limits: {inputsPerEntry: 100}})
  expect(json.entries[0]).toMatchObject({drawn: 100, overBudget: 100, inDomain: 0})
  expect(siteAt(json, 4).outcome).toBe('not-reached')
  expect(json.caps['stepBudget']).toBe(100)
}, 30_000)

test('relation repair: unsatisfiable a < b and b < a discard every input', async () => {
  const {json} = await sweepInProcess({'impossible.ts': `export function impossible(a: number, b: number): number {
  console.assert(a < b)
  console.assert(b < a)
  const sum = a + b
  console.assert(sum >= -1e7)
  return sum
}
`}, 'impossible.ts', {limits: {inputsPerEntry: 500}})
  expect(json.entries[0]).toMatchObject({drawn: 500, inDomain: 0, discards: {leading: 500, F1: 0, F3: 0, R1: 0}})
  expect(siteAt(json, 5).outcome).toBe('not-reached')
}, 30_000)

test('F1 loops per entry: the 9th consecutive loop is not a precondition', async () => {
  const loops = Array.from({length: 9}, (_, index) => `  for (const value of values) console.assert(value >= -${index + 1})\n`).join('')
  const {json} = await sweepInProcess({'nine.ts': `export function nine(values: number[]): number {\n${loops}  let total = 0\n  for (const value of values) total += value\n  return total\n}\n`}, 'nine.ts', {limits: {inputsPerEntry: 200}})
  const discards = json.entries[0]!.discardSites
  expect(discards.filter((discard) => discard.cause === 'F1').map((discard) => discard.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  expect(siteAt(json, 10).outcome).not.toBe('precondition')
  expect(siteAt(json, 9).outcome).toBe('precondition')
}, 30_000)

test('F3 callee depth: in a chain of 5 callees the 5th requirement is not a discard', async () => {
  const {json} = await sweepInProcess({'chain.ts': `type Item = {width: number}
function level5(item: Item): number { console.assert(item.width >= -5); return item.width }
function level4(item: Item): number { console.assert(item.width >= -4); return level5(item) }
function level3(item: Item): number { console.assert(item.width >= -3); return level4(item) }
function level2(item: Item): number { console.assert(item.width >= -2); return level3(item) }
function level1(item: Item): number { console.assert(item.width >= -1); return level2(item) }
export function chain(items: Item[]): number {
  let total = 0
  for (let index = 0; index < items.length; index++) total += level1(items[index]!)
  return total
}
`}, 'chain.ts', {limits: {inputsPerEntry: 100}})
  const chain = json.entries.find((entry) => entry.name === 'chain')!
  expect(chain.discardSites.map((discard) => [discard.line, discard.cause])).toEqual([[6, 'F3'], [5, 'F3'], [4, 'F3'], [3, 'F3']])
}, 30_000)

test('printed counterexamples: 65 failing sites print 64 and the summary counts 65', async () => {
  const body = Array.from({length: 65}, (_, index) => `  console.assert(result > ${2e6 + index})\n`).join('')
  const {report, json} = await sweepInProcess({'sixty-five.ts': `export function sixtyFive(value: number): number {\n  const result = value\n${body}  return result\n}\n`}, 'sixty-five.ts', {limits: {inputsPerEntry: 200, verifyItems: 128}})
  expect(sweepWarnings(report.findings)).toHaveLength(64)
  expect(json.sites.filter((site) => site.outcome === 'counterexample')).toHaveLength(65)
  expect(report.summaryLine).toContain('; 65 counterexamples;')
  expect(json.caps['printedCounterexamples']).toBe(1)
}, 60_000)

test('encoded input: a 3 KB input prints truncated with a marker and the JSON keeps its index', async () => {
  const fields = Array.from({length: 300}, (_, index) => `f${index}: number`).join('; ')
  const {report, json} = await sweepInProcess({'wide.ts': `type Wide = {${fields}}
export function wide(row: Wide): number {
  const first = row.f0
  console.assert(first > 2e6)
  return first
}
`}, 'wide.ts', {limits: {inputsPerEntry: 50}})
  const warning = sweepWarnings(report.findings)[0]!
  const inputLine = warning.details[0]!
  expect(inputLine.startsWith('  input: wide({f0: ')).toBe(true)
  const site = siteAt(json, 4)
  expect(inputLine).toEndWith(`… [input truncated at 2,048 bytes; the JSON sidecar keeps input ${site.first!.index} of wide]`)
  expect(site.first!.input.length).toBeGreaterThan(3000)
  expect(json.caps['inputTruncated']).toBe(1)
}, 30_000)

test('held threshold: a precondition met on 1 of 64 inputs at budget 10,000 leaves the site starved', async () => {
  const slots = Array.from({length: 64}, (_, index) => String(index)).join(' | ')
  const {json} = await sweepInProcess({'slot.ts': `type Slot = ${slots}
export function slot(k: Slot): number {
  console.assert(k === 7)
  const copy = k + 1
  console.assert(copy >= 1)
  return copy
}
`}, 'slot.ts', {limits: {inputsPerEntry: 10_000}})
  const site = siteAt(json, 5)
  expect(site.n).toBeGreaterThan(0)
  expect(site.n).toBeLessThan(1000)
  expect(site.outcome).toBe('starved')
}, 30_000)

test('child hard limit: an entry sleeping 1 s per call is stopped at a 3 s limit', async () => {
  const {report, json} = await sweepInProcess({
    'sleep.ts': 'export function sleepOneSecond(): void {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)\n}\n',
    'slow.ts': `import {sleepOneSecond} from './sleep'
export function slow(value: number): number {
  sleepOneSecond()
  const result = value
  console.assert(result >= 0)
  return result
}
`,
  }, 'slow.ts', {limits: {hardMs: 3000, inputsPerEntry: 100}})
  expect(json.status.killed).toBe('hard limit')
  expect(sweepWarnings(report.findings).map((finding) => finding.message)).toEqual(['sweep of slow.ts stopped: hard limit'])
  expect(json.timing.run!.ms).toBeLessThan(4000)
}, 30_000)

test('child RSS: 64 MB retained per call is stopped within one call of a 300 MB limit', async () => {
  const {report, json} = await sweepInProcess({
    'retain.ts': 'const kept: Uint8Array[] = []\nexport function retain(): void {\n  kept.push(new Uint8Array(64 * 1024 * 1024).fill(1))\n}\n',
    'target.ts': 'import {retain} from \'./retain\'\nexport function target(value: number): number {\n  retain()\n  const result = value\n  console.assert(result >= 0)\n  return result\n}\n',
  }, 'target.ts', {limits: {rssKb: 300 * 1024}})
  expect(json.status.killed).toBe('RSS')
  expect(sweepWarnings(report.findings).map((finding) => finding.message)).toEqual(['sweep of target.ts stopped: RSS'])
  // The child checks its own RSS after each call, so it stops at most one call's 64 MB past the limit.
  expect(json.timing.run!.peakRssKb).toBeGreaterThan(300 * 1024)
  expect(json.timing.run!.peakRssKb).toBeLessThanOrEqual((300 + 64 + 16) * 1024)
}, 30_000)

test('verification: an input whose imported callee loops forever without ticks in the verification child times out, and nothing prints', async () => {
  const {report, json} = await sweepInProcess({
    // The loop runs only in the verification child, whose job file is verify.json, so the run child records a firing first.
    'spin.ts': `declare const process: {argv: string[]}
export function spinInVerification(): void {
  if (process.argv.some((argument) => argument.endsWith('verify.json'))) while (true) {}
}
`,
    'target.ts': `import {spinInVerification} from './spin'
export function target(value: number): number {
  const result = value
  console.assert(result >= 0)
  spinInVerification()
  return result
}
`,
  }, 'target.ts', {limits: {verifyMs: 2000, inputsPerEntry: 200}})
  expect(siteAt(json, 4)).toMatchObject({outcome: 'unverified', why: 'timed out', action: null})
  expect(sweepWarnings(report.findings)).toEqual([])
  expect(json.caps['verificationTimedOut']).toBe(1)
}, 30_000)

// -- Domain rules ------------------------------------------------------------------------

const weightedMean = `export function blend(weights: number[], values: number[]): number {
  console.assert(values.length === weights.length)
  for (const weight of weights) console.assert(weight >= 0)
  let weightSeen = 0
  let mixed = 0
  for (let index = values.length - 1; index >= 0; index -= 1) {
    weightSeen += weights[index]!
    console.assert(weightSeen >= 0)
    mixed += weights[index]! * values[index]!
  }
  return weightSeen === 0 ? 0 : mixed / weightSeen
}
`

test('F1 and F2: a loop-scoped precondition discards, and a length tie draws equal lengths', async () => {
  const withFilters = await sweepInProcess({'blend.ts': weightedMean}, 'blend.ts', {limits: {inputsPerEntry: 2000}})
  const entry = withFilters.json.entries[0]!
  expect(entry.discardSites).toEqual([{line: 2, cause: 'leading'}, {line: 3, cause: 'F1'}])
  // F2: no input violates the tie, so the leading assert never discards.
  expect(entry.discards.leading).toBe(0)
  expect(entry.discards.F1).toBeGreaterThan(0)
  expect(siteAt(withFilters.json, 3).outcome).toBe('precondition')
  expect(siteAt(withFilters.json, 8)).toMatchObject({level3: 0, action: null})
  expect(['held', 'starved']).toContain(siteAt(withFilters.json, 8).outcome)

  const base = await sweepInProcess({'blend.ts': weightedMean}, 'blend.ts', {limits: {inputsPerEntry: 2000}, filters: 'base'})
  const baseEntry = base.json.entries[0]!
  expect(baseEntry.discardSites).toEqual([{line: 2, cause: 'leading'}])
  expect(baseEntry.discards.leading).toBeGreaterThan(0)
  expect(['counterexample', 'unverified']).toContain(siteAt(base.json, 8).outcome)
}, 60_000)

test('F3: a direct element read makes a callee requirement a discard, a derived argument does not', async () => {
  const {report, json} = await sweepInProcess({'pack.ts': `type Size = {width: number; height: number}
function placeItem(itemWidth: number, itemHeight: number): number {
  console.assert(itemWidth >= 0)
  console.assert(itemHeight >= 0)
  return itemWidth + itemHeight
}
export function packRows(sizes: Size[]): number {
  let total = 0
  for (let position = 0; position < sizes.length; position++) {
    const box = sizes[position]!
    total += placeItem(box.width, box.height)
  }
  return total
}
export function packScaled(sizes: Size[]): number {
  let total = 0
  for (const size of sizes) total += placeItem(size.width * 3, size.height)
  return total
}
`}, 'pack.ts', {limits: {inputsPerEntry: 1000}})
  expect(json.entries.find((entry) => entry.name === 'packRows')!.discardSites).toEqual([{line: 3, cause: 'F3'}, {line: 4, cause: 'F3'}])
  expect(json.entries.find((entry) => entry.name === 'packScaled')!.discardSites).toEqual([{line: 4, cause: 'F3'}])
  const warnings = sweepWarnings(report.findings)
  expect(warnings.map((finding) => [finding.line, finding.message])).toEqual([[17, 'call to placeItem failed its leading console.assert on a generated input in packScaled: itemWidth >= 0']])
}, 30_000)

test('R1: a failing console.assert of an imported module drops the call from N and firings', async () => {
  const {json} = await sweepInProcess({
    'helper.ts': `export function checkedHalf(value: number): number {
  console.assert(value >= 0)
  return value / 2
}
`,
    'use-half.ts': `import {checkedHalf} from './helper'
export function useHalf(value: number): number {
  const half = checkedHalf(value)
  console.assert(half >= 0)
  return half
}
`,
  }, 'use-half.ts', {limits: {inputsPerEntry: 1000}})
  const entry = json.entries[0]!
  expect(entry.discards.R1).toBeGreaterThan(0)
  expect(entry.inDomain + entry.discards.R1).toBe(1000)
  expect(siteAt(json, 4)).toMatchObject({outcome: 'starved', level3: 0})
}, 30_000)

test('a browser global at call time counts as threw and is never a counterexample', async () => {
  const {report, json} = await sweepInProcess({'viewport.ts': `export function viewportWidth(margin: number): number {
  const width = window.innerWidth - margin
  console.assert(width >= 0)
  return width
}
`}, 'viewport.ts', {limits: {inputsPerEntry: 100}})
  expect(json.entries[0]).toMatchObject({threw: 100, inDomain: 0})
  expect(siteAt(json, 3).outcome).toBe('not-reached')
  expect(sweepWarnings(report.findings).map((finding) => finding.message)).toEqual(['sweep of viewport.ts: every generated call of viewportWidth that was not discarded threw: ReferenceError: window is not defined'])
}, 30_000)

// -- Precedence against the static verdict -------------------------------------------------

const precedenceSource = `function needs(width: number): number {
  console.assert(width >= 0)
  return width
}

export function planted(value: number): number {
  console.assert(value >= 0)
  const lowered = value - 1
  console.assert(lowered >= 0)
  return lowered
}

export function refuted(value: number): number {
  const positive = Math.max(1, value)
  console.assert(positive < 0)
  return positive
}

export function propagated(width: number): number {
  console.assert(width >= -10)
  return needs(width - 5)
}

export function badCall(): number {
  return needs(-1)
}

export function unsupportedCaller(width: number): number {
  const total = [width].reduce((sum, item) => sum + item, 0)
  return needs(total - 1)
}
`

test('planted false proof: a verified firing on a proven site is an internal error with the input', async () => {
  const {report, json} = await sweepInProcess({'precedence.ts': precedenceSource}, 'precedence.ts', {
    limits: {inputsPerEntry: 200},
    verdict: (site, real) => site.line === 9 ? 'proven' : real,
  })
  expect(report.soundnessError).toBe(true)
  const internal = report.findings.filter((finding) => finding.rule === 'internal')
  expect(internal.map((finding) => [finding.line, finding.message, finding.details])).toEqual([[9, 'soundness violation: console.assert proved in planted can fail: lowered >= 0', ['  input: planted(0)']]])
  expect(siteAt(json, 9).action).toBe('internal')
}, 30_000)

test('precedence rows: refuted is JSON only, unproven warns, a propagated or statically flagged requirement warns at the call', async () => {
  const {report, json} = await sweepInProcess({'precedence.ts': precedenceSource}, 'precedence.ts', {limits: {inputsPerEntry: 200}})
  expect(report.soundnessError).toBe(false)
  expect(siteAt(json, 15)).toMatchObject({staticVerdict: 'refuted', outcome: 'counterexample', action: 'json only'})
  expect(siteAt(json, 9)).toMatchObject({staticVerdict: 'unproven', action: 'warning'})
  const warnings = sweepWarnings(report.findings).map((finding) => [finding.line, finding.message])
  expect(warnings).toContainEqual([9, 'console.assert condition failed on a generated input in planted: lowered >= 0'])
  expect(warnings).not.toContainEqual(expect.arrayContaining([15]))
  // The requirement site pools over propagated, badCall and unsupportedCaller; its first verified input comes from the
  // first entry in source order that fires it.
  const requirement = siteAt(json, 2)
  expect(requirement.action).toBe('call-site warning')
  expect(requirement.first!.entry).toBe('propagated')
  expect(requirement.why).toBe('propagated has an inferred precondition from line 2 that generated inputs are not checked against')
  expect(warnings).toContainEqual([21, 'call to needs failed its leading console.assert on a generated input in propagated: width >= 0'])
}, 30_000)

test('precedence rows: a call with a static finding and a call in an unlowered caller warn', async () => {
  const onlyBadCall = precedenceSource.replace(/export function propagated[\s\S]*?\n}\n/, '')
  const bad = await sweepInProcess({'precedence.ts': onlyBadCall}, 'precedence.ts', {limits: {inputsPerEntry: 50}})
  expect(siteAt(bad.json, 2)).toMatchObject({action: 'call-site warning', why: 'Freerange reports a finding at this call', callLine: 21})
  const onlyUnsupported = onlyBadCall.replace(/export function badCall[\s\S]*?\n}\n/, '')
  const unsupported = await sweepInProcess({'precedence.ts': onlyUnsupported}, 'precedence.ts', {limits: {inputsPerEntry: 200}})
  expect(siteAt(unsupported.json, 2)).toMatchObject({action: 'call-site warning', why: 'unsupportedCaller was not fully analyzed'})
}, 30_000)

test('precedence rows: a discharged requirement of a lowered callee is an internal error, and a reached unreachable assert is too', async () => {
  const onlyPropagated = precedenceSource.replace(/export function badCall[\s\S]*$/, '')
  const discharged = await sweepInProcess({'precedence.ts': onlyPropagated}, 'precedence.ts', {
    limits: {inputsPerEntry: 200},
    // Planted: Freerange claims the call satisfies needs' requirement, i.e. propagated has no inferred precondition from it.
    mutate: (detailed) => {
      for (const fn of detailed.analysis.functions) if (fn.kind === 'analyzed' && fn.lowering.name === 'propagated') fn.preconditions = fn.preconditions.filter((precondition) => precondition.kind === 'declaredNumberCheck')
    },
  })
  expect(discharged.report.findings.filter((finding) => finding.rule === 'internal').map((finding) => [finding.line, finding.message])).toEqual([[21, 'soundness violation: requirement of needs proved at this call can fail']])
  // The same planted claim resting on an assumption, e.g. a divisor assumed nonzero, is conditional: a call-site warning.
  const assumed = await sweepInProcess({'precedence.ts': onlyPropagated}, 'precedence.ts', {
    limits: {inputsPerEntry: 200},
    mutate: (detailed) => {
      for (const fn of detailed.analysis.functions) {
        if (fn.kind !== 'analyzed' || fn.lowering.name !== 'propagated') continue
        fn.preconditions = fn.preconditions.filter((precondition) => precondition.kind === 'declaredNumberCheck')
        fn.boundsAssumptions = [{site: 0, kind: 'nonzeroDivisor'}]
      }
    },
  })
  expect(assumed.report.soundnessError).toBe(false)
  expect(siteAt(assumed.json, 2).action).toBe('call-site warning')
  expect(siteAt(assumed.json, 2).why).toStartWith('propagated assumes a nonzero divisor at line')
  const dead = await sweepInProcess({'precedence.ts': onlyPropagated}, 'precedence.ts', {limits: {inputsPerEntry: 50}, verdict: (site, real) => site.line === 9 ? 'dead' : real})
  expect(dead.report.findings.filter((finding) => finding.rule === 'internal').map((finding) => [finding.line, finding.message])).toEqual([[9, 'unreachable assert was reached']])
}, 30_000)

test('precedence rows: a static finding at a call counts only for the callee it names, not for a callee whose name is a prefix of it', async () => {
  const onlyPropagated = precedenceSource.replace(/export function badCall[\s\S]*$/, '')
  const {report, json} = await sweepInProcess({'precedence.ts': onlyPropagated}, 'precedence.ts', {
    limits: {inputsPerEntry: 200},
    mutate: (detailed) => {
      for (const fn of detailed.analysis.functions) if (fn.kind === 'analyzed' && fn.lowering.name === 'propagated') fn.preconditions = fn.preconditions.filter((precondition) => precondition.kind === 'declaredNumberCheck')
    },
    // Planted: a finding at the call line of needs about another callee, needsMore, whose message contains `needs`.
    staticFindings: (real) => [...real, {line: 21, message: 'call to needsMore makes its declared requirement definitely false', callee: 'needsMore'}],
  })
  expect(siteAt(json, 2)).toMatchObject({action: 'internal', why: null})
  expect(report.findings.filter((finding) => finding.rule === 'internal').map((finding) => [finding.line, finding.message])).toEqual([[21, 'soundness violation: requirement of needs proved at this call can fail']])
}, 30_000)

// -- CLI -----------------------------------------------------------------------------------------

const freerangeCli = new URL('../fr.ts', import.meta.url).pathname

function runCli(cwd: string, env: Record<string, string>, ...arguments_: string[]) {
  const started = performance.now()
  const result = Bun.spawnSync({cmd: [process.execPath, freerangeCli, ...arguments_], cwd, env: {...process.env, ...env}, stdout: 'pipe', stderr: 'pipe'})
  return {exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), ms: performance.now() - started}
}

function withProject(files: Record<string, string>, body: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-sweep-cli-'))
  try {
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: true, target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler'}, include: ['**/*.ts']}))
    writeFiles(directory, files)
    body(directory)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
}

const smokeSource = `export function unproven(value: number): number {
  const result = value
  console.assert(result >= 0)
  return result
}

export function proven(value: number): number {
  const bounded = Math.max(0, value)
  console.assert(bounded >= 0)
  return bounded
}

function needsNonnegative(width: number): number {
  console.assert(width >= 0)
  return width
}

export function caller(width: number): number {
  console.assert(width >= -10)
  return needsNonnegative(width - 5)
}
`

test('fr <file> under FREERANGE_SWEEP prints the exact counterexample text and keeps the exit code', () => {
  withProject({'smoke.ts': smokeSource}, (directory) => {
    const off = runCli(directory, {}, 'smoke.ts')
    expect(off.exitCode).toBe(1)
    expect(off.stdout).toBe(`smoke.ts(3,3): error [console-assert]: could not prove console.assert condition in unproven: result >= 0

1 finding (1 error, 0 warnings).
coverage: 4/4 named top-level functions fully analyzed; 0 partially supported; 0 unsupported.
Run \`fr --audit [file]\` for every function's contracts and refactoring suggestions.
`)
    const on = runCli(directory, {FREERANGE_SWEEP: '1', FREERANGE_SWEEP_JSON: join(directory, 'smoke.json')}, 'smoke.ts')
    expect(on.exitCode).toBe(1)
    expect(on.stderr).toBe('')
    expect(on.stdout).toBe(`smoke.ts(3,3): error [console-assert]: could not prove console.assert condition in unproven: result >= 0
smoke.ts(3,3): warning [console-assert-sweep]: console.assert condition failed on a generated input in unproven: result >= 0
  input: unproven(-999998)
  fix unproven if a caller can pass this input; otherwise say when the property holds: add a leading console.assert to unproven that rules this input out, or guard this assert with the condition it needs
  domain: 100000 of 100000 generated inputs reached this assert in the domain; numbers no assert bounds are drawn from [-1e6, 1e6]; largest |number| in this input: 999998
smoke.ts(20,10): warning [console-assert-sweep]: call to needsNonnegative failed its leading console.assert on a generated input in caller: width >= 0
  input: caller(1)
  fix caller if a caller of caller can pass this input; otherwise add a leading console.assert to caller that rules it out

3 findings (1 error, 2 warnings).
coverage: 4/4 named top-level functions fully analyzed; 0 partially supported; 0 unsupported.
sweep: 4 of 4 functions run; 1 asserts held on at least 1,000 generated inputs; 2 counterexamples; 0 functions not run
Run \`fr --audit [file]\` for every function's contracts and refactoring suggestions.
`)
    const json = JSON.parse(readFileSync(join(directory, 'smoke.json'), 'utf8')) as SweepJson
    expect(siteAt(json, 9)).toMatchObject({staticVerdict: 'proven', outcome: 'held', n: 100000})
    const errorLevel = runCli(directory, {FREERANGE_SWEEP: 'error'}, 'smoke.ts')
    expect(errorLevel.exitCode).toBe(1)
    expect(errorLevel.stdout).toContain('smoke.ts(3,3): error [console-assert-sweep]: console.assert condition failed')
    // Only 1 and error turn the sweep on. Any other value, e.g. 0 set to turn it off, runs origin/main's code path.
    for (const value of ['0', 'true', 'eror']) {
      const other = runCli(directory, {FREERANGE_SWEEP: value}, 'smoke.ts')
      expect({value, exitCode: other.exitCode, stdout: other.stdout, stderr: other.stderr}).toEqual({value, exitCode: off.exitCode, stdout: off.stdout, stderr: off.stderr})
    }
  })
}, 60_000)

test('a bundled fr has no child.ts beside it: the sweep is not run and says why, and static findings print', () => {
  withProject({'smoke.ts': smokeSource}, (directory) => {
    const build = mkdtempSync(join(tmpdir(), 'freerange-sweep-build-'))
    try {
      const bundle = join(build, 'fr.js')
      const built = Bun.spawnSync({cmd: [process.execPath, 'build', freerangeCli, '--target=node', '--packages=external', `--outfile=${bundle}`], stdout: 'pipe', stderr: 'pipe'})
      expect(built.exitCode).toBe(0)
      symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(build, 'node_modules'))
      const off = Bun.spawnSync({cmd: [process.execPath, bundle, 'smoke.ts'], cwd: directory, env: {...process.env, FREERANGE_SWEEP: ''}, stdout: 'pipe', stderr: 'pipe'})
      const on = Bun.spawnSync({cmd: [process.execPath, bundle, 'smoke.ts'], cwd: directory, env: {...process.env, FREERANGE_SWEEP: '1'}, stdout: 'pipe', stderr: 'pipe'})
      expect(on.exitCode).toBe(off.exitCode)
      const lines = on.stdout.toString().split('\n')
      expect(lines.filter((line) => line.includes('[console-assert-sweep]'))).toEqual(['smoke.ts(1,1): warning [console-assert-sweep]: sweep of smoke.ts not run: FREERANGE_SWEEP runs only from fr\'s TypeScript source under Bun, e.g. `bun fr.ts <file>`'])
      expect(lines.filter((line) => line.includes('[console-assert]'))).toEqual(off.stdout.toString().split('\n').filter((line) => line.includes('[console-assert]')))
    } finally {
      rmSync(build, {recursive: true, force: true})
    }
  })
}, 60_000)

test('pipe waits: a child whose stdout nobody reads gives up after its wait cap instead of waiting forever', async () => {
  const pipeModule = new URL('../src/sweep/pipe.ts', import.meta.url).pathname
  // Touching process.stdout makes Bun switch fd 1 to non-blocking, as in the sweep child, so a full pipe throws EAGAIN.
  const script = `import {writeSync} from 'node:fs'
import {writeAll} from ${JSON.stringify(pipeModule)}
void process.stdout.write
try {
  writeAll(1, new Uint8Array(8 * 1024 * 1024), 20)
  writeSync(2, 'wrote all')
} catch (error) {
  writeSync(2, 'gave up: ' + error.code)
  process.exit(7)
}
`
  const child = spawn(process.execPath, ['-e', script], {stdio: ['ignore', 'pipe', 'pipe']})
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => {
    stderr += text
  })
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))
  await new Promise((resolve) => setTimeout(resolve, 50))
  child.stdout.destroy()
  expect(exitCode).toBe(7)
  expect(stderr).toBe('gave up: EAGAIN')
}, 30_000)

// -- Survival fixtures: the parent survives the child hanging, throwing and allocating without bound -----------------

type Survival = {name: string; files: Record<string, string>; limits: Partial<SweepLimits>; warning: string; limitMs: number}

const survivalEntry = (call: string) => `import {${call}} from './helper'
export function sweepTarget(value: number): number {
  ${call}()
  const result = value
  console.assert(result >= 0)
  return result
}
`

export const SURVIVAL_FIXTURES: Survival[] = [
  {name: 'a call hangs in an imported module', files: {'helper.ts': 'export function hang(): void {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)\n}\n', 'target.ts': survivalEntry('hang')}, limits: {heartbeatMs: 1000}, warning: 'sweep of target.ts stopped: heartbeat', limitMs: 1000},
  {name: 'module initialization hangs', files: {'helper.ts': 'await new Promise(() => {})\nexport function spin(): void {}\n', 'target.ts': survivalEntry('spin')}, limits: {loadMs: 1500}, warning: 'could not load target.ts for a sweep: the module did not finish loading within 1.5 s', limitMs: 1500},
  {name: 'module initialization throws', files: {'helper.ts': 'throw new Error(\'boom at load\')\nexport function spin(): void {}\n', 'target.ts': survivalEntry('spin')}, limits: {}, warning: 'could not load target.ts for a sweep: Error: boom at load', limitMs: 20_000},
  {name: 'every call throws', files: {'helper.ts': 'export function fail(): void {\n  throw new Error(\'always\')\n}\n', 'target.ts': survivalEntry('fail')}, limits: {inputsPerEntry: 1000}, warning: 'sweep of target.ts: every generated call of sweepTarget that was not discarded threw: Error: always', limitMs: 120_000},
  {name: 'a call runs process.exit(3)', files: {'helper.ts': 'declare const process: {exit(code: number): never}\nexport function quit(): void {\n  process.exit(3)\n}\n', 'target.ts': survivalEntry('quit')}, limits: {}, warning: 'sweep of target.ts stopped: the child exited with code 3 before it finished', limitMs: 120_000},
  {name: 'allocation without bound', files: {'helper.ts': 'const kept: Uint8Array[] = []\nexport function retain(): void {\n  kept.push(new Uint8Array(64 * 1024 * 1024).fill(1))\n}\n', 'target.ts': survivalEntry('retain')}, limits: {rssKb: 300 * 1024}, warning: 'sweep of target.ts stopped: RSS', limitMs: 120_000},
  {name: 'a stdout flood', files: {'helper.ts': 'declare const process: {stdout: {write(text: string): boolean}}\nconst megabyte = \'x\'.repeat(1024 * 1024)\nexport function flood(): void {\n  process.stdout.write(megabyte)\n}\n', 'target.ts': survivalEntry('flood')}, limits: {}, warning: 'sweep of target.ts stopped: output cap', limitMs: 120_000},
]

for (const fixture of SURVIVAL_FIXTURES) {
  test(`survival: ${fixture.name}`, () => {
    withProject(fixture.files, (directory) => {
      const off = runCli(directory, {}, 'target.ts')
      const jsonPath = join(directory, 'target.json')
      const on = runCli(directory, {FREERANGE_SWEEP: '1', FREERANGE_SWEEP_JSON: jsonPath, FREERANGE_SWEEP_LIMITS: JSON.stringify(fixture.limits)}, 'target.ts')
      expect(on.exitCode).toBe(off.exitCode)
      const staticLines = (stdout: string) => stdout.split('\n').filter((line) => /: (error|warning) \[/.test(line) && !line.includes('[console-assert-sweep]'))
      expect(staticLines(on.stdout)).toEqual(staticLines(off.stdout))
      const sweepLines = on.stdout.split('\n').filter((line) => line.includes('[console-assert-sweep]'))
      expect(sweepLines).toHaveLength(1)
      expect(sweepLines[0]).toEndWith(fixture.warning)
      const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as SweepJson
      if (json.timing.run != null) {
        expect(json.timing.run.ms).toBeLessThanOrEqual(fixture.limitMs + 1000)
        expect(json.timing.run.peakRssKb).toBeGreaterThan(0)
      }
      const leftover = Bun.spawnSync({cmd: ['pgrep', '-f', `${directory}`], stdout: 'pipe'}).stdout.toString().trim()
      expect(leftover).toBe('')
    })
  }, 60_000)
}

// -- Child termination and stop reporting --------------------------------------------------------------------------------

// `fr target.ts` flag off, then flag on with `limits`; the sweep lines, the sidecar and both runs. `env` applies to both runs.
function sweepCli(directory: string, limits: Partial<SweepLimits>, env: Record<string, string> = {}) {
  const off = runCli(directory, env, 'target.ts')
  const jsonPath = join(directory, 'target.json')
  const on = runCli(directory, {...env, FREERANGE_SWEEP: '1', FREERANGE_SWEEP_JSON: jsonPath, FREERANGE_SWEEP_LIMITS: JSON.stringify(limits)}, 'target.ts')
  const staticLines = (stdout: string) => stdout.split('\n').filter((line) => /: (error|warning) \[/.test(line) && !line.includes('[console-assert-sweep]'))
  expect(on.exitCode).toBe(off.exitCode)
  expect(on.stderr).toBe('')
  expect(staticLines(on.stdout)).toEqual(staticLines(off.stdout))
  const sweepLines = on.stdout.split('\n').filter((line) => line.includes('[console-assert-sweep]')).map((line) => line.slice(line.indexOf(']: ') + 3))
  return {on, sweepLines, json: JSON.parse(readFileSync(jsonPath, 'utf8')) as SweepJson}
}

const callingEntry = (call: string, module = './helper') => `import {${call}} from '${module}'
export function sweepTarget(value: number): number {
  const result = value + ${call}()
  console.assert(Number.isFinite(result))
  return result
}
`

test('a detached grandchild holding the child\'s stdout: fr stops waiting shortly after the child exits', () => {
  withProject({
    // helper.js is untyped runtime code, typed by helper.d.ts, so it can start a process freely.
    'helper.js': `import {spawn} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
const grandchild = spawn('sleep', ['30'], {detached: true, stdio: ['ignore', 'inherit', 'inherit']})
writeFileSync(join(import.meta.dir, 'grandchild.pid'), String(grandchild.pid))
grandchild.unref()
export function noop() { return 0 }
`,
    'helper.d.ts': 'export declare function noop(): number\n',
    'target.ts': callingEntry('noop', './helper.js'),
  }, (directory) => {
    const pidPath = join(directory, 'grandchild.pid')
    try {
      const {on, sweepLines, json} = sweepCli(directory, {hardMs: 5000})
      expect(json.status.killed).toBeNull()
      expect(json.entries.map((entry) => entry.status)).toEqual(['run'])
      expect(sweepLines).toEqual(['sweep of target.ts: a process started by project code kept the child\'s output open after the child exited; fr stopped waiting for it after 0.5 s'])
      expect(on.ms).toBeLessThan(4000)
    } finally {
      try {
        process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL')
      } catch {
        // The grandchild never started or already exited.
      }
    }
  })
}, 60_000)

test('a module-level setInterval: the child exits after its last entry, and nothing is reported', () => {
  withProject({'helper.ts': 'setInterval(() => {}, 1000)\nexport function noop(): number {\n  return 0\n}\n', 'target.ts': callingEntry('noop')}, (directory) => {
    const {sweepLines, json} = sweepCli(directory, {heartbeatMs: 3000})
    expect(sweepLines).toEqual([])
    expect(json.status.killed).toBeNull()
    expect(json.timing.run!.ms).toBeLessThan(3000)
  })
}, 60_000)

test('without ps on PATH the sweep stops with one warning, and the static findings print', () => {
  withProject({'helper.ts': 'export function noop(): number {\n  return 0\n}\n', 'target.ts': callingEntry('noop')}, (directory) => {
    mkdirSync(join(directory, 'bin'))
    symlinkSync(process.execPath, join(directory, 'bin', 'bun'))
    const {sweepLines, json} = sweepCli(directory, {}, {PATH: join(directory, 'bin')})
    expect(json.status.killed).toBe('RSS poller')
    expect(sweepLines).toHaveLength(1)
    expect(sweepLines[0]).toStartWith('sweep of target.ts stopped: RSS poller: ps could not run: ')
  })
}, 60_000)

test('a ps that never answers: the sweep stops at the ps wait limit, and the ps process is killed', () => {
  // Module initialization waits 3 s, so the child is still running when the 1 s ps wait limit passes.
  withProject({'helper.ts': 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)\nexport function noop(): number {\n  return 0\n}\n', 'target.ts': callingEntry('noop')}, (directory) => {
    mkdirSync(join(directory, 'bin'))
    writeFileSync(join(directory, 'bin', 'ps'), '#!/bin/sh\nexec /bin/sleep 61.25\n')
    chmodSync(join(directory, 'bin', 'ps'), 0o755)
    const {on, sweepLines, json} = sweepCli(directory, {psMs: 1000}, {PATH: `${join(directory, 'bin')}:/usr/bin:/bin`})
    expect(json.status.killed).toBe('RSS poller')
    expect(sweepLines).toEqual(['sweep of target.ts stopped: RSS poller: ps did not report within 1 s'])
    expect(on.ms).toBeLessThan(6000)
    expect(Bun.spawnSync({cmd: ['pgrep', '-f', 'sleep 61.25'], stdout: 'pipe'}).stdout.toString().trim()).toBe('')
  })
}, 60_000)

test('the RSS limit during module loading: the load warning names the stop', () => {
  withProject({
    'helper.ts': 'const kept: Uint8Array[] = []\nfor (let index = 0; index < 8; index++) kept.push(new Uint8Array(64 * 1024 * 1024).fill(1))\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)\nexport function noop(): number {\n  return kept.length * 0\n}\n',
    'target.ts': callingEntry('noop'),
  }, (directory) => {
    const {sweepLines, json} = sweepCli(directory, {rssKb: 300 * 1024})
    expect(json.status.killed).toBe('RSS')
    expect(json.entries.map((entry) => entry.status)).toEqual(['load-failed'])
    expect(sweepLines).toEqual(['could not load target.ts for a sweep: the child was stopped while loading: RSS'])
    expect(json.timing.run!.ms).toBeLessThan(10_000)
  })
}, 60_000)

test('a thrown value that String() cannot convert: the child keeps running and the warning says what was thrown', () => {
  withProject({'helper.ts': 'export function fail(): number {\n  throw Object.create(null)\n}\n', 'target.ts': callingEntry('fail')}, (directory) => {
    const {sweepLines, json} = sweepCli(directory, {inputsPerEntry: 1000})
    expect(json.entries.map((entry) => [entry.status, entry.threw])).toEqual([['run', 1000]])
    expect(sweepLines).toEqual(['sweep of target.ts: every generated call of sweepTarget that was not discarded threw: a value that String() cannot convert'])
  })
}, 60_000)

test('the child\'s own code fails after project code replaces a global it uses: the stop warning carries the error', () => {
  withProject({
    'helper.ts': 'export function replaceImul(): number {\n  Math.imul = () => {\n    throw new Error(\'Math.imul replaced\')\n  }\n  return 0\n}\n',
    'target.ts': callingEntry('replaceImul'),
  }, (directory) => {
    const {sweepLines, json} = sweepCli(directory, {inputsPerEntry: 1000})
    expect(json.status).toMatchObject({killed: null, exitCode: 1})
    expect(sweepLines).toEqual(['sweep of target.ts stopped: the child exited with code 1 before it finished: Error: Math.imul replaced'])
  })
}, 60_000)
