import {inferFitFiles, inspectFitShapes} from './src/check.ts'
import {verifyFitFiles} from './src/reports.ts'
import {displayWorkspaceFile, verifySnapshot} from './snapshot.ts'

const expectedPath = 'eval-snapshots.expected.txt'

const lines: string[] = []

await addCheckCase(
  'photo-gallery spring defaults through imported data',
  ['photo-gallery/index.ts'],
  text => text.includes('data[].sizeX.k > 0')
    || text.includes('data[].sizeX.b > 0')
    || text.includes('data[].fxFactor.k > 0')
    || text.includes('data[].fxFactor.b > 0'),
)

addInferCase('matrix nested iife/map/defaults', ['interpreter-matrix-patterns.ts'], 'matrixNestedIifeMapDefaults')
addInferCase('matrix default param order', ['interpreter-matrix-patterns.ts'], 'matrixDefaultParamOrder')
addInferCase('matrix for-of push visible rows', ['interpreter-matrix-patterns.ts'], 'matrixForOfPushVisibleRows')
addInferCase('matrix abstract for-of param rows', ['interpreter-matrix-patterns.ts'], 'matrixForOfParamRows')
addInferCase('matrix abstract guarded for-of rows', ['interpreter-matrix-patterns.ts'], 'matrixForOfParamVisibleRows')
addInferCase('matrix abstract for-of cursor values', ['interpreter-matrix-patterns.ts'], 'matrixForOfParamCursorValues')
addInferCase('matrix abstract conditional count', ['interpreter-matrix-patterns.ts'], 'matrixForOfParamConditionalCount')
addInferCase('matrix abstract running max', ['interpreter-matrix-patterns.ts'], 'matrixForOfParamRunningMax')
addInferCase('matrix indexed limit range', ['interpreter-matrix-patterns.ts'], 'matrixIndexedLimitRange')
addInferCase('matrix indexed array param rows', ['interpreter-matrix-patterns.ts'], 'matrixIndexedArrayParamRows')
addInferCase('imported literal nested map/defaults', ['import-patterns.ts'], 'importedNestedLiteralArrayMapDefaultFields')
addShapeCase('imported literal nested map/defaults shape', ['import-patterns.ts'], 'importedNestedLiteralArrayMapDefaultFields')

if (!await verifySnapshot(expectedPath, lines.join('\n'), 'eval snapshots')) process.exitCode = 1

async function addCheckCase(label: string, paths: string[], keep: (text: string) => boolean) {
  const report = await verifyFitFiles(paths)
  lines.push(`check ${label}`)
  lines.push(`  summary: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.unknown} unknown`)
  for (const check of report.checks.filter(check => keep(check.text))) {
    const line = check.line == null ? '' : `:${check.line}`
    lines.push(`  ${check.status.toUpperCase()} ${displayWorkspaceFile(check.file)}${line}:${check.functionName}: ${check.text}`)
  }
}

function addInferCase(label: string, paths: string[], functionName: string) {
  const fn = inferFitFiles(paths, {functionName}).functions[0]
  lines.push(`infer ${label}`)
  if (fn == null) {
    lines.push(`  missing ${functionName}`)
    return
  }
  for (const fact of fn.facts.map(fact => fact.text)) lines.push(`  return ${fact}`)
  for (const fact of fn.locals.map(fact => fact.text)) lines.push(`  local ${fact}`)
  for (const unsupported of fn.unsupported) lines.push(`  unsupported ${unsupported}`)
}

function addShapeCase(label: string, paths: string[], functionName: string) {
  const report = inspectFitShapes(paths, {functionName, calls: true})
  lines.push(`shape ${label}`)
  for (const insight of report.insights) {
    lines.push(`  ${displayWorkspaceFile(insight.file)}:${insight.functionName}: ${insight.subject}`)
    for (const fact of insight.freerange) lines.push(`    freerange ${fact}`)
    for (const fact of insight.typescript) lines.push(`    typescript ${fact}`)
  }
}
