import {readTopLevelGlobal} from '../../src/check-core.ts'
import {evaluateInterpreterFunction} from '../../src/interpreter/evaluate.ts'
import {buildFitSourceFile} from '../../src/modules.ts'
import {verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {importedArgumentRunsOnce, importedDefaultRunsOnce} from './imported-caller.ts'

void importedArgumentRunsOnce
void importedDefaultRunsOnce

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

function total(...values: number[]) {
  return values[0]! + values[1]!
}

class Box {
  value = 1

  read(ignored: number) {
    return this.value
  }
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
 * return == 2
 */
function methodReceiverStaysLive(box: Box) {
  return box.read(box.value = 2)
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
`)

const sourceCallFailures = sourceCallChecks.filter(check => check.status !== 'pass')
if (sourceCallFailures.length > 0 || sourceCallChecks.length !== 10) {
  console.error('expected source calls to prepare operands and parameters once')
  console.error(JSON.stringify(sourceCallChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('calls: operands and parameters prepared once')
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
  process.exitCode = 1
} else {
  console.log('calls: caller text stays distinct from callee names')
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
  process.exitCode = 1
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
  process.exitCode = 1
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
  process.exitCode = 1
} else {
  console.log('calls: unsupported spread and binding defaults reported')
}

const importedReport = await verifyFitFiles(['tests/calls/imported-caller.ts'])
if (importedReport.phase !== 'ready' || importedReport.summary.pass !== 2) {
  console.error('expected imported calls to share prepared invocation semantics')
  console.error(JSON.stringify(importedReport, null, 2))
  process.exitCode = 1
} else {
  console.log('calls: imported defaults and side effects prepared once')
}
