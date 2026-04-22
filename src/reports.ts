import {
  createFunctionContractCache,
  doctorFitProgram,
  readTopLevelNumberGlobal,
  verifyFitProgram,
  type FitCheck,
  type FitDoctorCheck,
} from './check.ts'
import {
  buildFitSourceModule,
  loadFitProject,
} from './modules.ts'

export type {FitCheck, FitDoctorCheck} from './check.ts'

export type FitCheckReport = {
  phase: 'ready' | 'error'
  files: string[]
  checks: FitCheck[]
  summary: {
    pass: number
    fail: number
    unknown: number
  }
}

export type FitDoctorReport = {
  phase: 'ready' | 'error'
  files: string[]
  checks: FitDoctorCheck[]
  summary: {
    pass: number
    fail: number
    requires: number
    unknown: number
  }
}

export async function verifyFitFiles(paths: string[]): Promise<FitCheckReport> {
  const checks: FitCheck[] = []
  const contractCache = createFunctionContractCache()
  const project = loadFitProject(paths, readTopLevelNumberGlobal)
  for (const program of project.entries) checks.push(...verifyFitProgram(program, contractCache))

  const summary = {
    pass: checks.filter(check => check.status === 'pass').length,
    fail: checks.filter(check => check.status === 'fail').length,
    unknown: checks.filter(check => check.status === 'unknown').length,
  }
  return {
    phase: summary.fail === 0 && summary.unknown === 0 ? 'ready' : 'error',
    files: paths,
    checks,
    summary,
  }
}

export async function doctorFitFiles(paths: string[]): Promise<FitDoctorReport> {
  const checks: FitDoctorCheck[] = []
  const contractCache = createFunctionContractCache()
  const project = loadFitProject(paths, readTopLevelNumberGlobal)
  for (const program of project.entries) checks.push(...doctorFitProgram(program, contractCache))

  const summary = {
    pass: checks.filter(check => check.status === 'pass').length,
    fail: checks.filter(check => check.status === 'fail').length,
    requires: checks.filter(check => check.status === 'requires').length,
    unknown: checks.filter(check => check.status === 'unknown').length,
  }
  return {
    phase: summary.fail === 0 ? 'ready' : 'error',
    files: paths,
    checks,
    summary,
  }
}

export function verifyFitSource(file: string, sourceText: string): FitCheck[] {
  const program = buildFitSourceModule(file, sourceText, readTopLevelNumberGlobal)
  return verifyFitProgram(program, createFunctionContractCache())
}
