import {analyzeProgram} from './engine/analyze.ts'
import type {ProgramAnalysis} from './engine/outcome.ts'
import type {ProgramIR} from './ir/program.ts'
import {lowerSource} from './lower/program.ts'
import type {CheckedSource} from './typescript/check.ts'

export type DetailedAnalysis = {
  program: ProgramIR
  analysis: ProgramAnalysis
}

export function analyzeCheckedSource(checked: CheckedSource, baseDirectory?: string): DetailedAnalysis {
  const program = lowerSource(checked, baseDirectory)
  const analysis = analyzeProgram(program)
  return {program, analysis}
}
