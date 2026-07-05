import type {BlockID, FunctionID, ModuleBindingID, SiteID, ValueID} from './ids.ts'
import type {UnsupportedReason} from './program.ts'

type InstructionBase = {
  result: ValueID
  site: SiteID
}

export type ComparisonOperator = 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'equal' | 'notEqual'
export type ArithmeticOperator = 'add' | 'subtract' | 'multiply' | 'divide'

type ObjectPropertyIR = {
  name: string
  value: ValueID
}

export type InstructionIR =
  | (InstructionBase & {kind: 'constant'; value: number})
  | (InstructionBase & {kind: 'nullishConstant'; sentinel: 'null' | 'undefined'})
  // A value the analysis carries without claims — a string literal, a template string.
  | (InstructionBase & {kind: 'opaqueConstant'})
  // A boolean the analysis knows nothing about — comparing two opaque values.
  | (InstructionBase & {kind: 'unknownBoolean'})
  | (InstructionBase & {kind: 'arrayLiteral'; elements: ValueID[]; form: 'tuple' | 'array'})
  | (InstructionBase & {kind: 'arrayLength'; array: ValueID})
  // An element read. `asserted` distinguishes arr[i]! (types T; unproven bounds become an
  // assumption line) from bare arr[i] (types T | undefined; the result honestly carries
  // the undefined). provenBounds marks reads a desugaring guarantees in bounds by
  // construction (the for-of counter).
  | (InstructionBase & {kind: 'arrayIndex'; array: ValueID; index: ValueID; asserted: boolean; provenBounds: boolean})
  // `value === null` and friends. sentinel 'nullish' is the loose form (== null, and the
  // ?? test), which covers both sentinels; negated flips the polarity (!==, !=).
  | (InstructionBase & {kind: 'nullishCheck'; value: ValueID; sentinel: 'null' | 'undefined' | 'nullish'; negated: boolean})
  | (InstructionBase & {kind: 'booleanConstant'; value: boolean})
  // Read a module binding's slot. Evaluates to the slot's current value; stops the path
  // when the slot holds nothing usable (uninitialized, imported, or an untracked kind).
  | (InstructionBase & {kind: 'moduleRead'; binding: ModuleBindingID})
  // Assign a module binding's slot. A binding is one storage location, so the write
  // replaces the slot's value. The instruction's result is the assigned value.
  | (InstructionBase & {kind: 'moduleWrite'; binding: ModuleBindingID; value: ValueID})
  // Emitted where the initializer skipped a top-level statement: the binding's slot resets
  // to what its category allows (declared-kind unknown, or uninitialized for untracked
  // bindings), so later top-level statements cannot compute from a stale pre-skip value.
  | (InstructionBase & {kind: 'moduleHavoc'; binding: ModuleBindingID})
  | (InstructionBase & {
      kind: 'binary'
      operator: ArithmeticOperator
      left: ValueID
      right: ValueID
    })
  | (InstructionBase & {kind: 'compare'; operator: ComparisonOperator; left: ValueID; right: ValueID})
  | (InstructionBase & {kind: 'floor'; value: ValueID})
  // A read of a platform catalog entry, e.g. document.documentElement.clientWidth. Each
  // evaluation produces a fresh finite non-NaN value within the recorded range — platform
  // state is mutable, so two reads are never assumed equal.
  | (InstructionBase & {kind: 'platformValue'; lower: number; upper: number; integer: boolean})
  | (InstructionBase & {kind: 'absolute'; value: ValueID})
  // Boolean negation, from `!x` on a boolean operand.
  | (InstructionBase & {kind: 'not'; value: ValueID})
  | (InstructionBase & {kind: 'minimum' | 'maximum'; values: ValueID[]})
  | (InstructionBase & {kind: 'call'; function: FunctionID; arguments: ValueID[]})
  | (InstructionBase & {kind: 'object'; properties: ObjectPropertyIR[]})
  | (InstructionBase & {kind: 'property'; object: ValueID; property: string})

// Every ValueID operand an instruction reads, enumerated next to the type so a new kind or
// a new operand field on an existing kind changes in the same file and the same diff view.
// Completeness is soundness-bearing for collectNonCompareUses: an unlisted operand could
// mark a division as consumed-only-by-comparisons and silently suppress its requirement.
export function forEachOperand(instruction: InstructionIR, visit: (operand: ValueID) => void): void {
  switch (instruction.kind) {
    case 'constant':
    case 'nullishConstant':
    case 'opaqueConstant':
    case 'unknownBoolean':
    case 'booleanConstant':
    case 'moduleRead':
    case 'moduleHavoc':
    case 'platformValue':
      return
    case 'moduleWrite': visit(instruction.value); return
    case 'binary': visit(instruction.left); visit(instruction.right); return
    case 'compare': visit(instruction.left); visit(instruction.right); return
    case 'floor':
    case 'absolute':
    case 'not': visit(instruction.value); return
    case 'nullishCheck': visit(instruction.value); return
    case 'arrayLiteral': for (const element of instruction.elements) visit(element); return
    case 'arrayLength': visit(instruction.array); return
    case 'arrayIndex': visit(instruction.array); visit(instruction.index); return
    case 'minimum':
    case 'maximum': for (const id of instruction.values) visit(id); return
    case 'call': for (const id of instruction.arguments) visit(id); return
    case 'object': for (const property of instruction.properties) visit(property.value); return
    case 'property': visit(instruction.object); return
  }
}

export type EdgeIR = {
  block: BlockID
  arguments: ValueID[]
}

export type TerminatorIR =
  | {kind: 'return'; value: ValueID | null; site: SiteID}
  | {kind: 'jump'; target: EdgeIR; site: SiteID}
  | {kind: 'branch'; condition: ValueID; whenTrue: EdgeIR; whenFalse: EdgeIR; site: SiteID}
  // The evaluation must record a stop here instead of returning. Only the file-wide
  // rejections (eval, type-check suppression) emit one today, as the terminator of the
  // replacement initializer; ordinary functions discard their whole body when lowering
  // stops, and the real initializer skips statements instead.
  | {kind: 'stop'; site: SiteID; reason: UnsupportedReason}
