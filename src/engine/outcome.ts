import type {AbstractValue} from '../domain/value.ts'
import type {ValueTypeIR} from '../ir/program.ts'
import type {InferredPrecondition} from '../requirements/model.ts'
import type {SharedState} from './state.ts'

export type FunctionAnalysis = {
  name: string
  parameters: Array<{name: string; type: ValueTypeIR}>
  preconditions: InferredPrecondition[]
  returnValue: AbstractValue
  sharedState: SharedState
}

export type ProgramAnalysis = {
  file: string
  functions: FunctionAnalysis[]
}

export type CompleteFunctionEvaluation = {
  returnValue: AbstractValue
  sharedState: SharedState
  preconditions: InferredPrecondition[]
}
