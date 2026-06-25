import {analyzeProgram} from './analyze.ts'
import {lowerSource} from './lower.ts'
import {createReport, type AnalysisReport} from './report.ts'
import {checkFile, checkSource} from './typescript.ts'

export function analyzeFile(file: string): AnalysisReport {
  return createReport(analyzeProgram(lowerSource(checkFile(file))))
}

export function analyzeSource(file: string, source: string): AnalysisReport {
  return createReport(analyzeProgram(lowerSource(checkSource(file, source))))
}

export {formatReport} from './report.ts'
export type {AnalysisReport} from './report.ts'
