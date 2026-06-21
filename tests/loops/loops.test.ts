import {describe, setDefaultTimeout, test} from 'bun:test'
import {inferFitFiles} from '../../src/check-core.ts'
import {numberValue} from '../../src/domain.ts'
import {runningSumNumber} from '../../src/loop-summary.ts'
import {verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

describe('loops', () => {
test('keeps an unbounded nonnegative running sum nonnegative', () => {
const unboundedNonnegativeRunningSum = runningSumNumber(
  'y',
  numberValue(0, Number.POSITIVE_INFINITY, null, 'start'),
  numberValue(0, Number.POSITIVE_INFINITY, 0, 'count'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'increment'),
)
if (unboundedNonnegativeRunningSum.min !== 0 || unboundedNonnegativeRunningSum.max !== Number.POSITIVE_INFINITY) {
  throw testDiagnosticError(`expected 0..Infinity running sum, got ${unboundedNonnegativeRunningSum.min}..${unboundedNonnegativeRunningSum.max}`, unboundedNonnegativeRunningSum)
}
})

test('checks direct and imported previous-index relationships', async () => {
const previousIndexReport = await verifyFitFiles([
  'tests/loops/previous-index-patterns.ts',
  'tests/imports/adjacent-summary-patterns.ts',
], {annotationsOnly: true})
if (previousIndexReport.phase !== 'ready') {
  throw testDiagnosticError('expected direct and imported previous-index relationships to pass', previousIndexReport.checks)
}
})

test('preserves imported adjacent summaries and rejects a different recurrence', async () => {
const negativeAdjacentSummaryReport = await verifyFitFiles(['tests/imports/negative-adjacent-summary.ts'], {annotationsOnly: true})
const negativeAdjacentSummaryCheck = negativeAdjacentSummaryReport.checks.find(check =>
  check.functionName === 'negativeImportedPreviousNamedIndexSummary'
  && check.text === 'return.rows[$i].top == return.rows[$i - 1].top + (return.rows[$i - 1].height + spacing + 1)')
const negativeAdjacentFirstItemCheck = negativeAdjacentSummaryReport.checks.find(check =>
  check.functionName === 'negativeAdjacentSummaryDoesNotDescribeFirstItem'
  && check.text === 'return.rows[].top >= 1')
if (
  negativeAdjacentSummaryCheck?.status !== 'unknown'
  || negativeAdjacentSummaryCheck.reason?.includes('adjacent: return.rows[$i + 1].top == return.rows[$i].top + (return.rows[$i].height + spacing)') !== true
  || negativeAdjacentFirstItemCheck?.status !== 'unknown'
) {
  throw testDiagnosticError('expected imported adjacent summaries to preserve the caller spelling and reject a different recurrence', negativeAdjacentSummaryReport.checks)
}
})

test('preserves sequence grouping and rejects unsound spacing or end facts', () => {
const sequenceOperationChecks = verifyFitSource('sequence-operations.ts', `
/** @fit
 * given items.length: int 2..2
 * given items[].height: 1
 * given gap: 1
 * spaced(return, gap)
 * return[$i + 1].y == return[$i].y + (return[$i].height + gap)
 */
function rightGrouped(items: {height: number}[], gap: number) {
  const rows = []
  let y = 10000000000000000
  for (const item of items) {
    rows.push({y, height: item.height})
    y += gap + item.height
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * given items[].height: 1
 * given gap: 1
 * return[$i + 1].y == (return[$i].y + return[$i].height) + gap
 * return[$i + 1].y == return[$i].y + (return[$i].height + gap)
 */
function leftGrouped(items: {height: number}[], gap: number) {
  const rows = []
  let y = 10000000000000000
  for (const item of items) {
    rows.push({y, height: item.height})
    y = (y + item.height) + gap
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * spaced(return, gap)
 */
function nanCapable(items: {height: number}[], gap: number) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({y, height: item.height})
    y += item.height + gap
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * nondecreasing(return.y)
 * return[$i + 1].y == return[$i].y
 */
function nanStable(items: number[], y: number) {
  const rows = []
  for (const item of items) {
    rows.push({y, item})
    y += 0
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * given step: 1
 * spaced(return, step)
 */
function unrelatedField(items: number[], step: number) {
  const rows = []
  let counter = 0
  for (const item of items) {
    rows.push({y: 0, height: 1, counter, item})
    counter += step
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * given items[].height: 0..40
 * given gap: 0..10
 * spaced(return, 1 + gap)
 * return[$i + 1].y == return[$i].y + (return[$i].height + (1 + gap))
 */
function precomputedGap(items: {height: number}[], gap: number) {
  const rows = []
  const actualGap = 1 + gap
  let y = 0
  for (const item of items) {
    rows.push({y, height: item.height})
    y += item.height + actualGap
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * given items[].height: 0..40
 * given gap: 0..10
 * spaced(return, gap)
 * noOverlap(return)
 * return[$i + 1].y == return[$i].next
 * return[$i + 1].y == return[$i].y + (return[$i].height + gap)
 */
function pushedComputedCursor(items: {height: number}[], gap: number) {
  const rows = []
  let cursor = 0
  for (const item of items) {
    const next = cursor + (item.height + gap)
    rows.push({y: cursor, height: item.height, next})
    cursor = next
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * given items[].size: 0..40
 * given gap: 0..10
 * spaced(return, gap)
 * noOverlap(return)
 */
function documentedStartAxis(items: {size: number}[], gap: number) {
  const rows = []
  let start = 0
  for (const item of items) {
    rows.push({start, size: item.size})
    start += item.size + gap
  }
  return rows
}

/** @fit
 * given items.length: int 2..2
 * given items[].height: 0..40
 * given gap: 0..10
 * spaced(return, gap)
 * noOverlap(return)
 */
function documentedTopAxis(items: {height: number}[], gap: number) {
  const rows = []
  let top = 0
  for (const item of items) {
    rows.push({top, height: item.height})
    top += item.height + gap
  }
  return rows
}

/** @fit
 * given spaced(rows, gap)
 * spaced(return, gap)
 */
function arbitraryPushBreaksSpacing(rows: {y: number; height: number}[], gap: number) {
  rows.push({y: 0, height: 1})
  return rows
}

/** @fit
 * given first.length: int 1..2
 * given second.length: int 1..2
 * spaced(return, 0)
 */
function incompatibleSecondLoop(first: number[], second: number[]) {
  const rows = []
  let y = 0
  for (const item of first) {
    rows.push({y, height: 1, item})
    y += 1
  }
  for (const item of second) {
    rows.push({y: 100, height: 1, item})
  }
  return rows
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * lastEnd(return.rows) == return.bottom
 */
function roundedLastEnd(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  return {rows, bottom: cursor - gap}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * extentEnd(return.rows, y) == return.bottom
 */
function roundedExtentEnd(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  return {rows, bottom: rows.length === 0 ? y : cursor - gap}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..1
 * return: -50..0
 */
function unaryGroupedUpdate(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total = total + (-item.height)
  }
  return total
}
`)
const sequenceOperationStatus = (functionName: string, text: string) =>
  sequenceOperationChecks.find(check => check.functionName === functionName && check.text === text)?.status
if (
  sequenceOperationStatus('rightGrouped', 'spaced(return, gap)') !== 'pass'
  || sequenceOperationStatus('rightGrouped', 'return[$i + 1].y == return[$i].y + (return[$i].height + gap)') !== 'pass'
  || sequenceOperationStatus('leftGrouped', 'return[$i + 1].y == (return[$i].y + return[$i].height) + gap') !== 'pass'
  || sequenceOperationStatus('leftGrouped', 'return[$i + 1].y == return[$i].y + (return[$i].height + gap)') !== 'unknown'
  || sequenceOperationStatus('nanCapable', 'spaced(return, gap)') !== 'unknown'
  || sequenceOperationStatus('nanStable', 'nondecreasing(return.y)') !== 'pass'
  || sequenceOperationStatus('nanStable', 'return[$i + 1].y == return[$i].y') !== 'pass'
  || sequenceOperationStatus('unrelatedField', 'spaced(return, step)') !== 'unknown'
  || sequenceOperationStatus('precomputedGap', 'spaced(return, 1 + gap)') !== 'pass'
  || sequenceOperationStatus('precomputedGap', 'return[$i + 1].y == return[$i].y + (return[$i].height + (1 + gap))') !== 'pass'
  || sequenceOperationStatus('pushedComputedCursor', 'spaced(return, gap)') !== 'pass'
  || sequenceOperationStatus('pushedComputedCursor', 'noOverlap(return)') !== 'pass'
  || sequenceOperationStatus('pushedComputedCursor', 'return[$i + 1].y == return[$i].next') !== 'pass'
  || sequenceOperationStatus('pushedComputedCursor', 'return[$i + 1].y == return[$i].y + (return[$i].height + gap)') !== 'pass'
  || sequenceOperationStatus('documentedTopAxis', 'spaced(return, gap)') !== 'pass'
  || sequenceOperationStatus('documentedTopAxis', 'noOverlap(return)') !== 'pass'
  || sequenceOperationStatus('documentedStartAxis', 'spaced(return, gap)') !== 'pass'
  || sequenceOperationStatus('documentedStartAxis', 'noOverlap(return)') !== 'pass'
  || sequenceOperationStatus('arbitraryPushBreaksSpacing', 'spaced(return, gap)') !== 'unknown'
  || sequenceOperationStatus('incompatibleSecondLoop', 'spaced(return, 0)') !== 'unknown'
  || sequenceOperationStatus('roundedLastEnd', 'lastEnd(return.rows) == return.bottom') !== 'unknown'
  || sequenceOperationStatus('roundedExtentEnd', 'extentEnd(return.rows, y) == return.bottom') !== 'unknown'
  || sequenceOperationStatus('unaryGroupedUpdate', 'return: -50..0') !== 'pass'
) {
  throw testDiagnosticError('expected sequence relations to preserve source grouping and reject unsound spacing or end facts', sequenceOperationChecks)
}
})

test('retains computation operands after later range refinement', () => {
const lateRefinementChecks = verifyFitSource('late-refinement.ts', `
/** @fit
 * given items[].height: -100..100
 * given top: 0..1000
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 */
function lateRefinement(items: {height: number}[], top: number) {
  const rows = []
  for (const item of items) {
    const height = item.height
    const bottom = top + height
    if (height < 0) continue
    rows.push({top, height, bottom})
  }
  return {rows}
}
`)
if (lateRefinementChecks.length !== 1 || lateRefinementChecks[0]?.status !== 'pass') {
  throw testDiagnosticError('expected a computation to retain operand identity after a later range refinement', lateRefinementChecks)
}
})

test('reports expected inferred and redundant loop facts', () => {
const loopInferReport = inferFitFiles(['tests/loops/loop-patterns.ts'], {functionName: 'localLoopAnnotation'})
const loopFunctionSpecStatuses = new Map(loopInferReport.functions[0]?.specs.map(spec => [spec.text, spec.status]) ?? [])
const loopReport = loopInferReport.functions[0]?.loops[0]
const loopRedundantSpecs = new Map(loopReport?.redundant.map(spec => [spec.text, spec.reason]) ?? [])
const expectedLoopFunctionSpecStatuses = [
  ['given items.length: int 1..50', 'assumed'],
  ['return.rows.length == items.length', 'checked'],
] as const
const expectedLoopRedundantSpecs = [
  ['rows.length == items.length', 'rows.length == items.length'],
  ['rows[].height: 0..40', 'rows[].height: 0..40'],
] as const
const missingLoopRedundantSpecs = expectedLoopRedundantSpecs.filter(([text, reason]) => loopRedundantSpecs.get(text) !== reason)
const unexpectedlyRedundantLoopSpecs: string[] = []
const badLoopFunctionSpecStatuses = expectedLoopFunctionSpecStatuses.filter(([text, status]) => loopFunctionSpecStatuses.get(text) !== status)
if (missingLoopRedundantSpecs.length > 0 || unexpectedlyRedundantLoopSpecs.length > 0 || badLoopFunctionSpecStatuses.length > 0) {
  throw testDiagnosticError('expected loop inferred facts changed', [
    ...missingLoopRedundantSpecs.map(([text, reason]) => `expected redundant ${text}: ${reason}`),
    ...unexpectedlyRedundantLoopSpecs.map(text => `unexpected redundant: ${text}`),
    ...badLoopFunctionSpecStatuses.map(([text, status]) => `expected function ${text}: ${status}`),
  ])
}
})

test('reports expected segmented loop facts', () => {
// Conditional flush loops keep the exact operand snapshots used by rounded
// additions, so resetting the height after the push cannot change the
// row-bottom or next-row computation retroactively.
const segmentedLoopInferReport = inferFitFiles(['tests/loops/loop-patterns.ts'], {functionName: 'segmentedStackRowsWithGuardLocalResetAlias'})
const segmentedFunction = segmentedLoopInferReport.functions[0]
const segmentedFacts = new Set(segmentedFunction?.facts.map(fact => fact.text) ?? [])
const segmentedSpecs = new Map(segmentedFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedSegmentedFacts = [
  'return.rows.length: int 0..50',
  'return.rows[].bottom == (rows[].y + rows[].height)',
  'return.rows[].height: 0..40',
  'nondecreasing(return.rows.y)',
  'spaced(return.rows, gap)',
  'return.rows[$i + 1].y == return.rows[$i].bottom + gap',
]
const missingSegmentedFacts = expectedSegmentedFacts.filter(fact => !segmentedFacts.has(fact))
const expectedSegmentedSpecStatuses = [
  ['return.rows.length <= items.length', 'checked'],
  ['return.rows[].bottom == return.rows[].y + return.rows[].height', 'checked'],
  ['nondecreasing(return.rows.y)', 'checked'],
  ['spaced(return.rows, gap)', 'checked'],
  ['noOverlap(return.rows)', 'checked'],
] as const
const badSegmentedSpecStatuses = expectedSegmentedSpecStatuses.filter(([text, status]) => segmentedSpecs.get(text) !== status)
if (missingSegmentedFacts.length > 0 || badSegmentedSpecStatuses.length > 0) {
  throw testDiagnosticError('expected segmented loop inferred facts changed', [
    ...missingSegmentedFacts.map(fact => `missing: ${fact}`),
    ...badSegmentedSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`),
  ])
}
})

test('reports expected function-level redundant facts', () => {
const redundantInferReport = inferFitFiles(['tests/loops/loop-patterns.ts'], {functionName: 'scalarPushLoop'})
const redundantFunction = redundantInferReport.functions[0]
const redundantFacts = new Map(redundantFunction?.redundant.map(fact => [fact.text, fact.reason]) ?? [])
const expectedRedundantFacts = [
  ['return.length == items.length', 'return.length == items.length'],
  ['return[]: 0..3000', 'return[]: 0..2960'],
] as const
const missingRedundantFacts = expectedRedundantFacts.filter(([fact, reason]) => redundantFacts.get(fact) !== reason)
const redundantSpecStatuses = new Map(redundantFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedRedundantSpecStatuses = [
  ['given items.length: int 0..50', 'assumed'],
  ['return.length == items.length', 'checked'],
  ['return[]: 0..3000', 'checked'],
] as const
const badRedundantSpecStatuses = expectedRedundantSpecStatuses.filter(([text, status]) => redundantSpecStatuses.get(text) !== status)
if (missingRedundantFacts.length > 0 || badRedundantSpecStatuses.length > 0) {
  throw testDiagnosticError('expected function-level redundant facts changed', [
    ...missingRedundantFacts.map(([fact, reason]) => `missing redundant: ${fact} covered by ${reason}`),
    ...badRedundantSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`),
  ])
}
})

test('reports expected equality redundant facts', () => {
const equalityRedundantReport = inferFitFiles(['tests/loops/loop-patterns.ts'], {functionName: 'stackedRowsWithBottom'})
const equalityRedundantFunction = equalityRedundantReport.functions[0]
const equalityRedundantFacts = new Set(equalityRedundantFunction?.facts.map(fact => fact.text) ?? [])
const equalityRedundantSpecs = new Map(equalityRedundantFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedEqualityRedundantFacts = [
  'return.rows[].bottom == (rows[].y + items[].height)',
]
const missingEqualityRedundantFacts = expectedEqualityRedundantFacts.filter(fact => !equalityRedundantFacts.has(fact))
if (missingEqualityRedundantFacts.length > 0 || equalityRedundantSpecs.get('return.rows[].bottom == return.rows[].y + return.rows[].height') !== 'checked') {
  throw testDiagnosticError('expected equality redundant facts changed', missingEqualityRedundantFacts.map(fact => `missing: ${fact}`))
}
})

test('restores loop magnitude proofs for finite default inputs', () => {
const finiteDefaultLoopChecks = verifyFitSource('finite-default-loop.ts', `
/** @fit
 * given count: int 0..100
 * return >= 0
 */
function accumulatedMagnitude(value: number, count: number) {
  let total = 0
  for (let i = 0; i < count; i++) {
    total += value >= 0 ? value : -value
  }
  return total
}
`)
if (finiteDefaultLoopChecks.length !== 1 || finiteDefaultLoopChecks[0]?.status !== 'pass') {
  throw testDiagnosticError('expected finite default inputs to restore the loop magnitude proof', finiteDefaultLoopChecks)
}
})

})
