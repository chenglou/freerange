import type {AbstractValue} from '../domain/value.ts'
import type {FunctionID, ModuleBindingID, SiteID} from '../ir/ids.ts'
import type {FunctionIR, UnsupportedFunctionIR, UnsupportedReason} from '../ir/program.ts'
import type {BoundsAssumption, InferredPrecondition} from '../requirements/model.ts'
import type {SharedState} from './state.ts'

// Why one function's evaluation stopped on some path. Code branches only on `kind`; prose
// is composed only in src/report.
export type StopReason =
  | {kind: 'recursion'; callee: FunctionID}
  // The called function never lowered, or its own evaluation has stops. The callee's report
  // entry carries the next hop or the root cause.
  | {kind: 'calleeStopped'; callee: FunctionID}
  // A divisor may be zero and no requirement over the caller-visible parameters can name
  // it (e.g. dividing by a platform read).
  | {kind: 'loopLimit'; updates: number}
  // A loop whose exit edge is never taken on any analyzed path, e.g.
  // `for (let index = 0; true; index += 1) {}`. The fixed point converged with every path
  // still inside the loop, so the function has no reachable return.
  | {kind: 'nonExitingLoop'}
  // A stop terminator was reached. Only the file-wide rejections (eval, type-check
  // suppression) produce one today, as the whole-file initializer replacement.
  | {kind: 'unsupportedCode'; reason: UnsupportedReason}
  // A moduleRead found nothing usable in the slot. Report prose comes from the binding's
  // category: imported, an untracked object, an unsupported type, or read before its
  // initialization.
  | {kind: 'moduleRead'; binding: ModuleBindingID}
  // A value reached an operation whose kind the analyzer's narrowing did not establish,
  // though the checker's did — e.g. a guard shape the analysis does not model. The path
  // stops; the rest of the function and file report normally.
  | {kind: 'unmodeledNarrowing'}
  // An asserted element read (arr[i]!) whose index is provably outside the array — there
  // is no element the assertion could produce. An empty array is the special case where
  // every read qualifies.
  | {kind: 'outOfBoundsRead'}


export type Stop = {
  site: SiteID
  reason: StopReason
}

// One evaluation can hold BOTH a normal outcome and stops: in
// `if (flag > 0) return 10; unsupportedThing()` the true branch returns 10 while the other
// path stops. Empty `stops` means every path completed.
export type FunctionEvaluation = {
  normal: {returnValue: AbstractValue; sharedState: SharedState} | null
  preconditions: InferredPrecondition[]
  boundsAssumptions: BoundsAssumption[]
  stops: Stop[]
}

// The result of a fully completed evaluation: the only data that may reach contract
// consumers (a caller adopting callee state, the report's requires/ensures lines).
// completedEvaluation below is the single way to obtain it, and refuses whenever any stop
// exists, so partial results structurally cannot flow into those consumers.
export type CompletedEvaluation = {
  returnValue: AbstractValue
  sharedState: SharedState
  preconditions: InferredPrecondition[]
  boundsAssumptions: BoundsAssumption[]
}

export function completedEvaluation(evaluation: FunctionEvaluation): CompletedEvaluation | null {
  if (evaluation.stops.length > 0 || evaluation.normal == null) return null
  return {
    returnValue: evaluation.normal.returnValue,
    sharedState: evaluation.normal.sharedState,
    preconditions: evaluation.preconditions,
    boundsAssumptions: evaluation.boundsAssumptions,
  }
}

export type FunctionAnalysis =
  | {
      kind: 'analyzed'
      lowering: FunctionIR
      preconditions: InferredPrecondition[]
      boundsAssumptions: BoundsAssumption[]
      returnValue: AbstractValue
      sharedState: SharedState
    }
  // Some path stopped. The evidence fields share no names with the contract fields above,
  // so report code cannot consume them interchangeably: observedReturn describes only the
  // paths that completed, and observedNeeds the requirements inferred on the path prefixes
  // the analysis did evaluate (a sibling path may contribute one after another path stopped).
  | {
      kind: 'partial'
      lowering: FunctionIR
      stops: [Stop, ...Stop[]]
      observedReturn: {value: AbstractValue} | null
      observedNeeds: InferredPrecondition[]
      observedBoundsAssumptions: BoundsAssumption[]
    }
  // The function did not lower. The variant carries a reference (not a copy) to its
  // lowering record, so a mismatched pair is unrepresentable and the report needs no
  // defensive re-checks.
  | {kind: 'notLowered'; lowering: UnsupportedFunctionIR}

export type ProgramAnalysis = {
  // Dense, index-aligned with ProgramIR.functions.
  functions: FunctionAnalysis[]
  // The synthetic module initializer's own analysis. Reports print it only when it stopped.
  initializer: FunctionAnalysis
  // Indexed by ModuleBindingID: the exact value functions may trust, or null when only the
  // binding's declared kind is known. Reports use this to print assumes lines for reads of
  // assumed-finite module numbers.
  moduleValues: Array<AbstractValue | null>
}
