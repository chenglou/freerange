// Math vocabulary: rounding, monotonic, bounded outputs.

/** @fit
 * given value: 0..1000
 * given min: 0..100
 * given max: 100..1000
 * given min <= max
 * return >= min
 * return <= max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** @fit
 * given value: 0..1000
 * return: int 0..1000
 */
export function rounded(value: number): number {
  return Math.round(value)
}

/** @fit
 * given value: 0..1000
 * return: int 0..1000
 */
export function floored(value: number): number {
  return Math.floor(value)
}

/** @fit
 * given x: -100..100
 * return: 0..100
 */
export function absolute(x: number): number {
  return Math.abs(x)
}

/** @fit
 * given value: 0..10000
 * return: 0..100
 */
export function root(value: number): number {
  return Math.sqrt(value)
}

// Bounded outputs: sin and cos always return in [-1, 1].

/** @fit
 * given angle: -1000..1000
 * return: -1..1
 */
export function sine(angle: number): number {
  return Math.sin(angle)
}

/** @fit
 * given angle: -1000..1000
 * return: -1..1
 */
export function cosine(angle: number): number {
  return Math.cos(angle)
}
