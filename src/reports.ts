import {
  createFunctionContractCache,
  verifyFitProgram,
  verifyFitProgramWithCallsites,
} from './check-core.ts'
import type {FitCheck} from './check-types.ts'
import {
  buildFitSourceModule,
  loadFitProject,
} from './modules.ts'
import {readTopLevelGlobal} from './module-values.ts'

export type {FitCheck} from './check-types.ts'

export type FitCheckOptions = {
  annotationsOnly?: boolean
  failOnRequires?: boolean
}

export type FitCheckReport = {
  phase: 'ready' | 'error'
  files: string[]
  checks: FitCheck[]
  summary: {
    pass: number
    fail: number
    requires: number
    unknown: number
  }
}

export async function verifyFitFiles(paths: string[], options: FitCheckOptions = {}): Promise<FitCheckReport> {
  const annotationChecks: FitCheck[] = []
  const callsiteChecks: FitCheck[] = []
  const contractCache = createFunctionContractCache()
  const project = loadFitProject(paths, readTopLevelGlobal)
  if (options.annotationsOnly === true) {
    for (const program of project.entries) annotationChecks.push(...verifyFitProgram(program, contractCache))
  } else {
    for (const program of project.entries) {
      const result = verifyFitProgramWithCallsites(program, contractCache)
      annotationChecks.push(...result.annotationChecks)
      callsiteChecks.push(...result.callsiteChecks)
    }
  }
  const checks = mergeCheckReports(annotationChecks, callsiteChecks)

  const summary = {
    pass: checks.filter(check => check.status === 'pass').length,
    fail: checks.filter(check => check.status === 'fail').length,
    requires: checks.filter(check => check.status === 'requires').length,
    unknown: checks.filter(check => check.status === 'unknown').length,
  }
  const failOnRequires = options.failOnRequires ?? true
  return {
    phase: summary.fail === 0 && summary.unknown === 0 && (!failOnRequires || summary.requires === 0) ? 'ready' : 'error',
    files: paths,
    checks,
    summary,
  }
}

export function verifyFitSource(file: string, sourceText: string): FitCheck[] {
  const program = buildFitSourceModule(file, sourceText, readTopLevelGlobal)
  return verifyFitProgram(program, createFunctionContractCache())
}

function mergeCheckReports(primary: FitCheck[], secondary: FitCheck[]) {
  const seen = new Set(primary.map(checkKey))
  const checks = [...primary]
  for (const check of secondary) {
    const key = checkKey(check)
    if (seen.has(key)) continue
    seen.add(key)
    checks.push(check)
  }
  return checks
}

function checkKey(check: FitCheck) {
  return `${check.file}\0${check.line ?? ''}\0${check.functionName}\0${check.text}`
}
