// Array-method vocabulary: every, some, filter().length, map.
// These TS forms reduce to per-element claims and counts.

/** @fit
 * given items.length: int 0..200
 * given items[].weight: 1..100
 * return == true
 */
export function allWeighable(items: {weight: number}[]): boolean {
  return items.every(item => item.weight >= 1)
}

/** @fit
 * given items.length: int 1..200
 * given items[].weight: 1..100
 * return == true
 */
export function anyWeighable(items: {weight: number}[]): boolean {
  return items.some(item => item.weight > 0)
}

/** @fit
 * given items.length: int 0..200
 * given items[].weight: 1..100
 * return: int 0..200
 */
export function countHeavy(items: {weight: number}[]): number {
  return items.filter(item => item.weight > 50).length
}

/** @fit
 * given items.length: int 0..200
 * given items[].weight: 1..100
 * return: int 0..0
 */
export function noneNegative(items: {weight: number}[]): number {
  return items.filter(item => item.weight < 0).length
}

/** @fit
 * given items.length: int 0..200
 * given items[].weight: 1..100
 * return.length == items.length
 * return[]: 1..100
 */
export function weights(items: {weight: number}[]): number[] {
  return items.map(item => item.weight)
}
