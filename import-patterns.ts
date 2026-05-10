// Imported helper pattern specimen. Cross-file calls use @fit contracts as summaries.

import defaultImportedClampWidth, {ImportedClassBox, importedAddGap as addImportedGap, importedBox, importedChromeX, importedClampWidth, importedLiteralSpringData, importedNestedLiteralSpringData, importedRows, importedTupleCenter} from './import-pattern-helpers'
import * as importedShapes from './import-pattern-helpers'
import type {ImportedPickedRows, ImportedShapeRows, ImportedTypeFieldRows, ImportedTypeFieldSpring} from './import-pattern-helpers'
import {importedClampWidth as aliasImportedClampWidth} from '@fit-fixtures/import-pattern-helpers'
import {declaredClampWidth} from '@fit-fixtures/import-pattern-declared-package'
import importedDefaultMaxAlias, {namedMaxAlias as importedNamedMaxAlias} from './import-pattern-alias-helpers'
import {barrelClampWidth, barrelTsxClampWidth} from './import-pattern-barrel'
import * as importedBarrel from './import-pattern-barrel'
import {importedTsxClampWidth} from './import-pattern-tsx-helpers'

const localAliasMax = Math.max
const {min: localAliasMin} = Math
const copiedLocalAliasMin = localAliasMin
const localImportedClampAlias = importedClampWidth
const localImportedMaxAlias = importedDefaultMaxAlias
const localImportedNamedMaxAlias = importedNamedMaxAlias
const namespaceImportedClampAlias = importedShapes.importedClampWidth

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
function localClampAliasTarget(width: number) {
  return Math.min(Math.max(width, 0), 320)
}

const copiedLocalClampAlias = localClampAliasTarget

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedHelperContract(width: number) {
  return importedClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function defaultImportedHelperContract(width: number) {
  return defaultImportedClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function namespaceImportedHelperContract(width: number) {
  return importedShapes.importedClampWidth(width)
}

/** @fit
 * given value: 0..1000
 * given min <= max
 * return >= min
 * return <= max
 */
export function localMathAliasContract(value: number, min: number, max: number) {
  return copiedLocalAliasMin(localAliasMax(value, min), max)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function localHelperAliasContract(width: number) {
  return copiedLocalClampAlias(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedHelperConstAliasContract(width: number) {
  return localImportedClampAlias(width)
}

/** @fit
 * given value: 0..5
 * return: 10
 */
export function importedDefaultMathAliasContract(value: number) {
  return localImportedMaxAlias(value, 10)
}

/** @fit
 * given value: 0..5
 * return: 10
 */
export function importedNamedMathAliasContract(value: number) {
  return localImportedNamedMaxAlias(value, 10)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function namespaceMemberAliasContract(width: number) {
  return namespaceImportedClampAlias(width)
}

/** @fit
 * given value: 0..10
 * return: 4..14
 */
export function importedHelperAliasContract(value: number) {
  return addImportedGap(value)
}

/** @fit
 * given width: 0..1000
 * return == width + importedChromeX
 */
export function importedNumericConstantContract(width: number) {
  return width + importedChromeX
}

/** @fit
 * given items[].height: 0..40
 * return.rows[].height: 0..40
 */
export function importedHelperWildcardContract(items: {height: number}[]) {
  return importedRows(items)
}

/** @fit
 * given box.top: 0..1000
 * given box.height: 0..1000
 * return >= box.top
 */
export function importedClassGetterContract(box: ImportedClassBox) {
  return box.bottom
}

/** @fit
 * given box.width: 0..1000
 * given box.height: 0..1000
 * return >= 0
 */
export function importedClassMethodContract(box: ImportedClassBox) {
  return box.area()
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedHelperTsconfigAliasContract(width: number) {
  return aliasImportedClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedHelperDeclarationMapContract(width: number) {
  return declaredClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedHelperTsxContract(width: number) {
  return importedTsxClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedHelperBarrelContract(width: number) {
  return barrelClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function namespaceImportedHelperBarrelContract(width: number) {
  return importedBarrel.barrelClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedHelperBarrelTsxContract(width: number) {
  return barrelTsxClampWidth(width)
}

/** @fit
 * return.rows.length >= 0
 */
export function importedTypeShape(input: ImportedShapeRows) {
  return {rows: input.rows}
}

/** @fit
 * return.rows.length >= 0
 */
export function importedUtilityTypeShape(input: ImportedPickedRows) {
  return {rows: input.rows}
}

/** @fit
 * return.rows.length >= 0
 */
export function importedGenericReturnShape(items: {height: number}[]) {
  const boxed = importedBox(items)
  return {rows: boxed.value}
}

/** @fit
 * return.rows.length >= 0
 */
export function namespaceImportedStructuralShape(items: {height: number}[]) {
  const boxed = importedShapes.importedBox(items)
  return {rows: boxed.value}
}

/** @fit
 * return > 0
 */
export function importedTypeFieldParamGiven(spring: ImportedTypeFieldSpring) {
  return spring.k
}

export function importedTypeFieldReturnCheck(): ImportedTypeFieldSpring {
  return {k: 290, b: 30}
}

/** @fit
 * return.rows[].height: 0..40
 */
export function importedTypeFieldArrayElement(input: ImportedTypeFieldRows) {
  const rows = input.rows.map(row => ({height: row.height}))
  return {rows}
}

/** @fit
 * return.rows[].height: 0..40
 */
export function namespaceImportedTypeFieldArrayElement(input: importedShapes.ImportedTypeFieldRows) {
  const rows = input.rows.map(row => ({height: row.height}))
  return {rows}
}

/** @fit
 * return.length == 5
 * return[3] >= 0
 * return[4] >= 0
 */
export function importedTupleSummaryFeedsDestructure(sourceX: number, sourceY: number, targetX: number, targetY: number): [string, number, number, number, number] {
  const [, , offsetX, offsetY] = importedTupleCenter(sourceX, sourceY, targetX, targetY)
  return ['path', 0, 0, offsetX, offsetY]
}

type ImportedLiteralSpring = {
  pos: number
  k: number // @fit > 0
  b: number // @fit > 0
}

function importedLiteralSpring(
  pos: number,
  k: number = 290, // @fit > 0
  b: number = 30, // @fit > 0
): ImportedLiteralSpring {
  return {pos, k, b}
}

type ImportedLiteralSpringBox = {
  spring: ImportedLiteralSpring
}

export function importedLiteralArrayMapDefaultFields(): ImportedLiteralSpringBox[] {
  return importedLiteralSpringData.map(item => ({spring: importedLiteralSpring(item.position)}))
}

export function importedLiteralArrayMapDefaultFieldsThroughIife(): ImportedLiteralSpringBox[] {
  return (() => {
    const marker = {count: 0}
    return importedLiteralSpringData.map(item => {
      marker.count = marker.count + 1
      return {spring: importedLiteralSpring(item.position)}
    })
  })()
}

type ImportedNestedLiteralSpringBox = {
  springs: ImportedLiteralSpring[]
}

export function importedNestedLiteralArrayMapDefaultFields(): ImportedNestedLiteralSpringBox[] {
  return importedNestedLiteralSpringData.groups.map(group => ({
    springs: group.items.map(item => importedLiteralSpring(item.position)),
  }))
}
