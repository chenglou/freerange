import {analyzeProgram} from './engine/analyze.ts'
import {lowerSource} from './lower/program.ts'
import {createReport, type AnalysisReport} from './report/index.ts'
import {checkFile, checkSource} from './typescript/check.ts'

export function analyzeFile(file: string, baseDirectory?: string): AnalysisReport {
  const program = lowerSource(checkFile(file), baseDirectory)
  return createReport(program, analyzeProgram(program))
}

export function analyzeSource(file: string, source: string): AnalysisReport {
  const program = lowerSource(checkSource(file, source))
  return createReport(program, analyzeProgram(program))
}

export {formatReport} from './report/index.ts'
export type {AnalysisReport} from './report/index.ts'
