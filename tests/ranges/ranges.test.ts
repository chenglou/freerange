import {describe, setDefaultTimeout, test} from 'bun:test'
import {verifyFitSource} from '../../src/reports.ts'
import {requiredCheck, testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

describe('ranges', () => {
test('checks dynamic summaries and numeric alternatives', () => {
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
const dynamicSummaryCheck = requiredCheck(dynamicRangeContractChecks, {functionName: 'usesDynamicSummary', text: 'return: 10..20'})
const intDynamicSummaryCheck = requiredCheck(dynamicRangeContractChecks, {functionName: 'usesIntDynamicSummary', text: 'return: int 10..20'})
const dynamicAlternativeCheck = requiredCheck(dynamicRangeContractChecks, {functionName: 'picksAlternative', text: 'return: low() | high()'})
const missedAlternativeCheck = requiredCheck(dynamicRangeContractChecks, {functionName: 'missesAlternative', text: 'return: low() | high()'})
const dynamicRangeAlternativeCheck = requiredCheck(dynamicRangeContractChecks, {functionName: 'picksRangeAlternative', text: 'return: 0..10 | 20..30'})
const missedRangeAlternativeCheck = requiredCheck(dynamicRangeContractChecks, {functionName: 'missesRangeAlternative', text: 'return: 0..10 | 20..30'})
if (
  dynamicSummaryCheck.status !== 'pass'
  || intDynamicSummaryCheck.status !== 'pass'
  || dynamicAlternativeCheck.status !== 'pass'
  || missedAlternativeCheck.status !== 'fail'
  || dynamicRangeAlternativeCheck.status !== 'pass'
  || missedRangeAlternativeCheck.status !== 'fail'
) {
  throw testDiagnosticError('expected dynamic range summaries and numeric alternatives to be checked', dynamicRangeContractChecks)
}
})

test('propagates numeric range unions and rejects gaps', () => {
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
const broadCallerCheck = requiredCheck(numericUnionPropagationChecks, {functionName: 'broadCaller', text: 'return: 5 | 20'})
const shiftedCallerCheck = requiredCheck(numericUnionPropagationChecks, {functionName: 'shiftedCaller', text: 'return: 6 | 21'})
const gapCallerCheck = requiredCheck(numericUnionPropagationChecks, {functionName: 'gapCaller', text: 'return: 7..20'})
const redundantAlternativeCallerCheck = requiredCheck(numericUnionPropagationChecks, {functionName: 'redundantAlternativeCaller', text: 'return: 20..30'})
if (
  broadCallerCheck.status !== 'pass'
  || broadCallerCheck.trace?.usedFacts.includes('5 | 20') !== true
  || shiftedCallerCheck.status !== 'pass'
  || shiftedCallerCheck.trace?.usedFacts.includes('6 | 21') !== true
  || gapCallerCheck.status !== 'fail'
  || gapCallerCheck.reason?.includes('int 6..6') !== true
  || redundantAlternativeCallerCheck.status !== 'fail'
) {
  throw testDiagnosticError('expected pure numeric range unions to propagate, normalize, and reject gaps', numericUnionPropagationChecks)
}
})

test('uses pure unannotated helpers as dynamic bounds', () => {
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
const insideHelperBoundCheck = requiredCheck(unannotatedHelperBoundChecks, {functionName: 'inside', text: 'return: 0..limit(width)'})
const outsideHelperBoundCheck = requiredCheck(unannotatedHelperBoundChecks, {functionName: 'outside', text: 'return: 0..limit(width)'})
if (
  insideHelperBoundCheck.status !== 'pass'
  || outsideHelperBoundCheck.status !== 'fail'
  || outsideHelperBoundCheck.reason?.includes('50 <= (width * 2)') !== true
) {
  throw testDiagnosticError('expected pure unannotated helpers to work as dynamic range bounds', unannotatedHelperBoundChecks)
}
})

test('keeps uncorrelated annotated helper bounds unknown', () => {
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
const insideAnnotatedHelperBoundCheck = requiredCheck(annotatedHelperBoundChecks, {functionName: 'inside', text: 'return: 0..limit(flag)'})
const outsideAnnotatedHelperBoundCheck = requiredCheck(annotatedHelperBoundChecks, {functionName: 'outside', text: 'return: 0..limit(flag)'})
if (
  insideAnnotatedHelperBoundCheck.status !== 'unknown'
  || insideAnnotatedHelperBoundCheck.reason?.includes('came from separate branch constructs') !== true
  || outsideAnnotatedHelperBoundCheck.status !== 'fail'
  || outsideAnnotatedHelperBoundCheck.reason?.includes('21 <= int 5..5') !== true
) {
  throw testDiagnosticError('expected uncorrelated annotated helper bounds to stay unknown', annotatedHelperBoundChecks)
}
})

test('preserves definite failures for two-sided helper bounds', () => {
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
const insideLowTwoSidedBoundCheck = requiredCheck(twoSidedHelperBoundChecks, {functionName: 'insideLow', text: 'return: lower(flag)..upper(flag)'})
const insideHighTwoSidedBoundCheck = requiredCheck(twoSidedHelperBoundChecks, {functionName: 'insideHigh', text: 'return: lower(flag)..upper(flag)'})
const outsideLowTwoSidedBoundCheck = requiredCheck(twoSidedHelperBoundChecks, {functionName: 'outsideLow', text: 'return: lower(flag)..upper(flag)'})
const outsideHighTwoSidedBoundCheck = requiredCheck(twoSidedHelperBoundChecks, {functionName: 'outsideHigh', text: 'return: lower(flag)..upper(flag)'})
if (
  insideLowTwoSidedBoundCheck.status !== 'unknown'
  || insideLowTwoSidedBoundCheck.reason?.includes('came from separate branch constructs') !== true
  || insideHighTwoSidedBoundCheck.status !== 'unknown'
  || insideHighTwoSidedBoundCheck.reason?.includes('came from separate branch constructs') !== true
  || outsideLowTwoSidedBoundCheck.status !== 'fail'
  || outsideHighTwoSidedBoundCheck.status !== 'fail'
  || outsideLowTwoSidedBoundCheck.reason?.includes('5 >= int 10..10') !== true
  || outsideHighTwoSidedBoundCheck.reason?.includes('26 <= int 20..20') !== true
) {
  throw testDiagnosticError('expected separate two-sided helper bounds to preserve definite failures and leave mixed cases unknown', twoSidedHelperBoundChecks)
}
})

test('does not reconnect separately evaluated values and bounds', () => {
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
const separateInside = requiredCheck(separateDynamicBoundChecks, {functionName: 'inside', text: 'return: 0..limit(n)'})
const separateOutside = requiredCheck(separateDynamicBoundChecks, {functionName: 'outside', text: 'return: 0..limit(n)'})
if (
  separateInside.status !== 'unknown'
  || separateInside.reason?.includes('came from separate branch constructs') !== true
  || separateOutside.status !== 'fail'
) {
  throw testDiagnosticError('expected separate returned values and helper bounds not to reconnect', separateDynamicBoundChecks)
}
})

test('decides obvious cases beyond the dynamic alternative budget', () => {
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
const budgetInside = requiredCheck(dynamicRangeBudgetChecks, {functionName: 'alwaysInside', text: 'return: lower(a)..upper(b)'})
const budgetOutside = requiredCheck(dynamicRangeBudgetChecks, {functionName: 'alwaysOutside', text: 'return: lower(a)..upper(b)'})
const budgetMixed = requiredCheck(dynamicRangeBudgetChecks, {functionName: 'mixed', text: 'return: lower(a)..upper(b)'})
if (
  budgetInside.status !== 'pass'
  || budgetOutside.status !== 'fail'
  || budgetMixed.status !== 'unknown'
  || budgetMixed.reason?.includes('Numeric alternative budget exceeded') !== true
) {
  throw testDiagnosticError('expected broad dynamic bounds to decide obvious over-budget cases', dynamicRangeBudgetChecks)
}
})

test('rejects impure range expressions like comparisons', () => {
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
const unsupportedRangeExpressionCheck = requiredCheck(unsupportedRangeExpressionChecks, {functionName: 'bad', text: 'return: bump() | 2'})
if (
  unsupportedRangeExpressionCheck.status !== 'unknown'
  || unsupportedRangeExpressionCheck.reason?.includes('Unsupported @fit contract expression: bump()') !== true
  || unsupportedRangeExpressionCheck.reason.includes('helper bump is not pure: writes outside state `box`') !== true
) {
  throw testDiagnosticError('expected unsupported range expressions to reject the same way as comparisons', unsupportedRangeExpressionChecks)
}
})

test('keeps the broad range when exact numeric alternatives overflow', () => {
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
const broadNumericAlternatives = requiredCheck(numericAlternativeBudgetChecks, {functionName: 'broad', text: 'return: 0..8'})
const exactNumericAlternatives = requiredCheck(numericAlternativeBudgetChecks, {functionName: 'exact', text: 'return: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8'})
if (
  broadNumericAlternatives.status !== 'pass'
  || exactNumericAlternatives.status !== 'unknown'
  || exactNumericAlternatives.reason?.includes('Numeric alternative budget exceeded') !== true
) {
  throw testDiagnosticError('expected numeric alternative overflow to keep its range and report lost exact choices', numericAlternativeBudgetChecks)
}
})

})
