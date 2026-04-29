import {formatMs, median, runBench} from './bench-core.ts'
import {demoContractPaths} from './demo-contract-paths.ts'

const runs = 3
const maxMedianMs = 2500
const maxSingleRunMs = 5000

const benchRuns = Array.from({length: runs}, () => runBench(demoContractPaths))
const totals = benchRuns.map(run => run.totalMs)
const medianMs = median(totals)
const slowestMs = Math.max(...totals)
const checks = benchRuns.at(-1)?.checks ?? []
const pass = checks.filter(check => check.status === 'pass').length
const fail = checks.filter(check => check.status === 'fail').length
const unknown = checks.filter(check => check.status === 'unknown').length

console.log(`bench budget: ${runs} runs, median ${formatMs(medianMs)}, slowest ${formatMs(slowestMs)}, ${pass} pass, ${fail} fail, ${unknown} unknown`)

if (fail > 0 || unknown > 0) {
  console.error('bench budget expected demo contracts to stay clean')
  process.exitCode = 1
}
if (medianMs > maxMedianMs) {
  console.error(`bench budget median exceeded ${formatMs(maxMedianMs)}`)
  process.exitCode = 1
}
if (slowestMs > maxSingleRunMs) {
  console.error(`bench budget slowest run exceeded ${formatMs(maxSingleRunMs)}`)
  process.exitCode = 1
}
