// Runnable checker pattern specimen. `bun run test` must run this file.
//
// Queued patterns:
// - `rectInside`
// - `rectEquals`
// - `nonOverlapX` / `nonOverlapY`
// - `life-calendar` numeric sizing: `**`, `Math.sqrt`, `Math.ceil`, positive-domain facts, integer facts after `ceil`
// - column/row width reasoning: tables, grids, flex-like negotiation, cells that cover multiple columns
// - Pretext text facts: line width fits, fragments are ordered, fragments cover ranges, selection rects reuse paint fragments
// - scroll-anchor stability as a userland geometry relation

const patternGap = 4

/** @fit
 * given width: int[320, 1600]
 * result: int[320, 1600]
 */
export function constantBoundedInput(width: number) {
  return width
}

/** @fit
 * given value: int[0, 10]
 * result: int[5, 15]
 */
export function outputRangeFact(value: number) {
  const shifted = value + 5
  return shifted
}

/** @fit
 * given value: number[0, 5]
 * result.high > result.low
 * result.low < result.high
 */
export function scalarComparisons(value: number) {
  const low = value
  const high = value + 10
  return {low, high}
}

/** @fit
 * given value: int[0, 5]
 * result.square: int[0, 25]
 * result.half: number[0, 2.5]
 */
export function straightLineArithmetic(value: number) {
  const square = value ** 2
  const half = value / 2
  return {square, half}
}

/** @fit
 * given value: number[10, 20]
 * result.width: number[14, 24]
 */
export function objectReturnPropertyAccess(value: number) {
  const width = value + patternGap
  const height = value * 2
  return {width, height}
}

function addPatternGap(value: number) {
  return value + patternGap
}

/** @fit
 * given value: number[0, 10]
 * result: number[4, 14]
 */
export function sameFilePureHelperCall(value: number) {
  return addPatternGap(value)
}

/** @fit
 * given value: int[0, 10]
 * result: int[3, 7]
 */
export function ternaryBranchJoin(value: number) {
  return value > 5 ? 7 : 3
}

/** @fit
 * given value: number[2, 8]
 * result.floorValue: int[1, 4]
 * result.ceilValue: int[1, 4]
 * result.floorValue <= value / 2
 * value / 2 >= result.floorValue
 * result.ceilValue >= value / 2
 * value / 2 <= result.ceilValue
 * result.roundValue: int[1, 4]
 * result.truncValue: int[1, 4]
 * result.sqrtValue: number[1, 3]
 * result.absValue: number[0, 3]
 * result.minValue: number[2, 4]
 * result.minValue <= 4
 * result.maxValue: number[4, 8]
 * result.maxValue >= 4
 */
export function mathSubset(value: number) {
  const half = value / 2
  const shifted = value - 5
  return {
    floorValue: Math.floor(half),
    ceilValue: Math.ceil(half),
    roundValue: Math.round(half),
    truncValue: Math.trunc(half),
    sqrtValue: Math.sqrt(value),
    absValue: Math.abs(shifted),
    minValue: Math.min(value, 4),
    maxValue: Math.max(value, 4),
  }
}

/** @fit
 * given total: int[0, 6000]
 * given count: int[1, 200]
 * result >= total
 */
export function ceilDivisionCoversTotal(total: number, count: number) {
  return Math.ceil(total / count) * count
}

/** @fit
 * given pointer: number[0, 100000]
 * given cellSize: int[1, 1000]
 * given count: int[1, 1000]
 * given pointer < count * cellSize
 * result >= 0
 * result < count
 */
export function floorHitIndexInsideCount(pointer: number, cellSize: number, count: number) {
  const maxPointer = count * cellSize
  return pointer < maxPointer ? Math.floor(pointer / cellSize) : Math.floor(pointer / cellSize)
}

/** @fit
 * given content: number[0, 1000]
 * given available: number[0, 1000]
 * given scale: number[0, 8]
 * given content <= available
 * result.scaled <= result.limit
 * result.swapped <= result.limit
 */
export function positiveScaleKeepsOrder(content: number, available: number, scale: number) {
  return {
    scaled: content * scale,
    swapped: scale * content,
    limit: available * scale,
  }
}

/** @fit
 * given content: number[0, 1000]
 * given available: number[0, 1000]
 * given columns: int[1, 12]
 * given content <= available
 * result.cell <= result.maxCell
 */
export function positiveDivisionKeepsOrder(content: number, available: number, columns: number) {
  return {
    cell: content / columns,
    maxCell: available / columns,
  }
}

/** @fit
 * given index: int[0, 10000]
 * given count: int[1, 1000]
 * result: int[0, 999]
 * result < count
 */
export function moduloWrapsInsideCount(index: number, count: number) {
  return index % count
}

/** @fit
 * given width: number[0, 1000]
 * given minWidth: number[0, 1000]
 * result >= minWidth
 */
export function guardReturnKeepsMinimum(width: number, minWidth: number) {
  if (width < minWidth) return minWidth
  return width
}

/** @fit
 * given items.length: int[1, 50]
 * given top: number[0, 1000]
 * given step: number[0, 40]
 * given gap: number[0, 10]
 * result.rows.length == items.length
 * nondecreasing(result.rows.top)
 * spaced(result.rows, gap)
 * lastEnd(result.rows) == result.bottom
 */
export function runningSumLoop(items: number[], top: number, step: number, gap: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: step, source: item})
    y += step + gap
  }
  return {rows, bottom: y - gap}
}

/** @fit
 * given item.height: number[0, 40]
 * given item.top: number[0, 1000]
 * result.bottom >= item.top
 * result.height: number[0, 40]
 */
export function objectFieldDomain(item: {top: number; height: number}) {
  return {height: item.height, bottom: item.top + item.height}
}

/** @fit
 * given child.x: number[0, 1000]
 * given child.w: number[0, 500]
 * given parent.x: number[0, 1000]
 * given parent.w: number[0, 2000]
 * given child.x >= parent.x
 * given child.x + child.w <= parent.x + parent.w
 * result.right <= parent.x + parent.w
 */
export function rectInsideAsFieldMath(child: {x: number; w: number}, parent: {x: number; w: number}) {
  return {right: child.x + child.w, parentRight: parent.x + parent.w}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * given index: int[0, 49]
 * given index < items.length
 * result: number[0, 40]
 */
export function indexedPerItemField(items: {height: number}[], index: number) {
  return items[index]!.height
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 * result.bottom >= top
 * nondecreasing(result.rows.top)
 * spaced(result.rows, gap)
 * lastEnd(result.rows) == result.bottom
 */
export function runningSumLoopPerItemHeight(items: {height: number}[], top: number, gap: number) {
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
 * given items[].height: number[0, 40]
 * result: number[0, 2000]
 * result >= 0
 */
export function runningTotalPerItemHeight(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total += item.height
  }
  return total
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result: number[0, 2000]
 * result >= 0
 */
export function conditionalRunningTotalPerItemHeight(items: {height: number; visible: boolean}[]) {
  let total = 0
  for (const item of items) {
    if (item.visible) total += item.height
  }
  return total
}

/** @fit
 * given items.length: int[0, 50]
 * result: int[0, 50]
 * result <= items.length
 */
export function conditionalRunningCount(items: {visible: boolean}[]) {
  let count = 0
  for (const item of items) {
    if (item.visible) count += 1
  }
  return count
}

/** @fit
 * given items.length: int[0, 50]
 * result <= items.length
 */
export function directRunningCountKeepsLengthBound(items: {visible: boolean}[]) {
  let count = 0
  for (const item of items) {
    count += item.visible ? 1 : 1
  }
  return count
}

/** @fit
 * given items.length: int[1, 50]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * result.bottom >= top
 * result.rows.length == items.length
 */
export function localLoopAnnotation(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let y = top
  /** @fit
   * given items[].height: number[0, 40]
   * rows.length == items.length
   * rows[].height: number[0, 40]
   * nondecreasing(rows.top)
   * spaced(rows, gap)
   * lastEnd(rows) == y - gap
   */
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height + gap
  }
  return {rows, bottom: y - gap}
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 * extentEnd(result.rows, top) == result.bottom
 */
export function extentEndHandlesEmptyRows(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height + gap
  }
  const bottom = rows.length === 0 ? top : y - gap
  return {rows, bottom}
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 */
export function mapRowsKeepsLengthAndFields(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 * result.rows[].index: int[0, 49]
 * result.rows[].index < items.length
 */
export function indexedLoopRows(items: {height: number}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    rows.push({index: i, height: items[i]!.height})
  }
  return {rows}
}

/** @fit
 * given params.items.length: int[1, 50]
 * given params.items[].height: number[0, 40]
 * given params.top: number[0, 1000]
 * result.rows.length == params.items.length
 * result.rows[].index: int[0, 49]
 * result.rows[].index < params.items.length
 * result.rows[].height: number[0, 40]
 * result.bottom >= params.top
 * nondecreasing(result.rows.top)
 * lastEnd(result.rows) == result.bottom
 */
export function indexedLoopAliasRows(params: {items: {height: number}[]; top: number}) {
  const rows = []
  let y = params.top
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i]!
    rows.push({index: i, top: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result.rows.length <= items.length
 * result.rows[].height: number[0, 40]
 */
export function conditionalPushRows(items: {height: number; visible: boolean}[]) {
  const rows = []
  for (const item of items) {
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * given parent.bottom: number[4000, 5000]
 * result.rows[].top <= parent.bottom
 * result.rows[].top + result.rows[].height <= parent.bottom
 */
export function wildcardRowsFitParent(items: {height: number}[], top: number, gap: number, parent: {bottom: number}) {
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
 * given maxHeight: number[40, 100]
 * result.sections[].rows[].height: number[0, 40]
 * result.sections[].rows[].height <= maxHeight
 */
export function nestedWildcardRows(sections: {rows: {height: number}[]}[], maxHeight: number) {
  return {sections, maxHeight}
}

/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 */
export function reverseKeepsRowDomains(items: {height: number}[]) {
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
 * given width: number[0, 1000]
 * result.capped: number[0, 320]
 * result.overflow >= 0
 */
export function pathSensitiveMinOverflow(width: number) {
  const capped = Math.min(width, 320)
  const overflow = width - capped
  return {capped, overflow}
}

/** @fit
 * given width: number[0, 1000]
 * given padding: number[0, 120]
 * result.content: number[0, 1000]
 * result.leftover >= 0
 */
export function pathSensitiveMaxLeftover(width: number, padding: number) {
  const content = Math.max(width - padding, 0)
  const leftover = width - content
  return {content, leftover}
}

/** @fit
 * given value: number[-1000, 1000]
 * given min: number[-1000, 1000]
 * given max: number[-1000, 1000]
 * given max >= min
 * result >= min
 * result <= max
 */
function clampLayoutValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

/** @fit
 * given value: number[-1000, 1000]
 * result: number[0, 320]
 */
export function userlandClamp(value: number) {
  return clampLayoutValue(value, 0, 320)
}

/** @fit
 * given min: number[-1000, 1000]
 * given value: number[-1000, 1000]
 * given max: number[-1000, 1000]
 * given max >= min
 * result >= min
 * result <= max
 */
function conditionalClampLayoutValue(min: number, value: number, max: number) {
  return value > max ? max : value < min ? min : value
}

/** @fit
 * given containerWidth: number[320, 2000]
 * result.cols: int[1, 7]
 */
export function localHelperPostconditionRange(containerWidth: number) {
  const cols = conditionalClampLayoutValue(1, Math.floor(containerWidth / 240), 7)
  return {cols}
}

/** @fit
 * given items.length: int[0, 100]
 * result: int[0, 100]
 */
export function arrayLengthRange(items: number[]) {
  return items.length
}

/** @fit
 * result: int[3, 3]
 */
export function arrayLiteralLength() {
  const values = [10, 20, 30]
  return values.length
}

/** @fit
 * given index: int[0, 2]
 * result: int[10, 30]
 */
export function arrayLiteralIndex(index: number) {
  return [10, 20, 30][index]
}

/** @fit
 * given items.length: int[0, 100]
 * given index: int[0, 100]
 * given index < items.length
 * result.index >= 0
 * result.index < items.length
 * result.length == items.length
 */
export function halfOpenArrayIndex(items: number[], index: number) {
  return {index, length: items.length}
}

/** @fit
 * given items.length: int[0, 20]
 * result.length: int[1, 21]
 * result.length == items.length + 1
 */
export function spreadAppendLength(items: number[], value: number) {
  return [...items, value]
}

/** @fit
 * given items.length: int[0, 10]
 * result: int[0, 10]
 */
function shortArrayLength(items: number[]) {
  return items.length
}

/** @fit
 * given items.length: int[0, 10]
 * result: int[0, 10]
 */
export function arrayLengthGivenThroughHelper(items: number[]) {
  return shortArrayLength(items)
}

/** @fit
 * given containee: number[0, 10000]
 * given container: number[0, 10000]
 * result == (container - containee) / 2
 */
export function exactExpressionIdentity(containee: number, container: number) {
  return (container - containee) / 2
}

/** @fit
 * given containee: number[0, 1000]
 * given container: number[0, 1000]
 * given container >= containee
 * result >= 0
 */
export function centeredOffset(containee: number, container: number) {
  return (container - containee) / 2
}

/** @fit
 * given containee: number[0, 1000]
 * given container: number[0, 1000]
 * given container >= containee
 * result >= 0
 */
export function centeredOffsetThroughHelper(containee: number, container: number) {
  return centeredOffset(containee, container)
}

/** @fit
 * given containee: number[0, 1000]
 * given padding: number[0, 100]
 * given container: number[0, 1200]
 * given container >= containee + padding
 * result.offset >= 0
 */
export function centeredOffsetWithPaddingSlack(containee: number, padding: number, container: number) {
  return {offset: (container - containee) / 2, padding}
}

/** @fit
 * given value: number[4, 14]
 * result: number[5, 15]
 */
function trackedInnerGiven(value: number) {
  return value + 1
}

/** @fit
 * given value: number[0, 10]
 * result: number[5, 15]
 */
function trackedMiddleGiven(value: number) {
  return trackedInnerGiven(value + patternGap)
}

/** @fit
 * given value: number[0, 10]
 * result: number[5, 15]
 */
export function transitiveGivenTracking(value: number) {
  return trackedMiddleGiven(value)
}
