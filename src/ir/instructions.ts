import type {BlockID, FunctionID, ModuleBindingID, SiteID, ValueID} from './ids.ts'
import type {UnsupportedReason} from './program.ts'

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
  | (InstructionBase & {kind: 'booleanConstant'; value: boolean})
  // Read a module binding's slot. Evaluates to the slot's current value; stops the path
  // when the slot holds nothing usable (uninitialized, imported, or an untracked kind).
  | (InstructionBase & {kind: 'moduleRead'; binding: ModuleBindingID})
  // Assign a module binding's slot. A binding is one storage location, so the write
  // replaces the slot's value. The instruction's result is the assigned value, like store.
  | (InstructionBase & {kind: 'moduleWrite'; binding: ModuleBindingID; value: ValueID})
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
  // Lowering met unsupported code here. The instructions already emitted describe exactly
  // the operations that run before the unsupported one (lowering emits in evaluation
  // order), so the engine evaluates them and records a stop on reaching this terminator.
  // Only the module initializer's lowering emits this today; ordinary functions still
  // discard their whole body when lowering stops.
  | {kind: 'stop'; site: SiteID; reason: UnsupportedReason}
