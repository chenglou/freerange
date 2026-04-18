/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function importedTsxClampWidth(width: number) {
  return Math.min(width, 320)
}
