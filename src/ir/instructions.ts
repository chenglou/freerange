import type {BlockID, FunctionID, SiteID, ValueID} from './ids.ts'

type InstructionBase = {
  result: ValueID
  site: SiteID
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
  | {kind: 'return'; value: ValueID | null; site: SiteID}
  | {kind: 'jump'; target: EdgeIR; site: SiteID}
  | {kind: 'branch'; condition: ValueID; whenTrue: EdgeIR; whenFalse: EdgeIR; site: SiteID}
