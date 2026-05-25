// Core vocabulary: comparisons over linear expressions, range claims,
// per-element claims, boolean composition.

/** @fit
 * given width: 0..1000
 * given gutter: 0..40
 * return: 0..1000
 * return <= width
 */
export function inner(width: number, gutter: number): number {
  if (width < gutter * 2) return 0
  return width - gutter * 2
}

/** @fit
 * given min: 0..1000
 * given max: 0..1000
 * given value: 0..1000
 * given min <= max
 * return >= min
 * return <= max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** @fit
 * given items.length: int 0..100
 * given items[].weight: 1..100
 * return.length: int 0..100
 * return[]: 1..100
 */
export function weights(items: {weight: number}[]): number[] {
  return items.map(item => item.weight)
}
