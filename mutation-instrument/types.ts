// Data shared between the parent (run.ts), the children (worker.ts) and the report (report.ts). Types only.
import type {CallerRulePlan} from './callers.ts'
import type {Comparison, TupleDomain} from './domain.ts'

export type Path = (string | number)[] // path[0] is the argument index, e.g. [1, 'cell'] for `geometry.cell`
export type RelationPlan = {left: Path; op: Comparison; right: Path}
export type PreconditionUse = 'bound' | 'integer' | 'finite' | 'relation' | 'unparsed'
// origin 'entry': one conjunct of the entry's own leading assert. origin 'callee': one conjunct of a same-file callee's
// leading assert, rewritten through an unconditional call whose arguments are entry parameter paths (domain@v2).
export type Precondition = {text: string; file: string; line: number; use: PreconditionUse; origin: 'entry' | 'callee'; callee: string | null}

export type EntryPlan = {
  name: string
  file: string // logical name of the copy file that exports the entry, e.g. `menuGeometry`
  ordinal: number // position among the copy's exported functions: files in registered order, then source order
  line: number
  parameterNames: string[]
  args: TupleDomain
  relations: RelationPlan[]
  preconditions: Precondition[]
  // Sites whose firing during a call of this entry discards the input: the entry's own leading asserts, and the leading
  // asserts of same-file callees that receive only entry parameter paths at every call (domain@v2 leak rule).
  discardSites: number[]
  leakSites: number[] // the second group above, also listed separately for the report
  unsupported: string | null
  phases: {p0: number; p1: number; p2: number} // input counts per phase within the budget; P3 is the rest
  digest: number // digest of the entry's whole input sequence, see lattice.ts digestValue
  // domain@v3-callers: the caller rules applied to this entry, and one line per narrowed leaf, relation and predicate naming
  // the rule and the call sites it cites (callers.ts). Both are empty under domain@v2.
  callerRules: CallerRulePlan[]
  provenance: string[]
}

export type SiteKind = 'cmp' | 'int' | 'bool'
export type Site = {
  index: number // global within the copy: files in registered order
  file: string
  line: number
  column: number
  functionName: string | null // the enclosing top-level function
  leading: boolean // part of that function's leading console.assert prefix
  text: string
  kind: SiteKind
  key: string // file | function | condition text | occurrence
}

// One file of a copy or of a mutant tree. `path` is where the file sits inside the tree, e.g. `src/MidUI/PageFrame.ts`, and
// spliced trees keep that layout; `source` is the uninstrumented file, `instrumented` the spliced one.
export type FilePlan = {file: string; path: string; source: string; sourceSha1: string; instrumented: string}
export type CopyPlan = {copy: string; files: FilePlan[]; sites: Site[]; entries: EntryPlan[]}
// A mutant is a whole tree of the copy's files; `changedFiles` lists the files whose text differs from the copy's.
export type MutantPlan = {key: string; id: string; copy: string; family: string; files: FilePlan[]; changedFiles: string[]}

export type LatticeSettings = {budget: number; seed: number; p0Inputs: number; p2ProductMax: number}
// stepBudget: the most loop body entries one call may run (execution.stepBudget), null when none is registered.
export type Plan = {settings: LatticeSettings; stepBudget: number | null; copies: CopyPlan[]; mutants: MutantPlan[]}

// Firing levels per site per call, see recorder.ts. A rule fires at or above its threshold.
export type NoiseRule = 'none' | 'abs1e-9' | 'abs1e-9-literal'
export const NOISE_RULES: NoiseRule[] = ['none', 'abs1e-9', 'abs1e-9-literal']
export const RULE_THRESHOLDS = [2, 3, 4]
export const CRITERION_RULE = 1 // index of noise@abs1e-9 in NOISE_RULES

export type CauseClass = 'subnormal' | 'drift' | 'large' | 'ordinary'

// First firing of a site under one rule: lowest input index, its producer (0-3 for P0-P3), the margin when known,
// the cause class, and the encoded input when at most 2 KB.
export type FirstFiring = {index: number; producer: number; margin: number | null; cause: CauseClass; input: string | null}

export type SiteFirings = {
  site: number
  // counts[rule][producer]
  counts: number[][]
  first: (FirstFiring | null)[] // per rule
}

export type Difference = {count: number; first: FirstFiring | null; detail: string | null}

export type ResultLine = {
  type: 'result'
  mutant: string // the mutant key
  base: string // the copy
  entry: string
  inputs: number
  discarded: number // an input the original's call discarded (discardSites)
  callerDiscarded: number // an input a caller rule discarded before any call (domain@v3-callers); 0 under domain@v2
  mutantOnlyDiscards: number
  overBudget: number // an input whose original call passed the step budget; the mutant doesn't run on it
  mutantOverBudget: Difference // the mutant passed the step budget where the original returned or threw; not a kill
  digest: number
  kills: SiteFirings[] // sites in F_mutant \ F_original, per rule
  throws: Difference
  nonFiniteReturns: Difference
  behavior: Difference
  ms: number
}

export type BaselineLine = {
  type: 'baseline'
  base: string // the copy
  entry: string
  inputs: number
  discarded: number
  callerDiscarded: number // inputs a caller rule discarded before the call (domain@v3-callers); 0 under domain@v2
  overBudget: number // inputs whose call passed the step budget, like discards never counted as firings
  digest: number
  nsPerCall: number
  reached: number[] // per site: in-domain inputs that reached it
  firings: (SiteFirings & {byCause: Record<CauseClass, number>})[] // under the criterion rule's first firing classes
  throws: Difference
  nonFiniteReturns: Difference
  ms: number
}

// One input through the instrumented original and mutant: the highest level of every reached site, as [site, level].
// `callerDiscarded`: the input violates a caller rule of the entry (domain@v3-callers); the calls still run.
export type ReplayLine = {type: 'replay'; mutant: string; entry: string; callerDiscarded: boolean; discarded: boolean; originalOverBudget: boolean; mutantOverBudget: boolean; original: [number, number][]; mutated: [number, number][]; originalThrew: string | null; mutantThrew: string | null}
// One input through the uninstrumented original with console.assert overridden to record the failing lines, as `file:line`.
export type VerifyLine = {type: 'verify'; base: string; entry: string; fired: string[]; thrown: string | null}
// One input through the uninstrumented original and mutant trees: failing lines and the encoded return value of each.
export type CallOutcome = {fired: string[]; thrown: string | null; value: string | null}
export type CallLine = {type: 'call'; mutant: string; entry: string; original: CallOutcome; mutated: CallOutcome}

export type DoneLine = {type: 'done'; maxRssKb: number; ms: number}
export type HeartbeatLine = {type: 'heartbeat'; entry: string; index: number}
export type ChildLine = ResultLine | BaselineLine | ReplayLine | VerifyLine | CallLine | DoneLine | HeartbeatLine

export type Job =
  | {mode: 'baseline'; plan: string}
  | {mode: 'mutant'; plan: string; mutant: string}
  | {mode: 'replay'; plan: string; mutant: string; entry: string; args: string}
  | {mode: 'verify'; plan: string; base: string; entry: string; args: string}
  | {mode: 'call'; plan: string; mutant: string; entry: string; args: string}
