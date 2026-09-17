import type {AbstractValue} from '../domain/value.ts'
import type {FunctionRef, ModuleBindingID, SiteID} from '../ir/ids.ts'
import type {FunctionIR, UnsupportedFunctionIR, UnsupportedReason} from '../ir/program.ts'
import type {BoundsAssumption, InferredPrecondition} from '../requirements/model.ts'
import type {SharedState, ValueFact} from './state.ts'

export type RequirementFailure =
  | {kind: 'declared'; site: SiteID; status: 'refuted' | 'unproven'}
  | {kind: 'finiteInput'; site: SiteID; status: 'refuted' | 'unproven'}
  | {kind: 'nonzeroDivisor'; site: SiteID; operation: 'division' | 'remainder'}
  | {kind: 'elementInBounds'; site: SiteID}

// Why one function's evaluation stopped on some path. Code branches only on `kind`; prose
// is composed only in src/report.
export type StopReason =
  | {kind: 'recursion'; callee: FunctionRef}
  // The called function never lowered, or its own evaluation has stops. The callee's report
  // entry carries the next hop or the root cause.
  | {kind: 'calleeStopped'; callee: FunctionRef}
  // An imported call can call back into the caller's own module, or into a module that is
  // still initializing or a function whose own analysis is still running. Each needs a runtime
  // import cycle, which is outside the analyzed scope, so the path stops rather than trusting
  // module state the cycle may have changed.
  | {kind: 'importCycle'; callee: FunctionRef}
  // The imported callee's result rests on a module binding of its own file that its report
  // prints as an assumption: a declared-kind binding, e.g. `assumes: scaleFactor is finite and
  // not NaN`, or a published structure, e.g. `assumes: other modules do not modify gaps or any
  // object or array inside it`. Those assumes lines are computed per file, so the caller could
  // not print them; the path stops instead of publishing a result that silently depends on them.
  | {kind: 'importedModuleState'; callee: FunctionRef; binding: ModuleBindingID}
  // An argument lies outside the declared kind the callee's own analysis seeded the parameter
  // with, e.g. a possibly NaN element in a number[] argument, so the callee's published summary
  // does not describe this call.
  | {kind: 'contractInput'; callee: FunctionRef; parameter: number}
  // The imported call can't be followed: the callee's file has TypeScript errors, lowering it
  // would pass maximumImportedModules, or checking where its calls lead couldn't finish (see
  // CallClosureAnswer). The callee's file may never lower, so the reason carries its name.
  | {kind: 'importUnavailable'; calleeName: string; why: 'typeScriptErrors' | 'moduleLimit' | 'callClosure'}
  // A loop header's abstract state kept changing through the fixed-point backstop. No
  // result computed before convergence is published as a guarantee.
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
  // A value reached an operation that needs a concrete runtime kind, but the analysis
  // carries it without one. This includes opaque values and narrowing shapes the engine
  // does not model. The path stops; the rest of the function and file report normally.
  | {kind: 'kindMismatch'}
  // A bare array read (arr[i]) remained possibly undefined and reached an operation that
  // needs a present value. This can be diagnostic-clean when noUncheckedIndexedAccess is
  // disabled, so it has its own actionable reason instead of looking like unsupported
  // TypeScript narrowing.
  | {kind: 'possiblyMissingElement'}
  // A written or inferred requirement failed. A direct failure has no callee; propagation
  // through a same-file call names the callee visible at that call while retaining the
  // original requirement site.
  | {
      kind: 'requirementFailure'
      failure: RequirementFailure
      callee: FunctionRef | null
    }

export type Stop = {
  site: SiteID
  reason: StopReason
}

// The result for one interior console.assert. A blocked result means its function did not
// finish analysis on every path without a site-specific assumption.
export type AssertionVerdict = {
  site: SiteID
  text: string
  verdict: 'proven' | 'refuted' | 'unproven' | 'dead' | 'blocked'
}

// One evaluation can hold BOTH a normal outcome and stops: in
// `if (flag > 0) return 10; unsupportedThing()` the true branch returns 10 while the other
// path stops. Empty `stops` means every path completed.
export type FunctionEvaluation = {
  normal: {returnValue: AbstractValue; sharedState: SharedState; valueFacts: ValueFact[]} | null
  preconditions: InferredPrecondition[]
  boundsAssumptions: BoundsAssumption[]
  assertions: AssertionVerdict[]
  stops: Stop[]
}

// The result of a fully completed evaluation: the only data that may reach contract
// consumers (a caller adopting callee state, the report's requires/ensures lines).
// completedEvaluation below is the single way to obtain it, and refuses whenever any stop
// exists, so partial results structurally cannot flow into those consumers.
export type CompletedEvaluation = {
  returnValue: AbstractValue
  sharedState: SharedState
  valueFacts: ValueFact[]
  preconditions: InferredPrecondition[]
  boundsAssumptions: BoundsAssumption[]
}

export function completedEvaluation(evaluation: FunctionEvaluation): CompletedEvaluation | null {
  if (evaluation.stops.length > 0 || evaluation.normal == null) return null
  return {
    returnValue: evaluation.normal.returnValue,
    sharedState: evaluation.normal.sharedState,
    valueFacts: evaluation.normal.valueFacts,
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
      // False when every path throws: the function is fully analyzed, but a call to it never
      // returns, so a caller applying its summary ends the path like an inline throw.
      returnsNormally: boolean
      assertions: AssertionVerdict[]
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
      assertions: AssertionVerdict[]
    }
  // The function did not lower. The variant carries a reference (not a copy) to its
  // lowering record, so a mismatched pair is unrepresentable and the report needs no
  // defensive re-checks.
  | {kind: 'notLowered'; lowering: UnsupportedFunctionIR}

export type LoweredFunctionAnalysis = Exclude<FunctionAnalysis, {kind: 'notLowered'}>

export type ProgramAnalysis = {
  // Dense, index-aligned with ProgramIR.functions.
  functions: FunctionAnalysis[]
  // The synthetic module initializer's own analysis. Reports print it only when it stopped.
  initializer: LoweredFunctionAnalysis
  // Indexed by ModuleBindingID: the exact value functions may trust, or null when only the
  // binding's declared kind is known. Reports use this to print assumes lines for reads of
  // assumed-finite module numbers.
  moduleValues: Array<AbstractValue | null>
}
