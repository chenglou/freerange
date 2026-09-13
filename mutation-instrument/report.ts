// report.md, kills.tsv and criterion1.txt from a run directory. results.jsonl is streamed one line at a time and only a
// small summary per mutant is kept.
// usage: bun mutation-instrument/report.ts <run dir> <m1.json>   (rewrites the report of an existing run)
import {createReadStream, existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createInterface} from 'node:readline'
import type {Value} from './domain.ts'
import {decodeJson, formatCall} from './encode.ts'
import {CRITERION_RULE, NOISE_RULES, type BaselineLine, type FirstFiring, type Plan, type ReplayLine, type ResultLine, type Site, type VerifyLine} from './types.ts'

export type Rules = {
  measured_on: string
  domains_label: string
  data: {scratch: string; basesDir: string; bases: string[]; referenceRecord: string; referenceRun: string; sweepCopyDir: string; knownFalse: string; sweepEntries: string[]; designSweepEntries: string[]}
  domain: {cap: number; maxArrayLength: number}
  lattice: {budget: number; seed: number; p0Inputs: number; p2ProductMax: number}
  rules: {noise: {criterion: string}}
  execution: {children: number; heartbeatEveryInputs: number; heartbeatTimeoutSeconds: number; projectionMaxMinutes: number}
  predictions: Record<string, string | number>
}

export type ReferenceRow = {
  id: string
  family: string
  base: string
  fn: string
  line: number
  op: string
  after: string
  path: string
  diff: {n: number; diffs: number}
  sweep: {caught: boolean; label?: string; fn?: string; line?: number; evals?: number}
}

type FailureLine = {type: 'failure'; mutant: string; base: string; exitCode: number | null; timedOut: string | null; stderr: string}
type ReplayRecord = {mutant: string; sweepExit: number | null; sweepFirst: {fn: string; label: string; line: number; firstCall: string; firstArgs: string} | null; sweepEvaluations: number | null; replay: ReplayLine | null}
type VerifyRecord = {base: string; entry: string; site: number; verify: VerifyLine | null}
type KnownFalse = {entries: {id: string; base: string; function: string; text: string; occurrence: number; cause: string}[]}
type ProbeRow = {mutant: string; findings: {kind: string; count: number}[]}
type Kill = {entry: string; site: number; first: FirstFiring}

type MutantSummary = {
  id: string
  base: string
  entries: number
  killSites: Set<number>[] // per rule
  first: (Kill | null)[] // per rule, the killing input with the lowest index
  laterProducer: boolean[] // per rule: some kill came from P1-P3
  sweepEntryKill: boolean[] // per rule, through the sweep's 9 entries
  designEntryKill: boolean[] // per rule, through the design's 7 entries
  cleanKill: boolean // criterion rule, through a site with 0 baseline firings for that entry
  throws: number
  throwFirst: string | null
  nonFinite: number
  nonFiniteFirst: string | null
  behaviorDiffs: number
  behaviorFirst: string | null
  digestMismatches: number
  failure: string | null
}

async function* jsonLines(path: string): AsyncGenerator<unknown> {
  if (!existsSync(path)) return
  const reader = createInterface({input: createReadStream(path), crlfDelay: Infinity})
  for await (const line of reader) if (line !== '') yield decodeJson(line)
}

function formatInput(entry: string, first: FirstFiring | null): string {
  if (first == null) return ''
  return first.input == null ? '(input above 2 KB, not kept)' : formatCall(entry, decodeJson(first.input) as Value[])
}

const PRODUCERS = ['P0', 'P1', 'P2', 'P3']
const RULE_LABELS = NOISE_RULES.map((rule) => `noise@${rule}`)

function listOrNone(items: string[], separator = ', ') {
  return items.length === 0 ? 'none' : items.join(separator)
}

function cell(text: string | number) {
  return String(text).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function table(header: string[], rows: (string | number)[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
}

export async function writeReport(outDir: string, rules: Rules, reference: ReferenceRow[]) {
  const meta = decodeJson(readFileSync(join(outDir, 'meta.json'), 'utf8')) as Record<string, unknown>
  const plan = decodeJson(readFileSync(join(outDir, 'plan.json'), 'utf8')) as Plan
  const knownFalse = decodeJson(readFileSync(join(rules.data.scratch, rules.data.knownFalse), 'utf8')) as KnownFalse
  const sitesOf = new Map<string, Site[]>(plan.bases.map((base) => [base.base, base.sites]))
  const digestOf = new Map<string, number>()
  for (const base of plan.bases) for (const entry of base.entries) digestOf.set(`${base.base}.${entry.name}`, entry.digest)
  const referenceById = new Map(reference.map((row) => [row.id, row]))
  const planned = plan.mutants.map((mutant) => referenceById.get(mutant.id)!)

  // -- baseline --
  const baseline = new Map<string, BaselineLine>()
  let baselineDigestMismatches = 0
  for await (const value of jsonLines(join(outDir, 'baseline.jsonl'))) {
    const line = value as BaselineLine
    baseline.set(`${line.base}.${line.entry}`, line)
    if (line.digest !== digestOf.get(`${line.base}.${line.entry}`)) baselineDigestMismatches += 1
  }
  const baselineFires = (base: string, entry: string, site: number, rule: number) => {
    const firing = baseline.get(`${base}.${entry}`)?.firings.find((candidate) => candidate.site === site)
    return firing == null ? 0 : firing.counts[rule]!.reduce((sum, count) => sum + count, 0)
  }

  // -- results, streamed --
  const summaries = new Map<string, MutantSummary>()
  const summaryOf = (id: string, base: string) => {
    let summary = summaries.get(id)
    if (summary == null) {
      summary = {
        id, base, entries: 0, killSites: NOISE_RULES.map(() => new Set<number>()), first: NOISE_RULES.map(() => null), laterProducer: NOISE_RULES.map(() => false),
        sweepEntryKill: NOISE_RULES.map(() => false), designEntryKill: NOISE_RULES.map(() => false), cleanKill: false,
        throws: 0, throwFirst: null, nonFinite: 0, nonFiniteFirst: null, behaviorDiffs: 0, behaviorFirst: null, digestMismatches: 0, failure: null,
      }
      summaries.set(id, summary)
    }
    return summary
  }
  let resultLines = 0
  for await (const value of jsonLines(join(outDir, 'results.jsonl'))) {
    const line = value as ResultLine | FailureLine
    if (line.type === 'failure') {
      summaryOf(line.mutant, line.base).failure = line.timedOut ?? `exit ${line.exitCode}: ${line.stderr.slice(-300)}`
      continue
    }
    resultLines += 1
    const summary = summaryOf(line.mutant, line.base)
    summary.entries += 1
    if (line.digest !== digestOf.get(`${line.base}.${line.entry}`)) summary.digestMismatches += 1
    for (const kill of line.kills) {
      for (let rule = 0; rule < NOISE_RULES.length; rule++) {
        const first = kill.first[rule]
        if (first == null) continue
        summary.killSites[rule]!.add(kill.site)
        const counts = kill.counts[rule]!
        if (counts[1]! + counts[2]! + counts[3]! > 0) summary.laterProducer[rule] = true
        if (rules.data.sweepEntries.includes(line.entry)) summary.sweepEntryKill[rule] = true
        if (rules.data.designSweepEntries.includes(line.entry)) summary.designEntryKill[rule] = true
        const previous = summary.first[rule]
        if (previous == null || first.index < previous.first.index) summary.first[rule] = {entry: line.entry, site: kill.site, first}
        if (rule === CRITERION_RULE && baselineFires(line.base, line.entry, kill.site, rule) === 0) summary.cleanKill = true
      }
    }
    summary.throws += line.throws.count
    summary.throwFirst ??= line.throws.first == null ? null : `${line.entry}: ${line.throws.detail} at ${formatInput(line.entry, line.throws.first)}`
    summary.nonFinite += line.nonFiniteReturns.count
    summary.nonFiniteFirst ??= line.nonFiniteReturns.first == null ? null : `${line.entry}: ${line.nonFiniteReturns.detail} at ${formatInput(line.entry, line.nonFiniteReturns.first)}`
    summary.behaviorDiffs += line.behavior.count
    summary.behaviorFirst ??= line.behavior.first == null ? null : `${formatInput(line.entry, line.behavior.first)}: ${line.behavior.detail}`
  }
  const killed = (id: string, rule: number) => (summaries.get(id)?.killSites[rule]!.size ?? 0) > 0
  const siteLine = (base: string, site: number) => sitesOf.get(base)![site]!

  // -- reference run (input-range probe) --
  const probeKilled = new Set<string>()
  const probeRun = new Set<string>()
  for await (const value of jsonLines(join(rules.data.scratch, rules.data.referenceRun))) {
    const row = value as ProbeRow
    probeRun.add(row.mutant)
    if (row.findings.some((finding) => ['interior assert', 'callee requirement', 'callee assert'].includes(finding.kind) && finding.count > 0)) probeKilled.add(row.mutant)
  }

  const replays: ReplayRecord[] = []
  for await (const value of jsonLines(join(outDir, 'replay.jsonl'))) replays.push(value as ReplayRecord)
  const verifies: VerifyRecord[] = []
  for await (const value of jsonLines(join(outDir, 'verify.jsonl'))) verifies.push(value as VerifyRecord)

  const out: string[] = []
  const write = (text = '') => out.push(text)

  // 1. Provenance
  write('# Plan A milestone 1: virtualization calibration run')
  write()
  write(`- **measured_on:** ${rules.measured_on}`)
  write(`- **domains:** ${rules.domains_label}`)
  for (const key of ['instrumentCommit', 'instrumentDirty', 'instrumentSha1', 'bun', 'rulesPath', 'rulesSha1', 'knownFalsePath', 'knownFalseSha1', 'started', 'finished', 'status', 'subset', 'siteCheck']) write(`- **${key}:** ${JSON.stringify(meta[key])}`)
  write(`- **inputSha1:** ${JSON.stringify(meta['inputSha1'])}`)
  write(`- **settings:** ${JSON.stringify(plan.settings)}; cap ±${rules.domain.cap}; ${rules.execution.children} children`)
  write(`- **Freerange findings:** ${JSON.stringify(meta['freerange'])}`)
  const failures = [...summaries.values()].filter((summary) => summary.failure != null)
  const digestMismatches = [...summaries.values()].reduce((sum, summary) => sum + summary.digestMismatches, 0) + baselineDigestMismatches
  write(`- **run quality:** ${summaries.size - failures.length} of ${plan.mutants.length} mutants finished; ${resultLines} result lines; ${failures.length} child failures or timeouts; input digest mismatches between parent and children: ${digestMismatches}`)
  write()

  // 2. Criterion 1
  const recorded = planned.filter((row) => row.sweep.caught)
  const criterionReproduced = recorded.filter((row) => killed(row.id, CRITERION_RULE))
  const criterionLines: string[] = []
  write('## 2. Criterion 1: recorded sweep kills reproduced')
  write()
  write(`Recorded sweep kills among the planned mutants: ${recorded.length} (of ${planned.filter((row) => row.diff.diffs > 0).length} behavior-changing in the record).`)
  write()
  const familyNames = ['grid', 'rowWindow', 'picker', 'sref', 'feed']
  const ruleRows = NOISE_RULES.map((_rule, rule) => {
    const reproduced = recorded.filter((row) => killed(row.id, rule))
    return [
      `${RULE_LABELS[rule]}${rule === CRITERION_RULE ? ' (criterion)' : ''}`, reproduced.length,
      ...familyNames.map((family) => `${reproduced.filter((row) => row.family === family).length}/${recorded.filter((row) => row.family === family).length}`),
      recorded.filter((row) => summaries.get(row.id)?.sweepEntryKill[rule] === true).length,
      recorded.filter((row) => summaries.get(row.id)?.designEntryKill[rule] === true).length,
    ]
  })
  write(table(['rule', 'reproduced', ...familyNames, 'through the 9 sweep entries', 'through the design\'s 7 entries'], ruleRows))
  write()
  const cleanReproduced = recorded.filter((row) => summaries.get(row.id)?.cleanKill === true).length
  const siteAgreement = criterionReproduced.filter((row) => row.sweep.line != null && [...summaries.get(row.id)!.killSites[CRITERION_RULE]!].some((site) => siteLine(row.base, site).line === row.sweep.line))
  write(`- kill@cleanSite under noise@abs1e-9: ${cleanReproduced} of ${recorded.length}`)
  write(`- Site-level agreement: for ${siteAgreement.length} of ${criterionReproduced.length} reproduced kills, the sweep's first failing line is among this run's killing sites.`)
  const disagreeing = criterionReproduced.filter((row) => !siteAgreement.includes(row))
  if (disagreeing.length > 0) write(`- Reproduced without the sweep's first failing line: ${disagreeing.map((row) => `${row.id} (sweep :${row.sweep.line} ${row.sweep.label}; here ${[...summaries.get(row.id)!.killSites[CRITERION_RULE]!].map((site) => `:${siteLine(row.base, site).line}`).join(' ')})`).join('; ')}`)
  const gate = plan.mutants.length !== reference.length ? `not applicable: subset run of ${plan.mutants.length} mutants`
    : criterionReproduced.length >= 288 ? 'go: >= 288, proceed to milestone 2' : criterionReproduced.length >= 260 ? 'diagnose: 260-287, replay misses and name each lattice gap' : 'stop: < 260, diagnose against the reference run'
  write(`- **Gate:** ${criterionReproduced.length} of ${recorded.length} under noise@abs1e-9 → ${gate}`)
  write()
  criterionLines.push(`criterion 1 kill clause, virtualization sysmut (exposed development data; calibration)`, `reproduced under kill@perInput noise@abs1e-9: ${criterionReproduced.length} of ${recorded.length}`)
  for (let rule = 0; rule < NOISE_RULES.length; rule++) criterionLines.push(`  ${RULE_LABELS[rule]}: ${recorded.filter((row) => killed(row.id, rule)).length}`)
  criterionLines.push(`gate: ${gate}`)

  write('### Misses under the criterion rule, with replay')
  write()
  const missRows = recorded.filter((row) => !killed(row.id, CRITERION_RULE)).map((row) => {
    const replay = replays.find((record) => record.mutant === row.id)
    let verdict = 'not replayed'
    let firstInput = ''
    if (replay?.sweepFirst != null) {
      firstInput = `${replay.sweepFirst.firstCall}(${replay.sweepFirst.firstArgs.slice(1, -1)})`
      const outcome = replay.replay
      if (outcome == null) verdict = 'replay child failed'
      else if (outcome.discarded) verdict = 'outside this run\'s declared domain (discarded on the original)'
      else {
        const originalLevels = new Map(outcome.original)
        const newSites = outcome.mutated.filter(([site, level]) => level >= 3 && (originalLevels.get(site) ?? 0) < 3)
        const exactSites = outcome.mutated.filter(([site, level]) => level >= 2 && (originalLevels.get(site) ?? 0) < 2)
        verdict = newSites.length > 0
          ? `fires here: lattice gap (${newSites.map(([site]) => `:${siteLine(row.base, site).line}`).join(' ')})`
          : exactSites.length > 0 ? `fires here only under noise@none (${exactSites.map(([site]) => `:${siteLine(row.base, site).line}`).join(' ')})` : 'does not fire here: runner disagreement'
      }
    } else if (replay != null) {
      verdict = `sweep --first printed no failure (exit ${replay.sweepExit})`
    }
    return [row.id, `${row.fn}:${row.line} ${row.op}`, row.after, `${row.sweep.label} :${row.sweep.line} after ${row.sweep.evals}`, killed(row.id, 0) ? 'yes' : 'no', firstInput, verdict]
  })
  write(missRows.length === 0 ? 'None.' : table(['mutant', 'mutation', 'after', 'sweep first failure', 'killed under noise@none', 'sweep first input', 'replay'], missRows))
  write()

  // 3. Kills beyond the record
  write('## 3. Kills beyond the record (criterion rule)')
  write()
  const extras = planned.filter((row) => !row.sweep.caught && killed(row.id, CRITERION_RULE))
  write(extras.length === 0 ? 'None.' : table(['mutant', 'mutation', 'record diffs', 'probe killed', 'site', 'producer', 'cause', 'first killing input'], extras.map((row) => {
    const first = summaries.get(row.id)!.first[CRITERION_RULE]!
    const site = siteLine(row.base, first.site)
    return [row.id, `${row.fn}:${row.line} ${row.op} | ${row.after}`, `${row.diff.diffs}/${row.diff.n}`, probeKilled.has(row.id) ? 'yes' : 'no', `${site.functionName}:${site.line} ${site.text}`, PRODUCERS[first.first.producer]!, first.first.cause, formatInput(first.entry, first.first)]
  })))
  write()

  // 4. Producer attribution
  write('## 4. Producer attribution (criterion rule)')
  write()
  const killedMutants = planned.filter((row) => killed(row.id, CRITERION_RULE))
  const p0Only = killedMutants.filter((row) => !summaries.get(row.id)!.laterProducer[CRITERION_RULE])
  write(`- Killed only by P0 inputs (the exposure-informed phase): ${p0Only.length}${p0Only.length > 0 ? `: ${p0Only.map((row) => `${row.id}${row.sweep.caught ? ' (recorded)' : ''}`).join(', ')}` : ''}`)
  write(`- First killing input by producer: ${PRODUCERS.map((name, producer) => `${name} ${killedMutants.filter((row) => summaries.get(row.id)!.first[CRITERION_RULE]!.first.producer === producer).length}`).join(', ')}`)
  const s158 = summaries.get('s158')
  if (s158 != null) write(`- s158: killed ${s158.killSites[CRITERION_RULE]!.size > 0 ? 'yes' : 'no'}; first killing input ${formatInput(s158.first[CRITERION_RULE]?.entry ?? '', s158.first[CRITERION_RULE]?.first ?? null)} (${s158.first[CRITERION_RULE] == null ? '' : PRODUCERS[s158.first[CRITERION_RULE].first.producer]})`)
  write()

  // 5. Agreement with the reference run
  write('## 5. Per-mutant agreement with the reference run (input-range probe, assert kinds)')
  write()
  const compared = planned.filter((row) => probeRun.has(row.id))
  const both = compared.filter((row) => killed(row.id, CRITERION_RULE) && probeKilled.has(row.id))
  const onlyHere = compared.filter((row) => killed(row.id, CRITERION_RULE) && !probeKilled.has(row.id))
  const onlyThere = compared.filter((row) => !killed(row.id, CRITERION_RULE) && probeKilled.has(row.id))
  write(`- compared: ${compared.length}; killed in both ${both.length}; only here ${onlyHere.length}; only in the probe ${onlyThere.length}`)
  write(`- only here: ${listOrNone(onlyHere.map((row) => row.id))}`)
  write(`- only in the probe: ${listOrNone(onlyThere.map((row) => `${row.id}${row.sweep.caught ? ' (recorded)' : ''}`))}`)
  write()

  // 6. Baseline
  write('## 6. Baseline firings on the originals')
  write()
  const knownKeys = new Set(knownFalse.entries.map((entry) => `${entry.base}|${entry.function}|${entry.text}|${entry.occurrence}|${entry.cause}`))
  const baselineRows: (string | number)[][] = []
  let offList = 0
  let notReproducible = 0
  for (const line of baseline.values()) {
    for (const firing of line.firings) {
      const site = siteLine(line.base, firing.site)
      const totals = firing.counts.map((counts) => counts.reduce((sum, count) => sum + count, 0))
      const criterionFirst = firing.first[CRITERION_RULE] ?? null
      const causes = Object.entries(firing.byCause).filter(([, count]) => count > 0)
      const off = causes.filter(([cause]) => !knownKeys.has(`${site.key}|${cause}`))
      if (criterionFirst != null && off.length > 0) offList += 1
      const verify = verifies.find((record) => record.base === line.base && record.entry === line.entry && record.site === firing.site)?.verify ?? null
      const entry = plan.bases.find((base) => base.base === line.base)!.entries.find((candidate) => candidate.name === line.entry)!
      const leadingLines = new Set(entry.preconditions.map((precondition) => precondition.line))
      let reproducible = ''
      if (criterionFirst != null) {
        const reproduces = verify != null && verify.firedLines.includes(site.line) && !verify.firedLines.some((firedLine) => leadingLines.has(firedLine))
        if (!reproduces) notReproducible += 1
        reproducible = verify == null ? 'not verified' : reproduces ? 'reproduces' : `does not reproduce (fired ${verify.firedLines.join(',')})`
      }
      const first = criterionFirst ?? firing.first[0] ?? null
      baselineRows.push([line.entry, `${site.functionName}:${site.line} ${site.text}`, totals.join(' / '), causes.map(([cause, count]) => `${cause} ${count}`).join(', '), first == null ? '' : `${PRODUCERS[first.producer]} #${first.index}`, first?.margin ?? '', formatInput(line.entry, first), off.length > 0 && criterionFirst != null ? 'off-list' : criterionFirst == null ? '(noise only)' : 'on list', reproducible])
    }
  }
  write(baselineRows.length === 0 ? 'No site fired on the originals under any rule.' : table(['entry', 'site', 'inputs firing (none / abs1e-9 / literal)', 'cause classes (criterion)', 'first', 'margin', 'first input', 'known-false list', 'uninstrumented replay'], baselineRows))
  write()
  write(`- **falseAlarm@asWritten:** ${offList} off-list baseline firing sites under noise@abs1e-9 → ${offList === 0 ? 'pass' : 'fail (published; the list is not amended)'}`)
  write(`- **falseAlarm@reproducible:** ${notReproducible} firings that don't reproduce on the uninstrumented original or break the entry's leading asserts → ${notReproducible === 0 ? 'pass' : 'fail: instrument bug'}`)
  write(`- Baseline discards per entry: ${[...baseline.values()].map((line) => `${line.entry} ${line.discarded}`).join(', ')}`)
  write(`- Baseline throws and non-finite returns: ${listOrNone([...baseline.values()].filter((line) => line.throws.count + line.nonFiniteReturns.count > 0).map((line) => `${line.entry}: throws ${line.throws.count}, non-finite ${line.nonFiniteReturns.count} ${line.nonFiniteReturns.detail ?? ''}`), '; ')}`)
  write()

  write('### Asserts Freerange could not prove or check, joined by line')
  write()
  const frRows: (string | number)[][] = []
  for (const base of plan.bases) {
    const path = join(outDir, `fr-${base.base}.txt`)
    if (!existsSync(path)) continue
    for (const match of readFileSync(path, 'utf8').matchAll(/\((\d+),\d+\): (?:error|warning) \[console-assert\]: (could not (?:prove|check))/g)) {
      const lineNumber = Number(match[1])
      const site = base.sites.find((candidate) => candidate.line === lineNumber)
      if (site == null) {
        frRows.push([base.base, lineNumber, match[2]!, '(no site on this line)', '', '', ''])
        continue
      }
      let reached = 0
      let firstFiring: {entry: string; first: FirstFiring; total: number} | null = null
      for (const entry of base.entries) {
        const line = baseline.get(`${base.base}.${entry.name}`)
        if (line == null) continue
        reached += line.reached[site.index] ?? 0
        const firing = line.firings.find((candidate) => candidate.site === site.index)
        const first = firing?.first[CRITERION_RULE] ?? null
        if (firing != null && first != null && (firstFiring == null || entry.name === site.functionName)) firstFiring = {entry: entry.name, first, total: firing.counts[CRITERION_RULE]!.reduce((sum, count) => sum + count, 0)}
      }
      frRows.push([base.base, `${site.functionName}:${lineNumber} ${site.text}`, match[2]!, reached, firstFiring == null ? 0 : firstFiring.total, firstFiring == null ? '' : firstFiring.first.cause, firstFiring == null ? '' : formatInput(firstFiring.entry, firstFiring.first)])
    }
  }
  const counterexamples = frRows.filter((row) => typeof row[4] === 'number' && row[4] > 0).length
  const unreached = frRows.filter((row) => row[3] === 0).length
  write(`${frRows.length} Freerange console-assert findings on the bases; ${frRows.length - unreached} reached by the lattice; ${counterexamples} with a counterexample under noise@abs1e-9. Reached counts sum over entries.`)
  write()
  write(table(['base', 'site', 'Freerange', 'in-domain inputs reaching it', 'firing inputs (criterion)', 'cause', 'first counterexample'], frRows))
  write()

  // 7. Behavior
  write('## 7. Behavior on the lattice (behavior@v1)')
  write()
  const equivalent = planned.filter((row) => summaries.get(row.id)?.behaviorDiffs === 0 && summaries.get(row.id)?.failure == null)
  write(`- lattice-equivalent: ${equivalent.length} of ${planned.length}; behavior-changing on the lattice: ${planned.length - equivalent.length}; record: ${planned.filter((row) => row.diff.diffs > 0).length} behavior-changing`)
  write(`- lattice-equivalent but behavior-changing in the record: ${listOrNone(equivalent.filter((row) => row.diff.diffs > 0).map((row) => row.id))}`)
  write(`- behavior-changing here but equivalent in the record: ${listOrNone(planned.filter((row) => row.diff.diffs === 0 && (summaries.get(row.id)?.behaviorDiffs ?? 0) > 0).map((row) => row.id))}`)
  write()
  const survivors = planned.filter((row) => (summaries.get(row.id)?.behaviorDiffs ?? 0) > 0 && !killed(row.id, CRITERION_RULE))
  write(`Survivors that change behavior (criterion rule): ${survivors.length}`)
  write()
  write(table(['mutant', 'mutation', 'sweep', 'differing inputs', 'first output difference'], survivors.map((row) => [row.id, `${row.fn}:${row.line} ${row.op} | ${row.after}`, row.sweep.caught ? `caught ${row.sweep.label}` : 'missed', summaries.get(row.id)!.behaviorDiffs, (summaries.get(row.id)!.behaviorFirst ?? '').slice(0, 300)])))
  write()

  // 8. Separate columns
  write('## 8. Separate columns: throw, nonFiniteReturn, timeout')
  write()
  const throwing = planned.filter((row) => (summaries.get(row.id)?.throws ?? 0) > 0)
  const nonFinite = planned.filter((row) => (summaries.get(row.id)?.nonFinite ?? 0) > 0)
  write(`- throw: ${throwing.length} mutants${throwing.length > 0 ? `: ${throwing.map((row) => `${row.id} (${summaries.get(row.id)!.throwFirst})`).join('; ')}` : ''}`)
  write(`- nonFiniteReturn: ${nonFinite.length} mutants${nonFinite.length > 0 ? `: ${nonFinite.map((row) => `${row.id} (${summaries.get(row.id)!.nonFiniteFirst})`).join('; ')}` : ''}`)
  write(`- timeout or crash: ${failures.length}${failures.length > 0 ? `: ${failures.map((summary) => `${summary.id} (${summary.failure})`).join('; ')}` : ''}`)
  write()

  // 9. Per assert site
  write('## 9. Kills per assert site (criterion rule; input for criterion 2, not scored)')
  write()
  const siteRows: (string | number)[][] = []
  for (const base of plan.bases) {
    const mutantsOfBase = planned.filter((row) => row.base === base.base && killed(row.id, CRITERION_RULE))
    for (const site of base.sites) {
      let kills = 0
      let unique = 0
      for (const row of mutantsOfBase) {
        const killingSites = summaries.get(row.id)!.killSites[CRITERION_RULE]!
        if (!killingSites.has(site.index)) continue
        kills += 1
        if (![...killingSites].some((other) => other !== site.index && base.sites[other]!.functionName === site.functionName)) unique += 1
      }
      if (kills > 0) siteRows.push([base.base, `${site.functionName}:${site.line}`, site.text, site.leading ? 'leading' : '', kills, unique])
    }
  }
  write(table(['base', 'site', 'condition', 'leading', 'mutants killed', 'unique within function'], siteRows))
  write()

  // 10. Timing
  write('## 10. Timing and memory')
  write()
  for (const key of ['wallSeconds', 'projection', 'mutantPass', 'baselineChild', 'parentMaxRssKb', 'maxChildRssKb', 'concurrentRssBoundKb']) write(`- **${key}:** ${JSON.stringify(key === 'baselineChild' ? {...(meta[key] as Record<string, unknown>), stderr: undefined} : meta[key])}`)
  write()
  write('## Registered predictions')
  write()
  for (const [key, prediction] of Object.entries(rules.predictions)) write(`- ${key}: ${prediction}`)
  write()
  writeFileSync(join(outDir, 'report.md'), `${out.join('\n')}\n`)
  writeFileSync(join(outDir, 'criterion1.txt'), `${criterionLines.join('\n')}\n`)

  const tsv = [['mutant', 'base', 'family', 'fn', 'line', 'op', 'record_diffs', 'sweep_caught', 'sweep_label', 'sweep_line', ...RULE_LABELS.map((label) => `kill_${label}`), 'kill_cleanSite', 'kill_sweep_entries', 'first_producer', 'first_cause', 'killing_lines', 'throws', 'non_finite', 'behavior_diffs', 'probe_killed', 'failure'].join('\t')]
  for (const row of planned) {
    const summary = summaries.get(row.id)
    const first = summary?.first[CRITERION_RULE] ?? null
    tsv.push([
      row.id, row.base, row.family, row.fn, row.line, row.op, row.diff.diffs, row.sweep.caught, row.sweep.label ?? '', row.sweep.line ?? '',
      ...NOISE_RULES.map((_rule, rule) => killed(row.id, rule)), summary?.cleanKill ?? '', summary?.sweepEntryKill[CRITERION_RULE] ?? '',
      first == null ? '' : PRODUCERS[first.first.producer], first?.first.cause ?? '', summary == null ? '' : [...summary.killSites[CRITERION_RULE]!].map((site) => siteLine(row.base, site).line).sort((a, b) => a - b).join(','),
      summary?.throws ?? '', summary?.nonFinite ?? '', summary?.behaviorDiffs ?? '', probeRun.has(row.id) ? probeKilled.has(row.id) : '', summary?.failure ?? '',
    ].join('\t'))
  }
  writeFileSync(join(outDir, 'kills.tsv'), `${tsv.join('\n')}\n`)
}

if (import.meta.main) {
  const [runDir, rulesPath] = process.argv.slice(2)
  if (runDir == null || rulesPath == null) throw new Error('usage: bun mutation-instrument/report.ts <run dir> <m1.json>')
  const rules = decodeJson(readFileSync(rulesPath, 'utf8')) as Rules
  const reference = decodeJson(readFileSync(join(rules.data.scratch, rules.data.referenceRecord), 'utf8')) as ReferenceRow[]
  await writeReport(runDir, rules, reference)
}
