export function unannotatedImportedClamp(width: number) {
  return Math.min(width, 320)
}

export default function unannotatedDefaultImportedClamp(width: number) {
  return Math.min(width, 320)
}

/** @fit
 * given width: 0..1000
 * return: 0..100
 */
export function importedClampWithBadContract(width: number) {
  return Math.min(width, 320)
}

export type ImportedOptionalRows = {
  rows?: {height: number}[]
}

/** @fit
 * return.length == 4
 * return[2] >= 0
 */
export function importedTupleWithOneOffset(value: number) {
  return [0, 0, Math.abs(value), value]
}
