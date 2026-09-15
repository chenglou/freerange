// The sweep's parent side, in the `fr` process. It never imports project code: it builds sites and entries from the
// TypeScript program, writes an instrumented and an uninstrumented copy of the analyzed file into a new temp directory
// with every import specifier resolved to an absolute path, and runs child.ts there under limits. Structure from
// mutation-instrument-spike at bccf0dd (children.ts runChild); the process group, environment allowlist, load step, RSS
// poller and output cap are new.
import {spawn, type ChildProcessByStdio} from 'node:child_process'
import {existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, extname, join} from 'node:path'
import type {Readable} from 'node:stream'
import * as ts from 'typescript'
import {hasExport, sweepEntries, type SweepFilters} from './analyze.ts'
import {capUnboundedEnds} from './domain.ts'
import {instrumentSource} from './instrument.ts'
import type {ChildLine, DiscardCause, EntryLine, Site, SweepEntry, SweepJob, VerifiedLine, VerifyItem} from './types.ts'

const CHILD = new URL('./child.ts', import.meta.url).pathname
// The longest protocol line the parent keeps; a longer line, e.g. project output with no newline, is dropped until its end.
const MAX_LINE_CHARACTERS = 8 * 1024 * 1024
// After the child exits, how long the parent keeps reading its pipes. A process that project code started outside the
// child's process group, e.g. a detached `sleep 30`, can hold the pipes open, and the parent must not wait for it.
export const DRAIN_MS = 500
// After a kill, how long the parent waits for the child's exit before it stops waiting anyway.
const KILL_WAIT_MS = 2000

export type SweepLimits = {
  inputsPerEntry: number
  entriesPerFile: number
  sitesPerFile: number
  stepBudget: number
  heartbeatEvery: number
  loadMs: number
  heartbeatMs: number
  hardMs: number // run and verification phases together
  rssKb: number
  pollMs: number
  psMs: number // how long one `ps` may take to report the child's RSS
  outputBytes: number
  verifyItems: number
  verifyMs: number
  printed: number
  inputBytes: number
  held: number
}

export const DEFAULT_LIMITS: SweepLimits = {
  inputsPerEntry: 100_000, entriesPerFile: 64, sitesPerFile: 4096, stepBudget: 1000, heartbeatEvery: 1024, loadMs: 20_000, heartbeatMs: 10_000,
  hardMs: 120_000, rssKb: 1024 * 1024, pollMs: 100, psMs: 5000, outputBytes: 16 * 1024 * 1024, verifyItems: 64, verifyMs: 20_000, printed: 64, inputBytes: 2048, held: 1000,
}

export type SweepSettings = {filters: SweepFilters; cap: number; limits: SweepLimits}

// 'RSS poller': `ps` could not run or didn't report within `psMs`, so the RSS limit can't be enforced and the child is stopped.
export type KillReason = 'RSS' | 'heartbeat' | 'hard limit' | 'output cap' | 'load step' | 'RSS poller'

export type ChildRun = {
  killed: KillReason | null
  exitCode: number | null
  loaded: boolean
  loadError: string | null
  crash: string | null // the child's `crashed` line: its own code threw outside a project call
  pollerError: string | null // why the RSS poller stopped the child
  heldOpen: boolean // the pipes were still open DRAIN_MS after the child exited, and the parent stopped reading them
  stderrTail: string
  peakRssKb: number
  doneMaxRssKb: number | null
  ms: number
}

type ChildLimits = {loadMs: number; heartbeatMs: number; hardMs: number; rssKb: number; pollMs: number; psMs: number; outputBytes: number}

/**
 * Runs one child to completion or to a limit. The child is detached into its own process group, so a SIGKILL of the group
 * stops everything it started inside the group; the group is killed when the run ends, on every path. Lines after the
 * output cap are not read. The run ends when the child's pipes close, DRAIN_MS after the child exits, or KILL_WAIT_MS
 * after a kill the child didn't exit from, whichever comes first.
 */
export function runChild(jobPath: string, cwd: string, limits: ChildLimits, onLine: (line: ChildLine) => void): Promise<ChildRun> {
  const started = performance.now()
  const environment: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name]
    if (value != null) environment[name] = value
  }
  const child = spawn(process.execPath, [CHILD, jobPath], {cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment})
  const run: ChildRun = {killed: null, exitCode: null, loaded: false, loadError: null, crash: null, pollerError: null, heldOpen: false, stderrTail: '', peakRssKb: 0, doneMaxRssKb: null, ms: 0}
  let lastLine = started
  let outputBytes = 0
  let lineParts: string[] = []
  let lineCharacters = 0
  let skippingLine = false
  let exitedAt: number | null = null
  let killedAt: number | null = null
  const killGroup = () => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // The group already exited.
    }
  }
  const kill = (reason: KillReason) => {
    if (run.killed != null) return
    run.killed = reason
    killedAt = performance.now()
    killGroup()
  }
  const countOutput = (text: string) => {
    outputBytes += Buffer.byteLength(text)
    if (outputBytes > limits.outputBytes) kill('output cap')
    return run.killed !== 'output cap'
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const handleLine = (raw: string) => {
    let line: ChildLine
    try {
      line = JSON.parse(raw) as ChildLine
    } catch {
      return // a line project code wrote; it counts toward the output cap only
    }
    switch (line.type) {
      case 'loaded': run.loaded = true; break
      case 'load-failed': run.loadError = line.error; break
      case 'done': run.doneMaxRssKb = line.maxRssKb; break
      case 'rss':
        run.peakRssKb = Math.max(run.peakRssKb, line.rssKb)
        kill('RSS')
        break
      case 'crashed': run.crash = line.error; break
      case 'heartbeat': case 'entry': case 'verified': break
    }
    onLine(line)
  }
  child.stdout.on('data', (text: string) => {
    if (!countOutput(text)) return
    lastLine = performance.now()
    let start = 0
    for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', start)) {
      if (!skippingLine) {
        lineParts.push(text.slice(start, newline))
        handleLine(lineParts.join(''))
      }
      lineParts = []
      lineCharacters = 0
      skippingLine = false
      start = newline + 1
    }
    if (skippingLine || start === text.length) return
    lineCharacters += text.length - start
    if (lineCharacters > MAX_LINE_CHARACTERS) {
      lineParts = []
      skippingLine = true
      return
    }
    lineParts.push(text.slice(start))
  })
  child.stderr.on('data', (text: string) => {
    if (!countOutput(text)) return
    run.stderrTail = `${run.stderrTail}${text}`.slice(-4000)
  })

  // The RSS poller: one `ps` at a time. A `ps` that can't run, e.g. with no ps on PATH, or that doesn't report within psMs,
  // stops the child, since its RSS limit could no longer be enforced.
  let ps: ChildProcessByStdio<null, Readable, null> | null = null
  let psStarted = 0
  const pollerFailed = (why: string) => {
    run.pollerError = why
    kill('RSS poller')
  }
  const poll = () => {
    if (child.pid == null || run.killed != null || exitedAt != null) return
    if (ps != null) {
      if (performance.now() - psStarted <= limits.psMs) return
      ps.kill('SIGKILL')
      ps = null
      pollerFailed(`ps did not report within ${limits.psMs / 1000} s`)
      return
    }
    psStarted = performance.now()
    let current: ChildProcessByStdio<null, Readable, null>
    try {
      current = spawn('ps', ['-o', 'rss=', '-p', String(child.pid)], {stdio: ['ignore', 'pipe', 'ignore']})
    } catch (error) {
      pollerFailed(`ps could not run: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    ps = current
    let text = ''
    current.stdout.setEncoding('utf8')
    current.stdout.on('data', (chunk: string) => {
      text += chunk
    })
    current.on('error', (error) => {
      if (ps !== current) return
      ps = null
      pollerFailed(`ps could not run: ${error.message}`)
    })
    current.on('close', () => {
      if (ps !== current) return
      ps = null
      const rss = Number.parseInt(text.trim(), 10)
      if (!Number.isFinite(rss)) return // the child already exited
      run.peakRssKb = Math.max(run.peakRssKb, rss)
      if (rss > limits.rssKb) kill('RSS')
    })
  }

  let resolveRun: (result: ChildRun) => void = () => {}
  const finished = new Promise<ChildRun>((resolve) => {
    resolveRun = resolve
  })
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    clearInterval(timer)
    clearInterval(poller)
    ps?.kill('SIGKILL')
    killGroup()
    child.stdout.destroy()
    child.stderr.destroy()
    run.ms = performance.now() - started
    resolveRun(run)
  }
  const timer = setInterval(() => {
    const now = performance.now()
    if (exitedAt == null) {
      if (!run.loaded && run.loadError == null && now - started > limits.loadMs) kill('load step')
      if (run.loaded && now - lastLine > limits.heartbeatMs) kill('heartbeat')
      if (now - started > limits.hardMs) kill('hard limit')
      if (killedAt != null && now - killedAt > KILL_WAIT_MS) end()
    } else if (now - exitedAt > DRAIN_MS) {
      run.heldOpen = true
      end()
    }
  }, 50)
  poll()
  const poller = setInterval(poll, limits.pollMs)
  child.on('exit', (code) => {
    run.exitCode = code
    exitedAt = performance.now()
  })
  child.on('close', end)
  return finished
}

// -- The temp tree --------------------------------------------------------------------

/** Rewrites every runtime import specifier to the absolute path it resolves to beside the original file. */
function rewriteImports(text: string, fileName: string, originalDirectory: string): string {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const edits: {start: number; end: number; replacement: string}[] = []
  const rewrite = (specifier: ts.Expression) => {
    if (!ts.isStringLiteral(specifier)) return
    let resolved: string
    try {
      resolved = Bun.resolveSync(specifier.text, originalDirectory)
    } catch {
      return // left as written; the load step reports what fails to load
    }
    edits.push({start: specifier.getStart(sourceFile), end: specifier.end, replacement: JSON.stringify(resolved)})
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) rewrite(node.moduleSpecifier)
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier != null) rewrite(node.moduleSpecifier)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] != null) rewrite(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  edits.sort((left, right) => right.start - left.start)
  let output = text
  for (const edit of edits) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end)
  return output
}

/** `export {…}` for the named top-level functions the file doesn't export (export@v1), or '' when there are none. */
function exportList(sourceFile: ts.SourceFile): string {
  const exported = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier == null && statement.exportClause != null && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add((element.propertyName ?? element.name).text)
    }
  }
  const names: string[] = []
  for (const statement of sourceFile.statements) {
    if (hasExport(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name != null && !exported.has(statement.name.text)) names.push(statement.name.text)
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (ts.isIdentifier(declaration.name) && initializer != null && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && !exported.has(declaration.name.text)) names.push(declaration.name.text)
    }
  }
  return names.length === 0 ? '' : `\nexport {${names.join(', ')}}\n`
}

// -- One file ----------------------------------------------------------------------------

export type EntryStatus = {kind: 'run'} | {kind: 'unsupported'; reason: string} | {kind: 'not-run'; reason: 'entry cap'} | {kind: 'load-failed'} | {kind: 'killed'; reason: string}

export type EntryResult = {entry: SweepEntry; status: EntryStatus; counts: EntryLine | null}

export type Verification = {item: VerifyItem; line: VerifiedLine | null}

export type SweepRun =
  | {kind: 'not-run'; reason: string}
  | {kind: 'ran'; sites: Site[]; entries: EntryResult[]; loadError: string | null; run: ChildRun | null; verify: ChildRun | null; verifications: Verification[]; ms: number}

// What a site's verification must show: a failure at level >= 3, a failure at level >= 2 (a proved site), or a reach (an
// unreachable site). The report decides which from the static verdict.
export type Requirement = 'level3' | 'level2' | 'reach'

export function describeExit(run: ChildRun): string {
  if (run.crash != null) return `the child exited with code ${run.exitCode ?? 'none'}: ${run.crash.split('\n')[0] ?? ''}`
  const lastLine = run.stderrTail.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).at(-1)
  return `the child exited with code ${run.exitCode ?? 'none'}${lastLine == null ? '' : `: ${lastLine}`}`
}

/**
 * Sweeps one file: runs every supported entry, up to the entry cap, in one run child, then verifies at most
 * `limits.verifyItems` first inputs in one verification child. `requirementOf` says what each site's verification needs.
 */
export async function sweepFile(path: string, reportFile: string, sourceFile: ts.SourceFile, program: ts.Program, settings: SweepSettings, requirementOf: (site: Site) => Requirement): Promise<SweepRun> {
  const started = performance.now()
  const limits = settings.limits
  // The child is child.ts, run by Bun from fr's TypeScript source. A bundled fr, e.g. `bun build fr.ts --target=node`, has no
  // child.ts beside it and can run under Node, which has no Bun.resolveSync. @types/bun declares `process.versions.bun` present,
  // so the version is read as the runtime record it is.
  const bunVersion = (process.versions as Partial<Record<string, string>>)['bun']
  if (bunVersion == null || !existsSync(CHILD)) return {kind: 'not-run', reason: `sweep of ${reportFile} not run: FREERANGE_SWEEP runs only from fr's TypeScript source under Bun, e.g. \`bun fr.ts <file>\``}
  let instrumented: {output: string; sites: Site[]}
  try {
    instrumented = instrumentSource(sourceFile.text, path, reportFile, 0)
  } catch (error) {
    return {kind: 'not-run', reason: `could not load ${reportFile} for a sweep: ${error instanceof Error ? error.message : String(error)}`}
  }
  const sites = instrumented.sites
  if (sites.length > limits.sitesPerFile) return {kind: 'not-run', reason: `sweep of ${reportFile} not run: ${sites.length} asserts, above the cap of ${limits.sitesPerFile}`}

  const entries: EntryResult[] = []
  let supported = 0
  for (const analyzed of sweepEntries(program, sourceFile, settings.filters)) {
    const discardSites: {site: number; cause: DiscardCause}[] = []
    for (const site of sites) if (site.leading && site.functionName === analyzed.name) discardSites.push({site: site.index, cause: 'leading'})
    for (const position of analyzed.discardAsserts) {
      const site = sites.find((candidate) => candidate.line === position.line && candidate.column === position.column)
      if (site != null && !discardSites.some((discard) => discard.site === site.index)) discardSites.push({site: site.index, cause: position.cause})
    }
    capUnboundedEnds(analyzed.args, settings.cap)
    const entry: SweepEntry = {name: analyzed.name, ordinal: analyzed.ordinal, line: analyzed.line, parameterNames: analyzed.parameterNames, args: analyzed.args, relations: analyzed.relations, lengthTies: analyzed.lengthTies, discardSites}
    if (analyzed.unsupported != null) {
      entries.push({entry, status: {kind: 'unsupported', reason: analyzed.unsupported}, counts: null})
      continue
    }
    if (supported >= limits.entriesPerFile) {
      entries.push({entry, status: {kind: 'not-run', reason: 'entry cap'}, counts: null})
      continue
    }
    supported += 1
    entries.push({entry, status: {kind: 'run'}, counts: null})
  }
  const runnable = entries.filter((result) => result.status.kind === 'run').map((result) => result.entry)
  if (runnable.length === 0) return {kind: 'ran', sites, entries, loadError: null, run: null, verify: null, verifications: [], ms: performance.now() - started}

  // The real path, so stack frames of the copies (which Bun reports through symlinks resolved) contain the job's paths.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'fr-sweep-')))
  try {
    const extension = extname(path)
    const instrumentedPath = join(directory, `instrumented${extension}`)
    const sourcePath = join(directory, `source${extension}`)
    const exports = exportList(sourceFile)
    writeFileSync(instrumentedPath, `${rewriteImports(instrumented.output, instrumentedPath, dirname(path))}${exports}`)
    writeFileSync(sourcePath, `${rewriteImports(sourceFile.text, sourcePath, dirname(path))}${exports}`)
    const settingsForJob = {budget: limits.inputsPerEntry, seed: 1, p0Inputs: 10_000, p2ProductMax: 50_000}
    const job: SweepJob = {mode: 'run', instrumented: instrumentedPath, source: sourcePath, sites, entries: runnable, settings: settingsForJob, stepBudget: limits.stepBudget, heartbeatEvery: limits.heartbeatEvery, rssKb: limits.rssKb, items: []}
    const jobPath = join(directory, 'job.json')
    writeFileSync(jobPath, JSON.stringify(job))
    const finished = new Map<number, EntryLine>()
    const run = await runChild(jobPath, directory, limits, (line) => {
      if (line.type === 'entry') finished.set(line.entry, line)
    })
    // A stop by the RSS poller is reported as a stop whether or not the module had loaded: nothing was wrong with the module.
    const loadFailed = run.killed !== 'RSS poller' && (run.loadError != null || !run.loaded)
    for (const result of entries) {
      if (result.status.kind !== 'run') continue
      const counts = finished.get(result.entry.ordinal)
      if (counts != null) {
        result.counts = counts
        continue
      }
      result.status = loadFailed ? {kind: 'load-failed'} : {kind: 'killed', reason: run.killed ?? describeExit(run)}
    }
    const loadError = !loadFailed ? null
      : run.loadError ?? (run.killed === 'load step' ? `the module did not finish loading within ${limits.loadMs / 1000} s`
        : run.killed != null ? `the child was stopped while loading: ${run.killed}`
        : describeExit(run))

    // Verification: the first input per site that the site's requirement needs, in line order, at most verifyItems.
    const candidates: VerifyItem[] = []
    const countsBySite = entries.map((result) => new Map((result.counts?.sites ?? []).map((counts) => [counts.site, counts])))
    for (const site of [...sites].sort((left, right) => left.line - right.line || left.column - right.column)) {
      const requirement = requirementOf(site)
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        const counts = countsBySite[entryIndex]!.get(site.index)
        const first = counts == null ? null : requirement === 'level3' ? counts.first3 : requirement === 'level2' ? counts.first2 : counts.firstReach
        if (first == null || entries[entryIndex]!.entry.discardSites.some((discard) => discard.site === site.index)) continue
        candidates.push({item: candidates.length, entry: entries[entryIndex]!.entry.ordinal, index: first.index, digest: first.digest, site: site.index})
        break
      }
    }
    const items = candidates.slice(0, limits.verifyItems)
    const verifications: Verification[] = candidates.map((item) => ({item, line: null}))
    let verify: ChildRun | null = null
    const remainingMs = limits.hardMs - run.ms
    if (items.length > 0 && remainingMs > 0 && run.loaded && run.killed !== 'RSS poller') {
      const verifyJob: SweepJob = {...job, mode: 'verify', entries: runnable.filter((entry) => items.some((item) => item.entry === entry.ordinal)), items}
      const verifyPath = join(directory, 'verify.json')
      writeFileSync(verifyPath, JSON.stringify(verifyJob))
      verify = await runChild(verifyPath, directory, {...limits, loadMs: Math.min(limits.loadMs, limits.verifyMs), hardMs: Math.min(limits.verifyMs, remainingMs)}, (line) => {
        if (line.type === 'verified') verifications[line.item]!.line = line
      })
    }
    return {kind: 'ran', sites, entries, loadError, run, verify, verifications, ms: performance.now() - started}
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
}
