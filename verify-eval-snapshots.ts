import {inferFitFiles, inspectFitShapes} from './src/check-core.ts'
import {verifyFitFiles} from './src/reports.ts'
import {displayWorkspaceFile, verifySnapshot} from './snapshot.ts'

const expectedPath = 'eval-snapshots.expected.txt'

const lines: string[] = []
const matrixPaths = ['tests/interpreter-matrix/interpreter-matrix-patterns.ts']
const importPaths = ['tests/imports/import-patterns.ts']
const matrixFunctions = inferFitFiles(matrixPaths, {all: true}).functions
const importFunctions = inferFitFiles(importPaths, {all: true}).functions
const matrixInferCases = [
  ['matrix nested iife/map/defaults', 'matrixNestedIifeMapDefaults'],
  ['matrix default param order', 'matrixDefaultParamOrder'],
  ['matrix explicit undefined defaults', 'matrixExplicitUndefinedDefaults'],
  ['matrix for-of push visible rows', 'matrixForOfPushVisibleRows'],
  ['matrix abstract for-of param rows', 'matrixForOfParamRows'],
  ['matrix abstract guarded for-of rows', 'matrixForOfParamVisibleRows'],
  ['matrix abstract for-of cursor values', 'matrixForOfParamCursorValues'],
  ['matrix abstract conditional count', 'matrixForOfParamConditionalCount'],
  ['matrix abstract running max', 'matrixForOfParamRunningMax'],
  ['matrix indexed conditional count', 'matrixIndexedArrayConditionalCount'],
  ['matrix indexed running max', 'matrixIndexedArrayRunningMax'],
  ['matrix indexed limit range', 'matrixIndexedLimitRange'],
  ['matrix indexed array param rows', 'matrixIndexedArrayParamRows'],
  ['matrix indexed array guarded rows', 'matrixIndexedArrayGuardedRows'],
  ['matrix indexed array guarded cursor values', 'matrixIndexedArrayGuardedCursorValues'],
  ['matrix indexed array cursor values', 'matrixIndexedArrayCursorValues'],
] as const

await addCheckCase(
  'photo-gallery spring defaults through imported data',
  ['photo-gallery/index.ts'],
  text => text.includes('data[].sizeX.k > 0')
    || text.includes('data[].sizeX.b > 0')
    || text.includes('data[].fxFactor.k > 0')
    || text.includes('data[].fxFactor.b > 0'),
)

for (const [label, functionName] of matrixInferCases) addInferCase(label, matrixFunctions, functionName)
addInferCase('imported literal nested map/defaults', importFunctions, 'importedNestedLiteralArrayMapDefaultFields')
addShapeCase('imported literal nested map/defaults shape', importPaths, 'importedNestedLiteralArrayMapDefaultFields')

if (!await verifySnapshot(expectedPath, lines.join('\n'), 'eval snapshots')) process.exitCode = 1

async function addCheckCase(label: string, paths: string[], keep: (text: string) => boolean) {
  const report = await verifyFitFiles(paths, {annotationsOnly: true})
  const checks = report.checks.filter(check => keep(check.text))
  lines.push(`check ${label}`)
  lines.push(`  summary: ${checks.filter(check => check.status === 'pass').length} pass, ${checks.filter(check => check.status === 'fail').length} fail, ${checks.filter(check => check.status === 'requires').length} requires, ${checks.filter(check => check.status === 'unknown').length} unknown`)
  for (const check of checks) {
    const line = check.line == null ? '' : `:${check.line}`
    lines.push(`  ${check.status.toUpperCase()} ${displayWorkspaceFile(check.file)}${line}:${check.functionName}: ${check.text}`)
  }
}

function addInferCase(label: string, functions: ReturnType<typeof inferFitFiles>['functions'], functionName: string) {
  const fn = functions.find(fn => fn.functionName === functionName)
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
