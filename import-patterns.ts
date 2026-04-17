// Imported helper pattern specimen. Cross-file calls use @fit contracts as summaries.

import {importedAddGap as addImportedGap, importedClampWidth} from './import-pattern-helpers'

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
