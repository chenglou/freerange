// Sequence vocabulary: adjacent-pair claims on loop-built arrays.
// spaced, nondecreasing, lastEnd, extentEnd, and the noOverlap catalog lift.

type Row = {top: number; height: number}

/** @fit
 * given items.length: int 0..200
 * given items[].height: 1..100
 * given gap: 0..40
 * given startY: 0..100
 * return.length == items.length
 * spaced(return, gap)
 * nondecreasing(return.top)
 * noOverlap(return)
 */
export function stack(items: {height: number}[], gap: number, startY: number): Row[] {
  const rows: Row[] = []
  let y = startY
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height + gap
  }
  return rows
}

// lastEnd needs the array to be non-empty. extentEnd is the total form that
// returns the fallback when the array is empty.

/** @fit
 * given items.length: int 1..200
 * given items[].height: 1..100
 * given startY: 0..100
 * extentEnd(return.rows, startY) == return.bottom
 */
export function stackWithBottom(items: {height: number}[], startY: number) {
  const rows: Row[] = []
  let y = startY
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}
