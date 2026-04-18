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
