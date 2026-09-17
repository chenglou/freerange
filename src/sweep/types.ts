// Data shared by the sweep's parent (run.ts, in the `fr` process), its child (child.ts) and the report (report.ts).
// Types only.
import type {Comparison, TupleDomain} from './domain.ts'

export type Path = (string | number)[] // path[0] is the argument index, e.g. [1, 'cell'] for `geometry.cell`
export type RelationPlan = {left: Path; op: Comparison; right: Path}

export type LatticeSettings = {budget: number; seed: number; p0Inputs: number; p2ProductMax: number}

export type SiteKind = 'cmp' | 'int' | 'bool'
export type Site = {
  index: number
  file: string
  line: number
  column: number
  functionName: string | null // the enclosing top-level function
  leading: boolean // part of that function's leading console.assert prefix
  text: string
  kind: SiteKind
  key: string // file | function | condition text | occurrence
}

// Why an input is outside an entry's domain when a discard site fails during its call:
//   leading: one of the entry's own leading asserts, or a same-file callee's leading assert that receives only entry
//            parameter paths at every call from the entry (domain@v2 rule 3)
//   F1:      an assert in a loop-scoped precondition directly after the entry's leading prefix
//   F3:      a same-file callee's leading assert that receives parameter paths or direct element reads, through up to 4
//            levels of same-file calls
// R1 (a failing console.assert of an imported module) is not a site; the child counts it separately.
export type DiscardCause = 'leading' | 'F1' | 'F3'
export const DISCARD_CAUSES: DiscardCause[] = ['leading', 'F1', 'F3']

export type SweepEntry = {
  name: string
  ordinal: number // position among the file's named top-level functions, in source order
  line: number
  parameterNames: string[]
  args: TupleDomain
  relations: RelationPlan[]
  // F2: pairs of array parameter paths that a leading `A.length === B.length` ties, drawn with one length.
  lengthTies: [Path, Path][]
  discardSites: {site: number; cause: DiscardCause}[]
}

export type CauseClass = 'subnormal' | 'drift' | 'large' | 'ordinary'
export const CAUSES: CauseClass[] = ['subnormal', 'drift', 'large', 'ordinary']

// The first input of an entry that raised a site to a level: its index, the input digest, the margin when known, the cause
// class and the encoded arguments.
export type FirstInput = {index: number; digest: number; margin: number | null; cause: CauseClass; args: string}

// Per site, over one entry's in-domain calls. A call is in the domain when no discard site failed, no imported assert
// failed (R1), it stayed within the step budget and it did not throw.
export type SiteCounts = {
  site: number
  touched: number // calls that reached the site, discarded calls included
  reached: number // in-domain calls that reached the site: N
  level2: number // in-domain calls at level >= 2
  level3: number // in-domain calls at level >= 3
  byCause: Record<CauseClass, number> // level >= 3, by the cause of the input
  first2: FirstInput | null
  first3: FirstInput | null
  firstReach: FirstInput | null
}

export type EntryLine = {
  type: 'entry'
  entry: number // ordinal
  drawn: number
  inDomain: number
  discards: Record<DiscardCause | 'R1', number>
  overBudget: number
  threw: number
  firstThrow: string | null
  sites: SiteCounts[]
}

export type VerifyItem = {item: number; entry: number; index: number; digest: number; site: number}

// One verification item: the regenerated input through the instrumented copy, then through the uninstrumented copy with
// console.assert recording the failing lines of the analyzed file (and, for each, the line of the call one frame out).
export type VerifiedLine = {
  type: 'verified'
  item: number
  digestMatches: boolean
  discarded: DiscardCause | null
  overBudget: boolean
  threw: string | null
  level: number
  importedFailed: boolean
  finite: boolean
  fired: {line: number; callerLine: number | null}[]
}

export type HeartbeatLine = {type: 'heartbeat'}
export type LoadedLine = {type: 'loaded'}
export type LoadFailedLine = {type: 'load-failed'; error: string}
export type DoneLine = {type: 'done'; maxRssKb: number}
// The child's own RSS passed the job's limit after a call, e.g. project code retaining 64 MB per call; the child exits after it.
export type RssLine = {type: 'rss'; rssKb: number}
// The child's own code threw outside a project call, e.g. after project code replaced a global the child uses; the child exits after it.
export type CrashedLine = {type: 'crashed'; error: string}
export type ChildLine = HeartbeatLine | LoadedLine | LoadFailedLine | EntryLine | VerifiedLine | DoneLine | RssLine | CrashedLine

export type SweepJob = {
  mode: 'run' | 'verify'
  instrumented: string // absolute path of the instrumented copy
  source: string // absolute path of the uninstrumented copy
  sites: Site[]
  entries: SweepEntry[] // only the entries this child runs
  settings: LatticeSettings
  stepBudget: number
  heartbeatEvery: number
  rssKb: number // the RSS limit the child checks after its calls; the parent's ps poller enforces the same limit from outside
  items: VerifyItem[] // verify mode only
}
