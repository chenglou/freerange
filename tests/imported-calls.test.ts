import {afterAll, describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {maximumCallClosureFunctions, maximumImportedModules, maximumReturnPathSteps} from '../src/engine/imported-calls.ts'

// The imported-call prototype is selected with FREERANGE_IMPORTED_CALLS=contract: a call to a
// named top-level function of another project file applies the callee's own analysis (design B).
// Each project below runs the CLI once per mode and command, and the tests read those outputs.
const freerangeCli = new URL('../fr.ts', import.meta.url).pathname

const projectDirectories: string[] = []
afterAll(() => {
  for (const directory of projectDirectories) rmSync(directory, {recursive: true, force: true})
})

function writeProject(files: Record<string, string>, withTsconfig = true): string {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-imported-calls-'))
  projectDirectories.push(directory)
  if (withTsconfig) {
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {strict: true, target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', noEmit: true},
      include: ['*.ts'],
    }))
  }
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
  return directory
}

function runCli(directory: string, mode: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, freerangeCli, ...arguments_],
    cwd: directory,
    env: {...process.env, FREERANGE_IMPORTED_CALLS: mode},
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = result.stderr.toString()
  if (stderr !== '') throw new Error(stderr)
  return result.stdout.toString()
}

function memoized<Value>(compute: () => Value): () => Value {
  let value: {current: Value} | null = null
  return () => {
    value ??= {current: compute()}
    return value.current
  }
}

// One function's contract lines from an audit, e.g. ['proves: ...', 'ensures: ...'], looked up
// inside the section of the file that declares it.
function functionBlock(audit: string, file: string, name: string): string[] {
  const lines = audit.split('\n')
  const header = lines.findIndex(line => line.startsWith(`# ${file} (`))
  if (header === -1) throw new Error(`No audit section for ${file}`)
  for (let index = header + 1; index < lines.length && !lines[index]!.startsWith('# '); index++) {
    if (lines[index] !== name) continue
    const block: string[] = []
    for (let line = index + 1; line < lines.length && lines[line] !== ''; line++) block.push(lines[line]!.trim())
    return block
  }
  throw new Error(`No audit block for ${name} in ${file}`)
}

const findingLines = (findings: string): string[] => findings.split('\n').filter(line => /^\S+\(\d+,\d+\): /.test(line))

const chapterModule = `export function nextChapter(chapterEnd: number, gap: number, wordsPerPage: number) {
  console.assert(gap >= 0)
  const chapterStart = chapterEnd + gap
  const pages = Math.max(1, Math.floor(wordsPerPage / 250))
  const chapter = {chapterStart, pages}
  console.assert(chapterEnd <= chapter.chapterStart)
  return chapter
}
`

const planModule = (chapterFile: string): string => `import {nextChapter} from './${chapterFile}'

export function readingPlan(prefaceWords: number, chapterWords: number, wordsPerPage: number) {
  const firstEnd = Math.min(Math.max(0, prefaceWords), 200) + Math.min(Math.max(0, chapterWords), 400)
  const second = nextChapter(firstEnd, 4, wordsPerPage)
  const plan = {firstEnd, secondStart: second.chapterStart, secondPages: second.pages}
  console.assert(plan.firstEnd <= plan.secondStart)
  console.assert(plan.secondPages >= 1)
  return plan
}
`

const replaceOnce = (text: string, from: string, to: string): string => {
  if (text.split(from).length !== 2) throw new Error(`Expected one occurrence of ${from}`)
  return text.replace(from, to)
}

const mainProject = memoized(() => writeProject({
  // Module A with a contract, module B relying on it, and one copy of the pair per edit to A
  // that TypeScript accepts silently.
  'chapter.ts': chapterModule,
  'plan.ts': planModule('chapter'),
  'chapter-range.ts': replaceOnce(chapterModule, 'Math.max(1, ', 'Math.max(0, '),
  'plan-range.ts': planModule('chapter-range'),
  'chapter-relation.ts': replaceOnce(chapterModule, 'chapterEnd + gap', 'chapterEnd + gap - 4'),
  'plan-relation.ts': planModule('chapter-relation'),
  'chapter-requirement.ts': replaceOnce(chapterModule, 'console.assert(gap >= 0)', 'console.assert(gap >= 8)'),
  'plan-requirement.ts': planModule('chapter-requirement'),
  // The assertion is proven only inside the guard, so it says nothing about a call with a
  // negative gap and must not become a fact about every call.
  'guarded-chapter.ts': `export function guardedChapter(chapterEnd: number, gap: number) {
  const chapterStart = chapterEnd + gap
  if (gap >= 0) {
    console.assert(chapterEnd <= chapterStart)
  }
  return {chapterStart}
}
`,
  'guarded-plan.ts': `import {guardedChapter} from './guarded-chapter'

export function guardedCaller(chapterEnd: number, gap: number) {
  const layout = guardedChapter(chapterEnd, gap)
  console.assert(chapterEnd <= layout.chapterStart)
  return layout
}
`,
  // The callee proves its assertion, but an earlier return hands back a record the assertion
  // says nothing about, and the caller's gap takes that return.
  'two-returns-chapter.ts': `export function twoReturnsChapter(chapterEnd: number, gap: number) {
  console.assert(gap >= 0)
  const chapterStart = chapterEnd + gap
  console.assert(chapterEnd <= chapterStart)
  if (gap > 100) return {chapterStart: chapterEnd - 1}
  return {chapterStart}
}
`,
  'two-returns-plan.ts': `import {twoReturnsChapter} from './two-returns-chapter'

export function twoReturnsCaller(chapterEnd: number) {
  const layout = twoReturnsChapter(chapterEnd, 200)
  console.assert(chapterEnd <= layout.chapterStart)
  return layout
}
`,
  // Contracts that state less than the caller asserts.
  'range-source.ts': `export function shrinkWidth(width: number): number {
  console.assert(width >= 0)
  return Math.max(0, width - 10)
}

export function doubledWidth(width: number): number {
  console.assert(width >= 0)
  const doubled = width * 2
  console.assert(doubled <= 100)
  return doubled
}

export function narrowedColumn(index: number): 0 | 1 {
  return index as 0 | 1
}

export function columnOffset(column: 0 | 1): number {
  return column * 320
}
`,
  'range-user.ts': `import {columnOffset, doubledWidth, narrowedColumn, shrinkWidth} from './range-source'

export function positiveShrink(width: number): number {
  console.assert(width >= 0)
  const shrunk = shrinkWidth(width)
  console.assert(shrunk > 0)
  return shrunk
}

export function shrinkBelowInput(width: number): number {
  console.assert(width >= 0)
  const shrunk = shrinkWidth(width)
  console.assert(shrunk <= width)
  return shrunk
}

export function cappedDouble(width: number): number {
  console.assert(width >= 0)
  const doubled = doubledWidth(width)
  console.assert(doubled <= 100)
  return doubled
}

export function columnAtMostOne(index: number): number {
  const column = narrowedColumn(index)
  console.assert(column <= 1)
  return column
}

export function castColumnOffset(count: number): number {
  const offset = columnOffset(count as 0 | 1)
  console.assert(offset <= 320)
  return offset
}
`,
  'ratio-source.ts': `export function perColumn(total: number, columns: number): number {
  return total / columns
}

export function parsedDivisor(count: number): number {
  const parsed = Number.parseFloat('3')
  return count / parsed
}
`,
  'ratio-user.ts': `import {parsedDivisor, perColumn} from './ratio-source'

export function zeroColumns(total: number): number {
  return perColumn(total, 0)
}

export function someColumns(total: number, columns: number): number {
  return perColumn(total, columns)
}

export function assumedDivisor(count: number): number {
  const spread = parsedDivisor(count)
  console.assert(spread === spread)
  return spread
}
`,
  // Module state of the callee's file.
  'scale-source.ts': `let scale = 2

export function setScale(next: number): void {
  scale = next
}

export function scaled(width: number): number {
  return width * scale
}
`,
  'scale-user.ts': `import {scaled} from './scale-source'

export function doubleScaled(width: number): number {
  return scaled(width) * 2
}
`,
  // gaps publishes its exact record inside gaps-source, whose audit of largeGap assumes that
  // other modules do not modify it. gaps-user is such a module, so doubledGap must not prove 24.
  'gaps-source.ts': `export const gaps = {small: 4, large: 24}

export function largeGap(): number {
  return gaps.large
}
`,
  'gaps-user.ts': `import {gaps, largeGap} from './gaps-source'

export function widenGaps(): void {
  gaps.large = 100
}

export function doubledGap(): number {
  const gap = largeGap()
  console.assert(gap === 24)
  return gap * 2
}
`,
  'minimum-source.ts': `const minimumWidth = 40

export function atLeastMinimum(width: number): number {
  return Math.max(minimumWidth, width)
}
`,
  'minimum-user.ts': `import {atLeastMinimum} from './minimum-source'

export function paddedWidth(width: number): number {
  const padded = atLeastMinimum(width)
  console.assert(padded >= 40)
  return padded
}
`,
  // queueWidth hands a module array to another file's unlowered code, which pushes onto it,
  // so the array's initial empty value must not publish into pendingCount.
  'mutate-collect.ts': `export function remember(target: number[], width: number): void {
  target.push(width)
}
`,
  'mutate-queue.ts': `import {remember} from './mutate-collect'

const pendingWidths: number[] = []

export function queueWidth(width: number): void {
  remember(pendingWidths, width)
}

export function pendingCount(): number {
  return pendingWidths.length
}
`,
  // Runtime import cycles. start re-enters cycle-a through cycle-b: at runtime start returns 7.
  'cycle-a.ts': `import {bounce} from './cycle-b'

let counter = 0

export function start(): number {
  counter = 5
  bounce()
  return counter
}

export function finish(): void {
  counter = 7
}
`,
  'cycle-b.ts': `import {finish} from './cycle-a'

export function bounce(): void {
  finish()
}
`,
  'init-a.ts': `import {measure} from './init-b'

export const seedValue = measure(8)

export function helperWidth(width: number): number {
  return width + 1
}
`,
  'init-b.ts': `import {helperWidth} from './init-a'

export function measure(width: number): number {
  return helperWidth(width) * 2
}
`,
  'even-depth.ts': `import {oddDepth} from './odd-depth'

export function evenDepth(depth: number): number {
  return depth <= 0 ? 0 : oddDepth(depth - 1)
}
`,
  'odd-depth.ts': `import {evenDepth} from './even-depth'

export function oddDepth(depth: number): number {
  return depth <= 0 ? 1 : evenDepth(depth - 1)
}
`,
  // Arguments outside what the callee's own analysis assumed.
  'total-source.ts': `export function total(values: number[]): number {
  let sum = 0
  for (const value of values) sum += value
  return sum
}
`,
  'total-user.ts': `import {total} from './total-source'

export function parsedTotal(text: string): number {
  return total([Number.parseFloat(text)])
}
`,
  'measurement.d.ts': `export interface Measurement {
  width: number
}
`,
  'measurement-describe.ts': `import type {Measurement} from './measurement'

export function describeWidth(measurement: Measurement): number {
  return measurement.width * 2
}
`,
  'measurement-parse.ts': `import {describeWidth} from './measurement-describe'
import type {Measurement} from './measurement'

export function parsedWidth(text: string): number {
  const measurement: Measurement = {width: Number.parseFloat(text)}
  describeWidth(measurement)
  return measurement.width
}
`,
  'throw-fail.ts': `export function fail(code: number): never {
  throw new Error(\`bad \${code}\`)
}
`,
  'throw-user.ts': `import {fail} from './throw-fail'

export function checkedWidth(width: number): number {
  if (width < 0) return fail(width)
  return width
}

export function statementThenAssert(width: number): number {
  if (width < 0) fail(width)
  console.assert(width >= 0)
  return width
}
`,
  // Re-exports. barrel-shadow's own clampWidth takes precedence over its `export *`.
  'clamp.ts': `export function clampWidth(width: number, maximum: number): number {
  console.assert(maximum >= 0)
  const clamped = Math.min(Math.max(0, width), maximum)
  console.assert(clamped <= maximum)
  return clamped
}
`,
  'barrel-named.ts': `export {clampWidth} from './clamp'
`,
  'barrel-star.ts': `export * from './clamp'
`,
  'barrel-renamed.ts': `export {clampWidth as limitWidth} from './clamp'
`,
  'barrel-shadow.ts': `export * from './clamp'

export function clampWidth(width: number, maximum: number): number {
  return width + maximum
}
`,
  'barrel-user.ts': `import {clampWidth as viaNamed} from './barrel-named'
import {clampWidth as viaStar} from './barrel-star'
import {limitWidth} from './barrel-renamed'
import {clampWidth as viaShadow} from './barrel-shadow'

export function namedWithin(width: number): number {
  const maximum = 800
  const clamped = viaNamed(width, maximum)
  console.assert(clamped <= maximum)
  return clamped
}

export function starWithin(width: number): number {
  const maximum = 800
  const clamped = viaStar(width, maximum)
  console.assert(clamped <= maximum)
  return clamped
}

export function renamedWithin(width: number): number {
  const maximum = 800
  const clamped = limitWidth(width, maximum)
  console.assert(clamped <= maximum)
  return clamped
}

export function shadowWithin(width: number): number {
  const maximum = 800
  const clamped = viaShadow(width, maximum)
  console.assert(clamped <= maximum)
  return clamped
}
`,
  // Default exports. default-alias exports growWidth as its default; the importer names it
  // keepWidth, which is also the name of a different function in that file.
  'default-named.ts': `export default function halveWidth(width: number): number {
  console.assert(width >= 0)
  return Math.min(width / 2, 400)
}
`,
  'default-alias.ts': `function growWidth(width: number): number {
  return width * 2
}

export function keepWidth(width: number): number {
  return Math.min(width, 100)
}

export default growWidth
`,
  'default-anonymous.ts': `export default (width: number): number => Math.min(width, 100)
`,
  'default-user.ts': `import halve from './default-named'
import keepWidth from './default-alias'
import cap from './default-anonymous'

export function halvedWithin(width: number): number {
  console.assert(width >= 0)
  const halved = halve(width)
  console.assert(halved <= 400)
  return halved
}

export function defaultNotByName(width: number): number {
  const kept = keepWidth(width)
  console.assert(kept <= 100)
  return kept
}

export function anonymousDefault(width: number): number {
  const capped = cap(width)
  console.assert(capped <= 100)
  return capped
}
`,
  // An overloaded function: an import resolves to the first overload signature, which has no
  // body, while a same-file call resolves to the implementation.
  'pick.ts': `export function pickWidth(width: number): number
export function pickWidth(width: number, fallback: number): number
export function pickWidth(width: number, fallback?: number): number {
  return fallback == null ? width * 2 : fallback
}
`,
  'pick-user.ts': `import {pickWidth} from './pick'

export function importedPick(width: number): number {
  console.assert(width >= 0)
  const picked = pickWidth(width)
  console.assert(picked === 0)
  return picked
}
`,
  // box-source type-imports Frame from box-user, which value-imports box-source: a cycle of
  // types only, which runs no module code.
  'box-source.ts': `import type {Frame} from './box-user'

export type Box = {width: number; height: number}

export function boxWidth(box: Box, frame: Frame): number {
  const fitted = Math.min(Math.max(0, box.width), frame.maximumWidth)
  console.assert(fitted <= frame.maximumWidth)
  return fitted
}
`,
  'box-user.ts': `import {boxWidth, type Box} from './box-source'

export type Frame = {maximumWidth: number}

export function framedWidth(width: number): number {
  const maximumWidth = 600
  const box: Box = {width, height: 10}
  const frame: Frame = {maximumWidth}
  const fitted = boxWidth(box, frame)
  console.assert(fitted <= maximumWidth)
  return fitted
}
`,
}))

const offFindings = memoized(() => runCli(mainProject(), 'off'))
const contractFindings = memoized(() => runCli(mainProject(), 'contract'))
const contractAudit = memoized(() => runCli(mainProject(), 'contract', '--audit'))

test('with imported calls off, a call into another file keeps rejecting the caller', () => {
  expect(findingLines(offFindings())).toContain('plan.ts(5,18): error [console-assert]: console.assert in readingPlan was not checked because function call nextChapter')
})

test('an unknown FREERANGE_IMPORTED_CALLS value is an error', () => {
  expect(() => runCli(mainProject(), 'inline')).toThrow('FREERANGE_IMPORTED_CALLS must be off or contract, not inline')
})

describe('contract: what a caller may rely on', () => {
  test("module B's checks catch each edit to module A", () => {
    const findings = findingLines(contractFindings())
    // Unedited: B proves both assertions from A's range and A's proven relation.
    expect(findings.filter(line => line.startsWith('plan.ts(') || line.startsWith('chapter.ts('))).toEqual([])
    // A range edit: A's column count may now be 0.
    expect(findings).toContain('plan-range.ts(8,3): error [console-assert]: could not prove console.assert condition in readingPlan: plan.secondPages >= 1')
    // A relation edit: A's relation is no longer proven, so B loses the fact it relied on.
    expect(findings).toContain('chapter-relation.ts(6,3): error [console-assert]: could not prove console.assert condition in nextChapter: chapterEnd <= chapter.chapterStart')
    expect(findings).toContain('plan-relation.ts(7,3): error [console-assert]: could not prove console.assert condition in readingPlan: plan.firstEnd <= plan.secondStart')
    // A stricter requirement: B passes a gap of 4, and the related location names A's file.
    expect(findings).toContain('plan-requirement.ts(5,18): error [declared-requirement]: call to nextChapter makes its declared requirement definitely false (declared at chapter-requirement.ts(2,3))')
  })

  test('a relation publishes only from a proven assertion that dominates the only return', () => {
    expect(functionBlock(contractAudit(), 'guarded-plan.ts', 'guardedCaller')).toContain('assertion unproven: could not prove chapterEnd <= layout.chapterStart (at guarded-plan.ts:5:3)')
    expect(functionBlock(contractAudit(), 'two-returns-chapter.ts', 'twoReturnsChapter')).toContain('proves: chapterEnd <= chapterStart (assertion at two-returns-chapter.ts:4:3)')
    expect(functionBlock(contractAudit(), 'two-returns-plan.ts', 'twoReturnsCaller')).toContain('assertion unproven: could not prove chapterEnd <= layout.chapterStart (at two-returns-plan.ts:5:3)')
  })

  test('a contract is not trusted beyond what it states', () => {
    const audit = contractAudit()
    // shrinkWidth(5) is 0: the contract says the result is at least 0, not above 0.
    expect(functionBlock(audit, 'range-user.ts', 'positiveShrink')).toContain('assertion unproven: could not prove shrunk > 0 (at range-user.ts:6:3)')
    // True at runtime, but the callee asserts no relation between its input and its result.
    expect(functionBlock(audit, 'range-user.ts', 'shrinkBelowInput')).toContain('assertion unproven: could not prove shrunk <= width (at range-user.ts:13:3)')
    // The callee's own assertion is unproven, and doubledWidth(60) is 120.
    expect(functionBlock(audit, 'range-source.ts', 'doubledWidth')).toContain('assertion unproven: could not prove doubled <= 100 (at range-source.ts:9:3)')
    expect(functionBlock(audit, 'range-user.ts', 'cappedDouble')).toContain('assertion unproven: could not prove doubled <= 100 (at range-user.ts:20:3)')
    // The declared return type 0 | 1 is a cast of any number, so it publishes nothing.
    expect(functionBlock(audit, 'range-user.ts', 'columnAtMostOne')).toContain('assertion blocked: the function did not finish analysis without site-specific assumptions: column <= 1 (at range-user.ts:26:3)')
  })

  test('an argument outside the declared kind the summary assumed stops the call', () => {
    const audit = contractAudit()
    expect(functionBlock(audit, 'range-user.ts', 'castColumnOffset')).toContain('partially supported: calls columnOffset, whose summary assumes more about column than this argument provides (call at range-user.ts:31:18)')
    expect(functionBlock(audit, 'total-user.ts', 'parsedTotal')).toEqual([
      'partially supported: calls total, whose summary assumes more about values than this argument provides (call at total-user.ts:4:10)',
    ])
    // width is declared only in a declaration file, so the callee assumed it finite and nothing
    // checked it; parsing can put NaN in it.
    expect(functionBlock(audit, 'measurement-parse.ts', 'parsedWidth')).toEqual([
      'partially supported: calls describeWidth, whose summary assumes more about measurement than this argument provides (call at measurement-parse.ts:6:3)',
    ])
  })

  test("the callee's requirements and assumptions reach the caller through the stub", () => {
    expect(findingLines(contractFindings())).toContain('ratio-user.ts(4,10): error [inferred-requirement]: call to perColumn violates its nonzero divisor requirement (division at ratio-source.ts(2,10))')
    expect(functionBlock(contractAudit(), 'ratio-user.ts', 'someColumns')).toContain('requires: columns is nonzero (division at ratio-source.ts:2:10)')
    expect(functionBlock(contractAudit(), 'ratio-user.ts', 'assumedDivisor')).toContain('assumes: the divisor at ratio-source.ts:7:10 is nonzero')
  })

  test('a callee that always throws ends the calling path', () => {
    expect(functionBlock(contractAudit(), 'throw-user.ts', 'checkedWidth')).toEqual([
      'requires: Number.isFinite(width) (input at throw-user.ts:3:30)',
      'ensures: return is a finite number at least 0',
    ])
    expect(functionBlock(contractAudit(), 'throw-user.ts', 'statementThenAssert')).toEqual([
      'requires: Number.isFinite(width) (input at throw-user.ts:8:37)',
      'proves: width >= 0 (assertion at throw-user.ts:10:3)',
      'ensures: return is a finite number at least 0',
    ])
  })
})

describe('contract: module state', () => {
  test("a callee resting on an assumption about its own file's state stops the call", () => {
    expect(functionBlock(contractAudit(), 'scale-user.ts', 'doubleScaled')).toContain("partially supported: calls scaled, whose result rests on an assumption about scale in its own file; assumptions about another file's module state are not carried across files (call at scale-user.ts:4:10)")
    // A published structure: another module, here the caller's own, may modify it.
    expect(functionBlock(contractAudit(), 'gaps-source.ts', 'largeGap')).toContain('assumes: other modules do not modify gaps or any object or array inside it')
    expect(functionBlock(contractAudit(), 'gaps-user.ts', 'doubledGap')).toEqual([
      'assertion blocked: the function did not finish analysis without site-specific assumptions: gap === 24 (at gaps-user.ts:9:3)',
      "partially supported: calls largeGap, whose result rests on an assumption about gaps in its own file; assumptions about another file's module state are not carried across files (call at gaps-user.ts:8:15)",
    ])
  })

  test("a callee reading a published scalar of its own file applies", () => {
    expect(functionBlock(contractAudit(), 'minimum-user.ts', 'paddedWidth')).toContain('proves: padded >= 40 (assertion at minimum-user.ts:5:3)')
  })

  test('module structures handed to unlowered code keep their declared-shape hedge', () => {
    expect(functionBlock(contractAudit(), 'mutate-queue.ts', 'pendingCount')).toContain('ensures: return is a finite integer number from 0 through 4294967295')
  })

  test('runtime import cycles stop the call', () => {
    const audit = contractAudit()
    expect(functionBlock(audit, 'cycle-a.ts', 'start')).toContain('partially supported: calls bounce, which can call back into a module that is already running or still initializing; runtime import cycles are outside the analyzed scope (call at cycle-a.ts:7:3)')
    expect(functionBlock(audit, 'even-depth.ts', 'evenDepth')).toContain('partially supported: calls oddDepth, which can call back into a module that is already running or still initializing; runtime import cycles are outside the analyzed scope (call at even-depth.ts:4:27)')
    // The module initializer of init-a calls measure, which calls back into init-a. measure's
    // own analysis is unaffected.
    expect(functionBlock(audit, 'init-a.ts', 'module initialization')).toContain('partially supported: calls measure, which can call back into a module that is already running or still initializing; runtime import cycles are outside the analyzed scope (call at init-a.ts:3:26)')
    expect(functionBlock(audit, 'init-b.ts', 'measure')).toContain('requires: Number.isFinite(width) (input at init-b.ts:3:25)')
  })
})

describe('contract: which function an import names', () => {
  test('re-exports follow the declaration TypeScript resolves', () => {
    const audit = contractAudit()
    expect(functionBlock(audit, 'barrel-user.ts', 'namedWithin')).toContain('proves: clamped <= maximum (assertion at barrel-user.ts:9:3)')
    expect(functionBlock(audit, 'barrel-user.ts', 'starWithin')).toContain('proves: clamped <= maximum (assertion at barrel-user.ts:16:3)')
    expect(functionBlock(audit, 'barrel-user.ts', 'renamedWithin')).toContain('proves: clamped <= maximum (assertion at barrel-user.ts:23:3)')
    expect(functionBlock(audit, 'barrel-user.ts', 'shadowWithin')).toContain('assertion unproven: could not prove clamped <= maximum (at barrel-user.ts:30:3)')
  })

  test('default exports follow the exported function, not the local name', () => {
    const audit = contractAudit()
    expect(functionBlock(audit, 'default-user.ts', 'halvedWithin')).toContain('proves: halved <= 400 (assertion at default-user.ts:8:3)')
    expect(functionBlock(audit, 'default-user.ts', 'defaultNotByName')).toContain('assertion unproven: could not prove kept <= 100 (at default-user.ts:14:3)')
    expect(functionBlock(audit, 'default-user.ts', 'anonymousDefault')).toEqual(['unsupported: function call cap at default-user.ts:19:18'])
  })

  test('an overloaded callee resolves to a signature without a body and stops the call', () => {
    expect(functionBlock(contractAudit(), 'pick-user.ts', 'importedPick')).toContain('partially supported: calls pickWidth, which hit unsupported code (call at pick-user.ts:5:18)')
  })

  test('an import cycle of types only runs no module code, so the call applies', () => {
    expect(functionBlock(contractAudit(), 'box-user.ts', 'framedWidth')).toContain('proves: fitted <= maximumWidth (assertion at box-user.ts:10:3)')
  })

  test('a file analyzed without a tsconfig follows imports into the files its program loads', () => {
    const directory = writeProject({
      'rounding.ts': `export function atLeast(value: number, floor: number): number {
  const raised = Math.max(floor, Math.floor(value))
  console.assert(floor <= raised)
  return raised
}
`,
      'score.ts': `import {atLeast} from './rounding'

export function passingScore(raw: number, curve: number): number {
  const minimum = 50
  const score = atLeast(raw + curve / 2, minimum)
  console.assert(minimum <= score)
  return score
}
`,
    }, false)
    expect(findingLines(runCli(directory, 'off', 'score.ts'))).toContain('score.ts(5,17): error [console-assert]: console.assert in passingScore was not checked because function call atLeast')
    expect(functionBlock(runCli(directory, 'contract', '--audit', 'score.ts'), 'score.ts', 'passingScore')).toContain('proves: minimum <= score (assertion at score.ts:6:3)')
  })

  test('a callee file with TypeScript errors stops the call instead of failing the run', () => {
    const directory = writeProject({
      'broken.ts': `export function brokenWidth(width: number): number {
  const label: string = width
  return Math.max(0, width)
}
`,
      'broken-user.ts': `import {brokenWidth} from './broken'

export function usesBroken(width: number): number {
  const result = brokenWidth(width)
  console.assert(result >= 0)
  return result
}
`,
    })
    expect(functionBlock(runCli(directory, 'contract', '--audit', 'broken-user.ts'), 'broken-user.ts', 'usesBroken')).toContain('partially supported: calls brokenWidth, whose file has TypeScript errors, so the declared types the analysis would trust may be wrong (call at broken-user.ts:4:18)')
  })
})

describe('contract: limits', () => {
  test(`a run lowers at most ${maximumImportedModules} files for imported calls`, () => {
    const files: Record<string, string> = {}
    const fan = (name: string, count: number): string => {
      const lines: string[] = []
      for (let index = 0; index < count; index++) lines.push(`import {leaf${index}} from './leaf${index}'`)
      lines.push('', `export function ${name}(): number {`, '  let total = 0')
      for (let index = 0; index < count; index++) lines.push(`  total += leaf${index}()`)
      lines.push(`  console.assert(total <= ${count})`, '  return total', '}', '')
      return lines.join('\n')
    }
    for (let index = 0; index <= maximumImportedModules; index++) {
      files[`leaf${index}.ts`] = `export function leaf${index}(): number {\n  return 1\n}\n`
    }
    files['wide-fan.ts'] = fan('wideFan', maximumImportedModules + 1)
    files['narrow-fan.ts'] = fan('narrowFan', maximumImportedModules)
    const directory = writeProject(files)
    const wide = functionBlock(runCli(directory, 'contract', '--audit', 'wide-fan.ts'), 'wide-fan.ts', 'wideFan')
    expect(wide.some(line => line.startsWith(`partially supported: calls leaf${maximumImportedModules}, whose file would pass the limit of ${maximumImportedModules} files loaded for imported calls in one run (call at wide-fan.ts:`))).toBe(true)
    const narrow = functionBlock(runCli(directory, 'contract', '--audit', 'narrow-fan.ts'), 'narrow-fan.ts', 'narrowFan')
    expect(narrow.some(line => line.startsWith(`proves: total <= ${maximumImportedModules} `))).toBe(true)
  })

  test('the module limit also bounds a chain of imported calls', () => {
    const files: Record<string, string> = {}
    const chainLength = maximumImportedModules + 6
    const name = (at: number): string => `depth${at}`
    for (let index = 0; index < chainLength; index++) {
      files[`${name(index)}.ts`] = index === chainLength - 1
        ? `export function ${name(index)}(): number {\n  return 7\n}\n`
        : `import {${name(index + 1)}} from './${name(index + 1)}'\n\nexport function ${name(index)}(): number {\n  return ${name(index + 1)}()\n}\n`
    }
    const caller = (callerName: string, start: number): string => `import {${name(start)}} from './${name(start)}'

export function ${callerName}(): number {
  const value = ${name(start)}()
  console.assert(value === 7)
  return value
}
`
    files['long-chain.ts'] = caller('longChain', 0)
    files['short-chain.ts'] = caller('shortChain', chainLength - 10)
    const directory = writeProject(files)
    expect(functionBlock(runCli(directory, 'contract', '--audit', 'long-chain.ts'), 'long-chain.ts', 'longChain')).toContain(`partially supported: calls depth0, whose calls could not all be followed to check that none calls back into this file: they reach more than ${maximumCallClosureFunctions} functions, a file past the limit of ${maximumImportedModules} files loaded for imported calls, or a file with TypeScript errors (call at long-chain.ts:4:17)`)
    expect(functionBlock(runCli(directory, 'contract', '--audit', 'short-chain.ts'), 'short-chain.ts', 'shortChain')).toContain('proves: value === 7 (assertion at short-chain.ts:5:3)')
  })

  test(`following where a call leads visits at most ${maximumCallClosureFunctions} functions`, () => {
    // A hub visits itself plus its parts.
    const hub = (hubName: string, parts: number): string => {
      const lines: string[] = []
      for (let index = 0; index < parts; index++) lines.push(`function part${index}(): number {\n  return 1\n}\n`)
      lines.push(`export function ${hubName}(): number {`, '  let total = 0')
      for (let index = 0; index < parts; index++) lines.push(`  total += part${index}()`)
      lines.push('  return Math.min(total, 5000)', '}', '')
      return lines.join('\n')
    }
    const directory = writeProject({
      'wide-hub.ts': hub('wideHub', maximumCallClosureFunctions),
      'narrow-hub.ts': hub('narrowHub', maximumCallClosureFunctions - 1),
      'hub-user.ts': `import {narrowHub} from './narrow-hub'
import {wideHub} from './wide-hub'

export function wideTotal(): number {
  const total = wideHub()
  console.assert(total <= 5000)
  return total
}

export function narrowTotal(): number {
  const total = narrowHub()
  console.assert(total <= 5000)
  return total
}
`,
    })
    const audit = runCli(directory, 'contract', '--audit', 'hub-user.ts')
    expect(functionBlock(audit, 'hub-user.ts', 'wideTotal')).toContain(`partially supported: calls wideHub, whose calls could not all be followed to check that none calls back into this file: they reach more than ${maximumCallClosureFunctions} functions, a file past the limit of ${maximumImportedModules} files loaded for imported calls, or a file with TypeScript errors (call at hub-user.ts:5:17)`)
    expect(functionBlock(audit, 'hub-user.ts', 'narrowTotal')).toContain('proves: total <= 5000 (assertion at hub-user.ts:12:3)')
  })

  test(`a path into a returned record is searched through at most ${maximumReturnPathSteps} values`, () => {
    // The search visits the returned record, then each field in order; the related field is last.
    const layout = (layoutName: string, fields: number): string => {
      const properties: string[] = []
      for (let index = 0; index < fields; index++) properties.push(`    field${index}: ${index},`)
      return `export function ${layoutName}(chapterEnd: number, gap: number) {
  console.assert(gap >= 0)
  const chapterStart = chapterEnd + gap
  console.assert(chapterEnd <= chapterStart)
  return {
${properties.join('\n')}
    chapterStart,
  }
}
`
    }
    const directory = writeProject({
      'wide-layout.ts': layout('wideLayout', maximumReturnPathSteps),
      'narrow-layout.ts': layout('narrowLayout', maximumReturnPathSteps - 1),
      'layout-user.ts': `import {narrowLayout} from './narrow-layout'
import {wideLayout} from './wide-layout'

export function wideCaller(chapterEnd: number) {
  const layout = wideLayout(chapterEnd, 4)
  console.assert(chapterEnd <= layout.chapterStart)
  return layout.chapterStart
}

export function narrowCaller(chapterEnd: number) {
  const layout = narrowLayout(chapterEnd, 4)
  console.assert(chapterEnd <= layout.chapterStart)
  return layout.chapterStart
}
`,
    })
    const audit = runCli(directory, 'contract', '--audit', 'layout-user.ts')
    expect(functionBlock(audit, 'layout-user.ts', 'wideCaller')).toContain('assertion unproven: could not prove chapterEnd <= layout.chapterStart (at layout-user.ts:6:3)')
    expect(functionBlock(audit, 'layout-user.ts', 'narrowCaller')).toContain('proves: chapterEnd <= layout.chapterStart (assertion at layout-user.ts:12:3)')
  })
})
