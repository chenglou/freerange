import {choose, keep} from './imported-helper.ts'

/** @fit
 * return == 1
 */
export function importedArgumentRunsOnce() {
  let count = 0
  keep(count++)
  return count
}

/** @fit
 * return == 1
 */
export function importedDefaultRunsOnce() {
  return choose(0)
}
