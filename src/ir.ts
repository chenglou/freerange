export type ValueID = number
export type BlockID = number
export type FunctionID = number

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
  type: ValueTypeIR
  span: SourceSpan
}

export type ValueTypeIR =
  | {kind: 'number'}
  | {kind: 'object'; properties: string[]}

type InstructionBase = {
  result: ValueID
  span: SourceSpan
}

export type ComparisonOperator = 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'equal'

export type ObjectPropertyIR = {
  name: string
  value: ValueID
}

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
  | (InstructionBase & {kind: 'call'; function: FunctionID; arguments: ValueID[]})
  | (InstructionBase & {kind: 'object'; properties: ObjectPropertyIR[]})
  | (InstructionBase & {kind: 'property'; object: ValueID; property: string})
  | (InstructionBase & {kind: 'store'; object: ValueID; property: string; value: ValueID})

export type TerminatorIR =
  | {kind: 'return'; value: ValueID | null; span: SourceSpan}
  | {kind: 'branch'; condition: ValueID; whenTrue: BlockID; whenFalse: BlockID; span: SourceSpan}

export type BlockIR = {
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
