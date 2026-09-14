// contract-writing-v1 (freerange-focus/plan-c/registered/contract-writing-v1.json `scores`): one writer's console.assert patch on
// mj-gallery's 13 subject files, scored against the m7 run (plan-a/runs/20260914T072511Z-mj-prealpha-m7):
//   4b  each subject file's line map from git's -U0 diff; astmut@v1 regenerated on the patched file (astmut-rows.ts); every valid
//       m7 row matched by exactly one regenerated row, or unmapped because it spans a changed line; plants P1-P7 by their text
//   4a  the run's lattice on every supported entry: the run's own instrumented original decides the domain, and the mapped
//       mutants are killed against the patched, unmutated file P (worker.ts cw-prepare and cw-mutant, contract-writing-worker.ts)
//   4c  P against the run's original on the run's domain; a file with a difference is scored as the run's own
//   4d  firing rows of added sites on P, witnessed through W1 sweep5 on c13-tooltip (witness-run.ts --patched-plan)
//   4e  the share of each subject entry's domain that added leading asserts reject
//   4f  Freerange's audit and findings joined to every added assert (cw-freerange.ts)
// --empty scores no patch: gate G-R0 must reproduce kills.tsv's kill_noise@abs1e-9 and lattice_equivalent columns for every
// mutant, the per-entry digests and in-domain counts, astmut@v1's table rows, and m7's Freerange findings on the pinned files.
// usage: bun mutation-instrument/contract-writing.ts --registration <contract-writing-v1.json> --writer <id> --out <run dir>
//          (--patch <patch> [--snapshot <the writer's snapshot directory>] | --empty)
import {createHash} from 'node:crypto'
import {appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {exportedEntries, loadProgram} from './analyze.ts'
import {astmutFile} from './astmut-rows.ts'
import {runChild, type ChildRun} from './children.ts'
import {assertVerdict, parseAudit, parseFindings, type AssertStatus} from './cw-freerange.ts'
import type {Value} from './domain.ts'
import {decodeJson, encodeJson, formatCall} from './encode.ts'
import {instrumentSource} from './instrument.ts'
import type {AstmutRow, AstmutTable} from './mj-gallery.ts'
import {decodePlan} from './plan-file.ts'
import {readRules, type PatchedWitnessSets, type WitnessSet} from './rules.ts'
import type {BaselineLine, ContractCopy, ContractPlan, ContractPrepareLine, CopyPlan, EntryPlan, FilePlan, FirstFiring, Job, MutantPlan, Plan, Site, WitnessTable} from './types.ts'

const REGISTRATION_SHA1 = '7c8734ad36c09e28ee4ab7232132dc6e15bb6017'
const FR = realpathSync(new URL('../fr.ts', import.meta.url).pathname)
const INSTRUMENT_DIR = dirname(realpathSync(new URL(import.meta.url).pathname))
const WITNESS_RUN = join(INSTRUMENT_DIR, 'witness-run.ts')
const STARTUP_SECONDS = 0.3
const TOOLTIP_COPY = 'c13-tooltip'
const W1_ENTRIES = ['tooltipPosition', 'tooltipInPlacePosition']
// 4d's shrinkRow count, reported beside the scores: tt/shrink-sweep.ts's caller-shaped rows through the wrapper tree. The script
// writes the module it imports into `planted/` beside itself, so it runs as a derived copy in the witness run's outputs; the
// substitute replaces a line with itself, which is what makes witness.ts write that copy.
const SHRINK_SWEEP = {script: 'tt/shrink-sweep.ts', line: "const dir = join(import.meta.dir, 'planted')"}

type Sha1File = {path: string; sha1: string}
type ContractRegistration = {
  id: string
  data: {scratch: string}
  sources: {
    m7Registration: Sha1File
    m7Run: {dir: string; 'kills.tsv': Sha1File; 'results.jsonl': Sha1File; 'baseline.jsonl': Sha1File; 'plan.json': Sha1File}
    astmutTable: Sha1File
    witnessScriptW1: Sha1File
    instrument: {runCommit: string}
  }
  subjects: {files: {file: string; copy: string; sha1At93b9935807: string; functions: {name: string}[]}[]}
  scores: {'4a_kills': {survivorClasses: Sha1File}}
}
type SurvivorClasses = {classTotals: Record<string, number>; survivors: {key: string; class: string}[]; killedBehaviourChanging: string[]}
type ChangeRule = {file: string; from: string; to: string}
// Indexed by line number from 1. writerLines: patched lines inside a hunk; changedPinnedLines: pinned lines inside a hunk.
type LineMap = {pinnedToPatched: (number | null)[]; patchedToPinned: (number | null)[]; writerLines: number[]; changedPinnedLines: number[]}
type Mapping = {runValid: number; matched: number; unmapped: string[]; excludedWriterLines: number; excludedNewScope: number; regeneratedWithoutRunRow: string[]; plants: {key: string; mapped: boolean}[]; regenerationEqualsTable: boolean | null}
type CopyWork = {runCopy: CopyPlan; copy: CopyPlan; contract: ContractCopy; subject: FilePlan; pinnedText: string; patchedText: string; frRoot: string; lineMap: LineMap; entryNames: {run: string[]; patched: string[]}; runSitesOnChangedLines: string[]; mapping: Mapping}
type MutantOutcome = {key: string; entries: number; killSites: Set<number>; quietFile: boolean; first: {entry: string; site: number; first: FirstFiring} | null; behaviorDiffs: number; eligibilityMismatches: number; digestMismatches: number; failure: string | null}
type ChildRecord = {job: string; exitCode: number | null; timedOut: string | null; ms: number; maxRssKb: number | null; stderrTail: string}

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

function newlines(text: string) {
  return text.split('\n').length - 1
}

function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function writeFileWithDirs(path: string, text: string) {
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, text)
}

function tsvCell(value: string | number | boolean | null) {
  return String(value).replaceAll('\t', ' ').replaceAll('\n', '\\n')
}

function cellOf(row: Record<string, string>, name: string): string {
  const value = row[name]
  if (value == null) throw new Error(`a kills.tsv row has no column ${name}`)
  return value
}

function parseTsv(text: string): Record<string, string>[] {
  const [header, ...rows] = linesOf(text)
  if (header == null) throw new Error('an empty tsv')
  const names = header.split('\t')
  return rows.map((row) => {
    const cells = row.split('\t')
    if (cells.length !== names.length) throw new Error(`a tsv row has ${cells.length} cells for ${names.length} columns`)
    return Object.fromEntries(cells.map((cell, index) => [names[index]!, cell]))
  })
}

function formatFirst(entry: string, first: FirstFiring | null) {
  if (first == null) return ''
  return first.input == null ? '(input above 2 KB, not kept)' : formatCall(entry, decodeJson(first.input) as Value[])
}

/** export@v1 as run.ts applies it: `function <name>(` becomes `export function <name>(` once in the tree. */
function exportShimmed(texts: string[], names: string[], label: string): string[] {
  const result = texts.slice()
  for (const name of names) {
    const token = `function ${name}(`
    const counts = result.map((text) => text.split(token).length - 1)
    let total = 0
    for (const count of counts) total += count
    if (total !== 1) throw new Error(`export@v1 ${label}: expected exactly one ${JSON.stringify(token)} in the tree, found ${total}`)
    const index = counts.indexOf(1)
    result[index] = result[index]!.replace(token, `export ${token}`)
  }
  return result
}

/** A change table's edits as run.ts applies them: each `from` must occur exactly once. */
function applyChanges(text: string, changes: ChangeRule[], label: string) {
  let result = text
  for (const change of changes) {
    const occurrences = result.split(change.from).length - 1
    if (occurrences !== 1) throw new Error(`${label}: expected exactly one occurrence of ${JSON.stringify(change.from)}, found ${occurrences}`)
    result = result.replace(change.from, change.to)
  }
  return result
}

/** A tree root's tsconfig.json, so `@/…` imports resolve, and its node_modules link when the tree imports a package. */
function finishTree(root: string, tsconfig: string, nodeModules: string | null) {
  mkdirSync(root, {recursive: true})
  copyFileSync(tsconfig, join(root, 'tsconfig.json'))
  if (nodeModules != null) symlinkSync(nodeModules, join(root, 'node_modules'))
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!
      next += 1
      await work(item)
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker))
}

/**
 * 4b's line map of one subject file, from `git diff --no-index --diff-algorithm=myers -U0 <pinned> <patched>`. A pinned line
 * outside every hunk is unchanged and maps by the offset the hunks before it add, e.g. line 60 maps to 62 after a hunk
 * `@@ -44,0 +45,2 @@`; every patched line inside a hunk is a writer line. The map checks itself: each hunk starts where the
 * offsets reach, every unchanged line keeps its text, and both files end together.
 */
function lineMapOf(pinnedPath: string, patchedPath: string, pinnedText: string, patchedText: string): LineMap {
  const diff = Bun.spawnSync(['git', 'diff', '--no-index', '--diff-algorithm=myers', '-U0', pinnedPath, patchedPath])
  if (diff.exitCode !== 0 && diff.exitCode !== 1) throw new Error(`git diff --no-index ${pinnedPath} ${patchedPath} exited ${diff.exitCode}: ${diff.stderr.toString()}`)
  const pinnedLines = linesOf(pinnedText)
  const patchedLines = linesOf(patchedText)
  const pinnedToPatched = new Array<number | null>(pinnedLines.length + 1).fill(null)
  const patchedToPinned = new Array<number | null>(patchedLines.length + 1).fill(null)
  const writerLines: number[] = []
  const changedPinnedLines: number[] = []
  let oldLine = 1
  let newLine = 1
  const keepUntil = (untilOldLine: number) => {
    for (; oldLine < untilOldLine; oldLine++, newLine++) {
      pinnedToPatched[oldLine] = newLine
      patchedToPinned[newLine] = oldLine
    }
  }
  for (const match of diff.stdout.toString().matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(match[1])
    const oldCount = match[2] == null ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newCount = match[4] == null ? 1 : Number(match[4])
    // A hunk with no old lines inserts after old line oldStart; a hunk with no new lines deletes after new line newStart.
    keepUntil(oldCount === 0 ? oldStart + 1 : oldStart)
    if (newLine !== (newCount === 0 ? newStart + 1 : newStart)) throw new Error(`line map of ${patchedPath}: hunk ${match[0]} starts where the offsets reach patched line ${newLine}`)
    for (let count = 0; count < oldCount; count++, oldLine++) changedPinnedLines.push(oldLine)
    for (let count = 0; count < newCount; count++, newLine++) writerLines.push(newLine)
  }
  keepUntil(pinnedLines.length + 1)
  if (newLine !== patchedLines.length + 1) throw new Error(`line map of ${patchedPath}: the offsets end at patched line ${newLine}, the file has ${patchedLines.length} lines`)
  for (let line = 1; line <= pinnedLines.length; line++) {
    const mapped = pinnedToPatched[line] ?? null
    if (mapped != null && pinnedLines[line - 1] !== patchedLines[mapped - 1]) throw new Error(`line map of ${patchedPath}: pinned line ${line} and patched line ${mapped} differ`)
  }
  return {pinnedToPatched, patchedToPinned, writerLines, changedPinnedLines}
}

// -- Inputs ------------------------------------------------------------------------------------------

const usage = 'usage: bun mutation-instrument/contract-writing.ts --registration <contract-writing-v1.json> --writer <id> --out <run dir> (--patch <patch> [--snapshot <dir>] | --empty)'
const registrationPath = option('--registration')
const writer = option('--writer')
const outOption = option('--out')
const patchPath = option('--patch')
const snapshotDir = option('--snapshot')
const empty = process.argv.includes('--empty')
if (registrationPath == null || writer == null || outOption == null || empty === (patchPath != null)) throw new Error(usage)
if (existsSync(outOption)) throw new Error(`refusing to overwrite ${outOption}`)
const wallStart = performance.now()
const started = new Date().toISOString()

const registrationText = readFileSync(registrationPath, 'utf8')
if (sha1(registrationText) !== REGISTRATION_SHA1) throw new Error(`${registrationPath}: sha1 ${sha1(registrationText)} differs from the registered ${REGISTRATION_SHA1}`)
const registration = decodeJson(registrationText) as ContractRegistration
const scratch = registration.data.scratch
const scratchPath = (text: string) => (text.startsWith('S/') ? join(scratch, text.slice(2)) : text)
const checkedText = (source: Sha1File) => {
  const text = readFileSync(scratchPath(source.path), 'utf8')
  if (sha1(text) !== source.sha1) throw new Error(`${source.path}: sha1 ${sha1(text)} differs from the registered ${source.sha1}`)
  return text
}
const gitOutput = (args: string[], cwd: string) => {
  const result = Bun.spawnSync(['git', ...args], {cwd})
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

// Freerange is the registered revision everywhere outside mutation-instrument and knip.config.ts, whose one added entry names
// this scorer for dead-code detection and changes nothing fr.ts runs.
const frDir = dirname(FR)
const frRevision = registration.sources.instrument.runCommit
const FREERANGE_EXCLUDED = [':!mutation-instrument', ':!knip.config.ts']
const frDifference = gitOutput(['diff', '--stat', frRevision, 'HEAD', '--', '.', ...FREERANGE_EXCLUDED], frDir)
const frUncommitted = gitOutput(['status', '--porcelain', '--', '.', ...FREERANGE_EXCLUDED], frDir)
const knipDifference = gitOutput(['diff', frRevision, '--', 'knip.config.ts'], frDir)
if (frDifference !== '' || frUncommitted !== '') throw new Error(`Freerange outside mutation-instrument differs from ${frRevision}: ${frDifference} ${frUncommitted}`)
const instrumentCommit = gitOutput(['rev-parse', 'HEAD'], INSTRUMENT_DIR)
const instrumentDirty = gitOutput(['status', '--porcelain', '--', '.'], INSTRUMENT_DIR) !== ''
const instrumentFiles = readdirSync(INSTRUMENT_DIR).filter((name) => name.endsWith('.ts')).sort()
const instrumentSha1 = sha1(instrumentFiles.map((name) => `${name}\n${readFileSync(join(INSTRUMENT_DIR, name), 'utf8')}`).join('\n'))

checkedText(registration.sources.m7Registration)
const rules = readRules(scratchPath(registration.sources.m7Registration.path))
const extras = rules.mjGallery
if (extras == null) throw new Error('the m7 registration is not an mj-gallery registration')
const m7 = extras.registration
const m7RunDir = scratchPath(registration.sources.m7Run.dir)
const runPlanPath = scratchPath(registration.sources.m7Run['plan.json'].path)
const runPlan = decodePlan(checkedText(registration.sources.m7Run['plan.json']))
checkedText(registration.sources.m7Run['results.jsonl'])
const baseline = new Map<string, BaselineLine>()
for (const text of linesOf(checkedText(registration.sources.m7Run['baseline.jsonl']))) {
  const line = decodeJson(text) as BaselineLine
  baseline.set(`${line.base}.${line.entry}`, line)
}
const killsRows = parseTsv(checkedText(registration.sources.m7Run['kills.tsv']))
const killsByKey = new Map(killsRows.map((row) => [cellOf(row, 'mutant'), row]))
const table = decodeJson(checkedText(registration.sources.astmutTable)) as AstmutTable
const survivorClasses = decodeJson(checkedText(registration.scores['4a_kills'].survivorClasses)) as SurvivorClasses
checkedText(registration.sources.witnessScriptW1)
const worktreeDir = join(scratch, extras.worktree)
const tsconfig = join(worktreeDir, 'tsconfig.json')
const worktreeNodeModules = join(worktreeDir, 'node_modules')

mkdirSync(join(outOption, 'work'), {recursive: true})
const out = realpathSync(outOption)
const work = join(out, 'work')
log(`contract-writing-v1 writer ${writer}${empty ? ' (empty patch: gate G-R0)' : ''} into ${out}`)

// -- The patch ------------------------------------------------------------------------------------------

const subjects = registration.subjects.files
const appliedDir = join(work, 'applied')
for (const subject of subjects) {
  const text = readFileSync(join(worktreeDir, subject.file), 'utf8')
  if (sha1(text) !== subject.sha1At93b9935807) throw new Error(`${subject.file}: sha1 ${sha1(text)} differs from the registered ${subject.sha1At93b9935807}`)
  writeFileWithDirs(join(appliedDir, subject.file), text)
}
let patchSha1: string | null = null
if (patchPath != null) {
  const patchText = readFileSync(patchPath, 'utf8')
  patchSha1 = sha1(patchText)
  writeFileSync(join(out, 'contracts.patch'), patchText)
  const changedFiles = [...patchText.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((match) => match[1]!)
  const outOfScope = changedFiles.filter((file) => !subjects.some((subject) => subject.file === file))
  if (outOfScope.length > 0) throw new Error(`the patch changes files outside the 13 subject files: ${outOfScope.join(', ')}. Disclose them and score the patch without them.`)
  if (patchText !== '') {
    // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the applied tree, so git apply works like patch(1).
    const apply = Bun.spawnSync(['git', 'apply', '--whitespace=nowarn', join(out, 'contracts.patch')], {cwd: appliedDir, env: {...process.env, GIT_CEILING_DIRECTORIES: work}})
    if (apply.exitCode !== 0) throw new Error(`git apply exited ${apply.exitCode}: ${apply.stderr.toString()}`)
  }
}
const patchedTextOf = (file: string) => readFileSync(join(appliedDir, file), 'utf8')
if (snapshotDir != null) {
  for (const subject of subjects) {
    if (sha1(readFileSync(join(snapshotDir, subject.file))) !== sha1(patchedTextOf(subject.file))) throw new Error(`${subject.file}: the applied patch differs from ${snapshotDir}'s file`)
  }
}

// -- 4b: trees, line maps, sites, entries, astmut@v1 regeneration and mapping -----------------------------------------------------

const works: CopyWork[] = []
const allMutants: MutantPlan[] = []
rules.data.copies.forEach((rule, copyIndex) => {
  const runCopy = runPlan.copies[copyIndex]
  if (runCopy?.copy !== rule.id) throw new Error(`the m7 plan's copy ${copyIndex} isn't ${rule.id}`)
  const listed = m7.copies.list.find((candidate) => candidate.id === rule.id)
  if (listed == null) throw new Error(`m7's copies.list has no ${rule.id}`)
  const entryFile = (file: FilePlan) => listed.files.find((candidate) => candidate.path === file.path)?.entries ?? false
  const subjectIndex = runCopy.files.findIndex(entryFile)
  const subjectPlan = runCopy.files[subjectIndex]
  if (subjectPlan == null || runCopy.files.filter(entryFile).length !== 1) throw new Error(`${rule.id}: expected one subject file`)
  const subject = subjects.find((candidate) => candidate.file === subjectPlan.path)
  if (subject?.copy !== rule.id) throw new Error(`${rule.id}: ${subjectPlan.path} isn't a registered subject file of this copy`)
  const texts = runCopy.files.map((file) => {
    const text = readFileSync(join(worktreeDir, file.path), 'utf8')
    const expected = m7.source.fileSha1[file.path]
    if (sha1(text) !== expected) throw new Error(`${file.path}: sha1 ${sha1(text)} differs from the m7 registration's ${expected ?? '(none)'}`)
    return text
  })
  const pinnedText = texts[subjectIndex]!
  const patchedText = patchedTextOf(subjectPlan.path)
  texts[subjectIndex] = patchedText
  const shim = rule.exportShim ?? []
  const shimmed = exportShimmed(texts, shim, rule.id)
  const nodeModules = runCopy.nodeModules

  // work/source: P uninstrumented with export@v1 (imports and witness verification); work/fr: P as written, with the worktree's
  // node_modules, which Freerange and the TypeScript program of astmut@v1 need; work/patched: P instrumented.
  const sourceRoot = join(work, 'source', rule.id)
  const frRoot = join(work, 'fr', rule.id)
  const patchedRoot = join(work, 'patched', rule.id)
  runCopy.files.forEach((file, index) => {
    writeFileWithDirs(join(sourceRoot, file.path), shimmed[index]!)
    writeFileWithDirs(join(frRoot, file.path), texts[index]!)
  })
  // The copy's files are its runtime closure; its type-only imports, e.g. `import type {Rect} from '@/MidUI/MidUI'`, need the
  // rest of the TypeScript closure, which m7 analyzed and ran Freerange in the worktree with. Those files go into the analysis
  // trees unchanged, and never into a tree anything imports at run time.
  const typeClosure = loadProgram([join(worktreeDir, subjectPlan.path)]).getSourceFiles().map((sourceFile) => sourceFile.fileName)
    .filter((path) => path.startsWith(`${worktreeDir}/src/`) && !runCopy.files.some((file) => path === join(worktreeDir, file.path)))
  for (const path of typeClosure) {
    const text = readFileSync(path, 'utf8')
    writeFileWithDirs(join(sourceRoot, path.slice(worktreeDir.length + 1)), text)
    writeFileWithDirs(join(frRoot, path.slice(worktreeDir.length + 1)), text)
  }
  finishTree(sourceRoot, tsconfig, nodeModules)
  finishTree(frRoot, tsconfig, worktreeNodeModules)
  const lineMap = lineMapOf(join(worktreeDir, subjectPlan.path), join(frRoot, subjectPlan.path), pinnedText, patchedText)
  const writerLineSet = new Set(lineMap.writerLines)
  const changedLineSet = new Set(lineMap.changedPinnedLines)

  const sites: Site[] = []
  const files: FilePlan[] = []
  runCopy.files.forEach((file, index) => {
    const source = join(sourceRoot, file.path)
    const instrumented = join(patchedRoot, file.path)
    const {output, sites: fileSites} = instrumentSource(shimmed[index]!, source, file.file, sites.length)
    writeFileWithDirs(instrumented, output)
    files.push({file: file.file, path: file.path, source, sourceSha1: sha1(shimmed[index]!), instrumented})
    sites.push(...fileSites)
  })
  finishTree(patchedRoot, tsconfig, nodeModules)

  // Sites: a site on a writer line is added; every other site is one of the run's, at its mapped line with the same column,
  // condition and function, e.g. the run's CoachmarkLayout:53 stays CoachmarkLayout:53 when the writer appends below it.
  const siteOfRun = new Array<number | null>(runCopy.sites.length).fill(null)
  const addedSites: number[] = []
  const siteProblems: string[] = []
  for (const site of sites) {
    const inSubject = site.file === subjectPlan.file
    if (inSubject && writerLineSet.has(site.line)) {
      addedSites.push(site.index)
      continue
    }
    const pinnedLine = inSubject ? lineMap.patchedToPinned[site.line] ?? null : site.line
    const matches = runCopy.sites.filter((candidate) => candidate.file === site.file && candidate.line === pinnedLine && candidate.column === site.column && candidate.text === site.text && candidate.functionName === site.functionName)
    const match = matches[0]
    if (matches.length !== 1 || match == null) {
      siteProblems.push(`patched site ${site.file}:${site.line}:${site.column} matches ${matches.length} run sites`)
      continue
    }
    if (siteOfRun[match.index] != null) siteProblems.push(`run site ${match.file}:${match.line} matched twice`)
    siteOfRun[match.index] = site.index
  }
  const runSitesOnChangedLines: string[] = []
  for (const runSite of runCopy.sites) {
    if (siteOfRun[runSite.index] != null) continue
    if (runSite.file === subjectPlan.file && changedLineSet.has(runSite.line)) runSitesOnChangedLines.push(`${runSite.file}:${runSite.line} ${runSite.text}`)
    else siteProblems.push(`run site ${runSite.file}:${runSite.line} on an unchanged line has no patched site`)
  }
  if (siteProblems.length > 0) throw new Error(`site map of ${rule.id}: ${siteProblems.join('; ')}`)

  // Entries keep the run's domains; their discard sites and precondition lines move to the mapped lines.
  const mapLine = (file: string, line: number) => {
    if (file !== subjectPlan.file) return line
    const mapped = lineMap.pinnedToPatched[line] ?? null
    if (mapped == null) throw new Error(`${rule.id}: the domain line ${file}:${line} is a changed line`)
    return mapped
  }
  const mapSite = (runSite: number) => {
    const mapped = siteOfRun[runSite] ?? null
    if (mapped == null) throw new Error(`${rule.id}: discard site ${runSite} is on a changed line`)
    return mapped
  }
  const entries: EntryPlan[] = runCopy.entries.map((entry) => ({
    ...entry,
    preconditions: entry.preconditions.map((precondition) => ({...precondition, line: mapLine(precondition.file, precondition.line)})),
    discardSites: entry.discardSites.map(mapSite),
    leakSites: entry.leakSites.map(mapSite),
  }))
  const program = loadProgram(files.map((file) => file.source))
  const patchedNames: string[] = []
  for (const file of files) {
    if (!(listed.files.find((candidate) => candidate.path === file.path)?.entries ?? false)) continue
    for (const entry of exportedEntries(program, file.source, file.file, patchedNames.length, rules.domain.version, runCopy.excludedEntries)) patchedNames.push(`${entry.name}${entry.unsupported == null ? '' : ' (unsupported)'}`)
  }
  const runNames = runCopy.entries.map((entry) => `${entry.name}${entry.unsupported == null ? '' : ' (unsupported)'}`)
  const contract: ContractCopy = {
    copy: rule.id, addedSites,
    addedLeading: entries.map((entry) => ({entry: entry.name, sites: addedSites.filter((site) => sites[site]!.leading && sites[site]!.functionName === entry.name && sites[site]!.file === entry.file)})),
  }

  // astmut@v1 on the patched file, then the registered match.
  const tableCopy = table.copies.find((candidate) => candidate.copy === rule.id)
  if (tableCopy == null) throw new Error(`the astmut table has no copy ${rule.id}`)
  const runRows = table.rows.filter((row) => row.copy === rule.id)
  const regenerated = astmutFile({copy: rule.id, file: subjectPlan.path, path: join(frRoot, subjectPlan.path), text: patchedText, exportShim: shim, excluded: runCopy.excludedEntries})
  const regenerationEqualsTable = empty ? JSON.stringify(regenerated) === JSON.stringify({rows: runRows, copy: tableCopy}) : null
  const lastLine = (row: AstmutRow) => row.line + newlines(row.before)
  const pinnedScope = new Set([...tableCopy.scopeFunctions, ...tableCopy.scopeConstants])
  let excludedWriterLines = 0
  let excludedNewScope = 0
  const candidates: AstmutRow[] = []
  for (const row of regenerated.rows) {
    if (row.status !== 'valid') continue
    let onWriterLine = false
    for (let line = row.line; line <= lastLine(row); line++) if (writerLineSet.has(line)) onWriterLine = true
    if (onWriterLine) excludedWriterLines += 1
    else if (!pinnedScope.has(row.function)) excludedNewScope += 1
    else candidates.push(row)
  }
  const matchCounts = new Map<AstmutRow, number>()
  const mapped: {key: string; id: string; family: string; changes: ChangeRule[]}[] = []
  const unmapped: string[] = []
  const mappingProblems: string[] = []
  const runValid = runRows.filter((row) => row.status === 'valid')
  for (const row of runValid) {
    const key = `${rule.id}/${row.id}`
    const spanned: number[] = []
    for (let line = row.line; line <= lastLine(row); line++) spanned.push(line)
    if (spanned.some((line) => changedLineSet.has(line))) {
      unmapped.push(key)
      continue
    }
    const line = lineMap.pinnedToPatched[row.line] ?? null
    if (line == null || spanned.some((pinned, offset) => lineMap.pinnedToPatched[pinned] !== line + offset)) {
      mappingProblems.push(`${key}: its lines don't map at one offset`)
      continue
    }
    const matches = candidates.filter((candidate) => candidate.function === row.function && candidate.operator === row.operator && candidate.before === row.before && candidate.after === row.after && candidate.column === row.column && candidate.line === line)
    const match = matches[0]
    if (matches.length !== 1 || match == null) {
      mappingProblems.push(`${key} (${row.function}:${row.line}:${row.column} ${row.operator} ${row.before} -> ${row.after}) matches ${matches.length} regenerated rows`)
      continue
    }
    matchCounts.set(match, (matchCounts.get(match) ?? 0) + 1)
    mapped.push({key, id: row.id, family: row.operator, changes: [match.change]})
  }
  for (const [row, count] of matchCounts) if (count > 1) mappingProblems.push(`regenerated ${row.function}:${row.line}:${row.column} ${row.operator} matches ${count} run rows`)
  if (mappingProblems.length > 0) throw new Error(`4b check on ${rule.id}: ${mappingProblems.join('; ')}`)
  const regeneratedWithoutRunRow = candidates.filter((row) => !matchCounts.has(row)).map((row) => `${row.function}:${row.line}:${row.column} ${row.operator} ${row.before} -> ${row.after}`)
  const plants: Mapping['plants'] = []
  for (const plant of extras.plants.filter((candidate) => candidate.copy === rule.id)) {
    const registered = m7.criterion1.planted.find((candidate) => candidate.id === plant.id)
    if (registered == null) throw new Error(`no registered plant ${plant.id}`)
    const key = `${rule.id}/${plant.id}`
    const applies = registered.changes.every((change) => {
      const start = pinnedText.indexOf(change.from)
      if (change.file !== subjectPlan.path || start < 0) return false
      const firstLine = newlines(pinnedText.slice(0, start)) + 1
      for (let line = firstLine; line <= firstLine + newlines(change.from); line++) if (changedLineSet.has(line)) return false
      return patchedText.split(change.from).length - 1 === 1
    })
    plants.push({key, mapped: applies})
    if (applies) mapped.push({key, id: plant.id, family: 'planted', changes: registered.changes})
  }

  // Mutant trees: the mapped change applied to P as written, then export@v1, instrumented, with the copy's sites.
  for (const item of mapped) {
    const root = join(work, 'mutants', item.key)
    const mutantTexts = exportShimmed(texts.map((text, index) => (index === subjectIndex ? applyChanges(text, item.changes, item.key) : text)), shim, item.key)
    const mutantFiles: FilePlan[] = []
    const mutantSites: Site[] = []
    runCopy.files.forEach((file, index) => {
      const source = join(root, 'source', file.path)
      const instrumented = join(root, file.path)
      writeFileWithDirs(source, mutantTexts[index]!)
      const {output, sites: fileSites} = instrumentSource(mutantTexts[index]!, source, file.file, mutantSites.length)
      writeFileWithDirs(instrumented, output)
      mutantFiles.push({file: file.file, path: file.path, source, sourceSha1: sha1(mutantTexts[index]!), instrumented})
      mutantSites.push(...fileSites)
    })
    finishTree(root, tsconfig, nodeModules)
    finishTree(join(root, 'source'), tsconfig, nodeModules)
    if (mutantSites.length !== sites.length || mutantSites.some((site, index) => site.key !== sites[index]!.key || site.line !== sites[index]!.line)) throw new Error(`site check: ${item.key} has other site keys or lines than the patched copy`)
    const changedFiles = mutantFiles.filter((file, index) => file.sourceSha1 !== files[index]!.sourceSha1).map((file) => file.file)
    if (changedFiles.length === 0) throw new Error(`${item.key}: the mutant tree is identical to the patched copy`)
    allMutants.push({key: item.key, id: item.id, copy: rule.id, family: item.family, files: mutantFiles, changedFiles})
  }

  works.push({
    runCopy, copy: {copy: rule.id, files, sites, entries, excludedEntries: runCopy.excludedEntries, nodeModules}, contract, subject: subjectPlan, pinnedText, patchedText, frRoot, lineMap,
    entryNames: {run: runNames, patched: patchedNames}, runSitesOnChangedLines,
    mapping: {runValid: runValid.length, matched: matchCounts.size, unmapped, excludedWriterLines, excludedNewScope, regeneratedWithoutRunRow, plants, regenerationEqualsTable},
  })
  log(`${rule.id}: ${pinnedText === patchedText ? 'untouched' : `${lineMap.writerLines.length} writer lines`}, ${addedSites.length} added sites, ${mapped.length} mapped mutants, ${unmapped.length} unmapped`)
})

const plan: Plan = {settings: runPlan.settings, stepBudget: runPlan.stepBudget, copies: works.map((copyWork) => copyWork.copy), mutants: allMutants}
const planPath = join(out, 'plan.json')
writeFileSync(planPath, encodeJson(plan))
const contractPlan: ContractPlan = {runPlan: runPlanPath, copies: works.map((copyWork) => copyWork.contract)}
const contractPath = join(out, 'contract.json')
writeFileSync(contractPath, `${JSON.stringify(contractPlan, null, 1)}\n`)

// -- 4a, 4c, 4d rows, 4e: the domain and P, per copy ----------------------------------------------------------------------

const children: ChildRecord[] = []
const heartbeatTimeoutMs = rules.execution.heartbeatTimeoutSeconds * 1000
const childLimitMs = (copy: CopyPlan) => {
  let seconds = STARTUP_SECONDS
  for (const entry of copy.entries) if (entry.unsupported == null) seconds += (runPlan.settings.budget * 2 * (baseline.get(`${copy.copy}.${entry.name}`)?.nsPerCall ?? 0)) / 1e9
  return (3 * seconds + 30) * 1000
}
const eligibilityPath = (copy: string) => join(work, 'eligibility', `${copy}.json`)
mkdirSync(join(work, 'eligibility'))
const noteChild = (job: string, run: ChildRun) => {
  children.push({job, exitCode: run.exitCode, timedOut: run.timedOut, ms: run.ms, maxRssKb: run.done?.maxRssKb ?? null, stderrTail: run.stderr.slice(-500)})
  return run.exitCode !== 0 || run.timedOut != null || run.done == null
}

log('cw-prepare: the run\'s domain and the patched files')
const prepareLines = new Map<string, ContractPrepareLine>()
await pool(works, rules.execution.children, async (copyWork) => {
  const job: Job = {mode: 'cw-prepare', plan: planPath, contract: contractPath, base: copyWork.copy.copy, eligibility: eligibilityPath(copyWork.copy.copy)}
  const run = await runChild(job, childLimitMs(copyWork.copy), heartbeatTimeoutMs, (line) => {
    if (line.type !== 'cw-prepare') return
    prepareLines.set(`${line.base}.${line.entry}`, line)
    appendFileSync(join(out, 'prepare.jsonl'), `${encodeJson(line)}\n`)
  })
  if (noteChild(`cw-prepare ${copyWork.copy.copy}`, run)) throw new Error(`cw-prepare ${copyWork.copy.copy} failed: exit ${run.exitCode} ${run.timedOut ?? ''}\n${run.stderr}`)
})
const domainProblems: string[] = []
for (const copyWork of works) {
  for (const entry of copyWork.runCopy.entries) {
    if (entry.unsupported != null) continue
    const key = `${copyWork.copy.copy}.${entry.name}`
    const line = prepareLines.get(key)
    const recorded = baseline.get(key)
    if (line == null || recorded == null) {
      domainProblems.push(`${key}: no cw-prepare line or no baseline line`)
      continue
    }
    if (line.digest !== entry.digest) domainProblems.push(`${key}: digest ${line.digest} differs from the plan's ${entry.digest}`)
    const recordedInDomain = recorded.inputs - recorded.discarded - recorded.callerDiscarded - recorded.overBudget
    if (line.inDomain !== recordedInDomain || line.discarded !== recorded.discarded || line.overBudget !== recorded.overBudget) domainProblems.push(`${key}: in-domain ${line.inDomain}, discarded ${line.discarded}, past the budget ${line.overBudget}; baseline.jsonl ${recordedInDomain}, ${recorded.discarded}, ${recorded.overBudget}`)
  }
}
if (domainProblems.length > 0) throw new Error(`4a domain check: ${domainProblems.join('; ')}`)

// 4c: a file with a behaviour difference, or other supported entry names, is scored as the run's own.
const behaviourOf = new Map(works.map((copyWork) => {
  const lines = copyWork.copy.entries.filter((entry) => entry.unsupported == null).map((entry) => prepareLines.get(`${copyWork.copy.copy}.${entry.name}`)!)
  const differing = lines.find((line) => line.behavior.count > 0) ?? null
  const namesDiffer = copyWork.entryNames.run.join('\n') !== copyWork.entryNames.patched.join('\n')
  return [copyWork.copy.copy, {excluded: namesDiffer || differing != null, namesDiffer, differing}]
}))
const excludedCopies = new Set([...behaviourOf].filter(([, behaviour]) => behaviour.excluded).map(([copy]) => copy))

// -- 4a: the mutant pass -------------------------------------------------------------------------------------------------

const scoredMutants = allMutants.filter((mutant) => !excludedCopies.has(mutant.copy))
log(`cw-mutant: ${scoredMutants.length} mutants (${allMutants.length - scoredMutants.length} on behaviour-excluded copies are scored as the run's own)`)
const outcomes = new Map<string, MutantOutcome>()
let finished = 0
await pool(scoredMutants, rules.execution.children, async (mutant) => {
  const copy = plan.copies.find((candidate) => candidate.copy === mutant.copy)!
  const outcome: MutantOutcome = {key: mutant.key, entries: 0, killSites: new Set(), quietFile: false, first: null, behaviorDiffs: 0, eligibilityMismatches: 0, digestMismatches: 0, failure: null}
  outcomes.set(mutant.key, outcome)
  const run = await runChild({mode: 'cw-mutant', plan: planPath, mutant: mutant.key, eligibility: eligibilityPath(mutant.copy)}, childLimitMs(copy), heartbeatTimeoutMs, (line) => {
    if (line.type !== 'cw-result') return
    appendFileSync(join(out, 'results.jsonl'), `${encodeJson(line)}\n`)
    outcome.entries += 1
    outcome.behaviorDiffs += line.behavior.count
    outcome.eligibilityMismatches += line.eligibilityMismatches
    if (line.digest !== copy.entries.find((entry) => entry.name === line.entry)?.digest) outcome.digestMismatches += 1
    for (const kill of line.kills) {
      outcome.killSites.add(kill.site)
      if (kill.quietFileCount > 0) outcome.quietFile = true
      if (outcome.first == null || kill.first.index < outcome.first.first.index) outcome.first = {entry: line.entry, site: kill.site, first: kill.first}
    }
  })
  const expectedEntries = copy.entries.filter((entry) => entry.unsupported == null).length
  if (noteChild(`cw-mutant ${mutant.key}`, run) || outcome.entries !== expectedEntries) {
    outcome.failure = run.timedOut ?? `exit ${run.exitCode}, ${outcome.entries} of ${expectedEntries} entries: ${run.stderr.slice(-300)}`
    appendFileSync(join(out, 'results.jsonl'), `${encodeJson({type: 'failure', mutant: mutant.key, base: mutant.copy, exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr})}\n`)
  }
  finished += 1
  if (finished % 100 === 0) log(`mutants done ${finished}/${scoredMutants.length}`)
})
const determinism = [...outcomes.values()].filter((outcome) => outcome.eligibilityMismatches > 0 || outcome.digestMismatches > 0)
if (determinism.length > 0) throw new Error(`cw-mutant disagrees with cw-prepare: ${determinism.map((outcome) => `${outcome.key} usable-input mismatches ${outcome.eligibilityMismatches}, digest mismatches ${outcome.digestMismatches}`).join('; ')}`)

// -- 4d: witness runs on c13-tooltip -------------------------------------------------------------------------------------

async function witnessRun(name: string, sets: WitnessSet[]): Promise<WitnessTable> {
  const dir = join(work, `witness-${name}`)
  const setsPath = join(work, `witness-sets-${name}.json`)
  const setsFile: PatchedWitnessSets = {
    scratch, reservoir: m7.scoringWitness.reservoir, childHardLimitMinutes: m7.scoringWitness.gates.childHardLimitMinutes, sets,
    measuredOn: `contract-writing-v1 writer ${writer}: ${sets.map((set) => set.name).join(', ')} against the patched trees of ${planPath}`,
  }
  writeFileSync(setsPath, `${JSON.stringify(setsFile, null, 1)}\n`)
  const child = Bun.spawn(['bun', WITNESS_RUN, '--patched-plan', planPath, '--sets', setsPath, '--out', dir], {stdout: Bun.file(join(work, `witness-${name}.log`)), stderr: Bun.file(join(work, `witness-${name}.stderr.log`))})
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`witness-run ${name} exited ${exitCode}; see ${join(work, `witness-${name}.stderr.log`)}`)
  return decodeJson(readFileSync(join(dir, `witness-mj-gallery-${TOOLTIP_COPY}.json`), 'utf8')) as WitnessTable
}
log('witness runs: W1 sweep5 and shrink-sweep caller rows on the patched c13-tooltip')
const w1 = m7.scoringWitness.witnessSets.find((set) => set.name === 'W1 sweep5')
if (w1?.scriptSha1 !== registration.sources.witnessScriptW1.sha1) throw new Error('the m7 registration has no W1 sweep5 with the registered sha1')
const w1Table = await witnessRun('w1', [{family: 'mj-gallery', name: w1.name, script: w1.script, scriptSha1: w1.scriptSha1, args: w1.args, substitute: w1.substitute, tiers: w1.tiers, copies: w1.copies}])
const shrinkScriptSha1 = sha1(readFileSync(join(scratch, SHRINK_SWEEP.script)))
const shrinkTable = await witnessRun('shrink', [{family: 'mj-gallery', name: 'shrink-sweep caller rows', script: SHRINK_SWEEP.script, scriptSha1: shrinkScriptSha1, args: ['{wrapper}/src/components/common/tooltipLayout.ts'], substitute: {from: SHRINK_SWEEP.line, to: SHRINK_SWEEP.line}, tiers: 'all', copies: [TOOLTIP_COPY]}])

// -- 4f: Freerange ------------------------------------------------------------------------------------------------------

log('Freerange audit and findings on each subject file')
const frHead = gitOutput(['rev-parse', 'HEAD'], frDir)
type AssertRecord = {copy: string; functionName: string | null; line: number; column: number; leading: boolean; condition: string; status: AssertStatus; evidence: string[]}
const asserts: AssertRecord[] = []
const frReference: {copy: string; equal: boolean}[] = []
for (const copyWork of works) {
  const copyId = copyWork.copy.copy
  const audit = Bun.spawnSync(['bun', FR, '--audit', copyWork.subject.path], {cwd: copyWork.frRoot, timeout: 300_000})
  const findings = Bun.spawnSync(['bun', FR, copyWork.subject.path], {cwd: copyWork.frRoot, timeout: 300_000})
  const auditText = audit.stdout.toString()
  const findingsText = findings.stdout.toString()
  writeFileSync(join(out, `fr-${copyId}-audit.txt`), `fr revision ${frHead}; exit ${audit.exitCode}\n${auditText}${audit.stderr.toString()}`)
  writeFileSync(join(out, `fr-${copyId}.txt`), `fr revision ${frHead}; exit ${findings.exitCode}\n${findingsText}${findings.stderr.toString()}`)
  if (empty) {
    const recorded = readFileSync(join(m7RunDir, `fr-${copyId}-${copyWork.subject.file}.txt`), 'utf8')
    frReference.push({copy: copyId, equal: recorded.slice(recorded.indexOf('\n') + 1) === `${findingsText}${findings.stderr.toString()}`})
  }
  const typeErrors = /error TS\d+/.test(audit.stderr.toString() + findings.stderr.toString())
  const auditFunctions = parseAudit(auditText)
  const frFindings = parseFindings(findingsText)
  for (const siteIndex of copyWork.contract.addedSites) {
    const site = copyWork.copy.sites[siteIndex]!
    const verdict = assertVerdict(site, auditFunctions, frFindings, typeErrors)
    asserts.push({copy: copyId, functionName: site.functionName, line: site.line, column: site.column, leading: site.leading, condition: site.text, status: verdict.status, evidence: verdict.evidence})
  }
}

// -- Scores ------------------------------------------------------------------------------------------------------------

const plannedKeys = new Set(allMutants.map((mutant) => mutant.key))
const addedOf = new Map(works.map((copyWork) => [copyWork.copy.copy, new Set(copyWork.contract.addedSites)]))
type KillState = {killed: boolean; unmapped: boolean; runOwn: boolean; throughAdded: boolean; throughOriginal: boolean; quietFile: boolean; failure: string | null}
const killState = (key: string): KillState => {
  const copy = key.slice(0, key.indexOf('/'))
  if (excludedCopies.has(copy)) {
    const row = killsByKey.get(key)
    return {killed: row != null && cellOf(row, 'kill_noise@abs1e-9') === 'true', unmapped: false, runOwn: true, throughAdded: false, throughOriginal: false, quietFile: false, failure: null}
  }
  const outcome = outcomes.get(key) ?? null
  if (outcome == null) return {killed: false, unmapped: !plannedKeys.has(key), runOwn: false, throughAdded: false, throughOriginal: false, quietFile: false, failure: plannedKeys.has(key) ? 'planned but not run' : null}
  const added = addedOf.get(copy)!
  const killing = [...outcome.killSites]
  return {killed: killing.length > 0, unmapped: false, runOwn: false, throughAdded: killing.some((site) => added.has(site)), throughOriginal: killing.some((site) => !added.has(site)), quietFile: outcome.quietFile, failure: outcome.failure}
}

// 4a: counts against survivor-classes.json and kills.tsv, whose totals must be the registered ones.
const survivorKeys = new Set(survivorClasses.survivors.map((survivor) => survivor.key))
const classes = Object.entries(survivorClasses.classTotals).map(([name, total]) => {
  const members = survivorClasses.survivors.filter((survivor) => survivor.class === name)
  if (members.length !== total) throw new Error(`survivor class ${name}: ${members.length} survivors, registered ${total}`)
  const states = members.map((survivor) => killState(survivor.key))
  return {class: name, of: total, killed: states.filter((state) => state.killed).length, unmapped: states.filter((state) => state.unmapped).length}
})
const newlyKilled = survivorClasses.survivors.map((survivor) => ({key: survivor.key, state: killState(survivor.key)})).filter((item) => item.state.killed)
const behaviourChanging = killsRows.filter((row) => cellOf(row, 'planted') === 'false' && cellOf(row, 'lattice_equivalent') === 'false').map((row) => cellOf(row, 'mutant'))
const plantedKeys = killsRows.filter((row) => cellOf(row, 'planted') === 'true').map((row) => cellOf(row, 'mutant'))
if (survivorKeys.size !== 463 || behaviourChanging.length !== 696 || plantedKeys.length !== 7) throw new Error(`registered totals: ${survivorKeys.size} survivors, ${behaviourChanging.length} behaviour-changing, ${plantedKeys.length} plants`)
const countOf = (keys: string[]) => ({of: keys.length, killed: keys.filter((key) => killState(key).killed).length, unmapped: keys.filter((key) => killState(key).unmapped).length})
// survivor-classes.json names m7's killed behaviour-changing mutants by id, e.g. m7-c01-coachmark-006; kills.tsv holds their keys.
const keyOfId = new Map(killsRows.map((row) => [cellOf(row, 'id'), cellOf(row, 'mutant')]))
const runKilledKeys = survivorClasses.killedBehaviourChanging.map((id) => {
  const key = keyOfId.get(id)
  if (key == null) throw new Error(`survivor-classes.json names ${id}, which kills.tsv doesn't hold`)
  return key
})
if (runKilledKeys.length !== 233) throw new Error(`survivor-classes.json lists ${runKilledKeys.length} killed behaviour-changing mutants, registered 233`)
const lostRunKills = runKilledKeys.filter((key) => !killState(key).killed).map((key) => ({key, unmapped: killState(key).unmapped}))
const failures = [...outcomes.values()].filter((outcome) => outcome.failure != null).map((outcome) => `${outcome.key}: ${outcome.failure}`)

// 4d rows and the witness split; preconditions the witness calls violate.
const witnessOf = (tableOfSets: WitnessTable, entry: string, key: string) => {
  let verified = 0
  let stored = 0
  for (const reservoir of tableOfSets.entries.find((candidate) => candidate.name === entry)?.sites.find((candidate) => candidate.key === key)?.reservoirs ?? []) {
    verified += reservoir.verified
    stored += reservoir.stored
  }
  return {verified, stored}
}
const rowRecords = works.flatMap((copyWork) => copyWork.copy.entries.filter((entry) => entry.unsupported == null).flatMap((entry) => prepareLines.get(`${copyWork.copy.copy}.${entry.name}`)!.rows.map((row) => {
  const site = copyWork.copy.sites[row.site]!
  const witness = copyWork.copy.copy === TOOLTIP_COPY ? witnessOf(w1Table, entry.name, site.key) : {verified: 0, stored: 0}
  return {copy: copyWork.copy.copy, entry: entry.name, siteKey: site.key, line: site.line, condition: site.text, cause: row.cause, count: row.count, firstInput: formatFirst(entry.name, row.first), witnessed: witness.verified > 0, witnessVerified: witness.verified, witnessStored: witness.stored}
})))
const distinctSites = (records: typeof rowRecords) => new Set(records.map((record) => `${record.copy}|${record.siteKey}`)).size
const tooltip = works.find((copyWork) => copyWork.copy.copy === TOOLTIP_COPY)!
const preconditionCounts = (tableOfSets: WitnessTable, entryNames: string[]) => tooltip.contract.addedLeading.filter((leading) => entryNames.includes(leading.entry)).flatMap((leading) => leading.sites.map((siteIndex) => {
  const site = tooltip.copy.sites[siteIndex]!
  const witnessEntry = tableOfSets.entries.find((candidate) => candidate.name === leading.entry)
  return {entry: leading.entry, siteKey: site.key, line: site.line, condition: site.text, calls: witnessEntry?.calls ?? 0, domainLineFired: witnessEntry?.domainLineFired ?? 0, violatedWithoutDomainLine: witnessEntry?.raised.find((candidate) => candidate.key === site.key)?.withoutDomainLine ?? 0}
}))
const w1Preconditions = preconditionCounts(w1Table, W1_ENTRIES)
const shrinkPreconditions = preconditionCounts(shrinkTable, ['shrinkRow'])

// 4e: per subject entry, the in-domain share its added leading asserts reject.
const subjectEntries = subjects.flatMap((subject) => subject.functions.map((fn) => ({copy: subject.copy, entry: fn.name})))
if (subjectEntries.length !== 17) throw new Error(`expected 17 subject entries, found ${subjectEntries.length}`)
const shrink = subjectEntries.map(({copy, entry}) => {
  const line = prepareLines.get(`${copy}.${entry}`)
  if (line == null) throw new Error(`no cw-prepare line for ${copy}.${entry}`)
  const leadingSites = works.find((copyWork) => copyWork.copy.copy === copy)!.contract.addedLeading.find((leading) => leading.entry === entry)?.sites ?? []
  return {copy, entry, addedLeadingAsserts: leadingSites.length, inDomain: line.inDomain, rejected: line.addedLeadingRaised, share: line.inDomain === 0 ? 0 : line.addedLeadingRaised / line.inDomain}
})
let shareSum = 0
let shareMax = 0
for (const item of shrink) {
  shareSum += item.share
  shareMax = Math.max(shareMax, item.share)
}

// 4f counts.
const statusCounts = (records: AssertRecord[]) => {
  const counts: Record<string, number> = {}
  for (const record of records) counts[record.status] = (counts[record.status] ?? 0) + 1
  return counts
}
const interior = asserts.filter((record) => !record.leading)
const leadingAsserts = asserts.filter((record) => record.leading)

// -- Gate G-R0 ----------------------------------------------------------------------------------------------------------

let gate: Record<string, unknown> | null = null
if (empty) {
  const killMismatches = killsRows.filter((row) => (cellOf(row, 'kill_noise@abs1e-9') === 'true') !== killState(cellOf(row, 'mutant')).killed).map((row) => cellOf(row, 'mutant'))
  const equivalenceMismatches = killsRows.filter((row) => cellOf(row, 'planted') === 'false').filter((row) => {
    const outcome = outcomes.get(cellOf(row, 'mutant')) ?? null
    const equivalent = outcome != null && outcome.failure == null && outcome.behaviorDiffs === 0
    return (cellOf(row, 'lattice_equivalent') === 'true') !== equivalent
  }).map((row) => cellOf(row, 'mutant'))
  const regenerationDifferences = works.filter((copyWork) => copyWork.mapping.regenerationEqualsTable !== true).map((copyWork) => copyWork.copy.copy)
  const frDifferences = frReference.filter((reference) => !reference.equal).map((reference) => reference.copy)
  const structural = works.filter((copyWork) => copyWork.contract.addedSites.length > 0 || copyWork.mapping.unmapped.length > 0 || copyWork.mapping.excludedWriterLines + copyWork.mapping.excludedNewScope > 0 || copyWork.mapping.regeneratedWithoutRunRow.length > 0).map((copyWork) => copyWork.copy.copy)
  const pass = killMismatches.length === 0 && equivalenceMismatches.length === 0 && regenerationDifferences.length === 0 && frDifferences.length === 0 && structural.length === 0 && failures.length === 0 && excludedCopies.size === 0 && plannedKeys.size === killsRows.length
  gate = {
    pass, mutants: killsRows.length, planned: plannedKeys.size, killMismatches, equivalenceMismatches, regenerationDifferences, frDifferences, structural, failures, excludedCopies: [...excludedCopies],
    checkedBeforeScoring: 'every entry digest, in-domain count, discard count and past-the-budget count equals baseline.jsonl and plan.json (the run refuses otherwise)',
  }
  writeFileSync(join(out, 'gate.json'), `${JSON.stringify(gate, null, 1)}\n`)
  log(`gate G-R0: ${pass ? 'pass' : 'fail'}; kill mismatches ${killMismatches.length}, lattice_equivalent mismatches ${equivalenceMismatches.length}, astmut regeneration differences ${regenerationDifferences.length}, Freerange reference differences ${frDifferences.length}, structural ${structural.length}, failures ${failures.length}`)
  if (!pass) process.exitCode = 1
}

// -- Outputs ------------------------------------------------------------------------------------------------------------

const classOf = new Map(survivorClasses.survivors.map((survivor) => [survivor.key, survivor.class]))
const mutantTsv = [['mutant', 'copy', 'survivor_class', 'planted', 'lattice_equivalent_m7', 'killed_m7', 'state', 'killed', 'through_added_sites', 'through_original_sites', 'kill_quietFile', 'killing_sites', 'first_killing_input', 'failure'].join('\t')]
for (const row of killsRows) {
  const key = cellOf(row, 'mutant')
  const state = killState(key)
  const outcome = outcomes.get(key) ?? null
  const copy = plan.copies.find((candidate) => candidate.copy === cellOf(row, 'copy'))!
  const killing = outcome == null ? [] : [...outcome.killSites].sort((left, right) => left - right).map((site) => `${copy.sites[site]!.file}:${copy.sites[site]!.line}${addedOf.get(copy.copy)!.has(site) ? ' (added)' : ''}`)
  mutantTsv.push([key, cellOf(row, 'copy'), classOf.get(key) ?? '', cellOf(row, 'planted'), cellOf(row, 'lattice_equivalent'), cellOf(row, 'kill_noise@abs1e-9'), state.runOwn ? 'scored as the run\'s own (behaviour-excluded copy)' : state.unmapped ? 'unmapped' : 'scored', state.killed, state.throughAdded, state.throughOriginal, state.quietFile, killing.join(', '), outcome?.first == null ? '' : formatFirst(outcome.first.entry, outcome.first.first), state.failure ?? ''].map(tsvCell).join('\t'))
}
writeFileSync(join(out, 'mutants.tsv'), `${mutantTsv.join('\n')}\n`)
const rowsTsv = [['copy', 'entry', 'site_key', 'line', 'condition', 'cause', 'firing_inputs', 'witnessed', 'witness_verified_of_stored', 'first_firing_input'].join('\t')]
for (const record of rowRecords) rowsTsv.push([record.copy, record.entry, record.siteKey, record.line, record.condition, record.cause, record.count, record.witnessed, `${record.witnessVerified}/${record.witnessStored}`, record.firstInput].map(tsvCell).join('\t'))
writeFileSync(join(out, 'rows.tsv'), `${rowsTsv.join('\n')}\n`)
const assertsTsv = [['copy', 'function', 'line', 'column', 'leading', 'condition', 'status', 'evidence'].join('\t')]
for (const record of asserts) assertsTsv.push([record.copy, record.functionName, record.line, record.column, record.leading, record.condition, record.status, record.evidence.join(' | ')].map(tsvCell).join('\t'))
writeFileSync(join(out, 'asserts.tsv'), `${assertsTsv.join('\n')}\n`)

const summary = {
  id: registration.id, writer, empty, registrationSha1: REGISTRATION_SHA1, patchSha1, snapshot: snapshotDir,
  instrument: {commit: instrumentCommit, dirty: instrumentDirty, sha1: instrumentSha1}, freerange: {head: frHead, registeredRevision: frRevision, differenceOutsideInstrument: `none apart from knip.config.ts: ${knipDifference.split('\n').filter((line) => /^[+-][^+-]/.test(line)).join(' ')}`}, bun: Bun.version,
  started, finished: new Date().toISOString(), wallSeconds: (performance.now() - wallStart) / 1000,
  copies: works.map((copyWork) => {
    const behaviour = behaviourOf.get(copyWork.copy.copy)!
    const entryLines = copyWork.copy.entries.filter((entry) => entry.unsupported == null).map((entry) => prepareLines.get(`${copyWork.copy.copy}.${entry.name}`)!)
    return {
      copy: copyWork.copy.copy, file: copyWork.subject.path, touched: copyWork.pinnedText !== copyWork.patchedText, writerLines: copyWork.lineMap.writerLines.length, changedPinnedLines: copyWork.lineMap.changedPinnedLines,
      addedSites: copyWork.contract.addedSites.length, addedLeading: copyWork.contract.addedLeading.filter((leading) => leading.sites.length > 0).map((leading) => ({entry: leading.entry, sites: leading.sites.map((site) => copyWork.copy.sites[site]!.text)})),
      runSitesOnChangedLines: copyWork.runSitesOnChangedLines, entryNames: copyWork.entryNames, mapping: copyWork.mapping,
      behaviour: {
        excluded: behaviour.excluded, entryNamesDiffer: behaviour.namesDiffer,
        firstDifference: behaviour.differing == null ? null : {entry: behaviour.differing.entry, count: behaviour.differing.behavior.count, input: formatFirst(behaviour.differing.entry, behaviour.differing.behavior.first), detail: behaviour.differing.behavior.detail},
        skippedInputs: entryLines.map((line) => ({entry: line.entry, skipped: line.behaviorSkipped})).filter((item) => item.skipped > 0),
        patchedPastBudget: entryLines.filter((line) => line.patchedOverBudget.count > 0).map((line) => ({entry: line.entry, count: line.patchedOverBudget.count, input: formatFirst(line.entry, line.patchedOverBudget.first)})),
        patchedThrewWhereOriginalReturned: entryLines.filter((line) => line.patchedThrew.count > 0).map((line) => ({entry: line.entry, count: line.patchedThrew.count, detail: line.patchedThrew.detail})),
      },
      usableInputs: entryLines.map((line) => ({entry: line.entry, inDomain: line.inDomain, usable: line.usable})),
    }
  }),
  '4a': {
    rule: 'a mutant is killed when some site kills on some usable input of some supported entry of its copy (level >= 3 on the mutant, below 3 on P); unmapped mutants count as not killed; a behaviour-excluded copy takes kills.tsv',
    classes, survivors: countOf([...survivorKeys]), behaviourChanging: countOf(behaviourChanging), planted: countOf(plantedKeys),
    beside: {
      newlyKilledThroughAddedSitesOnly: newlyKilled.filter((item) => item.state.throughAdded && !item.state.throughOriginal).length,
      newlyKilledThroughOriginalSitesOnly: newlyKilled.filter((item) => !item.state.throughAdded && item.state.throughOriginal).length,
      newlyKilledThroughBoth: newlyKilled.filter((item) => item.state.throughAdded && item.state.throughOriginal).length,
      newlyKilledWithAQuietFileKill: newlyKilled.filter((item) => item.state.quietFile).length,
      m7KillsLost: lostRunKills,
    },
    failures, excludedCopies: [...excludedCopies],
  },
  '4d': {
    rule: 'a row is (copy, entry, added site key, cause class) with an in-domain input where the added site reaches level >= 3 on P and no added leading assert of the entry reaches level >= 2; witnessed when a W1 sweep5 call of the entry fires no run domain line, records the site at level >= 3 and records the site line and no domain line on the uninstrumented patched copy',
    rows: rowRecords.length, unwitnessedRows: rowRecords.filter((record) => !record.witnessed).length, witnessedRows: rowRecords.filter((record) => record.witnessed).length,
    sitesWithUnwitnessedRows: distinctSites(rowRecords.filter((record) => !record.witnessed)), sitesWithWitnessedRows: distinctSites(rowRecords.filter((record) => record.witnessed)),
    w1Preconditions, beside: {shrinkSweepPreconditions: shrinkPreconditions, shrinkSweepScriptSha1: shrinkScriptSha1},
    w1Calls: w1Table.entries.map((entry) => ({entry: entry.name, calls: entry.calls})),
  },
  '4e': {rule: 'per subject entry: in-domain inputs where an added leading assert of the entry reaches level >= 2 on P, over the entry\'s in-domain inputs; mean over the 17 subject entries (0 without an added leading assert) and the largest', entries: shrink, mean: shareSum / shrink.length, max: shareMax},
  '4f': {
    rule: 'cw-freerange.ts: interior asserts proved, could not prove, can be false, unreachable, not analyzed; leading asserts accepted or rejected',
    addedAsserts: asserts.length, interior: interior.length, leading: leadingAsserts.length, interiorStatuses: statusCounts(interior), leadingStatuses: statusCounts(leadingAsserts),
    frReference: empty ? frReference : null,
  },
  gate,
  children: {count: children.length, maxRssKb: Math.max(0, ...children.map((child) => child.maxRssKb ?? 0)), seconds: children.reduce((sum, child) => sum + child.ms, 0) / 1000, prepare: children.filter((child) => child.job.startsWith('cw-prepare'))},
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`)
log(`4a: survivors killed ${summary['4a'].survivors.killed} of 463 (${summary['4a'].survivors.unmapped} unmapped); behaviour-changing killed ${summary['4a'].behaviourChanging.killed} of 696; plants ${summary['4a'].planted.killed} of 7`)
log(`4d: ${summary['4d'].unwitnessedRows} unwitnessed rows on ${summary['4d'].sitesWithUnwitnessedRows} sites, ${summary['4d'].witnessedRows} witnessed; 4e mean ${summary['4e'].mean.toFixed(4)}, max ${summary['4e'].max.toFixed(4)}; 4f ${asserts.length} added asserts ${JSON.stringify(summary['4f'].interiorStatuses)} leading ${JSON.stringify(summary['4f'].leadingStatuses)}`)
log(`done in ${((performance.now() - wallStart) / 1000).toFixed(1)} s`)
