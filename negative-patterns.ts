// Intentionally bad checker patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

/** @fit
 * given value: int 0..10
 * result: int 0..4
 */
export function negativeOutputRange(value: number) {
  return value + 5
}

/** @fit
 * given value: 0..5
 * result.high < result.low
 */
export function negativeComparison(value: number) {
  const low = value
  const high = value + 10
  return {low, high}
}

/** @fit
 * given width: 0..1000
 * result.overflow < 0
 */
export function negativePathSensitiveMinOverflow(width: number) {
  const capped = Math.min(width, 320)
  const overflow = width - capped
  return {capped, overflow}
}

/** @fit
 * given value: 0..10
 * result < 4
 */
export function negativeMathMinOperandBoundIsNotStrict(value: number) {
  return Math.min(value, 4)
}

/** @fit
 * given minWidth: 0..1000
 * given width: 0..1000
 * result >= minWidth
 */
function negativeAtLeastMinWidth(minWidth: number, width: number) {
  return Math.max(minWidth, width)
}

/** @fit
 * given minWidth: 0..1000
 * given width: 0..1000
 * result > minWidth
 */
export function negativeHelperSummaryComparisonIsNotStrict(minWidth: number, width: number) {
  return negativeAtLeastMinWidth(minWidth, width)
}

/** @fit
 * given items.length: int 0..10
 * given index: int 0..10
 * result < items.length
 */
export function negativeArrayIndexNeedsUpperBound(items: number[], index: number) {
  const length = items.length
  return length >= 0 ? index : index
}

/** @fit
 * given items.length: int 0..10
 * result: int 0..10
 */
function negativeNeedsShortArray(items: number[]) {
  return items.length
}

/** @fit
 * given items.length: int 0..20
 * result: int 0..20
 */
export function negativeArrayLengthCallGiven(items: number[]) {
  return negativeNeedsShortArray(items)
}

/** @fit
 * given items.length: int 1..50
 * result: int 0..<items.length
 */
export function negativeHalfOpenUpperExcludesLength(items: number[]) {
  return items.length
}

/** @fit
 * given total: int 0..6000
 * given count: int 1..200
 * result >= total
 */
export function negativeFloorDivisionDoesNotCoverTotal(total: number, count: number) {
  return Math.floor(total / count) * count
}

/** @fit
 * given total: int 0..6000
 * given count: int -200..-1
 * result >= total
 */
export function negativeCeilDivisionNeedsPositiveCount(total: number, count: number) {
  return Math.ceil(total / count) * count
}

/** @fit
 * given pointer: 0..1000
 * given cellSize: int 1..100
 * given count: int 1..10
 * result < count
 */
export function negativeFloorHitIndexNeedsUpperBound(pointer: number, cellSize: number, count: number) {
  const maxPointer = count * cellSize
  return pointer < maxPointer ? Math.floor(pointer / cellSize) : Math.floor(pointer / cellSize)
}

/** @fit
 * given content: 0..1000
 * given available: 0..1000
 * given scale: -2..2
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
 * given index: int 0..10000
 * given count: int 0..1000
 * result < count
 */
export function negativeModuloNeedsPositiveCount(index: number, count: number) {
  return index % count
}

/** @fit
 * given width: 0..1000
 * given minWidth: 0..1000
 * result >= minWidth
 */
export function negativeGuardNeedsReturnOnSmallSide(width: number, minWidth: number) {
  if (width > minWidth) return width
  return width
}

/** @fit
 * given items.length: int 0..50
 * given top: 0..1000
 * given step: -40..40
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
 * given items.length: int 1..50
 * given top: 0..1000
 * given step: 0..40
 * given gap: 0..10
 * given otherGap: 20..30
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
 * given items.length: int 1..50
 * given top: 0..1000
 * given step: 0..40
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
 * given item.height: -20..40
 * result.height >= 0
 */
export function negativeObjectFieldDomainTooWide(item: {height: number}) {
  return {height: item.height}
}

/** @fit
 * given base.x: -10..100
 * given y: 0..100
 * result.x: 0..100
 */
export function negativeObjectSpreadNeedsFieldDomain(base: {x: number}, y: number) {
  return {
    ...base,
    y,
  } satisfies {x: number; y: number}
}

/** @fit
 * result.rows == other.rows
 */
export function negativeArrayIdentityNeedsSameSource(input: {rows: {height: number}[]}, other: {rows: {height: number}[]}) {
  return {rows: input.rows, otherRows: other.rows}
}

declare const optionalStructuralShapeApi: {
  wrapRows(items: {height: number}[]): {rows?: {height: number}[]}
}

/** @fit
 * result.rows.length >= 0
 */
export function negativeOptionalStructuralCallShape(items: {height: number}[]) {
  return optionalStructuralShapeApi.wrapRows(items)
}

/** @fit
 * given items.length: int 1..50
 * given index: int 0..49
 * given index < items.length
 * result: 0..40
 */
export function negativePerItemFieldNeedsDomain(items: {height: number}[], index: number) {
  return items[index]!.height
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: -40..40
 * given top: 0..1000
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
 * given items.length: int 0..50
 * given items[].height: -40..40
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
 * given items.length: int 0..50
 * given top: 0..1000
 * given step: -40..40
 * result[] >= 0
 */
export function negativeScalarPushLoopNeedsNonNegativeStep(items: number[], top: number, step: number) {
  const rows = []
  let y = top
  for (const _item of items) {
    rows.push(y)
    y += step
  }
  return rows
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: -40..40
 * result >= 0
 */
export function negativeConditionalRunningTotalNeedsNonNegativeItem(items: {height: number; visible: boolean}[]) {
  let total = 0
  for (const item of items) {
    if (item.visible) total += item.height
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].width: 0..120
 * result: 0..80
 */
export function negativeRunningMaxNeedsItemBound(items: {width: number}[]) {
  let maxWidth = 0
  for (const item of items) {
    maxWidth = Math.max(maxWidth, item.width)
  }
  return maxWidth
}

/** @fit
 * given items.length: int 1..50
 * given items[].width: -20..80
 * result >= 0
 */
export function negativeRunningMinNeedsItemBound(items: {width: number}[]) {
  let minWidth = 100
  for (const item of items) {
    minWidth = Math.min(minWidth, item.width)
  }
  return minWidth
}

/** @fit
 * given items.length: int 1..50
 * given top: 0..1000
 * result.rows.length == items.length
 */
export function negativeLocalLoopAnnotationNeedsNonNegativeItem(items: {height: number}[], top: number) {
  const rows = []
  let y = top
  /** @fit
   * given items[].height: -40..40
   * nondecreasing(rows.top)
   */
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int 1..50
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
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * given parent.bottom: 0..2000
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
 * given sections[].rows[].height: 0..40
 * given maxHeight: 0..30
 * result.sections[].rows[].height <= maxHeight
 */
export function negativeNestedWildcardRowsNeedScalarBound(sections: {rows: {height: number}[]}[], maxHeight: number) {
  return {sections, maxHeight}
}

/** @fit
 * given rows[].top: 0..10
 * given boxes[].bottom: 0..10
 * result.rows[].top <= result.boxes[].bottom
 */
export function negativeWildcardComparisonNeedsScalar(rows: {top: number}[], boxes: {bottom: number}[]) {
  return {rows, boxes}
}

/** @fit
 * given value: 0..10
 * result: 0..10
 */
function negativeNeedsSmallValue(value: number) {
  return value
}

/** @fit
 * given value: 0..20
 * result: 0..20
 */
export function negativeCallGiven(value: number) {
  return negativeNeedsSmallValue(value)
}

function negativeInlineParamNeedsSmall(
  value: number, // @fit 0..10
) {
  return value
}

/** @fit
 * given value: 0..20
 * result: 0..20
 */
export function negativeInlineParamCallGiven(value: number) {
  return negativeInlineParamNeedsSmall(value)
}

/** @fit
 * given containee: 0..1000
 * given container: 0..1000
 * given container >= containee
 * result >= 0
 */
function negativeNeedsContainerFit(containee: number, container: number) {
  return (container - containee) / 2
}

/** @fit
 * given containee: 100..200
 * given container: 0..50
 * result: -100..0
 */
export function negativeRelationalCallGiven(containee: number, container: number) {
  return negativeNeedsContainerFit(containee, container)
}

/** @fit
 * given containee: 0..1000
 * given padding: -100..100
 * given container: 0..1200
 * given container >= containee + padding
 * result.offset >= 0
 */
export function negativeLinearReductionNeedsNonNegativePadding(containee: number, padding: number, container: number) {
  return {offset: (container - containee) / 2, padding}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
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
 * given items.length: int 0..50
 * given items[].height: -40..40
 * result.rows[].height: 0..40
 */
export function negativeMapRowsNeedFieldDomain(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * result.rows[].index: int 1..49
 */
export function negativeMapIndexCanBeZero(items: {height: number}[]) {
  const rows = items.map((item, index) => ({index, height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: -40..40
 * result.rows[].height: 0..40
 */
export function negativeMapBlockRowsNeedFieldDomain(items: {height: number}[]) {
  const rows = items.map(item => {
    const {height} = item
    return {height}
  })
  return {rows}
}

/** @fit
 * given min: -1000..1000
 * given value: -1000..1000
 * given max: -1000..1000
 * given max >= min
 * result >= min
 * result <= max
 */
function negativeConditionalClampLayoutValue(min: number, value: number, max: number) {
  return value > max ? max : value < min ? min : value
}

/** @fit
 * given containerWidth: 320..2000
 * result.cols: int 1..6
 */
export function negativeLocalHelperPostconditionTooNarrow(containerWidth: number) {
  const cols = negativeConditionalClampLayoutValue(1, Math.floor(containerWidth / 240), 7)
  return {cols}
}

/** @fit
 * given width: 0..100
 * result: 0..100
 */
export function negativeLocalHelperPreconditionViolation(width: number) {
  return negativeConditionalClampLayoutValue(10, width, 5)
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * result.rows[].index: int 1..49
 */
export function negativeIndexedLoopIndexCanBeZero(items: {height: number}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    rows.push({index: i, height: items[i]!.height})
  }
  return {rows}
}

/** @fit
 * given params.items.length: int 1..50
 * given params.items[].height: -40..40
 * given params.top: 0..1000
 * result.bottom >= params.top
 * nondecreasing(result.rows.top)
 */
export function negativeIndexedLoopAliasNeedsNonNegativeItem(params: {items: {height: number}[]; top: number}) {
  const rows = []
  let y = params.top
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i]!
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int 1..50
 * given items[]: 0..10
 * result: 0..0
 */
export function negativeUnsupportedForLoopForgetsScalar(items: number[]) {
  let total = 0
  for (let i = items.length - 1; i >= 0; i--) {
    total += items[i]!
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
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
 * given items.length: int 0..50
 * given items[].height: 0..40
 * result.rows.length == items.length
 */
export function negativeIndexedConditionalPushIsNotSameLength(items: {height: number; visible: boolean}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * result.rows.length == items.length
 */
export function negativeFilteredRowsAreNotAlwaysSameLength(items: {height: number; visible: boolean}[]) {
  const rows = items.filter(item => item.visible)
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..100
 * result.rows[].height: 0..40
 */
export function negativeForOfConditionalPushNeedsItemBound(items: {height: number; endsRow: boolean}[]) {
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
 * given items.length: int 1..50
 * given items[].height: 0..40
 * result.rows[].height: 0..40
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
 * given result: 0..10
 */
export function negativeFunctionGivenCannotNameResult() {
  return 0
}

/** @fit
 * given width: 500..400
 */
export function negativeGivenRangeCannotBeEmpty(width: number) {
  return width
}

/** @fit
 * given width: 100..200
 * given width <= 50
 */
export function negativeGivenComparisonCannotFit(width: number) {
  return width
}

/** @fit
 * given width >= 100
 * given width <= 50
 */
export function negativeGivenComparisonsCannotBothHold(width: number) {
  return width
}

/** @fit
 * given left >= middle
 * given middle >= right
 * given right > left
 */
export function negativeGivenComparisonsCannotTransitivelyHold(left: number, middle: number, right: number) {
  return {left, middle, right}
}

/** @fit
 * given width + 1: 0..10
 */
export function negativeGivenRangeCannotDescribeDerivedExpression(width: number) {
  return width
}

export function negativeInlineSideRange() {
  const index = 4 // @fit int 0..3
  return index
}

export function negativeInlineObjectFieldRange() {
  return {
    width: 4, // @fit 0..3
  }
}

export function negativeInlineLocalComparison() {
  const value = 4 // @fit < 4
  return value
}

export function negativeInlineObjectFieldComparison() {
  return {
    width: 4, // @fit > 4
  }
}

export function negativeInlineReturnComparison() {
  return 5 // @fit < 5
}

/** @fit
 * given value: 0..50
 */
export function negativeInlineParamComparison(
  value: number, // @fit > max
  max: number, // @fit 100..200
) {
  return value + max
}

/** @fit
 * given items[].height: 0..max.toString()
 */
export function negativeGivenRangeBoundCannotCallInputMethod(items: {height: number}[], max: number) {
  return items.length + max
}

/** @fit
 * given items.length: int 0..10
 * given index: int 0..9
 * given items[index] >= 0
 */
export function negativeGivenComparisonCannotIndexArray(items: number[], index: number) {
  return {items, index}
}

/** @fit
 * given items.length: int 2..50
 * given items[]: 0..40
 * result: 0..40
 */
export function negativeArrayAtOnlySupportsLast(items: number[]) {
  return items.at(-2)!
}

/** @fit
 * given items.length: int 1..50
 * given items[]: 0..40
 * given focused: int 0..<items.length
 * result: 0..40
 */
export function negativePredecessorIndexNeedsStrictPositiveBranch(items: number[], focused: number) {
  if (focused >= 0) return items[focused - 1]!
  return items[0]!
}

/** @fit
 * given focused: int 0..1000
 * result: int 0..1000
 */
export function negativeBranchLocalReturnNeedsStrictPositiveBranch(focused: number) {
  if (focused >= 0) return focused - 1 // @fit >= 0
  return 0
}

/** @fit
 * given width.toString() == 10
 */
export function negativeGivenComparisonCannotCallInputMethod(width: number) {
  return width
}

/** @fit
 * given items.length: int 0..10
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

export const negativeTopLevelInlineCallGiven = negativeNeedsContainerFit(4, 3) // @fit -1..0
