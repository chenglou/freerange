// Imported helper negative patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

import {unannotatedImportedClamp} from './negative-import-helpers'

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function negativeImportedHelperNeedsFit(width: number) {
  return unannotatedImportedClamp(width)
}
