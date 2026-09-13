// plan.json as children, reports and the scoring decode it. Plans written before domain@v3-callers, e.g. the recorded m2
// and m4 runs', have no callerRules or provenance on their entries, and both are empty there.
import type {CallerRulePlan} from './callers.ts'
import {decodeJson} from './encode.ts'
import type {CopyPlan, EntryPlan, Plan} from './types.ts'

type RecordedEntry = Omit<EntryPlan, 'callerRules' | 'provenance'> & {callerRules?: CallerRulePlan[]; provenance?: string[]}
type RecordedPlan = Omit<Plan, 'copies'> & {copies: (Omit<CopyPlan, 'entries'> & {entries: RecordedEntry[]})[]}

export function decodePlan(text: string): Plan {
  const recorded = decodeJson(text) as RecordedPlan
  return {...recorded, copies: recorded.copies.map((copy) => ({...copy, entries: copy.entries.map((entry) => ({...entry, callerRules: entry.callerRules ?? [], provenance: entry.provenance ?? []}))}))}
}
