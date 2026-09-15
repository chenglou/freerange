// FREERANGE_SWEEP: one test per cap of the registration's cap table, one per domain rule (D0 leading discards, F1, F2, F3,
// R1, browser globals), the precedence rows with planted static verdicts, the CLI text and exit codes, and the seven
// survival fixtures. Rule and cap tests call the sweep in-process with small limits; CLI tests spawn `fr` like
// project-report.test.ts.
import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {analyzeCheckedSource, type DetailedAnalysis} from '../src/analyze.ts'
import {collectLintFindings} from '../src/project.ts'
import {requirementFor, staticVerdictLookup, sweepReport, type StaticVerdict, type SweepFinding} from '../src/sweep/report.ts'
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

type InProcessOptions = {limits?: Partial<SweepLimits>; filters?: 'base' | 'default'; verdict?: (site: Site, real: StaticVerdict) => StaticVerdict; mutate?: (detailed: DetailedAnalysis) => void}

async function sweepInProcess(files: Record<string, string>, target: string, options: InProcessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-sweep-test-'))
  try {
    writeFiles(directory, files)
    const path = join(directory, target)
    const checked = checkFile(path)
    const detailed = analyzeCheckedSource(checked, directory)
    const staticFindings = collectLintFindings(detailed).map((finding) => ({line: finding.line, message: finding.kind === 'error' ? finding.message : ''}))
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

// -- Domain rules ------------------------------------------------------------------------

const shrinkRow = `export function shrink(minimums: number[], naturals: number[]): number {
  console.assert(minimums.length === naturals.length)
  for (let index = 0; index < minimums.length; index++) console.assert(minimums[index]! <= naturals[index]! + 1e-6)
  let total = 0
  for (let index = 0; index < minimums.length; index++) {
    const gap = naturals[index]! - minimums[index]!
    console.assert(gap >= -1e-6)
    total += gap
  }
  return total
}
`

test('F1 and F2: a loop-scoped precondition discards, and a length tie draws equal lengths', async () => {
  const withFilters = await sweepInProcess({'shrink.ts': shrinkRow}, 'shrink.ts', {limits: {inputsPerEntry: 2000}})
  const entry = withFilters.json.entries[0]!
  expect(entry.discardSites).toEqual([{line: 2, cause: 'leading'}, {line: 3, cause: 'F1'}])
  // F2: no input violates the tie, so the leading assert never discards.
  expect(entry.discards.leading).toBe(0)
  expect(entry.discards.F1).toBeGreaterThan(0)
  expect(siteAt(withFilters.json, 3).outcome).toBe('precondition')
  expect(siteAt(withFilters.json, 7)).toMatchObject({level3: 0, action: null})
  expect(['held', 'starved']).toContain(siteAt(withFilters.json, 7).outcome)

  const base = await sweepInProcess({'shrink.ts': shrinkRow}, 'shrink.ts', {limits: {inputsPerEntry: 2000}, filters: 'base'})
  const baseEntry = base.json.entries[0]!
  expect(baseEntry.discardSites).toEqual([{line: 2, cause: 'leading'}])
  expect(baseEntry.discards.leading).toBeGreaterThan(0)
  expect(['counterexample', 'unverified']).toContain(siteAt(base.json, 7).outcome)
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
  for (let index = 0; index < sizes.length; index++) {
    const size = sizes[index]!
    total += placeItem(size.width, size.height)
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
  expect(report.internalError).toBe(true)
  const internal = report.findings.filter((finding) => finding.rule === 'internal')
  expect(internal.map((finding) => [finding.line, finding.message, finding.details])).toEqual([[9, 'soundness violation: console.assert proved in planted can fail: lowered >= 0', ['  input: planted(0)']]])
  expect(siteAt(json, 9).action).toBe('internal')
}, 30_000)

test('precedence rows: refuted is JSON only, unproven warns, a propagated or statically flagged requirement warns at the call', async () => {
  const {report, json} = await sweepInProcess({'precedence.ts': precedenceSource}, 'precedence.ts', {limits: {inputsPerEntry: 200}})
  expect(report.internalError).toBe(false)
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
  const dead = await sweepInProcess({'precedence.ts': onlyPropagated}, 'precedence.ts', {limits: {inputsPerEntry: 50}, verdict: (site, real) => site.line === 9 ? 'dead' : real})
  expect(dead.report.findings.filter((finding) => finding.rule === 'internal').map((finding) => [finding.line, finding.message])).toEqual([[9, 'unreachable assert was reached']])
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
    const bad = runCli(directory, {FREERANGE_SWEEP: 'yes'}, 'smoke.ts')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('FREERANGE_SWEEP must be 1 or error, not yes')
  })
}, 60_000)

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
