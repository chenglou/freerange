import {createFunctionContractCache, inferFitFiles, readTopLevelGlobal, verifyFitProgramWithCallsites} from '../../src/check-core.ts'
import {
  addNumbers,
  arraySummary,
  binaryNumberComputation,
  divideNumbers,
  joinValues,
  mergeArraySummary,
  multiplyNumbers,
  numberValue,
  numberWithBounds,
  numberWithComputation,
  sameComputationOperand,
  sameNumberComputation,
  subtractNumbers,
  type ArraySummary,
  type ArrayValue,
  type CollectionValue,
  type SequenceRelation,
} from '../../src/domain.ts'
import {farkasProvesNonNegative, linearMaximum} from '../../src/farkas.ts'
import {linearAdd, linearConstant, linearScale, linearSubtract, linearVariable} from '../../src/linear.ts'
import {runningSumNumber} from '../../src/loop-summary.ts'
import {uniqueUnsupported} from '../../src/infer-report.ts'
import {buildFitSourceFile, TypeScriptUserlandError} from '../../src/modules.ts'
import {preparedProgramContracts} from '../../src/prepared-contracts.ts'
import {rationalEquals} from '../../src/rational.ts'
import {type FitCheck, verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {isFunctionImplementation} from '../../src/function-shape.ts'
import {verifySnapshot} from '../../snapshot.ts'
import {formatTestDiagnostics} from '../test-diagnostics.ts'
import {testSuite} from '../test-suite.ts'

testSuite('check suite', async suite => {
const positiveCatalogs = [
  {path: 'tests/patterns/patterns.ts', expectedChecks: 340},
  {path: 'tests/patterns/loop-patterns.ts', expectedChecks: 115},
  {path: 'tests/imports/import-patterns.ts', expectedChecks: 66},
  {path: 'tests/interpreter-matrix/interpreter-matrix-patterns.ts', expectedChecks: 19},
] as const
const positiveFiles = positiveCatalogs.map(catalog => catalog.path)
const negativeFiles = ['tests/patterns/negative-patterns.ts', 'tests/patterns/negative-shadowed-catalog.ts', 'tests/imports/negative-import-patterns.ts', 'tests/interpreter-matrix/interpreter-matrix-negative.ts']
const negativeExpectedPath = 'negative-patterns.expected.txt'
const inferSnapshotExpectedPath = 'infer-snapshots.expected.txt'
const repoDir = new URL('../..', import.meta.url).pathname
const workspaceDir = repoDir.replace(/\/[^/]+\/$/, '/')

const simplexX = linearVariable('simplex.x')
const simplexY = linearVariable('simplex.y')
const simplexNonnegativeFacts = [
  {diff: simplexX, strict: false},
  {diff: simplexY, strict: false},
]
const simplexBoundedFacts = [
  ...simplexNonnegativeFacts,
  {diff: linearSubtract(linearConstant(2), simplexX)!, strict: false},
  {diff: linearSubtract(linearConstant(3), simplexY)!, strict: false},
]
const simplexSum = linearAdd(simplexX, simplexY)!
const simplexOptimum = linearMaximum(simplexSum, simplexBoundedFacts)
const simplexFractionalOptimum = linearMaximum(simplexSum, [
  ...simplexNonnegativeFacts,
  {diff: linearSubtract(linearConstant(4), linearAdd(linearScale(simplexX, 2), simplexY))!, strict: false},
  {diff: linearSubtract(linearConstant(4), linearAdd(simplexX, linearScale(simplexY, 2)))!, strict: false},
])
const simplexDegenerateOptimum = linearMaximum(simplexSum, [
  ...simplexNonnegativeFacts,
  {diff: linearSubtract(linearConstant(1), simplexX)!, strict: false},
  {diff: linearSubtract(linearConstant(1), simplexY)!, strict: false},
  {diff: linearSubtract(linearConstant(1), simplexSum)!, strict: false},
  {diff: linearSubtract(linearConstant(2), simplexSum)!, strict: false},
])
const simplexNegativeRhsFacts = [
  {diff: linearAdd(simplexX, linearConstant(2))!, strict: false},
  {diff: linearSubtract(linearConstant(-1), simplexX)!, strict: false},
]
const simplexNegativeRhsOptimum = linearMaximum(simplexX, [...simplexNegativeRhsFacts])
const simplexNegativeRhsMinimum = linearMaximum(linearScale(simplexX, -1)!, [...simplexNegativeRhsFacts])
const simplexUnbounded = linearMaximum(simplexX, [{diff: simplexX, strict: false}])
const simplexInfeasible = linearMaximum(simplexX, [
  {diff: linearSubtract(simplexX, linearConstant(1))!, strict: false},
  {diff: linearSubtract(linearConstant(0), simplexX)!, strict: false},
])
const simplexFeasibleBoundary = linearMaximum(simplexX, [
  {diff: linearSubtract(simplexX, linearConstant(1))!, strict: false},
  {diff: linearSubtract(linearConstant(1), simplexX)!, strict: false},
])
if (
  simplexOptimum.kind !== 'optimum'
  || !rationalEquals(simplexOptimum.value, {num: 5n, den: 1n})
  || !rationalEquals(simplexOptimum.point.get('simplex.x')!, {num: 2n, den: 1n})
  || !rationalEquals(simplexOptimum.point.get('simplex.y')!, {num: 3n, den: 1n})
  || simplexFractionalOptimum.kind !== 'optimum'
  || !rationalEquals(simplexFractionalOptimum.value, {num: 8n, den: 3n})
  || !rationalEquals(simplexFractionalOptimum.point.get('simplex.x')!, {num: 4n, den: 3n})
  || !rationalEquals(simplexFractionalOptimum.point.get('simplex.y')!, {num: 4n, den: 3n})
  || simplexDegenerateOptimum.kind !== 'optimum'
  || !rationalEquals(simplexDegenerateOptimum.value, {num: 1n, den: 1n})
  || simplexNegativeRhsOptimum.kind !== 'optimum'
  || !rationalEquals(simplexNegativeRhsOptimum.value, {num: -1n, den: 1n})
  || simplexNegativeRhsMinimum.kind !== 'optimum'
  || !rationalEquals(simplexNegativeRhsMinimum.value, {num: 2n, den: 1n})
  || simplexUnbounded.kind !== 'unbounded'
  || simplexInfeasible.kind !== 'infeasible'
  || simplexFeasibleBoundary.kind !== 'optimum'
  || !rationalEquals(simplexFeasibleBoundary.value, {num: 1n, den: 1n})
  || !farkasProvesNonNegative(simplexSum, false, simplexNonnegativeFacts)
  || farkasProvesNonNegative(linearSubtract(simplexX, simplexY)!, false, simplexNonnegativeFacts)
  || !farkasProvesNonNegative(simplexX, true, [
    {diff: linearSubtract(simplexX, simplexY)!, strict: false},
    {diff: simplexY, strict: true},
  ])
  || farkasProvesNonNegative(simplexX, true, [
    {diff: linearSubtract(simplexX, simplexY)!, strict: false},
    {diff: simplexY, strict: false},
  ])
  || !farkasProvesNonNegative(simplexX, true, [
    {diff: linearSubtract(linearScale(simplexX, 2), simplexY)!, strict: false},
    {diff: simplexY, strict: true},
  ])
  || farkasProvesNonNegative(simplexX, true, [
    {diff: linearSubtract(linearScale(simplexX, 2), simplexY)!, strict: false},
    {diff: simplexY, strict: false},
  ])
) {
  console.error('expected simplex pivots to preserve bounded, unbounded, infeasible, and proof results')
  suite.fail()
}

const callableFamilyProgram = buildFitSourceFile('callable-family.ts', `
export default () => 1
export const arrow = () => 1
export function declared() { return 1 }
class Box {
  constructor() {}
  method() { return 1 }
  static method() { return 1 }
  get value() { return 1 }
  set value(next: number) { void next }
}
`, readTopLevelGlobal)
const expectedCallableNames = [
  'default',
  'arrow',
  'declared',
  'Box.constructor',
  'Box.method',
  'Box.static.method',
  'Box.value',
  'Box.set.value',
]
const callableFamilyNames = [...callableFamilyProgram.functions.keys()]
if (
  expectedCallableNames.some(name => !callableFamilyNames.includes(name))
  || callableFamilyNames.some(name => !expectedCallableNames.includes(name))
  || [...callableFamilyProgram.functions.values()].some(fn => !isFunctionImplementation(fn.node))
) {
  console.error('expected every supported function implementation to share one indexed declaration family')
  console.error(formatTestDiagnostics(callableFamilyNames))
  suite.fail()
}

function verifyFitSourceWithCallsites(file: string, sourceText: string) {
  const program = buildFitSourceFile(file, sourceText, readTopLevelGlobal)
  return verifyFitProgramWithCallsites(program, createFunctionContractCache())
}

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
  console.error('expected every positive catalog obligation to exist and pass')
  for (const catalog of positiveCountFailures) {
    console.error(`${catalog.path}: expected ${catalog.expectedChecks}, got ${actualPositiveCounts.get(catalog.path) ?? 0}`)
  }
  for (const path of unexpectedPositiveFiles) console.error(`unexpected positive catalog: ${path}`)
  for (const check of positiveReport.checks.filter(check => check.status !== 'pass')) {
    console.error(`${check.status.toUpperCase()} ${check.file}:${check.functionName}: ${check.text}`)
  }
  suite.fail()
}

const unboundedNonnegativeProduct = multiplyNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'right'),
)
// Zero times Infinity is NaN, and both are admitted here, so the hull must
// widen fully for the NaN exclusion to see it.
if (unboundedNonnegativeProduct.min !== Number.NEGATIVE_INFINITY || unboundedNonnegativeProduct.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected the NaN-admitting product to widen fully, got ${unboundedNonnegativeProduct.min}..${unboundedNonnegativeProduct.max}`)
  suite.fail()
}

const unboundedNonnegativeQuotient = divideNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(1, Number.POSITIVE_INFINITY, null, 'right'),
)
// Infinity over Infinity is NaN, and both sides admit Infinity here.
if (unboundedNonnegativeQuotient.kind !== 'number' || unboundedNonnegativeQuotient.min !== Number.NEGATIVE_INFINITY || unboundedNonnegativeQuotient.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected the NaN-admitting quotient to widen fully, got ${unboundedNonnegativeQuotient.kind === 'number' ? `${unboundedNonnegativeQuotient.min}..${unboundedNonnegativeQuotient.max}` : unboundedNonnegativeQuotient.kind}`)
  suite.fail()
}

const unboundedNonnegativeRunningSum = runningSumNumber(
  'y',
  numberValue(0, Number.POSITIVE_INFINITY, null, 'start'),
  numberValue(0, Number.POSITIVE_INFINITY, 0, 'count'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'increment'),
)
if (unboundedNonnegativeRunningSum.min !== 0 || unboundedNonnegativeRunningSum.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity running sum, got ${unboundedNonnegativeRunningSum.min}..${unboundedNonnegativeRunningSum.max}`)
  suite.fail()
}

const unboundedDifference = subtractNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'right'),
)
if (unboundedDifference.min !== Number.NEGATIVE_INFINITY || unboundedDifference.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected -Infinity..Infinity difference, got ${unboundedDifference.min}..${unboundedDifference.max}`)
  suite.fail()
}

const numericAlternativeBudgetChecks = verifyFitSource('numeric-alternative-budget.ts', `function choice(n: number) {
  return n === 0 ? 0
    : n === 1 ? 1
      : n === 2 ? 2
        : n === 3 ? 3
          : n === 4 ? 4
            : n === 5 ? 5
              : n === 6 ? 6
                : n === 7 ? 7
                  : 8
}

/** @fit
 * given n: int 0..8
 * return: 0..8
 */
function broad(n: number) {
  return choice(n)
}

/** @fit
 * given n: int 0..8
 * return: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
 */
function exact(n: number) {
  return choice(n)
}
`)
const broadNumericAlternatives = numericAlternativeBudgetChecks.find(check =>
  check.functionName === 'broad' && check.text === 'return: 0..8')
const exactNumericAlternatives = numericAlternativeBudgetChecks.find(check =>
  check.functionName === 'exact' && check.text.includes('0 | 1 | 2'))
if (
  broadNumericAlternatives?.status !== 'pass'
  || exactNumericAlternatives?.status !== 'unknown'
  || exactNumericAlternatives.reason?.includes('Numeric alternative budget exceeded') !== true
) {
  console.error('expected numeric alternative overflow to keep its range and report lost exact choices')
  console.error(formatTestDiagnostics(numericAlternativeBudgetChecks))
  suite.fail()
}

const computationLeft = numberValue(0, 1000, null, 'left', linearVariable('left'))
const computationHeight = numberValue(0, 40, null, 'height', linearVariable('height'))
const computationGap = numberValue(0, 10, null, 'gap', linearVariable('gap'))
const computedAdd = (left: typeof computationLeft, right: typeof computationLeft) =>
  numberWithComputation(addNumbers(left, right), binaryNumberComputation('+', left, right))
const computationBottom = computedAdd(computationLeft, computationHeight)
const computationNext = computedAdd(computationBottom, computationGap)
const computationNextAgain = computedAdd(computationBottom, computationGap)
const computationRegrouped = computedAdd(computationLeft, computedAdd(computationHeight, computationGap))
const sameComputationJoin = joinValues(computationNext, computationNextAgain)
const regroupedComputationJoin = joinValues(computationNext, computationRegrouped)
const narrowedComputation = numberWithBounds(computationNext, 0, 100)
const refinedComputationLeft = numberWithBounds(computationLeft, 100, 500, 0)
const refinedOperandJoin = joinValues(computationBottom, computedAdd(refinedComputationLeft, computationHeight))
const reverseRefinedOperandJoin = joinValues(computedAdd(refinedComputationLeft, computationHeight), computationBottom)
const commutedAdd = binaryNumberComputation('+', computationHeight, computationLeft)
const commutedMultiply = binaryNumberComputation('*', computationHeight, computationLeft)
const unrelatedContainedJoin = joinValues(
  numberValue(0, 100, null, 'broad', linearVariable('broad')),
  numberValue(20, 30, null, 'other', linearVariable('other')),
)
const unrelatedContainedCasesRetainIdentity = unrelatedContainedJoin.kind === 'number'
  && unrelatedContainedJoin.cases?.some(branch => branch.value.linear != null || branch.value.computation != null) === true
if (
  computationNext.computation == null
  || computationRegrouped.computation == null
  || !sameNumberComputation(computationNext.computation, computationNextAgain.computation)
  || !sameNumberComputation(computationBottom.computation, commutedAdd)
  || !sameNumberComputation(binaryNumberComputation('*', computationLeft, computationHeight), commutedMultiply)
  || sameNumberComputation(binaryNumberComputation('-', computationLeft, computationHeight), binaryNumberComputation('-', computationHeight, computationLeft))
  || sameNumberComputation(binaryNumberComputation('/', computationLeft, computationHeight), binaryNumberComputation('/', computationHeight, computationLeft))
  || sameNumberComputation(binaryNumberComputation('%', computationLeft, computationHeight), binaryNumberComputation('%', computationHeight, computationLeft))
  || sameNumberComputation(binaryNumberComputation('**', computationLeft, computationHeight), binaryNumberComputation('**', computationHeight, computationLeft))
  || sameNumberComputation(computationNext.computation, computationRegrouped.computation)
  || !sameComputationOperand(computationLeft, refinedComputationLeft)
  || sameComputationJoin.kind !== 'number'
  || sameComputationJoin.computation == null
  || regroupedComputationJoin.kind !== 'number'
  || regroupedComputationJoin.computation != null
  || narrowedComputation.computation == null
  || !sameNumberComputation(computationNext.computation, narrowedComputation.computation)
  || refinedOperandJoin.kind !== 'number'
  || refinedOperandJoin.computation?.kind !== 'binary'
  || refinedOperandJoin.computation.left.min !== 0
  || refinedOperandJoin.computation.left.max !== 1000
  || reverseRefinedOperandJoin.kind !== 'number'
  || !sameNumberComputation(refinedOperandJoin.computation, reverseRefinedOperandJoin.computation)
  || unrelatedContainedCasesRetainIdentity
) {
  console.error('expected numeric computation identity to ignore refinement, merge facts, preserve grouping, and support commutativity')
  suite.fail()
}

const exactSequenceRelation: SequenceRelation = {
  kind: 'adjacent-comparison',
  left: {item: 'next', path: ['y']},
  op: '==',
  right: {
    terms: [
      {item: 'previous', path: ['y']},
      {item: 'previous', path: ['height']},
    ],
    addends: ['gap'],
  },
}
const nondecreasingSequenceRelation: SequenceRelation = {
  kind: 'adjacent-comparison',
  left: {item: 'next', path: ['y']},
  op: '>=',
  right: {terms: [{item: 'previous', path: ['y']}], addends: []},
}
const equalYSequenceRelation: SequenceRelation = {
  kind: 'adjacent-comparison',
  left: {item: 'next', path: ['y']},
  op: '==',
  right: {terms: [{item: 'previous', path: ['y']}], addends: []},
}
const commutedExactSequenceRelation: SequenceRelation = {
  ...exactSequenceRelation,
  right: {
    terms: [
      {item: 'previous', path: ['height']},
      {item: 'previous', path: ['y']},
    ],
    addends: ['gap'],
  },
}
const operationalSequenceRelation: SequenceRelation = {
  kind: 'adjacent-addition',
  left: {item: 'next', path: ['y']},
  op: '==',
  right: {
    kind: 'add',
    left: {
      kind: 'add',
      left: {kind: 'term', term: {item: 'previous', path: ['y']}},
      right: {kind: 'term', term: {item: 'previous', path: ['height']}},
    },
    right: {kind: 'invariant', text: 'gap'},
  },
}
const summaryDeltaWide = numberValue(0, 10, null, 'delta', linearVariable('delta'))
const summaryDeltaNarrow = numberValue(2, 4, null, 'otherDelta', linearVariable('otherDelta'))
const summaryEnd = numberValue(0, 100, null, 'end', linearVariable('end'))
const summaryOtherEnd = numberValue(20, 80, null, 'otherEnd', linearVariable('otherEnd'))
const baseArraySummary: ArraySummary = {
  relations: [exactSequenceRelation],
  advances: [{prop: 'y', value: summaryDeltaWide}],
  lastEnd: {value: summaryEnd, positionPath: ['y'], sizePath: ['height']},
  extentEnds: [{emptyExpr: 'top', value: summaryEnd, positionPath: ['y'], sizePath: ['height']}],
}
function arrayWithSummary(summary: ArraySummary): CollectionValue {
  return {
    kind: 'array',
    referenceIds: [],
    layout: 'collection',
    length: numberValue(0, 10, 0, 'rows.length', linearVariable('rows.length')),
    element: null,
    expr: 'rows',
    summary,
  }
}
const reorderedSummaryJoin = joinValues(
  arrayWithSummary({...baseArraySummary, relations: [exactSequenceRelation, nondecreasingSequenceRelation]}),
  arrayWithSummary({...baseArraySummary, relations: [nondecreasingSequenceRelation, exactSequenceRelation]}),
)
const mismatchedSummaryJoin = joinValues(
  arrayWithSummary(baseArraySummary),
  arrayWithSummary({...baseArraySummary, relations: [operationalSequenceRelation]}),
)
const reverseMismatchedSummaryJoin = joinValues(
  arrayWithSummary({...baseArraySummary, relations: [operationalSequenceRelation]}),
  arrayWithSummary(baseArraySummary),
)
const mismatchedEndSummaryJoin = joinValues(
  arrayWithSummary(baseArraySummary),
  arrayWithSummary({
    ...baseArraySummary,
    lastEnd: {value: summaryEnd, positionPath: ['x'], sizePath: ['width']},
    extentEnds: [{emptyExpr: 'top', value: summaryEnd, positionPath: ['x'], sizePath: ['width']}],
  }),
)
const joinedAdvanceSummary = joinValues(
  arrayWithSummary(baseArraySummary),
  arrayWithSummary({...baseArraySummary, advances: [{prop: 'y', value: summaryDeltaNarrow}]}),
)
const reverseJoinedAdvanceSummary = joinValues(
  arrayWithSummary({...baseArraySummary, advances: [{prop: 'y', value: summaryDeltaNarrow}]}),
  arrayWithSummary(baseArraySummary),
)
const sharedGuaranteeSummaryJoin = joinValues(
  arrayWithSummary({...baseArraySummary, relations: [equalYSequenceRelation]}),
  arrayWithSummary({...baseArraySummary, relations: [nondecreasingSequenceRelation]}),
)
const commutedRelationSummaryJoin = joinValues(
  arrayWithSummary({...baseArraySummary, relations: [exactSequenceRelation]}),
  arrayWithSummary({...baseArraySummary, relations: [commutedExactSequenceRelation]}),
)
const structuralEndSummaryJoin = joinValues(
  arrayWithSummary(baseArraySummary),
  arrayWithSummary({
    ...baseArraySummary,
    lastEnd: {...baseArraySummary.lastEnd!, value: summaryOtherEnd},
    extentEnds: [{...baseArraySummary.extentEnds[0]!, value: summaryOtherEnd}],
  }),
)
const definitelyEmptyArray: ArrayValue = {
  ...arrayWithSummary(baseArraySummary),
  length: numberValue(0, 0, 0, 'empty.length', linearVariable('empty.length')),
  summary: null,
}
const emptyBranchSummaryJoin = joinValues(definitelyEmptyArray, arrayWithSummary(baseArraySummary))
const incompatibleAccumulation = mergeArraySummary(baseArraySummary, {
  ...baseArraySummary,
  lastEnd: {value: summaryEnd, positionPath: ['x'], sizePath: ['width']},
})
if (
  reorderedSummaryJoin.kind !== 'array'
  || arraySummary(reorderedSummaryJoin)?.relations.length !== 2
  || mismatchedSummaryJoin.kind !== 'array'
  || arraySummary(mismatchedSummaryJoin)?.relations.length !== 0
  || reverseMismatchedSummaryJoin.kind !== 'array'
  || arraySummary(reverseMismatchedSummaryJoin)?.relations.length !== 0
  || mismatchedEndSummaryJoin.kind !== 'array'
  || arraySummary(mismatchedEndSummaryJoin)?.lastEnd != null
  || arraySummary(mismatchedEndSummaryJoin)?.extentEnds.length !== 0
  || joinedAdvanceSummary.kind !== 'array'
  || arraySummary(joinedAdvanceSummary)?.advances[0]?.value.min !== 0
  || arraySummary(joinedAdvanceSummary)?.advances[0]?.value.max !== 10
  || reverseJoinedAdvanceSummary.kind !== 'array'
  || arraySummary(reverseJoinedAdvanceSummary)?.advances[0]?.value.min !== 0
  || arraySummary(reverseJoinedAdvanceSummary)?.advances[0]?.value.max !== 10
  || sharedGuaranteeSummaryJoin.kind !== 'array'
  || arraySummary(sharedGuaranteeSummaryJoin)?.relations[0]?.op !== '>='
  || commutedRelationSummaryJoin.kind !== 'array'
  || arraySummary(commutedRelationSummaryJoin)?.relations.length !== 1
  || structuralEndSummaryJoin.kind !== 'array'
  || arraySummary(structuralEndSummaryJoin)?.lastEnd?.value.min !== 0
  || arraySummary(structuralEndSummaryJoin)?.lastEnd?.value.max !== 100
  || arraySummary(structuralEndSummaryJoin)?.extentEnds[0]?.value.min !== 0
  || arraySummary(structuralEndSummaryJoin)?.extentEnds[0]?.value.max !== 100
  || emptyBranchSummaryJoin.kind !== 'array'
  || arraySummary(emptyBranchSummaryJoin)?.relations.length !== 1
  || arraySummary(emptyBranchSummaryJoin)?.lastEnd != null
  || incompatibleAccumulation?.lastEnd != null
) {
  console.error('expected array summaries to join common facts by semantic identity and preserve path-sensitive ends')
  suite.fail()
}

const computationIdentityChecks = verifyFitSource('computation-identity.ts', `
/** @fit
 * given left: -100..100
 * given right: -100..100
 * return.sum == right + left
 * return.product == right * left
 */
function commutative(left: number, right: number) {
  return {sum: left + right, product: left * right}
}
`)
const computationIdentityFailures = computationIdentityChecks.filter(check => check.status !== 'pass')
if (computationIdentityFailures.length > 0 || computationIdentityChecks.length !== 2) {
  console.error('expected commutative computations to retain runtime identity')
  console.error(formatTestDiagnostics(computationIdentityChecks))
  suite.fail()
}

const nanComputationIdentityChecks = verifyFitSource('nan-computation-identity.ts', `
/** @fit
 * return == right + left
 */
function nanCapableCommutative(left: number, right: number) {
  return left + right
}
`)
if (nanComputationIdentityChecks.length !== 1 || nanComputationIdentityChecks[0]?.status !== 'pass') {
  console.error('expected checked number inputs to exclude NaN by default')
  console.error(formatTestDiagnostics(nanComputationIdentityChecks))
  suite.fail()
}

const finiteDefaultChecks = verifyFitSourceWithCallsites('finite-default.ts', `
/** @fit
 * return: -Infinity<..<Infinity
 */
function needsFinite(value: number) {
  return value
}

/** @fit
 * given value: -Infinity..Infinity
 * pure
 */
function needsNonNaN(value: number) {
  return value
}

/** @fit
 * pure
 */
function forwardsChecked(value: number) {
  return needsFinite(value)
}

function guardedExternal(value: number) {
  if (!Number.isFinite(value)) return
  needsFinite(value)
}

function unguardedExternal(value: number) {
  needsFinite(value)
}

function integerExternal(value: number) {
  if (!Number.isInteger(value)) return
  needsFinite(value)
}

function safeIntegerExternal(value: number) {
  if (!Number.isSafeInteger(value)) return
  needsFinite(value)
}

function nonNaNExternal(value: number) {
  if (Number.isNaN(value)) return
  needsNonNaN(value)
}

/** @fit
 * given value: -100..100
 * pure
 */
function boundedDouble(value: number) {
  return needsFinite(value * 2)
}

/** @fit
 * pure
 */
function overflowingDouble(value: number) {
  return needsFinite(value * 2)
}
`)
const finiteDefaultAllChecks = [...finiteDefaultChecks.annotationChecks, ...finiteDefaultChecks.callsiteChecks]
const finiteDefaultStatus = (functionName: string, text: string) => finiteDefaultAllChecks.find(check =>
  check.functionName.includes(functionName) && check.text.includes(text))?.status
const expectedPassingFiniteDefaultFunctions = new Set([
  'forwardsChecked',
  'guardedExternal',
  'integerExternal',
  'safeIntegerExternal',
  'boundedDouble',
])
if (
  finiteDefaultStatus('needsFinite', 'return: -Infinity<..<Infinity') !== 'pass'
  || finiteDefaultStatus('unguardedExternal', 'requires value to be finite') !== 'requires'
  || !finiteDefaultAllChecks.some(check => check.functionName.includes('overflowingDouble')
    && check.text.includes('to be finite')
    && (check.status === 'unknown' || check.status === 'requires'))
  || finiteDefaultAllChecks.some(check =>
    expectedPassingFiniteDefaultFunctions.has(check.functionName.split(' > ')[0]!)
    && check.status !== 'pass')
  || !finiteDefaultAllChecks.some(check => check.functionName.includes('nonNaNExternal')
    && check.text.includes('requires value: -Infinity..Infinity')
    && check.status === 'pass')
) {
  console.error('expected finite defaults to apply only at checked contracts and to publish call requirements')
  console.error(formatTestDiagnostics(finiteDefaultChecks))
  suite.fail()
}

const finiteLeafChecks = verifyFitSourceWithCallsites('finite-leaves.ts', `
/** @fit
 * pure
 */
function reads(input: {width: number; rows: {height: number}[]}) {
  return input.width
}

/** @fit
 * given input.width: 0..Infinity
 * pure
 */
function allowsInfiniteWidth(input: {width: number; height: number}) {
  return input.width
}

/** @fit
 * pure
 */
function destructuredWidth({width}: {width: number}) {
  return width
}

reads({width: Infinity, rows: [{height: 1}]})
reads({width: 1, rows: [{height: Infinity}]})
allowsInfiniteWidth({width: Infinity, height: 1})
allowsInfiniteWidth({width: 1, height: Infinity})
destructuredWidth({width: Infinity})
`)
const finiteLeafCallChecks = finiteLeafChecks.callsiteChecks
const infiniteWidth = finiteLeafCallChecks.find(check => check.text.startsWith('reads({width: Infinity') && check.text.includes('.width to be finite'))
const infiniteHeight = finiteLeafCallChecks.find(check => check.text.startsWith('reads({width: 1') && check.text.includes('.rows[].height to be finite'))
const allowedWidth = finiteLeafCallChecks.find(check => check.text.startsWith('allowsInfiniteWidth({width: Infinity') && check.text.includes('input.width: 0..Infinity'))
const rejectedSibling = finiteLeafCallChecks.find(check => check.text.startsWith('allowsInfiniteWidth({width: 1') && check.text.includes('.height to be finite'))
const rejectedDestructured = finiteLeafCallChecks.find(check => check.text.startsWith('destructuredWidth({width: Infinity') && check.text.includes('requires Infinity to be finite'))
if (
  infiniteWidth?.status !== 'fail'
  || infiniteHeight?.status !== 'fail'
  || allowedWidth?.status !== 'pass'
  || rejectedSibling?.status !== 'fail'
  || rejectedDestructured?.status !== 'fail'
) {
  console.error('expected finite defaults on nested numeric leaves and exact-path range replacement')
  console.error(formatTestDiagnostics(finiteLeafChecks))
  suite.fail()
}

const resolvedFiniteLeafChecks = verifyFitSourceWithCallsites('resolved-finite-leaves.ts', `
type Box<T> = {value: T}
interface Base {value: number}
interface Derived extends Base {}
type OptionalChild = {child?: {value: number}}
type NullableChild = {child: {value: number} | null}
type NumericChoice = {kind: 'number'; value: number} | {kind: 'text'; value: string}

/** @fit
 * pure
 */
function genericLeaf(input: Box<number>) {
  return input.value
}

/** @fit
 * pure
 */
function inheritedLeaf(input: Derived) {
  return input.value
}

/** @fit
 * pure
 */
function destructuredRows({rows}: {rows: {height: number}[]}) {
  return rows[0]!.height
}

/** @fit
 * return >= 0
 */
function optionalLeaf(input: {value?: number}) {
  const value = input.value ?? 0
  return value >= 0 ? value : -value
}

/** @fit
 * return >= 0
 */
function nullableLeaf(value: number | null) {
  if (value === null) return 0
  return value >= 0 ? value : -value
}

/** @fit
 * return >= 0
 */
function inferredLeaf(value = 0) {
  return value >= 0 ? value : -value
}

/** @fit
 * pure
 */
function optionalChild(input: OptionalChild) {
  return input.child?.value ?? 0
}

/** @fit
 * pure
 */
function nullableChild(input: NullableChild) {
  return input.child?.value ?? 0
}

/** @fit
 * pure
 */
function unionNumericLeaf(input: NumericChoice) {
  return input.value
}

/** @fit
 * given !flag
 * pure
 */
function requiresFalse(flag: boolean) {}

function comparisonExcludesNaN(value: number) {
  if (value < 0) requiresFalse(Number.isNaN(value))
}

genericLeaf({value: Infinity})
inheritedLeaf({value: Infinity})
destructuredRows({rows: [{height: Infinity}]})
optionalLeaf({})
optionalLeaf({value: Infinity})
nullableLeaf(null)
nullableLeaf(Infinity)
inferredLeaf(Infinity)
genericLeaf({} as any)
optionalChild({})
optionalChild({child: {value: Infinity}})
nullableChild({child: null})
nullableChild({child: {value: Infinity}})
unionNumericLeaf({kind: 'text', value: 'ok'})
unionNumericLeaf({kind: 'number', value: Infinity})
`)
const resolvedFiniteChecks = [...resolvedFiniteLeafChecks.annotationChecks, ...resolvedFiniteLeafChecks.callsiteChecks]
const expectedResolvedFiniteFailures = [
  'genericLeaf',
  'inheritedLeaf',
  'destructuredRows',
  'optionalLeaf',
  'nullableLeaf',
  'inferredLeaf',
  'optionalChild',
  'nullableChild',
  'unionNumericLeaf',
]
if (
  resolvedFiniteLeafChecks.annotationChecks.some(check => check.status !== 'pass')
  || expectedResolvedFiniteFailures.some(functionName => !resolvedFiniteLeafChecks.callsiteChecks.some(check =>
    check.text.startsWith(`${functionName}(`) && check.status === 'fail' && check.text.includes('to be finite')))
  || resolvedFiniteChecks.some(check =>
    check.text.startsWith('optionalLeaf({})')
    || check.text.startsWith('nullableLeaf(null)')
    || check.text.startsWith('optionalChild({})')
    || check.text.startsWith('nullableChild({child: null})')
    || check.text.startsWith("unionNumericLeaf({kind: 'text'"))
  || !resolvedFiniteLeafChecks.callsiteChecks.some(check => check.text.startsWith('genericLeaf({} as any)') && check.status === 'unknown')
  || !resolvedFiniteLeafChecks.callsiteChecks.some(check => check.text.startsWith('requiresFalse(Number.isNaN(value))') && check.status === 'pass')
) {
  console.error('expected resolved, inherited, destructured, optional, nullable, and inferred number leaves to share the finite boundary')
  console.error(formatTestDiagnostics(resolvedFiniteLeafChecks))
  suite.fail()
}

const recursiveFiniteDefaultChecks = verifyFitSource('recursive-finite-default.ts', `
type Tree = {value: number; children: Tree[]}
type Labels = {name: string; children: Labels[]}

/** @fit
 * pure
 */
function walk(tree: Tree) {
  return tree.value
}

/** @fit
 * pure
 */
function labels(tree: Labels) {
  return tree.name
}
`)
if (!recursiveFiniteDefaultChecks.some(check => check.status === 'unknown'
  && check.reason === 'Recursive input types cannot publish the finite numeric default')
  || recursiveFiniteDefaultChecks.some(check => check.functionName === 'labels' && check.status !== 'pass')) {
  console.error('expected recursive numeric input types to be rejected instead of silently dropping finite leaves')
  console.error(formatTestDiagnostics(recursiveFiniteDefaultChecks))
  suite.fail()
}

const checkedNumberOperationChecks = verifyFitSource('checked-number-operations.ts', `
/** @fit
 * given extent: 0..Infinity
 * return >= 0
 */
function zeroTimesInfinity(extent: number) {
  return (0 * extent) + 1
}

/** @fit
 * given angle: 0..Infinity
 * return: -1..1
 */
function infiniteSine(angle: number) {
  return Math.sin(angle)
}

/** @fit
 * return: 0..Infinity
 */
function benignOverflow() {
  return Number.MAX_VALUE * 2
}

/** @fit
 * return: -Infinity<..<Infinity
 */
function parsedFinite(text: string) {
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return 0
  return value
}

/** @fit
 * return: 0..10
 */
function deliberateNaN(): number {
  return NaN
}

/** @fit
 * return: 0..10
 */
function oneNaNBranch(flag: boolean): number {
  return flag ? 3 : Number.NaN
}

/** @fit
 * return: int -Infinity<..<Infinity
 */
function integerGuard(value: number) {
  if (!Number.isInteger(value)) return 0
  return value
}

/** @fit
 * return: int -9007199254740991..9007199254740991
 */
function safeIntegerGuard(value: number) {
  if (!Number.isSafeInteger(value)) return 0
  return value
}

/** @fit
 * return: int 0..Infinity
 */
function inclusiveIntegerInfinity() {
  return Infinity
}

/** @fit
 * given value: int 0..Infinity
 * return: int 0..Infinity
 */
function acceptsIntegerInfinity(value: number) {
  return value
}

/** @fit
 * return == Infinity
 */
function callsIntegerInfinity() {
  return acceptsIntegerInfinity(Infinity)
}

/** @fit
 * return == "number"
 */
function nanTypeof() {
  return typeof NaN
}

/** @fit
 * return
 */
function directNaNPredicate() {
  return Number.isNaN(NaN)
}

/** @fit
 * given value: 0..10 | Infinity
 * return: 0..10
 */
function finiteAlternative(value: number) {
  if (!Number.isFinite(value)) return 0
  return value
}

/** @fit
 * given value: 0..10 | 10.5 | Infinity
 * return: int 0..10
 */
function integerAlternative(value: number) {
  if (!Number.isInteger(value)) return 0
  return value
}

/** @fit
 * given value: -0.5..10.5
 * return: int 0..10
 */
function integerInterval(value: number) {
  if (!Number.isInteger(value)) return 0
  return value
}

/** @fit
 * given factor: 0..1
 * given extent: 0..Infinity
 * return >= 0
 */
function guardedInfiniteProduct(factor: number, extent: number) {
  if (factor <= 0) return 0
  return factor * extent
}

/** @fit
 * given divisor: 0..Infinity
 * return >= 0
 */
function guardedDivision(divisor: number) {
  if (divisor <= 0) return 0
  return 1 / divisor
}

/** @fit
 * return == Infinity
 */
function emptyMinimum() {
  return Math.min()
}

/** @fit
 * return == -Infinity
 */
function emptyMaximum() {
  return Math.max()
}

/** @fit
 * return == -1
 */
function negativeRemainder() {
  return -5 % 2
}

/** @fit
 * given base: -2..-1
 * return: 1..4
 */
function negativeSquare(base: number) {
  return base ** 2
}

/** @fit
 * return >= 0
 */
function nanUnderUnary() {
  return -(0 * Infinity)
}

/** @fit
 * return >= 0
 */
function nanUnderCompound() {
  let value = 0 * Infinity
  value += 1
  return value
}


/** @fit
 * return >= 0
 */
function uncheckedSquare(text: string) {
  const value = Number.parseFloat(text)
  return value ** 2
}
`)
const zeroTimesInfinity = checkedNumberOperationChecks.find(check => check.functionName === 'zeroTimesInfinity')
const infiniteSine = checkedNumberOperationChecks.find(check => check.functionName === 'infiniteSine')
const benignOverflow = checkedNumberOperationChecks.find(check => check.functionName === 'benignOverflow')
const parsedFinite = checkedNumberOperationChecks.find(check => check.functionName === 'parsedFinite')
const deliberateNaN = checkedNumberOperationChecks.find(check => check.functionName === 'deliberateNaN')
const oneNaNBranch = checkedNumberOperationChecks.find(check => check.functionName === 'oneNaNBranch')
const integerGuard = checkedNumberOperationChecks.find(check => check.functionName === 'integerGuard')
const safeIntegerGuard = checkedNumberOperationChecks.find(check => check.functionName === 'safeIntegerGuard')
const expectedPassingNumberFunctions = new Set([
  'inclusiveIntegerInfinity',
  'acceptsIntegerInfinity',
  'callsIntegerInfinity',
  'nanTypeof',
  'directNaNPredicate',
  'finiteAlternative',
  'integerAlternative',
  'integerInterval',
  'guardedInfiniteProduct',
  'guardedDivision',
  'emptyMinimum',
  'emptyMaximum',
  'negativeRemainder',
  'negativeSquare',
])
const missingPassingNumberFunctions = [...expectedPassingNumberFunctions].filter(functionName =>
  !checkedNumberOperationChecks.some(check => check.functionName === functionName))
const nanUnderUnary = checkedNumberOperationChecks.find(check => check.functionName === 'nanUnderUnary')
const nanUnderCompound = checkedNumberOperationChecks.find(check => check.functionName === 'nanUnderCompound')
const uncheckedSquare = checkedNumberOperationChecks.find(check => check.functionName === 'uncheckedSquare')
if (
  zeroTimesInfinity?.status !== 'unknown'
  || zeroTimesInfinity.reason?.includes('zero and infinity may meet') !== true
  || zeroTimesInfinity.reason.includes('+ 1')
  || infiniteSine?.status !== 'unknown'
  || infiniteSine.reason?.includes('expected a finite number') !== true
  || benignOverflow?.status !== 'pass'
  || parsedFinite?.status !== 'pass'
  || deliberateNaN?.status !== 'unknown'
  || deliberateNaN.reason !== 'NaN is outside the checked numerical domain'
  || oneNaNBranch?.status !== 'unknown'
  || oneNaNBranch.reason !== 'NaN is outside the checked numerical domain'
  || integerGuard?.status !== 'pass'
  || safeIntegerGuard?.status !== 'pass'
  || missingPassingNumberFunctions.length > 0
  || checkedNumberOperationChecks.some(check => expectedPassingNumberFunctions.has(check.functionName) && check.status !== 'pass')
  || nanUnderUnary?.status !== 'unknown'
  || nanUnderUnary.reason?.startsWith('0 * Infinity is unknown because') !== true
  || nanUnderCompound?.status !== 'unknown'
  || nanUnderCompound.reason?.startsWith('0 * Infinity is unknown because') !== true
  || uncheckedSquare?.status !== 'unknown'
  || uncheckedSquare.reason?.includes('operand may be NaN') !== true
) {
  console.error('expected NaN hazards to stop at their source while overflow and guarded parsing remain usable')
  console.error(formatTestDiagnostics(checkedNumberOperationChecks))
  suite.fail()
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
  console.error('expected checks to carry proof obligations and used facts')
  console.error(formatTestDiagnostics({obligationChecks, sequenceObligationCheck}))
  suite.fail()
}

const pureContractHelperChecks = verifyFitSource('contract-purity.ts', `function safeLimit(value: number) {
  let floor = 9
  floor += 1
  return Math.max(value, floor)
}

/** @fit
 * given value: 0..10
 * return <= safeLimit(value)
 */
function bounded(value: number) {
  return value
}
`)
const pureContractHelperCheck = pureContractHelperChecks.find(check => check.functionName === 'bounded' && check.text === 'return <= safeLimit(value)')
if (pureContractHelperCheck?.status !== 'pass') {
  console.error('expected pure unannotated helper calls to work in contracts')
  console.error(formatTestDiagnostics(pureContractHelperChecks))
  suite.fail()
}

const pureGivenHelperChecks = verifyFitSource('given-contract-purity.ts', `function double(value: number) {
  return value * 2
}

/** @fit
 * given max >= double(min)
 * given width: double(min)..max
 * return.scaled <= max
 * return.width >= double(min)
 * return.width <= max
 */
function bounded(min: number, width: number, max: number) {
  return {scaled: double(min), width}
}
`)
const pureGivenHelperFailures = pureGivenHelperChecks.filter(check => check.status !== 'pass')
if (pureGivenHelperFailures.length > 0) {
  console.error('expected pure unannotated helper calls to work in given comparisons and range bounds')
  console.error(formatTestDiagnostics(pureGivenHelperChecks))
  suite.fail()
}

const shortcutCleanupChecks = verifyFitSource('shortcut-cleanup.ts', `type AliasRect = {left: number}

/** @fit
 * given input.width: 0..10
 * return: 0..10
 */
function typedGivenPath(input: {width: number}) {
  return input.width
}

/** @fit
 * given rect.left: 0..10
 * return: 0..10
 */
function typedAliasPath(rect: AliasRect) {
  return rect.left
}

/** @fit
 * given input.width: 0..10
 * return: 0..10
 */
function optionalGivenField(input: Partial<{width: number}>) {
  return input.width ?? 0
}

/** @fit
 * given input.width: 0..10
 * return: 0..10
 */
function missingGivenField(input: {}) {
  return 0
}

/** @fit
 * given input.width: 0..10
 * return: 0..10
 */
function stringGivenField(input: {width: string}) {
  return 0
}

/** @fit
 * given rows[].height: 0..10
 * return: 0..10
 */
function nonArrayGivenPath(rows: {height: number}) {
  return 0
}

/** @fit
 * given input: 0..10
 * return: 1..11
 */
function unknownParamGiven(input: unknown) {
  void input
  return 1
}

/** @fit
 * given items[].width: 0..10
 * return: 0..10
 */
function typedCallbackItem(items: {width: number}[]) {
  return items.map(item => item.width)[0] ?? 0
}

/** @fit
 * given items[].width: 0..10
 * return: 0..10
 */
function missingCallbackItemField(items: {}[]) {
  void items
  return 0
}
`)
const typedGivenPathFailures = shortcutCleanupChecks.filter(check => check.functionName === 'typedGivenPath' && check.status !== 'pass')
const typedAliasPathFailures = shortcutCleanupChecks.filter(check => check.functionName === 'typedAliasPath' && check.status !== 'pass')
const optionalGivenFieldCheck = shortcutCleanupChecks.find(check => check.functionName === 'optionalGivenField' && check.text === 'given input.width: 0..10')
const optionalGivenReturnCheck = shortcutCleanupChecks.find(check => check.functionName === 'optionalGivenField' && check.text === 'return: 0..10')
const missingGivenFieldCheck = shortcutCleanupChecks.find(check => check.functionName === 'missingGivenField' && check.text === 'given input.width: 0..10')
const stringGivenFieldCheck = shortcutCleanupChecks.find(check => check.functionName === 'stringGivenField' && check.text === 'given input.width: 0..10')
const nonArrayGivenPathCheck = shortcutCleanupChecks.find(check => check.functionName === 'nonArrayGivenPath' && check.text === 'given rows[].height: 0..10')
const unknownParamGivenCheck = shortcutCleanupChecks.find(check => check.functionName === 'unknownParamGiven' && check.text === 'given input: 0..10')
const typedCallbackItemFailures = shortcutCleanupChecks.filter(check => check.functionName === 'typedCallbackItem' && check.status !== 'pass')
const missingCallbackItemFieldCheck = shortcutCleanupChecks.find(check => check.functionName === 'missingCallbackItemField' && check.text === 'given items[].width: 0..10')
if (
  typedGivenPathFailures.length > 0
  || typedAliasPathFailures.length > 0
  || optionalGivenFieldCheck?.status !== 'unknown'
  || optionalGivenFieldCheck.reason?.includes("TS2322: Type 'number | undefined' is not assignable to type 'number'") !== true
  || optionalGivenReturnCheck != null
  || missingGivenFieldCheck?.status !== 'unknown'
  || missingGivenFieldCheck.reason?.includes("TS2339: Property 'width' does not exist on type '{}'") !== true
  || stringGivenFieldCheck?.status !== 'unknown'
  || stringGivenFieldCheck.reason?.includes("TS2322: Type 'string' is not assignable to type 'number'") !== true
  || nonArrayGivenPathCheck?.status !== 'unknown'
  || nonArrayGivenPathCheck.reason?.includes("TS7053: Element implicitly has an 'any' type") !== true
  || unknownParamGivenCheck?.status !== 'unknown'
  || unknownParamGivenCheck.reason?.includes("TS2322: Type 'unknown' is not assignable to type 'number'") !== true
  || typedCallbackItemFailures.length > 0
  || missingCallbackItemFieldCheck?.status !== 'unknown'
  || missingCallbackItemFieldCheck.reason?.includes("TS2339: Property 'width' does not exist on type '{}'") !== true
) {
  console.error('expected @fit paths and callback item facts to come from TypeScript or real source values, not invented shape')
  console.error(formatTestDiagnostics(shortcutCleanupChecks))
  suite.fail()
}

const constrainedGenericFunctionResult = verifyFitSourceWithCallsites('constrained-generic-function.ts', `/** @fit
 * given value > 0
 * return > 0
 */
function positiveIdentity<T extends number>(value: T) {
  return value
}

function goodGenericCall() {
  return positiveIdentity(1)
}

function badGenericCall() {
  return positiveIdentity(-1)
}
`)
const constrainedGenericReturnCheck = constrainedGenericFunctionResult.annotationChecks.find(check =>
  check.functionName === 'positiveIdentity' && check.text === 'return > 0'
)
const goodGenericCallCheck = constrainedGenericFunctionResult.callsiteChecks.find(check =>
  check.functionName === 'goodGenericCall' && check.text === 'positiveIdentity(1): requires value > 0'
)
const badGenericCallCheck = constrainedGenericFunctionResult.callsiteChecks.find(check =>
  check.functionName === 'badGenericCall' && check.text === 'positiveIdentity(-1): requires value > 0'
)
const unconstrainedGenericFunctionChecks = verifyFitSource('unconstrained-generic-function.ts', `/** @fit
 * given value > 0
 */
function unsafeIdentity<T>(value: T) {
  return value
}
`)
const unconstrainedGenericGivenCheck = unconstrainedGenericFunctionChecks.find(check =>
  check.functionName === 'unsafeIdentity' && check.text === 'given value > 0'
)
if (
  constrainedGenericReturnCheck?.status !== 'pass'
  || goodGenericCallCheck?.status !== 'pass'
  || badGenericCallCheck?.status !== 'fail'
  || unconstrainedGenericGivenCheck?.status !== 'unknown'
  || unconstrainedGenericGivenCheck.reason?.includes("Type 'T' is not assignable to type 'number'") !== true
) {
  console.error('expected TypeScript generic constraints to drive function contracts and call checks')
  console.error(formatTestDiagnostics({constrainedGenericFunctionResult, unconstrainedGenericFunctionChecks}))
  suite.fail()
}

const contractTypeLayerChecks = verifyFitSource('contract-type-layer.ts', `type Tile = {
  width: number // @fit missingTypeMin..Infinity
}

/** @fit
 * given input.width: 0..10
 * return.width: 0..10
 */
function functionContracts(input: {width: string}) {
  return {width: input.width}
}

function loopContracts(items: {height: string}[]) {
  const rows = items
  /** @fit
   * rows[].height: 0..10
   */
  for (const item of items) {
    void item
  }
  return rows.length
}

function typeContracts(tile: Tile) {
  return tile.width
}

function inlineFieldContract() {
  return {
    width: 'wide', // @fit 0..10
  }
}

const topWidth = 'wide' // @fit 0..10
`)
const expectedTypeLayerErrors = [
  ['functionContracts', 'given input.width: 0..10', "TS2322: Type 'string' is not assignable to type 'number'"],
  ['functionContracts', 'return.width: 0..10', "TS2322: Type 'string' is not assignable to type 'number'"],
  ['loopContracts > loop', 'rows[].height: 0..10', "TS2322: Type 'string' is not assignable to type 'number'"],
  ['<type>', 'type @fit missingTypeMin..Infinity', "TS2304: Cannot find name 'missingTypeMin'"],
  ['inlineFieldContract', '@fit 0..10', "TS2322: Type 'string' is not assignable to type 'number'"],
  ['<top-level>', 'topWidth: 0..10', "TS2322: Type 'string' is not assignable to type 'number'"],
] as const
const missingTypeLayerErrors = expectedTypeLayerErrors.filter(([functionName, text, reason]) => {
  const check = contractTypeLayerChecks.find(item => item.functionName === functionName && item.text === text)
  return check?.status !== 'unknown'
    || check.reason?.includes(reason) !== true
    || check.reason.includes('contract-type-layer.ts(') !== true
    || check.reason.includes(': error TS') !== true
    || check.line == null
})
if (missingTypeLayerErrors.length > 0) {
  console.error('expected every contract surface to be TypeScript-checked before proving')
  console.error(formatTestDiagnostics({missingTypeLayerErrors, contractTypeLayerChecks}))
  suite.fail()
}

const inlineNonNumberEqualityChecks = verifyFitSource('inline-non-number-equality.ts', `function keepLines(lines: string[]) {
  return {
    lines,
    copy: lines, // @fit == lines
  }
}
`)
const inlineNonNumberEqualityFailures = inlineNonNumberEqualityChecks.filter(check => check.status !== 'pass')
if (inlineNonNumberEqualityFailures.length > 0) {
  console.error('expected inline equality to allow non-number values')
  console.error(formatTestDiagnostics(inlineNonNumberEqualityChecks))
  suite.fail()
}

const preparedContractProgram = buildFitSourceFile('prepared-contracts.ts', `/** @fit
 * given input: 0..10
 * return: 0..10
 */
function bounded(input: number) {
  return {
    bad: 'wide', // @fit 0..10
    good: 5, // @fit 0..10
  }.good
}
`, readTopLevelGlobal)
const preparedContracts = preparedProgramContracts(preparedContractProgram)
const preparedContractsAgain = preparedProgramContracts(preparedContractProgram)
const preparedBoundedFunction = preparedContractProgram.functions.get('bounded')!
const preparedBounded = preparedContracts.functions.get(preparedBoundedFunction)!
const preparedPropertyTemplateCounts = [...preparedBounded.body.objectPropertyTemplatesByNode.values()].map(templates => templates.length)
if (
  preparedContracts !== preparedContractsAgain
  || preparedBounded.assumptions.length !== 1
  || preparedBounded.proofs.length !== 1
  || preparedBounded.typeChecks.length !== 1
  || preparedPropertyTemplateCounts.length !== 2
  || preparedPropertyTemplateCounts.filter(count => count === 1).length !== 1
  || preparedPropertyTemplateCounts.filter(count => count === 0).length !== 1
) {
  console.error('expected contracts to be prepared once and rejected by exact contract identity')
  console.error(formatTestDiagnostics({
    assumptions: preparedBounded.assumptions.map(spec => spec.text),
    proofs: preparedBounded.proofs.map(spec => spec.text),
    typeChecks: preparedBounded.typeChecks,
    preparedPropertyTemplateCounts,
  }))
  suite.fail()
}

const topLevelContractChecks = verifyFitSource('top-level-contracts.ts', `const layout = {
  width: 5, // @fit 0..10
  bad: 'wide', // @fit 0..10
}

let total = 0
/** @fit
 * total: 0..10
 */
for (const value of [1, 2]) {
  total += value
}

const mapped = [1].map(value => {
  const doubled = value * 2 // @fit 0..10
  return doubled
})
void layout
void mapped
`)
const topPropertyPass = topLevelContractChecks.find(check => check.functionName === '<top-level>' && check.text === 'layout.width: 0..10' && check.status === 'pass')
const topPropertyTypeError = topLevelContractChecks.find(check => check.functionName === '<top-level>' && check.text === '@fit 0..10' && check.status === 'unknown')
const topLoopPass = topLevelContractChecks.find(check => check.functionName === '<top-level> > loop' && check.text === 'total: 0..10')
const topNestedPlacement = topLevelContractChecks.find(check => check.functionName === '<top-level>' && check.text === '@fit 0..10' && check.reason?.includes('nested function'))
if (
  topPropertyPass == null
  || topPropertyTypeError?.reason?.includes("Type 'string' is not assignable to type 'number'") !== true
  || topLoopPass?.status !== 'pass'
  || topNestedPlacement?.status !== 'unknown'
) {
  console.error('expected top-level properties, loops, and nested placements to use the prepared body index')
  console.error(formatTestDiagnostics(topLevelContractChecks))
  suite.fail()
}

const booleanCallContractChecks = verifyFitSource('boolean-call-contracts.ts', `function isValidLayout(layout: {width: number}) {
  return layout.width > 0
}

function randomLayoutCheck(layout: {width: number}) {
  return Math.random() > layout.width
}

/** @fit
 * isValidLayout(return)
 */
function validLayout() {
  return {width: 10}
}

/** @fit
 * isValidLayout(return)
 */
function invalidLayout() {
  return {width: 0}
}

/** @fit
 * isValidLayout(return)
 */
function unknownLayout(width: number) {
  return {width}
}

/** @fit
 * randomLayoutCheck(return)
 */
function unsupportedLayout() {
  return {width: 10}
}

/** @fit
 * 1 + 2
 */
function numericExpression() {
  return {width: 10}
}
`)
const validLayoutCheck = booleanCallContractChecks.find(check => check.functionName === 'validLayout' && check.text === 'isValidLayout(return)')
const invalidLayoutCheck = booleanCallContractChecks.find(check => check.functionName === 'invalidLayout' && check.text === 'isValidLayout(return)')
const unknownLayoutCheck = booleanCallContractChecks.find(check => check.functionName === 'unknownLayout' && check.text === 'isValidLayout(return)')
const unsupportedLayoutCheck = booleanCallContractChecks.find(check => check.functionName === 'unsupportedLayout' && check.text === 'randomLayoutCheck(return)')
const numericExpressionCheck = booleanCallContractChecks.find(check => check.functionName === 'numericExpression' && check.text === '1 + 2')
if (
  validLayoutCheck?.status !== 'pass'
  || invalidLayoutCheck?.status !== 'fail'
  || unknownLayoutCheck?.status !== 'unknown'
  || unsupportedLayoutCheck?.status !== 'unknown'
  || unsupportedLayoutCheck.reason?.includes('helper randomLayoutCheck is not pure: observes the environment') !== true
  || numericExpressionCheck?.status !== 'unknown'
  || numericExpressionCheck.reason?.includes("TS2322: Type 'number' is not assignable to type 'boolean'") !== true
) {
  console.error('expected bare pure boolean call contracts to be checked')
  console.error(formatTestDiagnostics(booleanCallContractChecks))
  suite.fail()
}

const booleanGivenContractResult = verifyFitSourceWithCallsites('boolean-given-contracts.ts', `function isValidLayout(layout: {width: number}) {
  return layout.width > 0
}

/** @fit
 * given isValidLayout(layout)
 * isValidLayout((layout))
 */
function assumesValidLayout(layout: {width: number}) {
  return layout
}

function invalidCaller() {
  return assumesValidLayout({width: 0})
}

/** @fit
 * given isValidLayout(layout)
 * given !isValidLayout((layout))
 */
function conflictingLayout(layout: {width: number}) {
  return layout
}

/** @fit
 * given !isValidLayout(layout)
 * !isValidLayout(layout)
 */
function assumesInvalidLayout(layout: {width: number}) {
  return layout
}
`)
const assumedBooleanGivenCheck = booleanGivenContractResult.annotationChecks.find(check => check.functionName === 'assumesValidLayout' && check.text === 'isValidLayout((layout))')
const conflictingBooleanGivenCheck = booleanGivenContractResult.annotationChecks.find(check => check.functionName === 'conflictingLayout' && check.text === 'given !isValidLayout((layout))')
const assumedNegativeBooleanGivenCheck = booleanGivenContractResult.annotationChecks.find(check => check.functionName === 'assumesInvalidLayout' && check.text === '!isValidLayout(layout)')
const invalidBooleanGivenCall = booleanGivenContractResult.callsiteChecks.find(check => check.functionName === 'invalidCaller' && check.text === 'assumesValidLayout({width: 0}): requires isValidLayout(layout)')
if (
  assumedBooleanGivenCheck?.status !== 'pass'
  || assumedBooleanGivenCheck.trace?.steps.some(step => step.rule === 'assumption') !== true
  || conflictingBooleanGivenCheck?.status !== 'fail'
  || conflictingBooleanGivenCheck.reason?.includes('no input can satisfy both given isValidLayout((layout)) and given !isValidLayout((layout))') !== true
  || assumedNegativeBooleanGivenCheck?.status !== 'pass'
  || invalidBooleanGivenCall?.status !== 'fail'
  || invalidBooleanGivenCall.reason?.includes('given isValidLayout(layout) returned false') !== true
) {
  console.error('expected boolean given predicates to be assumed in the callee and checked at callers')
  console.error(formatTestDiagnostics(booleanGivenContractResult))
  suite.fail()
}

const collectionExpressionChecks = verifyFitSource('collection-expression-contracts.ts', `function twice(value: number) {
  return value * 2
}

/** @fit
 * given items.length: int 1..10
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[$i].height == items[$i].height
 * twice(return.rows[$i].height) == twice(items[$i].height)
 * return.rows[$i + 1].height: 0..40
 * return.rows[$i + 1].height >= 0
 * twice(return.rows[].height) <= 80
 */
function copyRows(items: {height: number}[]) {
  return {rows: items.map(item => ({height: item.height}))}
}

/** @fit
 * given items.length: int 1..10
 * given boxes.length: int 1..10
 * given items[].height: 0..40
 * given boxes[].height: 0..40
 * return.rows.length == items.length
 * return.rows[$i + 1].height == boxes[$i].height
 * return.rows[$i].height == boxes[$i - 1].height
 */
function offsetAcrossCollections(items: {height: number}[], boxes: {height: number}[]) {
  return {rows: items.map(item => ({height: item.height})), boxes}
}

/** @fit
 * given items[].height: 0..40
 * return[$i + 2].height >= return[$i].height
 * return[$i].height == return[$j].height
 * return[$i].height >= 0
 * return[$i].height: 0..40
 * return[$i + 1].height <= return[$i + 2].height
 * return[$i - 1].height <= return[$i].height
 * return[$i - 1].height >= 0
 * return[$i - 1].height: 0..40
 * return[$i - 2].height <= return[$i - 1].height
 * return[$i - 1].height <= return[$i + 1].height
 * twice(return[$i + 1].height) >= twice(return[$i].height)
 * twice(return[$i].height) >= twice(return[$i - 1].height)
 * twice(return[$row].height) >= twice(return[$row - 1].height)
 * return[$i].height <= return[].height
 * (return[$i + 2].height >= return[$i].height)
 * return[$i + 1]: {height: 0..40}
 * return[$i - 1]: {height: 0..40}
 */
function namedIndexForms(items: {height: number}[]) {
  return items
}

/** @fit
 * given groups[].rows[].height: 0..40
 * return[$i].rows[$j].height >= 0
 */
function nestedNamedIndexes(groups: {rows: {height: number}[]}[]) {
  return groups
}

/** @fit
 * return[$i].height == return[$i].height
 */
function namedIndexTuple() {
  const result: [{height: number}, {height: number}] = [{height: 1}, {height: 2}]
  return result
}

/** @fit
 * given items[$i + 2].height == items[$i].height
 * return == 1
 */
function unsupportedNamedIndexGiven(items: {height: number}[]) {
  void items
  return 1
}
`)
const collectionExpressionPasses = [
  'twice(return.rows[$i].height) == twice(items[$i].height)',
  'twice(return.rows[].height) <= 80',
].map(text => collectionExpressionChecks.find(check => check.functionName === 'copyRows' && check.text === text)?.status)
collectionExpressionPasses.push(...[
  'return[$i].height >= 0',
  'return[$i].height: 0..40',
].map(text => collectionExpressionChecks.find(check =>
  check.functionName === 'namedIndexForms'
  && check.text === text)?.status))
const unsupportedNamedIndexChecks = [
  ['copyRows', 'return.rows[$i + 1].height: 0..40'],
  ['copyRows', 'return.rows[$i + 1].height >= 0'],
  ['offsetAcrossCollections', 'return.rows[$i + 1].height == boxes[$i].height'],
  ['offsetAcrossCollections', 'return.rows[$i].height == boxes[$i - 1].height'],
  ['namedIndexForms', 'return[$i + 2].height >= return[$i].height'],
  ['namedIndexForms', 'return[$i].height == return[$j].height'],
  ['namedIndexForms', 'return[$i + 1].height <= return[$i + 2].height'],
  ['namedIndexForms', 'return[$i - 1].height >= 0'],
  ['namedIndexForms', 'return[$i - 1].height: 0..40'],
  ['namedIndexForms', 'return[$i - 2].height <= return[$i - 1].height'],
  ['namedIndexForms', 'return[$i - 1].height <= return[$i + 1].height'],
  ['namedIndexForms', 'twice(return[$i + 1].height) >= twice(return[$i].height)'],
  ['namedIndexForms', 'twice(return[$i].height) >= twice(return[$i - 1].height)'],
  ['namedIndexForms', 'twice(return[$row].height) >= twice(return[$row - 1].height)'],
  ['namedIndexForms', 'return[$i].height <= return[].height'],
  ['namedIndexForms', '(return[$i + 2].height >= return[$i].height)'],
  ['namedIndexForms', 'return[$i + 1]: {height: 0..40}'],
  ['namedIndexForms', 'return[$i - 1]: {height: 0..40}'],
  ['nestedNamedIndexes', 'return[$i].rows[$j].height >= 0'],
  ['namedIndexTuple', 'return[$i].height == return[$i].height'],
  ['unsupportedNamedIndexGiven', 'given items[$i + 2].height == items[$i].height'],
].map(([functionName, text]) => collectionExpressionChecks.find(check =>
  check.functionName === functionName && check.text === text))
const acceptedMinusOneWithoutFact = collectionExpressionChecks.find(check =>
  check.functionName === 'namedIndexForms'
  && check.text === 'return[$i - 1].height <= return[$i].height')
const customLabelFailure = collectionExpressionChecks.find(check =>
  check.functionName === 'namedIndexForms'
  && check.text === 'twice(return[$row].height) >= twice(return[$row - 1].height)')
if (
  collectionExpressionPasses.some(status => status !== 'pass')
  || acceptedMinusOneWithoutFact?.status !== 'unknown'
  || acceptedMinusOneWithoutFact.reason?.toLowerCase().includes('named index') === true
  || customLabelFailure?.reason?.includes('$row - 1') !== true
  || unsupportedNamedIndexChecks.some(check =>
    check?.status !== 'unknown'
    || check.reason?.toLowerCase().includes('named index') !== true)
) {
  console.error('expected named indexes to support only matching positions and direct adjacent relationships')
  console.error(formatTestDiagnostics(collectionExpressionChecks))
  suite.fail()
}

const unsupportedNamedIndexProgram = buildFitSourceFile('unsupported-named-index-preparation.ts', `/** @fit
 * given items[$i + 2].height == items[$i].height
 * return[$i].height == return[$j].height
 */
function unsupported(items: {height: number}[]) {
  return items
}
`, readTopLevelGlobal)
const unsupportedNamedIndexFunction = unsupportedNamedIndexProgram.functions.get('unsupported')!
const preparedUnsupportedNamedIndexes = preparedProgramContracts(unsupportedNamedIndexProgram).functions.get(unsupportedNamedIndexFunction)!
if (
  preparedUnsupportedNamedIndexes.contractSpecs.length !== 0
  || preparedUnsupportedNamedIndexes.assumptions.length !== 0
  || preparedUnsupportedNamedIndexes.proofs.length !== 0
  || preparedUnsupportedNamedIndexes.unsupportedSpecs.length !== 2
) {
  console.error('expected unsupported named indexes to stay out of call requirements and helper summaries')
  console.error(formatTestDiagnostics({
    contractSpecs: preparedUnsupportedNamedIndexes.contractSpecs.map(spec => spec.text),
    assumptions: preparedUnsupportedNamedIndexes.assumptions.map(spec => spec.text),
    proofs: preparedUnsupportedNamedIndexes.proofs.map(spec => spec.text),
    unsupported: preparedUnsupportedNamedIndexes.unsupportedSpecs,
  }))
  suite.fail()
}

const simplifiedRoundingChecks = verifyFitSource('rounding-simplification.ts', `/** @fit
 * given width: int 320..2400
 * given gap: int 1..32
 * return.outer >= return.inner
 */
function frame(width: number, gap: number) {
  const inner = Math.ceil(width / 2)
  const outer = width + 2 * (gap + 8)
  return {inner, outer}
}

/** @fit
 * given width: int 0..100
 * given gap: int 0..100
 * return.outer >= return.inner
 */
function missingFrame(width: number, gap: number) {
  const inner = Math.ceil(width / 2)
  const outer = gap
  return {inner, outer}
}
`)
const simplifiedRoundingCheck = simplifiedRoundingChecks.find(check => check.functionName === 'frame' && check.text === 'return.outer >= return.inner')
const missingRoundingCheck = simplifiedRoundingChecks.find(check => check.functionName === 'missingFrame' && check.text === 'return.outer >= return.inner')
if (
  simplifiedRoundingCheck?.status !== 'pass'
  || missingRoundingCheck?.status !== 'unknown'
  || missingRoundingCheck.reason?.includes('missing: (width / 2) <= gap') !== true
) {
  console.error('expected proof simplification to reduce rounding comparisons to smaller arithmetic')
  console.error(formatTestDiagnostics(simplifiedRoundingChecks))
  suite.fail()
}

const roundingFamilyChecks = verifyFitSource('rounding-family.ts', `/** @fit
 * given value: -10..10
 * return.floorValue <= value
 * value < return.floorValue + 1
 * value - 1 <= return.floorValue
 * value <= return.ceilValue
 * return.ceilValue <= value + 1
 * return.ceilValue - 1 < value
 * value - 0.5 <= return.roundValue
 * return.roundValue <= value + 0.5
 * return.roundValue - 0.5 <= value
 * value < return.roundValue + 0.5
 */
function roundingLoss(value: number) {
  return {
    floorValue: Math.floor(value),
    ceilValue: Math.ceil(value),
    roundValue: Math.round(value),
  }
}

/** @fit
 * given positive: 0..10
 * given negative: -10..0
 * return.positiveTrunc >= 0
 * return.positiveTrunc <= positive
 * positive - 1 <= return.positiveTrunc
 * return.negativeTrunc >= negative
 * return.negativeTrunc <= 0
 * return.negativeTrunc <= negative + 1
 */
function truncLoss(positive: number, negative: number) {
  return {
    positiveTrunc: Math.trunc(positive),
    negativeTrunc: Math.trunc(negative),
  }
}

/** @fit
 * given left <= right
 * return.floorLeft <= return.floorRight
 * return.ceilLeft <= return.ceilRight
 * return.roundLeft <= return.roundRight
 * return.truncLeft <= return.truncRight
 */
function roundingMonotonicity(left: number, right: number) {
  return {
    floorLeft: Math.floor(left),
    floorRight: Math.floor(right),
    ceilLeft: Math.ceil(left),
    ceilRight: Math.ceil(right),
    roundLeft: Math.round(left),
    roundRight: Math.round(right),
    truncLeft: Math.trunc(left),
    truncRight: Math.trunc(right),
  }
}

/** @fit
 * given value: -10..10
 * return <= value
 */
function truncNeedsSign(value: number) {
  return Math.trunc(value)
}

/** @fit
 * given left < right
 * return < Math.round(right)
 */
function roundMonotonicityIsNotStrict(left: number, right: number) {
  return Math.round(left)
}
`)
const roundingFamilyFailures = roundingFamilyChecks.filter(check => check.functionName !== 'truncNeedsSign' && check.functionName !== 'roundMonotonicityIsNotStrict' && check.status !== 'pass')
const truncNeedsSignCheck = roundingFamilyChecks.find(check => check.functionName === 'truncNeedsSign' && check.text === 'return <= value')
const roundStrictCheck = roundingFamilyChecks.find(check => check.functionName === 'roundMonotonicityIsNotStrict' && check.text === 'return < Math.round(right)')
if (
  roundingFamilyFailures.length > 0
  || truncNeedsSignCheck?.status !== 'unknown'
  || truncNeedsSignCheck.reason?.includes('missing fact: trunc(value) <= value') !== true
  || roundStrictCheck?.status !== 'unknown'
  || roundStrictCheck.reason?.includes('missing: left < (round(right) - 0.5)') !== true
) {
  console.error('expected rounding family proof rules to cover floor/ceil/round/trunc and reject unsafe strict/sign cases')
  console.error(formatTestDiagnostics(roundingFamilyChecks))
  suite.fail()
}

const expandedMathChecks = verifyFitSource('expanded-math.ts', `/** @fit
 * return.pi: 3..4
 * return.powValue: 8
 * return.cbrtValue: 2
 * return.froundValue: 1..2
 * return.f16roundValue: 1..2
 * return.clzValue: int 31..31
 * return.imulValue: int 6..6
 */
function exactMath() {
  return {
    pi: Math.PI,
    powValue: Math.pow(2, 3),
    cbrtValue: Math.cbrt(8),
    froundValue: Math.fround(1.25),
    f16roundValue: Math.f16round(1.25),
    clzValue: Math.clz32(1),
    imulValue: Math.imul(2, 3),
  }
}

/** @fit
 * given value: 1..4
 * given signed: -1..1
 * given unit: -0.5..0.5
 * return.expValue: 2..55
 * return.expm1Value: 1..54
 * return.logValue: 0..2
 * return.log2Value: 0..2
 * return.log10Value: 0..1
 * return.log1pValue: 0..2
 * return.asinValue: -1..1
 * return.acosValue: 1..3
 * return.atanValue: -1..1
 * return.sinhValue: -2..2
 * return.asinhValue: -1..1
 * return.tanhValue: -1..1
 * return.acoshValue: 0..3
 * return.atanhValue: -1..1
 */
function monotoneMath(value: number, signed: number, unit: number) {
  return {
    expValue: Math.exp(value),
    expm1Value: Math.expm1(value),
    logValue: Math.log(value),
    log2Value: Math.log2(value),
    log10Value: Math.log10(value),
    log1pValue: Math.log1p(value),
    asinValue: Math.asin(unit),
    acosValue: Math.acos(unit),
    atanValue: Math.atan(signed),
    sinhValue: Math.sinh(signed),
    asinhValue: Math.asinh(signed),
    tanhValue: Math.tanh(signed),
    acoshValue: Math.acosh(value),
    atanhValue: Math.atanh(unit),
  }
}

/** @fit
 * given value: -1..1
 * return: -Infinity..Infinity
 */
function logNeedsPositive(value: number) {
  return Math.log(value)
}
`)
const expandedMathFailures = expandedMathChecks.filter(check => check.functionName !== 'logNeedsPositive' && check.status !== 'pass')
const logNeedsPositiveCheck = expandedMathChecks.find(check => check.functionName === 'logNeedsPositive' && check.text === 'return: -Infinity..Infinity')
if (
  expandedMathFailures.length > 0
  || logNeedsPositiveCheck?.status !== 'unknown'
  || logNeedsPositiveCheck.reason?.includes('Math.log expected a non-negative number') !== true
) {
  console.error('expected expanded Math builtin families to infer ranges and reject unsafe domains')
  console.error(formatTestDiagnostics(expandedMathChecks))
  suite.fail()
}

const impureContractHelperChecks = verifyFitSource('contract-impure.ts', `const box = {limit: 0}

function bump() {
  box.limit = box.limit + 1
  return box.limit
}

/** @fit
 * return <= bump()
 */
function bad() {
  return 0
}
`)
const impureContractHelperCheck = impureContractHelperChecks.find(check => check.functionName === 'bad' && check.text === 'return <= bump()')
if (
  impureContractHelperCheck?.status !== 'unknown'
  || impureContractHelperCheck.reason?.includes('Unsupported @fit contract expression: bump()') !== true
  || impureContractHelperCheck.reason.includes('helper bump is not pure: writes outside state `box`') !== true
) {
  console.error('expected impure helper calls in contracts to be rejected loudly')
  console.error(formatTestDiagnostics(impureContractHelperChecks))
  suite.fail()
}

const mutableReadContractHelperChecks = verifyFitSource('contract-mutable-read.ts', `const state = {limit: 10}

function currentLimit() {
  return state.limit
}

/** @fit
 * return <= currentLimit()
 */
function bad() {
  return 0
}
`)
const mutableReadContractHelperCheck = mutableReadContractHelperChecks.find(check => check.functionName === 'bad' && check.text === 'return <= currentLimit()')
if (
  mutableReadContractHelperCheck?.status !== 'unknown'
  || mutableReadContractHelperCheck.reason?.includes('Unsupported @fit contract expression: currentLimit()') !== true
  || mutableReadContractHelperCheck.reason.includes('helper currentLimit is not pure: reads mutable outside state') !== true
) {
  console.error('expected contract helpers that read mutable outside state to be rejected by the shared purity check')
  console.error(formatTestDiagnostics(mutableReadContractHelperChecks))
  suite.fail()
}

const unsupportedContractExpressionChecks = verifyFitSource('contract-unsupported.ts', `function randomLimit() {
  return Math.random() * 10
}

const method = "max"

/** @fit
 * return <= randomLimit()
 * return <= Math[method](1, 2)
 */
function bad() {
  return 0
}
`)
const randomContractCheck = unsupportedContractExpressionChecks.find(check => check.functionName === 'bad' && check.text === 'return <= randomLimit()')
const dynamicContractCheck = unsupportedContractExpressionChecks.find(check => check.functionName === 'bad' && check.text === 'return <= Math[method](1, 2)')
if (
  randomContractCheck?.status !== 'unknown'
  || randomContractCheck.reason?.includes('helper randomLimit is not pure: observes the environment') !== true
  || dynamicContractCheck?.status !== 'unknown'
  || dynamicContractCheck.reason?.includes('Unsupported call Math[method]') !== true
) {
  console.error('expected unsupported contract expressions to explain the unsupported step')
  console.error(formatTestDiagnostics(unsupportedContractExpressionChecks))
  suite.fail()
}

const mutableAliasContractChecks = verifyFitSource('contract-mutable-alias.ts', `let max = Math.max

/** @fit
 * return <= max(1, 2)
 */
function bad() {
  return 0
}
`)
const mutableAliasContractCheck = mutableAliasContractChecks.find(check => check.functionName === 'bad' && check.text === 'return <= max(1, 2)')
if (
  mutableAliasContractCheck?.status !== 'unknown'
  || mutableAliasContractCheck.reason?.includes('max is a mutable helper alias') !== true
) {
  console.error('expected mutable helper aliases in contracts to be rejected loudly')
  console.error(formatTestDiagnostics(mutableAliasContractChecks))
  suite.fail()
}

const unsupportedGivenExpressionChecks = verifyFitSource('given-contract-unsupported.ts', `const box = {limit: 0}

function bump(value: number) {
  box.limit += value
  return box.limit
}

function double(value: number) {
  return value * 2
}

/** @fit
 * given max >= bump(min)
 */
function impure(min: number, max: number) {
  return max
}

/** @fit
 * given double(10) > 0
 */
function noInput(value: number) {
  return value
}

/** @fit
 * given double(value): 0..10
 */
function derivedRangeTarget(value: number) {
  return value
}

/** @fit
 * given bump(value)
 */
function impureBoolean(value: number) {
  return value
}

/** @fit
 * given true
 */
function noInputBoolean(value: number) {
  return value
}
`)
const impureGivenCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'impure' && check.text === 'given max >= bump(min)')
const noInputGivenCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'noInput' && check.text === 'given double(10) > 0')
const derivedRangeTargetCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'derivedRangeTarget' && check.text === 'given double(value): 0..10')
const impureBooleanGivenCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'impureBoolean' && check.text === 'given bump(value)')
const noInputBooleanGivenCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'noInputBoolean' && check.text === 'given true')
if (
  impureGivenCheck?.status !== 'unknown'
  || impureGivenCheck.reason?.includes('Unsupported @fit contract expression: bump(min)') !== true
  || impureGivenCheck.reason.includes('helper bump is not pure: writes outside state `box`') !== true
  || noInputGivenCheck?.status !== 'unknown'
  || noInputGivenCheck.reason !== 'given must mention an input'
  || derivedRangeTargetCheck?.status !== 'unknown'
  || derivedRangeTargetCheck.reason !== 'given range must name one input path, not a derived expression'
  || impureBooleanGivenCheck?.status !== 'unknown'
  || impureBooleanGivenCheck.reason?.includes("TS2322: Type 'number' is not assignable to type 'boolean'") !== true
  || noInputBooleanGivenCheck?.status !== 'unknown'
  || noInputBooleanGivenCheck.reason !== 'given must mention an input'
) {
  console.error('expected given helper expressions to reject impure, input-independent, and derived range target cases')
  console.error(formatTestDiagnostics(unsupportedGivenExpressionChecks))
  suite.fail()
}

const unsupportedSpreadContractChecks = verifyFitSource('unsupported-spread-contract.ts', `
function first(...values: number[]): number {
  return values[0]!
}

/** @fit
 * given items.length: 0..0
 * typeof first(...items) === "number"
 */
function emptySpreadCannotProveNumber(items: number[]) {
  return 0
}
`)
const unsupportedSpreadContractCheck = unsupportedSpreadContractChecks.find(check =>
  check.functionName === 'emptySpreadCannotProveNumber'
  && check.text === 'typeof first(...items) === "number"')
if (
  unsupportedSpreadContractCheck?.status !== 'unknown'
  || unsupportedSpreadContractCheck.reason?.includes('Call spread needs an exact tuple') !== true
) {
  console.error('expected every interpreter rejection in a contract expression to stop the proof')
  console.error(formatTestDiagnostics(unsupportedSpreadContractChecks))
  suite.fail()
}

const wildcardIdentityCollisionChecks = verifyFitSource('wildcard-identity-collision.ts', `
/** @fit
 * given rows.length: 1..1
 * given rows[].height: 0..10
 * given __fit_domain_rows___item_height: 20..30
 * rows[].height == __fit_domain_rows___item_height
 */
function wildcardIdentityCollision(rows: {height: number}[], __fit_domain_rows___item_height: number) {
  return rows
}
`)
const wildcardIdentityCollisionCheck = wildcardIdentityCollisionChecks.find(check =>
  check.functionName === 'wildcardIdentityCollision'
  && check.text === 'rows[].height == __fit_domain_rows___item_height')
if (wildcardIdentityCollisionCheck?.status !== 'fail') {
  console.error('expected a source identifier not to share proof identity with a wildcard path placeholder')
  console.error(formatTestDiagnostics(wildcardIdentityCollisionChecks))
  suite.fail()
}

const structuredPathRegressionChecks = verifyFitSource('structured-path-regressions.ts', `
/** @fit
 * given items.length: 0..2
 * return: int 0..2
 */
function boundedLength(items: number[]) {
  return items.length
}

/** @fit
 * given input[0]: 0..10
 * return: 0..10
 */
function numericObjectProperty(input: {0: number}) {
  return input[0]
}

/** @fit
 * given input[1.5]: 0..10
 * return: 0..10
 */
function decimalObjectProperty(input: {1.5: number}) {
  return input[1.5]
}

/** @fit
 * given input[-1]: 0..10
 * return: 0..10
 */
function negativeObjectProperty(input: {"-1": number}) {
  return input[-1]
}

/** @fit
 * given value: 5..5
 * return == 5
 */
function functionScopedVar(value: number) {
  {
    var value = 1
  }
  return value
}

/** @fit
 * given value: 5..5
 * return == 5
 */
function uninitializedFunctionScopedVar(value: number) {
  {
    var value: number
  }
  return value
}

/** @fit
 * given typeof value === "number"
 * typeof (value) === "number"
 */
function structurallyEqualBooleanGiven(value: number) {
  return value
}

/** @fit
 * given __fit_return: 0..0
 * return == __fit_return
 */
function reservedReturnBinding(__fit_return: number) {
  return 1
}
`)
const boundedLengthCheck = structuredPathRegressionChecks.find(check =>
  check.functionName === 'boundedLength' && check.text === 'return: int 0..2')
const numericObjectPropertyCheck = structuredPathRegressionChecks.find(check =>
  check.functionName === 'numericObjectProperty' && check.text === 'return: 0..10')
const decimalObjectPropertyCheck = structuredPathRegressionChecks.find(check =>
  check.functionName === 'decimalObjectProperty' && check.text === 'return: 0..10')
const negativeObjectPropertyCheck = structuredPathRegressionChecks.find(check =>
  check.functionName === 'negativeObjectProperty' && check.text === 'return: 0..10')
const functionScopedVarCheck = structuredPathRegressionChecks.find(check =>
  check.functionName === 'functionScopedVar' && check.text === 'return == 5')
const uninitializedFunctionScopedVarCheck = structuredPathRegressionChecks.find(check =>
  check.functionName === 'uninitializedFunctionScopedVar' && check.text === 'return == 5')
const structurallyEqualBooleanGivenCheck = structuredPathRegressionChecks.find(check =>
  check.functionName === 'structurallyEqualBooleanGiven' && check.text === 'typeof (value) === "number"')
const reservedReturnBindingChecks = structuredPathRegressionChecks.filter(check =>
  check.functionName === 'reservedReturnBinding')
if (
  boundedLengthCheck?.status !== 'pass'
  || numericObjectPropertyCheck?.status !== 'pass'
  || decimalObjectPropertyCheck?.status !== 'pass'
  || negativeObjectPropertyCheck?.status !== 'pass'
  || functionScopedVarCheck?.status !== 'fail'
  || uninitializedFunctionScopedVarCheck?.status !== 'pass'
  || structurallyEqualBooleanGivenCheck?.status !== 'pass'
  || reservedReturnBindingChecks.length !== 1
  || reservedReturnBindingChecks[0]?.status !== 'unknown'
  || reservedReturnBindingChecks[0].reason?.includes('is reserved for Freerange contract evaluation') !== true
) {
  console.error('expected structured paths and binding scopes to preserve their semantic guarantees')
  console.error(formatTestDiagnostics(structuredPathRegressionChecks))
  suite.fail()
}

const negativeReport = await verifyFitFiles(negativeFiles)
const actualNegative = normalizeNegative(negativeReport.checks)
if (!await verifySnapshot(negativeExpectedPath, actualNegative, 'negative messages')) suite.fail()

const previousIndexReport = await verifyFitFiles([
  'tests/patterns/previous-index-patterns.ts',
  'tests/imports/adjacent-summary-patterns.ts',
], {annotationsOnly: true})
if (previousIndexReport.phase !== 'ready') {
  console.error('expected direct and imported previous-index relationships to pass')
  console.error(formatTestDiagnostics(previousIndexReport.checks))
  suite.fail()
}

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
  console.error('expected imported adjacent summaries to preserve the caller spelling and reject a different recurrence')
  console.error(formatTestDiagnostics(negativeAdjacentSummaryReport.checks))
  suite.fail()
}

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
  console.error('expected sequence relations to preserve source grouping and reject unsound spacing or end facts')
  console.error(formatTestDiagnostics(sequenceOperationChecks))
  suite.fail()
}

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
  console.error('expected a computation to retain operand identity after a later range refinement')
  console.error(formatTestDiagnostics(lateRefinementChecks))
  suite.fail()
}

const suggestedGivenRootReason = verifyFitSource('given-typo.ts', `const boxesGapX = 24

/** @fit
 * given containerSizX >= 2 * boxesGapX
 */
function layout(containerSizeX: number) {
  return containerSizeX
}
`).find(check => check.text === 'given containerSizX >= 2 * boxesGapX')?.reason
if (
  suggestedGivenRootReason?.includes("TS2552: Cannot find name 'containerSizX'") !== true
  || suggestedGivenRootReason.includes("Did you mean 'containerSizeX'?") !== true
) {
  console.error('expected given typo suggestion')
  console.error(suggestedGivenRootReason ?? '<missing>')
  suite.fail()
}

const ambiguousGivenRootReason = verifyFitSource('given-typo.ts', `const boxesGapX = 24
const boxesGapY = 24

/** @fit
 * given containerSizeX >= 2 * boxesGap
 */
function layout(containerSizeX: number) {
  return containerSizeX
}
`).find(check => check.text === 'given containerSizeX >= 2 * boxesGap')?.reason
if (ambiguousGivenRootReason?.includes("TS2552: Cannot find name 'boxesGap'") !== true) {
  console.error('expected ambiguous given typo to use TypeScript diagnostics')
  console.error(ambiguousGivenRootReason ?? '<missing>')
  suite.fail()
}

let duplicateFunctionError: Error | null = null
try {
  verifyFitSource('duplicate-function.ts', `function score() {
  return 1
}

function score() {
  return 2
}
`)
} catch (error) {
  duplicateFunctionError = error instanceof Error ? error : new Error(String(error))
}
if (
  !(duplicateFunctionError instanceof TypeScriptUserlandError)
  || !duplicateFunctionError.message.includes('duplicate-function.ts(1,10): error TS2393: Duplicate function implementation.')
  || !duplicateFunctionError.message.includes('duplicate-function.ts(5,10): error TS2393: Duplicate function implementation.')
) {
  console.error('expected duplicate function names to be rejected by TypeScript preflight')
  console.error(duplicateFunctionError?.message ?? '<no error>')
  suite.fail()
}

const repeatedSourceFile = 'repeated-source-preflight.ts'
const repeatedValidSource = `function score(value: number) {
  return value + 1
}
`
let repeatedSourceError: Error | null = null
buildFitSourceFile(repeatedSourceFile, repeatedValidSource, readTopLevelGlobal)
try {
  buildFitSourceFile(repeatedSourceFile, `function score(value: number) {
  const label: string = value
  return label
}
`, readTopLevelGlobal)
} catch (error) {
  repeatedSourceError = error instanceof Error ? error : new Error(String(error))
}
const repeatedValidProgram = buildFitSourceFile(repeatedSourceFile, repeatedValidSource, readTopLevelGlobal)
if (
  !(repeatedSourceError instanceof TypeScriptUserlandError)
  || !repeatedSourceError.message.includes("repeated-source-preflight.ts(2,9): error TS2322: Type 'number' is not assignable to type 'string'.")
  || !repeatedValidProgram.functions.has('score')
) {
  console.error('expected standalone source preflight to use the current source text on every build')
  console.error(repeatedSourceError?.message ?? '<no error>')
  process.exitCode = 1
}

let defaultLibraryConflictError: Error | null = null
try {
  buildFitSourceFile('default-library-conflict.ts', 'type PropertyKey = string\n', readTopLevelGlobal)
} catch (error) {
  defaultLibraryConflictError = error instanceof Error ? error : new Error(String(error))
}
const expectedDefaultLibraryConflict = `default-library-conflict.ts(1,6): error TS2300: Duplicate identifier 'PropertyKey'.
node_modules/typescript/lib/lib.es5.d.ts(106,14): error TS2300: Duplicate identifier 'PropertyKey'.`
if (
  !(defaultLibraryConflictError instanceof TypeScriptUserlandError)
  || defaultLibraryConflictError.message !== expectedDefaultLibraryConflict
) {
  console.error('expected standalone source preflight failures to keep complete TypeScript diagnostics')
  console.error(defaultLibraryConflictError?.message ?? '<no error>')
  process.exitCode = 1
}

let unsupportedSourceExtensionError: Error | null = null
try {
  buildFitSourceFile('unsupported-source.txt', 'function ok() { return 1 }\n', readTopLevelGlobal)
} catch (error) {
  unsupportedSourceExtensionError = error instanceof Error ? error : new Error(String(error))
}
const unsupportedSourcePath = `${repoDir}unsupported-source.txt`
const expectedUnsupportedSourceExtension = `error TS6054: File '${unsupportedSourcePath}' has an unsupported extension. The only supported extensions are '.ts', '.tsx', '.d.ts', '.cts', '.d.cts', '.mts', '.d.mts'.
  The file is in the program because:
    Root file specified for compilation`
if (
  !(unsupportedSourceExtensionError instanceof TypeScriptUserlandError)
  || unsupportedSourceExtensionError.message !== expectedUnsupportedSourceExtension
) {
  console.error('expected unsupported standalone source extensions to keep TypeScript diagnostics')
  console.error(unsupportedSourceExtensionError?.message ?? '<no error>')
  process.exitCode = 1
}

const importedPreflightDir = `/tmp/freerange-source-preflight-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
const importedPreflightMkdir = Bun.spawnSync({cmd: ['mkdir', '-p', importedPreflightDir]})
if (importedPreflightMkdir.exitCode !== 0) throw new Error(`Could not create ${importedPreflightDir}`)
try {
  const importedPreflightHelper = `${importedPreflightDir}/helper.ts`
  const importedPreflightUser = `${importedPreflightDir}/user.ts`
  const importedPreflightSource = `import {label} from './helper'
function readLabel() {
  return label
}
`
  const importedPreflightFailureSource = `import {label} from './helper'
const enabled: boolean = label
void enabled
`
  let importedPreflightError: Error | null = null
  await Bun.write(importedPreflightHelper, 'export const label: string = 1\n')
  try {
    buildFitSourceFile(importedPreflightUser, importedPreflightFailureSource, readTopLevelGlobal)
  } catch (error) {
    importedPreflightError = error instanceof Error ? error : new Error(String(error))
  }
  const importedPreflightDisplayPath = `<fixture>`
  const importedPreflightPathPattern = new RegExp(`(?:\\.\\./)*tmp/${importedPreflightDir.slice(importedPreflightDir.lastIndexOf('/') + 1)}`, 'g')
  const normalizedImportedPreflightError = importedPreflightError?.message.replace(importedPreflightPathPattern, importedPreflightDisplayPath)
  const expectedImportedPreflightError = `<fixture>/helper.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.
<fixture>/user.ts(2,7): error TS2322: Type 'string' is not assignable to type 'boolean'.`
  await Bun.write(importedPreflightHelper, "export const label = 'ok'\n")
  const importedPreflightProgram = buildFitSourceFile(importedPreflightUser, importedPreflightSource, readTopLevelGlobal)
  if (
    !(importedPreflightError instanceof TypeScriptUserlandError)
    || normalizedImportedPreflightError !== expectedImportedPreflightError
    || !importedPreflightProgram.functions.has('readLabel')
  ) {
    console.error('expected standalone source preflight to preserve ordered multi-file diagnostics')
    console.error(importedPreflightError?.message ?? '<no error>')
    process.exitCode = 1
  }

  let importedSyntaxError: Error | null = null
  await Bun.write(importedPreflightHelper, 'export const label = ;\n')
  try {
    buildFitSourceFile(importedPreflightUser, importedPreflightSource, readTopLevelGlobal)
  } catch (error) {
    importedSyntaxError = error instanceof Error ? error : new Error(String(error))
  }
  const normalizedImportedSyntaxError = importedSyntaxError?.message.replace(importedPreflightPathPattern, importedPreflightDisplayPath)
  if (
    !(importedSyntaxError instanceof TypeScriptUserlandError)
    || normalizedImportedSyntaxError !== '<fixture>/helper.ts(1,22): error TS1109: Expression expected.'
  ) {
    console.error('expected standalone source preflight to preserve imported syntax diagnostics')
    console.error(importedSyntaxError?.message ?? '<no error>')
    process.exitCode = 1
  }
} finally {
  Bun.spawnSync({cmd: ['rm', '-rf', importedPreflightDir]})
}

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
  console.error('expected unsupported root fallout to collapse')
  console.error(collapsedUnsupported.join('\n'))
  suite.fail()
}

const unsupportedBranchConditionChecks = verifyFitSource('unsupported-branch-condition.ts', `declare function externalPredicate(): boolean

function danger() {
  return 2
}

/** @fit
 * return: 1
 */
function sample() {
  if (externalPredicate()) return danger()
  return 1
}
`)
const unsupportedBranchConditionCheck = unsupportedBranchConditionChecks.find(check => check.functionName === 'sample' && check.text === 'return: 1')
if (
  unsupportedBranchConditionCheck?.status !== 'unknown'
  || unsupportedBranchConditionCheck.reason !== 'Unsupported branch condition: externalPredicate()'
) {
  console.error('expected unsupported branch conditions to stop before speculating through branch bodies')
  console.error(formatTestDiagnostics(unsupportedBranchConditionChecks))
  suite.fail()
}

const inferReport = inferFitFiles(['tests/patterns/patterns.ts'], {functionName: 'typedObjectParamArrayShape'})
const inferFacts = new Set(inferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedInferFacts = [
  'return.rows.length == params.items.length',
  'return.rows.length: int 0..4294967295',
  'return.rows[].height == params.items[].height',
  'return.rows follows params.items by index',
]
const missingInferFacts = expectedInferFacts.filter(fact => !inferFacts.has(fact))
if (missingInferFacts.length > 0) {
  console.error('expected inferred facts changed')
  console.error(missingInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  suite.fail()
}

const filterInferReport = inferFitFiles(['tests/patterns/patterns.ts'], {functionName: 'filteredRowsKeepElementDomain'})
const filterInferFacts = new Set(filterInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedFilterInferFacts = [
  'return.rows is an order-preserving subset of items',
]
const missingFilterInferFacts = expectedFilterInferFacts.filter(fact => !filterInferFacts.has(fact))
if (missingFilterInferFacts.length > 0) {
  console.error('expected filter inferred facts changed')
  console.error(missingFilterInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  suite.fail()
}

const filterMapInferReport = inferFitFiles(['tests/patterns/patterns.ts'], {functionName: 'filteredMappedRowsKeepBaseLineage'})
const filterMapInferFacts = new Set(filterMapInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedFilterMapInferFacts = [
  'return.rows is an order-preserving subset of items',
]
const missingFilterMapInferFacts = expectedFilterMapInferFacts.filter(fact => !filterMapInferFacts.has(fact))
if (missingFilterMapInferFacts.length > 0) {
  console.error('expected filter-map inferred facts changed')
  console.error(missingFilterMapInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  suite.fail()
}

const loopInferReport = inferFitFiles(['tests/patterns/loop-patterns.ts'], {functionName: 'localLoopAnnotation'})
const loopFunctionSpecStatuses = new Map(loopInferReport.functions[0]?.specs.map(spec => [spec.text, spec.status]) ?? [])
const loopReport = loopInferReport.functions[0]?.loops[0]
const loopFacts = new Set(loopReport?.facts.map(fact => fact.text) ?? [])
const loopSpecStatuses = new Map(loopReport?.specs.map(spec => [spec.text, spec.status]) ?? [])
const loopRedundantSpecs = new Map(loopReport?.redundant.map(spec => [spec.text, spec.reason]) ?? [])
const expectedLoopFacts = [
  'rows.length == items.length',
  'rows[].height: 0..40',
  'nondecreasing(rows.y)',
  'spaced(rows, gap)',
]
const missingLoopFacts = expectedLoopFacts.filter(fact => !loopFacts.has(fact))
const expectedLoopSpecStatuses = [
  ['given items[].height: 0..40', 'assumed'],
  ['rows.length == items.length', 'checked'],
  ['spaced(rows, gap)', 'checked'],
] as const
const expectedLoopFunctionSpecStatuses = [
  ['given items.length: int 1..50', 'assumed'],
  ['return.rows.length == items.length', 'checked'],
] as const
const badLoopSpecStatuses = expectedLoopSpecStatuses.filter(([text, status]) => loopSpecStatuses.get(text) !== status)
const expectedLoopRedundantSpecs = [
  ['rows.length == items.length', 'rows.length == items.length'],
  ['rows[].height: 0..40', 'rows[].height: 0..40'],
] as const
const missingLoopRedundantSpecs = expectedLoopRedundantSpecs.filter(([text, reason]) => loopRedundantSpecs.get(text) !== reason)
const unexpectedlyRedundantLoopSpecs: string[] = []
const badLoopFunctionSpecStatuses = expectedLoopFunctionSpecStatuses.filter(([text, status]) => loopFunctionSpecStatuses.get(text) !== status)
if (missingLoopFacts.length > 0 || badLoopSpecStatuses.length > 0 || missingLoopRedundantSpecs.length > 0 || unexpectedlyRedundantLoopSpecs.length > 0 || badLoopFunctionSpecStatuses.length > 0) {
  console.error('expected loop inferred facts changed')
  console.error(missingLoopFacts.map(fact => `missing: ${fact}`).join('\n'))
  console.error(badLoopSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  console.error(missingLoopRedundantSpecs.map(([text, reason]) => `expected redundant ${text}: ${reason}`).join('\n'))
  console.error(unexpectedlyRedundantLoopSpecs.map(text => `unexpected redundant: ${text}`).join('\n'))
  console.error(badLoopFunctionSpecStatuses.map(([text, status]) => `expected function ${text}: ${status}`).join('\n'))
  suite.fail()
}

// Conditional flush loops keep the exact operand snapshots used by rounded
// additions, so resetting the height after the push cannot change the
// row-bottom or next-row computation retroactively.
const segmentedLoopInferReport = inferFitFiles(['tests/patterns/loop-patterns.ts'], {functionName: 'segmentedStackRowsWithGuardLocalResetAlias'})
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
  console.error('expected segmented loop inferred facts changed')
  console.error(missingSegmentedFacts.map(fact => `missing: ${fact}`).join('\n'))
  console.error(badSegmentedSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  suite.fail()
}

const redundantInferReport = inferFitFiles(['tests/patterns/loop-patterns.ts'], {functionName: 'scalarPushLoop'})
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
  console.error('expected function-level redundant facts changed')
  console.error(missingRedundantFacts.map(([fact, reason]) => `missing redundant: ${fact} covered by ${reason}`).join('\n'))
  console.error(badRedundantSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  suite.fail()
}

const tupleInferReport = inferFitFiles(['tests/patterns/patterns.ts'], {functionName: 'scalarStringishMutationPreservesTupleFacts'})
const tupleFacts = new Set(tupleInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
if (!tupleFacts.has('return.length == 2')) {
  console.error('expected fixed tuple length inference to stay readable')
  suite.fail()
}

const equalityRedundantReport = inferFitFiles(['tests/patterns/loop-patterns.ts'], {functionName: 'stackedRowsWithBottom'})
const equalityRedundantFunction = equalityRedundantReport.functions[0]
const equalityRedundantFacts = new Set(equalityRedundantFunction?.facts.map(fact => fact.text) ?? [])
const equalityRedundantSpecs = new Map(equalityRedundantFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedEqualityRedundantFacts = [
  'return.rows[].bottom == (rows[].y + items[].height)',
]
const missingEqualityRedundantFacts = expectedEqualityRedundantFacts.filter(fact => !equalityRedundantFacts.has(fact))
if (missingEqualityRedundantFacts.length > 0 || equalityRedundantSpecs.get('return.rows[].bottom == return.rows[].y + return.rows[].height') !== 'checked') {
  console.error('expected equality redundant facts changed')
  console.error(missingEqualityRedundantFacts.map(fact => `missing: ${fact}`).join('\n'))
  suite.fail()
}

const callSiteTextReport = inferFitFiles(['tests/patterns/patterns.ts'], {functionName: 'userlandClampThroughArithmeticAlias'})
const callSiteTextFacts = new Set(callSiteTextReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedCallSiteTextFacts = [
  'return == max(0, min(value, (position.cols - w)))',
]
const missingCallSiteTextFacts = expectedCallSiteTextFacts.filter(fact => !callSiteTextFacts.has(fact))
if (missingCallSiteTextFacts.length > 0) {
  console.error('expected call-site inferred text changed')
  console.error(missingCallSiteTextFacts.map(fact => `missing: ${fact}`).join('\n'))
  suite.fail()
}

const actualInferSnapshot = normalizeText([
  formatInferSnapshot(['tests/patterns/patterns.ts'], 'propertyAccessCallShape'),
  formatInferSnapshot(['tests/patterns/patterns.ts'], 'mapCallbackReturnShape'),
  formatInferSnapshot(['tests/patterns/loop-patterns.ts'], 'scalarPushLoop'),
  formatInferSnapshot(['tests/imports/import-patterns.ts'], 'namespaceImportedStructuralShape'),
  formatInferSnapshot(['tests/patterns/patterns.ts'], 'mapBlockRowsWithDestructure'),
  formatInferSnapshot(['tests/patterns/loop-patterns.ts'], 'localLoopAnnotation'),
].join('\n'))
if (!await verifySnapshot(inferSnapshotExpectedPath, actualInferSnapshot, 'infer snapshot')) suite.fail()

const referenceAliasChecks = verifyFitSource('reference-aliases.ts', `function grow(row: {size: number}) {
  row.size = 999
}

/** @fit
 * return == 1
 */
function assignedContainerAlias() {
  const box = {size: 1}
  let rows: {size: number}[] = []
  rows = [box]
  rows.forEach(row => { row.size = 999 })
  return box.size
}

/** @fit
 * return == 1
 */
function mappedElementAlias() {
  const box = {size: 1}
  const rows = [box]
  const copied = rows.map(row => row)
  copied.forEach(row => { row.size = 999 })
  return box.size
}

/** @fit
 * return == 1
 */
function filteredElementAlias() {
  const box = {size: 1}
  const rows = [box]
  const copied = rows.filter(() => true)
  copied.forEach(row => { row.size = 999 })
  return box.size
}

/** @fit
 * return == 1
 */
function directElementArgumentAlias() {
  const box = {size: 1}
  const rows = [box]
  grow(rows[0]!)
  return box.size
}

/** @fit
 * return == 1
 */
function readOnlyElementAliasesKeepFacts() {
  const box = {size: 1}
  const rows = [box]
  const copied = rows.filter(() => true)
  copied.forEach(row => { void row.size })
  return box.size
}

/** @fit
 * return == 999
 */
function conditionalAliasDoesNotNarrow(flag: boolean) {
  const left = {size: 1}
  const right = {size: 1}
  const chosen = flag ? left : right
  chosen.size = 999
  return left.size
}

declare function touch(row: {size: number}): void
const outerBox = {size: 1}
function touchOuterBox() {
  touch(outerBox)
}

/** @fit
 * return == 1
 */
function unavailableCallThroughHelper() {
  touchOuterBox()
  return outerBox.size
}
`)
const aliasClaims = referenceAliasChecks.filter(check => check.text === 'return == 1')
const readOnlyAlias = aliasClaims.find(check => check.functionName === 'readOnlyElementAliasesKeepFacts')
const staleMutationProofs = aliasClaims.filter(check =>
  check.functionName !== 'readOnlyElementAliasesKeepFacts'
  && check.status === 'pass'
)
const conditionalAlias = referenceAliasChecks.find(check => check.functionName === 'conditionalAliasDoesNotNarrow' && check.text === 'return == 999')
if (
  staleMutationProofs.length > 0
  || aliasClaims.length !== 6
  || readOnlyAlias?.status !== 'pass'
  || conditionalAlias?.status === 'pass'
) {
  console.error('expected definite, conditional, and unavailable-call mutations to forget every reachable alias without narrowing branches')
  console.error(formatTestDiagnostics(referenceAliasChecks))
  suite.fail()
}

const purePlacementChecks = verifyFitSource('pure-placement.ts', `function misplacedPure(items: number[]) {
  /** @fit
   * pure
   */
  for (const item of items) {
    void item
  }
  return items.length
}

function nestedClassMemberContracts() {
  class Local {
    constructor() {
      const value = 1 // @fit 1
      void value
    }

    set item(next: number) {
      const value = next // @fit == next
      void value
    }
  }
  return Local
}
`)
const purePlacement = purePlacementChecks.find(check => check.text === 'pure')
const nestedClassPlacements = purePlacementChecks.filter(check => check.functionName === 'nestedClassMemberContracts')
const nestedPlacementReason = 'Unsupported @fit placement: contracts inside a nested function are not checked; move the contract onto the enclosing statement or a named function'
if (
  purePlacement?.status !== 'unknown'
  || purePlacement.reason !== 'Unsupported @fit placement: `pure` can only appear in a function-level @fit block'
  || nestedClassPlacements.length !== 2
  || nestedClassPlacements.some(check => check.status !== 'unknown' || check.reason !== nestedPlacementReason)
) {
  console.error('expected invalid loop and nested class-member placements to be rejected during placement classification')
  console.error(formatTestDiagnostics(purePlacementChecks))
  suite.fail()
}

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
  if (file.startsWith(repoDir)) return file.slice(repoDir.length)
  if (file.startsWith(workspaceDir)) return `../${file.slice(workspaceDir.length)}`
  return file
}

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
  console.error('expected finite default inputs to restore the loop magnitude proof')
  console.error(formatTestDiagnostics(finiteDefaultLoopChecks))
  suite.fail()
}

})
