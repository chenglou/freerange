import {readFileSync} from 'node:fs'
import {analyzeProgram} from './analyze.ts'
import {lowerSource} from './lower.ts'
import {createReport, type AnalysisReport} from './report.ts'

export function analyzeFile(file: string): AnalysisReport {
  return analyzeSource(file, readFileSync(file, 'utf8'))
}

export function analyzeSource(file: string, source: string): AnalysisReport {
  return createReport(analyzeProgram(lowerSource(file, source)))
}

export {formatReport} from './report.ts'
export type {AnalysisReport} from './report.ts'
