/** @fit
 * given value: 0..10
 * return: 0..10
 */
function accepts(value: number) {
  return value
}

export function passes() {
  return accepts(5)
}

/** @fit
 * given value: 20..30
 */
export function failsWithRange(value: number) {
  return accepts(value)
}

export function requiresMixedRange(flag: boolean) {
  return accepts(flag ? 5 : 20)
}

/** @fit
 * given value: 5..15
 */
export function requiresOverlappingRange(value: number) {
  return accepts(value)
}

/** @fit
 * given left <= right
 * return == left
 */
function acceptsOrder(left: number, right: number) {
  if (left <= right) return left
  return left
}

export function passesWithComparison() {
  return acceptsOrder(0, 1)
}

/** @fit
 * given left: 20..30
 * given right: 0..10
 */
export function failsWithComparison(left: number, right: number) {
  return acceptsOrder(left, right)
}

export function requiresMixedComparison(flag: boolean) {
  return acceptsOrder(flag ? 5 : 20, 10)
}

/** @fit
 * given value: 5..15
 */
export function requiresOverlappingComparison(value: number) {
  return acceptsOrder(value, 10)
}

export function requires(value: number) {
  return accepts(value)
}

export function unknown(getValue: () => number) {
  return accepts(getValue())
}
