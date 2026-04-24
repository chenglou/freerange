// Imported helper pattern specimen. Cross-file calls use @fit contracts as summaries.

import {importedAddGap as addImportedGap, importedBox, importedChromeX, importedClampWidth, importedRows, importedTupleCenter} from './import-pattern-helpers'
import * as importedShapes from './import-pattern-helpers'
import type {ImportedPickedRows, ImportedShapeRows} from './import-pattern-helpers'
import {importedClampWidth as aliasImportedClampWidth} from '@fit-fixtures/import-pattern-helpers'
import {barrelClampWidth, barrelTsxClampWidth} from './import-pattern-barrel'
import {importedTsxClampWidth} from './import-pattern-tsx-helpers'

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function importedHelperContract(width: number) {
  return importedClampWidth(width)
}

/** @fit
 * given value: 0..10
 * result: 4..14
 */
export function importedHelperAliasContract(value: number) {
  return addImportedGap(value)
}

/** @fit
 * given width: 0..1000
 * result == width + importedChromeX
 */
export function importedNumericConstantContract(width: number) {
  return width + importedChromeX
}

/** @fit
 * given items[].height: 0..40
 * result.rows[].height: 0..40
 */
export function importedHelperWildcardContract(items: {height: number}[]) {
  return importedRows(items)
}

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function importedHelperTsconfigAliasContract(width: number) {
  return aliasImportedClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function importedHelperTsxContract(width: number) {
  return importedTsxClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function importedHelperBarrelContract(width: number) {
  return barrelClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function importedHelperBarrelTsxContract(width: number) {
  return barrelTsxClampWidth(width)
}

/** @fit
 * result.rows.length >= 0
 */
export function importedTypeShape(input: ImportedShapeRows) {
  return {rows: input.rows}
}

/** @fit
 * result.rows.length >= 0
 */
export function importedUtilityTypeShape(input: ImportedPickedRows) {
  return {rows: input.rows}
}

/** @fit
 * result.rows.length >= 0
 */
export function importedGenericReturnShape(items: {height: number}[]) {
  const boxed = importedBox(items)
  return {rows: boxed.value}
}

/** @fit
 * result.rows.length >= 0
 */
export function namespaceImportedStructuralShape(items: {height: number}[]) {
  const boxed = importedShapes.importedBox(items)
  return {rows: boxed.value}
}

/** @fit
 * result.length == 5
 * result[3] >= 0
 * result[4] >= 0
 */
export function importedTupleSummaryFeedsDestructure(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const [, , offsetX, offsetY] = importedTupleCenter(sourceX, sourceY, targetX, targetY)
  return ['path', 0, 0, offsetX, offsetY]
}
