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
