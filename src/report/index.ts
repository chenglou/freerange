import type {AbstractNumber} from '../domain/number.ts'
import type {AbstractValue} from '../domain/value.ts'
import type {ProgramAnalysis} from '../engine/outcome.ts'
import type {AbstractHeap} from '../heap/model.ts'
import {formatPrecondition} from './format-requirement.ts'

type FunctionReport = {
  name: string
  assumptions: string[]
  requires: string[]
  ensures: string[]
}

export type AnalysisReport = {
  file: string
  functions: FunctionReport[]
}

export function createReport(analysis: ProgramAnalysis): AnalysisReport {
  return {
    file: analysis.file,
    functions: analysis.functions.map(fn => {
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
        name: fn.name,
        assumptions,
        requires: fn.preconditions.map(precondition => formatPrecondition(precondition, parameterNames)),
        ensures: returnSummaries('return', fn.returnValue, fn.sharedState.heap),
      }
    }),
  }
}

export function formatReport(report: AnalysisReport): string {
  const lines: string[] = [report.file]
  for (const fn of report.functions) {
    lines.push('', fn.name)
    for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
    for (const precondition of fn.requires) lines.push(`  requires: ${precondition}`)
    for (const guarantee of fn.ensures) lines.push(`  ensures: ${guarantee}`)
  }
  return lines.join('\n')
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
