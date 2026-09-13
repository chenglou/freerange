// plan.json as children, reports, the witness run and the scoring decode it. Plans written by earlier commits lack fields
// added later, and decode with the values those runs had:
// - EntryPlan.callerRules and provenance (domain@v3-callers, e.g. the recorded m2 and m4 runs): empty
// - Plan.stepBudget (before m4-packing, e.g. the m1c, m2 and m3 runs): null, no step budget
// - FilePlan.path (before 53e1e52, e.g. the m1c and m2 runs): the spliced file's path inside its tree, e.g. `menuGeometry.ts`
//   for `<run>/work/original/contracts/menuGeometry.ts`, since spliced trees always kept the copy's layout
import type {CallerRulePlan} from './callers.ts'
import {decodeJson} from './encode.ts'
import type {CopyPlan, EntryPlan, FilePlan, MutantPlan, Plan} from './types.ts'

type RecordedFile = Omit<FilePlan, 'path'> & {path?: string}
type RecordedEntry = Omit<EntryPlan, 'callerRules' | 'provenance'> & {callerRules?: CallerRulePlan[]; provenance?: string[]}
type RecordedPlan = Omit<Plan, 'copies' | 'mutants' | 'stepBudget'> & {
  stepBudget?: number | null
  copies: (Omit<CopyPlan, 'entries' | 'files'> & {entries: RecordedEntry[]; files: RecordedFile[]})[]
  mutants: (Omit<MutantPlan, 'files'> & {files: RecordedFile[]})[]
}

function withPath(file: RecordedFile, treeMarker: string): FilePlan {
  if (file.path != null) return {...file, path: file.path}
  const start = file.instrumented.indexOf(treeMarker)
  if (start < 0) throw new Error(`the recorded plan's file ${file.instrumented} has no path and isn't under ${treeMarker}`)
  return {...file, path: file.instrumented.slice(start + treeMarker.length)}
}

export function decodePlan(text: string): Plan {
  const recorded = decodeJson(text) as RecordedPlan
  return {
    settings: recorded.settings,
    stepBudget: recorded.stepBudget ?? null,
    copies: recorded.copies.map((copy) => ({
      ...copy,
      files: copy.files.map((file) => withPath(file, `/work/original/${copy.copy}/`)),
      entries: copy.entries.map((entry) => ({...entry, callerRules: entry.callerRules ?? [], provenance: entry.provenance ?? []})),
    })),
    mutants: recorded.mutants.map((mutant) => ({...mutant, files: mutant.files.map((file) => withPath(file, `/work/mutants/${mutant.key}/`))})),
  }
}
