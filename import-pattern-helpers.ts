const importPatternCap = 320
const importPatternGap = 4

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function importedClampWidth(width: number) {
  return Math.min(width, importPatternCap)
}

/** @fit
 * given value: number[0, 10]
 * result: number[4, 14]
 */
export function importedAddGap(value: number) {
  return value + importPatternGap
}
