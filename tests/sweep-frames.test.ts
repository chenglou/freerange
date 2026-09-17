// FREERANGE_SWEEP_FRAMES: frame-driver recognition (D1-D4 and the threaded state), the JSON listing, and that the flag
// changes nothing for a file without a driver. Fixtures in tests/fixtures/frames are the dev set: each correct/buggy pair
// differs only in app code.
import {expect, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {analyzeCheckedSource} from '../src/analyze.ts'
import {sweepStaticFindings} from '../src/project.ts'
import {sweepEntries, type FrameRecognition} from '../src/sweep/analyze.ts'
import {decodeJson} from '../src/sweep/encode.ts'
import {instrumentSource} from '../src/sweep/instrument.ts'
import {compileLattice, inputAt} from '../src/sweep/lattice.ts'
import {requirementFor, staticVerdictLookup, sweepReport} from '../src/sweep/report.ts'
import {DEFAULT_LIMITS, sweepEntryFor, sweepFile, type SweepLimits} from '../src/sweep/run.ts'
import {checkFile, checkSource} from '../src/typescript/check.ts'

const fixture = (name: string) => new URL(`./fixtures/frames/${name}`, import.meta.url).pathname

function recognitionOf(path: string, source: string | null, name: string): FrameRecognition | null {
  const checked = source == null ? checkFile(path) : checkSource(path, source)
  const entry = sweepEntries(checked.program, checked.sourceFile, 'default', true).find((candidate) => candidate.name === name)
  if (entry == null) throw new Error(`no function ${name}`)
  return entry.frames
}

type EntryJson = {name: string; frames?: unknown; framesRejected?: string}
type SweepJson = {settings: {limits: Record<string, number>; frames?: boolean}; entries: EntryJson[]; sites: unknown[]}

async function sweepInProcess(files: Record<string, string>, target: string, frames: boolean, limits: Partial<SweepLimits> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-frames-test-'))
  try {
    for (const [file, source] of Object.entries(files)) writeFileSync(join(directory, file), source)
    const path = join(directory, target)
    const checked = checkFile(path)
    const detailed = analyzeCheckedSource(checked, directory)
    const staticFindings = sweepStaticFindings(detailed)
    const verdictOf = staticVerdictLookup(detailed, staticFindings)
    const settings = {filters: 'default' as const, cap: 1e6, limits: {...DEFAULT_LIMITS, ...limits}, frames}
    const run = await sweepFile(path, target, checked.sourceFile, checked.program, settings, (site) => requirementFor(verdictOf(site)))
    const report = sweepReport({run, verdictOf, detailed, staticFindings, sourceFile: checked.sourceFile, settings, level: 'warning', reportFile: target})
    return {report, json: report.json as SweepJson}
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
}

// -- Recognition ---------------------------------------------------------------------------

test('the dev drivers are recognized, with their loop line and threaded state', () => {
  expect(recognitionOf(fixture('queue_bug.ts'), null, 'queueFrames')).toMatchObject({kind: 'driver', driver: {
    eventsIndex: 0, eventsParameter: 'events', eventVariable: 'event', loopLine: 31, stepStatements: 1, step: {name: 'stepQueue', state: 'queue', line: 34},
  }})
  expect(recognitionOf(fixture('camera_bug.ts'), null, 'cameraFrames')).toMatchObject({kind: 'driver', driver: {eventsIndex: 1, loopLine: 54, step: {name: 'stepCamera', state: 'camera', line: 55}}})
  expect(recognitionOf(fixture('editor_bug.ts'), null, 'editorFrames')).toMatchObject({kind: 'driver', driver: {eventsIndex: 3, loopLine: 63, step: {name: 'stepEditor', state: 'editor', line: 69}}})
  expect(recognitionOf(fixture('chart_bug.ts'), null, 'chartFrames')).toMatchObject({kind: 'driver', driver: {eventsIndex: 2, loopLine: 63, step: {name: 'stepChart', state: 'chart', line: 65}}})
  // A step function is an ordinary entry: its last parameter isn't an array.
  expect(recognitionOf(fixture('queue_bug.ts'), null, 'stepQueue')).toBeNull()
})

const tickTypes = `type Tick = {kind: 'tick'; amount: number} | {kind: 'idle'}
function stepCount(total: number, event: Tick): number {
  return event.kind === 'tick' ? total + event.amount : total
}
function countTicks(ticks: Tick[]): number {
  return ticks.length
}
`
const countFrames = (body: string) => `${tickTypes}export function countFrames(events: Tick[]): number {
  let total = 0
${body}
  return total
}
`
const standardLoop = '  for (const event of events) {\n    total = stepCount(total, event)\n  }'

test('a driver without a block loop body, or with guards and end statements, is recognized', () => {
  const path = join(tmpdir(), 'count.ts')
  expect(recognitionOf(path, countFrames('  for (const event of events) total = stepCount(total, event)'), 'countFrames')).toMatchObject({kind: 'driver', driver: {loopLine: 10, step: {name: 'stepCount', state: 'total', line: 10}}})
  expect(recognitionOf(path, countFrames(`  console.assert(total === 0)\n  const start = total\n${standardLoop.replace('{\n', '{\n    if (event.kind === \'idle\' && total === 0) continue\n')}\n  console.assert(total >= start)`), 'countFrames')).toMatchObject({kind: 'driver', driver: {loopLine: 12, step: {line: 14}}})
})

test('S1: a function that reads its events array outside the loop, or walks it some other way, is not a driver', () => {
  const path = join(tmpdir(), 'count.ts')
  const cases: [string, string, string][] = [
    ['events.length', `  const count = events.length\n${standardLoop}\n  total += count`, 'D3: events is used outside its for...of loop at line 10'],
    ['events[i + 1]', standardLoop.replace('total = stepCount(total, event)', 'total = stepCount(total, events[total + 1] ?? event)'), 'D3: events is used outside its for...of loop at line 11'],
    ['events passed to a helper', `${standardLoop}\n  total += countTicks(events)`, 'D3: events is used outside its for...of loop at line 13'],
    ['two loops', `${standardLoop}\n${standardLoop}`, 'D2: countFrames has 2 top-level for...of loops over events, not 1'],
    ['a reassigned loop variable', standardLoop.replace('const event', 'let event').replace('{\n', '{\n    event = {kind: \'idle\'}\n'), 'D2: the loop over events must declare one const identifier, e.g. for (const event of events)'],
    ['a closure capture', `  const size = () => events.length\n${standardLoop}\n  total += size()`, 'D3: events is used outside its for...of loop at line 10'],
    ['a destructured loop variable', '  for (const {kind} of events) {\n    total = stepCount(total, {kind: \'idle\'})\n    if (kind === \'tick\') total += 1\n  }', 'D2: the loop over events must declare one const identifier, e.g. for (const event of events)'],
    ['a shorthand property', `${standardLoop}\n  const saved = {events}\n  total += saved.events.length`, 'D3: events is used outside its for...of loop at line 13'],
    ['a nested loop only', `  if (total === 0) {\n${standardLoop}\n  }`, 'D2: countFrames has 0 top-level for...of loops over events, not 1'],
    ['no call of this file in the loop', '  for (const event of events) {\n    if (event.kind === \'tick\') total += event.amount\n  }', 'D4: the loop body calls no function of this file'],
  ]
  for (const [name, body, reason] of cases) expect({name, recognition: recognitionOf(path, countFrames(body), 'countFrames')}).toEqual({name, recognition: {kind: 'rejected', reason}})
  const optional = `${tickTypes}export function countFrames(events: Tick[] = []): number {\n  let total = 0\n${standardLoop}\n  return total\n}\n`
  expect(recognitionOf(path, optional, 'countFrames')).toEqual({kind: 'rejected', reason: 'D1: events is optional'})
})

test('S1: two step statements leave the driver without a threaded state', () => {
  const path = join(tmpdir(), 'count.ts')
  const twice = standardLoop.replace('total = stepCount(total, event)', 'total = stepCount(total, event)\n    total = stepCount(total, event)')
  expect(recognitionOf(path, countFrames(twice), 'countFrames')).toMatchObject({kind: 'driver', driver: {stepStatements: 2, step: null}})
  // A step statement over a state declared inside the loop, or whose first argument isn't the state, isn't one.
  const notState = standardLoop.replace('total = stepCount(total, event)', 'total = stepCount(0, event)')
  expect(recognitionOf(path, countFrames(notState), 'countFrames')).toMatchObject({kind: 'driver', driver: {stepStatements: 0, step: null}})
})

// -- The flag ------------------------------------------------------------------------------

const noDriver = `export function clampWidth(width: number): number {
  const clamped = Math.min(Math.max(width, 0), 100)
  console.assert(clamped <= 50)
  return clamped
}
`

test('flag on: a file without a driver gets the same findings and JSON, except the listed frame limits', async () => {
  const off = await sweepInProcess({'clamp.ts': noDriver}, 'clamp.ts', false, {inputsPerEntry: 500})
  const on = await sweepInProcess({'clamp.ts': noDriver}, 'clamp.ts', true, {inputsPerEntry: 500})
  expect(on.report.findings).toEqual(off.report.findings)
  expect(on.report.summaryLine).toBe(off.report.summaryLine)
  expect(Object.keys(off.json.settings.limits)).not.toContain('maxFrames')
  expect(off.json.settings.frames).toBeUndefined()
  expect(on.json.settings).toMatchObject({frames: true, limits: {framesPerEntry: 1_000_000, sequencesPerEntry: 100_000, maxFrames: 64, redraws: 8}})
  const withoutSettings = (json: SweepJson) => ({...json, settings: null, timing: null})
  expect(withoutSettings(on.json)).toEqual(withoutSettings(off.json))
}, 30_000)

test('the JSON lists each driver and each rejected candidate only under the flag', async () => {
  const files = {'count.ts': `${countFrames(standardLoop)}export function lengthFrames(events: Tick[]): number {\n  return events.length\n}\n`}
  const off = await sweepInProcess(files, 'count.ts', false, {inputsPerEntry: 200})
  expect(off.json.entries.map((entry) => Object.keys(entry).filter((key) => key.startsWith('frames')))).toEqual([[], [], [], []])
  const on = await sweepInProcess(files, 'count.ts', true, {inputsPerEntry: 200})
  expect(on.json.entries.find((entry) => entry.name === 'countFrames')!.frames).toMatchObject({eventsParameter: 'events', loopLine: 10, stepStatements: 1, stepCall: {step: 'stepCount', state: 'total', line: 11}})
  expect(on.json.entries.find((entry) => entry.name === 'lengthFrames')!.framesRejected).toBe('D2: lengthFrames has 0 top-level for...of loops over events, not 1')
  // countTicks walks no loop either; stepCount's last parameter isn't an array.
  expect(on.json.entries.map((entry) => [entry.name, entry.frames != null, entry.framesRejected ?? null])).toEqual([
    ['stepCount', false, null], ['countTicks', false, 'D2: countTicks has 0 top-level for...of loops over ticks, not 1'], ['countFrames', true, null], ['lengthFrames', false, 'D2: lengthFrames has 0 top-level for...of loops over events, not 1'],
  ])
}, 30_000)

// -- Sequence entries ------------------------------------------------------------------------

type DriverJson = {eventsParameter: string; sequences: number; frames: number; setupDiscards: number; frameDiscards: number; endDiscards: number}
type FirstJson = {index: number; input: string; verified: boolean; frame?: number | 'end'; events?: number}
type FrameSiteJson = {line: number; outcome: string; n: number; level3: number; action: string | null; first: FirstJson | null}
type FrameEntryJson = {name: string; status: string; drawn: number; inDomain: number; overBudget: number; frames?: DriverJson}
const framesJsonOf = (json: SweepJson) => json as unknown as {entries: FrameEntryJson[]; sites: FrameSiteJson[]}

test('P1 draws every events length from 0 through maxFrames once, and no phase draws a longer sequence', () => {
  const path = fixture('queue_bug.ts')
  const checked = checkFile(path)
  const analyzed = sweepEntries(checked.program, checked.sourceFile, 'default', true).find((candidate) => candidate.name === 'queueFrames')!
  const {sites} = instrumentSource(checked.sourceFile.text, path, 'queue_bug.ts', 0, [])
  const entry = sweepEntryFor(analyzed, sites, {filters: 'default', cap: 1e6, limits: DEFAULT_LIMITS, frames: true})
  expect(entry.sequence).toMatchObject({eventsIndex: 0, framesPerEntry: 1_000_000, sequencesPerEntry: 100_000})
  const lattice = compileLattice(entry, {budget: 100_000, seed: 1, p0Inputs: 10_000, p2ProductMax: 50_000})
  // queueFrames has one parameter, so the events length is P1's first leaf: lengths 0..64 at the first 65 P1 indices.
  const p1Lengths = Array.from({length: 65}, (_, offset) => (inputAt(lattice, lattice.phases.p0 + offset).args[0] as unknown[]).length)
  expect(p1Lengths).toEqual(Array.from({length: 65}, (_, length) => length))
  const lengths = (from: number, to: number) => Array.from({length: to - from}, (_, offset) => (inputAt(lattice, from + offset).args[0] as unknown[]).length)
  expect(Math.max(...lengths(0, 2000))).toBe(2)
  expect(Math.max(...lengths(90_000, 92_000))).toBe(64)
})

const loopBudgetSource = `type Scan = {kind: 'scan'} | {kind: 'idle'}
function sumRows(total: number): number {
  let sum = total
  for (let pass = 0; pass < 4; pass++) {
    for (let row = 0; row < 64; row++) sum += 1
  }
  return sum
}
function stepScan(total: number, event: Scan): number {
  return event.kind === 'scan' ? sumRows(total) : total
}
export function scanFrames(events: Scan[]): number {
  let total = 0
  for (const event of events) {
    total = stepScan(total, event)
    console.assert(total >= 0)
  }
  return total
}
`

test('the step budget applies per frame: 64 frames of 4 passes over 64 rows stay within 1,000 ticks each', async () => {
  const {json} = await sweepInProcess({'scan.ts': loopBudgetSource}, 'scan.ts', true, {framesPerEntry: 50_000})
  const scan = framesJsonOf(json).entries.find((entry) => entry.name === 'scanFrames')!
  expect(scan.overBudget).toBe(0)
  expect(scan.frames!.sequences).toBe(scan.inDomain)
  expect(scan.frames!.frames).toBeGreaterThanOrEqual(50_000)
  // Without the per-frame reset, a sequence of 64 frames of 256 ticks would pass 1,000 ticks by its 4th frame.
  expect(scan.frames!.frames).toBeGreaterThan(scan.inDomain * 4)
}, 60_000)

const spinSource = `type Spin = {kind: 'spin'} | {kind: 'idle'}
function stepSpin(total: number, event: Spin): number {
  if (event.kind === 'idle') return total + 1
  let count = 0
  while (count >= 0) {
    count += 1
    console.assert(count < 5)
  }
  return count
}
export function spinFrames(events: Spin[]): number {
  let total = 0
  for (const event of events) {
    total = stepSpin(total, event)
  }
  return total
}
`

test('S10: a frame whose loop never ends counts over budget, and the assert it fails is never a finding', async () => {
  const {report, json} = await sweepInProcess({'spin.ts': spinSource}, 'spin.ts', true, {framesPerEntry: 20_000})
  const spin = framesJsonOf(json).entries.find((entry) => entry.name === 'spinFrames')!
  expect(spin.overBudget).toBeGreaterThan(0)
  expect(spin.inDomain + spin.overBudget).toBe(spin.drawn)
  // stepSpin's own one-call entry also goes over budget on every spin input; neither entry counts the firing.
  const site = framesJsonOf(json).sites.find((candidate) => candidate.line === 7)!
  expect(site).toMatchObject({level3: 0, action: null})
  expect(report.findings.filter((finding) => finding.rule === 'console-assert-sweep')).toEqual([])
}, 60_000)

const attributionSource = `type Tick = {kind: 'tick'} | {kind: 'idle'}
function stepTicks(total: number, event: Tick): number {
  return event.kind === 'tick' ? total + 1 : total
}
export function tickFrames(start: number, events: Tick[]): number {
  console.assert(Number.isInteger(start))
  console.assert(start >= 0)
  console.assert(start <= 3)
  let total = start
  console.assert(total !== 2)
  for (const event of events) {
    total = stepTicks(total, event)
    console.assert(total - start !== 3)
  }
  console.assert(total - start !== 2)
  return total
}
`

test('frame attribution: a setup assert fails at frame 0, a loop assert at its frame, and an end assert at end', async () => {
  const {json} = await sweepInProcess({'ticks.ts': attributionSource}, 'ticks.ts', true, {framesPerEntry: 20_000})
  const {sites, entries} = framesJsonOf(json)
  const setup = sites.find((site) => site.line === 10)!
  expect(setup.first).toMatchObject({frame: 0, verified: true})
  const end = sites.find((site) => site.line === 15)!
  expect(end.first).toMatchObject({frame: 'end', verified: true})
  const loop = sites.find((site) => site.line === 13)!
  const input = decodeJson(loop.first!.input) as [number, {kind: string}[]]
  const frame = loop.first!.frame as number
  // The loop assert fails on the frame of the third tick, and not before.
  expect(input[1].slice(0, frame).filter((event) => event.kind === 'tick')).toHaveLength(3)
  expect(input[1][frame - 1]!.kind).toBe('tick')
  expect(loop.first).toMatchObject({events: input[1].length, verified: true})
  expect(entries.find((entry) => entry.name === 'tickFrames')!.frames).toMatchObject({setupDiscards: 0, frameDiscards: 0, endDiscards: 0})
}, 60_000)
