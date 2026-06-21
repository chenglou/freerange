import {test} from 'bun:test'
import {evaluateInterpreterFunction} from '../../src/interpreter/evaluate.ts'
import {
  formatInterpreterEffects,
  formatInterpreterIssues,
  formatInterpreterValue,
} from '../../src/interpreter/format.ts'
import {factsFromValue} from '../../src/facts.ts'
import {loadFitProject} from '../../src/modules.ts'
import {readTopLevelGlobal} from '../../src/module-values.ts'
import {verifySnapshot} from '../../snapshot.ts'
import {changedSnapshotObservation, testDiagnosticError} from '../test-diagnostics.ts'

test('interpreter snapshots', async () => {
  const observations: InterpreterObservation[] = []
  const matrixPaths = ['tests/interpreter-matrix/interpreter-matrix-patterns.ts']
  const negativePaths = ['tests/interpreter-matrix/interpreter-matrix-negative.ts']
  const matrixProject = loadInterpreterProject(matrixPaths)
  const negativeProject = loadInterpreterProject(negativePaths)
  const matrixCases = [
    ['matrix nested iife/map/defaults', 'matrixNestedIifeMapDefaults'],
    ['matrix if refines nonnegative', 'matrixIfRefinesNonnegative'],
    ['matrix ternary literal join', 'matrixTernaryLiteralJoin'],
    ['matrix filter/map literal booleans', 'matrixFilterMapLiteralBooleans'],
    ['matrix for-of push visible rows', 'matrixForOfPushVisibleRows'],
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
    ['matrix Math clamp columns', 'matrixMathClampColumns'],
    ['matrix else-if continuation', 'matrixElseIfContinuation'],
    ['matrix throw guard narrows positive', 'matrixThrowGuardNarrowsPositive'],
    ['matrix switch finite literal', 'matrixSwitchFiniteLiteral'],
    ['matrix switch continuation', 'matrixSwitchContinuation'],
    ['matrix switch grouped cases', 'matrixSwitchGroupedCases'],
    ['matrix switch narrows discriminant path', 'matrixSwitchNarrowsDiscriminantPath'],
    ['matrix stringish mutation preserves tuple', 'matrixStringishMutationPreservesTuple'],
    ['matrix typeof undefined guard', 'matrixTypeofUndefinedGuard'],
    ['matrix optional property nullish fallback', 'matrixOptionalPropertyNullishFallback'],
    ['matrix nullable object optional fallback', 'matrixNullableObjectOptionalFallback'],
    ['matrix local Math alias', 'matrixLocalMathAlias'],
    ['matrix property access call shape', 'matrixPropertyAccessCallShape'],
    ['matrix class method this', 'matrixClassMethodThis'],
  ] as const
  const negativeCases = [
    ['negative default value surface', 'negativeMatrixDefaultViolatesType'],
    ['negative alias mutation surface', 'negativeMatrixMapMutationForgetsAlias'],
    ['negative cursor update before push surface', 'negativeMatrixCursorUpdateBeforePush'],
    ['negative conditional else count surface', 'negativeMatrixConditionalElseCount'],
    ['negative mixed extremum/cursor surface', 'negativeMatrixMixedExtremumAndCursor'],
    ['negative indexed loop starts at one surface', 'negativeMatrixIndexedLoopStartsAtOne'],
    ['negative indexed array guarded else surface', 'negativeMatrixIndexedArrayGuardedElse'],
    ['negative indexed array pushes into source surface', 'negativeMatrixIndexedArrayPushesIntoSource'],
    ['negative indexed cursor update before push surface', 'negativeMatrixIndexedCursorUpdateBeforePush'],
    ['negative indexed conditional else count surface', 'negativeMatrixIndexedConditionalElseCount'],
    ['negative indexed mixed extremum/cursor surface', 'negativeMatrixIndexedMixedExtremumAndCursor'],
    ['negative guarded unsafe reset surface', 'negativeMatrixGuardedExtremumUnsafeReset'],
    ['negative try/catch surface', 'negativeMatrixTryCatchUnsupported'],
    ['negative switch broad string surface', 'negativeMatrixSwitchBroadStringUnsupported'],
    ['negative switch fallthrough surface', 'negativeMatrixSwitchFallthroughUnsupported'],
    ['negative array at dynamic surface', 'negativeMatrixArrayAtDynamicUnsupported'],
    ['negative nullish fallback string surface', 'negativeMatrixNullishFallbackString'],
    ['negative mutable alias surface', 'negativeMatrixMutableAliasUnsupported'],
  ] as const

  for (const [label, functionName] of matrixCases) {
    observations.push(observeInterpreter(label, matrixPaths[0]!, matrixProject, functionName))
  }
  for (const [label, functionName] of negativeCases) {
    observations.push(observeInterpreter(label, negativePaths[0]!, negativeProject, functionName))
  }

  const snapshotPath = 'interpreter-snapshots.expected.txt'
  const serialized = serializeObservations(observations)
  if (!await verifySnapshot(snapshotPath, serialized, 'interpreter observations')) {
    throw testDiagnosticError('interpreter observations changed', changedSnapshotObservation(
      await Bun.file(snapshotPath).text(),
      serialized,
      observations,
    ))
  }
}, 300_000)

type InterpreterObservation = {
  label: string
  file: string
  functionName: string
  value: string[]
  facts: Array<{kind: string; text: string}>
  issues: string[]
  effects: string[]
  audits: Array<{
    stack: string[]
    line?: number
    text: string
    reason: string
  }>
}

function observeInterpreter(
  label: string,
  file: string,
  project: ReturnType<typeof loadInterpreterProject>,
  functionName: string,
): InterpreterObservation {
  const program = project.entries[0]
  if (program == null) {
    throw new Error(`expected an interpreter program for ${file}`)
  }
  if (!program.functions.has(functionName)) {
    throw testDiagnosticError(`expected interpreter function ${functionName}`, [...program.functions.keys()])
  }
  const result = evaluateInterpreterFunction({program, functionName})
  return {
    label,
    file,
    functionName,
    value: formatInterpreterValue(result.value),
    facts: factsFromValue('return', result.value).map(fact => ({kind: fact.kind, text: fact.text})),
    issues: formatInterpreterIssues(result.output.issues),
    effects: formatInterpreterEffects(result.output.effects),
    audits: result.output.audits.map(audit => ({
      stack: audit.stack,
      ...(audit.line == null ? {} : {line: audit.line}),
      text: audit.text,
      reason: audit.reason,
    })),
  }
}

function serializeObservations(observations: InterpreterObservation[]) {
  const lines: string[] = []
  let currentFile = ''
  for (const observation of observations) {
    const {file, functionName, value, facts, issues, effects, audits} = observation
    if (file !== currentFile) {
      currentFile = file
      lines.push(`@ ${JSON.stringify(file)}`)
    }
    lines.push(`# ${JSON.stringify([functionName, facts.length, observationDigest(facts)])}`)
    for (const line of value) lines.push(`v ${JSON.stringify(line)}`)
    for (const fact of facts) {
      if (fact.kind === 'origin') lines.push(`o ${JSON.stringify(fact.text)}`)
    }
    for (const issue of issues) lines.push(`! ${JSON.stringify(issue)}`)
    for (const effect of effects) lines.push(`e ${JSON.stringify(effect)}`)
    for (const audit of audits) lines.push(`a ${JSON.stringify(audit)}`)
  }
  return lines.join('\n')
}

function observationDigest(value: unknown) {
  const hash = new Bun.CryptoHasher('sha256')
  hash.update(JSON.stringify(value))
  return hash.digest('base64')
}

function loadInterpreterProject(paths: string[]) {
  return loadFitProject(paths, readTopLevelGlobal)
}
