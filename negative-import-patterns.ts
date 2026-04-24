// Imported helper negative patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

import {importedClampWithBadContract, importedTupleWithOneOffset, unannotatedImportedClamp} from './negative-import-helpers'
import {barrelClampWidth} from './import-pattern-barrel'
import {importedChromeX, importedClampWidth} from './import-pattern-helpers'
import {barrelUnannotatedClamp} from './negative-import-barrel'
import type {ImportedOptionalRows} from './negative-import-helpers'
// @ts-expect-error default import fixture for Freerange's unsupported import-shape report.
import defaultImportedClamp from './import-pattern-helpers'
// @ts-expect-error unresolved import fixture for Freerange's TypeScript resolver boundary.
import {missingImportedClamp} from '@fit-fixtures/missing-import-helper'

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function negativeImportedHelperNeedsFit(width: number) {
  return unannotatedImportedClamp(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function negativeImportedHelperUnresolved(width: number) {
  return missingImportedClamp(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function negativeImportedHelperReExportNeedsFit(width: number) {
  return barrelUnannotatedClamp(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function negativeImportedHelperDefaultImportUnsupported(width: number) {
  return defaultImportedClamp(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..100
 */
export function negativeImportedHelperSourceContractFails(width: number) {
  return importedClampWithBadContract(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..100
 */
export function negativeImportedHelperContractTooWide(width: number) {
  return importedClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * result: 0..100
 */
export function negativeImportedHelperReExportContractTooWide(width: number) {
  return barrelClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * result == width + importedChromeX + 1
 */
export function negativeImportedNumericConstantMismatch(width: number) {
  return width + importedChromeX
}

/** @fit
 * result.rows.length >= 0
 */
export function negativeOptionalImportedShape(input: ImportedOptionalRows) {
  return {rows: input.rows}
}

/** @fit
 * result[4] >= 0
 */
export function negativeImportedTupleSummaryDoesNotApplyToEverySlot(value: number) {
  const [, , offsetX, offsetY] = importedTupleWithOneOffset(value)
  return ['path', 0, 0, offsetX, offsetY]
}
