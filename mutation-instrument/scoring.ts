// scoring@witness-v1 (plan-a/registered/w1-scoring.json; plan-a/decision-domain.md §3.1): rescoring of one run's baseline
// firings, printed after criterion 1 as written, which it never restates:
//   falseAlarm@unwitnessed  off-list rows that no verified caller-derived witness call fires (witness-run.ts)
//   falseAlarm@instrument   rows with a sampled firing input that doesn't reproduce on the uninstrumented copy (worker.ts score)
//   missedFiring            sampled quiet inputs where the uninstrumented copy records a line the instrumented original held
//   budget starvation       under domain@v3-callers, an entry with a caller rule and too few in-domain inputs
// criterion 1@witness-v1 = kill clause AND falseAlarm@unwitnessed = 0 AND falseAlarm@instrument = 0 AND missedFiring = 0.
// A domain@v3-callers run is the oracle arm: the verdict of the domain@v2 run it reruns prints first, its own as-written
// clauses print under their own title, and every scoring line carries the oracle prefix.
// Writes into the output directory: criterion1.txt, scoring.md, findings.tsv, gates.jsonl and scoring.json.
import {createHash} from 'node:crypto'
import {appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {violatedRules} from './callers.ts'
import {runChild} from './children.ts'
import type {Value} from './domain.ts'
import {decodeJson, encodeJson} from './encode.ts'
import {readRules, type Rules, type RunScoring, type ScoringRegistration} from './rules.ts'
import {formatInput, listOrNone, loadRun, PRODUCERS, readLines, siteLabel, table, type AsWrittenReport, type Run} from './run-data.ts'
import {CAUSES, CRITERION_RULE, type CauseClass, type EntryPlan, type ScoreLine, type ScoreRow, type Site, type WitnessTable} from './types.ts'

export const ORACLE_PREFIX = 'oracle arm (hand-written caller domains; not criterion 1, memo §5): '
export const ORACLE_AS_WRITTEN_TITLE = 'as-written clauses under domain@v3-callers (oracle arm: hand-written caller domains, not criterion 1, memo §5; exposure-informed: rules written after these firings were seen, not evidence on m2-m4)'

export type ScoringJob = {
  sourceDir: string // the run scored; only read
  outDir: string // a new directory for a rescoring (R-S7); the run directory itself for a domain@v3-callers run
  rules: Rules
  rulesPath: string
  asWritten: AsWrittenReport
  registrationPath: string
  registrationSha1: string | null // checked when the run's own registration names it
  carried: RunScoring['carried'] | null // domain@v3-callers only: the domain@v2 run, its registration, and its rescoring
}

type ListStatus = 'on list' | 'off by cause' | 'off by site'
type Witness = {stored: number; verified: number; firstVerified: string | null}
type Row = {copy: string; entry: EntryPlan; site: Site; cause: CauseClass; count: number; listStatus: ListStatus; witness: Witness; score: ScoreRow | null; instrumentFailure: string | null}
type ChildRecord = {copy: string; exitCode: number | null; timedOut: string | null; ms: number; maxRssKb: number | null; stderr: string}
type Verdict = 'pass' | 'fail' | 'incomplete'
type CopyScore = {copy: string; criterion: boolean; rows: number; offList: number; unwitnessed: number; findings: number; instrumentFailures: number; verifiedInputs: number; missCount: number; sampled: number; entries: number; starved: string[]; killClause: boolean | null; verdict: Verdict}
type CarriedRow = {copy: string; entry: string; site: Site; cause: CauseClass; count: number; firstInput: string | null}

function sha1(text: string | Buffer) {
  return createHash('sha1').update(text).digest('hex')
}

function passFail(count: number) {
  return count === 0 ? 'pass' : 'fail'
}

/** A row's status against the criterion lists covering its copy, or against every list covering it when none is a criterion list. */
function listStatusOf(run: Run, copy: string, site: Site, cause: CauseClass): ListStatus {
  const covering = run.knownFalse.filter((list) => list.rule.copies.includes(copy))
  const criterionLists = covering.filter((list) => list.rule.criterion)
  const lists = criterionLists.length > 0 ? criterionLists : covering
  if (lists.some((list) => list.keys.has(`${copy}|${site.key}|${cause}`))) return 'on list'
  const sitePrefix = `${copy}|${site.key}|`
  return lists.some((list) => [...list.keys].some((key) => key.startsWith(sitePrefix))) ? 'off by cause' : 'off by site'
}

/**
 * The witness inputs of a row's site on its entry that the arm admits: under domain@v2 every stored input, under
 * domain@v3-callers only inputs that violate none of the entry's caller rules (R-S3 (a)).
 */
function witnessOf(witnessTable: WitnessTable | null, entry: EntryPlan, site: Site, oracle: boolean): Witness {
  const witnessEntry = witnessTable?.entries.find((candidate) => candidate.name === entry.name) ?? null
  const witnessSite = witnessEntry?.sites.find((candidate) => candidate.key === site.key) ?? null
  if (witnessEntry == null || witnessSite == null) return {stored: 0, verified: 0, firstVerified: null}
  let activeMask = 0
  if (oracle) {
    for (const callerRule of entry.callerRules) {
      const bit = witnessEntry.rules.indexOf(callerRule.id)
      if (bit < 0) throw new Error(`the witness table of ${entry.name} has no check of caller-rule@${callerRule.id}`)
      activeMask |= 1 << bit
    }
  }
  const witness: Witness = {stored: 0, verified: 0, firstVerified: null}
  for (const reservoir of witnessSite.reservoirs) {
    if ((reservoir.mask & activeMask) !== 0) continue
    witness.stored += reservoir.stored
    witness.verified += reservoir.verified
    witness.firstVerified ??= reservoir.firstVerified
  }
  return witness
}

function formatEncoded(entry: string, encoded: string | null) {
  return encoded == null ? '' : formatInput(entry, {index: 0, producer: 0, margin: null, cause: 'ordinary', input: encoded})
}

export async function writeScoring(job: ScoringJob) {
  const wallStart = performance.now()
  const registrationText = readFileSync(job.registrationPath, 'utf8')
  const registrationSha1 = sha1(registrationText)
  if (job.registrationSha1 != null && registrationSha1 !== job.registrationSha1) throw new Error(`scoring registration ${job.registrationPath}: sha1 ${registrationSha1} differs from the registered ${job.registrationSha1}`)
  const registration = decodeJson(registrationText) as ScoringRegistration
  const scratch = registration.data.scratch
  const oracle = job.rules.domain.version === 'domain@v3-callers'
  const prefix = oracle ? ORACLE_PREFIX : ''
  if (oracle !== (job.carried != null)) throw new Error('a domain@v3-callers run needs scoring.carried, and a domain@v2 rescoring has none')
  const run = await loadRun(job.sourceDir, job.rules)
  const witnessDir = join(scratch, registration.witness.runDir)
  const witnessMetaPath = join(witnessDir, 'meta.json')
  const witnessMeta = existsSync(witnessMetaPath) ? decodeJson(readFileSync(witnessMetaPath, 'utf8')) as Record<string, unknown> : null
  if (witnessMeta?.['status'] !== 'complete') throw new Error(`no complete witness run at ${witnessDir}`)
  const witnessMetaSha1 = sha1(readFileSync(witnessMetaPath))

  // R-S4 instrument gates: one score child per copy of the run.
  const gatesPath = join(job.outDir, 'gates.jsonl')
  const scores = new Map<string, ScoreLine>()
  const children: ChildRecord[] = []
  for (const copy of run.plan.copies) {
    const child = await runChild({mode: 'score', plan: join(job.sourceDir, 'plan.json'), base: copy.copy, samplesPerRow: registration.gates.samplesPerRow, missedSamples: registration.gates.missedSamples, maxDrawsPerEntry: registration.gates.maxDrawsPerEntry},
      registration.gates.childHardLimitMinutes * 60_000, registration.gates.heartbeatTimeoutSeconds * 1000, (line) => {
        if (line.type !== 'score') return
        scores.set(`${line.base}.${line.entry}`, line)
        appendFileSync(gatesPath, `${encodeJson(line)}\n`)
      })
    children.push({copy: copy.copy, exitCode: child.exitCode, timedOut: child.timedOut, ms: child.ms, maxRssKb: child.done?.maxRssKb ?? null, stderr: child.stderr})
  }

  const tables = new Map<string, WitnessTable>()
  const tableSha1s: Record<string, string> = {}
  for (const copy of run.plan.copies) {
    const path = join(witnessDir, `witness-${job.rules.family}-${copy.copy}.json`)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    tables.set(copy.copy, decodeJson(text) as WitnessTable)
    tableSha1s[copy.copy] = sha1(text)
  }

  // R-S1 rows: every (copy, entry, site, cause) with criterion-rule firings in baseline.jsonl.
  const rows: Row[] = []
  for (const line of run.baseline.values()) {
    const copy = run.copyOf.get(line.base)!
    const entry = copy.entries.find((candidate) => candidate.name === line.entry)!
    const score = scores.get(`${line.base}.${line.entry}`) ?? null
    const child = children.find((candidate) => candidate.copy === line.base)!
    for (const firing of line.firings) {
      if (firing.first[CRITERION_RULE] == null) continue
      const site = copy.sites[firing.site]!
      for (const cause of CAUSES) {
        const count = firing.byCause[cause]
        if (count === 0) continue
        const scoreRow = score?.rows.find((candidate) => candidate.site === firing.site && candidate.cause === cause) ?? null
        const instrumentFailure = child.exitCode !== 0 || child.timedOut != null ? `the score child failed: exit ${child.exitCode}${child.timedOut == null ? '' : `, ${child.timedOut}`}`
          : score == null ? 'the score child wrote no line for the entry'
          : score.digest !== entry.digest ? `input digest ${score.digest} differs from the plan's ${entry.digest}`
          : scoreRow == null ? 'the score pass found no firing input of this row'
          : scoreRow.count !== count ? `the score pass counts ${scoreRow.count} firing inputs where baseline.jsonl counts ${count}`
          : scoreRow.failureCount > 0 ? `${scoreRow.failureCount} of ${scoreRow.verified} verified inputs fail, e.g. #${scoreRow.failures[0]!.index}: ${scoreRow.failures[0]!.reason}` : null
        rows.push({copy: line.base, entry, site, cause, count, listStatus: listStatusOf(run, line.base, site, cause), witness: witnessOf(tables.get(line.base) ?? null, entry, site, oracle), score: scoreRow, instrumentFailure})
      }
    }
  }
  // Rows the score pass finds that baseline.jsonl doesn't have are instrument disagreements too.
  const extraRows: {copy: string; entry: string; site: Site; cause: CauseClass; count: number}[] = []
  for (const score of scores.values()) {
    const copy = run.copyOf.get(score.base)!
    for (const scoreRow of score.rows) {
      if (rows.some((row) => row.copy === score.base && row.entry.name === score.entry && row.site.index === scoreRow.site && row.cause === scoreRow.cause)) continue
      extraRows.push({copy: score.base, entry: score.entry, site: copy.sites[scoreRow.site]!, cause: scoreRow.cause, count: scoreRow.count})
    }
  }

  let carriedRun: Run | null = null
  const carriedRows: CarriedRow[] = []
  if (job.carried != null) {
    carriedRun = await loadRun(join(scratch, job.carried.run), readRules(join(scratch, job.carried.rules)))
    const carriedScores = new Map<string, ScoreLine>()
    for (const line of await readLines<ScoreLine>(join(scratch, job.carried.rescored, 'gates.jsonl'))) carriedScores.set(`${line.base}.${line.entry}`, line)
    for (const line of carriedRun.baseline.values()) {
      const copy = carriedRun.copyOf.get(line.base)!
      for (const firing of line.firings) {
        if (firing.first[CRITERION_RULE] == null) continue
        for (const cause of CAUSES) {
          if (firing.byCause[cause] === 0) continue
          const scoreRow = carriedScores.get(`${line.base}.${line.entry}`)?.rows.find((candidate) => candidate.site === firing.site && candidate.cause === cause) ?? null
          carriedRows.push({copy: line.base, entry: line.entry, site: copy.sites[firing.site]!, cause, count: firing.byCause[cause], firstInput: scoreRow?.firstInput ?? null})
        }
      }
    }
  }

  const copyScores: CopyScore[] = job.rules.data.copies.map((copyRule) => {
    const copyPlan = run.copyOf.get(copyRule.id)!
    const copyRows = rows.filter((row) => row.copy === copyRule.id)
    const offList = copyRows.filter((row) => row.listStatus !== 'on list')
    const unwitnessed = offList.filter((row) => row.witness.verified === 0).length
    const copyScoreLines = [...scores.values()].filter((score) => score.base === copyRule.id)
    const missingEntries = copyPlan.entries.filter((entry) => entry.unsupported == null).length - copyScoreLines.length
    const instrumentFailures = copyRows.filter((row) => row.instrumentFailure != null).length + extraRows.filter((row) => row.copy === copyRule.id).length + missingEntries
    let missCount = 0
    let sampled = 0
    for (const score of copyScoreLines) {
      missCount += score.missed.missCount
      sampled += score.missed.sampled
    }
    const starved: string[] = []
    if (oracle) {
      for (const entry of copyPlan.entries) {
        if (entry.callerRules.length === 0) continue
        const line = run.baseline.get(`${copyRule.id}.${entry.name}`)
        const inDomain = line == null ? 0 : line.inputs - line.discarded - line.callerDiscarded - line.overBudget
        if (inDomain < registration.gates.budgetStarvationMinimum) starved.push(`${entry.name} ${inDomain}`)
      }
    }
    let verifiedInputs = 0
    for (const row of copyRows) verifiedInputs += row.score?.verified ?? 0
    const killClause = job.asWritten.killClauses.find((clause) => clause.copies.includes(copyRule.id))?.pass ?? null
    const failing = killClause !== true || unwitnessed > 0 || instrumentFailures > 0 || missCount > 0
    return {copy: copyRule.id, criterion: copyRule.criterion, rows: copyRows.length, offList: offList.length, unwitnessed, findings: offList.length - unwitnessed, instrumentFailures, verifiedInputs, missCount, sampled, entries: copyScoreLines.length, starved, killClause, verdict: failing ? 'fail' : starved.length > 0 ? 'incomplete' : 'pass'}
  })
  const scored = copyScores.filter((copyScore) => copyScore.criterion)
  const overall: Verdict = scored.some((copyScore) => copyScore.verdict === 'fail') ? 'fail' : scored.some((copyScore) => copyScore.verdict === 'incomplete') ? 'incomplete' : 'pass'

  // -- criterion1.txt: criterion 1 as written first (R-S0), then the scoring lines (R-S5) ---------
  const lines: string[] = []
  if (job.carried != null) {
    lines.push(`criterion 1 as written, carried unchanged from ${job.carried.run} (registered in ${job.carried.rules}); this oracle-arm run doesn't restate it:`)
    for (const carriedLine of readFileSync(join(scratch, job.carried.run, 'criterion1.txt'), 'utf8').trimEnd().split('\n')) lines.push(`  ${carriedLine}`)
  }
  lines.push(...job.asWritten.criterion)
  lines.push(`${prefix}scoring@witness-v1 (${registration.id}, sha1 ${registrationSha1}; witness run ${registration.witness.runDir}, meta.json sha1 ${witnessMetaSha1}; exposed development data, calibration)`)
  for (const copyScore of copyScores) {
    const scope = copyScore.criterion ? '' : ' (not scored)'
    lines.push(`${prefix}falseAlarm@unwitnessed ${copyScore.copy}${scope}: ${copyScore.unwitnessed} of ${copyScore.offList} off-list rows without a verified witness; ${copyScore.findings} witnessed off-list rows are findings → ${passFail(copyScore.unwitnessed)}`)
    lines.push(`${prefix}falseAlarm@instrument ${copyScore.copy}${scope}: ${copyScore.instrumentFailures} failures over ${copyScore.rows} rows, ${copyScore.verifiedInputs} regenerated firing inputs verified → ${passFail(copyScore.instrumentFailures)}`)
    lines.push(`${prefix}missedFiring ${copyScore.copy}${scope}: ${copyScore.missCount} misses in ${copyScore.sampled} sampled quiet inputs over ${copyScore.entries} entries → ${passFail(copyScore.missCount)}`)
    if (oracle) lines.push(`${prefix}budget starvation ${copyScore.copy}${scope}: ${listOrNone(copyScore.starved)} (an entry with a caller rule needs ${registration.gates.budgetStarvationMinimum} in-domain inputs)`)
    const verdictText = copyScore.verdict === 'incomplete' ? `incomplete: budget starved (${copyScore.starved.join(', ')})` : copyScore.verdict
    const killText = copyScore.killClause == null ? 'not registered' : copyScore.killClause ? 'pass' : 'fail'
    lines.push(`${prefix}criterion 1@witness-v1 ${copyScore.copy}${scope}: kill clause ${killText}; falseAlarm@unwitnessed ${copyScore.unwitnessed}; falseAlarm@instrument ${copyScore.instrumentFailures}; missedFiring ${copyScore.missCount} → ${verdictText}`)
  }
  lines.push(`${prefix}criterion 1@witness-v1 (criterion copies ${scored.map((copyScore) => copyScore.copy).join(', ')}): ${overall}`)
  writeFileSync(join(job.outDir, 'criterion1.txt'), `${lines.join('\n')}\n`)

  // -- findings.tsv (R-S6) -----------------------------------------------------------------------
  const maskedKills = new Map<string, string[]>()
  for (const copyRule of job.rules.data.copies) {
    const findingSites = new Set(rows.filter((row) => row.copy === copyRule.id && row.listStatus !== 'on list' && row.witness.verified > 0).map((row) => row.site.index))
    const registered = [...(copyRule.expectedKills ?? []), ...(copyRule.staticOnly ?? [])].map((id) => `${copyRule.id}/${id}`)
    maskedKills.set(copyRule.id, registered.filter((key) => {
      const killSites = run.summaries.get(key)?.killSites[CRITERION_RULE]
      return killSites != null && killSites.size > 0 && [...killSites].every((site) => findingSites.has(site))
    }))
  }
  const removedBy = (copy: string, entryName: string, firstInput: string | null) => {
    const entry = run.copyOf.get(copy)?.entries.find((candidate) => candidate.name === entryName)
    if (entry == null || entry.callerRules.length === 0 || firstInput == null) return ''
    return listOrNone(violatedRules(entry.callerRules, decodeJson(firstInput) as Value[]))
  }
  const tsvCell = (text: string | number) => String(text).replaceAll('\t', ' ').replaceAll('\n', ' ')
  const tsv = [['copy', 'entry', 'site_key', 'line', 'cause', 'count', 'producers_P0_P1_P2_P3', 'lattice_first_input', 'first_witness_input', 'list_status', 'witnessed', 'witness_inputs_verified_of_stored', 'instrument', 'scan_features', 'masked_kills', 'v2_count', 'v3c_count', 'removed_by_rules_v2_first_input'].join('\t')]
  for (const row of rows) {
    const carried = carriedRows.find((candidate) => candidate.copy === row.copy && candidate.entry === row.entry.name && candidate.site.key === row.site.key && candidate.cause === row.cause)
    tsv.push([row.copy, row.entry.name, row.site.key, row.site.line, row.cause, row.count, row.score?.producers.join('/') ?? '', formatEncoded(row.entry.name, row.score?.firstInput ?? null), formatEncoded(row.entry.name, row.witness.firstVerified),
      row.listStatus, row.listStatus === 'on list' ? '' : row.witness.verified > 0 ? 'yes' : 'no', `${row.witness.verified}/${row.witness.stored}`, row.instrumentFailure ?? 'ok', JSON.stringify(row.score?.features ?? {}),
      listOrNone((maskedKills.get(row.copy) ?? []).filter((key) => run.summaries.get(key)?.killSites[CRITERION_RULE]?.has(row.site.index) === true)),
      oracle ? carried?.count ?? 0 : row.count, oracle ? row.count : '', ''].map(tsvCell).join('\t'))
  }
  for (const carried of carriedRows) {
    if (rows.some((row) => row.copy === carried.copy && row.entry.name === carried.entry && row.site.key === carried.site.key && row.cause === carried.cause)) continue
    tsv.push([carried.copy, carried.entry, carried.site.key, carried.site.line, carried.cause, 0, '', formatEncoded(carried.entry, carried.firstInput), '', 'not a row here', '', '', '', '', '', carried.count, 0, removedBy(carried.copy, carried.entry, carried.firstInput)].map(tsvCell).join('\t'))
  }
  writeFileSync(join(job.outDir, 'findings.tsv'), `${tsv.join('\n')}\n`)

  // -- scoring.md --------------------------------------------------------------------------------------
  const out: string[] = []
  const write = (text = '') => {
    out.push(text)
  }
  write(`# scoring@witness-v1: ${job.rules.id} (${oracle ? 'oracle arm, domain@v3-callers' : 'a domain@v2 run rescored'})`)
  write()
  write(`- **measured_on:** ${job.rules.measured_on}. Everything here is calibration on exposed development data.`)
  write(`- **source run:** ${job.sourceDir}${job.outDir === job.sourceDir ? '' : `, only read; this scoring writes into ${job.outDir}`}`)
  write(`- **rules:** ${job.rulesPath} sha1 ${sha1(readFileSync(job.rulesPath))}`)
  write(`- **scoring registration:** ${job.registrationPath} sha1 ${registrationSha1}`)
  write(`- **witness run:** ${witnessDir}, meta.json sha1 ${witnessMetaSha1}; drop list ${JSON.stringify(witnessMeta['dropList'])}; tables ${JSON.stringify(tableSha1s)}`)
  if (job.carried != null) write(`- **carried:** ${JSON.stringify(job.carried)}`)
  write()
  write('## Verdicts')
  write()
  write('```')
  for (const line of lines) write(line)
  write('```')
  write()
  write('## Baseline firing rows (R-S1), witness check (R-S3) and instrument gate (R-S4)')
  write()
  write(table(['copy', 'entry', 'site', 'cause', 'firing inputs', 'list status', 'witnessed (verified of stored witness inputs)', 'first verified witness input', 'lattice first input', 'instrument gate'], rows.map((row) => [
    row.copy, row.entry.name, siteLabel(row.site), row.cause, row.count, row.listStatus, row.listStatus === 'on list' ? `on list (${row.witness.verified}/${row.witness.stored})` : `${row.witness.verified > 0 ? 'yes' : 'no'} (${row.witness.verified}/${row.witness.stored})`,
    formatEncoded(row.entry.name, row.witness.firstVerified).slice(0, 600), formatEncoded(row.entry.name, row.score?.firstInput ?? null).slice(0, 600), row.instrumentFailure ?? `ok: ${row.score?.verified ?? 0} verified`,
  ])))
  write()
  write(`- Rows the score pass found that baseline.jsonl doesn't have: ${listOrNone(extraRows.map((row) => `${row.copy}.${row.entry} ${siteLabel(row.site)} ${row.cause} x${row.count}`), '; ')}`)
  write(`- Masked kills (registered kills whose every killing site is a finding site): ${listOrNone([...maskedKills.values()].flat())}`)
  write()
  write('## missedFiring per entry (R-S4)')
  write()
  write(table(['copy', 'entry', 'in-domain quiet inputs sampled', 'draws', 'misses', 'first misses'], [...scores.values()].map((score) => [score.base, score.entry, score.missed.sampled, score.missed.draws, score.missed.missCount, score.missed.misses.slice(0, 3).map((miss) => `#${miss.index}: ${miss.lines.join(', ')}`).join('; ')])))
  write()
  const failing = rows.filter((row) => row.score != null && row.score.failureCount > 0)
  if (failing.length > 0) {
    write('## Instrument gate failures')
    write()
    for (const row of failing) write(`- ${row.copy}.${row.entry.name} ${siteLabel(row.site)} ${row.cause}: ${JSON.stringify(row.score!.failures.slice(0, 5))}`)
    write()
  }
  if (oracle && carriedRun != null) {
    const carriedRunData = carriedRun
    write('## Caller rules applied (R-D4 provenance)')
    write()
    write(table(['copy', 'entry', 'provenance'], run.plan.copies.flatMap((copy) => copy.entries.filter((entry) => entry.callerRules.length > 0).map((entry) => [copy.copy, entry.name, entry.provenance.join(' | ')]))))
    write()
    write('## Caller discards and in-domain inputs (R-D5, budget gate)')
    write()
    write(table(['copy', 'entry', 'caller rules', 'inputs', 'leading-assert and leak discards', 'caller discards', 'past the step budget', 'in-domain inputs', `at least ${registration.gates.budgetStarvationMinimum}`], [...run.baseline.values()].filter((line) => run.copyOf.get(line.base)!.entries.some((entry) => entry.name === line.entry && entry.callerRules.length > 0)).map((line) => {
      const inDomain = line.inputs - line.discarded - line.callerDiscarded - line.overBudget
      const entry = run.copyOf.get(line.base)!.entries.find((candidate) => candidate.name === line.entry)!
      return [line.base, line.entry, entry.callerRules.map((callerRule) => callerRule.id).join(', '), line.inputs, line.discarded, line.callerDiscarded, line.overBudget, inDomain, inDomain >= registration.gates.budgetStarvationMinimum ? 'yes' : 'no: budget starved']
    })))
    write()
    write('## removedByCallerDomain (R-D5): domain@v2 rows and domain@v3-callers rows')
    write()
    const removedRows: (string | number)[][] = []
    for (const carried of carriedRows) {
      const current = rows.find((row) => row.copy === carried.copy && row.entry.name === carried.entry && row.site.key === carried.site.key && row.cause === carried.cause)
      removedRows.push([carried.copy, carried.entry, siteLabel(carried.site), carried.cause, carried.count, current?.count ?? 0, current == null ? removedBy(carried.copy, carried.entry, carried.firstInput) : ''])
    }
    for (const row of rows) {
      if (carriedRows.some((carried) => carried.copy === row.copy && carried.entry === row.entry.name && carried.site.key === row.site.key && carried.cause === row.cause)) continue
      removedRows.push([row.copy, row.entry.name, siteLabel(row.site), row.cause, 0, row.count, 'new under domain@v3-callers'])
    }
    write(table(['copy', 'entry', 'site', 'cause', 'domain@v2 count', 'domain@v3-callers count', 'caller rules the domain@v2 first input of the row violates'], removedRows))
    write()
    write('## Kills whose domain@v2 first killing input violates a caller rule (R-D5)')
    write()
    const killRows: (string | number)[][] = []
    for (const mutant of carriedRunData.plan.mutants) {
      const first = carriedRunData.summaries.get(mutant.key)?.first[CRITERION_RULE] ?? null
      if (first?.first.input == null) continue
      const entry = run.copyOf.get(mutant.copy)?.entries.find((candidate) => candidate.name === first.entry)
      if (entry == null || entry.callerRules.length === 0) continue
      const violated = violatedRules(entry.callerRules, decodeJson(first.first.input) as Value[])
      if (violated.length === 0) continue
      const copyRule = job.rules.data.copies.find((candidate) => candidate.id === mutant.copy)
      const role = (copyRule?.expectedKills ?? []).includes(mutant.id) ? 'registered catch' : (copyRule?.staticOnly ?? []).includes(mutant.id) ? 'static-only' : 'not registered'
      const current = run.summaries.get(mutant.key)?.first[CRITERION_RULE] ?? null
      killRows.push([mutant.key, role, formatInput(first.entry, first.first).slice(0, 500), violated.join(', '), current == null ? 'not killed' : `${formatInput(current.entry, current.first).slice(0, 500)} through ${siteLabel(run.copyOf.get(mutant.copy)!.sites[current.site]!)} (${PRODUCERS[current.first.producer]}, ${current.first.cause})`])
    }
    write(table(['mutant', 'role', 'domain@v2 first killing input', 'caller rules it violates', 'domain@v3-callers first killing input'], killRows))
    write()
    write('- falseAlarm@asWritten above is exposure-informed: the caller rules were written after these firings were seen, so it is not evidence on m2-m4.')
    write()
  }
  write('## Limits (decision-domain.md §4)')
  write()
  write('- A witness at site level can cover an unrealistic mechanism at the same site: compare the first witness input with the lattice first input.')
  write('- Witness sets exist only where hand-built caller-derived sweeps exist. A real counterexample the recorded sweeps never reached still counts as a false alarm.')
  write('- The witness tables come from one witness run over the domain@v2 runs\' spliced trees; the spliced trees of this run are identical (the G0 plan-only regression compares them).')
  write()
  write('## Scoring children: timing and memory')
  write()
  write(table(['copy', 'exit', 'timed out', 'seconds', 'max RSS (KB)'], children.map((child) => [child.copy, String(child.exitCode), child.timedOut ?? 'no', (child.ms / 1000).toFixed(1), child.maxRssKb ?? ''])))
  write()
  writeFileSync(join(job.outDir, 'scoring.md'), `${out.join('\n')}\n`)

  const instrumentDir = dirname(new URL(import.meta.url).pathname)
  const instrumentFiles = readdirSync(instrumentDir).filter((name) => name.endsWith('.ts')).sort()
  writeFileSync(join(job.outDir, 'scoring.json'), `${JSON.stringify({
    id: job.rules.id, arm: oracle ? 'oracle arm (domain@v3-callers)' : 'domain@v2 run rescored', sourceDir: job.sourceDir, outDir: job.outDir,
    rulesSha1: sha1(readFileSync(job.rulesPath)), registrationSha1, witnessMetaSha1, tableSha1s, carried: job.carried,
    instrumentCommit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: instrumentDir}).stdout.toString().trim(),
    instrumentDirty: Bun.spawnSync(['git', 'status', '--porcelain', '--', '.'], {cwd: instrumentDir}).stdout.toString().trim() !== '',
    instrumentSha1: sha1(instrumentFiles.map((name) => `${name}\n${readFileSync(join(instrumentDir, name), 'utf8')}`).join('\n')),
    copyScores, overall, extraRows: extraRows.length, children: children.map(({stderr, ...child}) => ({...child, stderrTail: stderr.slice(-500)})),
    wallSeconds: (performance.now() - wallStart) / 1000, parentMaxRssKb: process.resourceUsage().maxRSS, finished: new Date().toISOString(),
  }, null, 1)}\n`)
}
