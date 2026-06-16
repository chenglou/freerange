import {verifyFitSource} from '../../src/reports.ts'
import {testSuite} from '../test-suite.ts'

testSuite('ranges suite', async suite => {
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
  suite.fail()
} else {
  console.log('range contracts: dynamic bounds and alternatives')
}

const numericUnionPropagationChecks = verifyFitSource('numeric-union-propagation.ts', `/** @fit
 * return: 5 | 20
 */
function edge(flag: boolean): number {
  return flag ? 5 : 20
}

/** @fit
 * return: 0..30
 */
function broad(flag: boolean) {
  return edge(flag)
}

/** @fit
 * return: 0..30
 */
function shifted(flag: boolean) {
  return edge(flag) + 1
}

/** @fit
 * return: 5 | 20
 */
function broadCaller(flag: boolean) {
  return broad(flag)
}

/** @fit
 * return: 6 | 21
 */
function shiftedCaller(flag: boolean) {
  return shifted(flag)
}

/** @fit
 * return: 7..20
 */
function gapCaller(flag: boolean) {
  return shifted(flag)
}

/** @fit
 * return: 5..30 | 20..30
 */
function redundantAlternative(flag: boolean) {
  return flag ? 5 : 30
}

/** @fit
 * return: 20..30
 */
function redundantAlternativeCaller(flag: boolean) {
  return redundantAlternative(flag)
}
`)
const broadCallerCheck = numericUnionPropagationChecks.find(check => check.functionName === 'broadCaller' && check.text === 'return: 5 | 20')
const shiftedCallerCheck = numericUnionPropagationChecks.find(check => check.functionName === 'shiftedCaller' && check.text === 'return: 6 | 21')
const gapCallerCheck = numericUnionPropagationChecks.find(check => check.functionName === 'gapCaller' && check.text === 'return: 7..20')
const redundantAlternativeCallerCheck = numericUnionPropagationChecks.find(check => check.functionName === 'redundantAlternativeCaller' && check.text === 'return: 20..30')
if (
  broadCallerCheck?.status !== 'pass'
  || broadCallerCheck.trace?.usedFacts.includes('5 | 20') !== true
  || shiftedCallerCheck?.status !== 'pass'
  || shiftedCallerCheck.trace?.usedFacts.includes('6 | 21') !== true
  || gapCallerCheck?.status !== 'fail'
  || gapCallerCheck.reason?.includes('int 6..6') !== true
  || redundantAlternativeCallerCheck?.status !== 'fail'
) {
  console.error('expected pure numeric range unions to propagate, normalize, and reject gaps')
  console.error(JSON.stringify(numericUnionPropagationChecks, null, 2))
  suite.fail()
} else {
  console.log('range contracts: numeric union propagation')
}

const unannotatedHelperBoundChecks = verifyFitSource('unannotated-helper-range-bounds.ts', `function limit(value: number) {
  return value * 2
}

/** @fit
 * given width: 0..20
 * return: 0..limit(width)
 */
function inside(width: number) {
  return width + width
}

/** @fit
 * given width: 0..20
 * return: 0..limit(width)
 */
function outside(width: number) {
  return 50
}
`)
const insideHelperBoundCheck = unannotatedHelperBoundChecks.find(check => check.functionName === 'inside' && check.text === 'return: 0..limit(width)')
const outsideHelperBoundCheck = unannotatedHelperBoundChecks.find(check => check.functionName === 'outside' && check.text === 'return: 0..limit(width)')
if (
  insideHelperBoundCheck?.status !== 'pass'
  || outsideHelperBoundCheck?.status !== 'fail'
  || outsideHelperBoundCheck.reason?.includes('50 <= (width * 2)') !== true
) {
  console.error('expected pure unannotated helpers to work as dynamic range bounds')
  console.error(JSON.stringify(unannotatedHelperBoundChecks, null, 2))
  suite.fail()
} else {
  console.log('range contracts: unannotated helper bound')
}

const annotatedHelperBoundChecks = verifyFitSource('annotated-helper-range-bounds.ts', `/** @fit
 * return: 5 | 10..20
 */
function rawLimit(flag: boolean) {
  return flag ? 5 : 20
}

/** @fit
 * return: 5 | 10..20
 */
function limit(flag: boolean) {
  return rawLimit(flag)
}

/** @fit
 * return: 0..limit(flag)
 */
function inside(flag: boolean) {
  return flag ? 4 : 20
}

/** @fit
 * return: 0..limit(flag)
 */
function outside(flag: boolean) {
  return 21
}
`)
const insideAnnotatedHelperBoundCheck = annotatedHelperBoundChecks.find(check => check.functionName === 'inside' && check.text === 'return: 0..limit(flag)')
const outsideAnnotatedHelperBoundCheck = annotatedHelperBoundChecks.find(check => check.functionName === 'outside' && check.text === 'return: 0..limit(flag)')
if (
  insideAnnotatedHelperBoundCheck?.status !== 'unknown'
  || insideAnnotatedHelperBoundCheck.reason?.includes('came from separate branch constructs') !== true
  || outsideAnnotatedHelperBoundCheck?.status !== 'fail'
  || outsideAnnotatedHelperBoundCheck.reason?.includes('21 <= int 5..5') !== true
) {
  console.error('expected uncorrelated annotated helper bounds to stay unknown')
  console.error(JSON.stringify(annotatedHelperBoundChecks, null, 2))
  suite.fail()
} else {
  console.log('range contracts: annotated helper alternative bound')
}

const twoSidedHelperBoundChecks = verifyFitSource('two-sided-helper-range-bounds.ts', `/** @fit
 * return: 10 | 30
 */
function lower(flag: boolean) {
  return flag ? 10 : 30
}

/** @fit
 * return: 20 | 25
 */
function upper(flag: boolean) {
  return flag ? 20 : 25
}

/** @fit
 * return: lower(flag)..upper(flag)
 */
function insideLow(flag: boolean) {
  return 15
}

/** @fit
 * return: lower(flag)..upper(flag)
 */
function insideHigh(flag: boolean) {
  return 24
}

/** @fit
 * return: lower(flag)..upper(flag)
 */
function outsideLow(flag: boolean) {
  return 5
}

/** @fit
 * return: lower(flag)..upper(flag)
 */
function outsideHigh(flag: boolean) {
  return 26
}
`)
const insideLowTwoSidedBoundCheck = twoSidedHelperBoundChecks.find(check => check.functionName === 'insideLow' && check.text === 'return: lower(flag)..upper(flag)')
const insideHighTwoSidedBoundCheck = twoSidedHelperBoundChecks.find(check => check.functionName === 'insideHigh' && check.text === 'return: lower(flag)..upper(flag)')
const outsideLowTwoSidedBoundCheck = twoSidedHelperBoundChecks.find(check => check.functionName === 'outsideLow' && check.text === 'return: lower(flag)..upper(flag)')
const outsideHighTwoSidedBoundCheck = twoSidedHelperBoundChecks.find(check => check.functionName === 'outsideHigh' && check.text === 'return: lower(flag)..upper(flag)')
if (
  insideLowTwoSidedBoundCheck?.status !== 'unknown'
  || insideLowTwoSidedBoundCheck.reason?.includes('came from separate branch constructs') !== true
  || insideHighTwoSidedBoundCheck?.status !== 'unknown'
  || insideHighTwoSidedBoundCheck.reason?.includes('came from separate branch constructs') !== true
  || outsideLowTwoSidedBoundCheck?.status !== 'fail'
  || outsideHighTwoSidedBoundCheck?.status !== 'fail'
  || outsideLowTwoSidedBoundCheck.reason?.includes('5 >= int 10..10') !== true
  || outsideHighTwoSidedBoundCheck.reason?.includes('26 <= int 20..20') !== true
) {
  console.error('expected separate two-sided helper bounds to preserve definite failures and leave mixed cases unknown')
  console.error(JSON.stringify(twoSidedHelperBoundChecks, null, 2))
  suite.fail()
} else {
  console.log('range contracts: separate two-sided helper bounds')
}

const separateDynamicBoundChecks = verifyFitSource('separate-dynamic-range-bounds.ts', `function limit(n: number) {
  return n > 4 ? 5 : 20
}

/** @fit
 * given n: int 0..10
 * return: 0..limit(n)
 */
function inside(n: number) {
  return n > 4 ? 4 : 20
}

/** @fit
 * given n: int 0..10
 * return: 0..limit(n)
 */
function outside(n: number) {
  return 10
}
`)
const separateInside = separateDynamicBoundChecks.find(check =>
  check.functionName === 'inside' && check.text === 'return: 0..limit(n)')
const separateOutside = separateDynamicBoundChecks.find(check =>
  check.functionName === 'outside' && check.text === 'return: 0..limit(n)')
if (
  separateInside?.status !== 'unknown'
  || separateInside.reason?.includes('came from separate branch constructs') !== true
  || separateOutside?.status !== 'fail'
) {
  console.error('expected separate returned values and helper bounds not to reconnect')
  console.error(JSON.stringify(separateDynamicBoundChecks, null, 2))
  suite.fail()
} else {
  console.log('range contracts: separate returned values and helper bounds')
}

const dynamicRangeBudgetChecks = verifyFitSource('dynamic-range-budget.ts', `/** @fit
 * return: 0 | 1 | 2
 */
function lower(choice: number) {
  return choice === 0 ? 0 : choice === 1 ? 1 : 2
}

/** @fit
 * return: 10 | 11 | 12
 */
function upper(choice: number) {
  return choice === 0 ? 10 : choice === 1 ? 11 : 12
}

/** @fit
 * return: lower(a)..upper(b)
 */
function alwaysInside(a: number, b: number) {
  return 5
}

/** @fit
 * return: lower(a)..upper(b)
 */
function alwaysOutside(a: number, b: number) {
  return -1
}

/** @fit
 * return: lower(a)..upper(b)
 */
function mixed(a: number, b: number) {
  return 1
}
`)
const budgetInside = dynamicRangeBudgetChecks.find(check =>
  check.functionName === 'alwaysInside' && check.text === 'return: lower(a)..upper(b)')
const budgetOutside = dynamicRangeBudgetChecks.find(check =>
  check.functionName === 'alwaysOutside' && check.text === 'return: lower(a)..upper(b)')
const budgetMixed = dynamicRangeBudgetChecks.find(check =>
  check.functionName === 'mixed' && check.text === 'return: lower(a)..upper(b)')
if (
  budgetInside?.status !== 'pass'
  || budgetOutside?.status !== 'fail'
  || budgetMixed?.status !== 'unknown'
  || budgetMixed.reason?.includes('Numeric alternative budget exceeded') !== true
) {
  console.error('expected broad dynamic bounds to decide obvious over-budget cases')
  console.error(JSON.stringify(dynamicRangeBudgetChecks, null, 2))
  suite.fail()
} else {
  console.log('range contracts: over-budget dynamic bounds')
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
  || unsupportedRangeExpressionCheck.reason.includes('helper bump is not pure: writes outside state `box`') !== true
) {
  console.error('expected unsupported range expressions to reject the same way as comparisons')
  console.error(JSON.stringify(unsupportedRangeExpressionChecks, null, 2))
  suite.fail()
} else {
  console.log('range contracts: unsupported expression rejected')
}

})
