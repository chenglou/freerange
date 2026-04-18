// Imported helper negative patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

import {unannotatedImportedClamp} from './negative-import-helpers'
import {barrelClampWidth} from './import-pattern-barrel'
import {importedClampWidth} from './import-pattern-helpers'
import {barrelUnannotatedClamp} from './negative-import-barrel'
// @ts-expect-error unresolved import fixture for Freerange's TypeScript resolver boundary.
import {missingImportedClamp} from '@fit-fixtures/missing-import-helper'

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function negativeImportedHelperNeedsFit(width: number) {
  return unannotatedImportedClamp(width)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function negativeImportedHelperUnresolved(width: number) {
  return missingImportedClamp(width)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function negativeImportedHelperReExportNeedsFit(width: number) {
  return barrelUnannotatedClamp(width)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 100]
 */
export function negativeImportedHelperContractTooWide(width: number) {
  return importedClampWidth(width)
}

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 100]
 */
export function negativeImportedHelperReExportContractTooWide(width: number) {
  return barrelClampWidth(width)
}
