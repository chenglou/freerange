import {relative} from 'node:path'
import type * as ts from 'typescript'
import {finiteInputNumber, unknownNumber, type AbstractNumber} from '../domain/number.ts'
import {recordValue, unknownBoolean, type AbstractValue, type TaggedVariant} from '../domain/value.ts'
import type {BlockID, SiteID, ValueID} from './ids.ts'
import type {InstructionIR, TerminatorIR} from './instructions.ts'

export type ParameterIR = {
  value: ValueID
  name: string
  type: DeclaredKind
  site: SiteID
  // Destructured parameters still receive one runtime argument. Direct bindings let
  // reports use the local names the author wrote instead of printing the pattern as an
  // expression. Null distinguishes an ordinary named parameter.
  bindings: Array<{property: string; local: string}> | null
}

// Parameters share the module bindings' declared-kind language: one recursive
// classification covers numbers, booleans, records, nullable wrappers, arrays, tuples,
// and opaque (string) leaves — a label or id in a parameter record no longer rejects the
// function around it.

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

export type StaticAssertionIR = {site: SiteID; text: string}

export type FunctionIR = {
  kind: 'lowered'
  name: string
  assertions: StaticAssertionIR[]
  parameters: ParameterIR[]
  // Property names of the declared return type when it is a record, else null. Reports
  // omit wider runtime properties that a type-checked caller cannot read.
  returnPropertyNames: string[] | null
  entry: BlockID
  blocks: BlockIR[]
}

export type StaticAssertionProblem =
  | 'argumentCount'
  | 'position'
  | 'optionalCall'
  | 'directCheck'
  | 'bindValueFirst'
  | 'functionCall'
  | 'callerRequirement'

// Why one function's lowering stopped. String fields are display data (identifier text,
// operator text, checker.typeToString results captured while the checker is alive). Code
// that needs a decision uses a separate boolean or tagged field. Prose is composed only in
// src/report; nothing may branch on display text.
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

  // optionalOrRestTuple marks a parameter type that failed classification because it is a
  // tuple with an optional or rest position ([number, number?], [number, ...number[]]) —
  // the runtime length is a range the exact positional model cannot carry, and the
  // message names the rewrite toward number[] or a fixed tuple.
  | {kind: 'parameterType'; typeText: string; optionalOrRestTuple: boolean}
  // A default value outside the represented literal subset. Literal defaults are applied
  // exactly; a computed or non-finite initializer could falsify parameter assumptions or
  // hide unsupported behavior, so the declaration rejects.
  | {kind: 'parameterDefaultValue'; name: string}
  // A non-void function has a path that falls off the end without returning.
  | {kind: 'missingReturn'}
  // Method or accessor in an object literal.
  | {kind: 'objectPropertyForm'}
  | {kind: 'computedPropertyName'}
  | {kind: 'objectSpread'}
  | {kind: 'asyncOrGeneratorFunction'}
  | {kind: 'typePredicate'}
  | {kind: 'protoProperty'}
  | {kind: 'enumMemberRead'}
  // point.toString and friends: a prototype member the record value cannot answer.
  | {kind: 'prototypeMemberRead'; property: string}
  // e.g. '**', '>>', 'instanceof' in value position — the operators arithmetic and
  // comparison lowering do not claim ('%' and '??' lower now and no longer land here)
  | {kind: 'binaryOperator'; operator: string}
  // Callee is neither a top-level function in this file nor supported Math. `callee` is a
  // short display name — an identifier, dotted pair, or (…).method for computed receivers.
  // arrayMethod classifies a method called on an array value. Only reduce has a checked
  // guide; every other method stays distinct from a general unknown call without routing
  // on the display-only callee text.
  | {kind: 'call'; callee: string; arrayMethod?: 'reduce' | 'other'}
  // A call omitting a required parameter, or a parameter whose default initializer is
  // outside the supported literal subset. Supported optional and literal-defaulted
  // parameters are filled before the call instruction is emitted.
  | {kind: 'callWithFewerArguments'; callee: string}
  // An overload accepts more arguments than its implementation names. JavaScript still
  // evaluates them, but the fixed-arity call model has no corresponding parameters.
  | {kind: 'callWithMoreArguments'; callee: string}
  // A position that must hold a number (operand, supported Math argument) typed otherwise,
  // e.g. the left side of `events.keydown == null` with type KeyboardEvent | null. The site
  // points at the exact operand, so no role tag is needed.
  | {kind: 'nonNumberOperand'; typeText: string}
  // A branch condition whose type is not boolean, e.g. `if (width)` truthiness on a number.
  | {kind: 'nonBooleanCondition'; conditionKind: 'number' | 'other'; typeText: string}
  // The acceptance rules (see current-decisions.md): `var` hoists, so one variable can
  // have several declaration sites and the binding model does not apply.
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
  // (`as` and angle-bracket assertions erase to a claim-free opaque instead, so only `!`
  // reaches this reason.)
  | {kind: 'kindChangingAssertion'; fromText: string; toText: string}
  | {kind: 'propertyReadOnNonObject'; typeText: string}
  | {kind: 'statementAfterReturn'}
  // An assignment used as a value inside a larger expression, e.g. `cond ? (x = 1) : 2` or
  // `a = b = 5`. Assignments lower only in statement position; write it as its own
  // statement.
  | {kind: 'assignmentInValuePosition'}
  // A write into an object, e.g. `config.pos = 1` or `count.total += n`. Values are
  // immutable after construction (owner-locked): update state by rebinding a variable to a
  // fresh object with explicit fields, e.g. `config = {pos: 1, dest: config.dest}`.
  | {kind: 'propertyWrite'}
  // A direct global console.assert spelling expressed static intent, but its arguments,
  // position, optional form, or condition is outside the accepted grammar.
  | {kind: 'staticAssertionForm'; problem: StaticAssertionProblem}
  | {kind: 'forLoopWithoutCondition'}
  // Destructuring pattern or a declaration without an initializer.
  | {kind: 'variableDeclarationShape'}
  // Catch-alls carry the ts.SyntaxKind name, e.g. 'FalseKeyword', 'WhileStatement'.
  | {kind: 'expressionForm'; syntax: string}
  | {kind: 'statementForm'; syntax: string}
  // Switch is supported without fallthrough (owner decision): every non-empty case body
  // must end in break or return, stacked empty labels share the next body, default comes
  // last. These three name the rejections that remain.
  | {kind: 'switchFallthrough'}
  | {kind: 'switchDefaultNotLast'}
  | {kind: 'switchSubject'; typeText: string}
  | {kind: 'switchLabel'; typeText: string}

// A function whose lowering stopped. The half-built CFG is discarded wholesale so nothing
// downstream can mistake this record for analyzable IR. Sites already pushed while lowering
// the discarded blocks stay in ProgramIR.sites; do not roll the array back — that would
// invalidate the SiteID recorded here.
export type UnsupportedFunctionIR = {
  kind: 'unsupported'
  name: string
  hasStaticAnnotations: boolean
  site: SiteID
  reason: UnsupportedReason
}

export type FunctionLowering = FunctionIR | UnsupportedFunctionIR

// What a binding's declared type promises in each value position: a number, a boolean, or
// a record with a fixed property shape (shapes nest — module state is a tree of records).
// The promise is an assumption, not a guarantee: TypeScript accepts an `any`-typed value in
// any write position, so the report prints a condition for every read that rests on one.
export type DeclaredVariant = {tagValue: string | boolean; properties: Array<{name: string; declared: DeclaredKind}>}

export type DeclaredNumberInterval = {
  lower: number
  upper: number
  integer: boolean
}

export type DeclaredKind =
  | {kind: 'number'; interval: DeclaredNumberInterval | null}
  | {kind: 'boolean'}
  | {kind: 'record'; properties: Array<{name: string; declared: DeclaredKind}>}
  | {kind: 'nullish'; inner: DeclaredKind; sentinels: 'null' | 'undefined' | 'both'}
  // A tuple type: fixed length, one declared kind per position — the module config table
  // `const gapSizes = [4, 8, 24] as const` publishes like a record.
  | {kind: 'tuple'; elements: DeclaredKind[]}
  // A homogeneous array of the element's kind.
  | {kind: 'array'; element: DeclaredKind}
  // A kind the analysis carries without claims — strings. Present so a record with an id
  // or label keeps its numeric contract instead of rejecting wholesale.
  | {kind: 'opaque'}
  // One of several record shapes told apart by a shared string-literal property
  // (route.type is 'explore' or 'lightbox'). The variant list is written in the type;
  // analysis only ever removes variants. The tag rides inside each variant's properties
  // as an ordinary opaque leaf; tagProperty and tagValue carry which one it is.
  | {kind: 'taggedUnion'; tagProperty: string; variants: [DeclaredVariant, ...DeclaredVariant[]]}

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
  // An imported binding whose target declaration is a const with a plain numeric-literal
  // initializer in a project .ts file, e.g. `export const INPUT_ROW_HEIGHT = 54`. The
  // literal is trusted exactly, without analyzing the exporting module; the soundness
  // argument sits on importedCategory in src/lower/module.ts.
  | {kind: 'importedConstant'; value: number}
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
    // An imported constant needs no declared-kind hedge: its slot is always seeded with
    // the exact literal, so no assumes line and no havoc reset value apply.
    case 'importedConstant':
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
  return valueFromDeclaredKind(declared, finiteInputNumber, true)
}

// Inside a declared variant, the tag property holds exactly its tag value — the string
// content or the pinned boolean — rather than the walked hedge. This is what lets the
// rebuild idiom keep its variant: after `frame.type === 'sidebar'` narrows the union,
// `{type: frame.type, width}` reads a tag whose VALUE still says 'sidebar', and the
// engine's object arm pins from that value (an unnarrowed multi-variant union joins its
// tags to bare opaque or an unknown boolean, so nothing pins — correctly).
function exactTagValue(tagValue: string | boolean): AbstractValue {
  if (typeof tagValue === 'string') return {kind: 'opaque', content: tagValue}
  return {kind: 'boolean', canBeTrue: tagValue, canBeFalse: !tagValue}
}

// Whether values of this declared kind can be mutated through an alias: a record, tuple,
// or array anywhere inside, including behind a nullish wrapper (`number[] | null`).
// Rejected function bodies and skipped statements run at runtime too, and they can mutate
// such a value with no write-position mention of its binding — `queue?.push(x)` and
// `Object.assign(config, overrides)` both hold the binding in receiver or argument
// position, invisible to the whole-file write scan. Scalars are copied on read, so only a
// write-position form can change one, and the scan sees those even in rejected bodies.
export function holdsMutableStructure(declared: DeclaredKind): boolean {
  switch (declared.kind) {
    case 'record':
    case 'tuple':
    case 'array':
    case 'taggedUnion':
      return true
    case 'nullish':
      return holdsMutableStructure(declared.inner)
    case 'number':
    case 'boolean':
    case 'opaque':
      return false
  }
}

// The truly covering value of a declared kind: any number INCLUDING NaN and infinities.
// This is what a havocked slot resets to — a skipped statement can put NaN in a number
// binding (e.g. `scale = Number.parseFloat(text)`), and later top-level statements compute
// published values from the slot with no assumes line to carry a finiteness condition, so
// the reset value must cover everything the skipped code could have produced.
export function coveringKindValue(declared: DeclaredKind): AbstractValue {
  return valueFromDeclaredKind(declared, unknownNumber, false)
}

// The two declared-kind values have identical recursive structure and differ only at
// number leaves: function inputs use the written literal range when one exists and
// otherwise assume a finite number, while havoc must cover every number. Keeping the walk
// here makes a new DeclaredKind arm impossible to add to one conversion but not the other.
function valueFromDeclaredKind(
  declared: DeclaredKind,
  numberValue: () => AbstractNumber,
  preserveLiteralIntervals: boolean,
): AbstractValue {
  switch (declared.kind) {
    case 'number': return preserveLiteralIntervals && declared.interval != null
      ? {
          kind: 'number',
          lower: declared.interval.lower,
          upper: declared.interval.upper,
          integer: declared.interval.integer,
          mayBeNaN: false,
        }
      : numberValue()
    case 'boolean': return unknownBoolean()
    case 'record': return recordValue(declared.properties.map(property => ({
      name: property.name,
      value: valueFromDeclaredKind(property.declared, numberValue, preserveLiteralIntervals),
    })))
    case 'nullish': return {
      kind: 'maybeNullish',
      inner: valueFromDeclaredKind(declared.inner, numberValue, preserveLiteralIntervals),
      sentinels: declared.sentinels,
    }
    case 'tuple': return {
      kind: 'tuple',
      elements: declared.elements.map(element =>
        valueFromDeclaredKind(element, numberValue, preserveLiteralIntervals)),
    }
    case 'array': return {
      kind: 'array',
      element: valueFromDeclaredKind(declared.element, numberValue, preserveLiteralIntervals),
      length: {kind: 'number', lower: 0, upper: 4294967295, integer: true, mayBeNaN: false},
    }
    case 'taggedUnion': {
      const convertVariant = (variant: DeclaredVariant): TaggedVariant => ({
        tagValue: variant.tagValue,
        record: recordValue(variant.properties.map(property => ({
          name: property.name,
          value: property.name === declared.tagProperty
            ? exactTagValue(variant.tagValue)
            : valueFromDeclaredKind(property.declared, numberValue, preserveLiteralIntervals),
        }))),
      })
      const [firstVariant, ...restVariants] = declared.variants
      return {
        kind: 'taggedUnion',
        tagProperty: declared.tagProperty,
        variants: [convertVariant(firstVariant), ...restVariants.map(convertVariant)],
      }
    }
    case 'opaque': return {kind: 'opaque'}
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
  // What report paths are made relative to; CLI commands use their working directory,
  // matching TypeScript diagnostics. See reportPath.
  baseDirectory: string
  // Offset of each line's first character, copied from ts.SourceFile.getLineStarts(), so
  // locations can be formatted after the TypeScript objects are gone (analyzeSource inputs
  // never exist on disk, so re-reading the file is not an option).
  lineStarts: number[]
  // Indexed by SiteID. Push-only during lowering, immutable afterward.
  sites: SourceSpan[]
  // Still indexed by FunctionID, assigned from declaration order before any body lowers, so
  // call instructions may reference an index that later turns out unsupported.
  functions: FunctionLowering[]
  // Direct global console.assert calls outside named top-level function
  // declarations. Project reporting treats every entry as an error.
  staticAnnotationIssues: Array<{kind: 'outsideTopLevelFunction'; site: SiteID}>
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
  return `${reportPath(program)}:${line}:${column}`
}

// Report lines name files relative to the analysis base. CLI commands use their working
// directory, matching TypeScript diagnostics and producing stable relative paths without
// absolute machine-specific prefixes.
export function reportPath(program: ProgramIR): string {
  return relative(program.baseDirectory, program.file)
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
