export type ValueID = number
export type BlockID = number
export type FunctionID = number

type ParameterIR = {
  value: ValueID
  name: string
  type: ValueTypeIR
}

export type ValueTypeIR =
  | {kind: 'number'}
  | {kind: 'object'; properties: string[]}

type InstructionBase = {
  result: ValueID
}

export type ComparisonOperator = 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'equal'
export type ArithmeticOperator = 'add' | 'subtract' | 'multiply' | 'divide'

type ObjectPropertyIR = {
  name: string
  value: ValueID
}

export type InstructionIR =
  | (InstructionBase & {kind: 'constant'; value: number})
  | (InstructionBase & {
      kind: 'binary'
      operator: ArithmeticOperator
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

export type EdgeIR = {
  block: BlockID
  arguments: ValueID[]
}

export type TerminatorIR =
  | {kind: 'return'; value: ValueID | null}
  | {kind: 'jump'; target: EdgeIR}
  | {kind: 'branch'; condition: ValueID; whenTrue: EdgeIR; whenFalse: EdgeIR}

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
