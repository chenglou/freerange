import {inferFitFiles, inspectFitShapes} from './src/check.ts'
import {doctorFitFiles, verifyFitFiles} from './src/reports.ts'
import {displayWorkspaceFile, verifySnapshot} from './snapshot.ts'

const expectedPath = 'differential-snapshots.expected.txt'
const lines: string[] = []

await addCheckSummary('positive patterns', ['patterns.ts', 'import-patterns.ts', 'interpreter-matrix-patterns.ts'])
await addCheckSummary('negative patterns', ['negative-patterns.ts', 'negative-import-patterns.ts', 'interpreter-matrix-negative.ts'])
await addCheckSummary('photo-gallery type fields', ['photo-gallery/index.ts'])
await addDoctorSummary('photo-gallery calls', ['photo-gallery/index.ts'])
addInferSummary('map block rows', ['patterns.ts'], 'mapBlockRowsWithDestructure')
addInferSummary('interpreter matrix', ['interpreter-matrix-patterns.ts'], 'matrixNestedIifeMapDefaults')
addShapeSummary('property access call shape', ['patterns.ts'], 'propertyAccessCallShape')

if (!await verifySnapshot(expectedPath, lines.join('\n'), 'differential snapshots')) process.exitCode = 1

async function addCheckSummary(label: string, paths: string[]) {
  const report = await verifyFitFiles(paths)
  lines.push(`check ${label}: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.unknown} unknown`)
  for (const check of report.checks.filter(check => check.status !== 'pass').slice(0, 12)) {
    lines.push(`  ${check.status.toUpperCase()} ${displayWorkspaceFile(check.file)}:${check.functionName}: ${check.text}`)
  }
}

async function addDoctorSummary(label: string, paths: string[]) {
  const report = await doctorFitFiles(paths)
  lines.push(`doctor ${label}: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.requires} requires, ${report.summary.unknown} unknown`)
  for (const check of report.checks.filter(check => check.status !== 'pass').slice(0, 12)) {
    lines.push(`  ${check.status.toUpperCase()} ${displayWorkspaceFile(check.file)}:${check.functionName}: ${check.text}`)
  }
}

function addInferSummary(label: string, paths: string[], functionName: string) {
  const fn = inferFitFiles(paths, {functionName}).functions[0]
  lines.push(`infer ${label}: ${displayWorkspaceFile(paths[0]!)}:${functionName}`)
  if (fn == null) {
    lines.push('  missing')
    return
  }
  for (const fact of fn.facts.map(fact => fact.text).slice(0, 16)) lines.push(`  ${fact}`)
}

function addShapeSummary(label: string, paths: string[], functionName: string) {
  const report = inspectFitShapes(paths, {functionName})
  lines.push(`shape ${label}: ${displayWorkspaceFile(paths[0]!)}:${functionName}`)
  for (const insight of report.insights.slice(0, 8)) {
    lines.push(`  ${insight.subject}`)
    for (const fact of insight.freerange.slice(0, 8)) lines.push(`    freerange ${fact}`)
    for (const fact of insight.typescript.slice(0, 8)) lines.push(`    typescript ${fact}`)
  }
}
