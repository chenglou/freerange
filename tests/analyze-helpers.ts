import type {AnalysisReport} from '../src/index.ts'

export function analyzedFunction(report: AnalysisReport, name: string) {
  const fn = report.functions.find(candidate => candidate.name === name)
  if (fn == null || fn.kind !== 'analyzed') throw new Error(`Expected ${name} to be analyzed`)
  return fn
}

export function requirementsBesidesInputFiniteness(
  fn: ReturnType<typeof analyzedFunction>,
): string[] {
  return fn.requires.filter(requirement => !requirement.includes(' (input at '))
}
