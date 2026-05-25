import {verifyFitSource} from '../../src/reports.ts'

const wholeValueTypeSyntaxChecks = verifyFitSource('whole-value-type-syntax.ts', `type Box<T> = {
  value: T
}

type ImportedLookingTile = {
  width: number
}

/** @fit
 * return: {left: 0..10} & {width: int 1..5}
 */
function intersectionValue() {
  return {left: 5, width: 3}
}

/** @fit
 * return: Box<{tile: ImportedLookingTile & {width: 10..20}}>
 */
function genericAliasValue() {
  return {value: {tile: {width: 15}}}
}

/** @fit
 * return: Box<{tile: ImportedLookingTile & {width: 10..20}}>
 */
function genericAliasMiss() {
  return {value: {tile: {width: 30}}}
}
`)
const intersectionValueCheck = wholeValueTypeSyntaxChecks.find(check => check.functionName === 'intersectionValue' && check.text.startsWith('return: {left'))
const genericAliasValueCheck = wholeValueTypeSyntaxChecks.find(check => check.functionName === 'genericAliasValue' && check.text.startsWith('return: Box'))
const genericAliasMissCheck = wholeValueTypeSyntaxChecks.find(check => check.functionName === 'genericAliasMiss' && check.text.startsWith('return: Box'))
if (
  intersectionValueCheck?.status !== 'pass'
  || genericAliasValueCheck?.status !== 'pass'
  || genericAliasMissCheck?.status !== 'fail'
) {
  console.error('expected whole-value contracts to use TypeScript type syntax with range leaves')
  console.error(JSON.stringify(wholeValueTypeSyntaxChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('whole-value contracts: TypeScript type syntax')
}

const typeContractBoundaryChecks = verifyFitSource('type-contract-boundaries.ts', `type Spring = {
  k: number // @fit > 0
  b: number // @fit >= 0
}

type SpringRows = {
  rows: {
    height: number // @fit 0..40
  }[]
}

/** @fit
 * k > b
 */
type OrderedSpring = {
  k: number
  b: number
}

/** @fit
 * return > 0
 */
function inputField(spring: Spring) {
  return spring.k
}

function goodReturn(): Spring {
  return {k: 1, b: 0}
}

function badReturn(): Spring {
  return {k: -1, b: 0}
}

function badLocal() {
  const spring: Spring = {k: -1, b: 0}
  return spring
}

function badSatisfies() {
  return {k: -1, b: 0} satisfies Spring
}

function badAs() {
  return {k: -1, b: 0} as Spring
}

/** @fit
 * return.rows[].height: 0..40
 */
function inputArray(input: SpringRows) {
  return {rows: input.rows.map(row => ({height: row.height}))}
}

function badArrayReturn(): SpringRows {
  return {rows: [{height: 100}]}
}

/** @fit
 * return > spring.b
 */
function inputRelation(spring: OrderedSpring) {
  return spring.k
}

function badRelationReturn(): OrderedSpring {
  return {k: 1, b: 2}
}
`)
const inputFieldCheck = typeContractBoundaryChecks.find(check => check.functionName === 'inputField' && check.text === 'return > 0')
const goodReturnFailures = typeContractBoundaryChecks.filter(check => check.functionName === 'goodReturn' && check.status !== 'pass')
const badReturnCheck = typeContractBoundaryChecks.find(check => check.functionName === 'badReturn' && check.status === 'fail')
const badLocalCheck = typeContractBoundaryChecks.find(check => check.functionName === 'badLocal' && check.status === 'fail')
const badSatisfiesCheck = typeContractBoundaryChecks.find(check => check.functionName === 'badSatisfies' && check.status === 'fail')
const badAsCheck = typeContractBoundaryChecks.find(check => check.functionName === 'badAs' && check.status === 'fail')
const inputArrayCheck = typeContractBoundaryChecks.find(check => check.functionName === 'inputArray' && check.text === 'return.rows[].height: 0..40')
const badArrayReturnCheck = typeContractBoundaryChecks.find(check => check.functionName === 'badArrayReturn' && check.status === 'fail')
const inputRelationCheck = typeContractBoundaryChecks.find(check => check.functionName === 'inputRelation' && check.text === 'return > spring.b')
const badRelationReturnCheck = typeContractBoundaryChecks.find(check => check.functionName === 'badRelationReturn' && check.status === 'fail')
if (
  inputFieldCheck?.status !== 'pass'
  || goodReturnFailures.length > 0
  || badReturnCheck == null
  || badLocalCheck == null
  || badSatisfiesCheck == null
  || badAsCheck == null
  || inputArrayCheck?.status !== 'pass'
  || badArrayReturnCheck == null
  || inputRelationCheck?.status !== 'pass'
  || badRelationReturnCheck == null
) {
  console.error('expected type @fit contracts to inline through inputs, returns, locals, satisfies, as, arrays, and relations')
  console.error(JSON.stringify(typeContractBoundaryChecks, null, 2))
  process.exitCode = 1
} else {
  console.log('type contracts: annotation boundaries')
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
