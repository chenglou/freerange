import {analyzeProgram} from './engine/analyze.ts'
import {lowerSource} from './lower/program.ts'
import {createReport, type AnalysisReport} from './report/index.ts'
import {checkFile, checkSource} from './typescript/check.ts'

export function analyzeFile(file: string): AnalysisReport {
  return createReport(analyzeProgram(lowerSource(checkFile(file))))
}

export function analyzeSource(file: string, source: string): AnalysisReport {
  return createReport(analyzeProgram(lowerSource(checkSource(file, source))))
}

export {formatReport} from './report/index.ts'
export type {AnalysisReport} from './report/index.ts'
