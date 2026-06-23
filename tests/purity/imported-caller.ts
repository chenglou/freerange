import {
  importedImpure as noisy,
  importedPure as identity,
  importedPureCallback,
  importedStable,
} from './imported-barrel.ts'
import * as importedHelpers from './imported-barrel.ts'
import importedDefaultPure from './imported-helper.ts'

/** @fit
 * pure
 */
export function importedAliasPure() {
  return identity()
}

/** @fit
 * pure
 */
export function importedAliasImpure() {
  return noisy()
}

/** @fit
 * pure
 */
export function importedNamespacePure() {
  return importedHelpers.importedPure()
}

/** @fit
 * pure
 */
export function importedNamespaceImpure() {
  return importedHelpers.importedImpure()
}

/** @fit
 * pure
 */
export function importedNamespaceReassignedUnknown() {
  return importedHelpers.importedReassigned()
}

/** @fit
 * pure
 */
export function importedDefaultAliasPure() {
  return importedDefaultPure()
}

/** @fit
 * pure
 */
export function importedPrimitivePure() {
  return importedStable
}

/** @fit
 * pure
 */
export function importedNamespacePrimitivePure() {
  return importedHelpers.importedStable
}

/** @fit
 * return <= identity()
 */
export function contractUsesImportedAlias() {
  return 0
}

/** @fit
 * return <= noisy()
 */
export function contractRejectsImportedAlias() {
  return 0
}

/** @fit
 * return >= 0
 */
export function importedNamedCallbackKeepsSourceProgram(values: number[]) {
  values.map(importedPureCallback)
  return values.length
}

/** @fit
 * return <= importedPureCallback(0)
 */
export function contractUsesImportedCallbackAfterMap() {
  return 0
}
