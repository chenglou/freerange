import {verifyFitFiles} from './src/reports.ts'
import {demoContractPaths} from './demo-contract-paths.ts'

const expectedPassCount = 125
const report = await verifyFitFiles(demoContractPaths)

if (report.phase !== 'ready' || report.summary.pass !== expectedPassCount) {
  console.error(JSON.stringify(report, null, 2))
}
if (report.phase !== 'ready') {
  process.exitCode = 1
} else if (report.summary.pass !== expectedPassCount) {
  console.error(`Expected ${expectedPassCount} passing demo checks, got ${report.summary.pass}`)
  process.exitCode = 1
} else {
  console.log(`demo contracts: ${report.summary.pass} pass, 0 fail, 0 unknown`)
}
