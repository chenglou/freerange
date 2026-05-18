import {inferFitFiles} from './src/check-core.ts'
import {divideNumbers, multiplyNumbers, numberValue, runningSumNumber, subtractNumbers} from './src/domain.ts'
import {uniqueUnsupported} from './src/infer-report.ts'
import {type FitCheck, verifyFitFiles, verifyFitSource} from './src/reports.ts'

const positiveFiles = ['patterns.ts', 'import-patterns.ts', 'interpreter-matrix-patterns.ts']
const negativeFiles = ['negative-patterns.ts', 'negative-import-patterns.ts', 'interpreter-matrix-negative.ts']
const negativeExpectedPath = 'negative-patterns.expected.txt'
const inferSnapshotExpectedPath = 'infer-snapshots.expected.txt'
const repoDir = new URL('.', import.meta.url).pathname
const workspaceDir = repoDir.replace(/\/[^/]+\/$/, '/')

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
  numberValue(0, Number.POSITIVE_INFINITY, false, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, false, 'right'),
)
if (unboundedNonnegativeProduct.min !== 0 || unboundedNonnegativeProduct.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity product, got ${unboundedNonnegativeProduct.min}..${unboundedNonnegativeProduct.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded nonnegative product')
}

const unboundedNonnegativeQuotient = divideNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, false, 'left'),
  numberValue(1, Number.POSITIVE_INFINITY, false, 'right'),
)
if (unboundedNonnegativeQuotient.kind !== 'number' || unboundedNonnegativeQuotient.min !== 0 || unboundedNonnegativeQuotient.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity quotient, got ${unboundedNonnegativeQuotient.kind === 'number' ? `${unboundedNonnegativeQuotient.min}..${unboundedNonnegativeQuotient.max}` : unboundedNonnegativeQuotient.kind}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded nonnegative quotient')
}

const unboundedNonnegativeRunningSum = runningSumNumber(
  numberValue(0, Number.POSITIVE_INFINITY, false, 'start'),
  numberValue(0, Number.POSITIVE_INFINITY, true, 'count'),
  numberValue(0, Number.POSITIVE_INFINITY, false, 'increment'),
)
if (unboundedNonnegativeRunningSum.min !== 0 || unboundedNonnegativeRunningSum.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity running sum, got ${unboundedNonnegativeRunningSum.min}..${unboundedNonnegativeRunningSum.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded nonnegative running sum')
}

const unboundedDifference = subtractNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, false, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, false, 'right'),
)
if (unboundedDifference.min !== Number.NEGATIVE_INFINITY || unboundedDifference.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected -Infinity..Infinity difference, got ${unboundedDifference.min}..${unboundedDifference.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded difference')
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

const dynamicRangeContractChecks = verifyFitSource('dynamic-range-contracts.ts', `function low() {
  return 10
}

function high() {
  return 20
}

/** @fit
 * given min <= max
 * return: min..max
 */
function keepInside(min: number, max: number) {
  return min
}

/** @fit
 * given min: int 0..100
 * given max: int 0..100
 * given min <= max
 * return: int min..max
 */
function keepInsideInt(min: number, max: number) {
  return min + (max - max)
}

/** @fit
 * return: 10..20
 */
function usesDynamicSummary() {
  return keepInside(10, 20)
}

/** @fit
 * return: int 10..20
 */
function usesIntDynamicSummary() {
  return keepInsideInt(10, 20)
}

/** @fit
 * return: low() | high()
 */
function picksAlternative(flag: boolean) {
  return flag ? low() : high()
}

/** @fit
 * return: low() | high()
 */
function missesAlternative() {
  return 15
}

/** @fit
 * return: 0..10 | 20..30
 */
function picksRangeAlternative(flag: boolean) {
  return flag ? 5 : 25
}

/** @fit
 * return: 0..10 | 20..30
 */
function missesRangeAlternative() {
  return 15
}
`)
const dynamicSummaryCheck = dynamicRangeContractChecks.find(check => check.functionName === 'usesDynamicSummary' && check.text === 'return: 10..20')
const intDynamicSummaryCheck = dynamicRangeContractChecks.find(check => check.functionName === 'usesIntDynamicSummary' && check.text === 'return: int 10..20')
const dynamicAlternativeCheck = dynamicRangeContractChecks.find(check => check.functionName === 'picksAlternative' && check.text === 'return: low() | high()')
const missedAlternativeCheck = dynamicRangeContractChecks.find(check => check.functionName === 'missesAlternative' && check.text === 'return: low() | high()')
const dynamicRangeAlternativeCheck = dynamicRangeContractChecks.find(check => check.functionName === 'picksRangeAlternative' && check.text === 'return: 0..10 | 20..30')
const missedRangeAlternativeCheck = dynamicRangeContractChecks.find(check => check.functionName === 'missesRangeAlternative' && check.text === 'return: 0..10 | 20..30')
if (
  dynamicSummaryCheck?.status !== 'pass'
  || intDynamicSummaryCheck?.status !== 'pass'
  || dynamicAlternativeCheck?.status !== 'pass'
  || missedAlternativeCheck?.status !== 'fail'
  || dynamicRangeAlternativeCheck?.status !== 'pass'
  || missedRangeAlternativeCheck?.status !== 'fail'
) {
  console.error('expected dynamic range summaries and numeric alternatives to be checked')
  console.error(JSON.stringify(dynamicRangeContractChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('range contracts: dynamic bounds and alternatives')
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
 * value - 1 < return.floorValue
 * value <= return.ceilValue
 * return.ceilValue < value + 1
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
 * positive - 1 < return.positiveTrunc
 * return.negativeTrunc >= negative
 * return.negativeTrunc <= 0
 * return.negativeTrunc < negative + 1
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
  || truncNeedsSignCheck.reason?.includes('missing: value >= 0') !== true
  || roundStrictCheck?.status !== 'unknown'
  || roundStrictCheck.reason?.includes('missing: left < (round(right) - 0.5)') !== true
) {
  console.error('expected rounding family proof rules to cover floor/ceil/round/trunc and reject unsafe strict/sign cases')
  console.error(JSON.stringify(roundingFamilyChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('proof simplification: rounding family')
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
  || impureContractHelperCheck.reason.includes('effect bad > bump line 4: assignment mutates box.limit') !== true
) {
  console.error('expected impure helper calls in contracts to be rejected loudly')
  console.error(JSON.stringify(impureContractHelperChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: impure helper rejected')
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
  || randomContractCheck.reason?.includes('Unsupported Math.random call') !== true
  || dynamicContractCheck?.status !== 'unknown'
  || dynamicContractCheck.reason?.includes('Unsupported call Math[method]') !== true
) {
  console.error('expected unsupported contract expressions to explain the unsupported step')
  console.error(JSON.stringify(unsupportedContractExpressionChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('contract expressions: unsupported calls rejected')
}

const unsupportedRangeExpressionChecks = verifyFitSource('range-expression-unsupported.ts', `const box = {limit: 0}

function bump() {
  box.limit += 1
  return box.limit
}

/** @fit
 * return: bump() | 2
 */
function bad() {
  return 2
}
`)
const unsupportedRangeExpressionCheck = unsupportedRangeExpressionChecks.find(check => check.functionName === 'bad' && check.text === 'return: bump() | 2')
if (
  unsupportedRangeExpressionCheck?.status !== 'unknown'
  || unsupportedRangeExpressionCheck.reason?.includes('Unsupported @fit contract expression: bump()') !== true
  || unsupportedRangeExpressionCheck.reason.includes('assignment mutates box.limit') !== true
) {
  console.error('expected unsupported range expressions to reject the same way as comparisons')
  console.error(JSON.stringify(unsupportedRangeExpressionChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('range contracts: unsupported expression rejected')
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
`)
const impureGivenCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'impure' && check.text === 'given max >= bump(min)')
const noInputGivenCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'noInput' && check.text === 'given double(10) > 0')
const derivedRangeTargetCheck = unsupportedGivenExpressionChecks.find(check => check.functionName === 'derivedRangeTarget' && check.text === 'given double(value): 0..10')
if (
  impureGivenCheck?.status !== 'unknown'
  || impureGivenCheck.reason?.includes('Unsupported @fit contract expression: bump(min)') !== true
  || impureGivenCheck.reason.includes('assignment mutates box.limit') !== true
  || noInputGivenCheck?.status !== 'unknown'
  || noInputGivenCheck.reason !== 'given must mention an input'
  || derivedRangeTargetCheck?.status !== 'unknown'
  || derivedRangeTargetCheck.reason !== 'given range must name one input path, not a derived expression'
) {
  console.error('expected given helper expressions to reject impure, input-independent, and derived range target cases')
  console.error(JSON.stringify(unsupportedGivenExpressionChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('given contract expressions: unsupported cases rejected')
}

const negativeReport = await verifyFitFiles(negativeFiles)
const actualNegative = normalizeNegative(negativeReport.checks)
const expectedNegative = normalizeText(await Bun.file(negativeExpectedPath).text())

if (actualNegative !== expectedNegative) {
  console.error('expected negative messages changed')
  console.error('\nExpected:\n' + expectedNegative)
  console.error('Actual:\n' + actualNegative)
  process.exitCode = 1
} else {
  console.log(`negative: ${negativeReport.checks.filter(check => check.status !== 'pass').length} expected messages`)
}

const suggestedGivenRootReason = verifyFitSource('given-typo.ts', `const boxesGapX = 24

/** @fit
 * given containerSizX >= 2 * boxesGapX
 */
function layout(containerSizeX: number) {
  return containerSizeX
}
`).find(check => check.text === 'given containerSizX >= 2 * boxesGapX')?.reason
if (suggestedGivenRootReason !== 'containerSizX not found in this contract scope\ndid you mean containerSizeX?') {
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
if (ambiguousGivenRootReason !== 'boxesGap not found in this contract scope') {
  console.error('expected ambiguous given typo to avoid guessing')
  console.error(ambiguousGivenRootReason ?? '<missing>')
  process.exitCode = 1
} else {
  console.log('given typo: ambiguous root stays plain')
}

const typeGivenKeywordChecks = verifyFitSource('type-given-keyword.ts', `type Bar = {
  b: number // @fit > 0
}

/** @fit
 * given Bar.a > 10
 */
type Foo = {
  a: Bar
}

/** @fit
 * return > 0
 */
function read(foo: Foo) {
  return foo.a.b
}
`)
const typeGivenKeywordCheck = typeGivenKeywordChecks.find(check => check.text === 'given Bar.a > 10')
if (
  typeGivenKeywordCheck?.status !== 'unknown'
  || typeGivenKeywordCheck.reason !== 'type @fit lines do not use given; write the field fact without given'
) {
  console.error('expected type @fit given keyword to be rejected directly')
  console.error(JSON.stringify(typeGivenKeywordChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('type contracts: given keyword rejected directly')
}

const typeGivenPrefixFieldChecks = verifyFitSource('type-given-prefix-field.ts', `/** @fit
 * givenValue > 0
 */
type Box = {
  givenValue: number
}

/** @fit
 * return > 0
 */
function read(box: Box) {
  return box.givenValue
}
`)
const typeGivenPrefixFieldFailures = typeGivenPrefixFieldChecks.filter(check => check.status !== 'pass')
if (typeGivenPrefixFieldFailures.length > 0) {
  console.error('expected type @fit fields starting with given to keep working')
  console.error(JSON.stringify(typeGivenPrefixFieldChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('type contracts: given-prefixed field allowed')
}

const typeContractScopeChecks = verifyFitSource('type-contract-scope.ts', `const typeScopedMin = 80

function typeScopedDouble(value: number) {
  return value * 2
}

type ScopedTile = {
  width: number // @fit typeScopedDouble(typeScopedMin)..Infinity
}

/** @fit
 * return >= 160
 */
function readsScopedType(tile: ScopedTile) {
  return tile.width
}

function rejectsUsageLocal() {
  const typeScopedMin = 0
  const tile: ScopedTile = {width: 40}
  return tile.width
}

type MissingScopedTile = {
  width: number // @fit missingTypeMin..Infinity
}

function reportsMissingDeclarationName(tile: MissingScopedTile) {
  return tile.width
}
`)
const scopedTypeReadCheck = typeContractScopeChecks.find(check => check.functionName === 'readsScopedType' && check.text === 'return >= 160')
const usageLocalCaptureCheck = typeContractScopeChecks.find(check => check.functionName === 'rejectsUsageLocal' && check.text === 'tile.width: typeScopedDouble(typeScopedMin)..Infinity')
const missingDeclarationNameCheck = typeContractScopeChecks.find(check => check.functionName === 'reportsMissingDeclarationName' && check.text === 'given tile.width: missingTypeMin..Infinity')
if (
  scopedTypeReadCheck?.status !== 'pass'
  || usageLocalCaptureCheck?.status !== 'fail'
  || missingDeclarationNameCheck?.status !== 'unknown'
  || missingDeclarationNameCheck.reason?.includes('Unknown identifier missingTypeMin') !== true
) {
  console.error('expected type @fit contracts to evaluate free names where the type is declared')
  console.error(JSON.stringify(typeContractScopeChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('type contracts: declaration scope')
}

let duplicateFunctionError = ''
try {
  verifyFitSource('duplicate-function.ts', `function score() {
  return 1
}

function score() {
  return 2
}
`)
} catch (error) {
  duplicateFunctionError = error instanceof Error ? error.message : String(error)
}
if (duplicateFunctionError !== 'Unsupported duplicate function implementation score in duplicate-function.ts') {
  console.error('expected duplicate function names to be rejected before they overwrite fit data')
  console.error(duplicateFunctionError || '<no error>')
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

const inferReport = inferFitFiles(['patterns.ts'], {functionName: 'typedObjectParamArrayShape'})
const inferFacts = new Set(inferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedInferFacts = [
  'return.rows.length == params.items.length',
  'return.rows.length: int 0..Infinity',
  'return.rows[].height == params.items[].height',
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

const filterInferReport = inferFitFiles(['patterns.ts'], {functionName: 'filteredRowsKeepElementDomain'})
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

const filterMapInferReport = inferFitFiles(['patterns.ts'], {functionName: 'filteredMappedRowsKeepBaseLineage'})
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

const loopInferReport = inferFitFiles(['patterns.ts'], {functionName: 'localLoopAnnotation'})
const loopFunctionSpecStatuses = new Map(loopInferReport.functions[0]?.specs.map(spec => [spec.text, spec.status]) ?? [])
const loopReport = loopInferReport.functions[0]?.loops[0]
const loopFacts = new Set(loopReport?.facts.map(fact => fact.text) ?? [])
const loopSpecStatuses = new Map(loopReport?.specs.map(spec => [spec.text, spec.status]) ?? [])
const loopRedundantSpecs = new Map(loopReport?.redundant.map(spec => [spec.text, spec.reason]) ?? [])
const expectedLoopFacts = [
  'rows.length == items.length',
  'rows[].height: 0..40',
  'nondecreasing(rows.top)',
  'spaced(rows, gap)',
]
const missingLoopFacts = expectedLoopFacts.filter(fact => !loopFacts.has(fact))
const expectedLoopSpecStatuses = [
  ['given items[].height: 0..40', 'assumed'],
  ['rows.length == items.length', 'checked'],
  ['spaced(rows, gap)', 'checked'],
  ['lastEnd(rows) == y - gap', 'checked'],
] as const
const expectedLoopFunctionSpecStatuses = [
  ['given items.length: int 1..50', 'assumed'],
  ['return.bottom >= top', 'checked'],
  ['return.rows.length == items.length', 'checked'],
] as const
const badLoopSpecStatuses = expectedLoopSpecStatuses.filter(([text, status]) => loopSpecStatuses.get(text) !== status)
const expectedLoopRedundantSpecs = [
  ['rows.length == items.length', 'rows.length == items.length'],
  ['rows[].height: 0..40', 'rows[].height: 0..40'],
] as const
const missingLoopRedundantSpecs = expectedLoopRedundantSpecs.filter(([text, reason]) => loopRedundantSpecs.get(text) !== reason)
const unexpectedlyRedundantLoopSpecs = ['lastEnd(rows) == y - gap'].filter(text => loopRedundantSpecs.has(text))
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

const segmentedLoopInferReport = inferFitFiles(['patterns.ts'], {functionName: 'segmentedStackRowsWithGuardLocalResetAlias'})
const segmentedFunction = segmentedLoopInferReport.functions[0]
const segmentedFacts = new Set(segmentedFunction?.facts.map(fact => fact.text) ?? [])
const segmentedSpecs = new Map(segmentedFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedSegmentedFacts = [
  'return.rows.length: int 0..50',
  'return.rows[].bottom == (rows[].top + rows[].height)',
  'nondecreasing(return.rows.top)',
  'spaced(return.rows, gap)',
]
const missingSegmentedFacts = expectedSegmentedFacts.filter(fact => !segmentedFacts.has(fact))
const expectedSegmentedSpecStatuses = [
  ['return.rows.length <= items.length', 'checked'],
  ['return.rows[].bottom == return.rows[].top + return.rows[].height', 'checked'],
  ['spaced(return.rows, gap)', 'checked'],
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

const redundantInferReport = inferFitFiles(['patterns.ts'], {functionName: 'scalarPushLoop'})
const redundantFunction = redundantInferReport.functions[0]
const redundantFacts = new Map(redundantFunction?.redundant.map(fact => [fact.text, fact.reason]) ?? [])
const expectedRedundantFacts = [
  ['return.length == items.length', 'return.length == items.length'],
  ['return[]: 0..3000', 'return[]: 0..3000'],
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

const tupleInferReport = inferFitFiles(['patterns.ts'], {functionName: 'scalarStringishMutationPreservesTupleFacts'})
const tupleFacts = new Set(tupleInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
if (!tupleFacts.has('return.length == 2')) {
  console.error('expected fixed tuple length inference to stay readable')
  process.exitCode = 1
} else {
  console.log('infer tuple length: readable')
}

const equalityRedundantReport = inferFitFiles([
  '../vibescript/demos/photo-gallery/layout.ts',
  '../vibescript/demos/photo-gallery/prompt-layout.ts',
], {functionName: 'getGridLayout'})
const equalityRedundantLoop = equalityRedundantReport.functions[0]?.loops[0]
const equalityRedundantFacts = new Map(equalityRedundantLoop?.redundant.map(fact => [fact.text, fact.reason]) ?? [])
const expectedEqualityRedundantFacts = [
  ['rows[].bottom == rows[].top + rows[].height', 'rows[].bottom == (rows[].top + rows[].height)'],
] as const
const missingEqualityRedundantFacts = expectedEqualityRedundantFacts.filter(([fact, reason]) => equalityRedundantFacts.get(fact) !== reason)
if (missingEqualityRedundantFacts.length > 0) {
  console.error('expected equality redundant facts changed')
  console.error(missingEqualityRedundantFacts.map(([fact, reason]) => `missing redundant: ${fact} covered by ${reason}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer equality redundant: ${expectedEqualityRedundantFacts.length} expected facts`)
}

const callSiteTextReport = inferFitFiles(['patterns.ts'], {functionName: 'userlandClampThroughArithmeticAlias'})
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
  formatInferSnapshot(['patterns.ts'], 'typedObjectParamArrayShape'),
  formatInferSnapshot(['patterns.ts'], 'propertyAccessCallShape'),
  formatInferSnapshot(['patterns.ts'], 'mapCallbackReturnShape'),
  formatInferSnapshot(['patterns.ts'], 'scalarPushLoop'),
  formatInferSnapshot(['import-patterns.ts'], 'namespaceImportedStructuralShape'),
  formatInferSnapshot(['patterns.ts'], 'mapBlockRowsWithDestructure'),
  formatInferSnapshot(['patterns.ts'], 'localLoopAnnotation'),
  formatInferSnapshot([
    '../vibescript/demos/photo-gallery/layout.ts',
    '../vibescript/demos/photo-gallery/prompt-layout.ts',
  ], 'getGridLayout'),
  formatInferSnapshot([
    '../vibescript/demos/photo-gallery/layout.ts',
    '../vibescript/demos/photo-gallery/prompt-layout.ts',
  ], 'getLineLayout'),
].join('\n'))
const expectedInferSnapshot = normalizeText(await Bun.file(inferSnapshotExpectedPath).text())
if (actualInferSnapshot !== expectedInferSnapshot) {
  console.error('expected infer snapshot changed')
  console.error('\nExpected:\n' + expectedInferSnapshot)
  console.error('Actual:\n' + actualInferSnapshot)
  process.exitCode = 1
} else {
  console.log('infer snapshot: matched')
}

await runCliRegressionTests()

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
  if (item === 'return.rows[].bottom == (rows[].top + rows[].height)') return true
  if (item === 'return.rows[].bottom: 40..Infinity') return true
  if (item === 'return.rows[].height == rows[].height') return true
  if (item === 'return.rows[].height: 0..Infinity') return true
  if (item === 'return.rows[].top == rows[].top') return true
  if (item === 'return.rows[].top: 40..Infinity') return true
  if (item === 'nondecreasing(return.rows.top)') return true
  if (item === 'spaced(return.rows, boxesGapY)') return true
  if (section === 'return') {
    return item === 'return.items[].imageBox.sizeX: 0..1952'
      || item === 'return.items[].layoutBox.sizeX: 0..1952'
      || item.includes('return.items[].prompt.box.sizeX ==')
      || item.includes('return.items[].prompt.box.sizeY ==')
      || item.includes('return.items[].prompt.lines.length ==')
      || item === 'return.items[].prompt.lines.length: int 0..Infinity'
  }
  return item === 'cols: int 1..7'
    || item === 'boxMaxSizeX: 18.285714285714285..1952'
    || item === 'rows[].bottom == (rows[].top + rows[].height)'
    || item === 'rows[].bottom: 40..Infinity'
    || item === 'rows[].height: 0..Infinity'
    || item === 'rows[].top: 40..Infinity'
    || item === 'nondecreasing(rows.top)'
    || item === 'spaced(rows, boxesGapY)'
    || item === 'measurements.length == layoutSources.length'
    || item === 'measurements[].imageSizeX: 0..1952'
    || item.includes('measurements[].promptLayout.lineCount ==')
    || item.includes('measurements[].promptLayout.lines.length ==')
    || item === 'measurements[].promptLayout.lines.length: int 0..Infinity'
    || item.includes('measurements[].promptLayout.visibleHeight ==')
    || item.includes('measurements[].promptLayout.width ==')
}

function keepLineLayoutSnapshotItem(section: string, item: string) {
  if (item.includes('.fragments')) return false
  if (section === 'return') {
    return item === 'return.items.length == layoutSources.length'
      || item === 'return.items.length: int 0..Infinity'
      || item === 'return.items[].imageBox.sizeX == get1DItemSizeResult.imageSizeX'
      || item === 'return.items[].imageBox.sizeY == get1DItemSizeResult.imageSizeY'
      || item.includes('return.items[].prompt.box.sizeX ==')
      || item.includes('return.items[].prompt.box.sizeY ==')
      || item.includes('return.items[].prompt.lines.length ==')
      || item === 'return.items[].prompt.lines.length: int 0..Infinity'
      || item.includes('return.items[].prompt.lines[].width ==')
  }
  return item === 'box1DMaxSizeX == ((windowSizeX - (boxes1DGapX * 2)) - (hitArea1DSizeX * 2))'
    || item === 'box1DMaxSizeY == ((windowSizeY - windowPaddingTop) - boxes1DGapY)'
    || item === 'measurements.length == layoutSources.length'
    || item === 'measurements.length: int 0..Infinity'
    || item === 'items.length == layoutSources.length'
    || item === 'items.length: int 0..Infinity'
    || item === 'measurements[].imageSizeX == get1DItemSizeResult.imageSizeX'
    || item === 'measurements[].imageSizeY == get1DItemSizeResult.imageSizeY'
    || item === 'measurements[].layoutHeight == get1DItemSizeResult.layoutHeight'
    || item === 'measurements[].promptLayout.lineCount == get1DItemSizeResult.promptLayout.lineCount'
    || item === 'measurements[].promptLayout.lines.length == get1DItemSizeResult.promptLayout.lines.length'
    || item === 'measurements[].promptLayout.lines.length: int 0..Infinity'
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

async function runCliRegressionTests() {
  const explicitCheck = runFr(['check', 'patterns.ts', 'import-patterns.ts'])
  expectCli(explicitCheck.exitCode === 0, 'expected fr check <files> to pass', explicitCheck.output)
  expectCli(explicitCheck.output.includes('fr check: 2 files,'), 'expected explicit fr check summary to include file count', explicitCheck.output)
  expectCli(explicitCheck.output.includes('0 fail, 0 requires, 0 unknown'), 'expected explicit fr check summary to include clean counts', explicitCheck.output)

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['check'], dir)
    expectCli(check.exitCode === 0, 'expected no-arg fr check to pass from tsconfig project', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown'), 'expected no-arg fr check summary from tsconfig project', check.output)
  })

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}

function plain() {
  return 1
}
`,
  }, dir => {
    const infer = runFr(['infer', '--all'], dir)
    expectCli(infer.exitCode === 0, 'expected no-arg fr infer --all to summarize a tsconfig project', infer.output)
    expectCli(infer.output.includes('fr infer --all: 1 files, 2 functions'), 'expected project infer summary count', infer.output)
    expectCli(infer.output.includes('facts:'), 'expected project infer summary facts', infer.output)
    expectCli(!infer.output.includes('layout.ts:plain'), 'expected project infer summary to avoid per-function dump', infer.output)
  })

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'project-types.ts': `type ProjectBox = {
  value: number // @fit 0..10
}
`,
    'project-consumer.ts': `export function makeBox(): ProjectBox {
  return {value: 5}
}
`,
  }, dir => {
    const check = runFr(['check', 'project-consumer.ts'], dir)
    expectCli(check.exitCode === 0, 'expected explicit file check to use tsconfig type roots', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown'), 'expected project type contract to pass', check.output)
  })

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'project-types.ts': `type ProjectBox = {
  value: number // @fit 0..10
}
`,
    'project-consumer.ts': `export function makeBox(): ProjectBox {
  return {value: 20}
}
`,
  }, dir => {
    const check = runFr(['check', 'project-consumer.ts'], dir)
    expectCli(check.exitCode === 1, 'expected project type roots to enforce imported type-field facts', check.output)
    expectCli(check.output.includes('FAIL return.value: 0..10'), 'expected project type root failure output', check.output)
    expectCli(check.output.includes('fr check: 1 files, 0 pass, 1 fail, 0 requires, 0 unknown'), 'expected project type root failure summary', check.output)
  })

  await withCliFixture({
    'helper.ts': `/** @fit
 * given value: 0..10
 * return: 0..10
 */
export function cap(value: number) {
  return value
}
`,
    'barrel.ts': `export * from './helper'
`,
    'layout.ts': `import {cap} from './barrel'

/** @fit
 * given value: 0..10
 * return: 0..10
 */
function use(value: number) {
  return cap(value)
}
`,
  }, dir => {
    const check = runFr(['check', 'layout.ts'], dir)
    expectCli(check.exitCode === 0, 'expected star-barrel helper import to pass', check.output)
    expectCli(check.output.includes('0 fail, 0 requires, 0 unknown'), 'expected star-barrel helper import summary', check.output)
  })

  await withCliFixture({
    'helper.ts': `/** @fit
 * given value: 0..100
 * return: 0..100
 */
export function wide(value: number) {
  return value
}
`,
    'barrel.ts': `export * from './helper'
`,
    'layout.ts': `import {wide} from './barrel'

/** @fit
 * given value: 0..100
 * return: 0..10
 */
function use(value: number) {
  return wide(value)
}
`,
  }, dir => {
    const check = runFr(['check', 'layout.ts'], dir)
    expectCli(check.exitCode === 1, 'expected star-barrel helper import to preserve callee range', check.output)
    expectCli(check.output.includes('FAIL return: 0..10'), 'expected star-barrel helper failure output', check.output)
    expectCli(!check.output.includes('Unsupported call wide'), 'expected star-barrel helper call to resolve', check.output)
  })

  await withCliFixture({
    'bad.ts': `/** @fit
 * return: 0..1
 */
function bad() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['check', 'bad.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to exit 1 on a failed claim', check.output)
    expectCli(check.output.includes('bad.ts:2:bad'), 'expected fr check failure output to include the spec line and function scope', check.output)
    expectCli(check.output.includes('FAIL return: 0..1'), 'expected fr check failure output', check.output)
    expectCli(check.output.includes('next: run fr infer --function bad bad.ts'), 'expected fr check to point at infer next', check.output)
    expectCli(check.output.includes('fr check: 1 files, 0 pass, 1 fail, 0 requires, 0 unknown'), 'expected fr check failure summary', check.output)
  })

  await withCliFixture({
    'calls.ts': `function h(
  value: number, // @fit 0..10
) {
  return value
}

function f() {
  return h(20)
}
`,
  }, dir => {
    const check = runFr(['check', 'calls.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to exit 1 on a definite bad literal call', check.output)
    expectCli(check.output.includes('calls.ts:8:f'), 'expected fr check failure output to include the call line', check.output)
    expectCli(check.output.includes('FAIL: h(20): requires value: 0..10'), 'expected fr check literal-call failure output', check.output)
    expectCli(check.output.includes('missing: 20 <= 10'), 'expected fr check to print the caller-side missing obligation', check.output)
    expectCli(check.output.includes('fr check: 1 files,'), 'expected fr check summary', check.output)
    expectCli(check.output.includes('1 fail'), 'expected fr check summary to include one fail', check.output)
  })

  await withCliFixture({
    'calls.ts': `function h(
  value: number, // @fit 0..10
) {
  return value
}

function f(value: number) {
  return h(value)
}
`,
  }, dir => {
    const check = runFr(['check', 'calls.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to exit 1 on caller requirements', check.output)
    expectCli(check.output.includes('REQUIRES: h(value): requires value: 0..10'), 'expected fr check caller-requirement output', check.output)
    expectCli(check.output.includes('next: add a caller given, validate before this call, or run fr infer --function f calls.ts to see caller facts'), 'expected fr check to point at caller infer next', check.output)
    expectCli(check.output.includes('fr check: 1 files,'), 'expected fr check requirement summary', check.output)
    expectCli(check.output.includes('0 fail, 1 requires, 0 unknown'), 'expected fr check summary to classify requires separately from fail', check.output)

    const annotationsOnly = runFr(['check', '--annotations-only', 'calls.ts'], dir)
    expectCli(annotationsOnly.exitCode === 0, 'expected fr check --annotations-only to skip broad callsite requirements', annotationsOnly.output)
    expectCli(!annotationsOnly.output.includes('REQUIRES: h(value)'), 'expected fr check --annotations-only to suppress broad callsite requirements', annotationsOnly.output)
    expectCli(annotationsOnly.output.includes('fr check --annotations-only: 1 files,'), 'expected fr check --annotations-only summary', annotationsOnly.output)
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given width: 1..99
 * return: 1..100
 */
function size(width: number) {
  const lower = Math.max(1, width)
  const upper = Math.min(width, 100)
  return width < 100 ? width : 100
}
`,
  }, async dir => {
    const normal = runFr(['check', 'audit.ts'], dir)
    expectCli(normal.exitCode === 0, 'expected normal check to ignore selector audit findings', normal.output)
    expectCli(!normal.output.includes('AUDIT'), 'expected normal check not to print audits', normal.output)

    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected selector audit to stay advisory', audit.output)
    expectCli(audit.output.includes('AUDIT Math.max(1, width): 1 does not affect the result'), 'expected redundant Math.max guard audit', audit.output)
    expectCli(audit.output.includes('AUDIT Math.min(width, 100): 100 does not affect the result'), 'expected redundant Math.min guard audit', audit.output)
    expectCli(audit.output.includes('AUDIT width < 100 ? width : 100: 100 does not affect the result'), 'expected redundant selector ternary branch audit', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 3 audit'), 'expected audit summary count', audit.output)
    const report = await verifyFitFiles([pathJoin(dir, 'audit.ts')], {audit: true})
    const firstAudit = report.audits[0]
    expectCli(firstAudit?.obligation?.boundary === 'audit', 'expected audit to carry an audit obligation', JSON.stringify(report.audits, null, 2))
    expectCli(firstAudit?.trace?.steps[0]?.domain === 'audit', 'expected audit to carry a proof trace', JSON.stringify(report.audits, null, 2))
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given width: 10..99
 * given fallback: 0..100
 * return >= 0
 */
function size(width: number, fallback: number) {
  let value = width
  if (value < 1) value = 1
  const resolved = value ?? fallback
  return resolved
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected branch/nullish audit fixture to pass', audit.output)
    expectCli(audit.output.includes('AUDIT if (value < 1): condition is always false'), 'expected impossible branch audit', audit.output)
    expectCli(audit.output.includes('AUDIT value ?? fallback: fallback does not affect the result'), 'expected redundant nullish fallback audit', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 2 audit'), 'expected branch/nullish audit summary count', audit.output)
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given min <= mid
 * given mid <= width
 * return >= width
 */
function size(min: number, mid: number, width: number) {
  return Math.max(min, width)
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected selector audit to use composed comparison facts', audit.output)
    expectCli(audit.output.includes('AUDIT Math.max(min, width): min does not affect the result'), 'expected transitive Math.max guard audit', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 1 audit'), 'expected transitive audit summary count', audit.output)
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given width: 0..99
 * return: 1..99
 */
function size(width: number) {
  return Math.max(1, width)
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected uncertain selector audit fixture to pass', audit.output)
    expectCli(!audit.output.includes('does not affect the result'), 'expected uncertain Math.max guard to stay quiet', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 0 audit'), 'expected zero audit summary count', audit.output)
  })

  await withCliFixture({
    'audit.ts': `function plain() {
  return Math.max(1, 2)
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected broad audit to visit plain functions', audit.output)
    expectCli(audit.output.includes('AUDIT Math.max(1, 2): 1 does not affect the result'), 'expected broad audit finding', audit.output)

    const annotationsOnly = runFr(['check', '--annotations-only', '--audit', 'audit.ts'], dir)
    expectCli(annotationsOnly.exitCode === 0, 'expected annotations-only audit to pass', annotationsOnly.output)
    expectCli(!annotationsOnly.output.includes('AUDIT Math.max(1, 2)'), 'expected annotations-only audit to skip plain functions', annotationsOnly.output)
    expectCli(annotationsOnly.output.includes('fr check --annotations-only --audit: 1 files, 0 pass, 0 fail, 0 requires, 0 unknown, 0 audit'), 'expected annotations-only audit summary', annotationsOnly.output)
  })

  await withCliFixture({
    'calls.ts': `/** @fit
 * given max >= min
 * return > 0
 */
function h(min: number, value: number, max: number) {
  return 1
}

h(10, 0, 1)

function f() {
  h(20, 0, 2)
}

if (true) {
  h(30, 0, 3)
}

export default h(40, 0, 4)
`,
  }, dir => {
    const check = runFr(['check', 'calls.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to visit broad bare callsites', check.output)
    expectCli(check.output.includes('calls.ts:9:<top-level>'), 'expected top-level bare call line', check.output)
    expectCli(check.output.includes('FAIL: h(10, 0, 1): requires max >= min'), 'expected top-level bare call failure', check.output)
    expectCli(check.output.includes('calls.ts:12:f'), 'expected function bare call line', check.output)
    expectCli(check.output.includes('FAIL: h(20, 0, 2): requires max >= min'), 'expected function bare call failure', check.output)
    expectCli(check.output.includes('calls.ts:16:<top-level>'), 'expected top-level branch call line', check.output)
    expectCli(check.output.includes('FAIL: h(30, 0, 3): requires max >= min'), 'expected top-level branch call failure', check.output)
    expectCli(check.output.includes('calls.ts:19:<top-level>'), 'expected export assignment call line', check.output)
    expectCli(check.output.includes('FAIL: h(40, 0, 4): requires max >= min'), 'expected export assignment call failure', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 4 fail, 0 requires, 0 unknown'), 'expected broad bare callsite summary', check.output)
  })

  await withCliFixture({
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['infer', 'layout.ts', '--function', 'ok'], dir)
    expectCli(check.exitCode === 0, 'expected fr infer to run from the main CLI', check.output)
    expectCli(check.output.includes('layout.ts:ok'), 'expected fr infer to print the function header', check.output)
    expectCli(check.output.includes('checked:'), 'expected fr infer to print checked claims', check.output)
    expectCli(check.output.includes('return: 2'), 'expected fr infer to print the checked return fact', check.output)
  })

  await withCliFixture({
    'infer-filter.ts': `/** @fit
 * return: 2
 */
function annotated() {
  return 2
}

function plain() {
  return 1
}
`,
  }, dir => {
    const infer = runFr(['infer', 'infer-filter.ts'], dir)
    expectCli(infer.exitCode === 0, 'expected file-scoped infer to include every function', infer.output)
    expectCli(infer.output.includes('infer-filter.ts:annotated'), 'expected infer to include annotated function', infer.output)
    expectCli(infer.output.includes('infer-filter.ts:plain'), 'expected infer to include plain function', infer.output)

    const filtered = runFr(['infer', '--annotations-only', 'infer-filter.ts'], dir)
    expectCli(filtered.exitCode === 0, 'expected infer --annotations-only to keep the old filter', filtered.output)
    expectCli(filtered.output.includes('infer-filter.ts:annotated'), 'expected annotations-only infer to include annotated function', filtered.output)
    expectCli(!filtered.output.includes('infer-filter.ts:plain'), 'expected annotations-only infer to skip plain function', filtered.output)
  })

  await withCliFixture({
    'infer-contract.ts': `function randomLimit() {
  return Math.random() * 10
}

/** @fit
 * return <= randomLimit()
 */
function bad() {
  return 0
}
`,
  }, dir => {
    const infer = runFr(['infer', 'infer-contract.ts', '--function', 'bad'], dir)
    expectCli(infer.exitCode === 1, 'expected fr infer to fail when a written contract expression is unsupported', infer.output)
    expectCli(infer.output.includes('Unsupported @fit contract expression: randomLimit()'), 'expected infer output to name the unsupported contract expression', infer.output)
    expectCli(infer.output.includes('Unsupported Math.random call'), 'expected infer output to include the interpreter blocker', infer.output)
  })

  {
    const infer = runFr(['infer'])
    expectCli(infer.exitCode === 2, 'expected no-arg infer to require a file path', infer.output)
    expectCli(infer.output.includes('fr infer: pass a file path'), 'expected no-arg infer guidance', infer.output)
    expectCli(infer.output.includes('fr check [--annotations-only] [--audit] [file.ts ...]'), 'expected usage to include audit flag', infer.output)
    expectCli(infer.output.includes('fr infer [--function name] [--annotations-only] [--all] file.ts ...'), 'expected no-arg infer to print help', infer.output)
  }

  await withCliFixture({
    'helper.ts': `export function clamp(
  value: number,
  min: number, // @fit <= max
  max: number,
): number {
  // @fit >= min
  return Math.min(Math.max(value, min), max) // @fit <= max
}

const opacity = clamp(1.2, 0, 1) // @fit 0..1
`,
  }, dir => {
    const check = runFr(['check', 'helper.ts'], dir)
    expectCli(check.exitCode === 0, 'expected standalone helper call check to pass', check.output)
    expectCli(check.output.includes('fr check: 1 files, 6 pass, 0 fail, 0 requires, 0 unknown'), 'expected standalone helper call check summary', check.output)
  })

  await withCliFixture({
    'helper.ts.tmp': `/** @fit
 * given min <= max
 * return >= min
 * return <= max
 */
export function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Freerange catches this: the result can be 2.
const opacity = clamp(0, 10, 2) // @fit 0..1
`,
  }, dir => {
    const check = runFr(['check', 'helper.ts.tmp'], dir)
    expectCli(check.exitCode === 1, 'expected de-inlined clamp example to fail without crashing', check.output)
    expectCli(check.output.includes('FAIL opacity: 0..1'), 'expected de-inlined clamp example failure output', check.output)
    expectCli(check.output.includes('fr check: 1 files, 3 pass, 1 fail, 0 requires, 0 unknown'), 'expected de-inlined clamp example summary', check.output)
  })

  await withCliFixture({
    'recursive-infer.ts': `function walk(value: number): number {
  const next = value > 0 ? walk(value - 1) : 0
  return next
}
`,
  }, dir => {
    const infer = runFr(['infer', 'recursive-infer.ts', '--function', 'walk'], dir)
    expectCli(infer.exitCode === 0, 'expected recursive infer to stop at the helper cycle instead of overflowing', infer.output)
    expectCli(infer.output.includes('Recursive helper inlining is unsupported at walk'), 'expected recursive infer to report the helper cycle', infer.output)
  })

  {
    const infer = runFr(['infer', 'src/bound-index.ts', '--function', 'proveBoundIndexComparisonSpec'])
    expectCli(infer.exitCode === 0, 'expected self-hosted bound-index infer to stay bounded', infer.output)
    expectCli(infer.output.includes('src/bound-index.ts:proveBoundIndexComparisonSpec'), 'expected bound-index infer header', infer.output)
  }

  await withCliFixture({
    'block-inline.ts': `function invalid(
  value: number /* @fit 0..10 */,
) {
  return value
}
`,
  }, dir => {
    const check = runFr(['check', 'block-inline.ts'], dir)
    expectCli(check.exitCode === 2, 'expected inline block @fit to be rejected', check.output)
    expectCli(check.output.includes('Block @fit comments are only supported for function, loop, and type contract blocks; use // @fit for attached facts'), 'expected inline block @fit guidance', check.output)
  })

  await withCliFixture({
    'syntax.ts': `function invalid(value: number.) {
  return value
}
const =
`,
  }, dir => {
    const check = runFr(['check', 'syntax.ts'], dir)
    expectCli(check.exitCode === 2, 'expected syntax errors to stop fr check', check.output)
    expectCli(check.output.includes('fr: Syntax errors in syntax.ts:'), 'expected syntax error header', check.output)
    expectCli(check.output.includes('Syntax error in syntax.ts:1:32 TS1003: Identifier expected.'), 'expected first TypeScript syntax diagnostic', check.output)
    expectCli(check.output.includes('Syntax error in syntax.ts:4:7 TS1134: Variable declaration expected.'), 'expected second TypeScript syntax diagnostic', check.output)
  })

  console.log('cli: 29 expected behaviors')
}

function runFr(args: string[], cwd = repoDir) {
  return runProcess([process.execPath, pathJoin(repoDir, 'fr.ts'), ...args], cwd)
}

function runProcess(cmd: string[], cwd = repoDir) {
  const decoder = new TextDecoder()
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  }
}

async function withCliFixture(files: Record<string, string>, run: (dir: string) => void | Promise<void>) {
  const dir = pathJoin('/tmp', `freerange-cli-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`)
  const mkdir = runProcess(['mkdir', '-p', dir])
  expectCli(mkdir.exitCode === 0, `expected to create ${dir}`, mkdir.output)
  try {
    for (const [file, text] of Object.entries(files)) {
      await Bun.write(pathJoin(dir, file), text)
    }
    await run(dir)
  } finally {
    const cleanup = runProcess(['rm', '-rf', dir])
    expectCli(cleanup.exitCode === 0, `expected to remove ${dir}`, cleanup.output)
  }
}

function expectCli(condition: boolean, message: string, output: string) {
  if (condition) return
  console.error(message)
  console.error(output.trimEnd())
  process.exitCode = 1
}

function pathJoin(first: string, ...rest: string[]) {
  let path = first.endsWith('/') ? first.slice(0, -1) : first
  for (const part of rest) path += '/' + part.replace(/^\/+/, '')
  return path
}
