import {analyzeProgram} from './engine/analyze.ts'
import type {ProgramAnalysis} from './engine/outcome.ts'
import {createProjectIR, type ProgramIR} from './ir/program.ts'
import {lowerSource} from './lower/program.ts'
import type {CheckedSource} from './typescript/check.ts'

export type DetailedAnalysis = {
  program: ProgramIR
  analysis: ProgramAnalysis
}

// One file analyzed on its own: a one-module project in which calls to other files stay
// rejected.
export function analyzeCheckedSource(checked: CheckedSource, baseDirectory: string = process.cwd()): DetailedAnalysis {
  const program = lowerSource(checked, createProjectIR(baseDirectory), 0, null)
  const analysis = analyzeProgram(program)
  return {program, analysis}
}
