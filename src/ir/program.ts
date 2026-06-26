import type {BlockID, ValueID} from './ids.ts'
import type {InstructionIR, TerminatorIR} from './instructions.ts'

type ParameterIR = {
  value: ValueID
  name: string
  type: ValueTypeIR
}

export type ValueTypeIR =
  | {kind: 'number'}
  | {kind: 'object'; properties: string[]}

export type BlockIR = {
  loopHeader: boolean
  parameters: ValueID[]
  instructions: InstructionIR[]
  terminator: TerminatorIR
}

export type FunctionIR = {
  name: string
  parameters: ParameterIR[]
  entry: BlockID
  blocks: BlockIR[]
}

export type ProgramIR = {
  file: string
  functions: FunctionIR[]
}
