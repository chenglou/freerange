// report.md, kills.tsv and criterion1.txt from a run directory. results.jsonl is streamed one line at a time and only a
// small summary per mutant is kept. The reference sections differ per family: virtualization compares with the systematic
// mutants' sweep record; popovers, frames and packing with the planted mutants' record and the registered kill clause.
// usage: bun mutation-instrument/report.ts <run dir> <rules.json>   (rewrites the report of an existing run)
//        bun mutation-instrument/report.ts <run dir> <rules.json> --out <new dir>
//        (writes the report into a new directory; the run directory is only read)
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {maxMagnitude, type Value} from './domain.ts'
import {domainLines} from './domain-lines.ts'
import {decodeJson, formatCall} from './encode.ts'
import type {FramesReference, PackingReference, PlantedReference, RecordedCatch, Rules, SysmutRow} from './rules.ts'
import {formatInput, jsonLines, killed, listOrNone, loadRun, PRODUCERS, readLines, siteLabel, siteOf, table, type AsWrittenReport, type KillClause, type Run} from './run-data.ts'
import {CRITERION_RULE, NOISE_RULES, type CallLine, type CopyPlan, type FirstFiring, type ReplayLine, type Site} from './types.ts'

type SweepReplayRecord = {mutant: string; sweepExit: number | null; sweepFirst: {fn: string; label: string; line: number; firstCall: string; firstArgs: string} | null; sweepEvaluations: number | null; replay: ReplayLine | null}
type ExampleReplayRecord = {mutant: string; copy: string; id: string; source: string; helper: string; entry: string; args: string; replay: ReplayLine | null}
type CallRecord = {mutant: string; entry: string; site: number; input: string; call: CallLine | null}
type ProbeRow = {mutant: string; findings: {kind: string; count: number}[]}
type Writer = (text?: string) => void

const RULE_LABELS = NOISE_RULES.map((rule) => `noise@${rule}`)

function killingLines(run: Run, key: string, rule: number): string[] {
  const summary = run.summaries.get(key)
  if (summary == null) return []
  return [...summary.killSites[rule]!].map((site) => siteOf(run, summary.copy, site)).sort((a, b) => a.index - b.index).map((site) => `${site.file}:${site.line}`)
}

type FamilySections = {criterion: () => string[]; killClauses: KillClause[]; tsvColumns: string[]; tsv: (key: string) => (string | number | boolean)[]}

// -- Common sections ----------------------------------------------------------

function provenance(run: Run, write: Writer, title: string) {
  const {meta, plan, rules} = run
  write(`# ${title}`)
  write()
  write(`- **measured_on:** ${rules.measured_on}`)
  write(`- **domains:** ${rules.domains_label}`)
  for (const key of ['id', 'instrumentCommit', 'instrumentDirty', 'instrumentSha1', 'bun', 'rulesPath', 'rulesSha1', 'started', 'finished', 'status', 'subset', 'siteCheck']) write(`- **${key}:** ${JSON.stringify(meta[key])}`)
  write(`- **known-false lists:** ${JSON.stringify(meta['knownFalse'])}`)
  write(`- **inputSha1:** ${JSON.stringify(meta['inputSha1'])}`)
  write(`- **settings:** ${JSON.stringify(plan.settings)}; ${rules.domain.version}: cap ±${rules.domain.cap} on sides with no declared bound; ${rules.execution.children} children`)
  write(`- **Freerange findings:** ${JSON.stringify(meta['freerange'])}`)
  const failures = [...run.summaries.values()].filter((summary) => summary.failure != null)
  const digestMismatches = [...run.summaries.values()].reduce((sum, summary) => sum + summary.digestMismatches, 0) + run.baselineDigestMismatches
  write(`- **run quality:** ${run.summaries.size - failures.length} of ${plan.mutants.length} mutants finished; ${run.resultLines} result lines; ${failures.length} child failures or timeouts; input digest mismatches between parent and children: ${digestMismatches}`)
  write()
}

type FalseAlarmVerdicts = {offList: Map<string, Map<string, number>>; notReproducible: Map<string, number>; firingSites: Map<string, number>}

function baselineSection(run: Run, write: Writer): FalseAlarmVerdicts {
  write('## Baseline firings on the originals')
  write()
  const verdicts: FalseAlarmVerdicts = {offList: new Map(run.knownFalse.map((list) => [list.rule.label, new Map<string, number>()])), notReproducible: new Map(), firingSites: new Map()}
  const rows: (string | number)[][] = []
  for (const line of run.baseline.values()) {
    const copy = run.copyOf.get(line.base)!
    const entry = copy.entries.find((candidate) => candidate.name === line.entry)!
    const entryDomainLines = domainLines(copy, entry)
    for (const firing of line.firings) {
      const site = copy.sites[firing.site]!
      const totals = firing.counts.map((counts) => counts.reduce((sum, count) => sum + count, 0))
      const criterionFirst = firing.first[CRITERION_RULE] ?? null
      const causes = Object.entries(firing.byCause).filter(([, count]) => count > 0)
      const listStatus: string[] = []
      if (criterionFirst != null) {
        verdicts.firingSites.set(line.base, (verdicts.firingSites.get(line.base) ?? 0) + 1)
        for (const list of run.knownFalse) {
          if (!list.rule.copies.includes(line.base)) continue
          const off = causes.filter(([cause]) => !list.keys.has(`${line.base}|${site.key}|${cause}`))
          const counts = verdicts.offList.get(list.rule.label)!
          if (off.length > 0) counts.set(line.base, (counts.get(line.base) ?? 0) + 1)
          listStatus.push(`${list.rule.label}: ${off.length > 0 ? `off-list (${off.map(([cause]) => cause).join(', ')})` : 'on list'}`)
        }
      }
      const verify = run.verifies.find((record) => record.base === line.base && record.entry === line.entry && record.site === firing.site)?.verify ?? null
      let reproducible = ''
      if (criterionFirst != null) {
        const reproduces = verify != null && verify.fired.includes(`${site.file}:${site.line}`) && !verify.fired.some((fired) => entryDomainLines.has(fired))
        if (!reproduces) verdicts.notReproducible.set(line.base, (verdicts.notReproducible.get(line.base) ?? 0) + 1)
        reproducible = verify == null ? 'not verified' : reproduces ? 'reproduces' : `does not reproduce (fired ${verify.fired.join(',')})`
      }
      const first = criterionFirst ?? firing.first[0] ?? null
      rows.push([line.base, line.entry, siteLabel(site), totals.join(' / '), causes.map(([cause, count]) => `${cause} ${count}`).join(', '), first == null ? '' : `${PRODUCERS[first.producer]} #${first.index}`, first?.margin ?? '', formatInput(line.entry, first), criterionFirst == null ? '(noise only)' : listStatus.join('; '), reproducible])
    }
  }
  write(rows.length === 0 ? 'No site fired on the originals under any rule.' : table(['copy', 'entry', 'site', 'inputs firing (none / abs1e-9 / literal)', 'cause classes (criterion)', 'first', 'margin', 'first input', 'known-false lists', 'uninstrumented replay'], rows))
  write()
  for (const copy of run.plan.copies) {
    const lists = run.knownFalse.filter((list) => list.rule.copies.includes(copy.copy))
    for (const list of lists) {
      const off = verdicts.offList.get(list.rule.label)!.get(copy.copy) ?? 0
      write(`- **falseAlarm@asWritten, ${copy.copy}, against ${list.rule.label}** (${list.rule.stage}${list.rule.criterion ? ', the criterion list' : ''}, sha1 ${list.sha1 ?? 'missing'}): ${off} off-list firing sites under noise@abs1e-9 → ${off === 0 ? 'pass' : 'fail'}`)
    }
    const notReproducible = verdicts.notReproducible.get(copy.copy) ?? 0
    write(`- **falseAlarm@reproducible, ${copy.copy}:** ${notReproducible} firings that don't reproduce on the uninstrumented original or fire a domain line there → ${notReproducible === 0 ? 'pass' : 'fail: instrument bug'}`)
  }
  write(`- Baseline discards per entry: ${[...run.baseline.values()].map((line) => `${line.base}.${line.entry} ${line.discarded}`).join(', ')}`)
  write(`- Baseline inputs past the step budget of ${run.plan.stepBudget ?? 'none'} loop ticks per call: ${listOrNone([...run.baseline.values()].filter((line) => line.overBudget > 0).map((line) => `${line.base}.${line.entry} ${line.overBudget}`))}`)
  write(`- Baseline throws and non-finite returns: ${listOrNone([...run.baseline.values()].filter((line) => line.throws.count + line.nonFiniteReturns.count > 0).map((line) => `${line.base}.${line.entry}: throws ${line.throws.count}, non-finite ${line.nonFiniteReturns.count} ${line.nonFiniteReturns.detail ?? ''}`), '; ')}`)
  write()
  return verdicts
}

function domainSection(run: Run, write: Writer) {
  write('## Domains (per entry)')
  write()
  const rows: (string | number)[][] = []
  for (const copy of run.plan.copies) {
    for (const entry of copy.entries) {
      const own = entry.preconditions.filter((precondition) => precondition.origin === 'entry')
      const callee = entry.preconditions.filter((precondition) => precondition.origin === 'callee' && precondition.use !== 'unparsed')
      rows.push([
        copy.copy, `${entry.file}.${entry.name}`, entry.unsupported ?? entry.parameterNames.join(', '),
        `${own.filter((precondition) => precondition.use !== 'unparsed').length}/${own.length}`,
        listOrNone(callee.map((precondition) => `${precondition.callee}: ${precondition.text}`), '; '), entry.relations.length,
        listOrNone(entry.leakSites.map((site) => `${copy.sites[site]!.file}:${copy.sites[site]!.line}`)),
        listOrNone(entry.callerRules.map((callerRule) => callerRule.id)),
        run.baseline.get(`${copy.copy}.${entry.name}`)?.discarded ?? '', run.baseline.get(`${copy.copy}.${entry.name}`)?.callerDiscarded ?? '', run.baseline.get(`${copy.copy}.${entry.name}`)?.overBudget ?? '', JSON.stringify(entry.phases),
      ])
    }
  }
  write(table(['copy', 'entry', 'parameters', 'own leading conjuncts parsed', 'callee conjuncts substituted (domain@v2)', 'relations', 'leak sites (domain@v2)', 'caller rules (domain@v3-callers)', 'baseline discards', 'baseline caller discards', 'baseline past the step budget', 'phases'], rows))
  write()
}

function freerangeSection(run: Run, write: Writer) {
  write('### Asserts Freerange could not prove or check, joined by line')
  write()
  const rows: (string | number)[][] = []
  for (const copy of run.plan.copies) {
    for (const file of copy.files) {
      const path = join(run.outDir, `fr-${copy.copy}-${file.file}.txt`)
      if (!existsSync(path)) continue
      for (const match of readFileSync(path, 'utf8').matchAll(/\((\d+),\d+\): (?:error|warning) \[console-assert\]: (could not (?:prove|check))/g)) {
        const lineNumber = Number(match[1])
        const site = copy.sites.find((candidate) => candidate.file === file.file && candidate.line === lineNumber)
        if (site == null) {
          rows.push([copy.copy, `${file.file}:${lineNumber}`, match[2]!, '(no site on this line)', '', '', ''])
          continue
        }
        let reached = 0
        let firstFiring: {entry: string; first: FirstFiring; total: number} | null = null
        for (const entry of copy.entries) {
          const line = run.baseline.get(`${copy.copy}.${entry.name}`)
          if (line == null) continue
          reached += line.reached[site.index] ?? 0
          const firing = line.firings.find((candidate) => candidate.site === site.index)
          const first = firing?.first[CRITERION_RULE] ?? null
          if (firing != null && first != null && (firstFiring == null || entry.name === site.functionName)) firstFiring = {entry: entry.name, first, total: firing.counts[CRITERION_RULE]!.reduce((sum, count) => sum + count, 0)}
        }
        rows.push([copy.copy, siteLabel(site), match[2]!, reached, firstFiring == null ? 0 : firstFiring.total, firstFiring == null ? '' : firstFiring.first.cause, firstFiring == null ? '' : formatInput(firstFiring.entry, firstFiring.first)])
      }
    }
  }
  const counterexamples = rows.filter((row) => typeof row[4] === 'number' && row[4] > 0).length
  const unreached = rows.filter((row) => row[3] === 0).length
  write(`${rows.length} Freerange console-assert findings on the copies; ${rows.length - unreached} reached by the lattice; ${counterexamples} with a counterexample under noise@abs1e-9. Reached counts sum over entries.`)
  write()
  write(table(['copy', 'site', 'Freerange', 'in-domain inputs reaching it', 'firing inputs (criterion)', 'cause', 'first counterexample'], rows))
  write()
}

function behaviorSection(run: Run, write: Writer) {
  write('## Behavior on the lattice (behavior@v1)')
  write()
  const planned = run.plan.mutants
  const equivalent = planned.filter((mutant) => run.summaries.get(mutant.key)?.behaviorDiffs === 0 && run.summaries.get(mutant.key)?.failure == null)
  write(`- lattice-equivalent: ${equivalent.length} of ${planned.length}${equivalent.length > 0 && equivalent.length <= 40 ? `: ${equivalent.map((mutant) => mutant.key).join(', ')}` : ''}; behavior-changing on the lattice: ${planned.length - equivalent.length}`)
  const survivors = planned.filter((mutant) => (run.summaries.get(mutant.key)?.behaviorDiffs ?? 0) > 0 && !killed(run, mutant.key, CRITERION_RULE))
  write(`- survivors that change behavior (criterion rule): ${survivors.length}`)
  write()
  write(table(['mutant', 'differing inputs', 'first output difference'], survivors.map((mutant) => [mutant.key, run.summaries.get(mutant.key)!.behaviorDiffs, (run.summaries.get(mutant.key)!.behaviorFirst ?? '').slice(0, 400)])))
  write()
}

function separateColumns(run: Run, write: Writer) {
  write('## Separate columns: throw, nonFiniteReturn, step budget, timeout')
  write()
  const planned = run.plan.mutants
  const throwing = planned.filter((mutant) => (run.summaries.get(mutant.key)?.throws ?? 0) > 0)
  const nonFinite = planned.filter((mutant) => (run.summaries.get(mutant.key)?.nonFinite ?? 0) > 0)
  const mutantOverBudget = planned.filter((mutant) => (run.summaries.get(mutant.key)?.mutantOverBudget ?? 0) > 0)
  const failures = [...run.summaries.values()].filter((summary) => summary.failure != null)
  write(`- throw: ${throwing.length} mutants${throwing.length > 0 ? `: ${throwing.map((mutant) => `${mutant.key} (${run.summaries.get(mutant.key)!.throwFirst})`).join('; ')}` : ''}`)
  write(`- nonFiniteReturn: ${nonFinite.length} mutants${nonFinite.length > 0 ? `: ${nonFinite.map((mutant) => `${mutant.key} (${run.summaries.get(mutant.key)!.nonFiniteFirst})`).join('; ')}` : ''}`)
  write(`- step budget ${run.plan.stepBudget ?? 'none'}: the original passed the budget on ${[...run.summaries.values()].reduce((sum, summary) => sum + summary.overBudget, 0)} inputs summed over mutants and entries (the mutant doesn't run on them); the mutant alone passed the budget in ${mutantOverBudget.length} mutants${mutantOverBudget.length > 0 ? `: ${mutantOverBudget.map((mutant) => `${mutant.key} x${run.summaries.get(mutant.key)!.mutantOverBudget} (${run.summaries.get(mutant.key)!.mutantOverBudgetFirst})`).join('; ')}` : ''}`)
  write(`- timeout or crash: ${failures.length}${failures.length > 0 ? `: ${failures.map((summary) => `${summary.key} (${summary.failure})`).join('; ')}` : ''}`)
  write()
}

function perSiteSection(run: Run, write: Writer) {
  write('## Kills per assert site (criterion rule; input for criterion 2, not scored)')
  write()
  const rows: (string | number)[][] = []
  for (const copy of run.plan.copies) {
    const killedMutants = run.plan.mutants.filter((mutant) => mutant.copy === copy.copy && killed(run, mutant.key, CRITERION_RULE))
    for (const site of copy.sites) {
      let kills = 0
      let unique = 0
      for (const mutant of killedMutants) {
        const killingSites = run.summaries.get(mutant.key)!.killSites[CRITERION_RULE]!
        if (!killingSites.has(site.index)) continue
        kills += 1
        if (![...killingSites].some((other) => other !== site.index && copy.sites[other]!.functionName === site.functionName && copy.sites[other]!.file === site.file)) unique += 1
      }
      if (kills > 0) rows.push([copy.copy, `${site.functionName}:${site.file}:${site.line}`, site.text, site.leading ? 'leading' : '', kills, unique])
    }
  }
  write(table(['copy', 'site', 'condition', 'leading', 'mutants killed', 'unique within function'], rows))
  write()
}

function timingSection(run: Run, write: Writer) {
  write('## Timing and memory')
  write()
  for (const key of ['wallSeconds', 'projection', 'mutantPass', 'baselineChild', 'parentMaxRssKb', 'maxChildRssKb', 'concurrentRssBoundKb']) write(`- **${key}:** ${JSON.stringify(key === 'baselineChild' ? {...(run.meta[key] as Record<string, unknown>), stderr: undefined} : run.meta[key])}`)
  write()
  write('## Registered predictions')
  write()
  for (const [key, prediction] of Object.entries(run.rules.predictions)) write(`- ${key}: ${typeof prediction === 'string' ? prediction : JSON.stringify(prediction)}`)
  write()
}

// -- Virtualization: the systematic mutants' sweep record ----------------------

async function virtualizationSections(run: Run, write: Writer, title: string): Promise<FamilySections> {
  const {rules} = run
  const reference = decodeJson(readFileSync(join(rules.data.scratch, rules.data.reference), 'utf8')) as SysmutRow[]
  const byId = new Map(reference.map((row) => [row.id, row]))
  const planned = run.plan.mutants.map((mutant) => byId.get(mutant.id)!)
  const sweepEntries = rules.data.sweepEntries ?? []
  const designSweepEntries = rules.data.designSweepEntries ?? []
  const summaryOf = (id: string) => run.summaries.get(id)
  const recorded = planned.filter((row) => row.sweep.caught)
  const criterionReproduced = recorded.filter((row) => killed(run, row.id, CRITERION_RULE))
  write('## Criterion 1: recorded sweep kills reproduced')
  write()
  write(`Recorded sweep kills among the planned mutants: ${recorded.length} (of ${planned.filter((row) => row.diff.diffs > 0).length} behavior-changing in the record).`)
  write()
  const families = [...new Set(planned.map((row) => row.family))]
  const ruleRows = NOISE_RULES.map((_rule, rule) => {
    const reproduced = recorded.filter((row) => killed(run, row.id, rule))
    const through = (entries: string[]) => recorded.filter((row) => [...(summaryOf(row.id)?.killEntries[rule] ?? [])].some((entry) => entries.includes(entry))).length
    return [`${RULE_LABELS[rule]}${rule === CRITERION_RULE ? ' (criterion)' : ''}`, reproduced.length, ...families.map((family) => `${reproduced.filter((row) => row.family === family).length}/${recorded.filter((row) => row.family === family).length}`), through(sweepEntries), through(designSweepEntries)]
  })
  write(table(['rule', 'reproduced', ...families, `through the ${sweepEntries.length} sweep entries`, `through the design's ${designSweepEntries.length} entries`], ruleRows))
  write()
  const cleanReproduced = recorded.filter((row) => summaryOf(row.id)?.cleanKill === true).length
  const siteAgreement = criterionReproduced.filter((row) => row.sweep.line != null && [...summaryOf(row.id)!.killSites[CRITERION_RULE]!].some((site) => siteOf(run, row.base, site).line === row.sweep.line))
  write(`- kill@cleanSite under noise@abs1e-9: ${cleanReproduced} of ${recorded.length}`)
  write(`- Site-level agreement: for ${siteAgreement.length} of ${criterionReproduced.length} reproduced kills, the sweep's first failing line is among this run's killing sites.`)
  const disagreeing = criterionReproduced.filter((row) => !siteAgreement.includes(row))
  if (disagreeing.length > 0) write(`- Reproduced without the sweep's first failing line: ${disagreeing.map((row) => `${row.id} (sweep :${row.sweep.line} ${row.sweep.label}; here ${killingLines(run, row.id, CRITERION_RULE).join(' ')})`).join('; ')}`)
  const gate = run.plan.mutants.length !== reference.length ? `not applicable: subset run of ${run.plan.mutants.length} mutants`
    : criterionReproduced.length >= 288 ? 'go: >= 288' : criterionReproduced.length >= 260 ? 'diagnose: 260-287, replay misses and name each lattice gap' : 'stop: < 260, diagnose against the reference run'
  write(`- **Gate:** ${criterionReproduced.length} of ${recorded.length} under noise@abs1e-9 → ${gate}`)
  write()
  const criterion = [`${title} kill clause, virtualization sysmut (exposed development data; calibration)`, `reproduced under kill@perInput noise@abs1e-9: ${criterionReproduced.length} of ${recorded.length}`]
  for (let rule = 0; rule < NOISE_RULES.length; rule++) criterion.push(`  ${RULE_LABELS[rule]}: ${recorded.filter((row) => killed(run, row.id, rule)).length}`)
  criterion.push(`gate: ${gate}`)

  write('### Misses under the criterion rule, with replay')
  write()
  const replays = await readLines<SweepReplayRecord>(join(run.outDir, 'replay.jsonl'))
  const missRows = recorded.filter((row) => !killed(run, row.id, CRITERION_RULE)).map((row) => {
    const replay = replays.find((record) => record.mutant === row.id)
    let verdict = 'not replayed'
    let firstInput = ''
    if (replay?.sweepFirst != null) {
      firstInput = `${replay.sweepFirst.firstCall}(${replay.sweepFirst.firstArgs.slice(1, -1)})`
      verdict = replayVerdict(run, row.base, replay.replay)
    } else if (replay != null) {
      verdict = `sweep --first printed no failure (exit ${replay.sweepExit})`
    }
    return [row.id, `${row.fn}:${row.line} ${row.op}`, row.after, `${row.sweep.label} :${row.sweep.line} after ${row.sweep.evals}`, killed(run, row.id, 0) ? 'yes' : 'no', firstInput, verdict]
  })
  write(table(['mutant', 'mutation', 'after', 'sweep first failure', 'killed under noise@none', 'sweep first input', 'replay'], missRows))
  write()

  write('## Kills beyond the record (criterion rule)')
  write()
  const extras = planned.filter((row) => !row.sweep.caught && killed(run, row.id, CRITERION_RULE))
  write(table(['mutant', 'mutation', 'record diffs', 'site', 'producer', 'cause', 'first killing input'], extras.map((row) => {
    const first = summaryOf(row.id)!.first[CRITERION_RULE]!
    return [row.id, `${row.fn}:${row.line} ${row.op} | ${row.after}`, `${row.diff.diffs}/${row.diff.n}`, siteLabel(siteOf(run, row.base, first.site)), PRODUCERS[first.first.producer]!, first.first.cause, formatInput(first.entry, first.first)]
  })))
  write()

  write('## Producer attribution (criterion rule)')
  write()
  const killedRows = planned.filter((row) => killed(run, row.id, CRITERION_RULE))
  const p0Only = killedRows.filter((row) => !summaryOf(row.id)!.laterProducer[CRITERION_RULE]!)
  write(`- Killed only by P0 inputs (the exposure-informed phase): ${p0Only.length}${p0Only.length > 0 ? `: ${p0Only.map((row) => `${row.id}${row.sweep.caught ? ' (recorded)' : ''}`).join(', ')}` : ''}`)
  write(`- First killing input by producer: ${PRODUCERS.map((name, producer) => `${name} ${killedRows.filter((row) => summaryOf(row.id)!.first[CRITERION_RULE]!.first.producer === producer).length}`).join(', ')}`)
  const s158 = summaryOf('s158')
  if (s158 != null) write(`- s158: killed ${s158.killSites[CRITERION_RULE]!.size > 0 ? 'yes' : 'no'}; first killing input ${formatInput(s158.first[CRITERION_RULE]?.entry ?? '', s158.first[CRITERION_RULE]?.first ?? null)}`)
  write()

  if (rules.data.referenceRun != null) {
    write('## Per-mutant agreement with the reference run (input-range probe, assert kinds)')
    write()
    const probeKilled = new Set<string>()
    const probeRun = new Set<string>()
    for await (const value of jsonLines(join(rules.data.scratch, rules.data.referenceRun))) {
      const row = value as ProbeRow
      probeRun.add(row.mutant)
      if (row.findings.some((finding) => ['interior assert', 'callee requirement', 'callee assert'].includes(finding.kind) && finding.count > 0)) probeKilled.add(row.mutant)
    }
    const compared = planned.filter((row) => probeRun.has(row.id))
    const onlyHere = compared.filter((row) => killed(run, row.id, CRITERION_RULE) && !probeKilled.has(row.id))
    const onlyThere = compared.filter((row) => !killed(run, row.id, CRITERION_RULE) && probeKilled.has(row.id))
    write(`- compared: ${compared.length}; killed in both ${compared.filter((row) => killed(run, row.id, CRITERION_RULE) && probeKilled.has(row.id)).length}; only here ${onlyHere.length}; only in the probe ${onlyThere.length}`)
    write(`- only here: ${listOrNone(onlyHere.map((row) => row.id))}`)
    write(`- only in the probe: ${listOrNone(onlyThere.map((row) => `${row.id}${row.sweep.caught ? ' (recorded)' : ''}`))}`)
    write()
  }
  const equivalent = planned.filter((row) => summaryOf(row.id)?.behaviorDiffs === 0 && summaryOf(row.id)?.failure == null)
  write('## Behavior against the record')
  write()
  write(`- lattice-equivalent: ${equivalent.length} of ${planned.length}; record: ${planned.filter((row) => row.diff.diffs > 0).length} behavior-changing`)
  write(`- lattice-equivalent but behavior-changing in the record: ${listOrNone(equivalent.filter((row) => row.diff.diffs > 0).map((row) => row.id))}`)
  write(`- behavior-changing here but equivalent in the record: ${listOrNone(planned.filter((row) => row.diff.diffs === 0 && (summaryOf(row.id)?.behaviorDiffs ?? 0) > 0).map((row) => row.id))}`)
  write()
  return {
    criterion: () => criterion,
    // The clause as design.md §6.4 gates it: at least 288 of the 303 recorded sweep kills, over all four bases together.
    killClauses: [{copies: run.plan.copies.map((copy) => copy.copy), criterion: true, pass: criterionReproduced.length >= 288}],
    tsvColumns: ['family', 'fn', 'line', 'op', 'record_diffs', 'sweep_caught', 'sweep_label', 'sweep_line'],
    tsv: (key) => {
      const row = byId.get(key)!
      return [row.family, row.fn, row.line, row.op, row.diff.diffs, row.sweep.caught, row.sweep.label ?? '', row.sweep.line ?? '']
    },
  }
}

function replayVerdict(run: Run, copy: string, outcome: ReplayLine | null): string {
  if (outcome == null) return 'replay child failed'
  if (outcome.callerDiscarded) return 'outside the caller domain (a domain@v3-callers rule of the entry)'
  if (outcome.discarded) return 'outside this run\'s declared domain (discarded on the original)'
  if (outcome.originalOverBudget) return 'past the step budget on the original, so never compared here'
  const originalLevels = new Map(outcome.original)
  const newSites = outcome.mutated.filter(([site, level]) => level >= 3 && (originalLevels.get(site) ?? 0) < 3)
  const exactSites = outcome.mutated.filter(([site, level]) => level >= 2 && (originalLevels.get(site) ?? 0) < 2)
  if (newSites.length > 0) return `fires here: lattice gap (${newSites.map(([site]) => `${siteOf(run, copy, site).file}:${siteOf(run, copy, site).line}`).join(' ')})`
  if (exactSites.length > 0) return `fires here only under noise@none (${exactSites.map(([site]) => `${siteOf(run, copy, site).file}:${siteOf(run, copy, site).line}`).join(' ')})`
  return 'does not fire here: runner disagreement'
}

// -- Popovers: the planted mutants' record and the registered kill clause -------

type NanCheck = {record: CallRecord; nanInput: boolean; nanTop: boolean; line: string}

function nanCheck(run: Run, record: CallRecord): NanCheck {
  const input = (decodeJson(record.input) as Value[])[0]
  const fields = input != null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const margin = fields['anchor'] == null ? 8 : 16
  const viewportHeight = fields['viewportHeight']
  const nanInput = fields['height'] === 0 && typeof viewportHeight === 'number' && viewportHeight <= 2 * margin
  let top: unknown = undefined
  try {
    const value = record.call?.mutated.value
    const decoded = value == null ? null : decodeJson(value)
    if (decoded != null && typeof decoded === 'object') top = (decoded as Record<string, unknown>)['top']
  } catch {
    top = undefined
  }
  const nanTop = typeof top === 'number' && Number.isNaN(top)
  const copy = run.plan.mutants.find((mutant) => mutant.key === record.mutant)!.copy
  return {record, nanInput, nanTop, line: `${siteOf(run, copy, record.site).file}:${siteOf(run, copy, record.site).line}`}
}

function recordedAgreement(run: Run, copy: CopyPlan, key: string, catches: Pick<RecordedCatch, 'file' | 'line' | 'numbering'>[]): string {
  const killing = run.summaries.get(key)?.killSites[CRITERION_RULE]
  if (killing == null || killing.size === 0 || catches.length === 0) return ''
  const results = catches.map((recorded) => {
    let site: Site | undefined
    if (recorded.numbering === copy.copy) site = copy.sites.find((candidate) => candidate.file === recorded.file && candidate.line === recorded.line)
    else {
      const numbering = run.copyOf.get(recorded.numbering)
      const numbered = numbering?.sites.find((candidate) => candidate.file === recorded.file && candidate.line === recorded.line)
      site = numbered == null ? undefined : copy.sites.find((candidate) => candidate.key === numbered.key)
    }
    if (site == null) return `${recorded.file}:${recorded.line} n/a`
    return `${recorded.file}:${recorded.line} ${killing.has(site.index) ? 'yes' : 'no'}`
  })
  return results.join('; ')
}

async function popoversSections(run: Run, write: Writer, verdicts: () => FalseAlarmVerdicts | null, title: string): Promise<FamilySections> {
  const {rules} = run
  const reference = decodeJson(readFileSync(join(rules.data.scratch, rules.data.reference), 'utf8')) as PlantedReference
  const byId = new Map(reference.mutants.map((mutant) => [mutant.id, mutant]))
  const replays = await readLines<ExampleReplayRecord>(join(run.outDir, 'replay.jsonl'))
  const calls = (await readLines<CallRecord>(join(run.outDir, 'calls.jsonl'))).map((record) => nanCheck(run, record))
  const planned = new Set(run.plan.mutants.map((mutant) => mutant.key))

  type CopyVerdict = {copy: string; criterion: boolean; expected: string[]; reproduced: string[]; staticOnly: {id: string; killed: boolean; atInput: boolean}[]; pass: boolean}
  const copyVerdicts: CopyVerdict[] = []
  write('## Criterion 1 kill clause: registered kills per copy')
  write()
  const rows: (string | number)[][] = []
  for (const copyRule of rules.data.copies) {
    const expected = (copyRule.expectedKills ?? []).filter((id) => planned.has(`${copyRule.id}/${id}`))
    const staticOnly = (copyRule.staticOnly ?? []).filter((id) => planned.has(`${copyRule.id}/${id}`))
    const recordedSweep = [...byId.values()].filter((mutant) => mutant.sweep?.caught === true && planned.has(`${copyRule.id}/${mutant.id}`))
    for (let rule = 0; rule < NOISE_RULES.length; rule++) {
      const reproduced = expected.filter((id) => killed(run, `${copyRule.id}/${id}`, rule))
      rows.push([copyRule.id, copyRule.criterion ? 'criterion' : `not scored (${copyRule.role})`, `${RULE_LABELS[rule]}${rule === CRITERION_RULE ? ' (criterion)' : ''}`, `${reproduced.length}/${expected.length}`, listOrNone(expected.filter((id) => !reproduced.includes(id))),
        staticOnly.map((id) => `${id} ${killed(run, `${copyRule.id}/${id}`, rule) ? 'killed' : 'not killed'}`).join(', '),
        `${recordedSweep.filter((mutant) => killed(run, `${copyRule.id}/${mutant.id}`, rule)).length}/${recordedSweep.length}`])
    }
    const reproduced = expected.filter((id) => killed(run, `${copyRule.id}/${id}`, CRITERION_RULE))
    const staticVerdicts = staticOnly.map((id) => {
      const key = `${copyRule.id}/${id}`
      return {id, killed: killed(run, key, CRITERION_RULE), atInput: calls.some((check) => check.record.mutant === key && check.nanInput && check.nanTop)}
    })
    copyVerdicts.push({copy: copyRule.id, criterion: copyRule.criterion, expected, reproduced, staticOnly: staticVerdicts, pass: reproduced.length === expected.length && staticVerdicts.every((verdict) => verdict.killed && verdict.atInput)})
  }
  write(table(['copy', 'role', 'rule', 'registered sweep catches reproduced', 'missed', 'static-only mutants', 'recorded dense-sweep catches reproduced (as run, drift included)'], rows))
  write()
  for (const verdict of copyVerdicts) {
    write(`- **${verdict.copy}** (${verdict.criterion ? 'criterion' : 'hindsight, not scored'}): ${verdict.reproduced.length} of ${verdict.expected.length} registered catches under kill@perInput noise@abs1e-9; ${verdict.staticOnly.map((check) => `${check.id} killed ${check.killed ? 'yes' : 'no'}, at its registered input ${check.atInput ? 'yes' : 'no'}`).join('; ')} → ${verdict.pass ? 'pass' : 'fail'}`)
  }
  const scored = copyVerdicts.filter((verdict) => verdict.criterion)
  const killClause = scored.length > 0 && scored.every((verdict) => verdict.pass)
  write(`- **Kill clause (criterion copies ${scored.map((verdict) => verdict.copy).join(', ')}):** ${killClause ? 'pass' : 'fail'}`)
  write()

  write('### Static-only catches at their registered inputs')
  write()
  for (const staticOnly of reference.staticOnly) write(`- ${staticOnly.id} (${staticOnly.entry}): ${staticOnly.rule}. Source: ${staticOnly.source}. Registered example: ${formatCall(staticOnly.entry, staticOnly.args)}`)
  write()
  write(table(['mutant', 'killing site (criterion)', 'first killing input', 'registered input shape', 'mutant returns top NaN (uninstrumented call)', 'lines fired on the uninstrumented mutant', 'original'], calls.map((check) => [
    check.record.mutant, check.line, formatCall(check.record.entry, decodeJson(check.record.input) as Value[]), check.nanInput ? 'yes' : 'no', check.nanTop ? 'yes' : 'no', check.record.call?.mutated.fired.join(', ') ?? 'call failed', check.record.call?.original.value ?? check.record.call?.original.thrown ?? '',
  ])))
  write()

  for (const copyRule of rules.data.copies) {
    const copy = run.copyOf.get(copyRule.id)
    if (copy == null) continue
    write(`## Mutants on ${copyRule.id}`)
    write()
    const mutantRows = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id).map((mutant) => {
      const planted = byId.get(mutant.id)
      const summary = run.summaries.get(mutant.key)
      const catches = copyRule.id === 'contracts-k7t5b' && planted?.hindsightSweep != null ? [...(planted.sweep?.catches ?? []), ...planted.hindsightSweep.catches] : planted?.sweep?.catches ?? []
      const role = (copyRule.expectedKills ?? []).includes(mutant.id) ? 'registered catch' : (copyRule.staticOnly ?? []).includes(mutant.id) ? 'static-only' : 'not registered'
      const first = summary?.first[CRITERION_RULE] ?? null
      return [
        mutant.id, planted?.helper ?? mutant.family, role, listOrNone(catches.map((recorded) => `${recorded.file}:${recorded.line} x${recorded.count}${recorded.numbering === 'contracts-k7t5b' ? ' (K7/T5b)' : ''}`)),
        NOISE_RULES.map((_rule, rule) => (killed(run, mutant.key, rule) ? 'y' : 'n')).join('/'), listOrNone(killingLines(run, mutant.key, CRITERION_RULE)),
        copyRule.signature === 'reshaped' ? 'n/a (restated asserts)' : recordedAgreement(run, copy, mutant.key, catches),
        first == null ? '' : formatInput(first.entry, first.first), first == null ? '' : PRODUCERS[first.first.producer]!, first?.first.cause ?? '', summary?.cleanKill === true ? 'yes' : 'no', summary?.behaviorDiffs ?? '',
      ]
    })
    write(table(['mutant', 'helper', 'role', 'recorded catches', 'killed none/abs1e-9/literal', 'killing sites (criterion)', 'recorded line among killing sites', 'first killing input (criterion)', 'producer', 'cause', 'kill@cleanSite', 'differing inputs'], mutantRows))
    write()
    const misses = replays.filter((record) => record.copy === copyRule.id)
    if (misses.length > 0) {
      write(`### Misses on ${copyRule.id}, with replay of recorded inputs`)
      write()
      write(table(['mutant', 'recorded input source', 'call', 'replay'], misses.map((record) => [record.id, record.source, formatCall(record.entry, decodeJson(record.args) as Value[]), replayVerdict(run, copyRule.id, record.replay)])))
      write()
    }
    const extras = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id && killed(run, mutant.key, CRITERION_RULE) && !(copyRule.expectedKills ?? []).includes(mutant.id) && !(copyRule.staticOnly ?? []).includes(mutant.id))
    write(`- Kills beyond the registered list on ${copyRule.id}: ${listOrNone(extras.map((mutant) => {
      const first = run.summaries.get(mutant.key)!.first[CRITERION_RULE]!
      return `${mutant.id} through ${siteLabel(siteOf(run, copyRule.id, first.site))} at ${formatInput(first.entry, first.first)} (${PRODUCERS[first.first.producer]}, ${first.first.cause})`
    }), '; ')}`)
    const killedHere = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id && killed(run, mutant.key, CRITERION_RULE))
    const p0Only = killedHere.filter((mutant) => !run.summaries.get(mutant.key)!.laterProducer[CRITERION_RULE]!)
    write(`- Killed only by P0 inputs (the exposure-informed phase): ${listOrNone(p0Only.map((mutant) => mutant.id))}`)
    write(`- First killing input by producer: ${PRODUCERS.map((name, producer) => `${name} ${killedHere.filter((mutant) => run.summaries.get(mutant.key)!.first[CRITERION_RULE]!.first.producer === producer).length}`).join(', ')}`)
    write()
  }

  write('## Placement mutants beyond the planted table')
  write()
  write(table(['mutant', 'author', 'copies', 'recorded behavior example', 'killed none/abs1e-9/literal', 'differing inputs', 'first output difference here'], reference.mutants.filter((mutant) => mutant.behaviorExample != null).flatMap((mutant) => mutant.copies.filter((copy) => planned.has(`${copy}/${mutant.id}`)).map((copy) => {
    const key = `${copy}/${mutant.id}`
    const example = mutant.behaviorExample!
    return [key, mutant.author, copy, `${formatCall(example.entry, example.args)} = ${JSON.stringify(example.mutant)}, original ${JSON.stringify(example.original)}`, NOISE_RULES.map((_rule, rule) => (killed(run, key, rule) ? 'y' : 'n')).join('/'), run.summaries.get(key)?.behaviorDiffs ?? '', (run.summaries.get(key)?.behaviorFirst ?? '').slice(0, 300)]
  }))))
  write()

  return {
    criterion: () => {
      const falseAlarms = verdicts()
      const lines = [`${title}, popovers (exposed development data; calibration, not a benchmark)`]
      for (const verdict of copyVerdicts) {
        lines.push(`kill clause ${verdict.copy}${verdict.criterion ? '' : ' (hindsight arm, not the criterion)'}: ${verdict.reproduced.length}/${verdict.expected.length} registered catches; ${verdict.staticOnly.map((check) => `${check.id} at its registered input: ${check.killed && check.atInput ? 'yes' : 'no'}`).join('; ')} → ${verdict.pass ? 'pass' : 'fail'}`)
      }
      lines.push(`kill clause (criterion copies): ${killClause ? 'pass' : 'fail'}`)
      let falseAlarmClause = true
      if (falseAlarms != null) {
        for (const copyRule of rules.data.copies.filter((candidate) => candidate.criterion)) {
          for (const list of run.knownFalse.filter((candidate) => candidate.rule.criterion && candidate.rule.copies.includes(copyRule.id))) {
            const off = falseAlarms.offList.get(list.rule.label)!.get(copyRule.id) ?? 0
            if (off > 0) falseAlarmClause = false
            lines.push(`falseAlarm@asWritten ${copyRule.id} against ${list.rule.label}: ${off} off-list firing sites → ${off === 0 ? 'pass' : 'fail'}`)
          }
          const notReproducible = falseAlarms.notReproducible.get(copyRule.id) ?? 0
          if (notReproducible > 0) falseAlarmClause = false
          lines.push(`falseAlarm@reproducible ${copyRule.id}: ${notReproducible} → ${notReproducible === 0 ? 'pass' : 'fail'}`)
        }
      }
      lines.push(`false-alarm clause (criterion copies): ${falseAlarmClause ? 'pass' : 'fail'}`)
      lines.push(`${title} on popovers: ${killClause && falseAlarmClause ? 'pass' : 'fail'}`)
      return lines
    },
    killClauses: copyVerdicts.map((verdict) => ({copies: [verdict.copy], criterion: verdict.criterion, pass: verdict.pass})),
    tsvColumns: ['id', 'helper', 'author', 'registered_catch', 'static_only', 'recorded_sweep_caught'],
    tsv: (key) => {
      const mutant = run.plan.mutants.find((candidate) => candidate.key === key)!
      const planted = byId.get(mutant.id)
      const copyRule = rules.data.copies.find((candidate) => candidate.id === mutant.copy)!
      return [mutant.id, planted?.helper ?? mutant.family, planted?.author ?? '', (copyRule.expectedKills ?? []).includes(mutant.id), (copyRule.staticOnly ?? []).includes(mutant.id), planted?.sweep?.caught ?? '']
    },
  }
}

// -- Frames: the planted mutants' record, the skeptic's real-caller classification and the registered kill clause -------

async function framesSections(run: Run, write: Writer, verdicts: () => FalseAlarmVerdicts | null, title: string): Promise<FamilySections> {
  const {rules} = run
  const reference = decodeJson(readFileSync(join(rules.data.scratch, rules.data.reference), 'utf8')) as FramesReference
  const byId = new Map(reference.mutants.map((mutant) => [mutant.id, mutant]))
  const replays = await readLines<ExampleReplayRecord>(join(run.outDir, 'replay.jsonl'))
  const planned = new Set(run.plan.mutants.map((mutant) => mutant.key))
  const ruleCells = (key: string) => NOISE_RULES.map((_rule, rule) => (killed(run, key, rule) ? 'y' : 'n')).join('/')
  const realCallers = (id: string) => {
    const planted = byId.get(id)
    return planted == null ? '' : `${planted.realCallers.changesBehavior ? 'changes behavior' : 'no-op'}: ${planted.realCallers.basis}`
  }

  type CopyVerdict = {copy: string; criterion: boolean; expected: string[]; reproduced: string[]; pass: boolean}
  const copyVerdicts: CopyVerdict[] = []
  write('## Criterion 1 kill clause: registered kills per copy')
  write()
  const rows: (string | number)[][] = []
  for (const copyRule of rules.data.copies) {
    const expected = (copyRule.expectedKills ?? []).filter((id) => planned.has(`${copyRule.id}/${id}`))
    const staticOnly = (copyRule.staticOnly ?? []).filter((id) => planned.has(`${copyRule.id}/${id}`))
    const recordedSweep = reference.mutants.filter((mutant) => mutant.sweep.caught && planned.has(`${copyRule.id}/${mutant.id}`))
    for (let rule = 0; rule < NOISE_RULES.length; rule++) {
      const reproduced = expected.filter((id) => killed(run, `${copyRule.id}/${id}`, rule))
      rows.push([copyRule.id, copyRule.criterion ? 'criterion' : `not scored (${copyRule.role})`, `${RULE_LABELS[rule]}${rule === CRITERION_RULE ? ' (criterion)' : ''}`, `${reproduced.length}/${expected.length}`, listOrNone(expected.filter((id) => !reproduced.includes(id))),
        listOrNone(staticOnly.map((id) => `${id} ${killed(run, `${copyRule.id}/${id}`, rule) ? 'killed' : 'not killed'}`)),
        `${recordedSweep.filter((mutant) => killed(run, `${copyRule.id}/${mutant.id}`, rule)).length}/${recordedSweep.length}`])
    }
    const reproduced = expected.filter((id) => killed(run, `${copyRule.id}/${id}`, CRITERION_RULE))
    copyVerdicts.push({copy: copyRule.id, criterion: copyRule.criterion, expected, reproduced, pass: expected.length > 0 && reproduced.length === expected.length})
  }
  write(table(['copy', 'role', 'rule', 'registered catches reproduced', 'missed', 'static-only mutants (not scored)', 'recorded sweep catches reproduced (as run on inv/, real-caller no-ops included)'], rows))
  write()
  for (const verdict of copyVerdicts) {
    write(`- **${verdict.copy}** (${verdict.criterion ? 'criterion' : 'not scored'}): ${verdict.reproduced.length} of ${verdict.expected.length} registered catches under kill@perInput noise@abs1e-9 → ${verdict.pass ? 'pass' : 'fail'}`)
  }
  const scored = copyVerdicts.filter((verdict) => verdict.criterion)
  const killClause = scored.length > 0 && scored.every((verdict) => verdict.pass)
  write(`- **Kill clause (criterion copies ${scored.map((verdict) => verdict.copy).join(', ')}):** ${killClause ? 'pass' : 'fail'}`)
  write()

  write('### Static-only catches (reported, not scored)')
  write()
  write(table(['mutant', 'static catches in the record', 'real callers', 'killed none/abs1e-9/literal', 'killing sites (criterion)', 'differing inputs', 'first output difference'], rules.data.copies.flatMap((copyRule) => (copyRule.staticOnly ?? []).filter((id) => planned.has(`${copyRule.id}/${id}`)).map((id) => {
    const key = `${copyRule.id}/${id}`
    const planted = byId.get(id)
    const tools = planted == null ? '' : [planted.static.typescript ? 'TypeScript' : '', planted.static.freerangeAsWritten ? 'Freerange as written' : '', planted.static.freerangeReshaped ? 'Freerange reshaped' : ''].filter((tool) => tool !== '').join(', ')
    return [key, tools, realCallers(id), ruleCells(key), listOrNone(killingLines(run, key, CRITERION_RULE)), run.summaries.get(key)?.behaviorDiffs ?? '', (run.summaries.get(key)?.behaviorFirst ?? '').slice(0, 300)]
  }))))
  write()

  for (const copyRule of rules.data.copies) {
    const copy = run.copyOf.get(copyRule.id)
    if (copy == null) continue
    write(`## Mutants on ${copyRule.id}`)
    write()
    const mutantRows = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id).map((mutant) => {
      const planted = byId.get(mutant.id)
      const summary = run.summaries.get(mutant.key)
      const catches = planted?.sweep.catches ?? []
      const role = (copyRule.expectedKills ?? []).includes(mutant.id) ? 'registered catch' : (copyRule.staticOnly ?? []).includes(mutant.id) ? 'static-only' : 'not registered'
      const first = summary?.first[CRITERION_RULE] ?? null
      const recordedSites = [...new Map(catches.map((recorded) => [`${recorded.file}:${recorded.line}`, recorded])).values()]
      return [
        mutant.id, planted == null ? mutant.family : `${planted.file} ${planted.bugClass}`, role, realCallers(mutant.id),
        listOrNone(catches.map((recorded) => `${recorded.family}/${recorded.mode} ${recorded.file}:${recorded.line} x${recorded.count}${recorded.baselineCount > 0 ? ` (baseline x${recorded.baselineCount})` : ''}`), '; '),
        ruleCells(mutant.key), listOrNone(killingLines(run, mutant.key, CRITERION_RULE)), recordedAgreement(run, copy, mutant.key, recordedSites),
        first == null ? '' : formatInput(first.entry, first.first), first == null ? '' : PRODUCERS[first.first.producer]!, first?.first.cause ?? '', summary?.cleanKill === true ? 'yes' : 'no', summary?.behaviorDiffs ?? '',
      ]
    })
    write(table(['mutant', 'change', 'role', 'real callers (skeptic)', 'recorded sweep catches (inv/ numbering)', 'killed none/abs1e-9/literal', 'killing sites (criterion)', 'recorded line among killing sites', 'first killing input (criterion)', 'producer', 'cause', 'kill@cleanSite', 'differing inputs'], mutantRows))
    write()
    const misses = replays.filter((record) => record.copy === copyRule.id)
    if (misses.length > 0) {
      write(`### Misses on ${copyRule.id}, with replay of recorded inputs`)
      write()
      write(table(['mutant', 'recorded input source', 'call', 'replay'], misses.map((record) => [record.id, record.source, formatCall(record.entry, decodeJson(record.args) as Value[]), record.replay == null ? 'not replayed: the frame call failed' : replayVerdict(run, copyRule.id, record.replay)])))
      write()
    }
    const extras = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id && killed(run, mutant.key, CRITERION_RULE) && !(copyRule.expectedKills ?? []).includes(mutant.id))
    write(`- Kills beyond the registered list on ${copyRule.id}: ${listOrNone(extras.map((mutant) => {
      const first = run.summaries.get(mutant.key)!.first[CRITERION_RULE]!
      return `${mutant.id} through ${siteLabel(siteOf(run, copyRule.id, first.site))} at ${formatInput(first.entry, first.first)} (${PRODUCERS[first.first.producer]}, ${first.first.cause})`
    }), '; ')}`)
    const killedHere = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id && killed(run, mutant.key, CRITERION_RULE))
    const p0Only = killedHere.filter((mutant) => !run.summaries.get(mutant.key)!.laterProducer[CRITERION_RULE]!)
    write(`- Killed only by P0 inputs (the exposure-informed phase): ${listOrNone(p0Only.map((mutant) => mutant.id))}`)
    write(`- First killing input by producer: ${PRODUCERS.map((name, producer) => `${name} ${killedHere.filter((mutant) => run.summaries.get(mutant.key)!.first[CRITERION_RULE]!.first.producer === producer).length}`).join(', ')}`)
    write()
  }

  write('## Mutants that change behavior on real callers (the skeptic\'s 11, by elimination)')
  write()
  write(table(['copy', 'killed (criterion)', 'not killed, with differing inputs on the lattice'], rules.data.copies.map((copyRule) => {
    const eleven = reference.mutants.filter((mutant) => mutant.realCallers.changesBehavior && planned.has(`${copyRule.id}/${mutant.id}`))
    const killedIds = eleven.filter((mutant) => killed(run, `${copyRule.id}/${mutant.id}`, CRITERION_RULE)).map((mutant) => mutant.id)
    const survivors = eleven.filter((mutant) => !killed(run, `${copyRule.id}/${mutant.id}`, CRITERION_RULE)).map((mutant) => `${mutant.id} (${run.summaries.get(`${copyRule.id}/${mutant.id}`)?.behaviorDiffs ?? '?'})`)
    return [copyRule.id, `${killedIds.length}/${eleven.length}: ${listOrNone(killedIds)}`, listOrNone(survivors)]
  })))
  write()

  return {
    criterion: () => {
      const falseAlarms = verdicts()
      const lines = [`${title}, frames (exposed development data; calibration, not a benchmark)`]
      for (const verdict of copyVerdicts) lines.push(`kill clause ${verdict.copy}${verdict.criterion ? '' : ' (not the criterion)'}: ${verdict.reproduced.length}/${verdict.expected.length} registered catches → ${verdict.pass ? 'pass' : 'fail'}`)
      lines.push(`kill clause (criterion copies): ${killClause ? 'pass' : 'fail'}`)
      let falseAlarmClause = true
      if (falseAlarms != null) {
        for (const copyRule of rules.data.copies.filter((candidate) => candidate.criterion)) {
          for (const list of run.knownFalse.filter((candidate) => candidate.rule.copies.includes(copyRule.id))) {
            const off = falseAlarms.offList.get(list.rule.label)!.get(copyRule.id) ?? 0
            if (list.rule.criterion && off > 0) falseAlarmClause = false
            lines.push(`falseAlarm@asWritten ${copyRule.id} against ${list.rule.label}${list.rule.criterion ? '' : ' (not scored)'}: ${off} off-list firing rows → ${off === 0 ? 'pass' : 'fail'}`)
          }
          const notReproducible = falseAlarms.notReproducible.get(copyRule.id) ?? 0
          if (notReproducible > 0) falseAlarmClause = false
          lines.push(`falseAlarm@reproducible ${copyRule.id}: ${notReproducible} → ${notReproducible === 0 ? 'pass' : 'fail'}`)
        }
      }
      lines.push(`false-alarm clause (criterion copies): ${falseAlarmClause ? 'pass' : 'fail'}`)
      lines.push(`${title} on frames: ${killClause && falseAlarmClause ? 'pass' : 'fail'}`)
      return lines
    },
    killClauses: copyVerdicts.map((verdict) => ({copies: [verdict.copy], criterion: verdict.criterion, pass: verdict.pass})),
    tsvColumns: ['id', 'file', 'bug_class', 'registered_catch', 'static_only', 'recorded_sweep_caught', 'changes_behavior_on_real_callers'],
    tsv: (key) => {
      const mutant = run.plan.mutants.find((candidate) => candidate.key === key)!
      const planted = byId.get(mutant.id)
      const copyRule = rules.data.copies.find((candidate) => candidate.id === mutant.copy)!
      return [mutant.id, planted?.file ?? '', planted?.bugClass ?? mutant.family, (copyRule.expectedKills ?? []).includes(mutant.id), (copyRule.staticOnly ?? []).includes(mutant.id), planted?.sweep.caught ?? '', planted?.realCallers.changesBehavior ?? '']
    },
  }
}

// -- Packing: the planted and skeptic mutants' sweep record, the static-only m10, and the known-false lines at the lattice ----

type KnownFalseLine = {id: string; copy: string; siteKey: string; line: number; cause: string; recorded?: {input?: string; magnitude?: string}}

async function packingSections(run: Run, write: Writer, verdicts: () => FalseAlarmVerdicts | null, title: string): Promise<FamilySections> {
  const {rules} = run
  const reference = decodeJson(readFileSync(join(rules.data.scratch, rules.data.reference), 'utf8')) as PackingReference
  const byId = new Map(reference.mutants.map((mutant) => [mutant.id, mutant]))
  const replays = await readLines<ExampleReplayRecord>(join(run.outDir, 'replay.jsonl'))
  const calls = await readLines<CallRecord>(join(run.outDir, 'calls.jsonl'))
  const planned = new Set(run.plan.mutants.map((mutant) => mutant.key))
  const ruleCells = (key: string) => NOISE_RULES.map((_rule, rule) => (killed(run, key, rule) ? 'y' : 'n')).join('/')
  const roleOf = (copyRule: (typeof rules.data.copies)[number], id: string) => (copyRule.expectedKills ?? []).includes(id) ? 'registered catch' : (copyRule.staticOnly ?? []).includes(id) ? 'static-only' : 'not registered'
  // First killing inputs of a static-only mutant at its registered input shape, e.g. m10's masonryCardHeight calls with a
  // column width below 1 px.
  const atRegisteredInput = (copy: string, id: string) => {
    const condition = reference.staticOnly.find((candidate) => candidate.id === id)
    if (condition == null) return []
    return calls.filter((record) => {
      if (record.mutant !== `${copy}/${id}` || record.entry !== condition.entry) return false
      const argument = (decodeJson(record.input) as Value[])[condition.argumentIndex]
      return typeof argument === 'number' && argument < condition.below
    })
  }

  type CopyVerdict = {copy: string; criterion: boolean; expected: string[]; reproduced: string[]; staticOnly: {id: string; killed: boolean; atInput: boolean}[]; pass: boolean}
  const copyVerdicts: CopyVerdict[] = []
  write('## Criterion 1 kill clause: registered kills per copy')
  write()
  const rows: (string | number)[][] = []
  for (const copyRule of rules.data.copies) {
    const expected = (copyRule.expectedKills ?? []).filter((id) => planned.has(`${copyRule.id}/${id}`))
    const staticOnly = (copyRule.staticOnly ?? []).filter((id) => planned.has(`${copyRule.id}/${id}`))
    const recordedSweep = reference.mutants.filter((mutant) => mutant.sweep[copyRule.id]?.caughtInDomain === true && planned.has(`${copyRule.id}/${mutant.id}`))
    for (let rule = 0; rule < NOISE_RULES.length; rule++) {
      const reproduced = expected.filter((id) => killed(run, `${copyRule.id}/${id}`, rule))
      rows.push([copyRule.id, copyRule.criterion ? 'criterion' : `not scored (${copyRule.role})`, `${RULE_LABELS[rule]}${rule === CRITERION_RULE ? ' (criterion)' : ''}`, `${reproduced.length}/${expected.length}`, listOrNone(expected.filter((id) => !reproduced.includes(id))),
        listOrNone(staticOnly.map((id) => `${id} ${killed(run, `${copyRule.id}/${id}`, rule) ? 'killed' : 'not killed'}`)),
        `${recordedSweep.filter((mutant) => killed(run, `${copyRule.id}/${mutant.id}`, rule)).length}/${recordedSweep.length}`])
    }
    const reproduced = expected.filter((id) => killed(run, `${copyRule.id}/${id}`, CRITERION_RULE))
    const staticVerdicts = staticOnly.map((id) => ({id, killed: killed(run, `${copyRule.id}/${id}`, CRITERION_RULE), atInput: atRegisteredInput(copyRule.id, id).length > 0}))
    copyVerdicts.push({copy: copyRule.id, criterion: copyRule.criterion, expected, reproduced, staticOnly: staticVerdicts, pass: expected.length > 0 && reproduced.length === expected.length && staticVerdicts.every((verdict) => verdict.killed && verdict.atInput)})
  }
  write(table(['copy', 'role', 'rule', 'registered catches reproduced', 'missed', 'static-only mutants', 'recorded in-domain sweep catches reproduced (same copy)'], rows))
  write()
  for (const verdict of copyVerdicts) {
    write(`- **${verdict.copy}** (${verdict.criterion ? 'criterion' : 'not scored'}): ${verdict.reproduced.length} of ${verdict.expected.length} registered catches under kill@perInput noise@abs1e-9; ${verdict.staticOnly.map((check) => `${check.id} killed ${check.killed ? 'yes' : 'no'}, at its registered input shape ${check.atInput ? 'yes' : 'no'}`).join('; ')} → ${verdict.pass ? 'pass' : 'fail'}`)
  }
  const scored = copyVerdicts.filter((verdict) => verdict.criterion)
  const killClause = scored.length > 0 && scored.every((verdict) => verdict.pass)
  write(`- **Kill clause (criterion copies ${scored.map((verdict) => verdict.copy).join(', ')}):** ${killClause ? 'pass' : 'fail'}`)
  write()

  write('### Static-only catches at their registered input shapes')
  write()
  for (const condition of reference.staticOnly) write(`- ${condition.id}: ${condition.condition}. Source: ${condition.source}`)
  write()
  const staticKeys = new Set(rules.data.copies.flatMap((copyRule) => (copyRule.staticOnly ?? []).map((id) => `${copyRule.id}/${id}`)))
  write(table(['mutant', 'killing site (criterion)', 'first killing input of the entry', 'at the registered input shape', 'uninstrumented mutant', 'lines fired on the uninstrumented mutant', 'uninstrumented original'], calls.filter((record) => staticKeys.has(record.mutant)).map((record) => {
    const copy = run.plan.mutants.find((mutant) => mutant.key === record.mutant)!.copy
    const id = record.mutant.slice(copy.length + 1)
    return [record.mutant, siteLabel(siteOf(run, copy, record.site)), formatCall(record.entry, decodeJson(record.input) as Value[]), atRegisteredInput(copy, id).includes(record) ? 'yes' : 'no',
      record.call?.mutated.value ?? record.call?.mutated.thrown ?? 'call failed', listOrNone(record.call?.mutated.fired ?? []), record.call?.original.value ?? record.call?.original.thrown ?? '']
  })))
  write()

  for (const copyRule of rules.data.copies) {
    const copy = run.copyOf.get(copyRule.id)
    if (copy == null) continue
    write(`## Mutants on ${copyRule.id}`)
    write()
    const mutantRows = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id).map((mutant) => {
      const planted = byId.get(mutant.id)
      const summary = run.summaries.get(mutant.key)
      const catches = planted?.sweep[copyRule.id]?.catches ?? []
      const first = summary?.first[CRITERION_RULE] ?? null
      return [
        mutant.id, planted == null ? mutant.family : `${planted.author}: ${planted.description}`, roleOf(copyRule, mutant.id),
        listOrNone(catches.map((recorded) => `${recorded.section} ${recorded.tag} x${recorded.count} (${recorded.tier})`), '; '),
        ruleCells(mutant.key), listOrNone(killingLines(run, mutant.key, CRITERION_RULE)), recordedAgreement(run, copy, mutant.key, catches.filter((recorded) => recorded.tier === 'in-domain')),
        first == null ? '' : formatInput(first.entry, first.first), first == null ? '' : PRODUCERS[first.first.producer]!, first?.first.cause ?? '', summary?.cleanKill === true ? 'yes' : 'no', summary?.behaviorDiffs ?? '', summary?.mutantOverBudget ?? '',
      ]
    })
    write(table(['mutant', 'change', 'role', 'recorded sweep catches (this copy)', 'killed none/abs1e-9/literal', 'killing sites (criterion)', 'recorded in-domain line among killing sites', 'first killing input (criterion)', 'producer', 'cause', 'kill@cleanSite', 'differing inputs', 'mutant-only step budget aborts'], mutantRows))
    write()
    const misses = replays.filter((record) => record.copy === copyRule.id)
    if (misses.length > 0) {
      write(`### Misses on ${copyRule.id}, with replay of recorded inputs`)
      write()
      write(table(['mutant', 'recorded input source', 'call', 'replay'], misses.map((record) => [record.id, record.source, formatCall(record.entry, decodeJson(record.args) as Value[]), replayVerdict(run, copyRule.id, record.replay)])))
      write()
    }
    const extras = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id && killed(run, mutant.key, CRITERION_RULE) && roleOf(copyRule, mutant.id) === 'not registered')
    write(`- Kills beyond the registered list on ${copyRule.id}: ${listOrNone(extras.map((mutant) => {
      const first = run.summaries.get(mutant.key)!.first[CRITERION_RULE]!
      return `${mutant.id} through ${siteLabel(siteOf(run, copyRule.id, first.site))} at ${formatInput(first.entry, first.first)} (${PRODUCERS[first.first.producer]}, ${first.first.cause})`
    }), '; ')}`)
    const killedHere = run.plan.mutants.filter((mutant) => mutant.copy === copyRule.id && killed(run, mutant.key, CRITERION_RULE))
    const p0Only = killedHere.filter((mutant) => !run.summaries.get(mutant.key)!.laterProducer[CRITERION_RULE]!)
    write(`- Killed only by P0 inputs (the exposure-informed phase): ${listOrNone(p0Only.map((mutant) => mutant.id))}`)
    write(`- First killing input by producer: ${PRODUCERS.map((name, producer) => `${name} ${killedHere.filter((mutant) => run.summaries.get(mutant.key)!.first[CRITERION_RULE]!.first.producer === producer).length}`).join(', ')}`)
    write()
  }

  write('## The skeptic\'s six one-line mutants (written without the invariant list; the sweep and Freerange missed all six)')
  write()
  write(table(['mutant', 'change', 'skeptic\'s note', 'killed none/abs1e-9/literal', 'killing sites (criterion)', 'differing inputs', 'first output difference here'], reference.mutants.filter((mutant) => mutant.author === 'skeptic').flatMap((mutant) => mutant.copies.filter((copy) => planned.has(`${copy}/${mutant.id}`)).map((copy) => {
    const key = `${copy}/${mutant.id}`
    return [key, mutant.description, mutant.skepticNote ?? '', ruleCells(key), listOrNone(killingLines(run, key, CRITERION_RULE)), run.summaries.get(key)?.behaviorDiffs ?? '', (run.summaries.get(key)?.behaviorFirst ?? '').slice(0, 300)]
  }))))
  write()

  write('## Known-false lines at the lattice\'s magnitudes (criterion lists)')
  write()
  const knownRows: (string | number)[][] = []
  for (const list of run.knownFalse.filter((candidate) => candidate.rule.criterion)) {
    const path = join(rules.data.scratch, list.rule.path)
    if (!existsSync(path)) continue
    const entries = (decodeJson(readFileSync(path, 'utf8')) as {entries: KnownFalseLine[]}).entries
    for (const entry of entries) {
      const copy = run.copyOf.get(entry.copy)
      const site = copy?.sites.find((candidate) => candidate.key === entry.siteKey)
      if (copy == null || site == null) {
        knownRows.push([list.rule.label, entry.copy, entry.id, entry.siteKey, entry.cause, entry.recorded?.magnitude ?? '', 'no such site in this run', '', '', '', '', ''])
        continue
      }
      let reached = 0
      let firing = 0
      const byCause: Record<string, number> = {}
      let first: {entry: string; first: FirstFiring} | null = null
      for (const line of run.baseline.values()) {
        if (line.base !== entry.copy) continue
        reached += line.reached[site.index] ?? 0
        const found = line.firings.find((candidate) => candidate.site === site.index)
        const criterionFirst = found?.first[CRITERION_RULE] ?? null
        if (found == null || criterionFirst == null) continue
        firing += found.counts[CRITERION_RULE]!.reduce((sum, count) => sum + count, 0)
        for (const [cause, count] of Object.entries(found.byCause)) byCause[cause] = (byCause[cause] ?? 0) + count
        if (first == null || line.entry === site.functionName) first = {entry: line.entry, first: criterionFirst}
      }
      const causes = Object.entries(byCause).filter(([, count]) => count > 0)
      const verdict = reached === 0 ? 'not reached' : firing === 0 ? 'reached; no criterion-rule firing at the lattice\'s magnitudes'
        : `fires as ${causes.map(([cause]) => cause).join(', ')}; the list names ${entry.cause}${causes.some(([cause]) => cause !== entry.cause) ? ' (other causes are off this entry)' : ''}`
      const firstInput = first?.first.input == null ? null : decodeJson(first.first.input) as Value[]
      knownRows.push([list.rule.label, entry.copy, entry.id, `${site.functionName}:${site.file}:${site.line} ${site.text}`, entry.cause, entry.recorded?.magnitude ?? '', reached, `${firing}${causes.length > 0 ? ` (${causes.map(([cause, count]) => `${cause} ${count}`).join(', ')})` : ''}`,
        first == null ? '' : formatInput(first.entry, first.first), first?.first.margin ?? '', firstInput == null ? '' : maxMagnitude(firstInput), verdict])
    }
  }
  write(table(['list', 'copy', 'entry', 'site', 'listed cause', 'recorded magnitude', 'in-domain inputs reaching it (summed over entries)', 'criterion-rule firing inputs', 'first firing input', 'margin', 'largest |x| of that input', 'at this lattice'], knownRows))
  write()

  return {
    criterion: () => {
      const falseAlarms = verdicts()
      const lines = [`${title}, packing (exposed development data; calibration, not a benchmark)`]
      for (const verdict of copyVerdicts) {
        lines.push(`kill clause ${verdict.copy}${verdict.criterion ? '' : ' (not the criterion)'}: ${verdict.reproduced.length}/${verdict.expected.length} registered catches; ${verdict.staticOnly.map((check) => `${check.id} killed: ${check.killed ? 'yes' : 'no'}, at its registered input shape: ${check.atInput ? 'yes' : 'no'}`).join('; ')} → ${verdict.pass ? 'pass' : 'fail'}`)
      }
      lines.push(`kill clause (criterion copies): ${killClause ? 'pass' : 'fail'}`)
      let falseAlarmClause = true
      if (falseAlarms != null) {
        for (const copyRule of rules.data.copies.filter((candidate) => candidate.criterion)) {
          for (const list of run.knownFalse.filter((candidate) => candidate.rule.copies.includes(copyRule.id))) {
            const off = falseAlarms.offList.get(list.rule.label)!.get(copyRule.id) ?? 0
            if (list.rule.criterion && off > 0) falseAlarmClause = false
            lines.push(`falseAlarm@asWritten ${copyRule.id} against ${list.rule.label}${list.rule.criterion ? '' : ' (not scored)'}: ${off} off-list firing rows → ${off === 0 ? 'pass' : 'fail'}`)
          }
          const notReproducible = falseAlarms.notReproducible.get(copyRule.id) ?? 0
          if (notReproducible > 0) falseAlarmClause = false
          lines.push(`falseAlarm@reproducible ${copyRule.id}: ${notReproducible} → ${notReproducible === 0 ? 'pass' : 'fail'}`)
        }
      }
      lines.push(`false-alarm clause (criterion copies): ${falseAlarmClause ? 'pass' : 'fail'}`)
      lines.push(`${title} on packing: ${killClause && falseAlarmClause ? 'pass' : 'fail'}`)
      return lines
    },
    killClauses: copyVerdicts.map((verdict) => ({copies: [verdict.copy], criterion: verdict.criterion, pass: verdict.pass})),
    tsvColumns: ['id', 'author', 'class', 'registered_catch', 'static_only', 'recorded_sweep_caught_in_domain', 'mutant_over_budget'],
    tsv: (key) => {
      const mutant = run.plan.mutants.find((candidate) => candidate.key === key)!
      const planted = byId.get(mutant.id)
      const copyRule = rules.data.copies.find((candidate) => candidate.id === mutant.copy)!
      return [mutant.id, planted?.author ?? '', planted?.klass ?? mutant.family, roleOf(copyRule, mutant.id) === 'registered catch', roleOf(copyRule, mutant.id) === 'static-only', planted?.sweep[mutant.copy]?.caughtInDomain ?? '', run.summaries.get(key)?.mutantOverBudget ?? '']
    },
  }
}

/**
 * Writes report.md, criterion1.txt and kills.tsv for the run in `sourceDir` into `outDir`, and returns criterion 1 as written.
 * `criterionTitle` replaces "criterion 1" in the criterion lines, e.g. for a domain@v3-callers run, whose clauses aren't criterion 1.
 */
export async function writeReport(sourceDir: string, rules: Rules, outDir = sourceDir, criterionTitle: string | null = null): Promise<AsWrittenReport> {
  const run = await loadRun(sourceDir, rules)
  const title = criterionTitle ?? 'criterion 1'
  const out: string[] = []
  const write: Writer = (text = '') => out.push(text)
  provenance(run, write, `Plan A ${rules.id}: ${rules.family} calibration run`)
  let falseAlarms: FalseAlarmVerdicts | null = null
  const family = rules.family === 'virtualization' ? await virtualizationSections(run, write, title)
    : rules.family === 'popovers' ? await popoversSections(run, write, () => falseAlarms, title)
    : rules.family === 'frames' ? await framesSections(run, write, () => falseAlarms, title) : await packingSections(run, write, () => falseAlarms, title)
  falseAlarms = baselineSection(run, write)
  domainSection(run, write)
  freerangeSection(run, write)
  behaviorSection(run, write)
  separateColumns(run, write)
  perSiteSection(run, write)
  timingSection(run, write)
  writeFileSync(join(outDir, 'report.md'), `${out.join('\n')}\n`)
  const criterion = family.criterion()
  writeFileSync(join(outDir, 'criterion1.txt'), `${criterion.join('\n')}\n`)

  const tsv = [['mutant', 'copy', ...family.tsvColumns, ...RULE_LABELS.map((label) => `kill_${label}`), 'kill_cleanSite', 'first_producer', 'first_cause', 'killing_lines', 'throws', 'non_finite', 'behavior_diffs', 'failure'].join('\t')]
  for (const mutant of run.plan.mutants) {
    const summary = run.summaries.get(mutant.key)
    const first = summary?.first[CRITERION_RULE] ?? null
    tsv.push([
      mutant.key, mutant.copy, ...family.tsv(mutant.key), ...NOISE_RULES.map((_rule, rule) => killed(run, mutant.key, rule)), summary?.cleanKill ?? '',
      first == null ? '' : PRODUCERS[first.first.producer], first?.first.cause ?? '', killingLines(run, mutant.key, CRITERION_RULE).join(','),
      summary?.throws ?? '', summary?.nonFinite ?? '', summary?.behaviorDiffs ?? '', summary?.failure ?? '',
    ].join('\t'))
  }
  writeFileSync(join(outDir, 'kills.tsv'), `${tsv.join('\n')}\n`)
  return {criterion, killClauses: family.killClauses}
}

if (import.meta.main) {
  const [runDir, rulesPath] = process.argv.slice(2)
  const optionValue = (name: string) => {
    const index = process.argv.indexOf(name)
    return index < 0 ? null : process.argv[index + 1] ?? null
  }
  if (runDir == null || rulesPath == null) throw new Error('usage: bun mutation-instrument/report.ts <run dir> <rules.json> [--out <new dir>]')
  const rules = decodeJson(readFileSync(rulesPath, 'utf8')) as Rules
  const outDir = optionValue('--out')
  if (outDir == null) {
    await writeReport(runDir, rules)
  } else {
    if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`)
    mkdirSync(outDir, {recursive: true})
    await writeReport(runDir, rules, outDir)
  }
}
