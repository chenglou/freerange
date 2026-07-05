import {nextDown, nextUp, isFiniteNumber, type AbstractNumber} from '../domain/number.ts'
import type {AbstractValue} from '../domain/value.ts'
import type {FunctionAnalysis, ProgramAnalysis, Stop} from '../engine/outcome.ts'
import type {BoundsAssumption} from '../requirements/model.ts'
import {declaredKindOf, formatSite, type DeclaredKind, type FunctionIR, type ProgramIR, type UnsupportedReason} from '../ir/program.ts'
import {formatObservedNeed, formatPrecondition} from './format-requirement.ts'

export type FunctionReport =
  | {kind: 'analyzed'; name: string; assumptions: string[]; requires: string[]; ensures: string[]}
  // e.g. 'unknown identifier scheduledRender at /abs/demo/index.ts:6:7'
  | {kind: 'unsupported'; name: string; unsupported: string}
  // Some path stopped; `observed` lines are evidence from the paths that completed, never a
  // contract. e.g. stopped: 'recursive call to countdown (call at /abs/file.ts:3:10)',
  // observed: 'return is a finite integer number from 0 through 0'.
  | {kind: 'partial'; name: string; assumptions: string[]; stopped: string[]; skipped?: string[]; observed: string[]}

export type AnalysisReport = {
  file: string
  functions: FunctionReport[]
}

export function createReport(program: ProgramIR, analysis: ProgramAnalysis): AnalysisReport {
  const functions: FunctionReport[] = []
  const assumedBindings = assumedKindBindings(program, analysis)
  // An unproven asserted element read at the top level (`breakpoints[idx]!` with a
  // platform-derived idx) conditions everything the initializer published, and the
  // initializer usually prints no entry — so the assumption lines travel to every
  // function that reads any module binding, the same way declared-kind assumptions do.
  // Without this, a reader's ensures would publish unconditionally while the runtime
  // read can miss.
  const initializerBounds = analysis.initializer.kind === 'analyzed'
    ? analysis.initializer.boundsAssumptions
    : analysis.initializer.kind === 'partial' ? analysis.initializer.observedBoundsAssumptions : []
  const initializerBoundsLines = initializerBounds.map(assumption =>
    `the element read at ${formatSite(program, assumption.site)} is in bounds`)
  const readsModules = moduleReadingFunctions(program)
  // Top-level code runs before any function, so its entry comes first — but only when it
  // stopped or skipped statements. A fully analyzed initializer with nothing skipped is
  // invisible: its results show up as the exact module values other entries report, with
  // its bounds assumptions carried by the readers above.
  const skippedLines = program.initializerSkips.map(skip =>
    `${formatUnsupportedReason(skip.reason)} at ${formatSite(program, skip.site)}`)
  if (analysis.initializer.kind === 'partial' || skippedLines.length > 0) {
    const observed: string[] = []
    if (analysis.initializer.kind === 'partial') {
      for (const need of analysis.initializer.observedNeeds) observed.push(formatObservedNeed(need, [], program))
    }
    functions.push({
      kind: 'partial',
      name: program.initializer.name,
      assumptions: initializerBoundsLines,
      stopped: analysis.initializer.kind === 'partial'
        ? analysis.initializer.stops.map(stop => formatStop(stop, program, analysis))
        : [],
      skipped: skippedLines,
      observed,
    })
  }
  for (let functionID = 0; functionID < analysis.functions.length; functionID++) {
    const fn = analysis.functions[functionID]!
    switch (fn.kind) {
      case 'notLowered': {
        const lowering = fn.lowering
        functions.push({
          kind: 'unsupported',
          name: lowering.name,
          unsupported: `${formatUnsupportedReason(lowering.reason)} at ${formatSite(program, lowering.site)}`,
        })
        break
      }
      case 'partial': {
        const lowering = fn.lowering
        const parameterNames = lowering.parameters.map(parameter => parameter.name)
        const observed: string[] = []
        if (fn.observedReturn != null) {
          observed.push(...returnSummaries('return', declaredReturn(fn.observedReturn.value, lowering), program))
        }
        for (const need of fn.observedNeeds) observed.push(formatObservedNeed(need, parameterNames, program))
        functions.push({
          kind: 'partial',
          name: lowering.name,
          assumptions: [
            ...assumptionLines(lowering, program, assumedBindings[functionID]!, fn.observedBoundsAssumptions),
            ...(readsModules[functionID] === true ? initializerBoundsLines : []),
          ],
          stopped: fn.stops.map(stop => formatStop(stop, program, analysis)),
          observed,
        })
        break
      }
      case 'analyzed': {
        const lowering = fn.lowering
        const parameterNames = lowering.parameters.map(parameter => parameter.name)
        functions.push({
          kind: 'analyzed',
          name: lowering.name,
          assumptions: [
            ...assumptionLines(lowering, program, assumedBindings[functionID]!, fn.boundsAssumptions),
            ...(readsModules[functionID] === true ? initializerBoundsLines : []),
          ],
          requires: fn.preconditions.map(precondition => formatPrecondition(precondition, parameterNames, program)),
          ensures: returnSummaries('return', declaredReturn(fn.returnValue, lowering), program),
        })
        break
      }
    }
  }
  return {file: program.file, functions}
}

// The legend targets a reader — usually another model — that has never seen a freerange
// report: each line kind in one sentence, so the report is self-describing.
const legend = [
  '# freerange: static analysis of the numeric behavior of each top-level function.',
  '# assumes:  input facts taken on faith; the lines below hold only when these do.',
  '# requires: conditions the caller must make true; given them, the ensures lines hold.',
  '# ensures:  guarantees about the returned value whenever the function returns.',
  '# unsupported: the function uses code outside the analyzed subset; the message names the construct and, when one exists, the rewrite that brings it inside.',
  '# stopped:  analysis halted partway on some path; the entry describes only what ran before the stop.',
  '# skipped:  a top-level statement the module analysis stepped over; anything it could write is distrusted.',
  '# on analyzed paths: evidence from the paths that completed - not a guarantee for the whole function.',
]

export function formatReport(report: AnalysisReport): string {
  const lines: string[] = [...legend, report.file]
  for (const fn of report.functions) {
    lines.push('', fn.name)
    switch (fn.kind) {
      case 'analyzed': {
        for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
        for (const precondition of fn.requires) lines.push(`  requires: ${precondition}`)
        for (const guarantee of fn.ensures) lines.push(`  ensures: ${guarantee}`)
        break
      }
      case 'unsupported': {
        lines.push(`  unsupported: ${fn.unsupported}`)
        break
      }
      case 'partial': {
        for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
        for (const stop of fn.stopped) lines.push(`  stopped: ${stop}`)
        for (const skip of fn.skipped ?? []) lines.push(`  skipped: ${skip}`)
        for (const evidence of fn.observed) lines.push(`  on analyzed paths: ${evidence}`)
        break
      }
    }
  }
  return lines.join('\n')
}

function assumptionLines(
  fn: FunctionIR,
  program: ProgramIR,
  assumedBindings: boolean[],
  boundsAssumptions: BoundsAssumption[],
): string[] {
  const assumptions: string[] = []
  for (const parameter of fn.parameters) {
    pushDeclaredAssumptions(parameter.name, parameter.type, assumptions)
  }
  for (let bindingID = 0; bindingID < program.moduleBindings.length; bindingID++) {
    if (assumedBindings[bindingID] !== true) continue
    const binding = program.moduleBindings[bindingID]!
    const declaredKind = declaredKindOf(binding.category)
    if (declaredKind == null) throw new Error(`Module binding ${binding.name} has no declared kind to assume`)
    pushDeclaredAssumptions(binding.name, declaredKind, assumptions)
  }
  for (const assumption of boundsAssumptions) {
    // The engine could not prove the asserted element read in bounds; the entry's
    // guarantees rest on it. E.g. `the element read at demo.ts:4:10 is in bounds`.
    assumptions.push(`the element read at ${formatSite(program, assumption.site)} is in bounds`)
  }
  return assumptions
}

// One assumption line per leaf of the declared kind: a record binding's condition is a
// condition on each of its properties, e.g. `pointer.x is finite and not NaN`.
function pushDeclaredAssumptions(path: string, declared: DeclaredKind, assumptions: string[]): void {
  switch (declared.kind) {
    case 'number': assumptions.push(`${path} is finite and not NaN`); break
    case 'boolean': assumptions.push(`${path} is a boolean`); break
    case 'tuple': {
      for (let index = 0; index < declared.elements.length; index++) {
        pushDeclaredAssumptions(`${path}[${index}]`, declared.elements[index]!, assumptions)
      }
      break
    }
    case 'array': {
      // E.g. `every values element is finite and not NaN`. The recursion path uses
      // `[each]` so nesting stays readable: a number[][] parameter prints
      // `every grid[each] element is finite and not NaN`, and a record element prints
      // its property path, e.g. `points[each].x is finite and not NaN`.
      const leaf: string[] = []
      pushDeclaredAssumptions(`${path}[each]`, declared.element, leaf)
      for (const line of leaf) {
        const prefix = `${path}[each] is `
        // The `every X element is` sugar only reads right when the element path appears
        // once. A nullish element's disjunction mentions it again (`slots[each] is null
        // or slots[each].x is finite and not NaN`), and rewriting only the first mention
        // would mix the two quantifier styles in one line.
        const mentionsOnce = line.split(`${path}[each]`).length === 2
        assumptions.push(line.startsWith(prefix) && mentionsOnce
          ? `every ${path} element is ${line.slice(prefix.length)}`
          : line)
      }
      break
    }
    // No claims are made about an opaque leaf, so there is nothing to assume.
    case 'opaque': break
    case 'nullish': {
      const sentinelWords = declared.sentinels === 'both' ? 'null or undefined' : declared.sentinels
      if (declared.inner.kind === 'number') {
        // E.g. `animatedUntilTime is null or a finite non-NaN number`.
        assumptions.push(`${path} is ${sentinelWords} or a finite non-NaN number`)
      } else if (declared.inner.kind === 'boolean') {
        assumptions.push(`${path} is ${sentinelWords} or a boolean`)
      } else {
        // One line per inner leaf, each carrying the missing-value caveat — e.g. a
        // `Config | null` parameter prints `config is null or config.width is finite and
        // not NaN`. The seeded finiteness of every leaf must reach the report: the
        // ensures lines rest on it. An opaque inner (`string | null`) contributes no
        // line, because nothing is claimed about the string either way.
        const leaf: string[] = []
        pushDeclaredAssumptions(path, declared.inner, leaf)
        for (const line of leaf) assumptions.push(`${path} is ${sentinelWords} or ${line}`)
      }
      break
    }
    case 'record': {
      for (const property of declared.properties) {
        pushDeclaredAssumptions(`${path}.${property.name}`, property.declared, assumptions)
      }
      break
    }
  }
}

// Per function: the module bindings whose declared-kind seeding the function's results rest
// on. A read without a published exact value rests on the declared kind alone — the printed
// line is the condition under which the entry's guarantees hold. The assumption travels
// through calls: a callee evaluates on the caller's own seeded slots, so the callee's read
// is the caller's assumption too. Closed over static call edges; a call path that never
// executes can only add a harmless extra assumption line.
function assumedKindBindings(program: ProgramIR, analysis: ProgramAnalysis): boolean[][] {
  const assumed: boolean[][] = []
  const callees: Array<Set<number>> = []
  for (const lowering of program.functions) {
    const reads: boolean[] = []
    const calls = new Set<number>()
    if (lowering.kind === 'lowered') {
      for (const block of lowering.blocks) {
        for (const instruction of block.instructions) {
          if (instruction.kind === 'call') calls.add(instruction.function)
          if (instruction.kind !== 'moduleRead' || analysis.moduleValues[instruction.binding] != null) continue
          const binding = program.moduleBindings[instruction.binding]
          if (binding == null) throw new Error(`Unknown module binding ${instruction.binding}`)
          if (declaredKindOf(binding.category) != null) {
            reads[instruction.binding] = true
          }
        }
      }
    }
    assumed.push(reads)
    callees.push(calls)
  }
  // Call graphs can have cycles, so propagate until stable.
  let changed = true
  while (changed) {
    changed = false
    for (let caller = 0; caller < assumed.length; caller++) {
      for (const callee of callees[caller]!) {
        const calleeAssumed = assumed[callee]!
        for (let bindingID = 0; bindingID < calleeAssumed.length; bindingID++) {
          if (calleeAssumed[bindingID] === true && assumed[caller]![bindingID] !== true) {
            assumed[caller]![bindingID] = true
            changed = true
          }
        }
      }
    }
  }
  return assumed
}

// Whether each function (transitively, through calls to the file's own functions) reads
// any module binding at all — the consumers that rest on what the initializer published.
// Coarser than per-binding tracking on purpose: which binding rests on which top-level
// assumption is not tracked, and an extra assumption line on an unrelated reader is
// harmless, the same trade assumedKindBindings makes for call paths that never execute.
function moduleReadingFunctions(program: ProgramIR): boolean[] {
  const reads: boolean[] = []
  const callees: Array<Set<number>> = []
  for (const lowering of program.functions) {
    let readsAny = false
    const calls = new Set<number>()
    if (lowering.kind === 'lowered') {
      for (const block of lowering.blocks) {
        for (const instruction of block.instructions) {
          if (instruction.kind === 'call') calls.add(instruction.function)
          if (instruction.kind === 'moduleRead') readsAny = true
        }
      }
    }
    reads.push(readsAny)
    callees.push(calls)
  }
  let changed = true
  while (changed) {
    changed = false
    for (let caller = 0; caller < reads.length; caller++) {
      if (reads[caller] === true) continue
      for (const callee of callees[caller]!) {
        if (reads[callee] === true) {
          reads[caller] = true
          changed = true
          break
        }
      }
    }
  }
  return reads
}

// The only place stop prose exists; everything else branches on reason.kind.
function formatStop(stop: Stop, program: ProgramIR, analysis: ProgramAnalysis): string {
  const reason = stop.reason
  switch (reason.kind) {
    case 'recursion': {
      return `recursive call to ${functionName(program, reason.callee)} (call at ${formatSite(program, stop.site)})`
    }
    case 'calleeStopped': {
      // A merely stopped callee did not itself hit unsupported code; saying so would send an
      // agent hunting through a body whose constructs all lower.
      const calleeState = calleeStateText(analysis.functions[reason.callee])
      return `calls ${functionName(program, reason.callee)}, ${calleeState} (call at ${formatSite(program, stop.site)})`
    }
    case 'outOfBoundsRead': {
      return `reads an element provably outside the array (at ${formatSite(program, stop.site)})`
    }
    case 'unmodeledNarrowing': {
      return `narrows a value in a way the analysis does not model (at ${formatSite(program, stop.site)})`
    }
    case 'divisorUnknown': {
      return `cannot infer a nonzero requirement for the division at ${formatSite(program, stop.site)}`
    }
    case 'loopLimit': {
      return `the loop at ${formatSite(program, stop.site)} did not converge after ${reason.updates} updates`
    }
    case 'nonExitingLoop': {
      return `the loop at ${formatSite(program, stop.site)} never exits on any analyzed path`
    }
    case 'unsupportedCode': {
      return `${formatUnsupportedReason(reason.reason)} at ${formatSite(program, stop.site)}`
    }
    case 'moduleRead': {
      const binding = program.moduleBindings[reason.binding]
      if (binding == null) throw new Error(`Unknown module binding ${reason.binding}`)
      switch (binding.category.kind) {
        case 'import':
          return `reads ${binding.name}, which is imported from another module (read at ${formatSite(program, stop.site)})`
        case 'opaque':
          return `reads ${binding.name}, whose value the analysis does not track (read at ${formatSite(program, stop.site)})`
        // A value or kind binding is always seeded inside functions, so an uninitialized
        // read of one can only happen in the initializer's own top-level code.
        case 'value':
        case 'kind':
          return `reads ${binding.name} before it is initialized (read at ${formatSite(program, stop.site)})`
      }
    }
  }
}

function calleeStateText(callee: FunctionAnalysis | undefined): string {
  if (callee == null) return 'whose analysis stopped'
  switch (callee.kind) {
    case 'notLowered': return 'which hit unsupported code'
    case 'partial': return 'whose analysis stopped'
    // The callee analyzes completely in general but stopped when evaluated from this call —
    // because of this caller's arguments (e.g. an argument whose expression the requirement
    // language cannot name) or the module state at this point (e.g. a module binding not yet
    // initialized when top-level code makes the call).
    case 'analyzed': return 'whose analysis stopped for this specific call'
  }
}

function functionName(program: ProgramIR, callee: number): string {
  const fn = program.functions[callee]
  if (fn == null) throw new Error(`Unknown function ${callee}`)
  return fn.name
}

// The only place reason prose exists; everything else branches on reason.kind. The
// exhaustiveness check forces a formatting arm for every future variant.
function formatUnsupportedReason(reason: UnsupportedReason): string {
  switch (reason.kind) {
    case 'unknownIdentifier': return `unknown identifier ${reason.name}`
    case 'missingSymbol': return 'node without a TypeScript symbol'
    case 'functionWithoutSignature': return 'function without a TypeScript signature'
    case 'functionWithoutBody': return 'function declarations need bodies'
    case 'destructuredParameter': return 'destructured parameters (take a named parameter and destructure it in the body)'
    case 'parameterType': return `function parameter with type ${reason.typeText}`
    case 'parameterDefaultValue': return `default value for parameter ${reason.name}; supported defaults are literals provably inside the assumed kind (= 5 for a number, = null for a nullable) — otherwise drop the default and pass the argument explicitly`
    case 'missingReturn': return 'function path without a return (add a return on every path)'
    case 'objectPropertyForm': return 'object property form (use plain data properties: name: value, shorthand, or spread)'
    case 'computedPropertyName': return 'computed object property name'
    case 'spreadOptionalProperty': return `spread of a value whose property ${reason.property} is optional (declare every property of the spread source required)`
    case 'spreadAfterProperties': return 'a spread after other entries (the spread value can carry extra properties that override earlier entries at runtime; write the spread first, then override with explicit properties)'
    case 'asyncOrGeneratorFunction': return 'an async or generator function (the runtime result is a Promise or iterator, not the body\'s return value)'
    case 'typePredicate': return 'a type predicate (the checker takes the predicate on faith; return a plain boolean and check properties where they are read)'
    case 'protoProperty': return 'a property named __proto__ (prototype-setting syntax at runtime, not a data property)'
    case 'enumMemberRead': return 'an enum member read (replace the enum with plain module consts, e.g. const directionUp = 1)'
    case 'binaryOperator': return reason.operator === '!==' || reason.operator === '!='
      ? `binary operator ${reason.operator} (not-equal narrowing is not modeled; invert to === with an early return, e.g. if (columnCount === 0) return 0)`
      : `binary operator ${reason.operator} (supported: + - * /, comparisons, and boolean && || !)`
    case 'call': return reason.callee === 'Object.assign'
      ? 'function call Object.assign (values are immutable; rebind a variable to a fresh object instead)'
      : `function call ${reason.callee}`
    case 'callWithFewerArguments': return `call to ${reason.callee} with fewer arguments than parameters (pass every argument explicitly)`
    case 'nonNumberOperand': return `non-number operand of type ${reason.typeText}`
    case 'nonBooleanCondition': return `condition of type ${reason.typeText} (compare explicitly, e.g. width > 0 or mode !== undefined)`
    case 'valueType': return `value of type ${reason.typeText}`
    case 'kindChangingAssertion': return `a non-null assertion turning ${reason.fromText} into ${reason.toText}`
    case 'propertyReadOnNonObject': return `property read from ${reason.typeText}`
    case 'statementAfterReturn': return 'statements after return'
    case 'assignmentInValuePosition': return 'an assignment used as a value (write it as its own statement)'
    case 'propertyWrite': return 'a write into an object (values are immutable; rebind a variable to a fresh object instead)'
    case 'anyTyped': return 'a value typed any (give it a concrete number, boolean, or object type)'
    case 'typeAssertion': return `a type assertion to ${reason.typeText} (remove the assertion and declare the intended type instead)`
    case 'varDeclaration': return 'var declarations (use let or const)'
    case 'evalInFile': return 'eval appears in this file; an eval string can rewrite any binding, so no function in the file is analyzed'
    case 'typeCheckSuppressed': return 'a @ts-ignore, @ts-expect-error, or @ts-nocheck comment turns off type checking in this file, so declared types cannot be trusted and no function is analyzed'
    case 'forLoopWithoutCondition': return 'for loop without a condition'
    case 'forLoopWithoutIncrementor': return 'for loop without an incrementor'
    case 'variableDeclarationShape': return 'variables without identifier names and initializers'
    case 'expressionForm': return `expression (${reason.syntax})`
    case 'statementForm': return `statement (${reason.syntax})`
    case 'switchStatement': return 'switch statement; write an if/else chain instead'
  }
}

// The contract covers only what the declared return type exposes: a wider returned
// record's extra properties are true facts, but not ones any type-checked caller can read.
function declaredReturn(value: AbstractValue, lowering: FunctionIR): AbstractValue {
  if (lowering.returnPropertyNames == null) return value
  const declared = new Set(lowering.returnPropertyNames)
  if (value.kind === 'record') {
    return {kind: 'record', properties: value.properties.filter(property => declared.has(property.name))}
  }
  // A {w: number} | null return carries the record inside the wrapper.
  if (value.kind === 'maybeNullish' && value.inner.kind === 'record') {
    return {
      ...value,
      inner: {kind: 'record', properties: value.inner.properties.filter(property => declared.has(property.name))},
    }
  }
  return value
}

function returnSummaries(path: string, value: AbstractValue, program: ProgramIR): string[] {
  switch (value.kind) {
    case 'number': return [numberSummary(path, value, program)]
    case 'boolean': return [`${path} is ${value.canBeFalse ? (value.canBeTrue ? 'boolean' : 'false') : 'true'}`]
    case 'record': {
      const summaries: string[] = []
      for (const property of value.properties) {
        summaries.push(...returnSummaries(`${path}.${property.name}`, property.value, program))
      }
      return summaries
    }
    case 'void': return []
    // No numeric claims exist about an opaque value; saying nothing is the honest line.
    case 'opaque': return []
    case 'nullish': return [`${path} is ${sentinelsText(value.sentinels)}`]
    case 'tuple': {
      const lines: string[] = [`${path}.length is exactly ${value.elements.length}`]
      for (let index = 0; index < value.elements.length; index++) {
        lines.push(...returnSummaries(`${path}[${index}]`, value.elements[index]!, program))
      }
      return lines
    }
    case 'array': {
      const lines = [numberSummary(`${path}.length`, value.length, program)]
      if (value.element != null) {
        lines.push(...returnSummaries(`${path}[each]`, value.element, program).map(line =>
          line.startsWith(`${path}[each] is `)
            ? `every ${path} element is ${line.slice(`${path}[each] is `.length)}`
            : line))
      }
      return lines
    }
    case 'maybeNullish': {
      // The inner summary describes the present case; one line states the missing case.
      // E.g. `return is null or a finite number from 0 through 100`.
      const inner = returnSummaries(path, value.inner, program)
      if (inner.length === 0) return [`${path} may be ${sentinelsText(value.sentinels)}`]
      if (inner.length === 1 && inner[0]!.startsWith(`${path} is `)) {
        return [`${path} is ${sentinelsText(value.sentinels)} or ${inner[0]!.slice(`${path} is `.length)}`]
      }
      return [`${path} may be ${sentinelsText(value.sentinels)}; when present:`, ...inner]
    }
  }
}

function sentinelsText(sentinels: 'null' | 'undefined' | 'both'): string {
  return sentinels === 'both' ? 'null or undefined' : sentinels
}

function numberSummary(path: string, value: AbstractNumber, program: ProgramIR): string {
  const kind = value.integer ? 'integer ' : ''
  // Three-way: NaN is the scarier possibility and names itself; a value that can only
  // overflow says non-finite; everything else is finite.
  const domain = value.mayBeNaN ? 'possibly NaN ' : isFiniteNumber(value) ? 'finite ' : 'possibly non-finite '
  // The blame suffix names where the degradation was born, so the line points at the
  // missing input fact instead of just shrugging. A recovered value (clamped back to a
  // clean range) prints no suffix even when the annotation lingers.
  const blame = value.lossSite == null || (isFiniteNumber(value) && !value.mayBeNaN)
    ? ''
    : value.mayBeNaN
      ? ` (NaN possible from the operation at ${formatSite(program, value.lossSite)})`
      : ` (can overflow at ${formatSite(program, value.lossSite)})`
  const subject = `${path} is a ${domain}${kind}number`
  // A point interval is an exact value (`return 0.1 + 0.2` is exactly
  // 0.30000000000000004); rewriting either bound into strict phrasing would print an
  // absurd range around a constant, so the rewrite only applies to genuine ranges.
  const pointInterval = value.lower === value.upper
  const strictLower = pointInterval ? null : strictBoundWords(value.lower, 'lower')
  const strictUpper = pointInterval ? null : strictBoundWords(value.upper, 'upper')
  if (value.lower === -Number.MAX_VALUE && value.upper === Number.MAX_VALUE) return `${subject}${blame}`
  if (value.upper === Number.MAX_VALUE) {
    return `${subject} ${strictLower ?? `at least ${formatNumber(value.lower)}`}${blame}`
  }
  if (value.lower === -Number.MAX_VALUE) {
    return `${subject} ${strictUpper ?? `at most ${formatNumber(value.upper)}`}${blame}`
  }
  if (strictLower != null || strictUpper != null) {
    const low = strictLower ?? `at least ${formatNumber(value.lower)}`
    const high = strictUpper ?? `at most ${formatNumber(value.upper)}`
    return `${subject} ${low} and ${high}${blame}`
  }
  return `${subject} from ${formatNumber(value.lower)} through ${formatNumber(value.upper)}${blame}`
}

// A strict comparison refines a float bound to the adjacent representable double, which
// prints hideously (`if (x > 0)` gives lower bound 5e-324, `if (x < 100)` gives upper
// bound 99.99999999999999). When stepping the bound back lands on a visibly simpler
// number, the strict phrasing says the same thing readably: 'more than 0', 'less than
// 100'. Bounds that already print plainly return null and keep the ordinary phrasing.
function strictBoundWords(bound: number, side: 'lower' | 'upper'): string | null {
  const stepped = side === 'lower' ? nextDown(bound) : nextUp(bound)
  // The margin is deliberately wide: only rewrite when the stepped form is drastically
  // shorter (5e-324 -> 0, 99.99999999999999 -> 100), never for a computed bound whose
  // neighbor happens to print a digit or two shorter.
  if (formatNumber(stepped).length + 4 <= formatNumber(bound).length) {
    return `${side === 'lower' ? 'more than' : 'less than'} ${formatNumber(stepped)}`
  }
  return null
}

// Infinite bounds are expected here; String renders them as 'Infinity'/'-Infinity'.
function formatNumber(value: number): string {
  return String(value)
}
