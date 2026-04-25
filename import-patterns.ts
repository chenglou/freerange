// Imported helper pattern specimen. Cross-file calls use @fit contracts as summaries.

import defaultImportedClampWidth, {importedAddGap as addImportedGap, importedBox, importedChromeX, importedClampWidth, importedRows, importedTupleCenter} from './import-pattern-helpers'
import * as importedShapes from './import-pattern-helpers'
import type {ImportedPickedRows, ImportedShapeRows} from './import-pattern-helpers'
import {importedClampWidth as aliasImportedClampWidth} from '@fit-fixtures/import-pattern-helpers'
import {barrelClampWidth, barrelTsxClampWidth} from './import-pattern-barrel'
import {importedTsxClampWidth} from './import-pattern-tsx-helpers'

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
 * return.length == 5
 * return[3] >= 0
 * return[4] >= 0
 */
export function importedTupleSummaryFeedsDestructure(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const [, , offsetX, offsetY] = importedTupleCenter(sourceX, sourceY, targetX, targetY)
  return ['path', 0, 0, offsetX, offsetY]
}
