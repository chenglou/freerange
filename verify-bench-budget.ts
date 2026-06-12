import {benchStats, formatMs, runBench} from './bench-core.ts'
import {demoContractPaths} from './demo-contract-paths.ts'

const runs = 4
const maxWarmMedianTotalMs = 2900
// The loop analysis evaluates each loop body several times by design: once
// generalized, usually once narrowed, once for reporting. Demo verify went
// from ~1050ms to ~1500ms when that landed. The float-soundness gate added
// the rounded-op proof rules, the eager monotone facts, and the exactness
// window checks (~2100ms warm verify); the budget keeps similar headroom.
const maxWarmMedianVerifyMs = 2400
const maxWarmSingleRunMs = 5000

const benchRuns = Array.from({length: runs}, () => runBench(demoContractPaths))
const stats = benchStats(benchRuns)
const checks = benchRuns.at(-1)?.checks ?? []
const pass = checks.filter(check => check.status === 'pass').length
const fail = checks.filter(check => check.status === 'fail').length
const requires = checks.filter(check => check.status === 'requires').length
const unknown = checks.filter(check => check.status === 'unknown').length

console.log([
  `bench budget: ${runs} runs`,
  `cold ${formatMs(stats.cold.totalMs)} total (${formatMs(stats.cold.loadMs)} load, ${formatMs(stats.cold.verifyMs)} verify)`,
  `warm median ${formatMs(stats.warmMedianTotalMs)} total (${formatMs(stats.warmMedianLoadMs)} load, ${formatMs(stats.warmMedianVerifyMs)} verify)`,
  `warm slowest ${formatMs(stats.warmSlowestTotalMs)}`,
  `${pass} pass, ${fail} fail, ${requires} requires, ${unknown} unknown`,
].join(', '))

if (fail > 0 || requires > 0 || unknown > 0) {
  console.error('bench budget expected demo contracts to stay clean')
  process.exitCode = 1
}
if (stats.warmMedianTotalMs > maxWarmMedianTotalMs) {
  console.error(`bench budget warm median total exceeded ${formatMs(maxWarmMedianTotalMs)}`)
  process.exitCode = 1
}
if (stats.warmMedianVerifyMs > maxWarmMedianVerifyMs) {
  console.error(`bench budget warm median verify exceeded ${formatMs(maxWarmMedianVerifyMs)}`)
  process.exitCode = 1
}
if (stats.warmSlowestTotalMs > maxWarmSingleRunMs) {
  console.error(`bench budget warm slowest run exceeded ${formatMs(maxWarmSingleRunMs)}`)
  process.exitCode = 1
}
