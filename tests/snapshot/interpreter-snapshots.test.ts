import {test} from 'bun:test'
import {evaluateInterpreterFunction} from '../../src/interpreter/evaluate.ts'
import {
  formatInterpreterFacts,
  formatInterpreterIssues,
  formatInterpreterValue,
} from '../../src/interpreter/format.ts'
import {loadFitProject} from '../../src/modules.ts'
import {readTopLevelGlobal} from '../../src/module-values.ts'
import {displayWorkspaceFile, verifySnapshot} from '../../snapshot.ts'

test('interpreter snapshots', async () => {
  const lines: string[] = []
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
    ['negative unsupported loop impure read surface', 'negativeMatrixUnsupportedLoopImpureRead'],
    ['negative try/catch surface', 'negativeMatrixTryCatchUnsupported'],
    ['negative switch broad string surface', 'negativeMatrixSwitchBroadStringUnsupported'],
    ['negative switch fallthrough surface', 'negativeMatrixSwitchFallthroughUnsupported'],
    ['negative array at dynamic surface', 'negativeMatrixArrayAtDynamicUnsupported'],
    ['negative nullish fallback string surface', 'negativeMatrixNullishFallbackString'],
    ['negative mutable alias surface', 'negativeMatrixMutableAliasUnsupported'],
  ] as const

  for (const [label, functionName] of matrixCases) addCase(lines, label, matrixPaths, matrixProject, functionName)
  for (const [label, functionName] of negativeCases) addCase(lines, label, negativePaths, negativeProject, functionName)

  if (!await verifySnapshot('interpreter-snapshots.expected.txt', lines.join('\n'), 'interpreter snapshots')) {
    throw new Error('interpreter snapshots changed')
  }
}, 300_000)

function addCase(
  lines: string[],
  label: string,
  paths: string[],
  project: ReturnType<typeof loadInterpreterProject>,
  functionName: string,
) {
  const program = project.entries[0]
  lines.push(`case ${label}: ${displayWorkspaceFile(paths[0]!)}:${functionName}`)
  if (program == null) {
    lines.push('  missing program')
    return
  }
  const result = evaluateInterpreterFunction({program, functionName})
  for (const line of formatInterpreterValue(result.value)) lines.push(`  ${line}`)
  for (const line of formatInterpreterFacts(result.value)) lines.push(`  ${line}`)
  for (const line of formatInterpreterIssues(result.output.issues)) lines.push(`  ${line}`)
}

function loadInterpreterProject(paths: string[]) {
  return loadFitProject(paths, readTopLevelGlobal)
}
