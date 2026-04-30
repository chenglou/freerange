import {
  average,
  benchStats,
  type BenchRun,
  formatLoadTiming,
  formatMs,
  formatSummary,
  median,
  runBench,
  sourceLineCount,
} from './bench-core.ts'
import {demoContractPaths} from './demo-contract-paths.ts'

type BenchOptions = {
  paths: string[]
  runs: number
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
    const stats = benchStats(runs)
    console.log(`cold: ${formatMs(stats.cold.totalMs)} total (${formatMs(stats.cold.loadMs)} load, ${formatMs(stats.cold.verifyMs)} verify)`)
    console.log(`warm median: ${formatMs(stats.warmMedianTotalMs)} total (${formatMs(stats.warmMedianLoadMs)} load, ${formatMs(stats.warmMedianVerifyMs)} verify) over ${stats.warmRuns.length} run${stats.warmRuns.length === 1 ? '' : 's'}`)
    console.log(`median: ${formatMs(median(runs.map(run => run.totalMs)))} total`)
    console.log(`average: ${formatMs(average(runs.map(run => run.totalMs)))} total`)
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
