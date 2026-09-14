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
// excludedEntries: exported functions the registration keeps out of the entries (CopyRule.excludedEntries); nodeModules: the
// node_modules directory every spliced tree root of the copy links to, or null.
export type CopyPlan = {copy: string; files: FilePlan[]; sites: Site[]; entries: EntryPlan[]; excludedEntries: string[]; nodeModules: string | null}
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
export const CAUSES: CauseClass[] = ['subnormal', 'drift', 'large', 'ordinary']

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

// One item of a verify-batch job: the lines the uninstrumented original records for items[item].
export type VerifyItemLine = {type: 'verify-item'; item: number; fired: string[]; thrown: string | null}

// scoring@witness-v1's instrument gates for one entry (worker.ts score mode, R-S4). A row is (site, cause class) with at
// least one criterion-rule firing on the instrumented original. `ordinal` numbers the rows of one copy: entries in
// ordinal order, sites in index order, causes in CAUSES order.
export type ScoreFailure = {index: number; reason: string; fired: string[]; thrown: string | null}
export type ScoreRow = {
  site: number
  cause: CauseClass
  ordinal: number
  count: number
  producers: number[]
  firstIndex: number
  firstInput: string | null // at most 2 KB
  verified: number // regenerated inputs called on the uninstrumented copy: the first, plus every firing index or a seeded 1,000
  failureCount: number
  failures: ScoreFailure[] // the first 20
  features: Record<string, number> // firing inputs where each boolean triage feature is true (scan-features.ts)
}
// missedFiring: sampled in-domain inputs with no criterion-rule firing and within the step budget, called on the
// uninstrumented copy. A miss is a recorded line whose sites all stayed at level 1 or below on the instrumented original.
export type MissedFiring = {sampled: number; draws: number; missCount: number; misses: {index: number; lines: string[]}[]}
export type ScoreLine = {type: 'score'; base: string; entry: string; digest: number; inputs: number; discarded: number; callerDiscarded: number; overBudget: number; rows: ScoreRow[]; missed: MissedFiring}

// -- scoring@witness-v1 witness sets (witness-run.ts, witness.ts) ----------------------------

// witness-run.ts -> witness.ts: one witness set on one copy. `args` and `substitute` have their placeholders resolved.
export type WitnessJob = {plan: string; family: string; copy: string; set: string; script: string; args: string[]; substitute: {from: string; to: string} | null; derivedScript: string; tiers: 'all' | 'packing-in-domain'; callerRules: string; reservoir: number; out: string}
// A caller rule checked on every in-domain witness call of its entry (R-D1(ii)).
export type WitnessRuleCheck = {id: string; checked: number; violations: number; firstViolation: string | null}
// Witness calls of an entry that record a site at level 3 or above and fire no domain line, grouped by the bit mask of the
// entry's caller rules they violate (bit i = rules[i]); `inputs` keeps the first `reservoir` encoded argument lists.
export type WitnessReservoirOutput = {mask: number; count: number; inputs: string[]}
export type WitnessSiteOutput = {site: number; key: string; file: string; line: number; firing: number; withoutDomainLine: number; reservoirs: WitnessReservoirOutput[]}
// calls: every wrapped call; inDomain, degenerate, unclassified: the calls per sweep tier (only packing's sweep has a
// degenerate tier); overBudget, threw and domainLineFired count in-domain calls.
export type WitnessEntryOutput = {name: string; rules: string[]; calls: number; inDomain: number; degenerate: number; unclassified: number; overBudget: number; threw: number; domainLineFired: number; sites: WitnessSiteOutput[]; ruleChecks: WitnessRuleCheck[]}
export type WitnessSetOutput = {family: string; copy: string; set: string; script: string; scriptSha1: string; executed: string; executedSha1: string; args: string[]; ms: number; maxRssKb: number; entries: WitnessEntryOutput[]}
// witness-run.ts's table per copy, merged over the copy's witness sets, with each stored input called on the uninstrumented
// copy: `verified` counts inputs that record the site's line and no domain line of the entry.
export type WitnessReservoir = {mask: number; count: number; stored: number; verified: number; firstVerified: string | null; failures: {input: string; fired: string[]; thrown: string | null}[]}
export type WitnessSite = {key: string; file: string; line: number; firing: number; withoutDomainLine: number; reservoirs: WitnessReservoir[]}
export type WitnessEntry = {name: string; rules: string[]; calls: number; inDomain: number; degenerate: number; unclassified: number; overBudget: number; threw: number; domainLineFired: number; sites: WitnessSite[]; ruleChecks: WitnessRuleCheck[]}
export type WitnessTable = {family: string; copy: string; sets: {set: string; output: string; outputSha1: string}[]; entries: WitnessEntry[]}

export type DoneLine = {type: 'done'; maxRssKb: number; ms: number}
export type HeartbeatLine = {type: 'heartbeat'; entry: string; index: number}
export type ChildLine = ResultLine | BaselineLine | ReplayLine | VerifyLine | CallLine | VerifyItemLine | ScoreLine | DoneLine | HeartbeatLine

export type Job =
  | {mode: 'baseline'; plan: string}
  | {mode: 'mutant'; plan: string; mutant: string}
  | {mode: 'replay'; plan: string; mutant: string; entry: string; args: string}
  | {mode: 'verify'; plan: string; base: string; entry: string; args: string}
  | {mode: 'call'; plan: string; mutant: string; entry: string; args: string}
  // items: a JSON file of {entry, args} with args encoded, e.g. [{"entry": "packRows", "args": "[[], 320, 8]"}]
  | {mode: 'verify-batch'; plan: string; base: string; items: string}
  | {mode: 'score'; plan: string; base: string; samplesPerRow: number; missedSamples: number; maxDrawsPerEntry: number}
