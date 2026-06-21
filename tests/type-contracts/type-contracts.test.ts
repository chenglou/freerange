import {verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {testSuite} from '../test-suite.ts'
import {formatTestDiagnostics} from '../test-diagnostics.ts'

testSuite('type contracts suite', async suite => {
async function verifyTempFitFiles(files: Record<string, string>) {
  const dir = pathJoin('/tmp', `freerange-type-contract-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`)
  const mkdir = Bun.spawnSync({cmd: ['mkdir', '-p', dir]})
  if (mkdir.exitCode !== 0) throw new Error(`Could not create ${dir}`)
  try {
    for (const [name, source] of Object.entries(files)) await Bun.write(pathJoin(dir, name), source)
    return (await verifyFitFiles([pathJoin(dir, 'user.ts')])).checks
  } finally {
    Bun.spawnSync({cmd: ['rm', '-rf', dir]})
  }
}

function pathJoin(first: string, ...rest: string[]) {
  let path = first.endsWith('/') ? first.slice(0, -1) : first
  for (const part of rest) path += '/' + part.replace(/^\/+/, '')
  return path
}

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
  console.error(formatTestDiagnostics(wholeValueTypeSyntaxChecks))
  suite.fail()
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
  console.error(formatTestDiagnostics(typeContractBoundaryChecks))
  suite.fail()
}

const genericTypeContractChecks = verifyFitSource('generic-type-contracts.ts', `type AliasBox<T> = {
  width: number // @fit > 0
  value: T
}

interface InterfaceBox<T> {
  width: number // @fit > 0
  value: T
}

type ConstrainedBox<T extends number> = {
  value: T // @fit > 0
}

type NestedBox<T, U> = {
  nested: {
    width: number // @fit > 0
    payload: T
  }
  other: U
}

type DefaultBox<out T = string> = {
  width: number // @fit > 0
  value: T
}

type UnsafeBox<T> = {
  value: T // @fit > 0
}

function badAlias(): AliasBox<string> {
  return {width: -1, value: "value"}
}

function badInterface(): InterfaceBox<string> {
  return {width: -1, value: "value"}
}

function badConstrained(): ConstrainedBox<number> {
  return {value: -1}
}

function badNested(): NestedBox<string, boolean> {
  return {nested: {width: -1, payload: "value"}, other: true}
}

function badDefault(): DefaultBox {
  return {width: -1, value: "value"}
}

/** @fit
 * return > 0
 */
function readConstrained<T extends number>(box: ConstrainedBox<T>) {
  return box.value
}

function unsafeUse(): UnsafeBox<string> {
  return {value: "value"}
}
`)
const badGenericTypeFunctions = ['badAlias', 'badInterface', 'badConstrained', 'badNested', 'badDefault']
const missingGenericTypeFailures = badGenericTypeFunctions.filter(functionName =>
  !genericTypeContractChecks.some(check => check.functionName === functionName && check.status === 'fail')
)
const constrainedGenericReadCheck = genericTypeContractChecks.find(check => check.functionName === 'readConstrained' && check.text === 'return > 0')
const unsafeGenericDeclarationCheck = genericTypeContractChecks.find(check => check.functionName === '<type>' && check.text === 'type @fit > 0')
const unsafeGenericUseNoise = genericTypeContractChecks.find(check => check.functionName === 'unsafeUse')
if (
  missingGenericTypeFailures.length > 0
  || constrainedGenericReadCheck?.status !== 'pass'
  || unsafeGenericDeclarationCheck?.status !== 'unknown'
  || unsafeGenericDeclarationCheck.reason?.includes("Type 'T' is not assignable to type 'number'") !== true
  || unsafeGenericUseNoise != null
) {
  console.error('expected generic type contracts to preserve constraints without representative type arguments')
  console.error(formatTestDiagnostics(genericTypeContractChecks))
  suite.fail()
}

const unsupportedGenericTypeContextChecks = verifyFitSource('unsupported-generic-type-contexts.ts', `type ConditionalBox<T> = T extends number ? {
  value: T // @fit > 0
} : never

type MappedBox<T> = {
  [K in keyof T]: {
    value: T[K] // @fit > 0
  }
}

type GenericFactory = <T>() => {
  value: T // @fit > 0
}
`)
const conditionalTypeContextCheck = unsupportedGenericTypeContextChecks.find(check => check.text === 'type @fit > 0' && check.reason?.includes('conditional type branch'))
const mappedTypeContextCheck = unsupportedGenericTypeContextChecks.find(check => check.text === 'type @fit > 0' && check.reason?.includes('mapped type'))
const nestedGenericTypeContextCheck = unsupportedGenericTypeContextChecks.find(check => check.text === 'type @fit > 0' && check.reason?.includes('nested generic type member'))
if (
  conditionalTypeContextCheck?.status !== 'unknown'
  || mappedTypeContextCheck?.status !== 'unknown'
  || nestedGenericTypeContextCheck?.status !== 'unknown'
) {
  console.error('expected type contracts with unpreserved inner generic context to be rejected directly')
  console.error(formatTestDiagnostics(unsupportedGenericTypeContextChecks))
  suite.fail()
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
  console.error(formatTestDiagnostics(typeGivenKeywordChecks))
  suite.fail()
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
  console.error(formatTestDiagnostics(typeGivenPrefixFieldChecks))
  suite.fail()
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
const missingDeclarationNameCheck = typeContractScopeChecks.find(check => check.functionName === '<type>' && check.text === 'type @fit missingTypeMin..Infinity')
if (
  scopedTypeReadCheck?.status !== 'pass'
  || usageLocalCaptureCheck?.status !== 'fail'
  || missingDeclarationNameCheck?.status !== 'unknown'
  || missingDeclarationNameCheck.reason?.includes("TS2304: Cannot find name 'missingTypeMin'") !== true
) {
  console.error('expected type @fit contracts to evaluate free names where the type is declared')
  console.error(formatTestDiagnostics(typeContractScopeChecks))
  suite.fail()
}

const importedDeclarationScopeChecks = await verifyTempFitFiles({
  'helper.ts': `export function lowerBound(value: number) {
  void value
  return 0
}

export type ImportedWidth = {
  width: number // @fit lowerBound(width)..Infinity
}
`,
  'user.ts': `import type {ImportedWidth} from './helper'

export function goodReturn(): ImportedWidth {
  return {width: 5}
}

export function badReturn(): ImportedWidth {
  return {width: -1}
}
`,
})
const importedGoodCheck = importedDeclarationScopeChecks.find(check => check.functionName === 'goodReturn' && check.text === 'return.width: lowerBound(return.width)..Infinity')
const importedBadCheck = importedDeclarationScopeChecks.find(check => check.functionName === 'badReturn' && check.text === 'return.width: lowerBound(return.width)..Infinity')
const importedScopeLeak = importedDeclarationScopeChecks.find(check => check.reason?.includes("Cannot find name 'lowerBound'"))
if (
  importedGoodCheck?.status !== 'pass'
  || importedBadCheck?.status !== 'fail'
  || importedScopeLeak != null
) {
  console.error('expected imported type @fit helper calls to be checked where the type is declared and proven where values are used')
  console.error(formatTestDiagnostics(importedDeclarationScopeChecks))
  suite.fail()
}

const importedDeclarationTypeErrorChecks = await verifyTempFitFiles({
  'helper.ts': `export function needsString(value: string) {
  void value
  return 0
}

export type ImportedWidth = {
  width: number // @fit 0..needsString(width)
}
`,
  'user.ts': `import type {ImportedWidth} from './helper'

export function badReturn(): ImportedWidth {
  return {width: -1}
}
`,
})
const importedTypeErrorCheck = importedDeclarationTypeErrorChecks.find(check => check.functionName === '<type>' && check.text === 'type @fit 0..needsString(width)')
const importedUseSiteNameError = importedDeclarationTypeErrorChecks.find(check => check.reason?.includes("Cannot find name 'needsString'"))
const importedSkippedBadReturn = importedDeclarationTypeErrorChecks.find(check => check.functionName === 'badReturn')
if (
  importedTypeErrorCheck?.status !== 'unknown'
  || importedTypeErrorCheck.reason?.includes("TS2345: Argument of type 'number' is not assignable to parameter of type 'string'") !== true
  || importedUseSiteNameError != null
  || importedSkippedBadReturn != null
) {
  console.error('expected imported type @fit helper parameter mistakes to be reported at the type declaration')
  console.error(formatTestDiagnostics(importedDeclarationTypeErrorChecks))
  suite.fail()
}

// Two helpers, each with its own ill-typed type @fit, referenced from one
// user file: three contract twins share the type-check program, so each
// twin's diagnostics must attribute to its own file. Diagnostic offsets are
// file-local, so matching them against a pooled span list would land one
// helper's error on the other helper's (or the user's) line.
const multiHelperAttributionChecks = await verifyTempFitFiles({
  'width-helper.ts': `export function needsString(value: string) {
  void value
  return 0
}

export type WidthBox = {
  width: number // @fit 0..needsString(width)
}
`,
  'height-helper.ts': `export function needsBoolean(value: boolean) {
  void value
  return 0
}

export type HeightBox = {
  height: number // @fit 0..needsBoolean(height)
}
`,
  'user.ts': `import type {WidthBox} from './width-helper'
import type {HeightBox} from './height-helper'

export function buildWidth(): WidthBox {
  return {width: 1}
}

export function buildHeight(): HeightBox {
  return {height: 1}
}
`,
})
const widthAttribution = multiHelperAttributionChecks.find(check => check.text === 'type @fit 0..needsString(width)')
const heightAttribution = multiHelperAttributionChecks.find(check => check.text === 'type @fit 0..needsBoolean(height)')
if (
  widthAttribution?.status !== 'unknown'
  || !(widthAttribution.file?.endsWith('width-helper.ts') ?? false)
  || widthAttribution.reason?.includes("not assignable to parameter of type 'string'") !== true
  || heightAttribution?.status !== 'unknown'
  || !(heightAttribution.file?.endsWith('height-helper.ts') ?? false)
  || heightAttribution.reason?.includes("not assignable to parameter of type 'boolean'") !== true
) {
  console.error('expected each helper type @fit error to attribute to its own declaration file')
  console.error(formatTestDiagnostics(multiHelperAttributionChecks))
  suite.fail()
}

const importedGenericTypeChecks = await verifyTempFitFiles({
  'helper.ts': `export type ImportedBox<T> = {
  width: number // @fit > 0
  payload: T
}

export type ImportedPositive<T extends number> = {
  value: T // @fit > 0
}

export type ImportedUnsafe<T> = {
  value: T // @fit > 0
}
`,
  'user.ts': `import type {ImportedBox, ImportedPositive, ImportedUnsafe} from './helper'

export function badImportedBox(): ImportedBox<string> {
  return {width: -1, payload: "value"}
}

/** @fit
 * return > 0
 */
export function readImportedPositive<T extends number>(box: ImportedPositive<T>) {
  return box.value
}

export function unsafeImportedBox(): ImportedUnsafe<string> {
  return {value: "value"}
}
`,
})
const badImportedGenericCheck = importedGenericTypeChecks.find(check => check.functionName === 'badImportedBox' && check.status === 'fail')
const importedConstrainedReadCheck = importedGenericTypeChecks.find(check => check.functionName === 'readImportedPositive' && check.text === 'return > 0')
const unsafeImportedGenericCheck = importedGenericTypeChecks.find(check => check.functionName === '<type>' && check.text === 'type @fit > 0')
const unsafeImportedUseNoise = importedGenericTypeChecks.find(check => check.functionName === 'unsafeImportedBox')
if (
  badImportedGenericCheck == null
  || importedConstrainedReadCheck?.status !== 'pass'
  || unsafeImportedGenericCheck?.status !== 'unknown'
  || unsafeImportedGenericCheck.reason?.includes("Type 'T' is not assignable to type 'number'") !== true
  || unsafeImportedUseNoise != null
) {
  console.error('expected imported generic type contracts to keep their declaration constraints')
  console.error(formatTestDiagnostics(importedGenericTypeChecks))
  suite.fail()
}

const typeFieldRelationChecks = verifyFitSource('type-field-relation.ts', `type Size = {
  maxWidth: number
  width: number // @fit <= maxWidth
}

function goodSize(): Size {
  return {maxWidth: 10, width: 5}
}

function badSize(): Size {
  return {maxWidth: 10, width: 15}
}
`)
const typeFieldRelationGoodFailures = typeFieldRelationChecks.filter(check => check.functionName === 'goodSize' && check.status !== 'pass')
const typeFieldRelationBadCheck = typeFieldRelationChecks.find(check => check.functionName === 'badSize' && check.text === 'return.width <= return.maxWidth')
if (
  typeFieldRelationGoodFailures.length > 0
  || typeFieldRelationBadCheck?.status !== 'fail'
) {
  console.error('expected type @fit field relations to compare against the same object')
  console.error(formatTestDiagnostics(typeFieldRelationChecks))
  suite.fail()
}

const staticPropertyContractChecks = verifyFitSource('type-static-properties.ts', `
type Limits = {
  "available-width": number // @fit 0..10
  0: number // @fit > 0
}

function goodLimits(): Limits {
  return {"available-width": 5, 0: 1}
}

function badQuotedLimit(): Limits {
  return {"available-width": 20, 0: 1}
}

function badNumericLimit(): Limits {
  return {"available-width": 5, 0: 0}
}
`)
const goodStaticPropertyFailures = staticPropertyContractChecks.filter(check => check.functionName === 'goodLimits' && check.status !== 'pass')
const badQuotedProperty = staticPropertyContractChecks.find(check => check.functionName === 'badQuotedLimit' && check.status === 'fail')
const badNumericProperty = staticPropertyContractChecks.find(check => check.functionName === 'badNumericLimit' && check.status === 'fail')
if (goodStaticPropertyFailures.length > 0 || badQuotedProperty == null || badNumericProperty == null) {
  console.error('expected quoted and numeric static properties to keep their exact contract paths')
  console.error(formatTestDiagnostics(staticPropertyContractChecks))
  suite.fail()
}

})
