import {describe, setDefaultTimeout, test} from 'bun:test'
import {createFunctionContractCache, readTopLevelGlobal, verifyFitProgramWithCallsites} from '../../src/check-core.ts'
import {callSiteText} from '../../src/call-site-text.ts'
import {evaluateInterpreterFunction} from '../../src/interpreter/evaluate.ts'
import {buildFitSourceFile} from '../../src/modules.ts'
import {verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {
  importedArgumentRunsOnce,
  importedDefaultRunsOnce,
  importedDestructuredDefaultUsesFinalBinding,
} from './imported-caller.ts'
import {requiredCheck, testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

function verifyFitSourceWithCallsites(file: string, sourceText: string) {
  const program = buildFitSourceFile(file, sourceText, readTopLevelGlobal)
  return verifyFitProgramWithCallsites(program, createFunctionContractCache())
}

describe('calls', () => {
test('reports every call requirement outcome with its reason', async () => {
const report = await verifyFitFiles(['tests/calls/call-requirement-outcomes.ts'])
const expected = [
  {functionName: 'passes', text: 'accepts(5): requires value: 0..10', status: 'pass', reason: undefined},
  {functionName: 'failsWithRange', text: 'accepts(value): requires value: 0..10', status: 'fail', reason: 'caller passed: value: 20..30\nmissing: value <= 10'},
  {functionName: 'requiresMixedRange', text: 'accepts(flag ? 5 : 20): requires value: 0..10', status: 'requires', reason: 'caller passed: value: 5 | 20\nmissing: (flag ? 5 : 20) <= 10'},
  {functionName: 'requiresOverlappingRange', text: 'accepts(value): requires value: 0..10', status: 'requires', reason: 'caller passed: value: 5..15\nmissing: value <= 10'},
  {functionName: 'passesWithComparison', text: 'acceptsOrder(0, 1): requires left <= right', status: 'pass', reason: undefined},
  {functionName: 'failsWithComparison', text: 'acceptsOrder(left, right): requires left <= right', status: 'fail', reason: 'caller passed: left: 20..30, right: 0..10\nmissing: left <= right'},
  {functionName: 'requiresMixedComparison', text: 'acceptsOrder(flag ? 5 : 20, 10): requires left <= right', status: 'requires', reason: 'caller passed: left: 5 | 20, right: 10\nmissing: (flag ? 5 : 20) <= 10'},
  {functionName: 'requiresOverlappingComparison', text: 'acceptsOrder(value, 10): requires left <= right', status: 'requires', reason: 'caller passed: left: 5..15, right: 10\nmissing: value <= 10'},
  {functionName: 'requires', text: 'accepts(value): requires value: 0..10', status: 'requires', reason: 'caller passed: value: any number\nmissing: value: 0..10'},
  {
    functionName: 'unknown',
    text: 'accepts(getValue()): requires value: 0..10',
    status: 'unknown',
    reason: 'caller passed: value: unknown (Unsupported function value getValue)\nmissing: (getValue()): 0..10',
  },
] as const
const actual = expected.map(({functionName, text}) => requiredCheck(report.checks, {functionName, text}))
if (actual.some((check, index) => {
  const wanted = expected[index]!
  return check.status !== wanted.status || check.reason !== wanted.reason
}) || JSON.stringify(report.summary) !== JSON.stringify({pass: 4, fail: 2, requires: 5, unknown: 1, audit: 0})) {
  throw testDiagnosticError('expected the public report to preserve each call status and reason', {actual, summary: report.summary})
}
})

test('prepares source call operands and parameters once', () => {
const sourceCallChecks = verifyFitSource('source-call-evaluation.ts', `
function id(value: number) {
  return value
}

function pair(left: number, right: number) {
  return left * 10 + right
}

function choose(left: number, right: number | undefined = left++) {
  return left
}

function readBox(box: {value: number}, ignored: number) {
  return box.value
}

function readObjectBinding({box}: {box: {value: number}}, ignored = box.value++) {
  return box.value
}

function readRenamedBinding({value: renamed}: {value: number}, ignored = renamed = 2) {
  return renamed
}

function readArrayBinding([, value]: [number, number], ignored = value = 2) {
  return value
}

function readNestedBinding({outer: {value}}: {outer: {value: number}}, ignored = value = 2) {
  return value
}

function readWholePatternDefault({value}: {value: number} = {value: 2}) {
  return value
}

function readRestBinding(...[left, right]: [number, number]) {
  return left * 10 + right
}

function total(...values: [number, number]) {
  return values[0]! + values[1]!
}

function arrayIdentity(values: number[], ignored: number) {
  return values
}

/** @fit
 * return == 1
 */
function explicitArgumentRunsOnce() {
  let count = 0
  id(count++)
  return count
}

/** @fit
 * return == 12
 */
function argumentsRunLeftToRightOnce() {
  let count = 0
  return pair(++count, ++count)
}

/** @fit
 * return == 0
 */
function suppliedArgumentSkipsDefault() {
  return choose(0, 5)
}

/** @fit
 * return == 1
 */
function omittedArgumentRunsDefaultOnce() {
  return choose(0)
}

/** @fit
 * return: int 0..1
 */
function maybeUndefinedDefaultJoinsStates(flag: boolean) {
  return choose(0, flag ? 5 : undefined)
}

/** @fit
 * return == 2
 */
function earlierObjectArgumentStaysLive() {
  const box = {value: 1}
  return readBox(box, box.value = 2)
}

/** @fit
 * return == 1
 */
function earlierObjectArgumentSurvivesNestedCall() {
  const box = {value: 1}
  return readBox(box, id(0))
}

/** @fit
 * return == 1
 */
function laterDefaultMutatesObjectBinding() {
  return readObjectBinding({box: {value: 0}})
}

/** @fit
 * return == 2
 */
function laterDefaultMutatesRenamedBinding() {
  return readRenamedBinding({value: 1})
}

/** @fit
 * return == 2
 */
function laterDefaultMutatesArrayBinding() {
  return readArrayBinding([0, 1])
}

/** @fit
 * return == 2
 */
function laterDefaultMutatesNestedBinding() {
  return readNestedBinding({outer: {value: 1}})
}

/** @fit
 * return == 2
 */
function wholePatternDefaultBindsOnce() {
  return readWholePatternDefault()
}

/** @fit
 * return == 12
 */
function restPatternBindsFinalValues() {
  return readRestBinding(1, 2)
}

/** @fit
 * return == 12
 */
function exactTupleSpread() {
  const values: [number, number] = [1, 2]
  return pair(...values)
}

/** @fit
 * return == 3
 */
function restParameterCollectsArguments() {
  return total(1, 2)
}

/** @fit
 * return == 1
 */
function platformReceiverRunsOnce() {
  let count = 0
  arrayIdentity([10], count++).at(-1)
  return count
}

/** @fit
 * return == 1
 */
function platformArgumentRunsOnce() {
  let count = 0
  ;[10].at(-++count)
  return count
}

/** @fit
 * return == 1
 */
function callbackThisArgumentRunsOnce() {
  let count = 0
  ;[10].map(value => value, {count: count++})
  return count
}

/** @fit
 * return == 2
 */
function nestedPushUsesReceiverAfterArgumentEffects() {
  const values: number[] = []
  values.push(values.push(1))
  return values.length
}

/** @fit
 * return == 1
 */
function callbackIndexReassignmentDoesNotMutateElements() {
  const values = [{size: 1}]
  values.map((value, index) => {
    index = 20
    return value
  })
  return values[0]!.size
}

/** @fit
 * return == 0
 */
function logicalAndSkipsRight() {
  let count = 0
  false && count++
  return count
}

/** @fit
 * return == 0
 */
function logicalOrSkipsRight() {
  let count = 0
  true || count++
  return count
}

/** @fit
 * return: int 0..1
 */
function uncertainLogicalRightJoinsState(flag: boolean) {
  let count = 0
  flag && count++
  return count
}

/** @fit
 * return: int 0..1
 */
function uncertainConditionalJoinsState(flag: boolean) {
  let count = 0
  flag ? count++ : 0
  return count
}

/** @fit
 * return: int 0..1
 */
function uncertainNullishRightJoinsState(value: number | undefined) {
  let count = 0
  value ?? count++
  return count
}
`)

const sourceCallFailures = sourceCallChecks.filter(check => check.status !== 'pass')
if (sourceCallFailures.length > 0 || sourceCallChecks.length !== 25) {
  throw testDiagnosticError('expected source calls to prepare operands and parameters once', sourceCallChecks)
}
})

test('keeps arrays and fixed tuples separate at type boundaries', () => {
const arrayTupleBoundaryChecks = verifyFitSource('array-tuple-boundaries.ts', `
function throughArray(values: number[]) {
  return values
}

function throughTuple(values: [number, number]) {
  return values
}

function takeBox(box: {values: number[]}) {
  return box.values
}

function returnsArray(): number[] {
  return [10, 20] as const
}

function throughReadonlyArray(values: readonly number[]) {
  return values
}

type ReadonlyPair = readonly [number, number]

function throughReadonlyTuple(values: ReadonlyPair) {
  return values
}

/** @fit
 * given values[0]: 0..10
 * return: 0..10
 */
function fixedIndexGivenOnCollectionIsUnsupported(values: number[]) {
  return values[0] ?? 0
}

/** @fit
 * given values[-1]: 0..10
 * return: 0..10
 */
function negativePropertyGivenOnCollectionIsUnsupported(values: number[]) {
  return values[-1] ?? 0
}

/** @fit
 * given values[1.5]: 0..10
 * return: 0..10
 */
function fractionalPropertyGivenOnCollectionIsUnsupported(values: number[]) {
  return values[1.5] ?? 0
}

/** @fit
 * given values["0"]: 0..10
 * return: 0..10
 */
function quotedIndexGivenOnCollectionIsUnsupported(values: number[]) {
  return values["0"] ?? 0
}

/** @fit
 * given pair[0]: 0..10
 * return: 0..10
 */
function fixedIndexGivenOnTupleIsSupported(pair: [number, number]) {
  return pair[0]
}

/** @fit
 * given pair["0"]: 0..10
 * return: 0..10
 */
function quotedIndexGivenOnTupleIsSupported(pair: [number, number]) {
  return pair["0"]
}

/** @fit
 * return[0]: 0..10
 */
function fixedIndexReturnOnCollectionIsUnsupported(values: number[]): number[] {
  return values
}

/** @fit
 * given values.length: int 1..10
 * given values[]: 0..10
 * return: 0..10
 */
function collectionReadWithLengthProof(values: number[]) {
  return values[0]!
}

/** @fit
 * return == 10
 */
function explicitTupleKeepsFirstPosition() {
  return throughTuple([10, 20])[0]
}

/** @fit
 * return == 10
 */
function constAssertionKeepsFirstPosition() {
  return ([10, 20] as const)[0]
}

/** @fit
 * return == 20
 */
function readonlyTupleAliasKeepsSecondPosition() {
  return throughReadonlyTuple([10, 20])[1]
}

/** @fit
 * return.length == 0
 */
function emptyTupleHasExactLength(): [] {
  return []
}

/** @fit
 * return == 20
 */
function namedTupleKeepsSecondPosition() {
  const pair: [left: number, right: number] = [10, 20]
  return pair[1]
}

/** @fit
 * return[0] == 30
 * return.length == 2
 */
function tupleWriteUpdatesOnePosition(): [number, number] {
  const pair: [number, number] = [10, 20]
  pair[0] = 30
  return pair
}

/** @fit
 * return[0] == 30
 */
function quotedTupleWriteUpdatesOnePosition(): [number, number] {
  const pair: [number, number] = [10, 20]
  pair["0"] = 30
  return pair
}

/** @fit
 * return == 3
 */
function tuplePushBecomesCollection() {
  const pair: [number, number] = [10, 20]
  pair.push(30)
  const runtimeLength: number = pair.length
  return runtimeLength
}

/** @fit
 * return == 3
 */
function widenedAliasPushInvalidatesTupleLength() {
  const pair: [number, number] = [10, 20]
  const values: number[] = pair
  values.push(30)
  const runtimeLength: number = pair.length
  return runtimeLength
}

/** @fit
 * return == 30
 */
function tupleWriteDoesNotGiveArrayAliasPositions() {
  const pair: [number, number] = [10, 20]
  const values: number[] = pair
  pair[0] = 30
  return values[0]!
}

/** @fit
 * return == 10
 */
function arrayParameterDoesNotKeepFirstPosition() {
  return throughArray([10, 20])[0]!
}

/** @fit
 * return == 10
 */
function arrayReturnDoesNotKeepFirstPosition() {
  return returnsArray()[0]!
}

/** @fit
 * return == 10
 */
function nestedArrayBoundaryDoesNotKeepFirstPosition() {
  const pair: [10, 20] = [10, 20]
  return takeBox({values: pair})[0]!
}

/** @fit
 * return == 10
 */
function assignmentToArrayDoesNotKeepFirstPosition() {
  const pair: [10, 20] = [10, 20]
  let values: number[] = []
  values = pair
  return values[0]!
}

/** @fit
 * return == 10
 */
function assertionToArrayDoesNotKeepFirstPosition() {
  const pair: [10, 20] = [10, 20]
  return (pair as number[])[0]!
}

/** @fit
 * return == 10
 */
function readonlyArrayDoesNotKeepFirstPosition() {
  return throughReadonlyArray([10, 20] as const)[0]!
}

/** @fit
 * given values[]: 0..10
 * return: 0..10
 */
function collectionReadWithoutLengthProof(values: number[]) {
  return values[0] ?? -1
}

/** @fit
 * given values[]: 0..10
 * return: 0..10
 */
function collectionDestructureWithoutLengthProof(values: number[]) {
  const [first] = values
  return first ?? -1
}

/** @fit
 * given values.length: int 1..10
 * given values[]: 0..10
 * return: 0..10
 */
function negativeCollectionIndexIsNotAnItem(values: number[]) {
  return values[-1] ?? -1
}

/** @fit
 * given values.length: int 1..10
 * given values[]: 0..10
 * return: 0..10
 */
function nonArrayIndexIsNotAnItem(values: number[]) {
  return values[4294967295] ?? -1
}

/** @fit
 * return >= 20
 */
function equalLengthTupleUnionKeepsPositions(flag: boolean) {
  const pair: [10, 20] | [30, 40] = flag ? [10, 20] : [30, 40]
  return pair[1]
}

/** @fit
 * return == 10
 */
function differentLengthTupleUnionDoesNotKeepPositions(flag: boolean) {
  const values: [10] | [10, 20] = flag ? [10] : [10, 20]
  return values[0]
}

/** @fit
 * return[0] == 10
 */
function assertionCannotCreateTuple(values: number[]) {
  return values as [number, number]
}

/** @fit
 * return.length >= 0
 */
function optionalTupleIsUnsupported(values: [number, number?]) {
  return values
}

/** @fit
 * return.length >= 1
 */
function restTupleIsUnsupported(values: [number, ...number[]]) {
  return values
}

type OptionalPair = [number, number?]

/** @fit
 * return.length >= 1
 */
function optionalTupleAliasIsUnsupported(values: OptionalPair) {
  return values
}

type OptionalOrFixedPair = [number, number?] | [number, number]

/** @fit
 * return.length >= 1
 */
function optionalTupleUnionIsUnsupported(values: OptionalOrFixedPair) {
  return values
}

type RestOrFixedPair = [number, ...number[]] | [number, number]

/** @fit
 * return.length >= 1
 */
function restTupleUnionIsUnsupported(values: RestOrFixedPair) {
  return values
}

/** @fit
 * return == 2
 */
function indexedCollectionWriteIsUnsupported() {
  const values: number[] = [1, 2]
  values[0] = 3
  return values.length
}

/** @fit
 * return == 1
 */
function nestedCollectionWriteIsUnsupported() {
  const values: {width: number}[] = [{width: 1}]
  values[0]!.width = 2
  return values.length
}

/** @fit
 * return.length == 2
 */
function negativeTupleIndexWriteIsUnsupported() {
  const pair: [number, number] = [1, 2]
  void ((pair as number[])[-1] = 3)
  return pair
}
`)
const boundaryCheck = (functionName: string, text: string) =>
  requiredCheck(arrayTupleBoundaryChecks, {functionName, text})
const expectedBoundaryPasses = [
  'fixedIndexGivenOnTupleIsSupported',
  'quotedIndexGivenOnTupleIsSupported',
  'collectionReadWithLengthProof',
  'explicitTupleKeepsFirstPosition',
  'constAssertionKeepsFirstPosition',
  'readonlyTupleAliasKeepsSecondPosition',
  'emptyTupleHasExactLength',
  'namedTupleKeepsSecondPosition',
  'tupleWriteUpdatesOnePosition',
  'quotedTupleWriteUpdatesOnePosition',
  'tuplePushBecomesCollection',
  'widenedAliasPushInvalidatesTupleLength',
  'equalLengthTupleUnionKeepsPositions',
]
const expectedBoundaryNonPasses = [
  ['arrayParameterDoesNotKeepFirstPosition', 'return == 10'],
  ['fixedIndexGivenOnCollectionIsUnsupported', 'given values[0]: 0..10'],
  ['negativePropertyGivenOnCollectionIsUnsupported', 'given values[-1]: 0..10'],
  ['fractionalPropertyGivenOnCollectionIsUnsupported', 'given values[1.5]: 0..10'],
  ['quotedIndexGivenOnCollectionIsUnsupported', 'given values["0"]: 0..10'],
  ['fixedIndexReturnOnCollectionIsUnsupported', 'return[0]: 0..10'],
  ['arrayReturnDoesNotKeepFirstPosition', 'return == 10'],
  ['nestedArrayBoundaryDoesNotKeepFirstPosition', 'return == 10'],
  ['assignmentToArrayDoesNotKeepFirstPosition', 'return == 10'],
  ['assertionToArrayDoesNotKeepFirstPosition', 'return == 10'],
  ['readonlyArrayDoesNotKeepFirstPosition', 'return == 10'],
  ['tupleWriteDoesNotGiveArrayAliasPositions', 'return == 30'],
  ['collectionReadWithoutLengthProof', 'return: 0..10'],
  ['collectionDestructureWithoutLengthProof', 'return: 0..10'],
  ['negativeCollectionIndexIsNotAnItem', 'return: 0..10'],
  ['nonArrayIndexIsNotAnItem', 'return: 0..10'],
  ['differentLengthTupleUnionDoesNotKeepPositions', 'return == 10'],
] as const
const missingBoundaryPasses = expectedBoundaryPasses.filter(name =>
  !arrayTupleBoundaryChecks.some(check => check.functionName === name))
const invalidBoundaryPasses = expectedBoundaryPasses.filter(name =>
  arrayTupleBoundaryChecks.some(check => check.functionName === name && check.status !== 'pass'))
const invalidBoundaryNonPasses = expectedBoundaryNonPasses.filter(([functionName, text]) =>
  boundaryCheck(functionName, text).status === 'pass')
if (
  missingBoundaryPasses.length > 0
  || invalidBoundaryPasses.length > 0
  || invalidBoundaryNonPasses.length > 0
  || boundaryCheck('assertionCannotCreateTuple', 'return[0] == 10').status !== 'unknown'
  || !boundaryCheck('optionalTupleIsUnsupported', 'return.length >= 0').reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryCheck('restTupleIsUnsupported', 'return.length >= 1').reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryCheck('optionalTupleAliasIsUnsupported', 'return.length >= 1').reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryCheck('optionalTupleUnionIsUnsupported', 'return.length >= 1').reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryCheck('restTupleUnionIsUnsupported', 'return.length >= 1').reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryCheck('fixedIndexGivenOnCollectionIsUnsupported', 'given values[0]: 0..10').reason?.includes('requires a fixed tuple type')
  || !boundaryCheck('negativePropertyGivenOnCollectionIsUnsupported', 'given values[-1]: 0..10').reason?.includes('requires an object, not an array')
  || !boundaryCheck('fractionalPropertyGivenOnCollectionIsUnsupported', 'given values[1.5]: 0..10').reason?.includes('requires an object, not an array')
  || !boundaryCheck('quotedIndexGivenOnCollectionIsUnsupported', 'given values["0"]: 0..10').reason?.includes('requires a fixed tuple type')
  || !boundaryCheck('fixedIndexReturnOnCollectionIsUnsupported', 'return[0]: 0..10').reason?.includes('requires a fixed tuple type')
  || boundaryCheck('indexedCollectionWriteIsUnsupported', 'return == 2').status !== 'unknown'
  || boundaryCheck('nestedCollectionWriteIsUnsupported', 'return == 1').status !== 'unknown'
  || boundaryCheck('negativeTupleIndexWriteIsUnsupported', 'return.length == 2').status !== 'unknown'
) {
  throw testDiagnosticError('expected arrays and fixed tuples to keep separate guarantees at every type boundary', {
    missingBoundaryPasses,
    invalidBoundaryPasses,
    invalidBoundaryNonPasses,
    arrayTupleBoundaryChecks,
  })
}
})

test('reports unsupported tuple assertions and collection writes at their boundaries', () => {
const arrayTupleBoundaryProgram = buildFitSourceFile('array-tuple-boundary-interpreter.ts', `
function assertionCannotCreateTuple(values: number[]) {
  return values as [number, number]
}

function indexedCollectionWriteIsUnsupported() {
  const values: number[] = [1, 2]
  values[0] = 3
  return values.length
}

function nestedCollectionWriteIsUnsupported() {
  const values: {width: number}[] = [{width: 1}]
  values[0]!.width = 2
  return values.length
}

function negativeTupleIndexWriteIsUnsupported() {
  const pair: [number, number] = [1, 2]
  void ((pair as number[])[-1] = 3)
  return pair
}
`, readTopLevelGlobal)
const assertionBoundary = evaluateInterpreterFunction({
  program: arrayTupleBoundaryProgram,
  functionName: 'assertionCannotCreateTuple',
})
const indexedWriteBoundary = evaluateInterpreterFunction({
  program: arrayTupleBoundaryProgram,
  functionName: 'indexedCollectionWriteIsUnsupported',
})
const nestedIndexedWriteBoundary = evaluateInterpreterFunction({
  program: arrayTupleBoundaryProgram,
  functionName: 'nestedCollectionWriteIsUnsupported',
})
const negativeTupleIndexWriteBoundary = evaluateInterpreterFunction({
  program: arrayTupleBoundaryProgram,
  functionName: 'negativeTupleIndexWriteIsUnsupported',
})
if (
  !assertionBoundary.output.issues.some(issue => issue.message.includes('fixed tuple'))
  || !indexedWriteBoundary.output.issues.some(issue => issue.message.includes('Indexed writes to collections are unsupported'))
  || !nestedIndexedWriteBoundary.output.issues.some(issue => issue.message.includes('Indexed writes to collections are unsupported'))
  || !negativeTupleIndexWriteBoundary.output.issues.some(issue => issue.message.includes('not a JavaScript array index'))
) {
  throw testDiagnosticError('expected unsupported tuple assertions and collection writes to report their actual boundary', {
    assertion: assertionBoundary.output.issues.map(issue => issue.message),
    indexedWrite: indexedWriteBoundary.output.issues.map(issue => issue.message),
    nestedIndexedWrite: nestedIndexedWriteBoundary.output.issues.map(issue => issue.message),
    negativeTupleIndexWrite: negativeTupleIndexWriteBoundary.output.issues.map(issue => issue.message),
  })
}
})

test('uses final destructured parameter bindings for claims', () => {
const finalBindingNegativeChecks = verifyFitSource('final-binding-negative.ts', `
function read({value}: {value: number}, ignored = value = 2) {
  return value
}

/** @fit
 * return == 1
 */
function staleDestructuredValueMustNotPass() {
  return read({value: 1})
}
`)
if (
  finalBindingNegativeChecks.length !== 1
  || finalBindingNegativeChecks[0]?.status !== 'fail'
  || !finalBindingNegativeChecks[0].reason?.includes('is false')
) {
  throw testDiagnosticError('expected false claims to see final destructured parameter bindings', finalBindingNegativeChecks)
}
})

test('keeps caller and default text distinct from callee parameter names', () => {
const sameParameterNameChecks = verifyFitSource('same-parameter-name.ts', `
/** @fit
 * given value: 0..10
 * return: 0..10
 */
function bounded(value: number) {
  return value
}

/** @fit
 * given right <= left
 * return == right
 */
function ordered(left: number, right: number = left + 1) {
  return right
}

/** @fit
 * given value: 100..110
 * return: 100..110
 */
function sameParameterNameKeepsCallerMeaning(value: number) {
  ordered(value)
  return bounded(value)
}
`)
const sameNameRequirement = requiredCheck(sameParameterNameChecks, {
  functionName: 'sameParameterNameKeepsCallerMeaning',
  text: 'bounded(value): requires value: 0..10',
})
const defaultRequirement = requiredCheck(sameParameterNameChecks, {
  functionName: 'sameParameterNameKeepsCallerMeaning',
  text: 'ordered(value): requires right <= left',
})
if (
  sameNameRequirement.status !== 'fail'
  || !sameNameRequirement.reason?.includes('missing: value <= 10')
  || sameNameRequirement.reason.includes('value +')
  || defaultRequirement.status !== 'unknown'
  || !defaultRequirement.reason?.includes('(value + 1) <= value')
) {
  throw testDiagnosticError('expected caller and default text to remain distinct from callee parameter names', sameParameterNameChecks)
}
})

test('keeps explicit arguments in caller scope and defaults in callee scope', () => {
const simultaneousParameterChecks = verifyFitSource('simultaneous-parameters.ts', `
function difference(left: number, right: number) {
  return left - right
}

function copy(left: number, right: number = left) {
  return right
}

/** @fit
 * given left: 0..10
 * given right: 0..10
 * return >= 0
 */
function exchangedArgumentsStayInCallerScope(left: number, right: number) {
  return difference(right, left)
}

/** @fit
 * given value: 0..10
 * return == value
 */
function defaultReadsEarlierCalleeParameter(value: number) {
  return copy(value)
}
`)
const exchangedArgumentCheck = requiredCheck(simultaneousParameterChecks, {functionName: 'exchangedArgumentsStayInCallerScope', text: 'return >= 0'})
const defaultParameterCheck = requiredCheck(simultaneousParameterChecks, {functionName: 'defaultReadsEarlierCalleeParameter', text: 'return == value'})
const quotedPropertyRebase = callSiteText('obj["x"] + x', new Map([['obj', 'item'], ['x', 'amount']]))
const namedPropertyRebase = callSiteText('({x: x, x})', new Map([['x', 'amount']]))
const shadowedCallbackRebase = callSiteText('[1].map(x => x + outside)', new Map([['x', 'wrong'], ['outside', 'amount']]))
const shadowedBlockRebase = callSiteText('(() => { const x = 1; return x + outside })()', new Map([['x', 'wrong'], ['outside', 'amount']]))
const defaultInitializerRebase = callSiteText('((local = outside) => local)()', new Map([['outside', 'amount']]))
const catchBindingRebase = callSiteText('(() => { try {} catch (x) { return x + outside } })()', new Map([['x', 'wrong'], ['outside', 'amount']]))
const thisRebase = callSiteText('this.width + x', new Map([['this', 'item'], ['x', 'amount']]))
const arrowThisRebase = callSiteText('(() => this.width)()', new Map([['this', 'item']]))
const functionThisRebase = callSiteText('(function () { return this.width })()', new Map([['this', 'item']]))
const loopBindingRebase = callSiteText('(() => { for (const x of [1]) { void x }; return outside })()', new Map([['x', 'wrong'], ['outside', 'total']]))
const switchBindingRebase = callSiteText('(() => { switch (outside) { case 0: const x = 1; return x; default: return outside } })()', new Map([['x', 'wrong'], ['outside', 'total']]))
const classBindingRebase = callSiteText('(class x { static value() { return x } })', new Map([['x', 'wrong']]))
const methodFreeVariableRebase = callSiteText('({x() { return x + outside }})', new Map([['x', 'amount'], ['outside', 'total']]))
if (
  exchangedArgumentCheck.status === 'pass'
  || defaultParameterCheck.status !== 'pass'
  || quotedPropertyRebase !== 'item["x"] + amount'
  || namedPropertyRebase !== '({x: amount, x: amount})'
  || shadowedCallbackRebase !== '[1].map(x => x + amount)'
  || shadowedBlockRebase !== '(() => { const x = 1; return x + amount })()'
  || defaultInitializerRebase !== '((local = amount) => local)()'
  || catchBindingRebase !== '(() => { try {} catch (x) { return x + amount } })()'
  || thisRebase !== 'item.width + amount'
  || arrowThisRebase !== '(() => item.width)()'
  || functionThisRebase !== '(function () { return this.width })()'
  || loopBindingRebase !== '(() => { for (const x of [1]) { void x }; return total })()'
  || switchBindingRebase !== '(() => { switch (total) { case 0: const x = 1; return x; default: return total } })()'
  || classBindingRebase !== '(class x { static value() { return x } })'
  || methodFreeVariableRebase !== '({x() { return amount + total }})'
) {
  throw testDiagnosticError('expected explicit arguments to stay in caller scope and defaults to read earlier parameters', {
    simultaneousParameterChecks,
    quotedPropertyRebase,
    namedPropertyRebase,
    shadowedCallbackRebase,
    shadowedBlockRebase,
    defaultInitializerRebase,
    catchBindingRebase,
    thisRebase,
    arrowThisRebase,
    functionThisRebase,
    loopBindingRebase,
    switchBindingRebase,
    classBindingRebase,
    methodFreeVariableRebase,
  })
}
})

test('retains caller argument text in rest parameter contracts', () => {
const restContractChecks = verifyFitSource('rest-contract.ts', `
/** @fit
 * given values.length: int 2..2
 * return: int 2..2
 */
function exactlyTwo(...values: number[]) {
  return values.length
}

/** @fit
 * return: int 0..2
 */
function tooFew() {
  return exactlyTwo(1)
}
`)
const restRequirement = requiredCheck(restContractChecks, {
  functionName: 'tooFew',
  text: 'exactlyTwo(1): requires values.length: int 2..2',
})
if (restRequirement.status !== 'fail' || !restRequirement.reason?.includes('([1]).length >= 2')) {
  throw testDiagnosticError('expected rest parameter contracts to retain caller argument text', restContractChecks)
}
})

test('skips body callsite checks for input-only annotations', () => {
const annotationOnlyInputChecks = verifyFitSource('annotation-only-input.ts', `
export function annotationOnlyInput(
  value: number, // @fit 0..10
) {
  return narrowInput(value + 100)
}

function narrowInput(
  value: number, // @fit 0..10
) {
  return value
}
`)
if (annotationOnlyInputChecks.some(check => check.status !== 'pass')) {
  throw testDiagnosticError('expected input-only annotations to skip body callsite checks', annotationOnlyInputChecks)
}
})

test('reports unsupported call input families directly', () => {
const unsupportedCallProgram = buildFitSourceFile('unsupported-call-inputs.ts', `
function total(...values: number[]) {
  return values.length
}

function read({value = 2}: {value?: number}) {
  return value
}

function unknownSpread(values: number[]) {
  return total(...values)
}

function destructuringDefault() {
  return read({})
}
`, readTopLevelGlobal)

const unknownSpread = evaluateInterpreterFunction({program: unsupportedCallProgram, functionName: 'unknownSpread'})
const destructuringDefault = evaluateInterpreterFunction({program: unsupportedCallProgram, functionName: 'destructuringDefault'})
if (
  !unknownSpread.output.issues.some(issue => issue.message.includes('Call spread needs an exact tuple'))
  || !destructuringDefault.output.issues.some(issue => issue.message.includes('Unsupported parameter binding'))
) {
  throw testDiagnosticError('expected unsupported call input families to be reported directly', {
    unknownSpread: unknownSpread.output.issues.map(issue => issue.message),
    destructuringDefault: destructuringDefault.output.issues.map(issue => issue.message),
  })
}
})

test('reports specific reasons for unsupported platform calls', () => {
const unsupportedPlatformProgram = buildFitSourceFile('unsupported-platform-calls.ts', `
function arrayFrom(values: number[]) {
  return Array.from(values).length
}

function jsonParse(value: string) {
  return JSON.parse(value)
}

function jsonStringify(value: {x: number}) {
  return JSON.stringify(value).length
}

function objectEntries(value: {x: number}) {
  return Object.entries(value).length
}

function objectValues(value: {x: number}) {
  return Object.values(value).length
}

function dateParse(value: string) {
  return Date.parse(value)
}

function sortWithoutComparator(values: number[]) {
  values.sort()
  return values.length
}

function toSortedWithoutComparator(values: number[]) {
  return values.toSorted().length
}

function sortWithComparator(values: number[]) {
  values.sort((left, right) => left - right)
  return values.length
}

function toSortedWithComparator(values: number[]) {
  return values.toSorted((left, right) => left - right).length
}
`, readTopLevelGlobal)

const unsupportedPlatformMessages = new Map([
  ['arrayFrom', 'Array.from is unsupported because it can call an iterator or mapper supplied by user code'],
  ['jsonParse', 'JSON.parse is unsupported because its result values are not modeled and its optional callback can run user code'],
  ['jsonStringify', 'JSON.stringify is unsupported because it can run getters or toJSON methods'],
  ['objectEntries', 'Object.entries is unsupported because reading property values can run getters'],
  ['objectValues', 'Object.values is unsupported because reading property values can run getters'],
  ['dateParse', "Date.parse is unsupported because some date strings depend on the machine's time zone or accepted formats"],
  ['sortWithoutComparator', 'Array.sort without a comparator is unsupported because default sorting converts elements to strings and can run user code'],
  ['toSortedWithoutComparator', 'Array.toSorted without a comparator is unsupported because default sorting converts elements to strings and can run user code'],
])
const unsupportedPlatformFailures: {functionName: string; messages: string[]}[] = []
for (const [functionName, expectedMessage] of unsupportedPlatformMessages) {
  const result = evaluateInterpreterFunction({program: unsupportedPlatformProgram, functionName})
  const messages = result.output.issues.map(issue => issue.message)
  if (!messages.includes(expectedMessage)) unsupportedPlatformFailures.push({functionName, messages})
}
const supportedSortFailures = ['sortWithComparator', 'toSortedWithComparator'].flatMap(functionName => {
  const result = evaluateInterpreterFunction({program: unsupportedPlatformProgram, functionName})
  const messages = result.output.issues.map(issue => issue.message)
  return messages.some(message => message.includes('without a comparator'))
    ? [{functionName, messages}]
    : []
})
if (unsupportedPlatformFailures.length > 0 || supportedSortFailures.length > 0) {
  throw testDiagnosticError('expected deliberate platform boundaries to report their shared specific reasons', {
    unsupportedPlatformFailures,
    supportedSortFailures,
  })
}
})

test('preserves operand effects across unsupported callbacks and callable targets', () => {
const callbackBoundaryProgram = buildFitSourceFile('callback-boundaries.ts', `
function localCallbackIsRejected(values: number[]) {
  let count = 0
  const callback = (value: number) => {
    count++
    return value
  }
  values.map(callback)
  return count
}

function callbackExpressionEffectsRun(values: number[]) {
  let count = 0
  values.map((count++, value => value))
  return count
}

function localFunctionEffectsInvalidateCapturedState() {
  let count = 0
  const increment = () => count++
  increment()
  return count
}

function sortComparatorEffectsInvalidateCapturedState(values: number[]) {
  let count = 0
  values.sort(() => {
    count++
    return 0
  })
  return count
}

function namedSortComparatorEffectsInvalidateCapturedState(values: number[]) {
  let count = 0
  const compare = (left: number, right: number) => {
    count++
    return left - right
  }
  values.sort(compare)
  return count
}

function namedSortComparatorReadPreservesCapturedState(values: number[]) {
  const offset = 0
  const compare = (left: number, right: number) => left - right + offset
  values.sort(compare)
  return offset
}

function unresolvedSortComparatorDoesNotPreserveCapturedState(values: number[]) {
  let count = 0
  const compare = (left: number, right: number) => {
    count++
    return left - right
  }
  values.sort((count++, compare))
  return count
}

function callbackThisMutationInvalidatesArgument() {
  const state = {value: 0}
  const values = [1]
  values.map(function (this: {value: number}, value) {
    this.value = value
    return value
  }, state)
  return state.value
}

function makeCallable(state: {value: number}) {
  state.value++
  return (value: number) => value
}

function unknownCallableTargetStillRuns() {
  const state = {value: 0}
  makeCallable(state)(0)
  return state.value
}

let nondecreasing = (_values: number[]) => 1
nondecreasing = () => 2

function mutableCatalogNameIsNotBuiltin() {
  return nondecreasing([])
}

function mutateNestedState(holder: {state: {value: number}}) {
  holder.state.value = 10
}

function readNestedState(holder: {state: {value: number}}) {
  return holder.state.value
}

function nestedArgumentMutationInvalidatesAlias() {
  const state = {value: 0}
  const holder = {state}
  mutateNestedState(holder)
  return state.value
}

function nestedArgumentReadPreservesAlias() {
  const state = {value: 0}
  const holder = {state}
  readNestedState(holder)
  return state.value
}
`, readTopLevelGlobal)

const localCallback = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'localCallbackIsRejected'})
const callbackExpression = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'callbackExpressionEffectsRun'})
const localFunction = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'localFunctionEffectsInvalidateCapturedState'})
const sortComparator = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'sortComparatorEffectsInvalidateCapturedState'})
const namedSortComparator = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'namedSortComparatorEffectsInvalidateCapturedState'})
const readOnlySortComparator = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'namedSortComparatorReadPreservesCapturedState'})
const unresolvedSortComparator = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'unresolvedSortComparatorDoesNotPreserveCapturedState'})
const callbackThis = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'callbackThisMutationInvalidatesArgument'})
const unknownTarget = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'unknownCallableTargetStillRuns'})
const mutableCatalogName = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'mutableCatalogNameIsNotBuiltin'})
const nestedMutation = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'nestedArgumentMutationInvalidatesAlias'})
const nestedRead = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'nestedArgumentReadPreservesAlias'})
const isExactNumber = (value: typeof callbackExpression.value, expected: number) =>
  value.kind === 'number' && value.min === expected && value.max === expected
if (
  !localCallback.output.issues.some(issue => issue.message.includes('map callback must be an inline function'))
  || isExactNumber(callbackExpression.value, 0)
  || !callbackExpression.output.issues.some(issue => issue.message.includes('map callback must be an inline function'))
  || isExactNumber(localFunction.value, 0)
  || isExactNumber(sortComparator.value, 0)
  || isExactNumber(namedSortComparator.value, 0)
  || !isExactNumber(readOnlySortComparator.value, 0)
  || isExactNumber(unresolvedSortComparator.value, 1)
  || isExactNumber(callbackThis.value, 0)
  || isExactNumber(unknownTarget.value, 0)
  || unknownTarget.output.issues.length === 0
  || mutableCatalogName.output.issues.length === 0
  || isExactNumber(nestedMutation.value, 0)
  || !isExactNumber(nestedRead.value, 0)
) {
  throw testDiagnosticError('expected unsupported callbacks and callable targets to preserve operand effects without stale facts', {
    localCallback,
    callbackExpression,
    localFunction,
    sortComparator,
    namedSortComparator,
    readOnlySortComparator,
    unresolvedSortComparator,
    callbackThis,
    unknownTarget,
    mutableCatalogName,
    nestedMutation,
    nestedRead,
  })
}
})

test('shares prepared invocation semantics with imported calls', async () => {
void importedArgumentRunsOnce
void importedDefaultRunsOnce
void importedDestructuredDefaultUsesFinalBinding
const importedReport = await verifyFitFiles(['tests/calls/imported-caller.ts'])
if (importedReport.phase !== 'ready' || importedReport.summary.pass !== 4) {
  throw testDiagnosticError('expected imported calls to share prepared invocation semantics', importedReport)
}
})

test('applies finite defaults at checked contracts and publishes call requirements', () => {
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
const finiteDefaultStatus = (functionName: string, text: string) =>
  requiredCheck(finiteDefaultAllChecks, {functionName, text}).status
const expectedPassingFiniteDefaultFunctions = new Set([
  'forwardsChecked',
  'guardedExternal',
  'integerExternal',
  'safeIntegerExternal',
  'boundedDouble',
])
if (
  finiteDefaultStatus('needsFinite', 'return: -Infinity<..<Infinity') !== 'pass'
  || finiteDefaultStatus('unguardedExternal', 'needsFinite(value): requires value to be finite') !== 'requires'
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
  throw testDiagnosticError('expected finite defaults to apply only at checked contracts and to publish call requirements', finiteDefaultChecks)
}
})

test('applies finite defaults to nested numeric leaves and exact paths', () => {
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
const infiniteWidth = requiredCheck(finiteLeafCallChecks, {
  functionName: '<top-level>',
  text: 'reads({width: Infinity, rows: [{height: 1}]}): requires ({width: Infinity, rows: [{height: 1}]}).width to be finite',
})
const infiniteHeight = requiredCheck(finiteLeafCallChecks, {
  functionName: '<top-level>',
  text: 'reads({width: 1, rows: [{height: Infinity}]}): requires ({width: 1, rows: [{height: Infinity}]}).rows[].height to be finite',
})
const allowedWidth = requiredCheck(finiteLeafCallChecks, {
  functionName: '<top-level>',
  text: 'allowsInfiniteWidth({width: Infinity, height: 1}): requires input.width: 0..Infinity',
})
const rejectedSibling = requiredCheck(finiteLeafCallChecks, {
  functionName: '<top-level>',
  text: 'allowsInfiniteWidth({width: 1, height: Infinity}): requires ({width: 1, height: Infinity}).height to be finite',
})
const rejectedDestructured = requiredCheck(finiteLeafCallChecks, {
  functionName: '<top-level>',
  text: 'destructuredWidth({width: Infinity}): requires Infinity to be finite',
})
if (
  infiniteWidth.status !== 'fail'
  || infiniteHeight.status !== 'fail'
  || allowedWidth.status !== 'pass'
  || rejectedSibling.status !== 'fail'
  || rejectedDestructured.status !== 'fail'
) {
  throw testDiagnosticError('expected finite defaults on nested numeric leaves and exact-path range replacement', finiteLeafChecks)
}
})

test('applies the finite boundary to resolved numeric leaves', () => {
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
  throw testDiagnosticError('expected resolved, inherited, destructured, optional, nullable, and inferred number leaves to share the finite boundary', resolvedFiniteLeafChecks)
}
})

test('uses TypeScript generic constraints for contracts and call checks', () => {
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
const constrainedGenericReturnCheck = requiredCheck(constrainedGenericFunctionResult.annotationChecks, {
  functionName: 'positiveIdentity',
  text: 'return > 0',
})
const goodGenericCallCheck = requiredCheck(constrainedGenericFunctionResult.callsiteChecks, {
  functionName: 'goodGenericCall',
  text: 'positiveIdentity(1): requires value > 0',
})
const badGenericCallCheck = requiredCheck(constrainedGenericFunctionResult.callsiteChecks, {
  functionName: 'badGenericCall',
  text: 'positiveIdentity(-1): requires value > 0',
})
const unconstrainedGenericFunctionChecks = verifyFitSource('unconstrained-generic-function.ts', `/** @fit
 * given value > 0
 */
function unsafeIdentity<T>(value: T) {
  return value
}
`)
const unconstrainedGenericGivenCheck = requiredCheck(unconstrainedGenericFunctionChecks, {
  functionName: 'unsafeIdentity',
  text: 'given value > 0',
})
if (
  constrainedGenericReturnCheck.status !== 'pass'
  || goodGenericCallCheck.status !== 'pass'
  || badGenericCallCheck.status !== 'fail'
  || unconstrainedGenericGivenCheck.status !== 'unknown'
  || unconstrainedGenericGivenCheck.reason?.includes("Type 'T' is not assignable to type 'number'") !== true
) {
  throw testDiagnosticError('expected TypeScript generic constraints to drive function contracts and call checks', {
    constrainedGenericFunctionResult,
    unconstrainedGenericFunctionChecks,
  })
}
})

test('assumes boolean given predicates in callees and checks them at callers', () => {
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
const assumedBooleanGivenCheck = requiredCheck(booleanGivenContractResult.annotationChecks, {functionName: 'assumesValidLayout', text: 'isValidLayout((layout))'})
const conflictingBooleanGivenCheck = requiredCheck(booleanGivenContractResult.annotationChecks, {functionName: 'conflictingLayout', text: 'given !isValidLayout((layout))'})
const assumedNegativeBooleanGivenCheck = requiredCheck(booleanGivenContractResult.annotationChecks, {functionName: 'assumesInvalidLayout', text: '!isValidLayout(layout)'})
const invalidBooleanGivenCall = requiredCheck(booleanGivenContractResult.callsiteChecks, {
  functionName: 'invalidCaller',
  text: 'assumesValidLayout({width: 0}): requires isValidLayout(layout)',
})
if (
  assumedBooleanGivenCheck.status !== 'pass'
  || assumedBooleanGivenCheck.trace?.steps.some(step => step.rule === 'assumption') !== true
  || conflictingBooleanGivenCheck.status !== 'fail'
  || conflictingBooleanGivenCheck.reason?.includes('no input can satisfy both given isValidLayout((layout)) and given !isValidLayout((layout))') !== true
  || assumedNegativeBooleanGivenCheck.status !== 'pass'
  || invalidBooleanGivenCall.status !== 'fail'
  || invalidBooleanGivenCall.reason?.includes('given isValidLayout(layout) returned false') !== true
) {
  throw testDiagnosticError('expected boolean given predicates to be assumed in the callee and checked at callers', booleanGivenContractResult)
}
})

})
