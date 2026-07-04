import {finiteInputNumber, isFiniteNumber, type AbstractNumber} from '../domain/number.ts'
import {sameValues, type AbstractValue} from '../domain/value.ts'
import type {FunctionAnalysis, ProgramAnalysis, Stop} from '../engine/outcome.ts'
import type {AbstractHeap} from '../heap/model.ts'
import {referenceProperties} from '../heap/operations.ts'
import {declaredKindOf, formatSite, type FunctionIR, type ProgramIR, type UnsupportedReason} from '../ir/program.ts'
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
  // Top-level code runs before any function, so its entry comes first — but only when it
  // stopped or skipped statements. A fully analyzed initializer with nothing skipped is
  // invisible: its results show up as the exact module values other entries report.
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
      assumptions: [],
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
          observed.push(...returnSummaries('return', fn.observedReturn.value, fn.observedReturn.heap, program))
        }
        for (const need of fn.observedNeeds) observed.push(formatObservedNeed(need, parameterNames, program))
        functions.push({
          kind: 'partial',
          name: lowering.name,
          assumptions: assumptionLines(lowering, program, assumedBindings[functionID]!),
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
          assumptions: assumptionLines(lowering, program, assumedBindings[functionID]!),
          requires: fn.preconditions.map(precondition => formatPrecondition(precondition, parameterNames, program)),
          ensures: [
            ...parameterWriteSummaries(lowering, fn.sharedState.heap, program),
            ...returnSummaries('return', fn.returnValue, fn.sharedState.heap, program),
          ],
        })
        break
      }
    }
  }
  return {file: program.file, functions}
}

export function formatReport(report: AnalysisReport): string {
  const lines: string[] = [report.file]
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

function assumptionLines(fn: FunctionIR, program: ProgramIR, assumedBindings: boolean[]): string[] {
  const assumptions: string[] = []
  for (const parameter of fn.parameters) {
    switch (parameter.type.kind) {
      case 'number': assumptions.push(`${parameter.name} is finite and not NaN`); break
      case 'object': {
        for (const property of parameter.type.properties) {
          assumptions.push(`${parameter.name}.${property} is finite and not NaN`)
        }
        break
      }
    }
  }
  for (let bindingID = 0; bindingID < program.moduleBindings.length; bindingID++) {
    if (assumedBindings[bindingID] !== true) continue
    const binding = program.moduleBindings[bindingID]!
    const declaredKind = declaredKindOf(binding.category)
    if (declaredKind == null) throw new Error(`Module binding ${binding.name} has no declared kind to assume`)
    assumptions.push(declaredKind === 'number'
      ? `${binding.name} is finite and not NaN`
      : `${binding.name} is a boolean`)
  }
  return assumptions
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
        case 'identity':
          return `reads ${binding.name}, a module object; module object values are not yet tracked (read at ${formatSite(program, stop.site)})`
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
    case 'destructuredParameter': return 'destructured parameters'
    case 'multipleObjectParameters': return 'more than one object parameter'
    case 'parameterType': return `function parameter with type ${reason.typeText}`
    case 'objectParameterProperty': return `object parameter property ${reason.property} with type ${reason.typeText}`
    case 'objectParameterWithoutNumericProperties': return 'object parameter without numeric properties'
    case 'missingReturn': return 'function path without a return'
    case 'objectPropertyForm': return 'object property'
    case 'computedPropertyName': return 'computed object property name'
    case 'binaryOperator': return `binary operator ${reason.operator}`
    case 'call': return `function call ${reason.callee}`
    case 'callWithFewerArguments': return `call to ${reason.callee} with fewer arguments than parameters`
    case 'nonNumberOperand': return `non-number operand of type ${reason.typeText}`
    case 'nonBooleanCondition': return `condition of type ${reason.typeText}`
    case 'valueType': return `value of type ${reason.typeText}`
    case 'kindChangingAssertion': return `a non-null assertion turning ${reason.fromText} into ${reason.toText}`
    case 'propertyReadOnNonObject': return `property read from ${reason.typeText}`
    case 'statementAfterReturn': return 'statements after return'
    case 'assignmentInValuePosition': return 'an assignment used as a value (write it as its own statement)'
    case 'anyTyped': return 'a value typed any'
    case 'typeAssertion': return `a type assertion to ${reason.typeText}`
    case 'varDeclaration': return 'var declarations (use let or const)'
    case 'evalInFile': return 'eval appears in this file; an eval string can rewrite any binding, so no function in the file is analyzed'
    case 'typeCheckSuppressed': return 'a @ts-ignore, @ts-expect-error, or @ts-nocheck comment turns off type checking in this file, so declared types cannot be trusted and no function is analyzed'
    case 'forLoopWithoutCondition': return 'for loop without a condition'
    case 'forLoopWithoutIncrementor': return 'for loop without an incrementor'
    case 'variableDeclarationShape': return 'variables without identifier names and initializers'
    case 'expressionForm': return `expression (${reason.syntax})`
    case 'statementForm': return `statement (${reason.syntax})`
  }
}

// A function's writes to its object parameters are effects the caller observes, so they get
// ensures lines like the return value does. Properties still holding the entry assumption
// (any finite number) are unchanged or unrestricted and stay silent.
function parameterWriteSummaries(fn: FunctionIR, heap: AbstractHeap, program: ProgramIR): string[] {
  const summaries: string[] = []
  for (let index = 0; index < fn.parameters.length; index++) {
    const parameter = fn.parameters[index]!
    if (parameter.type.kind !== 'object') continue
    const object = heap.find(candidate =>
      candidate.identity.kind === 'parameter' && candidate.identity.parameterIndex === index)
    if (object == null) continue
    for (const property of object.properties) {
      if (property.value.kind === 'number' && sameValues(property.value, finiteInputNumber())) continue
      summaries.push(...returnSummaries(`${parameter.name}.${property.name}`, property.value, heap, program))
    }
  }
  return summaries
}

function returnSummaries(path: string, value: AbstractValue, heap: AbstractHeap, program: ProgramIR): string[] {
  switch (value.kind) {
    case 'number': return [numberSummary(path, value, program)]
    case 'boolean': return [`${path} is ${value.canBeFalse ? (value.canBeTrue ? 'boolean' : 'false') : 'true'}`]
    case 'reference': {
      const summaries: string[] = []
      for (const property of referenceProperties(heap, value)) {
        summaries.push(...returnSummaries(`${path}.${property.name}`, property.value, heap, program))
      }
      return summaries
    }
    case 'void': return []
  }
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
  if (value.lower === -Number.MAX_VALUE && value.upper === Number.MAX_VALUE) return `${subject}${blame}`
  if (value.upper === Number.MAX_VALUE) return `${subject} at least ${formatNumber(value.lower)}${blame}`
  if (value.lower === -Number.MAX_VALUE) return `${subject} at most ${formatNumber(value.upper)}${blame}`
  return `${subject} from ${formatNumber(value.lower)} through ${formatNumber(value.upper)}${blame}`
}

// Infinite bounds are expected here; String renders them as 'Infinity'/'-Infinity'.
function formatNumber(value: number): string {
  return String(value)
}
