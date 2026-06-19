import {readTopLevelGlobal} from '../../src/check-core.ts'
import {callSiteText} from '../../src/call-site-text.ts'
import {evaluateInterpreterFunction} from '../../src/interpreter/evaluate.ts'
import {buildFitSourceFile} from '../../src/modules.ts'
import {verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {
  importedArgumentRunsOnce,
  importedDefaultRunsOnce,
  importedDestructuredDefaultUsesFinalBinding,
} from './imported-caller.ts'
import {testSuite} from '../test-suite.ts'

testSuite('calls suite', async suite => {
void importedArgumentRunsOnce
void importedDefaultRunsOnce
void importedDestructuredDefaultUsesFinalBinding

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
  console.error('expected source calls to prepare operands and parameters once')
  console.error(JSON.stringify(sourceCallChecks, null, 2))
  suite.fail()
} else {
  console.log('calls: operands and parameters prepared once')
}

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
const boundaryStatus = (name: string) =>
  arrayTupleBoundaryChecks.find(check => check.functionName === name)
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
const expectedBoundaryUnknowns = [
  'arrayParameterDoesNotKeepFirstPosition',
  'fixedIndexGivenOnCollectionIsUnsupported',
  'negativePropertyGivenOnCollectionIsUnsupported',
  'fractionalPropertyGivenOnCollectionIsUnsupported',
  'quotedIndexGivenOnCollectionIsUnsupported',
  'fixedIndexReturnOnCollectionIsUnsupported',
  'arrayReturnDoesNotKeepFirstPosition',
  'nestedArrayBoundaryDoesNotKeepFirstPosition',
  'assignmentToArrayDoesNotKeepFirstPosition',
  'assertionToArrayDoesNotKeepFirstPosition',
  'readonlyArrayDoesNotKeepFirstPosition',
  'tupleWriteDoesNotGiveArrayAliasPositions',
  'collectionReadWithoutLengthProof',
  'collectionDestructureWithoutLengthProof',
  'negativeCollectionIndexIsNotAnItem',
  'nonArrayIndexIsNotAnItem',
  'differentLengthTupleUnionDoesNotKeepPositions',
]
if (
  expectedBoundaryPasses.some(name =>
    arrayTupleBoundaryChecks.filter(check => check.functionName === name).some(check => check.status !== 'pass'))
  || expectedBoundaryUnknowns.some(name => boundaryStatus(name)?.status === 'pass')
  || boundaryStatus('assertionCannotCreateTuple')?.status !== 'unknown'
  || !boundaryStatus('optionalTupleIsUnsupported')?.reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryStatus('restTupleIsUnsupported')?.reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryStatus('optionalTupleAliasIsUnsupported')?.reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryStatus('optionalTupleUnionIsUnsupported')?.reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryStatus('restTupleUnionIsUnsupported')?.reason?.includes('Optional and rest tuple elements are unsupported')
  || !boundaryStatus('fixedIndexGivenOnCollectionIsUnsupported')?.reason?.includes('requires a fixed tuple type')
  || !boundaryStatus('negativePropertyGivenOnCollectionIsUnsupported')?.reason?.includes('requires an object, not an array')
  || !boundaryStatus('fractionalPropertyGivenOnCollectionIsUnsupported')?.reason?.includes('requires an object, not an array')
  || !boundaryStatus('quotedIndexGivenOnCollectionIsUnsupported')?.reason?.includes('requires a fixed tuple type')
  || !boundaryStatus('fixedIndexReturnOnCollectionIsUnsupported')?.reason?.includes('requires a fixed tuple type')
  || boundaryStatus('indexedCollectionWriteIsUnsupported')?.status === 'pass'
  || boundaryStatus('nestedCollectionWriteIsUnsupported')?.status === 'pass'
  || boundaryStatus('negativeTupleIndexWriteIsUnsupported')?.status === 'pass'
) {
  console.error('expected arrays and fixed tuples to keep separate guarantees at every type boundary')
  console.error(JSON.stringify(arrayTupleBoundaryChecks, null, 2))
  suite.fail()
} else {
  console.log('calls: arrays and fixed tuples keep separate guarantees')
}

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
  console.error('expected unsupported tuple assertions and collection writes to report their actual boundary')
  console.error({
    assertion: assertionBoundary.output.issues.map(issue => issue.message),
    indexedWrite: indexedWriteBoundary.output.issues.map(issue => issue.message),
    nestedIndexedWrite: nestedIndexedWriteBoundary.output.issues.map(issue => issue.message),
    negativeTupleIndexWrite: negativeTupleIndexWriteBoundary.output.issues.map(issue => issue.message),
  })
  suite.fail()
} else {
  console.log('calls: unsupported tuple assertions and collection writes report directly')
}

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
  console.error('expected false claims to see final destructured parameter bindings')
  console.error(JSON.stringify(finalBindingNegativeChecks, null, 2))
  suite.fail()
} else {
  console.log('calls: stale destructured parameter values cannot prove claims')
}

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
const sameNameRequirement = sameParameterNameChecks.find(check => check.text.includes('bounded(value): requires'))
const defaultRequirement = sameParameterNameChecks.find(check => check.text.includes('ordered(value): requires'))
if (
  sameNameRequirement?.status !== 'fail'
  || !sameNameRequirement.reason?.includes('missing: value <= 10')
  || sameNameRequirement.reason.includes('value +')
  || defaultRequirement?.status !== 'unknown'
  || !defaultRequirement.reason?.includes('(value + 1) <= value')
) {
  console.error('expected caller and default text to remain distinct from callee parameter names')
  console.error(JSON.stringify(sameParameterNameChecks, null, 2))
  suite.fail()
} else {
  console.log('calls: caller text stays distinct from callee names')
}

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
const exchangedArgumentCheck = simultaneousParameterChecks.find(check => check.functionName === 'exchangedArgumentsStayInCallerScope' && check.text === 'return >= 0')
const defaultParameterCheck = simultaneousParameterChecks.find(check => check.functionName === 'defaultReadsEarlierCalleeParameter' && check.text === 'return == value')
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
  exchangedArgumentCheck?.status === 'pass'
  || defaultParameterCheck?.status !== 'pass'
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
  console.error('expected explicit arguments to stay in caller scope and defaults to read earlier parameters')
  console.error({
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
  suite.fail()
} else {
  console.log('calls: explicit arguments and defaults use their own lexical scopes')
}

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
const restRequirement = restContractChecks.find(check => check.text.includes('exactlyTwo(1): requires'))
if (restRequirement?.status !== 'fail' || !restRequirement.reason?.includes('([1]).length >= 2')) {
  console.error('expected rest parameter contracts to retain caller argument text')
  console.error(JSON.stringify(restContractChecks, null, 2))
  suite.fail()
} else {
  console.log('calls: rest contracts retain caller argument text')
}

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
  console.error('expected input-only annotations to skip body callsite checks')
  console.error(JSON.stringify(annotationOnlyInputChecks, null, 2))
  suite.fail()
} else {
  console.log('calls: annotation-only input checks stay local')
}

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
  console.error('expected unsupported call input families to be reported directly')
  console.error({
    unknownSpread: unknownSpread.output.issues.map(issue => issue.message),
    destructuringDefault: destructuringDefault.output.issues.map(issue => issue.message),
  })
  suite.fail()
} else {
  console.log('calls: unsupported spread and binding defaults reported')
}

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
  console.error('expected deliberate platform boundaries to report their shared specific reasons')
  console.error({unsupportedPlatformFailures, supportedSortFailures})
  suite.fail()
} else {
  console.log('calls: deliberate platform boundaries report specific reasons')
}

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

function sortComparatorEffectsInvalidateCapturedState(values: number[]) {
  let count = 0
  values.sort(() => {
    count++
    return 0
  })
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
`, readTopLevelGlobal)

const localCallback = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'localCallbackIsRejected'})
const callbackExpression = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'callbackExpressionEffectsRun'})
const sortComparator = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'sortComparatorEffectsInvalidateCapturedState'})
const callbackThis = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'callbackThisMutationInvalidatesArgument'})
const unknownTarget = evaluateInterpreterFunction({program: callbackBoundaryProgram, functionName: 'unknownCallableTargetStillRuns'})
const isExactNumber = (value: typeof callbackExpression.value, expected: number) =>
  value.kind === 'number' && value.min === expected && value.max === expected
if (
  !localCallback.output.issues.some(issue => issue.message.includes('map callback must be an inline function'))
  || !isExactNumber(callbackExpression.value, 1)
  || !callbackExpression.output.issues.some(issue => issue.message.includes('map callback must be an inline function'))
  || isExactNumber(sortComparator.value, 0)
  || isExactNumber(callbackThis.value, 0)
  || isExactNumber(unknownTarget.value, 0)
  || unknownTarget.output.issues.length === 0
) {
  console.error('expected unsupported callbacks and callable targets to preserve operand effects without stale facts')
  console.error({
    localCallback,
    callbackExpression,
    sortComparator,
    callbackThis,
    unknownTarget,
  })
  suite.fail()
} else {
  console.log('calls: unsupported callbacks and callable targets preserve operand effects')
}

const importedReport = await verifyFitFiles(['tests/calls/imported-caller.ts'])
if (importedReport.phase !== 'ready' || importedReport.summary.pass !== 4) {
  console.error('expected imported calls to share prepared invocation semantics')
  console.error(JSON.stringify(importedReport, null, 2))
  suite.fail()
} else {
  console.log('calls: imported defaults and side effects prepared once')
}

})
