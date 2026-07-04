import type * as ts from 'typescript'
import {finiteInputNumber, unknownNumber} from '../domain/number.ts'
import {recordValue, unknownBoolean, type AbstractValue} from '../domain/value.ts'
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

  | {kind: 'parameterType'; typeText: string}
  | {kind: 'objectParameterProperty'; property: string; typeText: string}
  | {kind: 'objectParameterWithoutNumericProperties'}
  // A non-void function has a path that falls off the end without returning.
  | {kind: 'missingReturn'}
  // Spread, method, or accessor in an object literal.
  | {kind: 'objectPropertyForm'}
  | {kind: 'computedPropertyName'}
  | {kind: 'spreadOptionalProperty'; property: string}
  // e.g. '%', '&&', '**', '??'
  | {kind: 'binaryOperator'; operator: string}
  // Callee is neither a top-level function in this file nor supported Math. `callee` is the
  // callee's source text, e.g. 'requestAnimationFrame' or a shadowed 'Math.max'.
  | {kind: 'call'; callee: string}
  // A call passing fewer arguments than the callee declares. TypeScript accepts the shorter
  // call when the omitted parameters have default values, e.g. scaled() calling
  // `function scaled(width: number = 5)`, but lowering never reads parameter initializers,
  // so the callee would receive fewer abstract values than it has parameters. The callee
  // itself still lowers and analyzes; only the shorter call stops.
  | {kind: 'callWithFewerArguments'; callee: string}
  // A position that must hold a number (operand, supported Math argument) typed otherwise,
  // e.g. the left side of `events.keydown == null` with type KeyboardEvent | null. The site
  // points at the exact operand, so no role tag is needed.
  | {kind: 'nonNumberOperand'; typeText: string}
  // A branch condition whose type is not boolean, e.g. `if (width)` truthiness on a number.
  | {kind: 'nonBooleanCondition'; typeText: string}
  // The acceptance rules (see current-decisions.md): an expression typed `any`, a type
  // assertion written with `as` or angle brackets, or a `var` declaration. Each is a spot
  // where the checker's word — the foundation of every guarantee — is void or the binding
  // model does not apply.
  | {kind: 'anyTyped'}
  | {kind: 'typeAssertion'; typeText: string}
  | {kind: 'varDeclaration'}
  // The identifier `eval` appears somewhere in the file. An eval string can rewrite any
  // binding in the file at runtime, so every function in the file carries this reason —
  // rejecting only the function containing the call would not protect the others' reports.
  | {kind: 'evalInFile'}
  // A `@ts-ignore`, `@ts-expect-error`, or `@ts-nocheck` comment appears somewhere in the
  // file. The directive turns off type checking, and every guarantee is built on the
  // checker's word, so the whole file is rejected like the eval case above.
  | {kind: 'typeCheckSuppressed'}
  // A value position whose type mixes kinds or is outside numbers, booleans, and objects —
  // e.g. a ternary with one number arm and one boolean arm, a string return type, or a
  // variable declared `let u: unknown` and reassigned across kinds. Left ungated, mixed
  // kinds would meet at a join deep in the engine instead of stopping here.
  | {kind: 'valueType'; typeText: string}
  // A non-null assertion that changes the value kind, e.g. `x!` with `x: number | null`.
  // Past the assertion, the static type stops describing the value the analysis models.
  // (`as` and angle-bracket assertions are rejected earlier by the acceptance check, so
  // only `!` reaches this reason.)
  | {kind: 'kindChangingAssertion'; fromText: string; toText: string}
  | {kind: 'propertyReadOnNonObject'; typeText: string}
  | {kind: 'statementAfterReturn'}
  // An assignment used as a value inside a larger expression, e.g. `cond ? (x = 1) : 2` or
  // `a = b = 5`. Assignments lower only in statement position; write it as its own
  // statement.
  | {kind: 'assignmentInValuePosition'}
  // A write into an object, e.g. `config.pos = 1` or `count.total += n`. Values are
  // immutable after construction (owner-locked): update state by rebinding a variable to a
  // fresh object, e.g. `config = {...config, pos: 1}`.
  | {kind: 'propertyWrite'}
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

// What a binding's declared type promises in each value position: a number, a boolean, or
// a record with a fixed property shape (shapes nest — module state is a tree of records).
// The promise is an assumption, not a guarantee: TypeScript accepts an `any`-typed value in
// any write position, so the report prints a condition for every read that rests on one.
export type DeclaredKind =
  | {kind: 'number'}
  | {kind: 'boolean'}
  | {kind: 'record'; properties: Array<{name: string; declared: DeclaredKind}>}

// What a function may assume about a module-level binding, decided once by a whole-file
// scan before any lowering. The rule: trust a value only when every possible write to it
// is accounted for. A const collapses into the no-outside-write check, since TypeScript
// already rejects assigning a const anywhere.
export type ModuleBindingCategory =
  // A binding of a representable declared kind that nothing outside the initializer
  // writes. Its initialized value flows into every function, e.g. `const boxesGapX = 24`
  // reads as 24 and `const gaps = {small: 4, large: 24}` reads as that exact record.
  | {kind: 'value'; declaredKind: DeclaredKind}
  // A binding of a representable declared kind that some function writes. Functions see
  // only the declared kind — some finite number, some boolean, some record of the declared
  // shape — and the report prints that as an assumption.
  | {kind: 'kind'; declaredKind: DeclaredKind}
  // An imported binding. Single-file analysis knows nothing about the other module.
  | {kind: 'import'}
  // Every other declared type (unions with null, arrays, strings, functions, records with
  // optional or unrepresentable properties). Reads stop.
  | {kind: 'opaque'}

// The declared kind a binding contributes when its exact value is unpublished — the single
// definition of the seeding rule, consumed by the engine's slot seeding, the havoc arm,
// and the report's assumption lines, so they cannot drift apart.
export function declaredKindOf(category: ModuleBindingCategory): DeclaredKind | null {
  switch (category.kind) {
    case 'value':
    case 'kind':
      return category.declaredKind
    case 'import':
    case 'opaque':
      return null
  }
}

// The abstract value a declared kind seeds at function entry: any finite number, any
// boolean, or a record of the declared shape with each leaf seeded the same way. The
// finite-non-NaN part is an ASSUMPTION — every function whose result rests on such a read
// prints an assumes line, and that machinery is what makes this value honest. Code without
// the assumes plumbing must use coveringKindValue below instead.
export function declaredKindValue(declared: DeclaredKind): AbstractValue {
  switch (declared.kind) {
    case 'number': return finiteInputNumber()
    case 'boolean': return unknownBoolean()
    case 'record': return recordValue(declared.properties.map(property => ({
      name: property.name,
      value: declaredKindValue(property.declared),
    })))
  }
}

// The truly covering value of a declared kind: any number INCLUDING NaN and infinities.
// This is what a havocked slot resets to — a skipped statement can put NaN in a number
// binding (e.g. `scale = Number.parseFloat(text)`), and later top-level statements compute
// published values from the slot with no assumes line to carry a finiteness condition, so
// the reset value must cover everything the skipped code could have produced.
export function coveringKindValue(declared: DeclaredKind): AbstractValue {
  switch (declared.kind) {
    case 'number': return unknownNumber()
    case 'boolean': return unknownBoolean()
    case 'record': return recordValue(declared.properties.map(property => ({
      name: property.name,
      value: coveringKindValue(property.declared),
    })))
  }
}

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
  // The synthetic function holding the module's top-level runtime code, evaluated once
  // before any declared function so its results can seed their module slots. Always
  // present; a file without top-level runtime code gets a trivial one. Not part of
  // `functions`, so no call instruction can reference it. When its lowering stops, writes
  // in the never-lowered statements demote the affected bindings' categories directly, so
  // no separate record of the remainder is needed.
  initializer: FunctionIR
  // Top-level statements the initializer's lowering skipped instead of stopping at.
  initializerSkips: InitializerSkip[]
}

// The synthetic initializer's display and IR name, shared by its two producers and read
// back by the report, so the strings cannot drift apart.
export const moduleInitializerName = 'module initialization'

// A top-level statement the initializer's lowering skipped, with the construct that made it
// unsupported. The report lists these on the module initialization entry.
export type InitializerSkip = {site: SiteID; reason: UnsupportedReason}

// The span an AST node covers, for pushing into ProgramIR.sites.
export function nodeSpan(sourceFile: ts.SourceFile, node: ts.Node): SourceSpan {
  return {start: node.getStart(sourceFile), end: node.getEnd()}
}

// A site rendered as file:line:column, the form every report line uses.
export function formatSite(program: ProgramIR, site: SiteID): string {
  const {line, column} = siteLocation(program, site)
  return `${program.file}:${line}:${column}`
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
