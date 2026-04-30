import {
  corpusRoot,
  corpusRootExists,
  discoverCorpusSweeps,
  type CorpusSweep,
} from './corpus-probes.ts'
import {doctorFitFiles, verifyFitFiles} from './src/reports.ts'
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

  const checkReport = await verifyFitFiles(sweep.paths)
  lines.push(`  check: ${checkReport.summary.pass} pass, ${checkReport.summary.fail} fail, ${checkReport.summary.unknown} unknown`)

  const doctorReport = await doctorFitFiles(sweep.paths)
  lines.push(`  doctor: ${doctorReport.summary.pass} pass, ${doctorReport.summary.fail} fail, ${doctorReport.summary.requires} requires, ${doctorReport.summary.unknown} unknown`)

  return {
    clean: checkReport.summary.fail === 0
      && checkReport.summary.unknown === 0
      && doctorReport.summary.fail === 0
      && doctorReport.summary.unknown === 0,
    totals: {
      files: sweep.paths.length,
      checkPass: checkReport.summary.pass,
      checkFail: checkReport.summary.fail,
      checkUnknown: checkReport.summary.unknown,
      doctorPass: doctorReport.summary.pass,
      doctorFail: doctorReport.summary.fail,
      doctorRequires: doctorReport.summary.requires,
      doctorUnknown: doctorReport.summary.unknown,
    },
  }
}

type CorpusTotals = ReturnType<typeof emptyTotals>

function emptyTotals() {
  return {
    files: 0,
    checkPass: 0,
    checkFail: 0,
    checkUnknown: 0,
    doctorPass: 0,
    doctorFail: 0,
    doctorRequires: 0,
    doctorUnknown: 0,
  }
}

function addTotals(totals: CorpusTotals, addition: CorpusTotals) {
  totals.files += addition.files
  totals.checkPass += addition.checkPass
  totals.checkFail += addition.checkFail
  totals.checkUnknown += addition.checkUnknown
  totals.doctorPass += addition.doctorPass
  totals.doctorFail += addition.doctorFail
  totals.doctorRequires += addition.doctorRequires
  totals.doctorUnknown += addition.doctorUnknown
}

function formatTotals(groups: number, totals: CorpusTotals) {
  return [
    `summary: ${groups} groups, ${totals.files} files`,
    `check: ${totals.checkPass} pass, ${totals.checkFail} fail, ${totals.checkUnknown} unknown`,
    `doctor: ${totals.doctorPass} pass, ${totals.doctorFail} fail, ${totals.doctorRequires} requires, ${totals.doctorUnknown} unknown`,
  ].join('; ')
}

function displayFile(file: string) {
  const prefix = `${corpusRoot}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}
