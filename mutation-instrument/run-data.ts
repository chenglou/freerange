// A run directory as the report and the scoring read it: plan, meta, baseline lines, verify lines, known-false lists, and a
// small summary per mutant streamed from results.jsonl. Shared by report.ts and scoring.ts, with the markdown helpers both use.
import {createHash} from 'node:crypto'
import {createReadStream, existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createInterface} from 'node:readline'
import type {Value} from './domain.ts'
import {decodeJson, formatCall} from './encode.ts'
import {decodePlan} from './plan-file.ts'
import type {KnownFalseRule, Rules} from './rules.ts'
import {CRITERION_RULE, NOISE_RULES, type BaselineLine, type CopyPlan, type Difference, type FirstFiring, type Plan, type ResultLine, type Site, type VerifyLine} from './types.ts'

// The kill clause of criterion 1 as written, per group of copies it covers: one per copy for popovers, frames and packing,
// and one for all four virtualization bases.
export type KillClause = {copies: string[]; criterion: boolean; pass: boolean}
export type AsWrittenReport = {criterion: string[]; killClauses: KillClause[]}

export type FailureLine = {type: 'failure'; mutant: string; base: string; exitCode: number | null; timedOut: string | null; stderr: string}
type VerifyRecord = {base: string; entry: string; site: number; verify: VerifyLine | null}
type KnownFalseEntry = {copy?: string; siteKey?: string; base?: string; function?: string; text?: string; occurrence?: number; cause: string}
export type KnownFalseList = {rule: KnownFalseRule; sha1: string | null; keys: Set<string>}
type Kill = {entry: string; site: number; first: FirstFiring}

export type MutantSummary = {
  key: string
  copy: string
  entries: number
  killSites: Set<number>[] // per rule
  first: (Kill | null)[] // per rule, the killing input with the lowest index
  laterProducer: boolean[] // per rule: some kill came from P1-P3
  killEntries: Set<string>[] // per rule, the entries with a kill
  cleanKill: boolean // criterion rule, through a site with 0 baseline firings for that entry
  throws: number
  throwFirst: string | null
  nonFinite: number
  nonFiniteFirst: string | null
  behaviorDiffs: number
  behaviorFirst: string | null
  overBudget: number // inputs whose original call passed the step budget, summed over entries
  mutantOverBudget: number
  mutantOverBudgetFirst: string | null
  digestMismatches: number
  failure: string | null
}

export type Run = {
  outDir: string
  rules: Rules
  meta: Record<string, unknown>
  plan: Plan
  copyOf: Map<string, CopyPlan>
  baseline: Map<string, BaselineLine>
  baselineDigestMismatches: number
  summaries: Map<string, MutantSummary>
  resultLines: number
  verifies: VerifyRecord[]
  knownFalse: KnownFalseList[]
}

export async function* jsonLines(path: string): AsyncGenerator<unknown> {
  if (!existsSync(path)) return
  const reader = createInterface({input: createReadStream(path), crlfDelay: Infinity})
  for await (const line of reader) if (line !== '') yield decodeJson(line)
}

export async function readLines<T>(path: string): Promise<T[]> {
  const result: T[] = []
  for await (const value of jsonLines(path)) result.push(value as T)
  return result
}

export function formatInput(entry: string, first: FirstFiring | null): string {
  if (first == null) return ''
  return first.input == null ? '(input above 2 KB, not kept)' : formatCall(entry, decodeJson(first.input) as Value[])
}

export const PRODUCERS = ['P0', 'P1', 'P2', 'P3']
export function listOrNone(items: string[], separator = ', ') {
  return items.length === 0 ? 'none' : items.join(separator)
}

function cell(text: string | number) {
  return String(text).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function table(header: string[], rows: (string | number)[][]): string {
  if (rows.length === 0) return 'None.'
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
}

export function killed(run: Run, key: string, rule: number) {
  return (run.summaries.get(key)?.killSites[rule]!.size ?? 0) > 0
}

export function siteOf(run: Run, copy: string, site: number): Site {
  return run.copyOf.get(copy)!.sites[site]!
}

export function siteLabel(site: Site) {
  return `${site.functionName}:${site.file}:${site.line} ${site.text}`
}

function knownKey(entry: KnownFalseEntry): string {
  if (entry.siteKey != null && entry.copy != null) return `${entry.copy}|${entry.siteKey}|${entry.cause}`
  return `${entry.base}|${entry.base}|${entry.function}|${entry.text}|${entry.occurrence}|${entry.cause}`
}

export async function loadRun(outDir: string, rules: Rules): Promise<Run> {
  const meta = decodeJson(readFileSync(join(outDir, 'meta.json'), 'utf8')) as Record<string, unknown>
  const plan = decodePlan(readFileSync(join(outDir, 'plan.json'), 'utf8'))
  const copyOf = new Map(plan.copies.map((copy) => [copy.copy, copy]))
  const digestOf = new Map<string, number>()
  for (const copy of plan.copies) for (const entry of copy.entries) digestOf.set(`${copy.copy}.${entry.name}`, entry.digest)
  const knownFalse: KnownFalseList[] = rules.data.knownFalse.map((rule) => {
    const path = join(rules.data.scratch, rule.path)
    if (!existsSync(path)) return {rule, sha1: null, keys: new Set<string>()}
    const text = readFileSync(path)
    const list = decodeJson(text.toString()) as {entries: KnownFalseEntry[]}
    return {rule, sha1: createHash('sha1').update(text).digest('hex'), keys: new Set(list.entries.map(knownKey))}
  })

  const baseline = new Map<string, BaselineLine>()
  let baselineDigestMismatches = 0
  // Lines written by earlier commits lack later counts, which are 0 there: callerDiscarded before domain@v3-callers, and
  // overBudget and mutantOverBudget before the step budget (e50f5aa), e.g. in the m1c, m2 and m3 runs.
  for (const recorded of await readLines<Omit<BaselineLine, 'callerDiscarded' | 'overBudget'> & {callerDiscarded?: number; overBudget?: number}>(join(outDir, 'baseline.jsonl'))) {
    const line: BaselineLine = {...recorded, callerDiscarded: recorded.callerDiscarded ?? 0, overBudget: recorded.overBudget ?? 0}
    baseline.set(`${line.base}.${line.entry}`, line)
    if (line.digest !== digestOf.get(`${line.base}.${line.entry}`)) baselineDigestMismatches += 1
  }
  const baselineFires = (copy: string, entry: string, site: number, rule: number) => {
    const firing = baseline.get(`${copy}.${entry}`)?.firings.find((candidate) => candidate.site === site)
    return firing == null ? 0 : firing.counts[rule]!.reduce((sum, count) => sum + count, 0)
  }

  const summaries = new Map<string, MutantSummary>()
  const summaryOf = (key: string, copy: string) => {
    let summary = summaries.get(key)
    if (summary == null) {
      summary = {
        key, copy, entries: 0, killSites: NOISE_RULES.map(() => new Set<number>()), first: NOISE_RULES.map(() => null), laterProducer: NOISE_RULES.map(() => false),
        killEntries: NOISE_RULES.map(() => new Set<string>()), cleanKill: false,
        throws: 0, throwFirst: null, nonFinite: 0, nonFiniteFirst: null, behaviorDiffs: 0, behaviorFirst: null, overBudget: 0, mutantOverBudget: 0, mutantOverBudgetFirst: null, digestMismatches: 0, failure: null,
      }
      summaries.set(key, summary)
    }
    return summary
  }
  let resultLines = 0
  type RecordedResultLine = Omit<ResultLine, 'callerDiscarded' | 'overBudget' | 'mutantOverBudget'> & {callerDiscarded?: number; overBudget?: number; mutantOverBudget?: Difference}
  for await (const value of jsonLines(join(outDir, 'results.jsonl'))) {
    const recorded = value as RecordedResultLine | FailureLine
    if (recorded.type === 'failure') {
      summaryOf(recorded.mutant, recorded.base).failure = recorded.timedOut ?? `exit ${recorded.exitCode}: ${recorded.stderr.slice(-300)}`
      continue
    }
    const line: ResultLine = {...recorded, callerDiscarded: recorded.callerDiscarded ?? 0, overBudget: recorded.overBudget ?? 0, mutantOverBudget: recorded.mutantOverBudget ?? {count: 0, first: null, detail: null}}
    resultLines += 1
    const summary = summaryOf(line.mutant, line.base)
    summary.entries += 1
    if (line.digest !== digestOf.get(`${line.base}.${line.entry}`)) summary.digestMismatches += 1
    for (const kill of line.kills) {
      for (let rule = 0; rule < NOISE_RULES.length; rule++) {
        const first = kill.first[rule]
        if (first == null) continue
        summary.killSites[rule]!.add(kill.site)
        summary.killEntries[rule]!.add(line.entry)
        const counts = kill.counts[rule]!
        if (counts[1]! + counts[2]! + counts[3]! > 0) summary.laterProducer[rule] = true
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
    summary.overBudget += line.overBudget
    summary.mutantOverBudget += line.mutantOverBudget.count
    summary.mutantOverBudgetFirst ??= line.mutantOverBudget.first == null ? null : `${formatInput(line.entry, line.mutantOverBudget.first)}: ${line.mutantOverBudget.detail}`
  }
  const verifies = await readLines<VerifyRecord>(join(outDir, 'verify.jsonl'))
  return {outDir, rules, meta, plan, copyOf, baseline, baselineDigestMismatches, summaries, resultLines, verifies, knownFalse}
}
