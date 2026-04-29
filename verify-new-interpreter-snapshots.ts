import {evaluateInterpreterFunction} from './src/interpreter/evaluate.ts'
import {
  formatInterpreterIssues,
  formatInterpreterValue,
} from './src/interpreter/format.ts'
import {readTopLevelGlobal} from './src/check.ts'
import {loadFitProject} from './src/modules.ts'
import {displayWorkspaceFile, verifySnapshot} from './snapshot.ts'

const expectedPath = 'new-interpreter-snapshots.expected.txt'
const lines: string[] = []

addCase('matrix nested iife/map/defaults', ['interpreter-matrix-patterns.ts'], 'matrixNestedIifeMapDefaults')
addCase('matrix default param order', ['interpreter-matrix-patterns.ts'], 'matrixDefaultParamOrder')
addCase('matrix if refines nonnegative', ['interpreter-matrix-patterns.ts'], 'matrixIfRefinesNonnegative')
addCase('matrix ternary literal join', ['interpreter-matrix-patterns.ts'], 'matrixTernaryLiteralJoin')
addCase('negative default value surface', ['interpreter-matrix-negative.ts'], 'negativeMatrixDefaultViolatesType')
addCase('negative alias mutation surface', ['interpreter-matrix-negative.ts'], 'negativeMatrixMapMutationForgetsAlias')

if (!await verifySnapshot(expectedPath, lines.join('\n'), 'new interpreter snapshots')) process.exitCode = 1

function addCase(label: string, paths: string[], functionName: string) {
  const project = loadFitProject(paths, readTopLevelGlobal)
  const program = project.entries[0]
  lines.push(`case ${label}: ${displayWorkspaceFile(paths[0]!)}:${functionName}`)
  if (program == null) {
    lines.push('  missing program')
    return
  }
  const result = evaluateInterpreterFunction(program, functionName)
  for (const line of formatInterpreterValue(result.value)) lines.push(`  ${line}`)
  for (const line of formatInterpreterIssues(result.issues)) lines.push(`  ${line}`)
}
