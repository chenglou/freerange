import type {AbstractNumber} from '../domain/number.ts'
import type {AbstractValue} from '../domain/value.ts'
import type {FunctionAnalysis, ProgramAnalysis, Stop} from '../engine/outcome.ts'
import type {AbstractHeap} from '../heap/model.ts'
import {referenceProperties} from '../heap/operations.ts'
import type {SiteID} from '../ir/ids.ts'
import {siteLocation, type FunctionIR, type ProgramIR, type UnsupportedReason} from '../ir/program.ts'
import {formatObservedNeed, formatPrecondition} from './format-requirement.ts'

export type FunctionReport =
  | {kind: 'analyzed'; name: string; assumptions: string[]; requires: string[]; ensures: string[]}
  // e.g. 'unknown identifier scheduledRender at /abs/demo/index.ts:6:7'
  | {kind: 'unsupported'; name: string; unsupported: string}
  // Some path stopped; `observed` lines are evidence from the paths that completed, never a
  // contract. e.g. stopped: 'recursive call to countdown (call at /abs/file.ts:3:10)',
  // observed: 'return is a finite integer number from 0 through 0'.
  | {kind: 'partial'; name: string; assumptions: string[]; stopped: string[]; observed: string[]}

export type AnalysisReport = {
  file: string
  functions: FunctionReport[]
}

export function createReport(program: ProgramIR, analysis: ProgramAnalysis): AnalysisReport {
  const functions: FunctionReport[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const lowering = program.functions[functionID]!
    const fn = analysis.functions[functionID]
    if (fn == null) throw new Error(`Missing analysis entry for ${lowering.name}`)
    switch (fn.kind) {
      case 'notLowered': {
        if (lowering.kind !== 'unsupported') throw new Error(`${lowering.name} was lowered but not analyzed`)
        functions.push({
          kind: 'unsupported',
          name: lowering.name,
          unsupported: `${formatUnsupportedReason(lowering.reason)} at ${formatSite(program, lowering.site)}`,
        })
        break
      }
      case 'partial': {
        if (lowering.kind !== 'lowered') throw new Error(`${lowering.name} was analyzed without lowering`)
        const parameterNames = lowering.parameters.map(parameter => parameter.name)
        const observed: string[] = []
        if (fn.observedReturn != null) {
          observed.push(...returnSummaries('return', fn.observedReturn.value, fn.observedReturn.heap))
        }
        for (const need of fn.observedNeeds) observed.push(formatObservedNeed(need, parameterNames, program))
        functions.push({
          kind: 'partial',
          name: lowering.name,
          assumptions: assumptionLines(lowering),
          stopped: fn.stops.map(stop => formatStop(stop, program, analysis)),
          observed,
        })
        break
      }
      case 'analyzed': {
        if (lowering.kind !== 'lowered') throw new Error(`${lowering.name} was analyzed without lowering`)
        const parameterNames = lowering.parameters.map(parameter => parameter.name)
        functions.push({
          kind: 'analyzed',
          name: lowering.name,
          assumptions: assumptionLines(lowering),
          requires: fn.preconditions.map(precondition => formatPrecondition(precondition, parameterNames, program)),
          ensures: returnSummaries('return', fn.returnValue, fn.sharedState.heap),
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
        for (const evidence of fn.observed) lines.push(`  on analyzed paths: ${evidence}`)
        break
      }
    }
  }
  return lines.join('\n')
}

function assumptionLines(fn: FunctionIR): string[] {
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
  return assumptions
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
  }
}

function calleeStateText(callee: FunctionAnalysis | undefined): string {
  if (callee == null) return 'whose analysis stopped'
  switch (callee.kind) {
    case 'notLowered': return 'which hit unsupported code'
    case 'partial': return 'whose analysis stopped'
    // The callee analyzes completely for general inputs but stopped under this caller's
    // arguments (e.g. an argument whose expression the requirement language cannot name).
    case 'analyzed': return 'whose analysis stopped for these arguments'
  }
}

function functionName(program: ProgramIR, callee: number): string {
  const fn = program.functions[callee]
  if (fn == null) throw new Error(`Unknown function ${callee}`)
  return fn.name
}

function formatSite(program: ProgramIR, site: SiteID): string {
  const {line, column} = siteLocation(program, site)
  return `${program.file}:${line}:${column}`
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
    case 'nonNumberOperand': return `non-number operand of type ${reason.typeText}`
    case 'nonBooleanCondition': return `condition of type ${reason.typeText}`
    case 'valueType': return `value of type ${reason.typeText}`
    case 'propertyReadOnNonObject': return `property read from ${reason.typeText}`
    case 'statementAfterReturn': return 'statements after return'
    case 'forLoopWithoutCondition': return 'for loop without a condition'
    case 'forLoopWithoutIncrementor': return 'for loop without an incrementor'
    case 'variableDeclarationShape': return 'variables without identifier names and initializers'
    case 'expressionForm': return `expression (${reason.syntax})`
    case 'statementForm': return `statement (${reason.syntax})`
  }
}

function returnSummaries(path: string, value: AbstractValue, heap: AbstractHeap): string[] {
  switch (value.kind) {
    case 'number': return [numberSummary(path, value)]
    case 'boolean': return [`${path} is boolean`]
    case 'reference': {
      const summaries: string[] = []
      for (const property of referenceProperties(heap, value)) {
        summaries.push(...returnSummaries(`${path}.${property.name}`, property.value, heap))
      }
      return summaries
    }
    case 'void': return []
  }
}

function numberSummary(path: string, value: AbstractNumber): string {
  const kind = value.integer ? 'integer ' : ''
  const domain = value.finite && !value.mayBeNaN ? 'finite ' : 'possibly non-finite '
  const subject = `${path} is a ${domain}${kind}number`
  if (value.lower === -Number.MAX_VALUE && value.upper === Number.MAX_VALUE) return subject
  if (value.upper === Number.MAX_VALUE) return `${subject} at least ${formatNumber(value.lower)}`
  if (value.lower === -Number.MAX_VALUE) return `${subject} at most ${formatNumber(value.upper)}`
  return `${subject} from ${formatNumber(value.lower)} through ${formatNumber(value.upper)}`
}

function formatNumber(value: number): string {
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  return String(value)
}
