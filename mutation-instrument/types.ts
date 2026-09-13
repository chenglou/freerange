// Data shared between the parent (run.ts), the children (worker.ts) and the report (report.ts). Types only.
import type {Comparison, TupleDomain} from './domain.ts'

export type Path = (string | number)[] // path[0] is the argument index, e.g. [1, 'cell'] for `geometry.cell`
export type RelationPlan = {left: Path; op: Comparison; right: Path}
export type PreconditionUse = 'bound' | 'integer' | 'finite' | 'relation' | 'unparsed'
export type Precondition = {text: string; line: number; use: PreconditionUse}

export type EntryPlan = {
  name: string
  ordinal: number // position among the base's exported functions, in source order
  line: number
  parameterNames: string[]
  args: TupleDomain
  relations: RelationPlan[]
  preconditions: Precondition[]
  unsupported: string | null
  phases: {p0: number; p1: number; p2: number} // input counts per phase within the budget; P3 is the rest
  digest: number // digest of the entry's whole input sequence, see lattice.ts digestValue
}

export type SiteKind = 'cmp' | 'int' | 'bool'
export type Site = {
  index: number
  line: number
  column: number
  functionName: string | null // the enclosing top-level function
  leading: boolean // part of that function's leading console.assert prefix
  text: string
  kind: SiteKind
  key: string // base | function | condition text | occurrence
}

export type BasePlan = {base: string; source: string; sourceSha1: string; instrumented: string; sites: Site[]; entries: EntryPlan[]}
export type MutantPlan = {id: string; base: string; family: string; source: string; sourceSha1: string; instrumented: string}

export type LatticeSettings = {budget: number; seed: number; p0Inputs: number; p2ProductMax: number}
export type Plan = {settings: LatticeSettings; bases: BasePlan[]; mutants: MutantPlan[]}

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
  mutant: string
  base: string
  entry: string
  inputs: number
  discarded: number // original's entry leading assert failed
  mutantOnlyDiscards: number
  digest: number
  kills: SiteFirings[] // sites in F_mutant \ F_original, per rule
  throws: Difference
  nonFiniteReturns: Difference
  behavior: Difference
  ms: number
}

export type BaselineLine = {
  type: 'baseline'
  base: string
  entry: string
  inputs: number
  discarded: number
  digest: number
  nsPerCall: number
  reached: number[] // per site: in-domain inputs that reached it
  firings: (SiteFirings & {byCause: Record<CauseClass, number>})[] // under the criterion rule's first firing classes
  throws: Difference
  nonFiniteReturns: Difference
  ms: number
}

// One input through the instrumented original and mutant: the highest level of every reached site, as [site, level].
export type ReplayLine = {type: 'replay'; mutant: string; entry: string; discarded: boolean; original: [number, number][]; mutated: [number, number][]; originalThrew: string | null; mutantThrew: string | null}
// One input through the uninstrumented original with console.assert overridden to record the failing lines.
export type VerifyLine = {type: 'verify'; base: string; entry: string; firedLines: number[]; thrown: string | null}

export type DoneLine = {type: 'done'; maxRssKb: number; ms: number}
export type HeartbeatLine = {type: 'heartbeat'; entry: string; index: number}
export type ChildLine = ResultLine | BaselineLine | ReplayLine | VerifyLine | DoneLine | HeartbeatLine

export type Job =
  | {mode: 'baseline'; plan: string}
  | {mode: 'mutant'; plan: string; mutant: string}
  | {mode: 'replay'; plan: string; mutant: string; entry: string; args: string}
  | {mode: 'verify'; plan: string; base: string; entry: string; args: string}
