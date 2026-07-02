import type {AbstractValue} from '../domain/value.ts'
import type {FunctionID, SiteID} from '../ir/ids.ts'
import type {ValueTypeIR} from '../ir/program.ts'
import type {InferredPrecondition} from '../requirements/model.ts'
import type {SharedState} from './state.ts'

export type FunctionAnalysis =
  | {
      kind: 'analyzed'
      name: string
      parameters: Array<{name: string; type: ValueTypeIR}>
      preconditions: InferredPrecondition[]
      returnValue: AbstractValue
      sharedState: SharedState
    }
  // The function did not lower. Site and reason live on ProgramIR.functions at the same
  // index (single source of truth; createReport receives both structures).
  | {kind: 'notLowered'}
  // The function lowered, but a call in its body reaches — possibly through further calls —
  // a function that did not lower, so the engine never ran it. `site` is that call in this
  // function's own body; `callee` is the called function, whose own entry carries the next
  // hop or the root reason. A later change replaces this variant with partial evaluation up
  // to the call; do not build on it.
  | {kind: 'blockedByCallee'; site: SiteID; callee: FunctionID}

export type ProgramAnalysis = {
  // Dense, index-aligned with ProgramIR.functions.
  functions: FunctionAnalysis[]
}

export type CompleteFunctionEvaluation = {
  returnValue: AbstractValue
  sharedState: SharedState
  preconditions: InferredPrecondition[]
}
