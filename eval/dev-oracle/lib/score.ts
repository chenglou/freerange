// The oracle arm's score. Per entry, from the verdicts at the inserted assert on the snapshot tree and the fix tree:
// - refuted on a tree: Freerange says the condition can be false there, or a sweep there found a verified counterexample.
// - points at the defect: refuted on the snapshot tree and not refuted on the fix tree.
// - proved on the fix tree: verdict proved (an `unreachable` finding counts as proved, as in ../lib/findings.ts).
// - not analyzed on either: the verdict is not-analyzed on the snapshot tree, the fix tree or both.
// Counts are over the eligible entries a run covers, split by the entry's reach (static or sweep).
import type {Verdict} from '../../lib/findings.ts'

export type SweepResult = {outcome: string; n: number; verified: boolean | null; entry: string | null; input: string | null; why: string | null}

export type TreeResult = {verdict: Verdict; reason: string; finding: string | null; sweep: SweepResult | null}

export function verifiedCounterexample(result: TreeResult): boolean {
  return result.sweep != null && result.sweep.outcome === 'counterexample' && result.sweep.verified === true
}

export function refuted(result: TreeResult): boolean {
  return result.verdict === 'can-be-false' || verifiedCounterexample(result)
}

export type EntryScore = {
  pointsAtDefect: boolean
  refutedOnSnapshot: boolean
  refutedOnFix: boolean
  provedOnFix: boolean
  notAnalyzedOnEither: boolean
  heldOnSnapshot: number | null
  heldOnFix: number | null
}

export function scoreEntry(snapshot: TreeResult, fix: TreeResult): EntryScore {
  const held = (result: TreeResult): number | null => result.sweep?.outcome === 'held' ? result.sweep.n : null
  return {
    pointsAtDefect: refuted(snapshot) && !refuted(fix),
    refutedOnSnapshot: refuted(snapshot),
    refutedOnFix: refuted(fix),
    provedOnFix: fix.verdict === 'proved',
    notAnalyzedOnEither: snapshot.verdict === 'not-analyzed' || fix.verdict === 'not-analyzed',
    heldOnSnapshot: held(snapshot),
    heldOnFix: held(fix),
  }
}

export type ReachTotals = {entries: number; pointsAtDefect: number; refutedOnSnapshot: number; refutedOnFix: number; provedOnFix: number; notAnalyzedOnEither: number; notAnalyzedOnSnapshot: number; notAnalyzedOnFix: number}

export function emptyTotals(): ReachTotals {
  return {entries: 0, pointsAtDefect: 0, refutedOnSnapshot: 0, refutedOnFix: 0, provedOnFix: 0, notAnalyzedOnEither: 0, notAnalyzedOnSnapshot: 0, notAnalyzedOnFix: 0}
}

export function addToTotals(totals: ReachTotals, snapshot: TreeResult, fix: TreeResult): void {
  const score = scoreEntry(snapshot, fix)
  totals.entries++
  if (score.pointsAtDefect) totals.pointsAtDefect++
  if (score.refutedOnSnapshot) totals.refutedOnSnapshot++
  if (score.refutedOnFix) totals.refutedOnFix++
  if (score.provedOnFix) totals.provedOnFix++
  if (score.notAnalyzedOnEither) totals.notAnalyzedOnEither++
  if (snapshot.verdict === 'not-analyzed') totals.notAnalyzedOnSnapshot++
  if (fix.verdict === 'not-analyzed') totals.notAnalyzedOnFix++
}
