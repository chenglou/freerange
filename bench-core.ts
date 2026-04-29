import {
  createFunctionContractCache,
  readTopLevelGlobal,
  verifyFitProgram,
  type FitCheck,
} from './src/check.ts'
import {
  createFitProjectLoadTiming,
  loadFitProject,
  type FitProjectLoadTiming,
} from './src/modules.ts'

export type BenchRun = {
  totalMs: number
  loadMs: number
  verifyMs: number
  loadTiming: FitProjectLoadTiming
  modules: number
  checks: FitCheck[]
}

export function runBench(paths: string[]): BenchRun {
  const totalStart = performance.now()
  const loadStart = performance.now()
  const loadTiming = createFitProjectLoadTiming()
  const project = loadFitProject(paths, readTopLevelGlobal, {timing: loadTiming})
  const loadMs = performance.now() - loadStart

  const verifyStart = performance.now()
  const contractCache = createFunctionContractCache()
  const checks: FitCheck[] = []
  for (const program of project.entries) checks.push(...verifyFitProgram(program, contractCache))
  const verifyMs = performance.now() - verifyStart

  return {
    totalMs: performance.now() - totalStart,
    loadMs,
    verifyMs,
    loadTiming,
    modules: project.modules.size,
    checks,
  }
}

export async function sourceLineCount(paths: string[]) {
  let total = 0
  for (const path of paths) {
    const text = await Bun.file(path).text()
    if (text.length === 0) continue
    total += (text.match(/\r\n|\r|\n/g)?.length ?? 0) + (text.endsWith('\n') || text.endsWith('\r') ? 0 : 1)
  }
  return total
}

export function formatSummary(checks: FitCheck[]) {
  const pass = checks.filter(check => check.status === 'pass').length
  const fail = checks.filter(check => check.status === 'fail').length
  const unknown = checks.filter(check => check.status === 'unknown').length
  return `${checks.length} checks (${pass} pass, ${fail} fail, ${unknown} unknown)`
}

export function formatMs(ms: number) {
  return `${ms.toFixed(1)}ms`
}

export function formatLoadTiming(timing: FitProjectLoadTiming, loadMs: number) {
  const known = timing.configMs
    + timing.typeProgramMs
    + timing.typeCheckerMs
    + timing.fileReadMs
    + timing.moduleParseMs
    + timing.importResolveMs
  const other = Math.max(0, loadMs - known)
  return [
    `config ${formatMs(timing.configMs)}`,
    `ts ${formatMs(timing.typeProgramMs)}`,
    `checker ${formatMs(timing.typeCheckerMs)}`,
    `read ${formatMs(timing.fileReadMs)}`,
    `parse/index ${formatMs(timing.moduleParseMs)}`,
    `resolve ${formatMs(timing.importResolveMs)}`,
    `other ${formatMs(other)}`,
  ].join(', ')
}

export function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
