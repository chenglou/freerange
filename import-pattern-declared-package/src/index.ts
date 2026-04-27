/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function declaredClampWidth(width: number) {
  return Math.min(width, 320)
}
