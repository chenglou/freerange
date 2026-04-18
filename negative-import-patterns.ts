// Imported helper negative patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

import {unannotatedImportedClamp} from './negative-import-helpers'
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
