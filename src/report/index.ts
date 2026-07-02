import type {AbstractNumber} from '../domain/number.ts'
import type {AbstractValue} from '../domain/value.ts'
import type {FunctionAnalysis, ProgramAnalysis} from '../engine/outcome.ts'
import type {AbstractHeap} from '../heap/model.ts'
import type {SiteID} from '../ir/ids.ts'
import {siteLocation, type ProgramIR, type UnsupportedReason} from '../ir/program.ts'
import {formatPrecondition} from './format-requirement.ts'

export type FunctionReport =
  | {kind: 'analyzed'; name: string; assumptions: string[]; requires: string[]; ensures: string[]}
  // e.g. 'unknown identifier scheduledRender at /abs/demo/index.ts:6:7'
  | {kind: 'unsupported'; name: string; unsupported: string}
  // The function lowered, but a call in its body reaches a function that hit unsupported
  // code, e.g. 'calls remainderWidth, which hit unsupported code (call at /abs/file.ts:3:16)'
  // — or, when the callee was itself only skipped, 'calls middleWidth, which was itself
  // skipped (call at …)'. Each entry names one hop; the chain is walkable across entries.
  | {kind: 'skipped'; name: string; skipped: string}

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
      case 'blockedByCallee': {
        const callee = program.functions[fn.callee]
        if (callee == null) throw new Error(`Unknown function ${fn.callee}`)
        // A merely skipped callee did not itself hit unsupported code; saying so would send
        // an agent hunting through a body whose constructs all lower.
        const calleeState = analysis.functions[fn.callee]?.kind === 'blockedByCallee'
          ? 'which was itself skipped'
          : 'which hit unsupported code'
        functions.push({
          kind: 'skipped',
          name: lowering.name,
          skipped: `calls ${callee.name}, ${calleeState} (call at ${formatSite(program, fn.site)})`,
        })
        break
      }
      case 'analyzed': {
        functions.push(analyzedReport(fn, program))
        break
      }
    }
  }
  return {file: program.file, functions}
}

function analyzedReport(fn: Extract<FunctionAnalysis, {kind: 'analyzed'}>, program: ProgramIR): FunctionReport {
  const assumptions: string[] = []
  const parameterNames = fn.parameters.map(parameter => parameter.name)
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
  return {
    kind: 'analyzed',
    name: fn.name,
    assumptions,
    requires: fn.preconditions.map(precondition => formatPrecondition(precondition, parameterNames, program)),
    ensures: returnSummaries('return', fn.returnValue, fn.sharedState.heap),
  }
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
      case 'skipped': {
        lines.push(`  skipped: ${fn.skipped}`)
        break
      }
    }
  }
  return lines.join('\n')
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
      const object = heap[value.allocation]
      if (object == null) throw new Error(`Missing returned heap allocation ${value.allocation}`)
      const summaries: string[] = []
      for (const property of object.properties) {
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
