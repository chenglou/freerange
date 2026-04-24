// Intentionally bad checker patterns. `bun run test` compares their
// stable messages against negative-patterns.expected.txt.

/** @fit
 * given value: int 0..10
 * return: int 0..4
 */
export function negativeOutputRange(value: number) {
  return value + 5
}

/** @fit
 * given value: 0..5
 * return.high < return.low
 */
export function negativeComparison(value: number) {
  const low = value
  const high = value + 10
  return {low, high}
}

/** @fit
 * given width: 0..1000
 * return.overflow < 0
 */
export function negativePathSensitiveMinOverflow(width: number) {
  const capped = Math.min(width, 320)
  const overflow = width - capped
  return {capped, overflow}
}

/** @fit
 * given value: 0..10
 * return < 4
 */
export function negativeMathMinOperandBoundIsNotStrict(value: number) {
  return Math.min(value, 4)
}

/** @fit
 * given minWidth: 0..1000
 * given width: 0..1000
 * return >= minWidth
 */
function negativeAtLeastMinWidth(minWidth: number, width: number) {
  return Math.max(minWidth, width)
}

/** @fit
 * given minWidth: 0..1000
 * given width: 0..1000
 * return > minWidth
 */
export function negativeHelperSummaryComparisonIsNotStrict(minWidth: number, width: number) {
  return negativeAtLeastMinWidth(minWidth, width)
}

/** @fit
 * given items.length: int 0..10
 * given index: int 0..10
 * return < items.length
 */
export function negativeArrayIndexNeedsUpperBound(items: number[], index: number) {
  const length = items.length
  return length >= 0 ? index : index
}

/** @fit
 * given items.length: int 0..10
 * return: int 0..10
 */
function negativeNeedsShortArray(items: number[]) {
  return items.length
}

/** @fit
 * given items.length: int 0..20
 * return: int 0..20
 */
export function negativeArrayLengthCallGiven(items: number[]) {
  return negativeNeedsShortArray(items)
}

/** @fit
 * given items.length: int 1..50
 * return: int 0..<items.length
 */
export function negativeHalfOpenUpperExcludesLength(items: number[]) {
  return items.length
}

/** @fit
 * given total: int 0..6000
 * given count: int 1..200
 * return >= total
 */
export function negativeFloorDivisionDoesNotCoverTotal(total: number, count: number) {
  return Math.floor(total / count) * count
}

/** @fit
 * given total: int 0..6000
 * given count: int -200..-1
 * return >= total
 */
export function negativeCeilDivisionNeedsPositiveCount(total: number, count: number) {
  return Math.ceil(total / count) * count
}

/** @fit
 * given pointer: 0..1000
 * given cellSize: int 1..100
 * given count: int 1..10
 * return < count
 */
export function negativeFloorHitIndexNeedsUpperBound(pointer: number, cellSize: number, count: number) {
  const maxPointer = count * cellSize
  return pointer < maxPointer ? Math.floor(pointer / cellSize) : Math.floor(pointer / cellSize)
}

/** @fit
 * given px: 0..Infinity
 * given py: 0..Infinity
 * given blockSize: 1..Infinity
 * given countX: int 1..Infinity
 * given _countY: int 1..Infinity
 * given px < countX * blockSize
 * return < countX * _countY
 */
export function negativeFlattenedGridHitIndexNeedsYBound(px: number, py: number, blockSize: number, countX: number, _countY: number) {
  return Math.floor(py / blockSize) * countX + Math.floor(px / blockSize)
}

/** @fit
 * given content: 0..1000
 * given available: 0..1000
 * given scale: -2..2
 * given content <= available
 * return.scaled <= return.limit
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
 * return < count
 */
export function negativeModuloNeedsPositiveCount(index: number, count: number) {
  return index % count
}

/** @fit
 * given width: 0..1000
 * given minWidth: 0..1000
 * return >= minWidth
 */
export function negativeGuardNeedsReturnOnSmallSide(width: number, minWidth: number) {
  if (width > minWidth) return width
  return width
}

/** @fit
 * given width: 0..100
 * return: 0..100
 */
export function negativeBranchAssignmentJoinsBothSides(width: number) {
  let chosen = 0
  if (width > 40) {
    chosen = width + 100
  }
  return chosen
}

export function negativeMathSignCanBeNegative(
  value: number, // @fit -10..10
) {
  return Math.sign(value) // @fit int 0..1
}

/** @fit
 * given limit: int 1..1000
 * return[]: int 1..<limit
 */
export function negativeNumericLimitRangeLoopCanIncludeZero(limit: number) {
  const values = []
  for (let i = 0; i < limit; i++) {
    values.push(i)
  }
  return values
}

/** @fit
 * given width: 1..Infinity
 * return <= 500
 */
export function negativeUnboundedWidthNeedsCap(width: number) {
  return width / 2
}

/** @fit
 * given items.length: int 0..50
 * given top: 0..1000
 * given step: -40..40
 * return.bottom >= top
 * nondecreasing(return.rows.top)
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

export class NegativeClassMethodNeedsThisGiven {
  constructor(
    public top: number,
    public height: number,
  ) {}

  /** @fit
   * given this.top: 0..1000
   * given this.height: -100..1000
   * return >= this.top
   */
  get bottom() {
    return this.top + this.height
  }
}

/** @fit
 * given box.top: 0..1000
 * return: 0..2000
 */
export function negativeClassGetterSummaryNeedsThisGiven(box: NegativeClassMethodNeedsThisGiven) {
  return box.bottom
}

/** @fit
 * given items.length: int 1..50
 * given top: 0..1000
 * given step: 0..40
 * given gap: 0..10
 * given otherGap: 20..30
 * spaced(return.rows, otherGap)
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
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 */
export function negativeSegmentedStackRowsNeedMatchingBottom(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let nextRowTop = top
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight + 1
      rows.push({top: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + gap
      rowHeight = 0
    }
  }
  return {rows, gap}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * given otherGap: 20..30
 * return.rows[$i + 1].top == return.rows[$i].bottom + gap
 * spaced(return.rows, gap)
 */
export function negativeSegmentedStackRowsNeedMatchingGap(items: {height: number}[], top: number, gap: number, otherGap: number) {
  const rows = []
  let nextRowTop = top
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      rows.push({top: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + otherGap
      rowHeight = 0
    }
  }
  return {rows, gap}
}

/** @fit
 * given items.length: int 1..50
 * given top: 0..1000
 * given step: 0..40
 * lastEnd(return.rows) == return.bottom
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
 * return.height >= 0
 */
export function negativeObjectFieldDomainTooWide(item: {height: number}) {
  return {height: item.height}
}

/** @fit
 * given base.x: -10..100
 * given y: 0..100
 * return.x: 0..100
 */
export function negativeObjectSpreadNeedsFieldDomain(base: {x: number}, y: number) {
  return {
    ...base,
    y,
  } satisfies {x: number; y: number}
}

/** @fit
 * return.rows == other.rows
 */
export function negativeArrayIdentityNeedsSameSource(input: {rows: {height: number}[]}, other: {rows: {height: number}[]}) {
  return {rows: input.rows, otherRows: other.rows}
}

declare const optionalStructuralShapeApi: {
  wrapRows(items: {height: number}[]): {rows?: {height: number}[]}
}

/** @fit
 * return.rows.length >= 0
 */
export function negativeOptionalStructuralCallShape(items: {height: number}[]) {
  return optionalStructuralShapeApi.wrapRows(items)
}

/** @fit
 * given items.length: int 1..50
 * given index: int 0..49
 * given index < items.length
 * return: 0..40
 */
export function negativePerItemFieldNeedsDomain(items: {height: number}[], index: number) {
  return items[index]!.height
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: -40..40
 * given top: 0..1000
 * return.bottom >= top
 * nondecreasing(return.rows.top)
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
 * return >= 0
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
 * return[] >= 0
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
 * return >= 0
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
 * return: 0..80
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
 * return >= 0
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
 * return.rows.length == items.length
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
 * return.rows.length == items.length
 */
export function negativeLoopFitHasNoReturn(items: {height: number}[]) {
  const rows = []
  /** @fit
   * given return.rows.length == items.length
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
 * return.rows[].top + return.rows[].height <= parent.bottom
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
 * return.sections[].rows[].height <= maxHeight
 */
export function negativeNestedWildcardRowsNeedScalarBound(sections: {rows: {height: number}[]}[], maxHeight: number) {
  return {sections, maxHeight}
}

/** @fit
 * given rows[].top: 0..10
 * given boxes[].bottom: 0..10
 * return.rows[].top <= return.boxes[].bottom
 */
export function negativeWildcardComparisonNeedsScalar(rows: {top: number}[], boxes: {bottom: number}[]) {
  return {rows, boxes}
}

/** @fit
 * given rows.length: int 0..10
 * given boxes.length: int 0..20
 * given rows[].top: 0..10
 * given boxes[].bottom: 0..10
 * return.rows[$i].top <= return.boxes[$i].bottom
 */
export function negativeSameIndexNeedsMatchingLengths(rows: {top: number}[], boxes: {bottom: number}[]) {
  return {rows, boxes}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: -40..40
 * return.rows[$i].top <= return.rows[$i + 1].top
 */
export function negativeAdjacentBoundIndexNeedsNondecreasingRows(items: {height: number}[]) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows}
}

/** @fit
 * given value: 0..10
 * return: 0..10
 */
function negativeNeedsSmallValue(value: number) {
  return value
}

/** @fit
 * given value: 0..20
 * return: 0..20
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
 * return: 0..20
 */
export function negativeInlineParamCallGiven(value: number) {
  return negativeInlineParamNeedsSmall(value)
}

/** @fit
 * given containee: 0..1000
 * given container: 0..1000
 * given container >= containee
 * return >= 0
 */
function negativeNeedsContainerFit(containee: number, container: number) {
  return (container - containee) / 2
}

/** @fit
 * given containee: 100..200
 * given container: 0..50
 * return: -100..0
 */
export function negativeRelationalCallGiven(containee: number, container: number) {
  return negativeNeedsContainerFit(containee, container)
}

/** @fit
 * given containee: 0..1000
 * given padding: -100..100
 * given container: 0..1200
 * given container >= containee + padding
 * return.offset >= 0
 */
export function negativeLinearReductionNeedsNonNegativePadding(containee: number, padding: number, container: number) {
  return {offset: (container - containee) / 2, padding}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * extentEnd(return.rows, top) == return.bottom
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
 * return.rows[].height: 0..40
 */
export function negativeMapRowsNeedFieldDomain(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows[].index: int 1..49
 */
export function negativeMapIndexCanBeZero(items: {height: number}[]) {
  const rows = items.map((item, index) => ({index, height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: -40..40
 * return.rows[].height: 0..40
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
 * return >= min
 * return <= max
 */
function negativeConditionalClampLayoutValue(min: number, value: number, max: number) {
  return value > max ? max : value < min ? min : value
}

/** @fit
 * given containerWidth: 320..2000
 * return.cols: int 1..6
 */
export function negativeLocalHelperPostconditionTooNarrow(containerWidth: number) {
  const cols = negativeConditionalClampLayoutValue(1, Math.floor(containerWidth / 240), 7)
  return {cols}
}

export function negativeSilentHelperSummaryRequiresPrecondition() {
  const clamped = negativeConditionalClampLayoutValue(10, 0, 2)
  return {
    clamped, // @fit <= 2
  }
}

function negativeLoopReadHelper(index: number) {
  return index + 1
}

export function negativeForgettableLoopStillForgetsMutatedRoot(items: number[]) {
  let scratch = 0
  for (let i = 1; i < items.length - 1; i++) {
    scratch += negativeLoopReadHelper(i)
  }
  return scratch // @fit 0
}

export function negativeScalarStringishMutationForgetsMutatedRoot(items: number[]) {
  let path = ''
  path += `M ${items.length}`
  return path // @fit 0
}

/** @fit
 * given width: 0..100
 * return: 0..100
 */
export function negativeLocalHelperPreconditionViolation(width: number) {
  return negativeConditionalClampLayoutValue(10, width, 5)
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows[].index: int 1..49
 */
export function negativeIndexedLoopIndexCanBeZero(items: {height: number}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    rows.push({index: i, height: items[i]!.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows[].rowIndex: int 0..<items.length
 */
export function negativeIndexedLoopNamedIndexTooHigh(items: {height: number}[]) {
  const rows = []
  for (let rowIndex = 0; rowIndex < items.length; rowIndex++) {
    rows.push({rowIndex: rowIndex + 1, height: items[rowIndex]!.height})
  }
  return {rows}
}

/** @fit
 * given params.items.length: int 1..50
 * given params.items[].height: -40..40
 * given params.top: 0..1000
 * return.bottom >= params.top
 * nondecreasing(return.rows.top)
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
 * return: 0..0
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
 * return.rows.length == items.length
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
 * return.rows.length == items.length
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
 * return.rows.length == items.length
 */
export function negativeFilteredRowsAreNotAlwaysSameLength(items: {height: number; visible: boolean}[]) {
  const rows = items.filter(item => item.visible)
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..100
 * return.rows[].height: 0..40
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
 * nondecreasing(return.rows.top)
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
 * return.rows[].height: 0..40
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
 * given return: 0..10
 */
export function negativeFunctionGivenCannotNameReturn() {
  return 0
}

/** @fit
 * result.width: 0..10
 */
export function negativeLegacyResultIsNotReturn(width: number) {
  return {width}
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
 * return >= min
 */
export const negativeArrowFunctionContract = (value: number, min: number) => Math.min(value, min - 1)

export const negativeDestructuredArrowParamClaim = ({width}: {width: number}) => {
  return width - 1 // @fit >= width
}

export function negativeArrayDestructuredLocalClaim(
  value: number, // @fit 0..10
) {
  const [offset] = [value - 1]
  return offset // @fit >= value
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
 * return: 0..40
 */
export function negativeArrayAtOnlySupportsLast(items: number[]) {
  return items.at(-2)!
}

/** @fit
 * given items.length: int 1..10
 */
export function negativeLoopLengthDerivedIndexDoesNotUseInitialArray(items: number[]) {
  const xs = [0]
  for (let i = 0; i < items.length; i++) {
    const last = xs[xs.length - 1]! // @fit 0
    xs.push(last + 1)
  }
  return xs.length
}

/** @fit
 * given items.length: int 1..50
 * given items[]: 0..40
 * given focused: int 0..<items.length
 * return: 0..40
 */
export function negativePredecessorIndexNeedsStrictPositiveBranch(items: number[], focused: number) {
  if (focused >= 0) return items[focused - 1]!
  return items[0]!
}

/** @fit
 * given focused: int 0..1000
 * return: int 0..1000
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

// The return value is known to be one of `{82, 214}`, so `return: 40 | 120`
// cannot hold. A range-based check would be pessimistic too, but the union
// check reports the set directly so authors see which values are rejected.
/** @fit
 * given navSizeX: 82 | 214
 * return: 40 | 120
 */
export function negativeUnionReturnOutsideSet(navSizeX: number) {
  return navSizeX
}

// Hand a literal that is NOT in the union to a callee that requires
// membership. Freerange rejects the call with the set in the missing line.
/** @fit
 * given navSizeX: 82 | 214
 * return >= 82
 */
function negativeUnionGivenCallee(navSizeX: number) {
  return navSizeX
}

export function negativeUnionGivenCallerOutsideSet() {
  return negativeUnionGivenCallee(150)
}

/** @fit
 * given rect.left: 0..100
 * given rect.right: 0..100
 * given rect.top: 0..100
 * given rect.bottom: 0..100
 * return.x: 50..100
 */
export default (rect: {left: number; right: number; top: number; bottom: number}) => ({
  x: rect.left + (rect.right - rect.left) / 2,
  y: rect.top + (rect.bottom - rect.top) / 2,
})
