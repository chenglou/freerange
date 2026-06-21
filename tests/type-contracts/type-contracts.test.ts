import {describe, setDefaultTimeout, test} from 'bun:test'
import {verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {requiredCheck, testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

describe('type contracts', () => {
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

test('uses TypeScript syntax with range leaves for whole-value contracts', () => {
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
const intersectionValueCheck = requiredCheck(wholeValueTypeSyntaxChecks, {functionName: 'intersectionValue', text: 'return: {left: 0..10} & {width: int 1..5}'})
const genericAliasValueCheck = requiredCheck(wholeValueTypeSyntaxChecks, {functionName: 'genericAliasValue', text: 'return: Box<{tile: ImportedLookingTile & {width: 10..20}}>'})
const genericAliasMissCheck = requiredCheck(wholeValueTypeSyntaxChecks, {functionName: 'genericAliasMiss', text: 'return: Box<{tile: ImportedLookingTile & {width: 10..20}}>'})
if (
  intersectionValueCheck.status !== 'pass'
  || genericAliasValueCheck.status !== 'pass'
  || genericAliasMissCheck.status !== 'fail'
) {
  throw testDiagnosticError('expected whole-value contracts to use TypeScript type syntax with range leaves', wholeValueTypeSyntaxChecks)
}
})

test('inlines type contracts through value boundaries and relations', () => {
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
const inputFieldCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'inputField', text: 'return > 0'})
const goodReturnFailures = typeContractBoundaryChecks.filter(check => check.functionName === 'goodReturn' && check.status !== 'pass')
const badReturnCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'badReturn', text: 'return.k > 0'})
const badLocalCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'badLocal', text: 'spring.k > 0'})
const badSatisfiesCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'badSatisfies', text: 'return.k > 0'})
const badAsCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'badAs', text: 'return.k > 0'})
const inputArrayCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'inputArray', text: 'return.rows[].height: 0..40'})
const badArrayReturnCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'badArrayReturn', text: 'return.rows[].height: 0..40'})
const inputRelationCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'inputRelation', text: 'return > spring.b'})
const badRelationReturnCheck = requiredCheck(typeContractBoundaryChecks, {functionName: 'badRelationReturn', text: 'return.k > return.b'})
if (
  inputFieldCheck.status !== 'pass'
  || goodReturnFailures.length > 0
  || badReturnCheck.status !== 'fail'
  || badLocalCheck.status !== 'fail'
  || badSatisfiesCheck.status !== 'fail'
  || badAsCheck.status !== 'fail'
  || inputArrayCheck.status !== 'pass'
  || badArrayReturnCheck.status !== 'fail'
  || inputRelationCheck.status !== 'pass'
  || badRelationReturnCheck.status !== 'fail'
) {
  throw testDiagnosticError('expected type @fit contracts to inline through inputs, returns, locals, satisfies, as, arrays, and relations', typeContractBoundaryChecks)
}
})

test('preserves generic type constraints without representative arguments', () => {
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
const constrainedGenericReadCheck = requiredCheck(genericTypeContractChecks, {functionName: 'readConstrained', text: 'return > 0'})
const unsafeGenericDeclarationCheck = requiredCheck(genericTypeContractChecks, {functionName: '<type>', text: 'type @fit > 0', line: 29})
const unsafeGenericUseNoise = genericTypeContractChecks.some(check => check.functionName === 'unsafeUse')
if (
  missingGenericTypeFailures.length > 0
  || constrainedGenericReadCheck.status !== 'pass'
  || unsafeGenericDeclarationCheck.status !== 'unknown'
  || unsafeGenericDeclarationCheck.reason?.includes("Type 'T' is not assignable to type 'number'") !== true
  || unsafeGenericUseNoise
) {
  throw testDiagnosticError('expected generic type contracts to preserve constraints without representative type arguments', genericTypeContractChecks)
}
})

test('rejects type contracts with unpreserved inner generic context', () => {
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
const conditionalTypeContextCheck = requiredCheck(unsupportedGenericTypeContextChecks, {functionName: '<type>', text: 'type @fit > 0', line: 2})
const mappedTypeContextCheck = requiredCheck(unsupportedGenericTypeContextChecks, {functionName: '<type>', text: 'type @fit > 0', line: 7})
const nestedGenericTypeContextCheck = requiredCheck(unsupportedGenericTypeContextChecks, {functionName: '<type>', text: 'type @fit > 0', line: 12})
if (
  conditionalTypeContextCheck.status !== 'unknown'
  || conditionalTypeContextCheck.reason?.includes('conditional type branch') !== true
  || mappedTypeContextCheck.status !== 'unknown'
  || mappedTypeContextCheck.reason?.includes('mapped type') !== true
  || nestedGenericTypeContextCheck.status !== 'unknown'
  || nestedGenericTypeContextCheck.reason?.includes('nested generic type member') !== true
) {
  throw testDiagnosticError('expected type contracts with unpreserved inner generic context to be rejected directly', unsupportedGenericTypeContextChecks)
}
})

test('rejects given in type contracts directly', () => {
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
const typeGivenKeywordCheck = requiredCheck(typeGivenKeywordChecks, {functionName: 'read', text: 'given Bar.a > 10'})
if (
  typeGivenKeywordCheck.status !== 'unknown'
  || typeGivenKeywordCheck.reason !== 'type @fit lines do not use given; write the field fact without given'
) {
  throw testDiagnosticError('expected type @fit given keyword to be rejected directly', typeGivenKeywordChecks)
}
})

test('accepts type contract fields whose names start with given', () => {
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
  throw testDiagnosticError('expected type @fit fields starting with given to keep working', typeGivenPrefixFieldChecks)
}
})

test('evaluates free names where a type contract is declared', () => {
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
`)
const scopedTypeReadCheck = requiredCheck(typeContractScopeChecks, {functionName: 'readsScopedType', text: 'return >= 160'})
const usageLocalCaptureCheck = requiredCheck(typeContractScopeChecks, {functionName: 'rejectsUsageLocal', text: 'tile.width: typeScopedDouble(typeScopedMin)..Infinity'})
if (
  scopedTypeReadCheck.status !== 'pass'
  || usageLocalCaptureCheck.status !== 'fail'
) {
  throw testDiagnosticError('expected type @fit contracts to evaluate free names where the type is declared', typeContractScopeChecks)
}
})

test('checks imported type helpers in declaration scope', async () => {
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
const importedGoodCheck = requiredCheck(importedDeclarationScopeChecks, {functionName: 'goodReturn', text: 'return.width: lowerBound(return.width)..Infinity'})
const importedBadCheck = requiredCheck(importedDeclarationScopeChecks, {functionName: 'badReturn', text: 'return.width: lowerBound(return.width)..Infinity'})
const importedScopeLeak = importedDeclarationScopeChecks.some(check => check.reason?.includes("Cannot find name 'lowerBound'"))
if (
  importedGoodCheck.status !== 'pass'
  || importedBadCheck.status !== 'fail'
  || importedScopeLeak
) {
  throw testDiagnosticError('expected imported type @fit helper calls to be checked where the type is declared and proven where values are used', importedDeclarationScopeChecks)
}
})

test('reports imported type helper mistakes at the declaration', async () => {
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
const importedTypeErrorCheck = requiredCheck(importedDeclarationTypeErrorChecks, {functionName: '<type>', text: 'type @fit 0..needsString(width)', line: 7})
const importedUseSiteNameError = importedDeclarationTypeErrorChecks.some(check => check.reason?.includes("Cannot find name 'needsString'"))
const importedSkippedBadReturn = importedDeclarationTypeErrorChecks.some(check => check.functionName === 'badReturn')
if (
  importedTypeErrorCheck.status !== 'unknown'
  || importedTypeErrorCheck.reason?.includes("TS2345: Argument of type 'number' is not assignable to parameter of type 'string'") !== true
  || importedUseSiteNameError
  || importedSkippedBadReturn
) {
  throw testDiagnosticError('expected imported type @fit helper parameter mistakes to be reported at the type declaration', importedDeclarationTypeErrorChecks)
}
})

test('attributes each helper type error to its declaration file', async () => {
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
const widthAttribution = requiredCheck(multiHelperAttributionChecks, {functionName: '<type>', text: 'type @fit 0..needsString(width)', line: 7})
const heightAttribution = requiredCheck(multiHelperAttributionChecks, {functionName: '<type>', text: 'type @fit 0..needsBoolean(height)', line: 7})
if (
  widthAttribution.status !== 'unknown'
  || !widthAttribution.file.endsWith('width-helper.ts')
  || widthAttribution.reason?.includes("not assignable to parameter of type 'string'") !== true
  || heightAttribution.status !== 'unknown'
  || !heightAttribution.file.endsWith('height-helper.ts')
  || heightAttribution.reason?.includes("not assignable to parameter of type 'boolean'") !== true
) {
  throw testDiagnosticError('expected each helper type @fit error to attribute to its own declaration file', multiHelperAttributionChecks)
}
})

test('keeps declaration constraints for imported generic contracts', async () => {
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
const badImportedGenericCheck = requiredCheck(importedGenericTypeChecks, {functionName: 'badImportedBox', text: 'return.width > 0'})
const importedConstrainedReadCheck = requiredCheck(importedGenericTypeChecks, {functionName: 'readImportedPositive', text: 'return > 0'})
const unsafeImportedGenericCheck = requiredCheck(importedGenericTypeChecks, {functionName: '<type>', text: 'type @fit > 0', line: 11})
const unsafeImportedUseNoise = importedGenericTypeChecks.some(check => check.functionName === 'unsafeImportedBox')
if (
  badImportedGenericCheck.status !== 'fail'
  || importedConstrainedReadCheck.status !== 'pass'
  || unsafeImportedGenericCheck.status !== 'unknown'
  || unsafeImportedGenericCheck.reason?.includes("Type 'T' is not assignable to type 'number'") !== true
  || unsafeImportedUseNoise
) {
  throw testDiagnosticError('expected imported generic type contracts to keep their declaration constraints', importedGenericTypeChecks)
}
})

test('compares type contract field relations against the same object', () => {
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
const typeFieldRelationBadCheck = requiredCheck(typeFieldRelationChecks, {functionName: 'badSize', text: 'return.width <= return.maxWidth'})
if (
  typeFieldRelationGoodFailures.length > 0
  || typeFieldRelationBadCheck.status !== 'fail'
) {
  throw testDiagnosticError('expected type @fit field relations to compare against the same object', typeFieldRelationChecks)
}
})

test('keeps exact paths for quoted and numeric static properties', () => {
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
const badQuotedProperty = requiredCheck(staticPropertyContractChecks, {functionName: 'badQuotedLimit', text: 'return["available-width"]: 0..10'})
const badNumericProperty = requiredCheck(staticPropertyContractChecks, {functionName: 'badNumericLimit', text: 'return["0"] > 0'})
if (goodStaticPropertyFailures.length > 0 || badQuotedProperty.status !== 'fail' || badNumericProperty.status !== 'fail') {
  throw testDiagnosticError('expected quoted and numeric static properties to keep their exact contract paths', staticPropertyContractChecks)
}
})

})
