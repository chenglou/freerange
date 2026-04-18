// Intentionally bad checker patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

/** @fit
 * given value: int[0, 10]
 * result: int[0, 4]
 */
export function negativeOutputRange(value: number) {
  return value + 5
}

/** @fit
 * given value: number[0, 5]
 * result.high < result.low
 */
export function negativeComparison(value: number) {
  const low = value
  const high = value + 10
  return {low, high}
}

/** @fit
 * given width: number[0, 1000]
 * result.overflow < 0
 */
export function negativePathSensitiveMinOverflow(width: number) {
  const capped = Math.min(width, 320)
  const overflow = width - capped
  return {capped, overflow}
}

/** @fit
 * given items.length: int[0, 10]
 * given index: int[0, 10]
 * result < items.length
 */
export function negativeArrayIndexNeedsUpperBound(items: number[], index: number) {
  const length = items.length
  return length >= 0 ? index : index
}

/** @fit
 * given items.length: int[0, 10]
 * result: int[0, 10]
 */
function negativeNeedsShortArray(items: number[]) {
  return items.length
}

/** @fit
 * given items.length: int[0, 20]
 * result: int[0, 20]
 */
export function negativeArrayLengthCallGiven(items: number[]) {
  return negativeNeedsShortArray(items)
}

/** @fit
 * given total: int[0, 6000]
 * given count: int[1, 200]
 * result >= total
 */
export function negativeFloorDivisionDoesNotCoverTotal(total: number, count: number) {
  return Math.floor(total / count) * count
}

/** @fit
 * given pointer: number[0, 1000]
 * given cellSize: int[1, 100]
 * given count: int[1, 10]
 * result < count
 */
export function negativeFloorHitIndexNeedsUpperBound(pointer: number, cellSize: number, count: number) {
  const maxPointer = count * cellSize
  return pointer < maxPointer ? Math.floor(pointer / cellSize) : Math.floor(pointer / cellSize)
}

/** @fit
 * given content: number[0, 1000]
 * given available: number[0, 1000]
 * given scale: number[-2, 2]
 * given content <= available
 * result.scaled <= result.limit
 */
export function negativeScaleNeedsNonNegativeFactor(content: number, available: number, scale: number) {
  return {
    scaled: content * scale,
    limit: available * scale,
  }
}

/** @fit
 * given index: int[0, 10000]
 * given count: int[0, 1000]
 * result < count
 */
export function negativeModuloNeedsPositiveCount(index: number, count: number) {
  return index % count
}

/** @fit
 * given width: number[0, 1000]
 * given minWidth: number[0, 1000]
 * result >= minWidth
 */
export function negativeGuardNeedsReturnOnSmallSide(width: number, minWidth: number) {
  if (width > minWidth) return width
  return width
}

/** @fit
 * given items.length: int[0, 50]
 * given top: number[0, 1000]
 * given step: number[-40, 40]
 * result.bottom >= top
 * nondecreasing(result.rows.top)
 */
export function negativeRunningSumNeedsNonNegativeStep(items: number[], top: number, step: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: step, source: item})
    y += step
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int[1, 50]
 * given top: number[0, 1000]
 * given step: number[0, 40]
 * given gap: number[0, 10]
 * given otherGap: number[20, 30]
 * spaced(result.rows, otherGap)
 */
export function negativeSpacedNeedsMatchingGap(items: number[], top: number, step: number, gap: number, otherGap: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: step, source: item})
    y += step + gap
  }
  return {rows, bottom: y - gap, otherGap}
}

/** @fit
 * given items.length: int[1, 50]
 * given top: number[0, 1000]
 * given step: number[0, 40]
 * lastEnd(result.rows) == result.bottom
 */
export function negativeLastEndNeedsHeightInRows(items: number[], top: number, step: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, source: item})
    y += step
  }
  return {rows, bottom: y}
}

/** @fit
 * given item.height: number[-20, 40]
 * result.height >= 0
 */
export function negativeObjectFieldDomainTooWide(item: {height: number}) {
  return {height: item.height}
}

/** @fit
 * given items.length: int[1, 50]
 * given index: int[0, 49]
 * given index < items.length
 * result: number[0, 40]
 */
export function negativePerItemFieldNeedsDomain(items: {height: number}[], index: number) {
  return items[index]!.height
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[-40, 40]
 * given top: number[0, 1000]
 * result.bottom >= top
 * nondecreasing(result.rows.top)
 */
export function negativeRunningSumPerItemHeightNeedsNonNegative(items: {height: number}[], top: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[-40, 40]
 * result >= 0
 */
export function negativeRunningTotalNeedsNonNegativeItem(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total += item.height
  }
  return total
}

/** @fit
 * given items.length: int[1, 50]
 * given top: number[0, 1000]
 * result.rows.length == items.length
 */
export function negativeLocalLoopAnnotationNeedsNonNegativeItem(items: {height: number}[], top: number) {
  const rows = []
  let y = top
  /** @fit
   * given items[].height: number[-40, 40]
   * nondecreasing(rows.top)
   */
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int[1, 50]
 * result.rows.length == items.length
 */
export function negativeLoopFitHasNoResult(items: {height: number}[]) {
  const rows = []
  /** @fit
   * given result.rows.length == items.length
   */
  for (const item of items) {
    rows.push({top: 0, height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * given parent.bottom: number[0, 2000]
 * result.rows[].top + result.rows[].height <= parent.bottom
 */
export function negativeWildcardRowsNeedParentBottom(items: {height: number}[], top: number, gap: number, parent: {bottom: number}) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height + gap
  }
  return {rows, bottom: y - gap, parent}
}

/** @fit
 * given sections[].rows[].height: number[0, 40]
 * given maxHeight: number[0, 30]
 * result.sections[].rows[].height <= maxHeight
 */
export function negativeNestedWildcardRowsNeedScalarBound(sections: {rows: {height: number}[]}[], maxHeight: number) {
  return {sections, maxHeight}
}

/** @fit
 * given rows[].top: number[0, 10]
 * given boxes[].bottom: number[0, 10]
 * result.rows[].top <= result.boxes[].bottom
 */
export function negativeWildcardComparisonNeedsScalar(rows: {top: number}[], boxes: {bottom: number}[]) {
  return {rows, boxes}
}

/** @fit
 * given value: number[0, 10]
 * result: number[0, 10]
 */
function negativeNeedsSmallValue(value: number) {
  return value
}

/** @fit
 * given value: number[0, 20]
 * result: number[0, 20]
 */
export function negativeCallGiven(value: number) {
  return negativeNeedsSmallValue(value)
}

/** @fit
 * given containee: number[0, 1000]
 * given container: number[0, 1000]
 * given container >= containee
 * result >= 0
 */
function negativeNeedsContainerFit(containee: number, container: number) {
  return (container - containee) / 2
}

/** @fit
 * given containee: number[100, 200]
 * given container: number[0, 50]
 * result: number[-100, 0]
 */
export function negativeRelationalCallGiven(containee: number, container: number) {
  return negativeNeedsContainerFit(containee, container)
}

/** @fit
 * given containee: number[0, 1000]
 * given padding: number[-100, 100]
 * given container: number[0, 1200]
 * given container >= containee + padding
 * result.offset >= 0
 */
export function negativeLinearReductionNeedsNonNegativePadding(containee: number, padding: number, container: number) {
  return {offset: (container - containee) / 2, padding}
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * extentEnd(result.rows, top) == result.bottom
 */
export function negativeExtentEndCatchesEmptyRows(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height + gap
  }
  return {rows, bottom: y - gap}
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[-40, 40]
 * result.rows[].height: number[0, 40]
 */
export function negativeMapRowsNeedFieldDomain(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * result.rows[].index: int[1, 49]
 */
export function negativeIndexedLoopIndexCanBeZero(items: {height: number}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    rows.push({index: i, height: items[i]!.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result.rows.length == items.length
 */
export function negativeConditionalPushIsNotSameLength(items: {height: number; visible: boolean}[]) {
  const rows = []
  for (const item of items) {
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * nondecreasing(result.rows.top)
 */
export function negativeReverseKillsRowOrder(items: {height: number}[]) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  rows.reverse()
  return {rows}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * result.rows[].height: number[0, 40]
 */
export function negativeIndexedAssignmentKillsRowDomain(items: {height: number}[], height: number) {
  const rows = []
  for (const item of items) {
    rows.push({height: item.height})
  }
  rows[0]!.height = height
  return {rows}
}

/** @fit
 * given result: number[0, 10]
 */
export function negativeFunctionGivenCannotNameResult() {
  return 0
}

/** @fit
 * given width: number[500, 400]
 */
export function negativeGivenRangeCannotBeEmpty(width: number) {
  return width
}

/** @fit
 * given width: number[100, 200]
 * given width <= 50
 */
export function negativeGivenComparisonCannotFit(width: number) {
  return width
}

/** @fit
 * given items.length: int[0, 10]
 */
export function negativeLoopGivenCannotNameRows(items: number[]) {
  const rows = []
  /** @fit
   * given rows.length == items.length
   */
  for (const item of items) {
    rows.push(item)
  }
  return rows
}
