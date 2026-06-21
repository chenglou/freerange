import {test} from 'bun:test'
import {inferFitFiles} from '../../src/check-core.ts'
import {verifySnapshot} from '../../snapshot.ts'

test('evaluation snapshots', async () => {
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

  for (const [label, functionName] of matrixInferCases) addInferCase(lines, label, matrixFunctions, functionName)
  addInferCase(lines, 'imported literal nested map/defaults', importFunctions, 'importedNestedLiteralArrayMapDefaultFields')

  if (!await verifySnapshot('eval-snapshots.expected.txt', lines.join('\n'), 'eval snapshots')) {
    throw new Error('evaluation snapshots changed')
  }
}, 300_000)

function addInferCase(
  lines: string[],
  label: string,
  functions: ReturnType<typeof inferFitFiles>['functions'],
  functionName: string,
) {
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
