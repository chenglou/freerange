// Scores one Freerange revision on the corpus.
//
//   bun eval/score.ts --freerange <Freerange checkout with node_modules> --corpus <corpus directory> --out <new directory>
//     [--slice mj-gallery|families|replay]... [--unit <id>]... [--timeout-seconds 300]
//     [--node-modules mj-gallery=<dir>] [--examples-per-site 3] [--max-runtime-runs 3000]
//     [--runtime-timeout-seconds 20] [--skip-runtime]
//
// For every analyzed file of every unit it runs `bun <freerange>/fr.ts <file>` in a copy of the unit's tree, under
// `/usr/bin/time -l` and a per-file timeout, and joins the findings to each console.assert site (lib/findings.ts). Sites
// that are proved, can be false or could not be proved, and have stored example inputs, are run on those inputs
// (lib/runtime.ts): a firing in-domain confirms a counterexample, and on a proved site it is a soundness violation.
// Outputs: run.json, verdicts.jsonl (one row per site), files.tsv, summary.json, summary.md, raw/ and work/.
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {extractAssertSites, runtimeSiteID, type AssertSite} from './lib/asserts.ts'
import {failedRunReason, joinVerdicts, parseFreerangeOutput, type RunOutcome, type SiteVerdict, type Verdict} from './lib/findings.ts'
import {findConfigUpward, loadManifest, readJsonFile, type GroundTruthSite, type Slice} from './lib/manifest.ts'
import {runMeasured} from './lib/process.ts'
import {classifyEvents, runExample, selectExamples, writeRuntimeTree, type ExampleOutcome, type RuntimeResult} from './lib/runtime.ts'

type Options = {
  freerange: string
  out: string
  corpus: string
  slices: Set<string> | null
  units: Set<string> | null
  timeoutMs: number
  runtimeTimeoutMs: number
  nodeModules: Map<string, string>
  examplesPerSite: number
  maxRuntimeRuns: number
  skipRuntime: boolean
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    freerange: '', out: '', corpus: '', slices: null, units: null,
    timeoutMs: 300_000, runtimeTimeoutMs: 20_000, nodeModules: new Map(), examplesPerSite: 3, maxRuntimeRuns: 3000, skipRuntime: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!
    const value = (): string => {
      const next = argv[++index]
      if (next == null) throw new Error(`${name} needs a value`)
      return next
    }
    switch (name) {
      case '--freerange': options.freerange = resolve(value()); break
      case '--out': options.out = resolve(value()); break
      case '--corpus': options.corpus = resolve(value()); break
      case '--slice': (options.slices ??= new Set()).add(value()); break
      case '--unit': (options.units ??= new Set()).add(value()); break
      case '--timeout-seconds': options.timeoutMs = Number(value()) * 1000; break
      case '--runtime-timeout-seconds': options.runtimeTimeoutMs = Number(value()) * 1000; break
      case '--examples-per-site': options.examplesPerSite = Number(value()); break
      case '--max-runtime-runs': options.maxRuntimeRuns = Number(value()); break
      case '--skip-runtime': options.skipRuntime = true; break
      case '--node-modules': {
        const [label, directory] = value().split('=')
        if (label == null || directory == null) throw new Error('--node-modules takes <name>=<directory>')
        options.nodeModules.set(label, resolve(directory))
        break
      }
      default: throw new Error(`unknown option ${name}`)
    }
  }
  if (options.freerange === '' || options.out === '' || options.corpus === '') throw new Error('--freerange, --corpus and --out are required')
  if (!existsSync(join(options.freerange, 'fr.ts'))) throw new Error(`no fr.ts in ${options.freerange}`)
  if (existsSync(options.out)) throw new Error(`${options.out} exists; each run writes a new directory`)
  return options
}

function git(directory: string, args: string[]): string {
  const result = spawnSync('git', ['-C', directory, ...args], {encoding: 'utf8'})
  return result.status === 0 ? result.stdout.trim() : ''
}

const scorerDirectory = new URL('.', import.meta.url).pathname
const verdicts: Verdict[] = ['proved', 'could-not-prove', 'can-be-false', 'not-analyzed', 'requirement']
const emptyCounts = (): Record<Verdict, number> => ({'proved': 0, 'could-not-prove': 0, 'can-be-false': 0, 'not-analyzed': 0, 'requirement': 0})

// 'not run for this verdict': the site has examples, but its verdict is not-analyzed or requirement, which a firing
// can't contradict. 'skipped by cap': the run's example cap was reached first.
type RuntimeSummary = {examplesRun: number; outcome: ExampleOutcome['status'] | 'no examples' | 'not run for this verdict' | 'skipped by cap'; why: string | null; example: string | null}

type Row = {
  unit: string
  slice: Slice
  family: string
  file: string
  line: number
  column: number
  owner: string
  role: AssertSite['role']
  text: string
  key: string
  verdict: Verdict
  reason: string
  groundTruth: boolean
  labels: GroundTruthSite['labels']
  latticeFiringNone: number | null
  witnessFiring: number | null
  kills: number | null
  catching: boolean
  replay: {stage: string; firesAtStage: boolean} | null
  firesOnCorpusInputs: boolean
  runtime: RuntimeSummary
  soundnessViolation: boolean
}

// recordedMatch compares this run's finding lines with the lines the unit's source run recorded for the file: null when
// nothing was recorded, else the lines only one side has.
type FileRow = {unit: string; slice: Slice; file: string; exitCode: number | null; timedOut: boolean; wallSeconds: number | null; maxRssBytes: number | null; findings: number; coverage: string; failure: string; recordedMatch: {recordedRevision: string; onlyRecorded: string[]; onlyNow: string[]} | null}

type SliceSummary = {
  units: number
  files: number
  sites: Record<Verdict, number>
  groundTruthSites: Record<Verdict, number>
  catching: {total: number; byVerdict: Record<Verdict, number>; proved: string[]}
  firesOnCorpusInputs: {total: number; byVerdict: Record<Verdict, number>}
  canBeFalse: {total: number; confirmedInDomain: number; firesOutOfDomainOnly: number; notConfirmed: number}
  soundnessViolations: Array<{unit: string; key: string; example: string | null}>
  unmatchedGroundTruth: string[]
}

function firesOnCorpusInputs(truth: GroundTruthSite | undefined): boolean {
  if (truth == null) return false
  if (truth.replay != null) return truth.replay.firesAtStage
  return (truth.lattice?.firing.none ?? 0) > 0 || (truth.witness?.withoutDomainLine ?? 0) > 0
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const {manifest, units} = loadManifest(options.corpus)
  const defaultNodeModules = join(options.corpus, 'node-modules.json')
  if (existsSync(defaultNodeModules)) {
    for (const [label, directory] of Object.entries(readJsonFile<Record<string, string>>(defaultNodeModules))) {
      if (!options.nodeModules.has(label)) options.nodeModules.set(label, directory)
    }
  }
  const selected = units.filter(unit =>
    (options.slices == null || options.slices.has(unit.slice)) && (options.units == null || options.units.has(unit.id)))
  mkdirSync(join(options.out, 'raw'), {recursive: true})
  const frPath = join(options.freerange, 'fr.ts')
  const runInfo = {
    startedAt: new Date().toISOString(),
    freerange: {directory: options.freerange, revision: git(options.freerange, ['rev-parse', 'HEAD']), dirtyFiles: git(options.freerange, ['status', '--porcelain', '--', 'src', 'fr.ts', 'package.json', 'bun.lock']).split('\n').filter(line => line.length > 0).length},
    corpus: {directory: options.corpus, version: manifest.version, builtAt: manifest.builtAt, manifestSha1: createHash('sha1').update(readFileSync(join(options.corpus, 'manifest.json'))).digest('hex')},
    scorer: {revision: git(scorerDirectory, ['rev-parse', 'HEAD']), dirtyFiles: git(scorerDirectory, ['status', '--porcelain', '--', '.']).split('\n').filter(line => line.length > 0).length},
    bun: Bun.version,
    options: {timeoutSeconds: options.timeoutMs / 1000, runtimeTimeoutSeconds: options.runtimeTimeoutMs / 1000, examplesPerSite: options.examplesPerSite, maxRuntimeRuns: options.maxRuntimeRuns, skipRuntime: options.skipRuntime, slices: options.slices == null ? null : [...options.slices], units: options.units == null ? null : [...options.units], nodeModules: Object.fromEntries(options.nodeModules)},
    unitsSelected: selected.length,
  }
  writeFileSync(join(options.out, 'run.json'), `${JSON.stringify(runInfo, null, 1)}\n`)
  writeFileSync(join(options.out, 'files.tsv'), 'unit\tslice\tfile\texit\ttimed_out\twall_seconds\tmax_rss_bytes\tfindings\tcoverage\tfailure\n')
  writeFileSync(join(options.out, 'verdicts.jsonl'), '')

  const summaries = new Map<Slice, SliceSummary>()
  const summaryFor = (slice: Slice): SliceSummary => {
    let summary = summaries.get(slice)
    if (summary == null) {
      summary = {units: 0, files: 0, sites: emptyCounts(), groundTruthSites: emptyCounts(), catching: {total: 0, byVerdict: emptyCounts(), proved: []}, firesOnCorpusInputs: {total: 0, byVerdict: emptyCounts()}, canBeFalse: {total: 0, confirmedInDomain: 0, firesOutOfDomainOnly: 0, notConfirmed: 0}, soundnessViolations: [], unmatchedGroundTruth: []}
      summaries.set(slice, summary)
    }
    return summary
  }
  const fileRows: FileRow[] = []
  let runtimeRuns = 0
  let runtimeSkippedByCap = 0

  for (const unit of selected) {
    const summary = summaryFor(unit.slice)
    summary.units++
    const workRoot = join(options.out, 'work', unit.id)
    cpSync(join(options.corpus, unit.tree), workRoot, {recursive: true})
    let unitFailure: string | null = null
    if (unit.nodeModules != null) {
      const directory = options.nodeModules.get(unit.nodeModules)
      if (directory == null) unitFailure = `node_modules for ${unit.nodeModules} not provided (--node-modules ${unit.nodeModules}=<directory>)`
      else symlinkSync(directory, join(workRoot, 'node_modules'))
    }
    if (!unit.tsconfig) {
      const found = findConfigUpward(workRoot)
      if (found != null) unitFailure = `a tsconfig.json above the unit's work directory (${found}) would replace the single-file program`
    }

    const sitesWithVerdicts: Array<{site: AssertSite; verdict: SiteVerdict}> = []
    for (const file of unit.analyze) {
      summary.files++
      const sites = extractAssertSites(file, readFileSync(join(workRoot, file), 'utf8'))
      let outcome: RunOutcome
      const fileRow: FileRow = {unit: unit.id, slice: unit.slice, file, exitCode: null, timedOut: false, wallSeconds: null, maxRssBytes: null, findings: 0, coverage: '', failure: '', recordedMatch: null}
      if (unitFailure != null) {
        outcome = {kind: 'failed', reason: unitFailure}
        fileRow.failure = unitFailure
      } else {
        const run = await runMeasured([process.execPath, frPath, file], workRoot, {timeoutMs: options.timeoutMs, maxOutputBytes: 16 * 1024 * 1024})
        const rawBase = join(options.out, 'raw', unit.id, file.replaceAll('/', '__'))
        mkdirSync(join(options.out, 'raw', unit.id), {recursive: true})
        writeFileSync(`${rawBase}.stdout.txt`, run.stdout)
        writeFileSync(`${rawBase}.stderr.txt`, run.stderr)
        const parsed = parseFreerangeOutput(run.stdout)
        const failure = failedRunReason({timedOut: run.timedOut, timeoutMs: options.timeoutMs, spawnError: run.spawnError, exitCode: run.exitCode, stderr: run.stderr, coverageLine: parsed.coverageLine})
        outcome = failure == null ? {kind: 'ran', output: parsed} : {kind: 'failed', reason: failure}
        Object.assign(fileRow, {exitCode: run.exitCode, timedOut: run.timedOut, wallSeconds: run.wallMs / 1000, maxRssBytes: run.maxRssBytes, findings: parsed.findings.length, coverage: parsed.coverageLine ?? '', failure: failure ?? ''})
        const recorded = unit.recordedFindings.find(entry => entry.file === file)
        if (recorded != null) {
          const recordedLines = new Set(recorded.lines.filter(line => line.includes(': error [') || line.includes(': warning [')))
          const nowLines = new Set(run.stdout.split('\n').filter(line => line.includes(': error [') || line.includes(': warning [')))
          fileRow.recordedMatch = {
            recordedRevision: recorded.revision,
            onlyRecorded: [...recordedLines].filter(line => !nowLines.has(line)),
            onlyNow: [...nowLines].filter(line => !recordedLines.has(line)),
          }
        }
      }
      fileRows.push(fileRow)
      appendFileSync(join(options.out, 'files.tsv'), `${[fileRow.unit, fileRow.slice, fileRow.file, fileRow.exitCode ?? '', fileRow.timedOut, fileRow.wallSeconds?.toFixed(3) ?? '', fileRow.maxRssBytes ?? '', fileRow.findings, fileRow.coverage, fileRow.failure].join('\t')}\n`)
      const joined = joinVerdicts(sites, outcome)
      for (const site of sites) sitesWithVerdicts.push({site, verdict: joined.get(site.key)!})
    }

    const truthByKey = new Map(unit.groundTruth.map(truth => [truth.key, truth]))
    const matchedKeys = new Set<string>()
    for (const {site} of sitesWithVerdicts) if (truthByKey.has(site.key)) matchedKeys.add(site.key)
    for (const truth of unit.groundTruth) if (!matchedKeys.has(truth.key)) summary.unmatchedGroundTruth.push(`${unit.id} ${truth.key}`)

    // Runtime checks, one child process per distinct example, cached across the sites it covers.
    const runtimeOutcomes = new Map<string, RuntimeSummary>()
    const checkable = sitesWithVerdicts.filter(({site, verdict}) => {
      const truth = truthByKey.get(site.key)
      return truth != null && truth.examples.length > 0 && (verdict.verdict === 'proved' || verdict.verdict === 'can-be-false' || verdict.verdict === 'could-not-prove')
    })
    if (checkable.length > 0 && !options.skipRuntime) {
      const selection = selectExamples(checkable.map(({site}) => ({key: site.key, exampleCount: truthByKey.get(site.key)!.examples.length})), options.examplesPerSite, Math.max(0, options.maxRuntimeRuns - runtimeRuns))
      runtimeSkippedByCap += selection.skipped
      const runtimeRoot = join(options.out, 'work', `${unit.id}.runtime`)
      writeRuntimeTree(workRoot, runtimeRoot, unit.analyze)
      const results = new Map<string, RuntimeResult>()
      for (const candidate of selection.selected) {
        const site = checkable.find(entry => entry.site.key === candidate.siteKey)!.site
        const example = truthByKey.get(site.key)!.examples[candidate.exampleIndex]!
        const cacheKey = `${example.entryFile}|${example.entry}|${example.args}`
        let result = results.get(cacheKey)
        if (result == null) {
          result = await runExample({runtimeRoot, entryFile: example.entryFile, entry: example.entry, args: example.args, workDirectory: runtimeRoot, label: `example-${results.size}`, timeoutMs: options.runtimeTimeoutMs})
          results.set(cacheKey, result)
          runtimeRuns++
        }
        const leadingIDs = new Set(sitesWithVerdicts
          .filter(entry => entry.site.file === site.file && entry.site.role === 'requirement' && entry.site.topLevelFunction === site.topLevelFunction)
          .map(entry => runtimeSiteID(entry.site)))
        const outcome = classifyEvents(result, runtimeSiteID(site), site.topLevelFunction, leadingIDs)
        const previous = runtimeOutcomes.get(site.key)
        const rank = (status: RuntimeSummary['outcome']): number => ['fires-in-domain', 'fires-out-of-domain', 'holds', 'not-run', 'no examples', 'not run for this verdict', 'skipped by cap'].indexOf(status)
        if (previous == null || rank(outcome.status) < rank(previous.outcome)) {
          runtimeOutcomes.set(site.key, {examplesRun: (previous?.examplesRun ?? 0) + 1, outcome: outcome.status, why: 'why' in outcome ? outcome.why : null, example: `${example.entry}(${example.args.slice(1, -1)}) [${example.source}]`})
        } else {
          previous.examplesRun++
        }
      }
    }

    for (const {site, verdict} of sitesWithVerdicts) {
      const truth = truthByKey.get(site.key)
      const checkableVerdict = verdict.verdict === 'proved' || verdict.verdict === 'can-be-false' || verdict.verdict === 'could-not-prove'
      const runtime: RuntimeSummary = runtimeOutcomes.get(site.key) ?? {
        examplesRun: 0,
        outcome: truth == null || truth.examples.length === 0 ? 'no examples' : checkableVerdict && !options.skipRuntime ? 'skipped by cap' : 'not run for this verdict',
        why: options.skipRuntime ? '--skip-runtime' : null,
        example: null,
      }
      const soundnessViolation = verdict.verdict === 'proved' && runtime.outcome === 'fires-in-domain'
      const fires = firesOnCorpusInputs(truth)
      const row: Row = {
        unit: unit.id, slice: unit.slice, family: unit.family, file: site.file, line: site.line, column: site.column, owner: site.owner, role: site.role, text: site.text, key: site.key,
        verdict: verdict.verdict, reason: verdict.reason, groundTruth: truth != null, labels: truth?.labels ?? null,
        latticeFiringNone: truth?.lattice?.firing.none ?? null, witnessFiring: truth?.witness?.firing ?? null, kills: truth?.kills?.count ?? null,
        catching: truth?.catching ?? false, replay: truth?.replay == null ? null : {stage: truth.replay.stage, firesAtStage: truth.replay.firesAtStage},
        firesOnCorpusInputs: fires, runtime, soundnessViolation,
      }
      appendFileSync(join(options.out, 'verdicts.jsonl'), `${JSON.stringify(row)}\n`)
      summary.sites[row.verdict]++
      if (row.groundTruth) summary.groundTruthSites[row.verdict]++
      if (row.catching) {
        summary.catching.total++
        summary.catching.byVerdict[row.verdict]++
        if (row.verdict === 'proved') summary.catching.proved.push(`${unit.id} ${row.key}`)
      }
      if (fires) {
        summary.firesOnCorpusInputs.total++
        summary.firesOnCorpusInputs.byVerdict[row.verdict]++
      }
      if (row.verdict === 'can-be-false') {
        summary.canBeFalse.total++
        if (runtime.outcome === 'fires-in-domain') summary.canBeFalse.confirmedInDomain++
        else if (runtime.outcome === 'fires-out-of-domain') summary.canBeFalse.firesOutOfDomainOnly++
        else summary.canBeFalse.notConfirmed++
      }
      if (soundnessViolation) summary.soundnessViolations.push({unit: unit.id, key: row.key, example: runtime.example})
    }
    console.log(`${unit.id}: ${sitesWithVerdicts.length} sites`)
  }

  const summary = {
    run: runInfo,
    finishedAt: new Date().toISOString(),
    slices: Object.fromEntries(summaries),
    files: fileRows,
    totals: {
      freerangeWallSeconds: fileRows.reduce((total, row) => total + (row.wallSeconds ?? 0), 0),
      maxRssBytes: fileRows.reduce((max, row) => Math.max(max, row.maxRssBytes ?? 0), 0),
      timeouts: fileRows.filter(row => row.timedOut).length,
      runtimeRuns,
      runtimeSkippedByCap,
    },
    counting: {
      ...manifest.counting,
      proved: 'an interior assert in a lowered function with no finding at its line; `unreachable` findings count as proved and say so in the reason',
      couldNotProve: '`could not prove`, `could not check` (blocked), an unrecognized console-assert finding at the site, or a leading assert whose requirements weren\'t checked',
      canBeFalse: '`console.assert condition can be false` or a declared requirement reported false',
      notAnalyzed: 'the function wasn\'t lowered, the assert is outside a named top-level function, or the run failed (timeout, TypeScript errors, missing node_modules)',
      requirement: 'a leading assert of a lowered function with no finding: a caller requirement Freerange assumes inside the function',
      firesOnCorpusInputs: 'lattice firing under noise@none > 0, or witness firings without a domain line > 0, or for replay units the oracle\'s firings at that stage',
      confirmedInDomain: 'a stored example input, re-run on an instrumented copy, fires the assert in a call of its function whose leading asserts held and whose numeric inputs were finite',
      soundnessViolation: 'a proved site with a confirmed in-domain firing',
      catchingProved: 'catching sites (kills >= 1, or oracle-credited) with verdict proved',
    },
  }
  writeFileSync(join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`)
  writeFileSync(join(options.out, 'summary.md'), formatSummary(summary.slices, fileRows, summary.totals, runInfo))
  console.log(formatSummary(summary.slices, fileRows, summary.totals, runInfo))
}

function formatSummary(slices: Record<string, SliceSummary>, fileRows: FileRow[], totals: {freerangeWallSeconds: number; maxRssBytes: number; timeouts: number; runtimeRuns: number; runtimeSkippedByCap: number}, runInfo: {freerange: {revision: string; dirtyFiles: number}; corpus: {version: string; manifestSha1: string}; scorer: {revision: string; dirtyFiles: number}; bun: string; options: {timeoutSeconds: number}}): string {
  const lines: string[] = []
  lines.push(`# Corpus score: Freerange ${runInfo.freerange.revision.slice(0, 10)}`, '')
  lines.push(`- Freerange ${runInfo.freerange.revision} (${runInfo.freerange.dirtyFiles} dirty files under src, fr.ts, package.json, bun.lock); corpus ${runInfo.corpus.version}, manifest sha1 ${runInfo.corpus.manifestSha1}; scorer ${runInfo.scorer.revision} (${runInfo.scorer.dirtyFiles} dirty files under eval/); bun ${runInfo.bun}; per-file timeout ${runInfo.options.timeoutSeconds} s`, '')
  lines.push('## Verdicts per slice', '', '| slice | units | files | sites | proved | could not prove | can be false | not analyzed | requirement | ground-truth sites proved / cnp / cbf / na / req |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|')
  for (const [name, slice] of Object.entries(slices)) {
    const total = verdicts.reduce((count, verdict) => count + slice.sites[verdict], 0)
    const truth = verdicts.map(verdict => slice.groundTruthSites[verdict]).join(' / ')
    lines.push(`| ${name} | ${slice.units} | ${slice.files} | ${total} | ${slice.sites.proved} | ${slice.sites['could-not-prove']} | ${slice.sites['can-be-false']} | ${slice.sites['not-analyzed']} | ${slice.sites.requirement} | ${truth} |`)
  }
  lines.push('', '## Catching asserts, firings, counterexamples and soundness', '', '| slice | catching sites | catching proved | sites firing on corpus inputs (proved / cnp / cbf / na / req) | can be false | confirmed in-domain by running | soundness violations | unmatched ground truth |', '|---|---:|---:|---|---:|---:|---:|---:|')
  for (const [name, slice] of Object.entries(slices)) {
    const fires = verdicts.map(verdict => slice.firesOnCorpusInputs.byVerdict[verdict]).join(' / ')
    lines.push(`| ${name} | ${slice.catching.total} | ${slice.catching.proved.length} | ${slice.firesOnCorpusInputs.total} (${fires}) | ${slice.canBeFalse.total} | ${slice.canBeFalse.confirmedInDomain} | ${slice.soundnessViolations.length} | ${slice.unmatchedGroundTruth.length} |`)
  }
  for (const [name, slice] of Object.entries(slices)) {
    for (const violation of slice.soundnessViolations) lines.push(`- soundness violation (${name}): ${violation.unit} ${violation.key} on ${violation.example ?? '(no example)'}`)
  }
  lines.push('', '## Runtime and peak RSS per file', '', '| unit | file | exit | wall s | max RSS MB | findings | failure |', '|---|---|---:|---:|---:|---:|---|')
  for (const row of fileRows) {
    lines.push(`| ${row.unit} | ${row.file} | ${row.exitCode ?? ''} | ${row.wallSeconds?.toFixed(2) ?? ''} | ${row.maxRssBytes == null ? '' : (row.maxRssBytes / 1024 / 1024).toFixed(0)} | ${row.findings} | ${row.failure.replaceAll('|', '\\|')} |`)
  }
  lines.push('', `Totals: Freerange wall ${totals.freerangeWallSeconds.toFixed(1)} s over ${fileRows.length} files, max RSS ${(totals.maxRssBytes / 1024 / 1024).toFixed(0)} MB, ${totals.timeouts} timeouts; ${totals.runtimeRuns} runtime example runs, ${totals.runtimeSkippedByCap} examples skipped by the run cap.`, '')
  const compared = fileRows.filter(row => row.recordedMatch != null)
  const identical = compared.filter(row => row.recordedMatch!.onlyRecorded.length === 0 && row.recordedMatch!.onlyNow.length === 0)
  lines.push(`Recorded findings: ${identical.length} of ${compared.length} files with findings recorded by their source run reproduce them line for line.`, '')
  for (const row of compared) {
    if (row.recordedMatch!.onlyRecorded.length === 0 && row.recordedMatch!.onlyNow.length === 0) continue
    lines.push(`- ${row.unit} ${row.file} (recorded at ${row.recordedMatch!.recordedRevision.slice(0, 10)}): ${row.recordedMatch!.onlyRecorded.length} recorded lines missing, ${row.recordedMatch!.onlyNow.length} new lines`)
  }
  return `${lines.join('\n')}\n`
}

await main()
