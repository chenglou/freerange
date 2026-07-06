import {importedOffset, importedPad} from './module-imports-helper'

// importedPad resolves to `export const importedPad = 7`, so the read carries exactly 7.
export function paddedBy(width: number): number {
  return Math.max(0, width) + importedPad
}

// importedOffset is a `let` export; the exporting module can reassign it, so the read stops.
export function shiftedBy(width: number): number {
  return width + importedOffset
}
