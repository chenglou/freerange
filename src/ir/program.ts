import type {BlockID, SiteID, ValueID} from './ids.ts'
import type {InstructionIR, TerminatorIR} from './instructions.ts'

type ParameterIR = {
  value: ValueID
  name: string
  type: ValueTypeIR
}

export type ValueTypeIR =
  | {kind: 'number'}
  | {kind: 'object'; properties: string[]}

// UTF-16 offsets into the analyzed source, from ts.Node.getStart/getEnd. Line and column
// are computed only at message-formatting time. Spans may repeat across sites (the constant 1
// and the add that `count++` lowers to share a span); identity is the SiteID, never the span.
export type SourceSpan = {
  start: number
  end: number
}

export type BlockIR = {
  // Non-null exactly on loop headers. The site spans the whole loop statement, so a
  // non-converging analysis is reported on the loop, not on a back-edge jump.
  loopHeader: SiteID | null
  parameters: ValueID[]
  instructions: InstructionIR[]
  terminator: TerminatorIR
}

export type FunctionIR = {
  kind: 'lowered'
  name: string
  parameters: ParameterIR[]
  entry: BlockID
  blocks: BlockIR[]
}

// Why one function's lowering stopped. Code branches only on `kind`; the string fields are
// display data (identifier text, operator text, checker.typeToString results captured while
// the checker is alive). Prose is composed only in src/report; nothing may branch on it.
export type UnsupportedReason =
  // An identifier with no lowered binding: module-level state, globals, captured outer
  // locals. E.g. reading a module-level `let` inside a function.
  | {kind: 'unknownIdentifier'; name: string}
  // The checker returned no symbol for a node that needs one (identifier expressions,
  // shorthand object properties). Believed unreachable after the whole-file type gate, but
  // user source is a shaky boundary, so the case is recorded rather than crashed on.
  | {kind: 'missingSymbol'}
  | {kind: 'functionWithoutSignature'}
  // Overload signatures and ambient declarations have no body to lower.
  | {kind: 'functionWithoutBody'}
  | {kind: 'destructuredParameter'}
  | {kind: 'multipleObjectParameters'}
  | {kind: 'parameterType'; typeText: string}
  | {kind: 'objectParameterProperty'; property: string; typeText: string}
  | {kind: 'objectParameterWithoutNumericProperties'}
  // A non-void function has a path that falls off the end without returning.
  | {kind: 'missingReturn'}
  // Spread, method, or accessor in an object literal.
  | {kind: 'objectPropertyForm'}
  | {kind: 'computedPropertyName'}
  // e.g. '%', '&&', '**', '??'
  | {kind: 'binaryOperator'; operator: string}
  // Callee is neither a top-level function in this file nor supported Math. `callee` is the
  // callee's source text, e.g. 'requestAnimationFrame' or a shadowed 'Math.max'.
  | {kind: 'call'; callee: string}
  // A position that must hold a number (operand, supported Math argument) typed otherwise,
  // e.g. the left side of `events.keydown == null` with type KeyboardEvent | null. The site
  // points at the exact operand, so no role tag is needed.
  | {kind: 'nonNumberOperand'; typeText: string}
  // A branch condition whose type is not boolean, e.g. `if (width)` truthiness on a number.
  | {kind: 'nonBooleanCondition'; typeText: string}
  // A call resolved through a top-level function binding while a direct eval call exists
  // somewhere in the file. The eval string can reassign the function binding at runtime —
  // TypeScript's static no-reassignment check does not see into it — so the call target
  // cannot be trusted.
  | {kind: 'directEvalMayReassignFunctions'}
  // A value position whose type mixes kinds or is outside numbers, booleans, and objects —
  // e.g. a ternary with one number arm and one boolean arm, or a string return type. Left
  // ungated, mixed kinds would meet at a join deep in the engine instead of stopping here.
  | {kind: 'valueType'; typeText: string}
  // A type assertion that changes the value kind, e.g. `true as unknown as number` or `x!`
  // on a nullable type. The asserted type no longer describes the runtime value, and the
  // analysis keys everything to static types.
  | {kind: 'kindChangingAssertion'; fromText: string; toText: string}
  | {kind: 'propertyReadOnNonObject'; typeText: string}
  | {kind: 'statementAfterReturn'}
  | {kind: 'forLoopWithoutCondition'}
  | {kind: 'forLoopWithoutIncrementor'}
  // Destructuring pattern or a declaration without an initializer.
  | {kind: 'variableDeclarationShape'}
  // Catch-alls carry the ts.SyntaxKind name, e.g. 'FalseKeyword', 'WhileStatement'.
  | {kind: 'expressionForm'; syntax: string}
  | {kind: 'statementForm'; syntax: string}

// A function whose lowering stopped. The half-built CFG is discarded wholesale so nothing
// downstream can mistake this record for analyzable IR. Sites already pushed while lowering
// the discarded blocks stay in ProgramIR.sites; do not roll the array back — that would
// invalidate the SiteID recorded here.
export type UnsupportedFunctionIR = {
  kind: 'unsupported'
  name: string
  site: SiteID
  reason: UnsupportedReason
}

export type FunctionLowering = FunctionIR | UnsupportedFunctionIR

// What a function may assume about a module-level binding, decided once by a whole-file
// scan before any lowering. The rule: trust a value only when every possible write to it
// is accounted for. A const collapses into the no-outside-write check, since TypeScript
// already rejects assigning a const anywhere.
export type ModuleBindingCategory =
  // A number or boolean binding that nothing outside the initializer writes. Its
  // initialized value flows into every function, e.g. `const boxesGapX = 24` reads as 24.
  | {kind: 'value'; declaredKind: 'number' | 'boolean'}
  // An object binding that nothing outside the initializer reassigns, e.g.
  // `const events = {keydown: null}`. Its identity could flow into functions while
  // property values reset to unknown at function entry; recorded now so the scan is
  // complete, but reads stop until that flow is implemented.
  | {kind: 'identity'}
  // A number or boolean binding that some function writes, or that a direct eval call
  // anywhere in the file could write. Functions see only the declared kind: some finite
  // number, some boolean.
  | {kind: 'kind'; declaredKind: 'number' | 'boolean'}
  // An imported binding. Single-file analysis knows nothing about the other module.
  | {kind: 'import'}
  // Every other declared type (unions with null, arrays, strings, functions). Reads stop.
  | {kind: 'opaque'}

// One top-level binding visible to every function in the file: a top-level variable
// declarator with an identifier name, or a named import.
export type ModuleBindingIR = {
  name: string
  category: ModuleBindingCategory
}

export type ProgramIR = {
  file: string
  // Offset of each line's first character, copied from ts.SourceFile.getLineStarts(), so
  // locations can be formatted after the TypeScript objects are gone (analyzeSource inputs
  // never exist on disk, so re-reading the file is not an option).
  lineStarts: number[]
  // Indexed by SiteID. Push-only during lowering, immutable afterward.
  sites: SourceSpan[]
  // Still indexed by FunctionID, assigned from declaration order before any body lowers, so
  // call instructions may reference an index that later turns out unsupported.
  functions: FunctionLowering[]
  // Indexed by ModuleBindingID.
  moduleBindings: ModuleBindingIR[]
  // A direct eval call exists somewhere in the file. Consumers must not fall back to a
  // binding's declared kind: the eval string can put a value of any type into any non-const
  // binding, so an unpublished binding is fully untracked, not "some number of unknown value".
  directEval: boolean
  // The synthetic function holding the module's top-level runtime code, evaluated once
  // before any declared function so its results can seed their module slots. Always
  // present; a file without top-level runtime code gets a trivial one. Not part of
  // `functions`, so no call instruction can reference it. When its lowering stops, writes
  // in the never-lowered statements demote the affected bindings' categories directly, so
  // no separate record of the remainder is needed.
  initializer: FunctionIR
}

// 1-based line and column of a site's start offset.
export function siteLocation(program: ProgramIR, site: SiteID): {line: number; column: number} {
  const span = program.sites[site]
  if (span == null) throw new Error(`Unknown site ${site}`)
  const lineStarts = program.lineStarts
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (lineStarts[middle]! <= span.start) low = middle
    else high = middle - 1
  }
  return {line: low + 1, column: span.start - lineStarts[low]! + 1}
}
