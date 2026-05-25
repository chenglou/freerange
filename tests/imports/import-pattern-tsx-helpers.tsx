/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedTsxClampWidth(width: number) {
  return Math.min(width, 320)
}
