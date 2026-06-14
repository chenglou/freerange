/** @fit
 * return == 10
 */
export function importedPure() {
  return 10
}

export function importedImpure() {
  return Math.random()
}

export default function importedDefaultPure() {
  return 10
}
