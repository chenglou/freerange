// Which entries the oracle arm scores, per tier, and why every other entry is out. Each tier is evaluated over every entry
// on its own, and its counts are never added to the other's:
// - tier 1: checks that caught or evaluated the defect (status `used`)
// - tier 2: curator-written checks not run against the defect (status `proposed`), an upper bound on what an assert could
//   catch
// Criteria, in order; an entry is counted under the first criterion it fails, and a later criterion is evaluated only for
// entries that pass the earlier ones:
// 0. The entry is on the development split: `split` isn't `heldout`.
// 1. `reach` is `static` or `sweep`.
// 2. A check of the tier gives a console.assert condition: kind console-assert, sweep or differential, whose curated reading
//    gives a condition. Tier 1 takes status `used` with role caught-live, post-fix-contract or post-hoc-check; tier 2 takes
//    status `proposed`. Other kinds (browser-measurement, screenshot-comparison, render-count, code-review, typecheck,
//    unrecorded) leave no condition. A check the readings file doesn't cover, or covers for a different statement text, is
//    counted as unread.
// 3. The condition's site exists in JS or TS at both trees: the entry has a fix commit; the reading places the condition;
//    the placed file has a JS or TS extension and exists at the fix's first parent (the snapshot tree) and at the fix; the
//    anchor statement (the fix anchor on the fix tree) is found once in the named function on both trees; the condition's
//    names resolve there on both trees (lib/placement.ts). Candidates are tried in role order (caught-live,
//    post-fix-contract, post-hoc-check), then in checks[] order, and the first that passes is the entry's catching check.
//    When none passes, the entry is counted under the first candidate's first failure; every failure of every candidate on
//    both trees is recorded.
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {Binding, Check, Entry, EntriesFile, Placement, ReadingsFile} from './entries.ts'
import {sha1} from './entries.ts'
import {filesIdentical, resolveCommit, showFile} from './git.ts'
import {insertAssert, scriptExtensions} from './placement.ts'

const conditionKinds = ['console-assert', 'sweep', 'differential']
const catchingRoles = ['caught-live', 'post-fix-contract', 'post-hoc-check']

export type Tier = 1 | 2
export const tiers: Tier[] = [1, 2]

export function tierTitle(tier: Tier): string {
  return tier === 1
    ? 'checks that caught or evaluated the defect (status used)'
    : 'curator-written checks (status proposed, not run against the defect): an upper bound on what an assert could catch'
}

function tierTakes(tier: Tier, check: Check): boolean {
  if (!conditionKinds.includes(check.kind)) return false
  return tier === 1 ? check.status === 'used' && catchingRoles.includes(check.role) : check.status === 'proposed'
}

export type TreeRole = 'snapshot' | 'fix'

export function anchorFor(placement: Placement, tree: TreeRole): string {
  return tree === 'fix' ? placement.fixAnchor ?? placement.anchor : placement.anchor
}

export type Reason = {criterion: 0 | 1 | 2 | 3; code: string; tree: TreeRole | null; checkIndex: number | null; detail: string}

export type TreeInsertion = {commit: string; assertLine: number; firstInsertedLine: number; insertedLineCount: number; pristineSha1: string; insertedSha1: string}

export type SelectedCheck = {
  checkIndex: number
  kind: string
  role: string
  condition: string
  bindings: Binding[]
  placement: Placement
  clone: string
  trees: Record<TreeRole, TreeInsertion>
  locationSnapshotCommit: string | null
  siteFileIdenticalAtLocationSnapshot: boolean | null
}

export type EligibilityRow = {tier: Tier; id: string; reach: Entry['reach']; split: string; eligible: boolean; reason: Reason | null; failures: Reason[]; proposedConsoleAsserts: number; selected: SelectedCheck | null}

export type Eligibility = {rule: string; entries: {path: string; sha1: string; count: number}; readings: {path: string; sha1: string; rule: string; by: string; date: string}; rows: EligibilityRow[]}

export function defaultClones(): Map<string, string> {
  const github = join(homedir(), 'github')
  return new Map([
    ['nicer-hacker-news', join(github, 'nicer-hacker-news')],
    ['pretext', join(github, 'pretext')],
    ['vibescript', join(github, 'vibescript')],
    ['chenglou.github.io', join(github, 'chenglou.github.io')],
  ])
}

type Candidate = {checkIndex: number; kind: string; role: string; condition: string; bindings: Binding[]; placement: Placement | null; why: string}

function evaluateEntry(entry: Entry, readings: ReadingsFile, clones: Map<string, string>, tier: Tier): EligibilityRow {
  const proposedConsoleAsserts = entry.checks.filter(check => check.kind === 'console-assert' && check.status === 'proposed').length
  const row: EligibilityRow = {tier, id: entry.id, reach: entry.reach, split: entry.split, eligible: false, reason: null, failures: [], proposedConsoleAsserts, selected: null}
  const fail = (reasons: Reason[]): EligibilityRow => {
    row.failures = reasons
    row.reason = reasons[0] ?? null
    return row
  }
  if (entry.split === 'heldout') return fail([{criterion: 0, code: 'split-heldout', tree: null, checkIndex: null, detail: 'held-out entries are never scored here'}])
  if (entry.reach !== 'static' && entry.reach !== 'sweep') return fail([{criterion: 1, code: 'reach-browser', tree: null, checkIndex: null, detail: `reach ${entry.reach}`}])

  const entryReadings = readings.entries.get(entry.id) ?? []
  const unread: Reason[] = []
  const candidates: Candidate[] = []
  entry.checks.forEach((check, checkIndex) => {
    if (!tierTakes(tier, check)) return
    const reading = entryReadings.find(candidate => candidate.index === checkIndex)
    if (reading == null) {
      unread.push({criterion: 2, code: 'reading-missing', tree: null, checkIndex, detail: `no reading of checks[${checkIndex}] (${check.kind}, ${check.role}, ${check.status})`})
    } else if (reading.statementSha1 !== sha1(check.statement)) {
      unread.push({criterion: 2, code: 'reading-stale', tree: null, checkIndex, detail: `checks[${checkIndex}]'s statement changed since it was read`})
    } else if (reading.condition != null) {
      candidates.push({checkIndex, kind: check.kind, role: check.role, condition: reading.condition, bindings: reading.bindings, placement: reading.placement, why: reading.why})
    }
  })
  if (candidates.length === 0) {
    if (unread.length > 0) return fail(unread)
    const statusKinds = (status: string): string => {
      const kinds = entry.checks.filter(check => check.status === status).map(check => check.kind)
      return kinds.length === 0 ? 'none' : kinds.join(', ')
    }
    const detail = tier === 1
      ? `no used check gives a condition (used kinds: ${statusKinds('used')}; proposed console-assert checks: ${proposedConsoleAsserts})`
      : `no proposed check gives a condition (proposed kinds: ${statusKinds('proposed')})`
    return fail([{criterion: 2, code: 'no-condition', tree: null, checkIndex: null, detail}])
  }
  candidates.sort((left, right) => {
    const byRole = catchingRoles.indexOf(left.role) - catchingRoles.indexOf(right.role)
    return byRole !== 0 ? byRole : left.checkIndex - right.checkIndex
  })

  const fixCommit = entry.location.fixCommit
  if (fixCommit == null) return fail([{criterion: 3, code: 'no-fix-commit', tree: null, checkIndex: null, detail: `location.fix_commit is null (snapshot ${entry.location.snapshotCommit ?? 'null'})`}])
  const failures: Reason[] = []
  for (const candidate of candidates) {
    const candidateFailures: Reason[] = []
    const add = (code: string, tree: TreeRole | null, detail: string): void => {
      candidateFailures.push({criterion: 3, code, tree, checkIndex: candidate.checkIndex, detail})
    }
    const placement = candidate.placement
    if (placement == null) {
      add('no-placement', null, candidate.why)
      failures.push(...candidateFailures)
      continue
    }
    const clone = clones.get(placement.repo)
    if (clone == null) {
      add('repo-unknown', null, `no clone for ${placement.repo}`)
      failures.push(...candidateFailures)
      continue
    }
    const fix = resolveCommit(clone, fixCommit)
    const parent = fix == null ? null : resolveCommit(clone, `${fix}^1`)
    if (fix == null) add('fix-commit-missing', 'fix', `${placement.repo} has no commit ${fixCommit}`)
    else if (parent == null) add('fix-parent-missing', 'snapshot', `${fixCommit} has no parent`)
    if (!scriptExtensions.some(extension => placement.path.endsWith(extension))) add('not-js-ts', null, `${placement.path} isn't a JS or TS file`)
    const trees: Partial<Record<TreeRole, TreeInsertion>> = {}
    if (candidateFailures.length === 0 && fix != null && parent != null) {
      for (const [tree, commit] of [['snapshot', parent], ['fix', fix]] as const) {
        const content = showFile(clone, commit, placement.path)
        if (content == null) {
          add(`file-missing-at-${tree}`, tree, `${placement.path} doesn't exist at ${commit.slice(0, 10)}`)
          continue
        }
        const insertion = insertAssert(placement.path, content, {function: placement.function, anchor: anchorFor(placement, tree), position: placement.position, condition: candidate.condition, bindings: candidate.bindings})
        if (insertion.kind === 'failed') {
          add(insertion.reason, tree, `${insertion.detail} (${commit.slice(0, 10)})`)
          continue
        }
        trees[tree] = {commit, assertLine: insertion.assertLine, firstInsertedLine: insertion.firstInsertedLine, insertedLineCount: insertion.insertedLineCount, pristineSha1: sha1(content), insertedSha1: sha1(insertion.text)}
      }
    }
    if (candidateFailures.length === 0 && trees.snapshot != null && trees.fix != null) {
      const locationSnapshot = entry.location.snapshotCommit == null ? null : resolveCommit(clone, entry.location.snapshotCommit)
      row.eligible = true
      row.failures = failures
      row.selected = {
        checkIndex: candidate.checkIndex, kind: candidate.kind, role: candidate.role, condition: candidate.condition, bindings: candidate.bindings, placement, clone,
        trees: {snapshot: trees.snapshot, fix: trees.fix},
        locationSnapshotCommit: locationSnapshot,
        siteFileIdenticalAtLocationSnapshot: locationSnapshot == null ? null : filesIdentical(clone, locationSnapshot, trees.snapshot.commit, placement.path),
      }
      return row
    }
    failures.push(...candidateFailures)
  }
  return fail(failures)
}

export function evaluateEligibility(entries: EntriesFile, readings: ReadingsFile, clones: Map<string, string>): Eligibility {
  return {
    rule: 'dev-oracle-eligibility@v2',
    entries: {path: entries.path, sha1: entries.sha1, count: entries.entries.length},
    readings: {path: readings.path, sha1: readings.sha1, rule: readings.rule, by: readings.by, date: readings.date},
    rows: tiers.flatMap(tier => entries.entries.map(entry => evaluateEntry(entry, readings, clones, tier))),
  }
}

function describeFailure(failure: Reason): string {
  return `${failure.checkIndex == null ? '' : `checks[${failure.checkIndex}] `}${failure.code}${failure.tree == null ? '' : ` (${failure.tree})`}: ${failure.detail}`
}

export function formatEligibility(eligibility: Eligibility): string {
  const lines: string[] = []
  lines.push(`Counting rule: per tier (dev-oracle-tiers@v1), one row per line of entries.jsonl (${eligibility.entries.count} lines, sha1 ${eligibility.entries.sha1}), counted under the first criterion it fails, or as eligible. The tiers' counts are never added. Readings file sha1 ${eligibility.readings.sha1} (${eligibility.readings.rule}, by ${eligibility.readings.by}, ${eligibility.readings.date}).`, '')
  for (const tier of tiers) {
    const rows = eligibility.rows.filter(row => row.tier === tier)
    lines.push(`## Tier ${tier}: ${tierTitle(tier)}`, '')
    lines.push('| criterion | outcome | entries | static | sweep | browser |', '|---|---|---:|---:|---:|---:|')
    const groups = new Map<string, EligibilityRow[]>()
    for (const row of rows) {
      const key = row.eligible ? 'in|eligible' : `${row.reason?.criterion ?? '?'}|${row.reason?.code ?? '?'}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    const rank = (key: string): number => key.startsWith('in') ? 9 : Number(key[0])
    const ordered = [...groups.entries()].sort(([left], [right]) => {
      const byCriterion = rank(left) - rank(right)
      return byCriterion !== 0 ? byCriterion : left.localeCompare(right)
    })
    const byReach = (group: EligibilityRow[], reach: string): number => group.filter(row => row.reach === reach).length
    for (const [key, group] of ordered) {
      const [criterion, code] = key.split('|')
      lines.push(`| ${criterion} | ${code} | ${group.length} | ${byReach(group, 'static')} | ${byReach(group, 'sweep')} | ${byReach(group, 'browser')} |`)
    }
    lines.push(`| | total | ${rows.length} | ${byReach(rows, 'static')} | ${byReach(rows, 'sweep')} | ${byReach(rows, 'browser')} |`, '')
    if (tier === 1) {
      const noCondition = rows.filter(row => row.reason?.code === 'no-condition')
      lines.push(`Of the ${noCondition.length} entries out under no-condition, ${noCondition.filter(row => row.proposedConsoleAsserts > 0).length} have a proposed console-assert check. Tier 1 doesn't take those; tier 2 does.`, '')
    }
    lines.push('| entry | reach | outcome | reason |', '|---|---|---|---|')
    for (const row of rows) {
      if (row.reach === 'browser') continue
      const outcome = row.eligible ? `in, checks[${row.selected!.checkIndex}]` : `out, criterion ${row.reason?.criterion ?? '?'} ${row.reason?.code ?? ''}`
      const selected = row.selected
      const reason = selected != null
        ? `\`${selected.condition}\` ${selected.placement.position} \`${selected.placement.anchor}\`${selected.placement.fixAnchor == null ? '' : ` (fix tree: \`${selected.placement.fixAnchor}\`)`} in ${selected.placement.function}, ${selected.placement.path}${row.failures.length > 0 ? `; earlier candidates: ${row.failures.map(describeFailure).join('; ')}` : ''}`
        : row.failures.map(describeFailure).join('; ')
      lines.push(`| ${row.id} | ${row.reach} | ${outcome} | ${reason.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`)
    }
    lines.push('', `The ${byReach(rows, 'browser')} browser-reach entries are out under criterion 1 and not listed.`, '')
  }
  const eligibleIn = (tier: Tier): Set<string> => new Set(eligibility.rows.filter(row => row.tier === tier && row.eligible).map(row => row.id))
  const both = [...eligibleIn(1)].filter(id => eligibleIn(2).has(id))
  lines.push(`Eligible in both tiers: ${both.length}${both.length === 0 ? '' : ` (${both.join(', ')})`}.`)
  return `${lines.join('\n')}\n`
}
