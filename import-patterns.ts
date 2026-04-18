// Imported helper pattern specimen. Cross-file calls use @fit contracts as summaries.

import {importedAddGap as addImportedGap, importedChromeX, importedClampWidth, importedRows} from './import-pattern-helpers'
import {importedClampWidth as aliasImportedClampWidth} from '@fit-fixtures/import-pattern-helpers'
import {barrelClampWidth, barrelTsxClampWidth} from './import-pattern-barrel'
import {importedTsxClampWidth} from './import-pattern-tsx-helpers'

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function importedHelperContract(width: number) {
  return importedClampWidth(width)
}

/** @fit
 * given value: number[0, 10]
 * result: number[4, 14]
 */
export function importedHelperAliasContract(value: number) {
  return addImportedGap(value)
}

/** @fit
 * given width: number[0, 1000]
 * result == width + importedChromeX
 */
export function importedNumericConstantContract(width: number) {
  return width + importedChromeX
}

/** @fit
 * given items[].height: number[0, 40]
 * result.rows[].height: number[0, 40]
 */
export function importedHelperWildcardContract(items: {height: number}[]) {
  return importedRows(items)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function importedHelperTsconfigAliasContract(width: number) {
  return aliasImportedClampWidth(width)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function importedHelperTsxContract(width: number) {
  return importedTsxClampWidth(width)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function importedHelperBarrelContract(width: number) {
  return barrelClampWidth(width)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function importedHelperBarrelTsxContract(width: number) {
  return barrelTsxClampWidth(width)
}
