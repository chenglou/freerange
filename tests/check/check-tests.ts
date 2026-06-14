import {createFunctionContractCache, inferFitFiles, readTopLevelGlobal, verifyFitProgramWithCallsites} from '../../src/check-core.ts'
import {
  addNumbers,
  binaryNumberComputation,
  divideNumbers,
  joinValues,
  multiplyNumbers,
  numberValue,
  numberWithBounds,
  numberWithComputation,
  sameNumberComputation,
  subtractNumbers,
} from '../../src/domain.ts'
import {runningSumNumber} from '../../src/loop-summary.ts'
import {uniqueUnsupported} from '../../src/infer-report.ts'
import {buildFitSourceFile, TypeScriptUserlandError} from '../../src/modules.ts'
import {preparedProgramContracts} from '../../src/prepared-contracts.ts'
import {type FitCheck, verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {isFunctionImplementation} from '../../src/function-shape.ts'

const positiveFiles = ['tests/patterns/patterns.ts', 'tests/patterns/loop-patterns.ts', 'tests/imports/import-patterns.ts', 'tests/interpreter-matrix/interpreter-matrix-patterns.ts']
const negativeFiles = ['tests/patterns/negative-patterns.ts', 'tests/patterns/negative-shadowed-catalog.ts', 'tests/imports/negative-import-patterns.ts', 'tests/interpreter-matrix/interpreter-matrix-negative.ts']
const negativeExpectedPath = 'negative-patterns.expected.txt'
const inferSnapshotExpectedPath = 'infer-snapshots.expected.txt'
const repoDir = new URL('../..', import.meta.url).pathname
const workspaceDir = repoDir.replace(/\/[^/]+\/$/, '/')

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
  console.error(JSON.stringify(callableFamilyNames))
  process.exitCode = 1
} else {
  console.log('functions: one implementation family and canonical class-member names')
}

function verifyFitSourceWithCallsites(file: string, sourceText: string) {
  const program = buildFitSourceFile(file, sourceText, readTopLevelGlobal)
  return verifyFitProgramWithCallsites(program, createFunctionContractCache())
}

const positiveReport = await verifyFitFiles(positiveFiles)
if (positiveReport.phase !== 'ready') {
  console.error(JSON.stringify(positiveReport, null, 2))
  process.exitCode = 1
} else {
  console.log(`positive: ${positiveReport.summary.pass} pass, 0 fail, 0 requires, 0 unknown`)
}

const photoGalleryReport = await verifyFitFiles(['photo-gallery/index.ts'])
if (photoGalleryReport.phase !== 'ready' || photoGalleryReport.summary.pass !== 38 || photoGalleryReport.summary.fail !== 0 || photoGalleryReport.summary.requires !== 0 || photoGalleryReport.summary.unknown !== 0) {
  console.error('expected photo-gallery literal data to stay summarized')
  console.error(photoGalleryReport.phase === 'ready'
    ? `got ${photoGalleryReport.summary.pass} pass, ${photoGalleryReport.summary.fail} fail, ${photoGalleryReport.summary.requires} requires, ${photoGalleryReport.summary.unknown} unknown`
    : JSON.stringify(photoGalleryReport, null, 2))
  process.exitCode = 1
} else {
  console.log('photo-gallery: summarized array data')
}

const unboundedNonnegativeProduct = multiplyNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'right'),
)
// Zero times Infinity is NaN, and both are admitted here, so the hull must
// widen fully for the NaN exclusion to see it.
if (unboundedNonnegativeProduct.min !== Number.NEGATIVE_INFINITY || unboundedNonnegativeProduct.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected the NaN-admitting product to widen fully, got ${unboundedNonnegativeProduct.min}..${unboundedNonnegativeProduct.max}`)
  process.exitCode = 1
} else {
  console.log('domain: NaN-admitting product widens')
}

const unboundedNonnegativeQuotient = divideNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(1, Number.POSITIVE_INFINITY, null, 'right'),
)
// Infinity over Infinity is NaN, and both sides admit Infinity here.
if (unboundedNonnegativeQuotient.kind !== 'number' || unboundedNonnegativeQuotient.min !== Number.NEGATIVE_INFINITY || unboundedNonnegativeQuotient.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected the NaN-admitting quotient to widen fully, got ${unboundedNonnegativeQuotient.kind === 'number' ? `${unboundedNonnegativeQuotient.min}..${unboundedNonnegativeQuotient.max}` : unboundedNonnegativeQuotient.kind}`)
  process.exitCode = 1
} else {
  console.log('domain: NaN-admitting quotient widens')
}

const unboundedNonnegativeRunningSum = runningSumNumber(
  'y',
  numberValue(0, Number.POSITIVE_INFINITY, null, 'start'),
  numberValue(0, Number.POSITIVE_INFINITY, 0, 'count'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'increment'),
)
if (unboundedNonnegativeRunningSum.min !== 0 || unboundedNonnegativeRunningSum.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity running sum, got ${unboundedNonnegativeRunningSum.min}..${unboundedNonnegativeRunningSum.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded nonnegative running sum')
}

const unboundedDifference = subtractNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, null, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, null, 'right'),
)
if (unboundedDifference.min !== Number.NEGATIVE_INFINITY || unboundedDifference.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected -Infinity..Infinity difference, got ${unboundedDifference.min}..${unboundedDifference.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded difference')
}

const computationLeft = numberValue(0, 1000, null, 'left')
const computationHeight = numberValue(0, 40, null, 'height')
const computationGap = numberValue(0, 10, null, 'gap')
const computedAdd = (left: typeof computationLeft, right: typeof computationLeft) =>
  numberWithComputation(addNumbers(left, right), binaryNumberComputation('+', left, right))
const computationBottom = computedAdd(computationLeft, computationHeight)
const computationNext = computedAdd(computationBottom, computationGap)
const computationNextAgain = computedAdd(computationBottom, computationGap)
const computationRegrouped = computedAdd(computationLeft, computedAdd(computationHeight, computationGap))
const sameComputationJoin = joinValues(computationNext, computationNextAgain)
const regroupedComputationJoin = joinValues(computationNext, computationRegrouped)
const narrowedComputation = numberWithBounds(computationNext, 0, 100)
if (
  computationNext.computation == null
  || computationRegrouped.computation == null
  || !sameNumberComputation(computationNext.computation, computationNextAgain.computation)
  || sameNumberComputation(computationNext.computation, computationRegrouped.computation)
  || sameComputationJoin.kind !== 'number'
  || sameComputationJoin.computation == null
  || regroupedComputationJoin.kind !== 'number'
  || regroupedComputationJoin.computation != null
  || narrowedComputation.computation == null
  || !sameNumberComputation(computationNext.computation, narrowedComputation.computation)
) {
  console.error('expected numeric computations to preserve operand snapshots, grouping, and range refinement')
  process.exitCode = 1
} else {
  console.log('domain: numeric computations preserve grouping across joins')
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
  || sequenceObligationCheck?.trace?.usedFacts.some(fact => fact.startsWith('sequence facts:')) !== true
) {
  console.error('expected checks to carry proof obligations and used facts')
  console.error(JSON.stringify({obligationChecks, sequenceObligationCheck}, null, 2))
  process.exitCode = 1
} else {
  console.log('obligations: attached to checks with facts')
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
  console.error(JSON.stringify(pureContractHelperChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: pure helper call')
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
  console.error(JSON.stringify(pureGivenHelperChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('given contract expressions: pure helper call')
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
  console.error(JSON.stringify(shortcutCleanupChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('shortcut cleanup: no invented spec or callback paths')
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
  console.error(JSON.stringify({constrainedGenericFunctionResult, unconstrainedGenericFunctionChecks}, null, 2))
  process.exitCode = 1
} else {
  console.log('generic functions: constrained numbers checked through calls')
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
  console.error(JSON.stringify({missingTypeLayerErrors, contractTypeLayerChecks}, null, 2))
  process.exitCode = 1
} else {
  console.log('contract type layer: all surfaces reject TypeScript mismatches')
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
  console.error(JSON.stringify(inlineNonNumberEqualityChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('inline contracts: non-number equality type-checks')
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
  console.error(JSON.stringify({
    assumptions: preparedBounded.assumptions.map(spec => spec.text),
    proofs: preparedBounded.proofs.map(spec => spec.text),
    typeChecks: preparedBounded.typeChecks,
    preparedPropertyTemplateCounts,
  }, null, 2))
  process.exitCode = 1
} else {
  console.log('contract preparation: stable index and exact rejection identity')
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
  console.error(JSON.stringify(topLevelContractChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('top-level contracts: properties, loops, and nested placements')
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
  console.error(JSON.stringify(booleanCallContractChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: bare boolean helper call')
}

const booleanGivenContractResult = verifyFitSourceWithCallsites('boolean-given-contracts.ts', `function isValidLayout(layout: {width: number}) {
  return layout.width > 0
}

/** @fit
 * given isValidLayout(layout)
 * isValidLayout(layout)
 */
function assumesValidLayout(layout: {width: number}) {
  return layout
}

function invalidCaller() {
  return assumesValidLayout({width: 0})
}

/** @fit
 * given isValidLayout(layout)
 * given !isValidLayout(layout)
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
const assumedBooleanGivenCheck = booleanGivenContractResult.annotationChecks.find(check => check.functionName === 'assumesValidLayout' && check.text === 'isValidLayout(layout)')
const conflictingBooleanGivenCheck = booleanGivenContractResult.annotationChecks.find(check => check.functionName === 'conflictingLayout' && check.text === 'given !isValidLayout(layout)')
const assumedNegativeBooleanGivenCheck = booleanGivenContractResult.annotationChecks.find(check => check.functionName === 'assumesInvalidLayout' && check.text === '!isValidLayout(layout)')
const invalidBooleanGivenCall = booleanGivenContractResult.callsiteChecks.find(check => check.functionName === 'invalidCaller' && check.text === 'assumesValidLayout({width: 0}): requires isValidLayout(layout)')
if (
  assumedBooleanGivenCheck?.status !== 'pass'
  || assumedBooleanGivenCheck.trace?.steps.some(step => step.rule === 'assumption') !== true
  || conflictingBooleanGivenCheck?.status !== 'fail'
  || conflictingBooleanGivenCheck.reason?.includes('no input can satisfy both given isValidLayout(layout) and given !isValidLayout(layout)') !== true
  || assumedNegativeBooleanGivenCheck?.status !== 'pass'
  || invalidBooleanGivenCall?.status !== 'fail'
  || invalidBooleanGivenCall.reason?.includes('given isValidLayout(layout) returned false') !== true
) {
  console.error('expected boolean given predicates to be assumed in the callee and checked at callers')
  console.error(JSON.stringify(booleanGivenContractResult, null, 2))
  process.exitCode = 1
} else {
  console.log('given contract expressions: boolean predicate call')
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
 */
function offsetAcrossCollections(items: {height: number}[], boxes: {height: number}[]) {
  return {rows: items.map(item => ({height: item.height})), boxes}
}
`)
const collectionExpressionPasses = [
  'twice(return.rows[$i].height) == twice(items[$i].height)',
  'return.rows[$i + 1].height: 0..40',
  'return.rows[$i + 1].height >= 0',
  'twice(return.rows[].height) <= 80',
].map(text => collectionExpressionChecks.find(check => check.functionName === 'copyRows' && check.text === text)?.status)
const crossCollectionOffsetCheck = collectionExpressionChecks.find(check =>
  check.functionName === 'offsetAcrossCollections'
  && check.text === 'return.rows[$i + 1].height == boxes[$i].height')
if (
  collectionExpressionPasses.some(status => status !== 'pass')
  || crossCollectionOffsetCheck?.status !== 'unknown'
) {
  console.error('expected indexed and wildcard checks to keep expression support where the index meaning is clear')
  console.error(JSON.stringify(collectionExpressionChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('collection contracts: pure expressions with wildcards and indexed paths')
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
  console.error(JSON.stringify(simplifiedRoundingChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('proof simplification: rounded bound comparison')
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
  console.error(JSON.stringify(roundingFamilyChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('proof simplification: rounding family')
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
  console.error(JSON.stringify(expandedMathChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('math builtins: constants, integer/coarse, and monotone functions')
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
  console.error(JSON.stringify(impureContractHelperChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: impure helper rejected')
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
  console.error(JSON.stringify(mutableReadContractHelperChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: mutable outside read rejected')
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
  console.error(JSON.stringify(unsupportedContractExpressionChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: unsupported calls rejected')
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
  console.error(JSON.stringify(mutableAliasContractChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: mutable alias rejected')
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
  console.error(JSON.stringify(unsupportedGivenExpressionChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('given contract expressions: unsupported cases rejected')
}

const negativeReport = await verifyFitFiles(negativeFiles)
const actualNegative = normalizeNegative(negativeReport.checks)
if (Bun.argv.includes('--update')) {
  await Bun.write(negativeExpectedPath, actualNegative)
  console.log(`negative: updated ${negativeExpectedPath}`)
} else {
  const expectedNegative = normalizeText(await Bun.file(negativeExpectedPath).text())
  if (actualNegative !== expectedNegative) {
    console.error('expected negative messages changed')
    console.error('\nExpected:\n' + expectedNegative)
    console.error('Actual:\n' + actualNegative)
    process.exitCode = 1
  } else {
    console.log(`negative: ${negativeReport.checks.filter(check => check.status !== 'pass').length} expected messages`)
  }
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
  process.exitCode = 1
} else {
  console.log('given typo: suggested contract root')
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
  process.exitCode = 1
} else {
  console.log('given typo: ambiguous root reported by TypeScript')
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
  process.exitCode = 1
} else {
  console.log('function data: duplicate names rejected')
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
  process.exitCode = 1
} else {
  console.log('diagnostics: collapsed unsupported root fallout')
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
  console.error(JSON.stringify(unsupportedBranchConditionChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('control flow: unsupported branch condition stops')
}

const inferReport = inferFitFiles(['tests/patterns/patterns.ts'], {functionName: 'typedObjectParamArrayShape'})
const inferFacts = new Set(inferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedInferFacts = [
  'return.rows.length == params.items.length',
  'return.rows.length: int 0..4294967295',
  'return.rows[].height == item.height',
  'return.rows follows params.items by index',
]
const missingInferFacts = expectedInferFacts.filter(fact => !inferFacts.has(fact))
if (missingInferFacts.length > 0) {
  console.error('expected inferred facts changed')
  console.error(missingInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer: ${expectedInferFacts.length} expected facts`)
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
  process.exitCode = 1
} else {
  console.log(`infer filter: ${expectedFilterInferFacts.length} expected facts`)
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
  process.exitCode = 1
} else {
  console.log(`infer filter-map: ${expectedFilterMapInferFacts.length} expected facts`)
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
  process.exitCode = 1
} else {
  console.log(`infer loops: ${expectedLoopFacts.length} expected facts`)
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
  'return.rows[$i + 1].y == return.rows[$i].y + return.rows[$i].height + gap',
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
  process.exitCode = 1
} else {
  console.log(`infer segmented loop: ${expectedSegmentedFacts.length} expected facts`)
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
  process.exitCode = 1
} else {
  console.log(`infer redundant: ${expectedRedundantFacts.length} expected facts`)
}

const tupleInferReport = inferFitFiles(['tests/patterns/patterns.ts'], {functionName: 'scalarStringishMutationPreservesTupleFacts'})
const tupleFacts = new Set(tupleInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
if (!tupleFacts.has('return.length == 2')) {
  console.error('expected fixed tuple length inference to stay readable')
  process.exitCode = 1
} else {
  console.log('infer tuple length: readable')
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
  process.exitCode = 1
} else {
  console.log(`infer equality redundant: ${expectedEqualityRedundantFacts.length} expected facts`)
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
  process.exitCode = 1
} else {
  console.log(`infer call-site text: ${expectedCallSiteTextFacts.length} expected facts`)
}

const actualInferSnapshot = normalizeText([
  formatInferSnapshot(['tests/patterns/patterns.ts'], 'typedObjectParamArrayShape'),
  formatInferSnapshot(['tests/patterns/patterns.ts'], 'propertyAccessCallShape'),
  formatInferSnapshot(['tests/patterns/patterns.ts'], 'mapCallbackReturnShape'),
  formatInferSnapshot(['tests/patterns/loop-patterns.ts'], 'scalarPushLoop'),
  formatInferSnapshot(['tests/imports/import-patterns.ts'], 'namespaceImportedStructuralShape'),
  formatInferSnapshot(['tests/patterns/patterns.ts'], 'mapBlockRowsWithDestructure'),
  formatInferSnapshot(['tests/patterns/loop-patterns.ts'], 'localLoopAnnotation'),
  formatInferSnapshot([
    '../vibescript/demos/photo-gallery/layout.ts',
    '../vibescript/demos/photo-gallery/prompt-layout.ts',
  ], 'getGridLayout'),
  formatInferSnapshot([
    '../vibescript/demos/photo-gallery/layout.ts',
    '../vibescript/demos/photo-gallery/prompt-layout.ts',
  ], 'getLineLayout'),
].join('\n'))
if (Bun.argv.includes('--update')) {
  await Bun.write(inferSnapshotExpectedPath, actualInferSnapshot)
  console.log(`infer snapshot: updated ${inferSnapshotExpectedPath}`)
} else {
  const expectedInferSnapshot = normalizeText(await Bun.file(inferSnapshotExpectedPath).text())
  if (actualInferSnapshot !== expectedInferSnapshot) {
    console.error('expected infer snapshot changed')
    console.error('\nExpected:\n' + expectedInferSnapshot)
    console.error('Actual:\n' + actualInferSnapshot)
    process.exitCode = 1
  } else {
    console.log('infer snapshot: matched')
  }
}

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
  console.error(JSON.stringify(referenceAliasChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('reference aliases: mutations forget every reachable binding')
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
  console.error(JSON.stringify(purePlacementChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract placement: loop and nested class-member diagnostics')
}

function normalizeNegative(checks: FitCheck[]) {
  const lines = checks
    .filter(check => check.status !== 'pass')
    .map(check => {
      const head = `${check.status.toUpperCase()} ${check.file}:${check.functionName}: ${check.text}`
      if (check.reason == null) return head
      const reason = check.reason.split('\n').map(line => `  ${line}`).join('\n')
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
  addSection(lines, 'return', snapshotItems(functionName, 'return', fn.facts.map(fact => fact.text)))
  addSection(lines, 'locals', snapshotItems(functionName, 'locals', fn.locals.map(fact => fact.text)))
  for (const loop of fn.loops) {
    lines.push(`loop ${loop.line}: ${loop.header}`)
    addSection(lines, 'inferred', snapshotItems(functionName, 'loop', loop.facts.map(fact => fact.text)), '  ')
    addSection(lines, 'checked', loop.specs.filter(spec => spec.status === 'checked').map(spec => spec.text), '  ')
    addSection(lines, 'assumptions', loop.specs.filter(spec => spec.status === 'assumed').map(spec => spec.text), '  ')
    addSection(lines, 'not-inferred', loop.specs.filter(spec => spec.status === 'not-inferred').map(spec => spec.text), '  ')
  }
  addSection(lines, 'unsupported', fn.unsupported.filter(line => line.startsWith('Forgot unsupported')))
  return lines.join('\n')
}

function snapshotItems(functionName: string, section: string, items: string[]) {
  if (functionName === 'getGridLayout') return items.filter(item => keepGridLayoutSnapshotItem(section, item))
  if (functionName === 'getLineLayout') return items.filter(item => keepLineLayoutSnapshotItem(section, item))
  return items
}

function keepGridLayoutSnapshotItem(section: string, item: string) {
  if (item.includes('.fragments')) return false
  if (item === 'return.items.length == layoutSources.length') return true
  if (item === 'return.contentHeight == nextRowTop') return true
  if (item === 'return.contentHeight: 40..Infinity') return true
  if (item === 'return.rows.length == rows.length') return true
  if (item === 'return.rows[].bottom == (rows[].y + rows[].height)') return true
  if (item === 'return.rows[].bottom: 40..Infinity') return true
  if (item === 'return.rows[].height == rows[].height') return true
  if (item === 'return.rows[].height: 0..Infinity') return true
  if (item === 'return.rows[].y == rows[].y') return true
  if (item === 'return.rows[].y: 40..Infinity') return true
  if (item === 'nondecreasing(return.rows.y)') return true
  if (item === 'spaced(return.rows, 24)') return true
  if (section === 'return') {
    return item === 'return.items[].imageBox.sizeX: 0..1952'
      || item === 'return.items[].layoutBox.sizeX: 0..1952'
      || item.includes('return.items[].prompt.box.sizeX ==')
      || item.includes('return.items[].prompt.box.sizeY ==')
      || item.includes('return.items[].prompt.lines.length ==')
      || item === 'return.items[].prompt.lines.length: int 0..4294967295'
  }
  return item === 'cols: int 1..7'
    || item === 'boxMaxSizeX: 18.285714285714285..1952'
    || item === 'rows[].bottom == (rows[].y + rows[].height)'
    || item === 'rows[].bottom: 40..Infinity'
    || item === 'rows[].height: 0..Infinity'
    || item === 'rows[].y: 40..Infinity'
    || item === 'nondecreasing(rows.y)'
    || item === 'spaced(rows, 24)'
    || item === 'measurements.length == layoutSources.length'
    || item === 'measurements[].imageSizeX: 0..1952'
    || item.includes('measurements[].promptLayout.lineCount ==')
    || item.includes('measurements[].promptLayout.lines.length ==')
    || item === 'measurements[].promptLayout.lines.length: int 0..4294967295'
    || item.includes('measurements[].promptLayout.visibleHeight ==')
    || item.includes('measurements[].promptLayout.width ==')
}

function keepLineLayoutSnapshotItem(section: string, item: string) {
  if (item.includes('.fragments')) return false
  if (section === 'return') {
    return item === 'return.items.length == layoutSources.length'
      || item === 'return.items.length: int 0..4294967295'
      || item === 'return.items[].imageBox.sizeX == get1DItemSizeResult.imageSizeX'
      || item === 'return.items[].imageBox.sizeY == get1DItemSizeResult.imageSizeY'
      || item.includes('return.items[].prompt.box.sizeX ==')
      || item.includes('return.items[].prompt.box.sizeY ==')
      || item.includes('return.items[].prompt.lines.length ==')
      || item === 'return.items[].prompt.lines.length: int 0..4294967295'
      || item.includes('return.items[].prompt.lines[].width ==')
  }
  return item === 'box1DMaxSizeX == ((windowSizeX - (boxes1DGapX * 2)) - (hitArea1DSizeX * 2))'
    || item === 'box1DMaxSizeY == ((windowSizeY - windowPaddingTop) - boxes1DGapY)'
    || item === 'measurements.length == layoutSources.length'
    || item === 'measurements.length: int 0..4294967295'
    || item === 'items.length == layoutSources.length'
    || item === 'items.length: int 0..4294967295'
    || item === 'measurements[].imageSizeX == get1DItemSizeResult.imageSizeX'
    || item === 'measurements[].imageSizeY == get1DItemSizeResult.imageSizeY'
    || item === 'measurements[].layoutHeight == get1DItemSizeResult.layoutHeight'
    || item === 'measurements[].promptLayout.lineCount == get1DItemSizeResult.promptLayout.lineCount'
    || item === 'measurements[].promptLayout.lines.length == get1DItemSizeResult.promptLayout.lines.length'
    || item === 'measurements[].promptLayout.lines.length: int 0..4294967295'
    || item === 'measurements[].promptLayout.visibleHeight == get1DItemSizeResult.promptLayout.visibleHeight'
    || item === 'measurements[].promptLayout.width == get1DItemSizeResult.promptLayout.width'
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
