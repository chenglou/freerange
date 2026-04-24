export function unannotatedImportedClamp(width: number) {
  return Math.min(width, 320)
}

/** @fit
 * given width: 0..1000
 * result: 0..100
 */
export function importedClampWithBadContract(width: number) {
  return Math.min(width, 320)
}

export type ImportedOptionalRows = {
  rows?: {height: number}[]
}

/** @fit
 * result.length == 4
 * result[2] >= 0
 */
export function importedTupleWithOneOffset(value: number) {
  return [0, 0, Math.abs(value), value]
}
