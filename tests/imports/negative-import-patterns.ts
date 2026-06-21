// Imported helper negative patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

import unannotatedDefaultImportedClamp, {NegativeImportedClassBox, importedClampWithBadContract, importedTupleWithOneOffset, unannotatedImportedClamp} from './negative-import-helpers'
import {barrelClampWidth} from './import-pattern-barrel'
import * as importPatternBarrel from './import-pattern-barrel'
import {importedChromeX, importedClampWidth} from './import-pattern-helpers'
import {barrelUnannotatedClamp} from './negative-import-barrel'
import {unmappedDeclaredClampWidth} from '@fit-fixtures/import-pattern-declared-package-no-map'
import type {ImportedOptionalRows, NegativeImportedTypeFieldRows, NegativeImportedTypeFieldSpring} from './negative-import-helpers'
// @ts-expect-error unresolved import fixture for Freerange's TypeScript resolver boundary.
import {missingImportedClamp} from '@fit-fixtures/missing-import-helper'

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function negativeImportedHelperNeedsFit(width: number) {
  return unannotatedImportedClamp(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function negativeImportedHelperUnresolved(width: number) {
  return missingImportedClamp(width) // oxlint-disable-line typescript/no-unsafe-return, typescript/no-unsafe-call
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function negativeImportedHelperDeclarationMapMissing(width: number) {
  return unmappedDeclaredClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function negativeImportedHelperReExportNeedsFit(width: number) {
  return barrelUnannotatedClamp(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function negativeImportedHelperDefaultImportNeedsFit(width: number) {
  return unannotatedDefaultImportedClamp(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..100
 */
export function negativeImportedHelperSourceContractFails(width: number) {
  return importedClampWithBadContract(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..100
 */
export function negativeImportedHelperContractTooWide(width: number) {
  return importedClampWidth(width)
}

/** @fit
 * given box.top: 0..1000
 * return >= box.top
 */
export function negativeImportedClassGetterNeedsThisGiven(box: NegativeImportedClassBox) {
  return box.bottom
}

/** @fit
 * given width: 0..1000
 * return: 0..100
 */
export function negativeImportedHelperReExportContractTooWide(width: number) {
  return barrelClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return: 0..100
 */
export function negativeNamespaceImportedHelperReExportContractTooWide(width: number) {
  return importPatternBarrel.barrelClampWidth(width)
}

/** @fit
 * given width: 0..1000
 * return == width + importedChromeX + 1
 */
export function negativeImportedNumericConstantMismatch(width: number) {
  return width + importedChromeX
}

/** @fit
 * return.rows.length >= 0
 */
export function negativeOptionalImportedShape(input: ImportedOptionalRows) {
  return {rows: input.rows}
}

export function negativeImportedTypeFieldReturnCheck(): NegativeImportedTypeFieldSpring {
  return {k: -1, b: 1}
}

export function negativeImportedTypeFieldArrayElement(): NegativeImportedTypeFieldRows {
  return {rows: [{height: 100}]}
}

/** @fit
 * return[4] >= 0
 */
export function negativeImportedTupleSummaryDoesNotApplyToEverySlot(value: number): [string, number, number, number, number] {
  const [, , offsetX, offsetY] = importedTupleWithOneOffset(value)
  return ['path', 0, 0, offsetX, offsetY]
}
