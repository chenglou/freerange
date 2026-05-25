import {
  corpusRoot,
  corpusRootExists,
  discoverCorpusSweeps,
  type CorpusSweep,
} from './corpus-probes.ts'
import {type FitCheck, verifyFitFiles} from './src/reports.ts'
import {verifySnapshot} from './snapshot.ts'

const expectedPath = 'corpus-probes.expected.txt'
const sweeps = discoverCorpusSweeps()

if (!corpusRootExists()) {
  console.log(`corpus probes: skipped, missing ${corpusRoot}`)
} else {
  const bodyLines: string[] = []
  const totals = emptyTotals()
  let clean = true

  if (sweeps.length === 0) bodyLines.push('no corpus @fit files found')
  for (const sweep of sweeps) {
    const result = await addSweep(bodyLines, sweep)
    addTotals(totals, result.totals)
    clean &&= result.clean
  }

  const lines = [
    formatTotals(sweeps.length, totals),
    '',
    ...bodyLines,
  ]
  const snapshotMatched = await verifySnapshot(expectedPath, lines.join('\n'), 'corpus probes')
  if (!snapshotMatched || !clean) process.exitCode = 1
}

async function addSweep(lines: string[], sweep: CorpusSweep) {
  lines.push(`${sweep.name}: ${sweep.paths.length} files`)
  for (const path of sweep.paths) lines.push(`  ${displayFile(path)}`)

  const checkReport = await verifyFitFiles(sweep.paths, {failOnRequires: false})
  lines.push(`  check: ${checkReport.summary.pass} pass, ${checkReport.summary.fail} fail, ${checkReport.summary.requires} requires, ${checkReport.summary.unknown} unknown`)
  lines.push(...formatNonPassChecks(checkReport.checks))

  return {
    clean: checkReport.summary.fail === 0,
    totals: {
      files: sweep.paths.length,
      checkPass: checkReport.summary.pass,
      checkFail: checkReport.summary.fail,
      checkRequires: checkReport.summary.requires,
      checkUnknown: checkReport.summary.unknown,
    },
  }
}

type CorpusTotals = ReturnType<typeof emptyTotals>

function emptyTotals() {
  return {
    files: 0,
    checkPass: 0,
    checkFail: 0,
    checkRequires: 0,
    checkUnknown: 0,
  }
}

function addTotals(totals: CorpusTotals, addition: CorpusTotals) {
  totals.files += addition.files
  totals.checkPass += addition.checkPass
  totals.checkFail += addition.checkFail
  totals.checkRequires += addition.checkRequires
  totals.checkUnknown += addition.checkUnknown
}

function formatTotals(groups: number, totals: CorpusTotals) {
  return [
    `summary: ${groups} groups, ${totals.files} files`,
    `check: ${totals.checkPass} pass, ${totals.checkFail} fail, ${totals.checkRequires} requires, ${totals.checkUnknown} unknown`,
  ].join('; ')
}

function displayFile(file: string) {
  const prefix = `${corpusRoot}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function formatNonPassChecks(checks: FitCheck[]) {
  const lines: string[] = []
  for (const check of checks) {
    if (check.status === 'pass') continue
    const location = `${displayFile(check.file)}${check.line == null ? '' : `:${check.line}`}`
    lines.push(`    ${check.status.toUpperCase()} ${location}:${check.functionName}: ${check.text}`)
    const firstReasonLine = check.reason?.split('\n')[0]
    if (firstReasonLine != null && firstReasonLine !== '') lines.push(`      ${firstReasonLine}`)
  }
  return lines
}
