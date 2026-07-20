import type {AnalysisReport} from '../src/index.ts'

export function analyzedFunction(report: AnalysisReport, name: string) {
  const fn = report.functions.find(candidate => candidate.name === name)
  if (fn == null || fn.kind !== 'analyzed') throw new Error(`Expected ${name} to be analyzed`)
  return fn
}

// Most analyzer tests pin one particular requirement rule. Automatic finite-input
// contracts have their own focused suite, so those tests can keep asking only about the
// division, bounds, or written requirements they were built to exercise.
export function nonInputRequirements(report: AnalysisReport, name: string): string[] {
  return analyzedFunction(report, name).requires.filter(requirement => !requirement.includes('(input at '))
}
