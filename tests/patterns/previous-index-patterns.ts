/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given gap: 0..10
 * return.rows[$i].rowRect.y == return.rows[$i - 1].rowRect.y + (return.rows[$i - 1].rowRect.height + gap)
 * return.rows[$i - 1].rowRect.y + (return.rows[$i - 1].rowRect.height + gap) == return.rows[$i].rowRect.y
 * return.rows[$i - 1].rowRect.y <= return.rows[$i].rowRect.y
 * return.rows[$i].rowRect.y >= return.rows[$i - 1].rowRect.y
 */
export function previousNamedIndexRows(items: {height: number}[], gap: number) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({rowRect: {y, height: item.height}})
    y += item.height + gap
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given y: 0..1000
 * given step: 0..40
 * return[$i] == return[$i - 1] + step
 */
export function previousNamedIndexScalars(items: number[], y: number, step: number) {
  const values = []
  let current = y
  for (const _item of items) {
    values.push(current)
    current += step
  }
  return values
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given gap: 0..10
 * return.rows[$row].top == return.rows[$row - 1].top + (return.rows[$row - 1].height + gap)
 */
function localPreviousNamedIndexRows(items: {height: number}[], gap: number) {
  const rows = []
  let top = 0
  for (const item of items) {
    rows.push({top, height: item.height})
    top += item.height + gap
  }
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given spacing: 0..10
 * return.rows[$i + 1].top == return.rows[$i].top + (return.rows[$i].height + spacing)
 */
export function localPreviousNamedIndexSummary(items: {height: number}[], spacing: number) {
  return localPreviousNamedIndexRows(items, spacing)
}
