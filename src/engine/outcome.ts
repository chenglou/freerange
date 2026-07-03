import type {AbstractValue} from '../domain/value.ts'
import type {AbstractHeap} from '../heap/model.ts'
import type {FunctionID, ModuleBindingID, SiteID} from '../ir/ids.ts'
import type {UnsupportedReason} from '../ir/program.ts'
import type {InferredPrecondition} from '../requirements/model.ts'
import type {SharedState} from './state.ts'

// Why one function's evaluation stopped on some path. Code branches only on `kind`; prose
// is composed only in src/report.
export type StopReason =
  | {kind: 'recursion'; callee: FunctionID}
  // The called function never lowered, or its own evaluation has stops. The callee's report
  // entry carries the next hop or the root cause.
  | {kind: 'calleeStopped'; callee: FunctionID}
  // A divisor may be zero and no requirement over the caller-visible parameters can name it
  // (e.g. dividing by a property read). Revisit when requirement expressions support
  // property paths with mutation-awareness.
  | {kind: 'divisorUnknown'}
  | {kind: 'loopLimit'; updates: number}
  // A loop whose exit edge is never taken on any analyzed path, e.g.
  // `for (let index = 0; true; index += 1) {}`. The fixed point converged with every path
  // still inside the loop, so the function has no reachable return.
  | {kind: 'nonExitingLoop'}
  // A stop terminator was reached: the module initializer's lowering met unsupported code
  // here and kept everything before it.
  | {kind: 'unsupportedCode'; reason: UnsupportedReason}
  // A moduleRead found nothing usable in the slot. Report prose comes from the binding's
  // category: imported, an untracked object, an unsupported type, or read before its
  // initialization.
  | {kind: 'moduleRead'; binding: ModuleBindingID}

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
}

export function completedEvaluation(evaluation: FunctionEvaluation): CompletedEvaluation | null {
  if (evaluation.stops.length > 0 || evaluation.normal == null) return null
  return {
    returnValue: evaluation.normal.returnValue,
    sharedState: evaluation.normal.sharedState,
    preconditions: evaluation.preconditions,
  }
}

export type FunctionAnalysis =
  | {
      kind: 'analyzed'
      preconditions: InferredPrecondition[]
      returnValue: AbstractValue
      sharedState: SharedState
    }
  // Some path stopped. The evidence fields share no names with the contract fields above,
  // so report code cannot consume them interchangeably: observedReturn describes only the
  // paths that completed, and observedNeeds the requirements inferred on the path prefixes
  // the analysis did evaluate (a sibling path may contribute one after another path stopped).
  | {
      kind: 'partial'
      stops: [Stop, ...Stop[]]
      observedReturn: {value: AbstractValue; heap: AbstractHeap} | null
      observedNeeds: InferredPrecondition[]
    }
  // The function did not lower. Site and reason live on ProgramIR.functions at the same
  // index (single source of truth; createReport receives both structures).
  | {kind: 'notLowered'}

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
