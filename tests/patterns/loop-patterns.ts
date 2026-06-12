// Runnable loop-analysis specimen catalog. `bun run test` must run this file.
//
// Loop bodies are analyzed across every branch combination of one iteration,
// with each variable's per-iteration effect classified as unchanged, an added
// amount, a Math.min/Math.max against a candidate, or a reassignment. These
// fixtures pin the supported surface: running sums in every spelling,
// extrema, conditional pushes, segmented stacks, indexed loops, and the
// sequence facts (nondecreasing/spaced/lastEnd/extentEnd) derived from pushes.

/** @fit
 * given limit: int 0..1000
 * return.length == limit
 * return[]: int 0..<limit
 */
export function numericLimitRangeLoop(limit: number) {
  const values = []
  for (let i = 0; i < limit; i++) {
    values.push(i)
  }
  return values
}

/** @fit
 * given items.length: int 1..50
 * given y: 0..1000
 * given step: 0..40
 * given gap: 0..10
 * return.rows.length == items.length
 * nondecreasing(return.rows.y)
 * spaced(return.rows, gap)
 * lastEnd(return.rows) == return.bottom
 */
export function runningSumLoop(items: number[], y: number, step: number, gap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: step, source: item})
    cursor += step + gap
  }
  return {rows, bottom: cursor - gap}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * nondecreasing(return.rows.y)
 * spaced(return.rows, gap)
 * lastEnd(return.rows) == return.bottom
 */
export function runningSumLoopPerItemHeight(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  return {rows, bottom: cursor - gap}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 * return.rows[].rowRect.height: 0..40
 * nondecreasing(return.rows.rowRect.y)
 * return.rows[$i + 1].rowRect.y == return.rows[$i].rowRect.y + return.rows[$i].rowRect.height + gap
 */
export function nestedRowRectRunningSumLoop(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({rowRect: {y: cursor, height: item.height}, source: item})
    cursor += item.height + gap
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function segmentedStackRows(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const layoutHeight = item.height
    rowHeight = Math.max(rowHeight, layoutHeight)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      rows.push({y: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + gap
      rowHeight = 0
    }
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function segmentedStackRowsInlineBottom(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      rows.push({y: rowTop, height: rowHeight, bottom: rowTop + rowHeight})
      nextRowTop = rowTop + rowHeight + gap
      rowHeight = 0
    }
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.measurements.length == items.length
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function segmentedStackRowsWithSideAppend(items: {height: number}[], y: number, gap: number) {
  const rows = []
  const measurements = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const layoutHeight = item.height
    measurements.push({layoutHeight})
    rowHeight = Math.max(rowHeight, layoutHeight)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      rows.push({y: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + gap
      rowHeight = 0
    }
  }
  return {rows, measurements}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
 * return >= 0
 */
export function runningTotalPerItemHeight(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total += item.height
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
 * return >= 0
 */
export function runningTotalAssignmentPerItemHeight(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total = total + item.height
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
 * return >= 0
 */
export function runningTotalCommutedAssignmentPerItemHeight(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total = item.height + total
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given minHeight: 0..40
 * return: 0..2000
 * return >= 0
 */
export function runningTotalPlusMaxStep(items: {height: number}[], minHeight: number) {
  let total = 0
  for (const item of items) {
    total += Math.max(item.height, minHeight)
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given minHeight: 0..40
 * return: 0..2000
 * return >= 0
 */
export function runningTotalAssignmentPlusMaxStep(items: {height: number}[], minHeight: number) {
  let total = 0
  for (const item of items) {
    total = Math.max(item.height, minHeight) + total
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
 * return >= 0
 */
export function indexedRunningTotalAssignmentPerItemHeight(items: {height: number}[]) {
  let total = 0
  for (let i = 0; i < items.length; i++) {
    total = total + items[i]!.height
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given gap: 0..10
 * return: 0..2500
 * return >= 0
 */
export function runningTotalChainedAssignmentPerItemHeight(items: {height: number}[], gap: number) {
  let total = 0
  for (const item of items) {
    total = total + item.height + gap
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].cost: 0..40
 * given budget: 0..1000
 * return <= budget
 * return: -2000..1000
 */
export function remainingBudgetPerItemCost(items: {cost: number}[], budget: number) {
  let remaining = budget
  for (const item of items) {
    remaining -= item.cost
  }
  return remaining
}

/** @fit
 * given items.length: int 0..50
 * return: int 0..50
 * return >= 0
 */
export function countedPositiveItemsWithPostfixIncrement(items: number[]) {
  let count = 0
  for (const item of items) {
    if (item > 0) count++
  }
  return count
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given items[].width: 0..60
 * return: 0..60
 */
export function widestEdgeAcrossItems(items: {height: number; width: number}[]) {
  let widest = 0
  for (const item of items) {
    widest = Math.max(widest, item.height, item.width)
  }
  return widest
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
 * return >= 0
 */
export function indexedRunningTotalLonghandIncrement(items: {height: number}[]) {
  let total = 0
  for (let i = 0; i < items.length; i = i + 1) {
    total = total + items[i]!.height
  }
  return total
}

/** @fit
 * given items.length: int 0..100
 * given items[].width: 1..400
 * given gap: 0..24
 * nondecreasing(return.x)
 * spaced(return, gap)
 * noOverlap(return)
 */
export function horizontalColumnLayout(items: {width: number}[], gap: number) {
  const cols: {x: number; width: number}[] = []
  let x = 0
  for (const item of items) {
    cols.push({x: x, width: item.width})
    x += item.width + gap
  }
  return cols
}

/** @fit
 * given items.length: int 1..100
 * given items[].size: int 1..400
 * given gap: int 0..24
 * nondecreasing(return.y)
 * spaced(return, gap)
 * noOverlap(return)
 * lastEnd(return) >= 0
 */
export function renamedBandsReachTheCatalog(items: {size: number}[], gap: number) {
  const bands: {y: number; size: number}[] = []
  let y = 0
  for (const item of items) {
    bands.push({y, size: item.size})
    y += item.size + gap
  }
  return bands.map(band => ({y: band.y, height: band.size}))
}

/** @fit
 * given items.length: int 0..50
 * given y: 0..1000
 * given step: 0..40
 * return.length == items.length
 * return[]: 0..3000
 */
export function scalarPushLoop(items: number[], y: number, step: number) {
  const rows = []
  let cursor = y
  for (const _item of items) {
    rows.push(cursor)
    cursor += step
  }
  return rows
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
 * return >= 0
 */
export function conditionalRunningTotalPerItemHeight(items: {height: number; visible: boolean}[]) {
  let total = 0
  for (const item of items) {
    if (item.visible) total += item.height
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * return: int 0..50
 * return <= items.length
 */
export function conditionalRunningCount(items: {visible: boolean}[]) {
  let count = 0
  for (const item of items) {
    if (item.visible) count += 1
  }
  return count
}

/** @fit
 * given items.length: int 0..50
 * given items[].width: 0..80
 * return: 0..80
 */
export function runningMaxPerItemWidth(items: {width: number}[]) {
  let maxWidth = 0
  for (const item of items) {
    const width = item.width
    maxWidth = Math.max(maxWidth, width)
  }
  return maxWidth
}

/** @fit
 * given items.length: int 1..50
 * given items[].width: 20..80
 * return: 20..80
 */
export function runningMinPerItemWidth(items: {width: number}[]) {
  let minWidth = 100
  for (const item of items) {
    minWidth = Math.min(minWidth, item.width)
  }
  return minWidth
}

/** @fit
 * given items.length: int 0..50
 * given items[].width: 0..80
 * return: 0..80
 */
export function indexedRunningMaxPerItemWidth(items: {width: number}[]) {
  let maxWidth = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const width = item.width
    maxWidth = Math.max(maxWidth, width)
  }
  return maxWidth
}

/** @fit
 * given items.length: int 0..50
 * return <= items.length
 */
export function directRunningCountKeepsLengthBound(items: {visible: boolean}[]) {
  let count = 0
  for (const item of items) {
    count += item.visible ? 1 : 1
  }
  return count
}

/** @fit
 * given items.length: int 1..50
 * given y: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 */
export function localLoopAnnotation(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let cursor = y
  /** @fit
   * given items[].height: 0..40
   * rows.length == items.length
   * rows[].height: 0..40
   * nondecreasing(rows.y)
   * spaced(rows, gap)
   * lastEnd(rows) == cursor - gap
   */
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  return {rows, bottom: cursor - gap}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function segmentedStackRowsWithGuardLocalResetAlias(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      const resetHeight = 0
      rows.push({y: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + gap
      rowHeight = resetHeight
    }
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * extentEnd(return.rows, y) == return.bottom
 */
export function extentEndHandlesEmptyRows(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  const bottom = rows.length === 0 ? y : cursor - gap
  return {rows, bottom}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * return.rows[].index: int 0..49
 * return.rows[].index < items.length
 */
export function indexedLoopRows(items: {height: number}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    rows.push({index: i, height: items[i]!.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int 1..Infinity
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[].rowIndex: int 0..<items.length
 * return.rows[].height: 0..40
 */
export function indexedLoopNamedIndexField(items: {height: number}[]) {
  const rows = []
  for (let rowIndex = 0; rowIndex < items.length; rowIndex++) {
    const item = items[rowIndex]!
    rows.push({rowIndex, height: item.height})
  }
  return {rows}
}

/** @fit
 * given params.items.length: int 1..50
 * given params.items[].height: 0..40
 * given params.y: 0..1000
 * return.rows.length == params.items.length
 * return.rows[].index: int 0..49
 * return.rows[].index < params.items.length
 * return.rows[].height: 0..40
 * return.bottom >= params.y
 * nondecreasing(return.rows.y)
 * lastEnd(return.rows) == return.bottom
 */
export function indexedLoopAliasRows(params: {items: {height: number}[]; y: number}) {
  const rows = []
  let y = params.y
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i]!
    rows.push({index: i, y: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function conditionalPushRows(items: {height: number; visible: boolean}[]) {
  const rows = []
  for (const item of items) {
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * return.rows.length <= items.length
 * return.rows[].y: 0..3000
 * return.rows[].height: 0..40
 * return.bottom >= y
 */
export function conditionalPushRowsWithCursor(items: {height: number; visible: boolean}[], y: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    if (item.visible) rows.push({y: cursor, height: item.height})
    cursor += item.height
  }
  return {rows, bottom: cursor}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function indexedConditionalPushRows(items: {height: number; visible: boolean}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows[].height: 0..40
 */
export function forOfConditionalPushWithSafeReset(items: {height: number; endsRow: boolean}[]) {
  const rows = []
  let rowHeight = 0
  for (const item of items) {
    rowHeight = Math.max(rowHeight, item.height)
    if (item.endsRow) {
      rows.push({height: rowHeight})
      rowHeight = 0
    }
  }
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * given parent.bottom: 4000..5000
 * return.rows[].y <= parent.bottom
 * return.rows[].y + return.rows[].height <= parent.bottom
 */
export function wildcardRowsFitParent(items: {height: number}[], y: number, gap: number, parent: {bottom: number}) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  return {rows, bottom: cursor - gap, parent}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows[$i].y <= return.rows[$i + 1].y
 */
export function adjacentBoundIndexRowsAreNondecreasing(items: {height: number}[]) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({y: y, height: item.height})
    y += item.height
  }
  return {rows}
}

/** @fit
 * given items[].height: 0..100
 * given items[].width: 0..50
 * given items.length: 0..50
 * return: 0..7500
 */
export function loopTwoAddsSameVariable(items: {height: number; width: number}[]): number {
  let total = 0
  for (const item of items) {
    total += item.height
    total += item.width
  }
  return total
}

/** @fit
 * given items.length: 0..50
 * return: 0..250
 */
export function loopIfElseAdd(items: {visible: boolean}[]): number {
  let total = 0
  for (const item of items) {
    if (item.visible) total += 2
    else total += 5
  }
  return total
}

/** @fit
 * given items[].height: 0..100
 * given items.length: 0..50
 * return.total: 0..5000
 * return.best: 0..100
 */
export function loopSumAndMaxTogether(items: {height: number}[]) {
  let total = 0
  let best = 0
  for (const item of items) {
    best = Math.max(best, item.height)
    total += item.height
  }
  return {total, best}
}

/** @fit
 * given items[].height: 0..100
 * given items.length: 0..50
 * return: 0..100
 */
export function loopGuardedExtremum(items: {height: number}[]): number {
  let best = 0
  for (const item of items) {
    if (item.height > best) best = item.height
  }
  return best
}

/** @fit
 * given items[].height: 0..100
 * given items.length: 1..50
 * given gap: 0..10
 * nondecreasing(return.rows.y)
 * spaced(return.rows, gap)
 */
export function loopPushLocalRow(items: {height: number}[], gap: number) {
  const rows: {y: number; height: number}[] = []
  let y = 0
  for (const item of items) {
    const row = {y, height: item.height}
    rows.push(row)
    y += item.height + gap
  }
  return {rows}
}

/** @fit
 * given items[].height: int 0..100
 * given items.length: 1..50
 * spaced(return.rows, 0)
 */
export function loopUpdateBeforePush(items: {height: number}[]) {
  const rows: {y: number; height: number}[] = []
  let y = 0
  for (const item of items) {
    y += item.height
    rows.push({y: y - item.height, height: item.height})
  }
  return {rows}
}

/** @fit
 * given items[].height: 0..100
 * given items.length: 0..50
 * return.total: 0..5000
 */
export function loopScratchRebind(items: {height: number}[]) {
  let total = 0
  let scratch = 0
  for (const item of items) {
    scratch = item.height
    total += scratch
  }
  return {total, scratch}
}

/** @fit
 * given items[].height: 0..100
 * given items.length: 0..50
 * return.total: 0..5000
 * return.count: 0..50
 */
export function loopSurvivesUnrelatedHavoc(items: {height: number}[], log: number[]) {
  let total = 0
  let count = 0
  for (const item of items) {
    total += item.height
    log[0] = item.height
    count += 1
  }
  return {total, count}
}

/** @fit
 * given items[].height: int 0..100
 * given items.length: 0..50
 * return: 0..10000
 */
export function loopNetOfSignedAdds(items: {height: number}[]): number {
  let total = 0
  for (const item of items) {
    total += item.height
    total += item.height
    total -= item.height
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given gap: 0..10
 * return.rows[].bottom == return.rows[].y + return.rows[].height
 * nondecreasing(return.rows.y)
 * spaced(return.rows, gap)
 */
export function stackedRowsWithBottom(items: {height: number}[], gap: number) {
  const rows: {y: number; height: number; bottom: number}[] = []
  let cursor = 0
  for (const item of items) {
    rows.push({y: cursor, height: item.height, bottom: cursor + item.height})
    cursor += item.height + gap
  }
  return {rows}
}
