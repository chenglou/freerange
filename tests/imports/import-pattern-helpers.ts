const importPatternCap = 320
const importPatternGap = 4
export const importedChromeX = 16
export const importedLiteralSpringData = [
  {position: 4},
  {position: 8},
]
export const importedNestedLiteralSpringData = {
  groups: [
    {items: [{position: 4}, {position: 6}]},
    {items: [{position: 8}]},
  ],
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function importedClampWidth(width: number) {
  return Math.min(width, importPatternCap)
}

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export default function defaultImportedClampWidth(width: number) {
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

export class ImportedClassBox {
  constructor(public top: number, public height: number, public width: number) {}

  /** @fit
   * given this.top: 0..1000
   * given this.height: 0..1000
   * return == this.top + this.height
   * return >= this.top
   */
  get bottom() {
    return this.top + this.height
  }

  /** @fit
   * given this.width: 0..1000
   * given this.height: 0..1000
   * return >= 0
   */
  area() {
    return this.width * this.height
  }
}

export type ImportedShapeRows = {
  rows: {height: number}[]
}

export type ImportedPickedRows = Pick<ImportedShapeRows, 'rows'>

export type ImportedTypeFieldSpring = {
  k: number // @fit > 0
  b: number // @fit > 0
}

export type ImportedTypeFieldRows = {
  rows: {
    height: number // @fit 0..40
  }[]
}

export const importedTypeMinWidth = 80

export function importedTypeDouble(value: number) {
  return value * 2
}

export type ImportedScopedTypeWidth = {
  width: number // @fit importedTypeDouble(importedTypeMinWidth)..Infinity
}

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
export function importedTupleCenter(sourceX: number, sourceY: number, targetX: number, targetY: number): [number, number, number, number] {
  const xOffset = Math.abs(targetX - sourceX)
  const yOffset = Math.abs(targetY - sourceY)
  return [sourceX + xOffset, sourceY + yOffset, xOffset, yOffset]
}

/** @fit
 * given min <= max
 * return: min..max
 */
export function importedDynamicRange(min: number, max: number) {
  return min + (max - max)
}

/** @fit
 * return: {rows: {height: 10..20}[]}
 */
export function importedValueSpecRows() {
  return {rows: [{height: 10}, {height: 20}]}
}
