export type ValueID = number
export type BlockID = number

export type SourceSpan = {
  file: string
  start: number
  end: number
  line: number
  column: number
}

export type ParameterIR = {
  value: ValueID
  name: string
  span: SourceSpan
}

type InstructionBase = {
  result: ValueID
  span: SourceSpan
}

export type ComparisonOperator = 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'equal'

export type InstructionIR =
  | (InstructionBase & {kind: 'constant'; value: number})
  | (InstructionBase & {
      kind: 'binary'
      operator: 'add' | 'subtract' | 'multiply' | 'divide'
      left: ValueID
      right: ValueID
    })
  | (InstructionBase & {kind: 'compare'; operator: ComparisonOperator; left: ValueID; right: ValueID})
  | (InstructionBase & {kind: 'floor'; value: ValueID})
  | (InstructionBase & {kind: 'minimum' | 'maximum'; values: ValueID[]})
  | (InstructionBase & {kind: 'call'; functionName: string; arguments: ValueID[]})

export type TerminatorIR =
  | {kind: 'return'; value: ValueID; span: SourceSpan}
  | {kind: 'branch'; condition: ValueID; whenTrue: BlockID; whenFalse: BlockID; span: SourceSpan}

export type BlockIR = {
  id: BlockID
  instructions: InstructionIR[]
  terminator: TerminatorIR
}

export type FunctionIR = {
  name: string
  parameters: ParameterIR[]
  entry: BlockID
  blocks: BlockIR[]
  span: SourceSpan
}

export type ProgramIR = {
  file: string
  functions: FunctionIR[]
}
