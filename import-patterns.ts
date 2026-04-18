// Imported helper pattern specimen. Cross-file calls use @fit contracts as summaries.

import {importedAddGap as addImportedGap, importedClampWidth, importedRows} from './import-pattern-helpers'

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
 * given items[].height: number[0, 40]
 * result.rows[].height: number[0, 40]
 */
export function importedHelperWildcardContract(items: {height: number}[]) {
  return importedRows(items)
}
