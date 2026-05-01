import {verifyFitFiles} from './src/reports.ts'
import {demoContractPaths} from './demo-contract-paths.ts'
import {displayWorkspaceFile, verifySnapshot} from './snapshot.ts'

const expectedPath = 'demo-contracts.expected.txt'
const report = await verifyFitFiles(demoContractPaths, {annotationsOnly: true})

if (report.phase !== 'ready') {
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
} else if (!await verifySnapshot(expectedPath, formatDemoContractSnapshot(), 'demo contracts')) {
  process.exitCode = 1
} else {
  console.log(`demo contracts: ${report.summary.pass} pass, 0 fail, 0 requires, 0 unknown`)
}

function formatDemoContractSnapshot() {
  return [
    `summary: ${report.files.length} files, ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.requires} requires, ${report.summary.unknown} unknown`,
    ...report.checks.map(check => {
      const line = check.line == null ? '' : `:${check.line}`
      return `${check.status.toUpperCase()} ${displayWorkspaceFile(check.file)}${line}:${check.functionName}: ${check.text}`
    }),
  ].join('\n')
}
