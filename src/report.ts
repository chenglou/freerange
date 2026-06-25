import type {ProgramAnalysis} from './analyze.ts'
import type {AbstractNumber} from './domain.ts'

export type FunctionReport = {
  name: string
  assumptions: string[]
  ensures: string[]
  obligations: ProgramAnalysis['functions'][number]['obligations']
}

export type AnalysisReport = {
  file: string
  functions: FunctionReport[]
}

export function createReport(analysis: ProgramAnalysis): AnalysisReport {
  return {
    file: analysis.file,
    functions: analysis.functions.map(fn => ({
      name: fn.name,
      assumptions: fn.parameters.map(parameter => `${parameter} is finite and not NaN`),
      ensures: [returnSummary(fn.returnValue)],
      obligations: fn.obligations,
    })),
  }
}

export function formatReport(report: AnalysisReport): string {
  const lines: string[] = [report.file]
  for (const fn of report.functions) {
    lines.push('', fn.name)
    for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
    for (const guarantee of fn.ensures) lines.push(`  ensures: ${guarantee}`)
    for (const obligation of fn.obligations.filter(item => item.status !== 'proved')) {
      lines.push(`  unknown: ${obligation.description} (${obligation.span.line}:${obligation.span.column})`)
    }
  }
  return lines.join('\n')
}

function returnSummary(value: AbstractNumber): string {
  const kind = value.integer ? 'integer ' : ''
  const domain = value.finite && !value.mayBeNaN ? 'finite ' : 'possibly non-finite '
  return `return is a ${domain}${kind}number from ${formatNumber(value.lower)} through ${formatNumber(value.upper)}`
}

function formatNumber(value: number): string {
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  return String(value)
}
