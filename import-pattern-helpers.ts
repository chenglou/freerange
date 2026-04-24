const importPatternCap = 320
const importPatternGap = 4
export const importedChromeX = 16

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedClampWidth(width: number) {
  return Math.min(width, importPatternCap)
}

/** @fit
 * given value: 0..10
 * return: 4..14
 */
export function importedAddGap(value: number) {
  return value + importPatternGap
}

/** @fit
 * given items[].height: 0..40
 * return.rows[].height: 0..40
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

/** @fit
 * return.length == 4
 * return[2] >= 0
 * return[3] >= 0
 */
export function importedTupleCenter(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const xOffset = Math.abs(targetX - sourceX)
  const yOffset = Math.abs(targetY - sourceY)
  return [sourceX + xOffset, sourceY + yOffset, xOffset, yOffset]
}
