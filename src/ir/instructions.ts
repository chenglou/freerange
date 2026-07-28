import type {BlockID, FunctionID, ModuleBindingID, SiteID, ValueID} from './ids.ts'
import type {UnsupportedReason} from './program.ts'

type InstructionBase = {
  result: ValueID
  site: SiteID
}

export type ComparisonOperator = 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'equal' | 'notEqual'
export type ArithmeticOperator = 'add' | 'subtract' | 'multiply' | 'divide' | 'remainder'

type ObjectPropertyIR = {
  name: string
  value: ValueID
}

export type InstructionIR =
  | (InstructionBase & {kind: 'constant'; value: number})
  | (InstructionBase & {kind: 'nullishConstant'; sentinel: 'null' | 'undefined'})
  // A value the analysis carries without claims — a string literal, a template string.
  | (InstructionBase & {kind: 'opaqueConstant'; content?: string})
  // A boolean the analysis knows nothing about — comparing two opaque values.
  | (InstructionBase & {kind: 'unknownBoolean'})
  | (InstructionBase & {kind: 'arrayLiteral'; elements: ValueID[]; form: 'tuple' | 'array'})
  | (InstructionBase & {kind: 'arrayLength'; array: ValueID})
  // An element read. Bare reads honestly carry possible undefined regardless of the
  // project's TypeScript options; bareUnchecked marks the case where those options hide
  // undefined and Freerange should explain a later kind mismatch. Asserted reads create
  // an assumption when bounds are unknown.
  | (InstructionBase & {
      kind: 'arrayIndex'
      array: ValueID
      index: ValueID
      mode: 'bare' | 'bareUnchecked' | 'asserted'
    })
  // `value === null` and friends. sentinel 'nullish' is the loose form (== null, and the
  // ?? test), which covers both sentinels; negated flips the polarity (!==, !=).
  // route.type === 'lightbox': consumes the tagged-union value directly (the tag read
  // never becomes a property instruction), and branch refinement keeps only the matching
  // variants on the true side, the rest on the false side.
  | (InstructionBase & {kind: 'tagCheck'; union: ValueID; tagValue: string | boolean; negated: boolean})
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
  // Math.ceil / Math.round / Math.trunc / Math.sqrt. Kept apart from 'floor', which
  // additionally lives in the requirement expression language; these can join it when a
  // rounded divisor shows the need.
  | (InstructionBase & {kind: 'mathUnary'; operator: 'ceil' | 'round' | 'trunc' | 'sqrt'; value: ValueID})
  // A string's .length is a nonnegative integer. Carrying the string lets repeated reads
  // of the same immutable value keep their identity.
  | (InstructionBase & {kind: 'stringLength'; value: ValueID})
  // parseFloat / parseInt / Number(x): an honest NaN source — any number including NaN
  // and the infinities; parseInt's result is an integer when it is a number at all.
  // Arguments are lowered by the caller and not carried.
  | (InstructionBase & {kind: 'parsedNumber'; integer: boolean})
  // Number.isInteger(x) / Number.isFinite(x) / Number.isNaN(x): a boolean over one number
  // operand, with branch refinement like nullishCheck — the true branch of isInteger knows
  // the value is an integer (and finite, and not NaN), the false branch of isFinite prunes
  // when the value was already provably finite, and the false branch of isNaN launders a
  // possibly-NaN value clean.
  | (InstructionBase & {
      kind: 'numberCheck'
      predicate: 'integer' | 'finite' | 'nan'
      value: ValueID
      // Generated entry checks establish function-boundary contracts but are not body reads.
      purpose?: 'finiteInput'
    })
  // Boolean negation, from `!x` on a boolean operand.
  | (InstructionBase & {kind: 'not'; value: ValueID})
  // Static requirements narrow the function body and become caller preconditions.
  // Interior assertions are observational; their indexes address FunctionIR.assertions.
  | (InstructionBase & {kind: 'staticRequire'; value: ValueID; purpose?: 'finiteInput'})
  | (InstructionBase & {kind: 'staticAssert'; value: ValueID; assertion: number})
  | (InstructionBase & {kind: 'minimum' | 'maximum'; values: ValueID[]})
  | (InstructionBase & {
      kind: 'call'
      function: FunctionID
      arguments: ValueID[]
      // A const-bound function is unavailable until its top-level initializer runs.
      binding: ModuleBindingID | null
    })
  // tag is set when the literal's contextual type is a tagged union and the literal names
  // its tag with a string literal — the engine then builds a single-variant union, so
  // branches building different variants join per tag instead of dropping properties.
  | (InstructionBase & {kind: 'object'; properties: ObjectPropertyIR[]; tag?: {property: string}})
  | (InstructionBase & {kind: 'property'; object: ValueID; property: string})

// Every ValueID operand an instruction reads, enumerated next to the type so a new kind or
// a new operand field on an existing kind changes in the same file and the same diff view.
// Completeness is soundness-bearing for report assumption trimming: an unlisted operand
// could make the report claim that a parameter property was never read.
export function forEachOperand(instruction: InstructionIR, visit: (operand: ValueID) => void): void {
  switch (instruction.kind) {
    case 'constant':
    case 'nullishConstant':
    case 'opaqueConstant':
    case 'unknownBoolean':
    case 'parsedNumber':
    case 'booleanConstant':
    case 'moduleRead':
    case 'moduleHavoc':
    case 'platformValue':
      return
    case 'stringLength': visit(instruction.value); return
    case 'moduleWrite': visit(instruction.value); return
    case 'binary': visit(instruction.left); visit(instruction.right); return
    case 'compare': visit(instruction.left); visit(instruction.right); return
    case 'floor':
    case 'absolute':
    case 'mathUnary':
    case 'numberCheck':
    case 'not':
    case 'staticRequire':
    case 'staticAssert': visit(instruction.value); return
    case 'nullishCheck': visit(instruction.value); return
    case 'tagCheck': visit(instruction.union); return
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
  // A throw statement: the path ends and contributes nothing — no return value, no stop,
  // no successor. Sound without modeling exceptions because the subset has no catch: a
  // thrown path cannot be observed by any analyzed continuation, in this function or any
  // caller. The thrown expression is deliberately NOT lowered (nothing after it runs);
  // the acceptance pre-pass still vets it for any/assertions, and the eval scan is
  // file-wide.
  | {kind: 'thrown'; site: SiteID}
