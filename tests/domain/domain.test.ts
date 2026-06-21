import {describe, setDefaultTimeout, test} from 'bun:test'
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
import {rationalEquals} from '../../src/rational.ts'
import {verifyFitSource} from '../../src/reports.ts'
import {requiredCheck, testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

describe('domain', () => {
test('preserves simplex bounded, unbounded, infeasible, and proof results', () => {
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
  throw testDiagnosticError('expected simplex pivots to preserve bounded, unbounded, infeasible, and proof results', [])
}
})

test('widens arithmetic ranges that admit infinity hazards', () => {
const unboundedNonnegativeProduct = multiplyNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'right'),
)
// Zero times Infinity is NaN, and both are admitted here, so the hull must
// widen fully for the NaN exclusion to see it.
if (unboundedNonnegativeProduct.min !== Number.NEGATIVE_INFINITY || unboundedNonnegativeProduct.max !== Number.POSITIVE_INFINITY) {
  throw testDiagnosticError(`expected the NaN-admitting product to widen fully, got ${unboundedNonnegativeProduct.min}..${unboundedNonnegativeProduct.max}`, unboundedNonnegativeProduct)
}

const unboundedNonnegativeQuotient = divideNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(1, Number.POSITIVE_INFINITY, null, 'right'),
)
// Infinity over Infinity is NaN, and both sides admit Infinity here.
if (unboundedNonnegativeQuotient.kind !== 'number' || unboundedNonnegativeQuotient.min !== Number.NEGATIVE_INFINITY || unboundedNonnegativeQuotient.max !== Number.POSITIVE_INFINITY) {
  throw testDiagnosticError(`expected the NaN-admitting quotient to widen fully, got ${unboundedNonnegativeQuotient.kind === 'number' ? `${unboundedNonnegativeQuotient.min}..${unboundedNonnegativeQuotient.max}` : unboundedNonnegativeQuotient.kind}`, unboundedNonnegativeQuotient)
}


const unboundedDifference = subtractNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'right'),
)
if (unboundedDifference.min !== Number.NEGATIVE_INFINITY || unboundedDifference.max !== Number.POSITIVE_INFINITY) {
  throw testDiagnosticError(`expected -Infinity..Infinity difference, got ${unboundedDifference.min}..${unboundedDifference.max}`, unboundedDifference)
}
})

test('preserves numeric computation identity across refinement and joins', () => {
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
  throw testDiagnosticError('expected numeric computation identity to ignore refinement, merge facts, preserve grouping, and support commutativity', [])
}
})

test('joins array summaries by semantic identity and compatible paths', () => {
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
  throw testDiagnosticError('expected array summaries to join common facts by semantic identity and preserve path-sensitive ends', [])
}
})

test('retains runtime identity for commutative computations', () => {
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
  throw testDiagnosticError('expected commutative computations to retain runtime identity', computationIdentityChecks)
}
})

test('excludes NaN from checked number inputs by default', () => {
const nanComputationIdentityChecks = verifyFitSource('nan-computation-identity.ts', `
/** @fit
 * return == right + left
 */
function nanCapableCommutative(left: number, right: number) {
  return left + right
}
`)
if (nanComputationIdentityChecks.length !== 1 || nanComputationIdentityChecks[0]?.status !== 'pass') {
  throw testDiagnosticError('expected checked number inputs to exclude NaN by default', nanComputationIdentityChecks)
}
})

test('contains NaN hazards while preserving overflow and guarded parsing', () => {
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
const zeroTimesInfinity = requiredCheck(checkedNumberOperationChecks, {functionName: 'zeroTimesInfinity', text: 'return >= 0'})
const infiniteSine = requiredCheck(checkedNumberOperationChecks, {functionName: 'infiniteSine', text: 'return: -1..1'})
const benignOverflow = requiredCheck(checkedNumberOperationChecks, {functionName: 'benignOverflow', text: 'return: 0..Infinity'})
const parsedFinite = requiredCheck(checkedNumberOperationChecks, {functionName: 'parsedFinite', text: 'return: -Infinity<..<Infinity'})
const deliberateNaN = requiredCheck(checkedNumberOperationChecks, {functionName: 'deliberateNaN', text: 'return: 0..10'})
const oneNaNBranch = requiredCheck(checkedNumberOperationChecks, {functionName: 'oneNaNBranch', text: 'return: 0..10'})
const integerGuard = requiredCheck(checkedNumberOperationChecks, {functionName: 'integerGuard', text: 'return: int -Infinity<..<Infinity'})
const safeIntegerGuard = requiredCheck(checkedNumberOperationChecks, {functionName: 'safeIntegerGuard', text: 'return: int -9007199254740991..9007199254740991'})
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
const nanUnderUnary = requiredCheck(checkedNumberOperationChecks, {functionName: 'nanUnderUnary', text: 'return >= 0'})
const nanUnderCompound = requiredCheck(checkedNumberOperationChecks, {functionName: 'nanUnderCompound', text: 'return >= 0'})
const uncheckedSquare = requiredCheck(checkedNumberOperationChecks, {functionName: 'uncheckedSquare', text: 'return >= 0'})
if (
  zeroTimesInfinity.status !== 'unknown'
  || zeroTimesInfinity.reason?.includes('zero and infinity may meet') !== true
  || zeroTimesInfinity.reason.includes('+ 1')
  || infiniteSine.status !== 'unknown'
  || infiniteSine.reason?.includes('expected a finite number') !== true
  || benignOverflow.status !== 'pass'
  || parsedFinite.status !== 'pass'
  || deliberateNaN.status !== 'unknown'
  || deliberateNaN.reason !== 'NaN is outside the checked numerical domain'
  || oneNaNBranch.status !== 'unknown'
  || oneNaNBranch.reason !== 'NaN is outside the checked numerical domain'
  || integerGuard.status !== 'pass'
  || safeIntegerGuard.status !== 'pass'
  || missingPassingNumberFunctions.length > 0
  || checkedNumberOperationChecks.some(check => expectedPassingNumberFunctions.has(check.functionName) && check.status !== 'pass')
  || nanUnderUnary.status !== 'unknown'
  || nanUnderUnary.reason?.startsWith('0 * Infinity is unknown because') !== true
  || nanUnderCompound.status !== 'unknown'
  || nanUnderCompound.reason?.startsWith('0 * Infinity is unknown because') !== true
  || uncheckedSquare.status !== 'unknown'
  || uncheckedSquare.reason?.includes('operand may be NaN') !== true
) {
  throw testDiagnosticError('expected NaN hazards to stop at their source while overflow and guarded parsing remain usable', checkedNumberOperationChecks)
}
})

test('supports matching named indexes and direct adjacent relationships', () => {
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
].map(text => requiredCheck(collectionExpressionChecks, {functionName: 'copyRows', text}).status)
collectionExpressionPasses.push(...[
  'return[$i].height >= 0',
  'return[$i].height: 0..40',
].map(text => requiredCheck(collectionExpressionChecks, {functionName: 'namedIndexForms', text}).status))
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
] as const
const unsupportedNamedIndexCheckResults = unsupportedNamedIndexChecks.map(([functionName, text]) =>
  requiredCheck(collectionExpressionChecks, {functionName, text}))
const acceptedMinusOneWithoutFact = requiredCheck(collectionExpressionChecks, {
  functionName: 'namedIndexForms',
  text: 'return[$i - 1].height <= return[$i].height',
})
const customLabelFailure = requiredCheck(collectionExpressionChecks, {
  functionName: 'namedIndexForms',
  text: 'twice(return[$row].height) >= twice(return[$row - 1].height)',
})
if (
  collectionExpressionPasses.some(status => status !== 'pass')
  || acceptedMinusOneWithoutFact.status !== 'unknown'
  || acceptedMinusOneWithoutFact.reason?.toLowerCase().includes('named index') === true
  || customLabelFailure.reason?.includes('$row - 1') !== true
  || unsupportedNamedIndexCheckResults.some(check =>
    check.status !== 'unknown'
    || check.reason?.toLowerCase().includes('named index') !== true)
) {
  throw testDiagnosticError('expected named indexes to support only matching positions and direct adjacent relationships', collectionExpressionChecks)
}
})

test('simplifies rounding comparisons to smaller arithmetic', () => {
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
const simplifiedRoundingCheck = requiredCheck(simplifiedRoundingChecks, {functionName: 'frame', text: 'return.outer >= return.inner'})
const missingRoundingCheck = requiredCheck(simplifiedRoundingChecks, {functionName: 'missingFrame', text: 'return.outer >= return.inner'})
if (
  simplifiedRoundingCheck.status !== 'pass'
  || missingRoundingCheck.status !== 'unknown'
  || missingRoundingCheck.reason?.includes('missing: (width / 2) <= gap') !== true
) {
  throw testDiagnosticError('expected proof simplification to reduce rounding comparisons to smaller arithmetic', simplifiedRoundingChecks)
}
})

test('covers the rounding proof family and rejects unsafe cases', () => {
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
const truncNeedsSignCheck = requiredCheck(roundingFamilyChecks, {functionName: 'truncNeedsSign', text: 'return <= value'})
const roundStrictCheck = requiredCheck(roundingFamilyChecks, {functionName: 'roundMonotonicityIsNotStrict', text: 'return < Math.round(right)'})
if (
  roundingFamilyFailures.length > 0
  || truncNeedsSignCheck.status !== 'unknown'
  || truncNeedsSignCheck.reason?.includes('missing fact: trunc(value) <= value') !== true
  || roundStrictCheck.status !== 'unknown'
  || roundStrictCheck.reason?.includes('missing: left < (round(right) - 0.5)') !== true
) {
  throw testDiagnosticError('expected rounding family proof rules to cover floor/ceil/round/trunc and reject unsafe strict/sign cases', roundingFamilyChecks)
}
})

test('infers expanded Math builtin ranges and rejects unsafe domains', () => {
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
const logNeedsPositiveCheck = requiredCheck(expandedMathChecks, {functionName: 'logNeedsPositive', text: 'return: -Infinity..Infinity'})
if (
  expandedMathFailures.length > 0
  || logNeedsPositiveCheck.status !== 'unknown'
  || logNeedsPositiveCheck.reason?.includes('Math.log expected a non-negative number') !== true
) {
  throw testDiagnosticError('expected expanded Math builtin families to infer ranges and reject unsafe domains', expandedMathChecks)
}
})

test('keeps source identifiers distinct from wildcard path placeholders', () => {
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
const wildcardIdentityCollisionCheck = requiredCheck(wildcardIdentityCollisionChecks, {
  functionName: 'wildcardIdentityCollision',
  text: 'rows[].height == __fit_domain_rows___item_height',
})
if (wildcardIdentityCollisionCheck.status !== 'fail') {
  throw testDiagnosticError('expected a source identifier not to share proof identity with a wildcard path placeholder', wildcardIdentityCollisionChecks)
}
})

})
