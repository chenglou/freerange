/** @fit
 * return == value
 */
export function keep(value: number) {
  return value
}

/** @fit
 * return == right
 */
export function choose(left: number, right: number | undefined = left + 1) {
  return right
}

/** @fit
 * given value == 2
 * return == value
 */
export function chooseDestructured({value}: {value: number}, _ignored = value = 2) {
  return value
}
