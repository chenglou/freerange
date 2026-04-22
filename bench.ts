import {
  createFunctionContractCache,
  readTopLevelNumberGlobal,
  verifyFitProgram,
  type FitCheck,
} from './src/check.ts'
import {
  createFitProjectLoadTiming,
  loadFitProject,
  type FitProjectLoadTiming,
} from './src/modules.ts'
import {demoContractPaths} from './demo-contract-paths.ts'

type BenchOptions = {
  paths: string[]
  runs: number
}

type BenchRun = {
  totalMs: number
  loadMs: number
  verifyMs: number
  loadTiming: FitProjectLoadTiming
  modules: number
  checks: FitCheck[]
}

const args = Bun.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  printHelp()
} else {
  const options = parseBenchArgs(args)
  const paths = options.paths.length === 0 ? demoContractPaths : options.paths
  const label = options.paths.length === 0 ? 'demo contracts' : 'custom files'
  const lineCount = await sourceLineCount(paths)

  console.log(`bench: ${label}`)
  console.log(`files: ${paths.length} entry, ${lineCount} lines`)

  const runs: BenchRun[] = []
  for (let index = 0; index < options.runs; index++) {
    const run = runBench(paths)
    runs.push(run)
    console.log(`run ${index + 1}: ${formatMs(run.totalMs)} total (${formatMs(run.loadMs)} load, ${formatMs(run.verifyMs)} verify) - ${formatSummary(run.checks)}, ${run.modules} modules`)
    console.log(`  load: ${formatLoadTiming(run.loadTiming, run.loadMs)}`)
  }

  if (runs.length > 1) {
    console.log(`median: ${formatMs(median(runs.map(run => run.totalMs)))} total`)
    console.log(`average: ${formatMs(average(runs.map(run => run.totalMs)))} total`)
  }
}

function runBench(paths: string[]): BenchRun {
  const totalStart = performance.now()
  const loadStart = performance.now()
  const loadTiming = createFitProjectLoadTiming()
  const project = loadFitProject(paths, readTopLevelNumberGlobal, {timing: loadTiming})
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

function parseBenchArgs(args: string[]): BenchOptions {
  const paths: string[] = []
  let runs = 1
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--runs') {
      const value = args[index + 1]
      if (value == null) throw new Error('--runs needs a number')
      runs = parseRuns(value)
      index++
      continue
    }
    if (arg.startsWith('--runs=')) {
      runs = parseRuns(arg.slice('--runs='.length))
      continue
    }
    paths.push(arg)
  }
  return {paths, runs}
}

function parseRuns(text: string) {
  const runs = Number(text)
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${text}`)
  return runs
}

function printHelp() {
  console.log([
    'Usage: bun run bench [--runs N] [path ...]',
    '',
    'Without paths, benchmarks the current sibling demo contract set.',
  ].join('\n'))
}

async function sourceLineCount(paths: string[]) {
  let total = 0
  for (const path of paths) {
    const text = await Bun.file(path).text()
    if (text.length === 0) continue
    total += (text.match(/\r\n|\r|\n/g)?.length ?? 0) + (text.endsWith('\n') || text.endsWith('\r') ? 0 : 1)
  }
  return total
}

function formatSummary(checks: FitCheck[]) {
  const pass = checks.filter(check => check.status === 'pass').length
  const fail = checks.filter(check => check.status === 'fail').length
  const unknown = checks.filter(check => check.status === 'unknown').length
  return `${checks.length} checks (${pass} pass, ${fail} fail, ${unknown} unknown)`
}

function formatMs(ms: number) {
  return `${ms.toFixed(1)}ms`
}

function formatLoadTiming(timing: FitProjectLoadTiming, loadMs: number) {
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

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
