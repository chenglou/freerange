const importPatternCap = 320
const importPatternGap = 4
export const importedChromeX = 16

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
export function importedClampWidth(width: number) {
  return Math.min(width, importPatternCap)
}

/** @fit
 * given value: 0..10
 * result: 4..14
 */
export function importedAddGap(value: number) {
  return value + importPatternGap
}

/** @fit
 * given items[].height: 0..40
 * result.rows[].height: 0..40
 */
export function importedRows(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

export type ImportedShapeRows = {
  rows: {height: number}[]
}

export type ImportedPickedRows = Pick<ImportedShapeRows, 'rows'>

export type ImportedBox<T> = {
  value: T
}

export function importedBox<T>(value: T): ImportedBox<T> {
  return {value}
}
