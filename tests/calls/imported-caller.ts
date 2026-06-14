import {choose, chooseDestructured, keep} from './imported-helper.ts'

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

/** @fit
 * return == 2
 */
export function importedDestructuredDefaultUsesFinalBinding() {
  return chooseDestructured({value: 1})
}
