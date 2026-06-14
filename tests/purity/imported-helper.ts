/** @fit
 * return == 10
 */
export function importedPure() {
  return 10
}

export function importedImpure() {
  return Math.random()
}

export const importedStable = 10

function increment(value: number) {
  return value + 1
}

/** @fit
 * given value: 0..10
 * return == value + 1
 */
export function importedPureCallback(value: number) {
  return increment(value)
}

export default function importedDefaultPure() {
  return 10
}
