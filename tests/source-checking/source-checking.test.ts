import {describe, setDefaultTimeout, test} from 'bun:test'
import {inferFitFiles, readTopLevelGlobal} from '../../src/check-core.ts'
import {isFunctionImplementation} from '../../src/function-shape.ts'
import {buildFitSourceFile, TypeScriptUserlandError} from '../../src/modules.ts'
import {preparedProgramContracts} from '../../src/prepared-contracts.ts'
import {verifyFitSource} from '../../src/reports.ts'
import {requiredCheck, testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

describe('source checking', () => {
test('indexes every supported callable implementation', () => {
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
  throw testDiagnosticError('expected every supported function implementation to share one indexed declaration family', callableFamilyNames)
}
})

test('rejects recursive numeric input defaults without rejecting nonnumeric recursion', () => {
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
  throw testDiagnosticError('expected recursive numeric input types to be rejected instead of silently dropping finite leaves', recursiveFiniteDefaultChecks)
}
})

test('checks contract paths against real TypeScript shapes', () => {
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
const optionalGivenFieldCheck = requiredCheck(shortcutCleanupChecks, {functionName: 'optionalGivenField', text: 'given input.width: 0..10'})
const optionalGivenReturnCheckExists = shortcutCleanupChecks.some(check =>
  check.functionName === 'optionalGivenField' && check.text === 'return: 0..10')
const missingGivenFieldCheck = requiredCheck(shortcutCleanupChecks, {functionName: 'missingGivenField', text: 'given input.width: 0..10'})
const stringGivenFieldCheck = requiredCheck(shortcutCleanupChecks, {functionName: 'stringGivenField', text: 'given input.width: 0..10'})
const nonArrayGivenPathCheck = requiredCheck(shortcutCleanupChecks, {functionName: 'nonArrayGivenPath', text: 'given rows[].height: 0..10'})
const unknownParamGivenCheck = requiredCheck(shortcutCleanupChecks, {functionName: 'unknownParamGiven', text: 'given input: 0..10'})
const typedCallbackItemFailures = shortcutCleanupChecks.filter(check => check.functionName === 'typedCallbackItem' && check.status !== 'pass')
const missingCallbackItemFieldCheck = requiredCheck(shortcutCleanupChecks, {functionName: 'missingCallbackItemField', text: 'given items[].width: 0..10'})
if (
  typedGivenPathFailures.length > 0
  || typedAliasPathFailures.length > 0
  || optionalGivenFieldCheck.status !== 'unknown'
  || optionalGivenFieldCheck.reason?.includes("TS2322: Type 'number | undefined' is not assignable to type 'number'") !== true
  || optionalGivenReturnCheckExists
  || missingGivenFieldCheck.status !== 'unknown'
  || missingGivenFieldCheck.reason?.includes("TS2339: Property 'width' does not exist on type '{}'") !== true
  || stringGivenFieldCheck.status !== 'unknown'
  || stringGivenFieldCheck.reason?.includes("TS2322: Type 'string' is not assignable to type 'number'") !== true
  || nonArrayGivenPathCheck.status !== 'unknown'
  || nonArrayGivenPathCheck.reason?.includes("TS7053: Element implicitly has an 'any' type") !== true
  || unknownParamGivenCheck.status !== 'unknown'
  || unknownParamGivenCheck.reason?.includes("TS2322: Type 'unknown' is not assignable to type 'number'") !== true
  || typedCallbackItemFailures.length > 0
  || missingCallbackItemFieldCheck.status !== 'unknown'
  || missingCallbackItemFieldCheck.reason?.includes("TS2339: Property 'width' does not exist on type '{}'") !== true
) {
  throw testDiagnosticError('expected @fit paths and callback item facts to come from TypeScript or real source values, not invented shape', shortcutCleanupChecks)
}
})

test('type-checks every contract surface before proving', () => {
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
  const check = requiredCheck(contractTypeLayerChecks, {functionName, text})
  return check.status !== 'unknown'
    || check.reason?.includes(reason) !== true
    || check.reason.includes('contract-type-layer.ts(') !== true
    || check.reason.includes(': error TS') !== true
    || check.line == null
})
if (missingTypeLayerErrors.length > 0) {
  throw testDiagnosticError('expected every contract surface to be TypeScript-checked before proving', {missingTypeLayerErrors, contractTypeLayerChecks})
}
})

test('allows inline equality for non-number values', () => {
const inlineNonNumberEqualityChecks = verifyFitSource('inline-non-number-equality.ts', `function keepLines(lines: string[]) {
  return {
    lines,
    copy: lines, // @fit == lines
  }
}
`)
const inlineNonNumberEqualityFailures = inlineNonNumberEqualityChecks.filter(check => check.status !== 'pass')
if (inlineNonNumberEqualityFailures.length > 0) {
  throw testDiagnosticError('expected inline equality to allow non-number values', inlineNonNumberEqualityChecks)
}
})

test('prepares contracts once by exact contract identity', () => {
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
  throw testDiagnosticError('expected contracts to be prepared once and rejected by exact contract identity', {
    assumptions: preparedBounded.assumptions.map(spec => spec.text),
    proofs: preparedBounded.proofs.map(spec => spec.text),
    typeChecks: preparedBounded.typeChecks,
    preparedPropertyTemplateCounts,
  })
}
})

test('uses the prepared body index for top-level contracts', () => {
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
const topPropertyPass = requiredCheck(topLevelContractChecks, {functionName: '<top-level>', text: 'layout.width: 0..10'})
const topPropertyTypeError = requiredCheck(topLevelContractChecks, {functionName: '<top-level>', text: '@fit 0..10', line: 3})
const topLoopPass = requiredCheck(topLevelContractChecks, {functionName: '<top-level> > loop', text: 'total: 0..10'})
const topNestedPlacement = requiredCheck(topLevelContractChecks, {functionName: '<top-level>', text: '@fit 0..10', line: 15})
if (
  topPropertyPass.status !== 'pass'
  || topPropertyTypeError.status !== 'unknown'
  || topPropertyTypeError.reason?.includes("Type 'string' is not assignable to type 'number'") !== true
  || topLoopPass.status !== 'pass'
  || topNestedPlacement.status !== 'unknown'
  || topNestedPlacement.reason?.includes('nested function') !== true
) {
  throw testDiagnosticError('expected top-level properties, loops, and nested placements to use the prepared body index', topLevelContractChecks)
}
})

test('checks bare pure boolean call contracts', () => {
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
const validLayoutCheck = requiredCheck(booleanCallContractChecks, {functionName: 'validLayout', text: 'isValidLayout(return)'})
const invalidLayoutCheck = requiredCheck(booleanCallContractChecks, {functionName: 'invalidLayout', text: 'isValidLayout(return)'})
const unknownLayoutCheck = requiredCheck(booleanCallContractChecks, {functionName: 'unknownLayout', text: 'isValidLayout(return)'})
const unsupportedLayoutCheck = requiredCheck(booleanCallContractChecks, {functionName: 'unsupportedLayout', text: 'randomLayoutCheck(return)'})
const numericExpressionCheck = requiredCheck(booleanCallContractChecks, {functionName: 'numericExpression', text: '1 + 2'})
if (
  validLayoutCheck.status !== 'pass'
  || invalidLayoutCheck.status !== 'fail'
  || unknownLayoutCheck.status !== 'unknown'
  || unsupportedLayoutCheck.status !== 'unknown'
  || unsupportedLayoutCheck.reason?.includes('helper randomLayoutCheck is not pure: observes the environment') !== true
  || numericExpressionCheck.status !== 'unknown'
  || numericExpressionCheck.reason?.includes("TS2322: Type 'number' is not assignable to type 'boolean'") !== true
) {
  throw testDiagnosticError('expected bare pure boolean call contracts to be checked', booleanCallContractChecks)
}
})

test('keeps unsupported named indexes out of prepared requirements and summaries', () => {
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
  throw testDiagnosticError('expected unsupported named indexes to stay out of call requirements and helper summaries', {
    contractSpecs: preparedUnsupportedNamedIndexes.contractSpecs.map(spec => spec.text),
    assumptions: preparedUnsupportedNamedIndexes.assumptions.map(spec => spec.text),
    proofs: preparedUnsupportedNamedIndexes.proofs.map(spec => spec.text),
    unsupported: preparedUnsupportedNamedIndexes.unsupportedSpecs,
  })
}
})

test('reports the unsupported step in contract expressions', () => {
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
const randomContractCheck = requiredCheck(unsupportedContractExpressionChecks, {functionName: 'bad', text: 'return <= randomLimit()'})
const dynamicContractCheck = requiredCheck(unsupportedContractExpressionChecks, {functionName: 'bad', text: 'return <= Math[method](1, 2)'})
if (
  randomContractCheck.status !== 'unknown'
  || randomContractCheck.reason?.includes('helper randomLimit is not pure: observes the environment') !== true
  || dynamicContractCheck.status !== 'unknown'
  || dynamicContractCheck.reason?.includes('Unsupported call Math[method]') !== true
) {
  throw testDiagnosticError('expected unsupported contract expressions to explain the unsupported step', unsupportedContractExpressionChecks)
}
})

test('rejects mutable helper aliases in contracts', () => {
const mutableAliasContractChecks = verifyFitSource('contract-mutable-alias.ts', `let max = Math.max

/** @fit
 * return <= max(1, 2)
 */
function bad() {
  return 0
}
`)
const mutableAliasContractCheck = requiredCheck(mutableAliasContractChecks, {functionName: 'bad', text: 'return <= max(1, 2)'})
if (
  mutableAliasContractCheck.status !== 'unknown'
  || mutableAliasContractCheck.reason?.includes('max is a mutable helper alias') !== true
) {
  throw testDiagnosticError('expected mutable helper aliases in contracts to be rejected loudly', mutableAliasContractChecks)
}
})

test('rejects unsupported given helper expressions', () => {
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
const impureGivenCheck = requiredCheck(unsupportedGivenExpressionChecks, {functionName: 'impure', text: 'given max >= bump(min)'})
const noInputGivenCheck = requiredCheck(unsupportedGivenExpressionChecks, {functionName: 'noInput', text: 'given double(10) > 0'})
const derivedRangeTargetCheck = requiredCheck(unsupportedGivenExpressionChecks, {functionName: 'derivedRangeTarget', text: 'given double(value): 0..10'})
const impureBooleanGivenCheck = requiredCheck(unsupportedGivenExpressionChecks, {functionName: 'impureBoolean', text: 'given bump(value)'})
const noInputBooleanGivenCheck = requiredCheck(unsupportedGivenExpressionChecks, {functionName: 'noInputBoolean', text: 'given true'})
if (
  impureGivenCheck.status !== 'unknown'
  || impureGivenCheck.reason?.includes('Unsupported @fit contract expression: bump(min)') !== true
  || impureGivenCheck.reason.includes('helper bump is not pure: writes outside state `box`') !== true
  || noInputGivenCheck.status !== 'unknown'
  || noInputGivenCheck.reason !== 'given must mention an input'
  || derivedRangeTargetCheck.status !== 'unknown'
  || derivedRangeTargetCheck.reason !== 'given range must name one input path, not a derived expression'
  || impureBooleanGivenCheck.status !== 'unknown'
  || impureBooleanGivenCheck.reason?.includes("TS2322: Type 'number' is not assignable to type 'boolean'") !== true
  || noInputBooleanGivenCheck.status !== 'unknown'
  || noInputBooleanGivenCheck.reason !== 'given must mention an input'
) {
  throw testDiagnosticError('expected given helper expressions to reject impure, input-independent, and derived range target cases', unsupportedGivenExpressionChecks)
}
})

test('stops contract proofs on call spreads without exact tuples', () => {
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
const unsupportedSpreadContractCheck = requiredCheck(unsupportedSpreadContractChecks, {
  functionName: 'emptySpreadCannotProveNumber',
  text: 'typeof first(...items) === "number"',
})
if (
  unsupportedSpreadContractCheck.status !== 'unknown'
  || unsupportedSpreadContractCheck.reason?.includes('Call spread needs an exact tuple') !== true
) {
  throw testDiagnosticError('expected every interpreter rejection in a contract expression to stop the proof', unsupportedSpreadContractChecks)
}
})

test('preserves structured path and binding scope semantics', () => {
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
const boundedLengthCheck = requiredCheck(structuredPathRegressionChecks, {functionName: 'boundedLength', text: 'return: int 0..2'})
const numericObjectPropertyCheck = requiredCheck(structuredPathRegressionChecks, {functionName: 'numericObjectProperty', text: 'return: 0..10'})
const decimalObjectPropertyCheck = requiredCheck(structuredPathRegressionChecks, {functionName: 'decimalObjectProperty', text: 'return: 0..10'})
const negativeObjectPropertyCheck = requiredCheck(structuredPathRegressionChecks, {functionName: 'negativeObjectProperty', text: 'return: 0..10'})
const functionScopedVarCheck = requiredCheck(structuredPathRegressionChecks, {functionName: 'functionScopedVar', text: 'return == 5'})
const uninitializedFunctionScopedVarCheck = requiredCheck(structuredPathRegressionChecks, {functionName: 'uninitializedFunctionScopedVar', text: 'return == 5'})
const structurallyEqualBooleanGivenCheck = requiredCheck(structuredPathRegressionChecks, {
  functionName: 'structurallyEqualBooleanGiven',
  text: 'typeof (value) === "number"',
})
const reservedReturnBindingChecks = structuredPathRegressionChecks.filter(check =>
  check.functionName === 'reservedReturnBinding')
if (
  boundedLengthCheck.status !== 'pass'
  || numericObjectPropertyCheck.status !== 'pass'
  || decimalObjectPropertyCheck.status !== 'pass'
  || negativeObjectPropertyCheck.status !== 'pass'
  || functionScopedVarCheck.status !== 'fail'
  || uninitializedFunctionScopedVarCheck.status !== 'pass'
  || structurallyEqualBooleanGivenCheck.status !== 'pass'
  || reservedReturnBindingChecks.length !== 1
  || reservedReturnBindingChecks[0]?.status !== 'unknown'
  || reservedReturnBindingChecks[0].reason?.includes('is reserved for Freerange contract evaluation') !== true
) {
  throw testDiagnosticError('expected structured paths and binding scopes to preserve their semantic guarantees', structuredPathRegressionChecks)
}
})

test('includes TypeScript suggestions for unambiguous given typos', () => {
const suggestedGivenRootChecks = verifyFitSource('given-typo.ts', `const boxesGapX = 24

/** @fit
 * given containerSizX >= 2 * boxesGapX
 */
function layout(containerSizeX: number) {
  return containerSizeX
}
`)
const suggestedGivenRootReason = requiredCheck(suggestedGivenRootChecks, {
  functionName: 'layout',
  text: 'given containerSizX >= 2 * boxesGapX',
}).reason
if (
  suggestedGivenRootReason?.includes("TS2552: Cannot find name 'containerSizX'") !== true
  || suggestedGivenRootReason.includes("Did you mean 'containerSizeX'?") !== true
) {
  throw testDiagnosticError('expected given typo suggestion', suggestedGivenRootReason ?? '<missing>')
}
})

test('uses TypeScript diagnostics for ambiguous given typos', () => {
const ambiguousGivenRootChecks = verifyFitSource('given-typo.ts', `const boxesGapX = 24
const boxesGapY = 24

/** @fit
 * given containerSizeX >= 2 * boxesGap
 */
function layout(containerSizeX: number) {
  return containerSizeX
}
`)
const ambiguousGivenRootReason = requiredCheck(ambiguousGivenRootChecks, {
  functionName: 'layout',
  text: 'given containerSizeX >= 2 * boxesGap',
}).reason
if (ambiguousGivenRootReason?.includes("TS2552: Cannot find name 'boxesGap'") !== true) {
  throw testDiagnosticError('expected ambiguous given typo to use TypeScript diagnostics', ambiguousGivenRootReason ?? '<missing>')
}
})

test('rejects duplicate function implementations during TypeScript preflight', () => {
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
  throw testDiagnosticError('expected duplicate function names to be rejected by TypeScript preflight', duplicateFunctionError?.message ?? '<no error>')
}
})

test('preflights the current source text on every repeated build', () => {
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
  throw testDiagnosticError('expected standalone source preflight to use the current source text on every build', repeatedSourceError?.message ?? '<no error>')
}
})

test('preserves complete default library conflict diagnostics', () => {
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
  throw testDiagnosticError('expected standalone source preflight failures to keep complete TypeScript diagnostics', defaultLibraryConflictError?.message ?? '<no error>')
}
})

test('preserves unsupported source extension diagnostics', () => {
const repoDir = new URL('../..', import.meta.url).pathname
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
  throw testDiagnosticError('expected unsupported standalone source extensions to keep TypeScript diagnostics', unsupportedSourceExtensionError?.message ?? '<no error>')
}
})

test('preserves ordered diagnostics across an imported temporary project', async () => {
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
    throw testDiagnosticError('expected standalone source preflight to preserve ordered multi-file diagnostics', importedPreflightError?.message ?? '<no error>')
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
    throw testDiagnosticError('expected standalone source preflight to preserve imported syntax diagnostics', importedSyntaxError?.message ?? '<no error>')
  }
} finally {
  Bun.spawnSync({cmd: ['rm', '-rf', importedPreflightDir]})
}
})

test('stops before unsupported branch bodies', () => {
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
const unsupportedBranchConditionCheck = requiredCheck(unsupportedBranchConditionChecks, {functionName: 'sample', text: 'return: 1'})
if (
  unsupportedBranchConditionCheck.status !== 'unknown'
  || unsupportedBranchConditionCheck.reason !== 'Unsupported branch condition: externalPredicate()'
) {
  throw testDiagnosticError('expected unsupported branch conditions to stop before speculating through branch bodies', unsupportedBranchConditionChecks)
}
})

test('forgets every reachable alias after possible mutation', () => {
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
const readOnlyAlias = requiredCheck(aliasClaims, {functionName: 'readOnlyElementAliasesKeepFacts', text: 'return == 1'})
const staleMutationProofs = aliasClaims.filter(check =>
  check.functionName !== 'readOnlyElementAliasesKeepFacts'
  && check.status === 'pass'
)
const conditionalAlias = requiredCheck(referenceAliasChecks, {functionName: 'conditionalAliasDoesNotNarrow', text: 'return == 999'})
if (
  staleMutationProofs.length > 0
  || aliasClaims.length !== 6
  || readOnlyAlias.status !== 'pass'
  || conditionalAlias.status === 'pass'
) {
  throw testDiagnosticError('expected definite, conditional, and unavailable-call mutations to forget every reachable alias without narrowing branches', referenceAliasChecks)
}
})

test('rejects invalid pure and nested class-member placements', () => {
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
const purePlacement = requiredCheck(purePlacementChecks, {functionName: 'misplacedPure', text: 'pure'})
const nestedClassPlacements = purePlacementChecks.filter(check => check.functionName === 'nestedClassMemberContracts')
const nestedPlacementReason = 'Unsupported @fit placement: contracts inside a nested function are not checked; move the contract onto the enclosing statement or a named function'
if (
  purePlacement.status !== 'unknown'
  || purePlacement.reason !== 'Unsupported @fit placement: `pure` can only appear in a function-level @fit block'
  || nestedClassPlacements.length !== 2
  || nestedClassPlacements.some(check => check.status !== 'unknown' || check.reason !== nestedPlacementReason)
) {
  throw testDiagnosticError('expected invalid loop and nested class-member placements to be rejected during placement classification', purePlacementChecks)
}
})

test('infers typed object parameter array shape facts', () => {
const inferReport = inferFitFiles(['tests/source-checking/patterns.ts'], {functionName: 'typedObjectParamArrayShape'})
const inferFacts = new Set(inferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedInferFacts = [
  'return.rows.length == params.items.length',
  'return.rows.length: int 0..4294967295',
  'return.rows[].height == params.items[].height',
  'return.rows follows params.items by index',
]
const missingInferFacts = expectedInferFacts.filter(fact => !inferFacts.has(fact))
if (missingInferFacts.length > 0) {
  throw testDiagnosticError('expected inferred facts changed', missingInferFacts.map(fact => `missing: ${fact}`).join('\n'))
}
})

test('infers filtered row subset lineage', () => {
const filterInferReport = inferFitFiles(['tests/source-checking/patterns.ts'], {functionName: 'filteredRowsKeepElementDomain'})
const filterInferFacts = new Set(filterInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedFilterInferFacts = [
  'return.rows is an order-preserving subset of items',
]
const missingFilterInferFacts = expectedFilterInferFacts.filter(fact => !filterInferFacts.has(fact))
if (missingFilterInferFacts.length > 0) {
  throw testDiagnosticError('expected filter inferred facts changed', missingFilterInferFacts.map(fact => `missing: ${fact}`).join('\n'))
}
})

test('infers filtered mapped row base lineage', () => {
const filterMapInferReport = inferFitFiles(['tests/source-checking/patterns.ts'], {functionName: 'filteredMappedRowsKeepBaseLineage'})
const filterMapInferFacts = new Set(filterMapInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedFilterMapInferFacts = [
  'return.rows is an order-preserving subset of items',
]
const missingFilterMapInferFacts = expectedFilterMapInferFacts.filter(fact => !filterMapInferFacts.has(fact))
if (missingFilterMapInferFacts.length > 0) {
  throw testDiagnosticError('expected filter-map inferred facts changed', missingFilterMapInferFacts.map(fact => `missing: ${fact}`).join('\n'))
}
})

test('keeps fixed tuple length inference readable', () => {
const tupleInferReport = inferFitFiles(['tests/source-checking/patterns.ts'], {functionName: 'scalarStringishMutationPreservesTupleFacts'})
const tupleFacts = new Set(tupleInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
if (!tupleFacts.has('return.length == 2')) {
  throw testDiagnosticError('expected fixed tuple length inference to stay readable', tupleFacts)
}
})

test('preserves inferred call-site text', () => {
const callSiteTextReport = inferFitFiles(['tests/source-checking/patterns.ts'], {functionName: 'userlandClampThroughArithmeticAlias'})
const callSiteTextFacts = new Set(callSiteTextReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedCallSiteTextFacts = [
  'return == max(0, min(value, (position.cols - w)))',
]
const missingCallSiteTextFacts = expectedCallSiteTextFacts.filter(fact => !callSiteTextFacts.has(fact))
if (missingCallSiteTextFacts.length > 0) {
  throw testDiagnosticError('expected call-site inferred text changed', missingCallSiteTextFacts.map(fact => `missing: ${fact}`).join('\n'))
}
})

})
