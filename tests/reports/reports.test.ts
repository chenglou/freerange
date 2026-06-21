import {describe, setDefaultTimeout, test} from 'bun:test'
import {inferFitFiles} from '../../src/check-core.ts'
import {uniqueUnsupported} from '../../src/infer-report.ts'
import {type FitCheck, verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {verifySnapshot} from '../../snapshot.ts'
import {testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

describe('reports', () => {
test('checks every positive catalog obligation and trace', async () => {
const positiveCatalogs = [
  {path: 'tests/source-checking/patterns.ts', expectedChecks: 340},
  {path: 'tests/loops/loop-patterns.ts', expectedChecks: 115},
  {path: 'tests/imports/import-patterns.ts', expectedChecks: 66},
  {path: 'tests/interpreter-matrix/interpreter-matrix-patterns.ts', expectedChecks: 19},
] as const
const positiveFiles = positiveCatalogs.map(catalog => catalog.path)

const positiveReport = await verifyFitFiles(positiveFiles)
const actualPositiveCounts = new Map<string, number>()
for (const check of positiveReport.checks) {
  actualPositiveCounts.set(check.file, (actualPositiveCounts.get(check.file) ?? 0) + 1)
}
const positiveCountFailures = positiveCatalogs.filter(catalog =>
  actualPositiveCounts.get(catalog.path) !== catalog.expectedChecks)
const unexpectedPositiveFiles = [...actualPositiveCounts.keys()].filter(path =>
  !positiveCatalogs.some(catalog => catalog.path === path))
if (positiveReport.phase !== 'ready' || positiveCountFailures.length > 0 || unexpectedPositiveFiles.length > 0) {
  throw testDiagnosticError('expected every positive catalog obligation to exist and pass', {
    positiveCountFailures: positiveCountFailures.map(catalog => ({
      path: catalog.path,
      expected: catalog.expectedChecks,
      actual: actualPositiveCounts.get(catalog.path) ?? 0,
    })),
    unexpectedPositiveFiles,
    failedChecks: positiveReport.checks.filter(check => check.status !== 'pass'),
  })
}

const obligationChecks = verifyFitSource('obligation.ts', `/** @fit
 * return: 1
 */
function one() {
  return 1
}
/** @fit
 * given value: 1..1
 * return: 1
 */
function identity(value: number) {
  return value
}
function bounded(value: number /* intentionally not @fit syntax here */) {
  return value
}
const x = one() // @fit 1
`)
const obligationCheck = obligationChecks.find(check => check.text === 'return: 1' && check.functionName === 'one')
const tracedObligationCheck = obligationChecks.find(check => check.text === 'return: 1' && check.functionName === 'identity')
const inlineObligationCheck = obligationChecks.find(check => check.text === 'x: 1')
const sequenceObligationCheck = positiveReport.checks.find(check => check.functionName === 'runningSumLoop' && check.text === 'spaced(return.rows, gap)')
if (
  obligationCheck?.obligation?.boundary !== 'function-contract'
  || obligationCheck.trace?.obligationId !== obligationCheck.obligation.id
  || tracedObligationCheck?.trace?.usedFacts.some(fact => fact.includes('assumed from input: given value: 1..1')) !== true
  || inlineObligationCheck?.obligation?.boundary !== 'inline-check'
  || sequenceObligationCheck?.obligation?.goal.kind !== 'expression'
  || sequenceObligationCheck.trace?.steps.some(step => step.message === 'checked boolean expression') !== true
  || sequenceObligationCheck.trace.usedFacts.some(fact => fact.startsWith('sequence facts:')) !== true
) {
  throw testDiagnosticError('expected checks to carry proof obligations and used facts', {obligationChecks, sequenceObligationCheck})
}
})

test('matches the negative report snapshot', async () => {
const negativeFiles = ['tests/source-checking/negative-patterns.ts', 'tests/source-checking/negative-shadowed-catalog.ts', 'tests/imports/negative-import-patterns.ts', 'tests/interpreter-matrix/interpreter-matrix-negative.ts']
const negativeExpectedPath = 'negative-patterns.expected.txt'
const negativeReport = await verifyFitFiles(negativeFiles)
const actualNegative = normalizeNegative(negativeReport.checks)
if (!await verifySnapshot(negativeExpectedPath, actualNegative, 'negative messages')) {
  throw testDiagnosticError('expected negative report snapshot to match', actualNegative)
}
})

test('collapses unsupported fallout by root cause', () => {
const collapsedUnsupported = uniqueUnsupported([
  'unsupported render line 1: Unknown identifier events',
  'unsupported render line 1: Property access expected an object path: events.click',
  'unsupported render > <if-true>: Unknown assignment root events',
  'unsupported render > <if-true>: Unknown identifier events',
  'unsupported render line 2: Unknown assignment root debugTimestamp',
  'unsupported render line 2: Compound assignment debugTimestamp += 1000 / 60 expected numbers',
  'unsupported render line 3: Recursive helper inlining is unsupported at walk',
  'unsupported other line 8: Recursive helper inlining is unsupported at walk',
])
const expectedCollapsedUnsupported = [
  'unsupported render line 1: Unknown identifier events',
  'unsupported render line 2: Unknown assignment root debugTimestamp',
  'unsupported render line 3: Recursive helper inlining is unsupported at walk',
]
if (collapsedUnsupported.join('\n') !== expectedCollapsedUnsupported.join('\n')) {
  throw testDiagnosticError('expected unsupported root fallout to collapse', collapsedUnsupported)
}
})

test('matches the inference snapshot', async () => {
const inferSnapshotExpectedPath = 'infer-snapshots.expected.txt'
const actualInferSnapshot = normalizeText([
  formatInferSnapshot(['tests/source-checking/patterns.ts'], 'propertyAccessCallShape'),
  formatInferSnapshot(['tests/source-checking/patterns.ts'], 'mapCallbackReturnShape'),
  formatInferSnapshot(['tests/loops/loop-patterns.ts'], 'scalarPushLoop'),
  formatInferSnapshot(['tests/imports/import-patterns.ts'], 'namespaceImportedStructuralShape'),
  formatInferSnapshot(['tests/source-checking/patterns.ts'], 'mapBlockRowsWithDestructure'),
  formatInferSnapshot(['tests/loops/loop-patterns.ts'], 'localLoopAnnotation'),
].join('\n'))
if (!await verifySnapshot(inferSnapshotExpectedPath, actualInferSnapshot, 'infer snapshot')) {
  throw testDiagnosticError('expected inference snapshot to match', actualInferSnapshot)
}
})
})

function normalizeNegative(checks: FitCheck[]) {
  const lines = checks
    .filter(check => check.status !== 'pass')
    .map(check => {
      const head = `${check.status.toUpperCase()} ${check.file}:${check.functionName}: ${check.text}`
      if (check.reason == null) return head
      const reason = check.reason
        .replace(/@loop\d+/g, '@loop')
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n')
      return `${head}\n${reason}`
    })
  return normalizeText(lines.join('\n'))
}

function normalizeText(text: string) {
  return text.trimEnd() + '\n'
}

function formatInferSnapshot(paths: string[], functionName: string) {
  const report = inferFitFiles(paths, {functionName})
  const fn = report.functions[0]
  if (fn == null) return `${functionName}\n  missing function`
  const lines = [`${displayFile(fn.file)}:${fn.functionName}`]
  addSection(lines, 'return', fn.facts.map(fact => fact.text))
  addSection(lines, 'locals', fn.locals.map(fact => fact.text))
  for (const loop of fn.loops) {
    lines.push(`loop ${loop.line}: ${loop.header}`)
    addSection(lines, 'inferred', loop.facts.map(fact => fact.text), '  ')
    addSection(lines, 'checked', loop.specs.filter(spec => spec.status === 'checked').map(spec => spec.text), '  ')
    addSection(lines, 'assumptions', loop.specs.filter(spec => spec.status === 'assumed').map(spec => spec.text), '  ')
    addSection(lines, 'not-inferred', loop.specs.filter(spec => spec.status === 'not-inferred').map(spec => spec.text), '  ')
  }
  addSection(lines, 'unsupported', fn.unsupported.filter(line => line.startsWith('Forgot unsupported')))
  return lines.join('\n')
}

function addSection(lines: string[], name: string, items: string[], indent = '') {
  if (items.length === 0) return
  lines.push(`${indent}${name}:`)
  for (const item of items) lines.push(`${indent}  ${item}`)
}

function displayFile(file: string) {
  const repoDir = new URL('../..', import.meta.url).pathname
  const workspaceDir = repoDir.replace(/\/[^/]+\/$/, '/')
  if (file.startsWith(repoDir)) return file.slice(repoDir.length)
  if (file.startsWith(workspaceDir)) return `../${file.slice(workspaceDir.length)}`
  return file
}
