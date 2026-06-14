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
