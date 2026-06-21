import {test} from 'bun:test'
import {inferFitFiles} from '../../src/check-core.ts'
import {verifySnapshot} from '../../snapshot.ts'
import {changedSnapshotObservation, testDiagnosticError} from '../test-diagnostics.ts'

test('evaluation snapshots', async () => {
  const observations: InferenceObservation[] = []
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

  for (const [label, functionName] of matrixInferCases) {
    observations.push(observeInference(label, matrixPaths[0]!, matrixFunctions, functionName))
  }
  observations.push(observeInference(
    'imported literal nested map/defaults',
    importPaths[0]!,
    importFunctions,
    'importedNestedLiteralArrayMapDefaultFields',
  ))

  const snapshotPath = 'eval-snapshots.expected.txt'
  const serialized = serializeObservations(observations)
  if (!await verifySnapshot(snapshotPath, serialized, 'evaluation observations')) {
    throw testDiagnosticError('evaluation observations changed', changedSnapshotObservation(
      await Bun.file(snapshotPath).text(),
      serialized,
      observations,
    ))
  }
}, 300_000)

type InferenceObservation = {
  label: string
  file: string
  functionName: string
  facts: string[]
  locals: string[]
  unsupported: string[]
}

function observeInference(
  label: string,
  file: string,
  functions: ReturnType<typeof inferFitFiles>['functions'],
  functionName: string,
): InferenceObservation {
  const matches = functions.filter(fn => fn.functionName === functionName)
  if (matches.length !== 1) {
    throw testDiagnosticError(`expected exactly one inference result for ${functionName}`, matches)
  }
  const fn = matches[0]!
  return {
    label,
    file,
    functionName,
    facts: fn.facts.map(fact => fact.text),
    locals: fn.locals.map(fact => fact.text),
    unsupported: fn.unsupported,
  }
}

function serializeObservations(observations: InferenceObservation[]) {
  const lines: string[] = []
  let currentFile = ''
  for (const observation of observations) {
    const {file, functionName, facts, locals, unsupported} = observation
    if (file !== currentFile) {
      currentFile = file
      lines.push(`@ ${JSON.stringify(file)}`)
    }
    lines.push(`# ${JSON.stringify([functionName])}`)
    for (const fact of facts) lines.push(`f ${JSON.stringify(fact)}`)
    for (const local of locals) lines.push(`l ${JSON.stringify(local)}`)
    for (const item of unsupported) lines.push(`! ${JSON.stringify(item)}`)
  }
  return lines.join('\n')
}
