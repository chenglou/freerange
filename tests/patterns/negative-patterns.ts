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
 * given low * scale <= _mid * scale
 * given _mid * scale <= _high * scale
 * return < _high * scale
 */
export function negativeOpaqueInequalityGraphLoosePathIsNotStrict(low: number, _mid: number, _high: number, scale: number) {
  return low * scale
}

/** @fit
 * given low * scale <= _mid * scale
 * given _mid * scale <= _high * scale
 * given _high * scale < low * scale
 * return == low * scale
 */
export function negativeGivenGraphContradiction(low: number, _mid: number, _high: number, scale: number) {
  return low * scale
}

/** @fit
 * given low <= mid
 * return.low <= return.mid
 */
function negativePartialOrderedTriple(low: number, mid: number, high: number) {
  return {low, mid, high}
}

/** @fit
 * given low <= mid
 * return.low <= return.high
 */
export function negativeHelperResultComparisonNeedsBridge(low: number, mid: number, high: number) {
  return negativePartialOrderedTriple(low, mid, high)
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

let mutableMaxAlias = Math.max

/** @fit
 * return >= 0
 */
export function negativeMutableMathAlias(value: number) {
  return mutableMaxAlias(value, 0)
}

/** @fit
 * given value: 0..10
 * return < 4
 */
export function negativeHandwrittenMinOperandBoundIsNotStrict(value: number) {
  return value < 4 ? value : 4
}

type NegativeLiteralColumnSpec =
  | {kind: 'ordered'; panelWidth: number}
  | {kind: 'inverted'; panelWidth: number}

function negativeLiteralColumnGeometry(spec: NegativeLiteralColumnSpec, panelX: number) {
  switch (spec.kind) {
    case 'ordered': {
      const yThresholdX = panelX + 100
      const uThresholdX = panelX + 300
      return {yThresholdX, uThresholdX, emptyIntervalWidth: uThresholdX - yThresholdX}
    }
    case 'inverted': {
      const yThresholdX = panelX + 300
      const uThresholdX = panelX + 100
      return {yThresholdX, uThresholdX, emptyIntervalWidth: 0}
    }
  }
}

/** @fit
 * given panelX: 0..1000
 * return.ordered.yThresholdX > return.ordered.uThresholdX
 */
export function negativeFiniteLiteralDiscriminantWrongBranch(panelX: number) {
  return {
    ordered: negativeLiteralColumnGeometry({kind: 'ordered', panelWidth: 400}, panelX),
  }
}

function negativeBroadStringColumnGeometry(kind: string, panelX: number) {
  if (kind === 'ordered') {
    const yThresholdX = panelX + 100
    const uThresholdX = panelX + 300
    return {yThresholdX, uThresholdX}
  }
  const yThresholdX = panelX + 300
  const uThresholdX = panelX + 100
  return {yThresholdX, uThresholdX}
}

/** @fit
 * given panelX: 0..1000
 * return.yThresholdX < return.uThresholdX
 */
export function negativeBroadStringDoesNotBecomeFinite(kind: string, panelX: number) {
  return negativeBroadStringColumnGeometry(kind, panelX)
}

/** @fit
 * return: {x: 0, width: 100} | {x: 20, width: 80}
 */
export function negativePairedObjectReturnShape(pinned: boolean) {
  if (pinned) return {x: 20, width: 81} as const
  return {x: 0, width: 100} as const
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
 * given content <= available
 * return <= content * scale
 */
export function negativeScaleFlipNeedsNegativeFactor(content: number, available: number, scale: number) {
  void content
  return available * scale
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
 * given x < right
 * return.floorLeft < return.floorRight
 */
export function negativeRoundingDoesNotKeepStrictOrder(x: number, right: number) {
  return {
    floorLeft: Math.floor(x),
    floorRight: Math.floor(right),
  }
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
 * given x: -10..10
 * given y: -10..10
 * return >= 0
 */
export function negativeLogicalOrTrueOnlyCarriesOneSide(x: number, y: number) {
  if (x >= 0 || y >= 0) return x + y
  return 0
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

/** @fit
 * return.total: 12 | 21
 */
export function negativeBranchStateDoesNotInventCrossProduct(flag: boolean) {
  let x = 0
  let y = 0
  if (flag) {
    x = 1
    y = 10
  } else {
    x = 2
    y = 20
  }
  return {total: x + y}
}

/** @fit
 * given n: int 0..10
 * return.total: 12 | 21
 */
export function negativeConditionalExpressionDoesNotInventNumericCrossProduct(n: number) {
  const x = n > 4 ? 1 : 2
  const y = n > 4 ? 10 : 20
  return {total: x + y}
}

/** @fit
 * given a: int 0..1
 * given b: int 0..1
 * given c: int 0..1
 * given d: int 0..1
 * return: int 0..15
 */
export function negativeStatePartitionBudgetDoesNotSilentlyPass(a: number, b: number, c: number, d: number) {
  let total = 0
  if (a > 0) total += 1
  if (b > 0) total += 2
  if (c > 0) total += 4
  if (d > 0) total += 8
  return total
}

/** @fit
 * given step: -10..10
 * return > 1
 */
export function negativeThrowGuardOnlyProvesPositive(step: number) {
  if (step <= 0) {
    throw new Error('step must be positive')
  }
  return step
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
 * given y: 0..1000
 * given step: -40..40
 * nondecreasing(return.rows.y)
 */
export function negativeRunningSumNeedsNonNegativeStep(items: number[], y: number, step: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: step, source: item})
    cursor += step
  }
  return {rows, bottom: cursor}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: -40..40
 * given y: 0..1000
 * return.rows[$i].rowRect.y <= return.rows[$i + 1].rowRect.y
 */
export function negativeNestedRowRectNeedsNonNegativeAdvance(items: {height: number}[], y: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({rowRect: {y: cursor, height: item.height}})
    cursor += item.height
  }
  return {rows}
}

export class NegativeClassMethodNeedsThisGiven {
  constructor(
    public y: number,
    public height: number,
  ) {}

  /** @fit
   * given this.y: 0..1000
   * given this.height: -100..1000
   * return >= this.y
   */
  get bottom() {
    return this.y + this.height
  }
}

/** @fit
 * given box.y: 0..1000
 * return: 0..2000
 */
export function negativeClassGetterSummaryNeedsThisGiven(box: NegativeClassMethodNeedsThisGiven) {
  return box.bottom
}

/** @fit
 * given items.length: int 1..50
 * given y: 0..1000
 * given step: 0..40
 * given gap: 0..10
 * given otherGap: 20..30
 * spaced(return.rows, otherGap)
 */
export function negativeSpacedNeedsMatchingGap(items: number[], y: number, step: number, gap: number, otherGap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: step, source: item})
    cursor += step + gap
  }
  return {rows, bottom: cursor - gap, otherGap}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows[].bottom == return.rows[].y + return.rows[].height
 */
export function negativeSegmentedStackRowsNeedMatchingBottom(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight + 1
      rows.push({y: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + gap
      rowHeight = 0
    }
  }
  return {rows, gap}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows[].bottom == return.rows[].y + return.rows[].height
 */
export function negativeSegmentedStackRowsInlineBottomNeedsMatchingBottom(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      rows.push({y: rowTop, height: rowHeight, bottom: rowTop + rowHeight + 1})
      nextRowTop = rowTop + rowHeight + gap
      rowHeight = 0
    }
  }
  return {rows, gap}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * given otherGap: 20..30
 * return.rows[$i + 1].y == return.rows[$i].bottom + gap
 * spaced(return.rows, gap)
 */
export function negativeSegmentedStackRowsNeedMatchingGap(items: {height: number}[], y: number, gap: number, otherGap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      rows.push({y: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + otherGap
      rowHeight = 0
    }
  }
  return {rows, gap}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * spaced(return.rows, gap)
 */
export function negativeGuardedFlushCannotMixSameArrayAppend(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rows.push({y: nextRowTop, height: item.height, bottom: nextRowTop + item.height})
    rowHeight = Math.max(rowHeight, item.height)
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
 * given items.length: int 1..50
 * given y: 0..1000
 * given step: 0..40
 * lastEnd(return.rows) == return.bottom
 */
export function negativeLastEndNeedsHeightInRows(items: number[], y: number, step: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, source: item})
    cursor += step
  }
  return {rows, bottom: cursor}
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
 * given y: 0..1000
 * nondecreasing(return.rows.y)
 */
export function negativeRunningSumPerItemHeightNeedsNonNegative(items: {height: number}[], y: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height
  }
  return {rows, bottom: cursor}
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
 * given items.length: int 1..10
 * return: 0..10
 */
export function negativeSelfReferentialAccumulatorRhs(items: number[]) {
  let total = 1
  for (const _item of items) {
    total += total
  }
  return total
}

/** @fit
 * return == 10
 */
export function negativeLoopGuardMutationIsNotPure(items: number[]) {
  let cap = 10
  let total = 0
  for (const item of items) {
    if (--cap > 0) total += item
  }
  return cap
}

/** @fit
 * return == 10
 */
export function negativeCompoundAssignmentWrites() {
  let value = 10
  value -= 2
  return value
}

/** @fit
 * return == 10
 */
export function negativePrefixIncrementWrites() {
  let value = 10
  ++value
  return value
}

function negativeGrowBox(box: {size: number}): void {
  box.size = 100
}

/** @fit
 * return == 1
 */
export function negativeCalleeMutatesArgument() {
  const box = {size: 1}
  negativeGrowBox(box)
  return box.size
}

/** @fit
 * given items.length: int 0..50
 * return == 0
 */
export function negativeMapCallbackMutatesCaptured(items: number[]) {
  let total = 0
  items.map(item => {
    total += 1
    return item
  })
  return total
}

/** @fit
 * return == 3
 */
export function negativeArrayAliasPush() {
  const xs = [1, 2, 3]
  const ys = xs
  ys.push(4)
  return xs.length
}

/** @fit
 * given i: int 0..2
 * return == 1
 */
export function negativeDynamicIndexWrite(i: number) {
  const slots = [1, 1, 1]
  slots[i] = 999
  return slots[0]!
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 1..40
 * nondecreasing(return.y)
 */
export function negativeSeededArrayBreaksAdjacency(items: {height: number}[]) {
  const rows: {y: number; height: number}[] = [{y: 100, height: 5}]
  let y = 0
  for (const item of items) {
    rows.push({y: y, height: item.height})
    y += item.height
  }
  return rows
}

/** @fit
 * given rows.length: int 1..100
 * given rows[].height: 1..100
 * return >= 5
 */
export function negativeConditionalSumGuardMayNeverFire(rows: {height: number}[]) {
  let total = 0
  for (const row of rows) {
    if (row.height > 50) total += 5
  }
  return total
}

/** @fit
 * given cells.length: int 0..50
 * given cells[].height: 1..40
 * given cells[].width: 1..40
 * given gap: 0..10
 * noOverlap(return)
 */
export function negativeBothAxesAreAmbiguous(cells: {height: number; width: number}[], gap: number) {
  const rows: {y: number; height: number; x: number; width: number}[] = []
  let y = 0
  for (const cell of cells) {
    rows.push({y: y, height: cell.height, x: 0, width: cell.width})
    y += cell.height + gap
  }
  return rows
}

/** @fit
 * given items.length: int 1..100
 * given items[].size: 1..400
 * given gap: 0..24
 * spaced(return, gap)
 */
export function negativePartialRenameLosesTheRelation(items: {size: number}[], gap: number) {
  const bands: {y: number; size: number}[] = []
  let y = 0
  for (const item of items) {
    bands.push({y, size: item.size})
    y += item.size + gap
  }
  return bands.map(band => ({y: band.y, height: band.size + 1}))
}

/** @fit
 * given x: -1000000000000..1000000000000
 * return == 0
 */
export function negativeTinyCoefficientIsNotZero(x: number) {
  return 1e-10 * x
}

/** @fit
 * given widths.length: int 0..10
 * return.length: int 0..10
 */
export function negativeCallbackFitPlacementIsReported(widths: number[]) {
  return widths.map(width => ({
    half: width / 2, // @fit > 0
  }))
}

/** @fit
 * return == 99
 */
export function negativeTrailingCommentBelongsToItsOwnDeclaration() {
  const earlier = 99; const annotated = 1 // @fit == 99
  void earlier
  void annotated
  return 99
}

/** @fit
 * return == 0.3
 */
export function negativeFloatSumIsNotItsDecimalLook() {
  return 0.1 + 0.2
}

/** @fit
 * given items.length: int 0..200
 * given items[].height: 1..100
 * given gap: 0..5
 * return[$i + 1].y <= return[$i].height + gap
 */
export function negativeFirstIterationCoincidenceIsNotARelation(items: {height: number}[], gap: number) {
  const rows: {y: number; height: number}[] = []
  let y = 0
  for (const item of items) {
    rows.push({y: y, height: item.height})
    y += item.height + gap
  }
  return rows
}

/** @fit
 * given items.length: int 1..10
 * given items[].height: 0..5
 * given minHeight: 0..5
 * return >= 10
 */
export function negativeLoopResetAssignmentIsNotAccumulator(items: {height: number}[], minHeight: number) {
  let total = 10
  for (const item of items) {
    total = Math.max(item.height, minHeight)
  }
  return total
}

/** @fit
 * given items.length: int 0..50
 * given y: 0..1000
 * given step: -40..40
 * return[] >= 0
 */
export function negativeScalarPushLoopNeedsNonNegativeStep(items: number[], y: number, step: number) {
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
 * given y: 0..1000
 * return.rows.length == items.length
 */
export function negativeLocalLoopAnnotationNeedsNonNegativeItem(items: {height: number}[], y: number) {
  const rows = []
  let cursor = y
  /** @fit
   * given items[].height: -40..40
   * nondecreasing(rows.y)
   */
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height
  }
  return {rows, bottom: cursor}
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
    rows.push({y: 0, height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * given parent.bottom: 0..2000
 * return.rows[].y + return.rows[].height <= parent.bottom
 */
export function negativeWildcardRowsNeedParentBottom(items: {height: number}[], y: number, gap: number, parent: {bottom: number}) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  return {rows, bottom: cursor - gap, parent}
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
 * given rows[].y: 0..10
 * given boxes[].bottom: 0..10
 * return.rows[].y <= return.boxes[].bottom
 */
export function negativeWildcardComparisonNeedsScalar(rows: {y: number}[], boxes: {bottom: number}[]) {
  return {rows, boxes}
}

/** @fit
 * given rows.length: int 0..10
 * given boxes.length: int 0..20
 * given rows[].y: 0..10
 * given boxes[].bottom: 0..10
 * return.rows[$i].y <= return.boxes[$i].bottom
 */
export function negativeSameIndexNeedsMatchingLengths(rows: {y: number}[], boxes: {bottom: number}[]) {
  return {rows, boxes}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: -40..40
 * return.rows[$i].y <= return.rows[$i + 1].y
 */
export function negativeAdjacentBoundIndexNeedsNondecreasingRows(items: {height: number}[]) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({y: y, height: item.height})
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
 * given value: -100..100
 * given min: 1..100
 * given max: 1..100
 * given min <= max
 * return: -1..<1
 */
export function negativeElseIfBranchCanReturnUpper(value: number, min: number, max: number) {
  if (value < -min) {
    return -1
  } else if (value > max) {
    return 1
  }
  return 0
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
 * given y: 0..1000
 * given gap: 0..10
 * extentEnd(return.rows, y) == return.bottom
 */
export function negativeExtentEndCatchesEmptyRows(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let cursor = y
  for (const item of items) {
    rows.push({y: cursor, height: item.height})
    cursor += item.height + gap
  }
  return {rows, bottom: cursor - gap}
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
 * given items.length: int 0..50
 * given items[].height: -40..40
 * return.rows[].height: 0..40
 */
export function negativeMapFunctionRowsNeedFieldDomain(items: {height: number}[]) {
  const rows = items.map(function (item) {
    const {height} = item
    return {height}
  })
  return {rows}
}

type NegativeTypeFieldSpring = {
  k: number // @fit > 0
  b: number // @fit >= 0
}

type NegativeTypeFieldRows = {
  rows: {
    height: number // @fit 0..40
  }[]
}

export function negativeTypeFieldReturnCheck(): NegativeTypeFieldSpring {
  return {k: -1, b: 30}
}

function negativeNeedsTypeFieldSpring(spring: NegativeTypeFieldSpring) {
  return spring.k
}

/** @fit
 * return < 0
 */
export function negativeTypeFieldCallBoundary() {
  const spring = {k: -1, b: 30}
  return negativeNeedsTypeFieldSpring(spring)
}

export function negativeTypeFieldLocalBoundary() {
  const spring: NegativeTypeFieldSpring = {k: -1, b: 30}
  return spring
}

export function negativeTypeFieldSatisfiesReturn() {
  return {k: -1, b: 30} satisfies NegativeTypeFieldSpring
}

export function negativeTypeFieldAsReturn() {
  return {k: -1, b: 30} as NegativeTypeFieldSpring
}

export function negativeTypeFieldArrayElement(): NegativeTypeFieldRows {
  return {rows: [{height: 100}]}
}

/** @fit
 * k > b
 */
type NegativeTypeRelationSpring = {
  k: number
  b: number
}

/** @fit
 * rows[].bottom >= rows[].y
 * rows[].cells[].right >= rows[].cells[].x
 */
type NegativeTypeRelationRows = {
  rows: {
    y: number
    bottom: number
    cells: {
      x: number
      right: number
    }[]
  }[]
}

/** @fit
 * rows[].cells[].x >= row.x
 */
type NegativeTypeRelationCrossScope = {
  rows: {
    x: number
    cells: {
      x: number
    }[]
  }[]
}

type NegativeTypeRelationOptional = {
  maybe?: number // @fit >= 0
}

export function negativeTypeRelationReturnCheck(): NegativeTypeRelationSpring {
  return {k: 1, b: 2}
}

function negativeNeedsTypeRelationSpring(spring: NegativeTypeRelationSpring) {
  return spring.k
}

/** @fit
 * return > 0
 */
export function negativeTypeRelationCallBoundary() {
  const spring = {k: 1, b: 2}
  return negativeNeedsTypeRelationSpring(spring)
}

export function negativeTypeRelationArrayPathReturnCheck(): NegativeTypeRelationRows {
  return {rows: [{y: 10, bottom: 0, cells: [{x: 4, right: 1}]}]}
}

export function negativeTypeRelationCrossScope(input: NegativeTypeRelationCrossScope) {
  return input.rows.length
}

export function negativeTypeRelationOptional(input: NegativeTypeRelationOptional) {
  return input.maybe ?? 0
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
 * given min: -1000..1000
 * given value: -1000..1000
 * given max: -1000..1000
 * given max >= min
 * return >= min
 * return < max
 */
export function negativeIfClampCanReturnMax(min: number, value: number, max: number) {
  let next = value
  if (next < min) {
    next = min
  }
  if (next > max) {
    next = max
  }
  return next
}

/** @fit
 * given containerWidth: 320..2000
 * return.cols: int 1..6
 */
export function negativeLocalHelperPostconditionTooNarrow(containerWidth: number) {
  const cols = negativeConditionalClampLayoutValue(1, Math.floor(containerWidth / 240), 7)
  return {cols}
}

/** @fit
 * given bounds.min: -1000..1000
 * given bounds.max: -1000..1000
 * given value: -1000..1000
 * return >= bounds.min
 */
export function negativeAliasHelperPreconditionNeedsComparison(bounds: {min: number; max: number}, value: number) {
  const low = bounds.min
  const high = bounds.max
  return negativeConditionalClampLayoutValue(low, value, high)
}

/** @fit
 * given extent[0][0]: -1000..1000
 * given extent[1][0]: -990..1000
 * given width: 0..10
 * given value: -1000..1000
 * return >= extent[0][0]
 */
export function negativeFixedElementHelperPreconditionNeedsComparison(extent: [[number, number], [number, number]], width: number, value: number) {
  return negativeConditionalClampLayoutValue(extent[0][0], value, extent[1][0] - width)
}

/** @fit
 * given _index: int 0..10
 * given _items[_index][0]: 0..10
 * return >= 0
 */
export function negativeFixedElementPathCannotHideDynamicIndex(_items: number[][], _index: number) {
  return 0
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

/** @fit
 * given focused: int 0..50
 * return: int 0..49
 */
export function negativeNullableBranchNeedsPresentGuard(focused: number) {
  const previous = focused > 0 ? focused - 1 : null
  return previous
}

/** @fit
 * given focused: int 0..50
 * return: int 0..49
 */
export function negativeNullablePropertyNeedsPresentGuard(focused: number) {
  const state = {
    previous: focused > 0 ? {targetIndex: focused - 1} : null,
  }
  // @ts-expect-error This case intentionally checks the missing present guard.
  return state.previous.targetIndex
}

export function negativeOptionalNumberNeedsPresentGuard(max?: number) {
  // @ts-expect-error This case intentionally checks the missing present guard.
  return Math.max(max, 0) // @fit >= max
}

export function negativeNullishFallbackNeedsNumericDefault(dimensions: {width?: number}, label: string) {
  // @ts-expect-error This case intentionally keeps a non-numeric fallback.
  return Math.max(dimensions?.width ?? label, 0) // @fit >= 0
}

export function negativeForgettableWhileStillForgetsMutatedRoot(items: number[]) {
  let scratch = 0
  let i = 0
  while (i < items.length) {
    scratch += items[i]!
    i++
  }
  return scratch // @fit 0
}

export function negativeScalarStringishMutationForgetsMutatedRoot(items: number[]) {
  let path = ''
  path += `M ${items.length}`
  return path // @fit 0
}

/** @fit
 * given box.width: 0..10
 * return >= 0
 */
export function negativeObjectMutationForgetsInputPath(box: {width: number}) {
  box.width = -1
  return box.width
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
 * given params.y: 0..1000
 * return.bottom >= params.y
 * nondecreasing(return.rows.y)
 */
export function negativeIndexedLoopAliasNeedsNonNegativeItem(params: {items: {height: number}[]; y: number}) {
  const rows = []
  let y = params.y
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i]!
    rows.push({y: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given gap: 0..20
 * spaced(return.rows, gap)
 */
export function negativeStaleGapAfterRefactor(items: {height: number}[], gap: number) {
  const rows = []
  let y = 0
  const oldGap = gap + 1
  for (const item of items) {
    rows.push({y: y, height: item.height})
    y += item.height + oldGap
  }
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given focused: int 0..<items.length
 * return.targetIndex: int 0..<items.length
 */
export function negativeOffByOneTargetIndex(items: number[], focused: number) {
  return {targetIndex: focused + 1, itemCount: items.length}
}

/** @fit
 * given row.y: 0..1000
 * given row.height: 0..40
 * return.bottom == return.y + return.height
 */
export function negativeMissingRowBottom(row: {y: number; height: number}) {
  return {
    y: row.y,
    height: row.height,
    bottom: row.y + row.height - 1,
  }
}

/** @fit
 * given prompt.height: 0..Infinity
 * given availableHeight: 0..200
 * return.visibleHeight <= availableHeight
 */
export function negativeUnboundedPromptHeight(prompt: {height: number}, availableHeight: number) {
  return {visibleHeight: prompt.height, availableHeight}
}

/** @fit
 * given opacity: 0..1
 * return: 0..1
 */
export function negativeInvertedClampBounds(opacity: number) {
  return negativeConditionalClampLayoutValue(1, opacity, 0)
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
 * given items[].height: -40..40
 * given y: 0..1000
 * return.bottom >= y
 */
export function negativeConditionalPushCursorNeedsNonNegativeItem(items: {height: number; visible: boolean}[], y: number) {
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
 * given items.length: int 0..50
 * given items[].height: -40..40
 * return.rows[].height > 0
 */
export function negativeFilteredPredicateIsNotStrongerThanSource(items: {height: number; visible: boolean}[]) {
  const rows = items.filter(item => item.height >= 0)
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 */
export function negativeFilteredMappedRowsAreNotAlwaysSameLength(items: {height: number; visible: boolean}[]) {
  const rows = items
    .filter(item => item.visible)
    .map(item => ({height: item.height}))
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
 * nondecreasing(return.rows.y)
 */
export function negativeReverseKillsRowOrder(items: {height: number}[]) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({y: y, height: item.height})
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
 * given x >= middle
 * given middle >= right
 * given right > x
 */
export function negativeGivenComparisonsCannotTransitivelyHold(x: number, middle: number, right: number) {
  return {x, middle, right}
}

/** @fit
 * given width + 1: 0..10
 */
export function negativeGivenRangeCannotDescribeDerivedExpression(width: number) {
  return width
}

/** @fit
 * given x >= middle
 * given middle >= right
 * given right: 20..30
 * given x: 0..10
 */
export function negativeGivenRangeCannotFitEarlierChain(x: number, middle: number, right: number) {
  return {x, middle, right}
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
 * given items.length: int 1..50
 * given items[]: 0..40
 * return: 0..40
 */
export function negativeArrayAtNegativeIndexNeedsEnoughLength(items: number[]) {
  return items.at(-2)!
}

/** @fit
 * given count: int 0..100
 * return.length == count + 1
 */
export function negativeTypedArrayConstructorKeepsExactLength(count: number) {
  return new Uint8Array(count)
}

/** @fit
 * given index: 0 | 2
 * return: 20 | 40
 */
export function negativeArrayLiteralFiniteIndexDoesNotReadSkippedSlot(index: 0 | 2) {
  return ([10, 20, 30] as const)[index]
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
 * given items.length: int 2..50
 * given items[].y: 0..1000
 * given focused: int 1..<items.length
 * return.current == return.previous
 */
export function negativeDifferentSymbolicSlotsAreNotSamePath(items: {y: number}[], focused: number) {
  return {
    current: items[focused]!.y,
    previous: items[focused - 1]!.y,
  }
}

/** @fit
 * given items.length: int 2..50
 * given items[].height: 0..40
 * given focused: int 0..<items.length
 * given focused + 1 < items.length
 * return.nextTop == return.currentTop
 */
export function negativeForwardSymbolicSlotsAreNotSamePath(items: {height: number}[], focused: number) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({y, height: item.height})
    y += item.height
  }
  return {
    currentTop: rows[focused]!.y,
    nextTop: rows[focused+1]!.y,
  }
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

type NegativeTypedTupleRows = [{height: number}, {height: number}]
type NegativeOptionalTupleRows = [{height: number}, {height: number}?]
type NegativeRestTupleRows = [{height: number}, ...{height: number}[]]

/** @fit
 * return[1].height: 0..40
 */
export function negativeTypedTupleShapeIsNotNumeric(input: NegativeTypedTupleRows) {
  return input
}

/** @fit
 * return.length == 2
 */
export function negativeOptionalTupleShapeIsNotExactLength(input: NegativeOptionalTupleRows) {
  return input
}

/** @fit
 * return.length == 2
 */
export function negativeRestTupleShapeIsNotExactLength(input: NegativeRestTupleRows) {
  return input
}

/** @fit
 * given navSizeX: 82 | 214
 * return: 40 | 120
 */
export function negativeUnionReturnOutsideSet(navSizeX: number) {
  return navSizeX
}

/** @fit
 * return: 0 | 100
 */
export function negativeUnionBranchInsideBoundsOutsideSet(folder: boolean) {
  return folder ? 0 : 50
}

/** @fit
 * given navSizeX: 82 | 214
 * return >= 82
 */
function negativeUnionGivenCallee(navSizeX: number) {
  return navSizeX
}

/** @fit
 * return >= 82
 */
export function negativeUnionGivenCallerOutsideSet() {
  return negativeUnionGivenCallee(150)
}

type NegativeDefaultSpring = {
  k: number // @fit > 0
}

function negativeDefaultSpring(
  k: number = -1, // @fit > 0
): NegativeDefaultSpring {
  return {k}
}

export function negativeDefaultArgumentViolatesGiven(): NegativeDefaultSpring {
  return negativeDefaultSpring()
}

export const negativeIifeDefaultArgumentViolatesType: NegativeDefaultSpring = ((k: number = -1) => ({k}))()

type NegativeStrictSpring = {
  k: number // @fit > 0
  b: number // @fit > 0
}

function negativeStrictSpring(
  k: number = 1, // @fit > 0
  b: number = 1, // @fit > 0
): NegativeStrictSpring {
  return {k, b}
}

function negativeStrictSpringBadDefault(
  b: number = 0, // @fit > 0
): NegativeStrictSpring {
  return {k: 1, b}
}

export function negativeStrictSpringDefault(): NegativeStrictSpring {
  return negativeStrictSpringBadDefault()
}

export function negativeStrictSpringCallArg(): NegativeStrictSpring {
  return negativeStrictSpring(-1)
}

export function negativeStrictSpringObjectArg(): NegativeStrictSpring {
  const params = {k: 1, b: 0}
  return negativeStrictSpring(params.k, params.b)
}

export function negativeStrictSpringManualObject(): NegativeStrictSpring {
  return {k: -1, b: 1}
}

export function negativeStrictSpringMutation(): NegativeStrictSpring {
  const spring = negativeStrictSpring()
  spring.k = -1
  return spring
}

export function negativeStrictSpringObjectAssign(): NegativeStrictSpring {
  return Object.assign(negativeStrictSpring(), {k: -1})
}

type NegativeMutatedMapItem = {
  value: number // @fit > 0
}

export function negativeMapCallbackMutationForgetsReturnedFact(): NegativeMutatedMapItem[] {
  const item = {value: 1}
  return [item].map(entry => {
    entry.value = -1
    return {value: entry.value}
  })
}

/** @fit
 * return: 0..Infinity
 */
export function negativePlainClientWidthIsNotAmbient(box: {clientWidth: number}) {
  return box.clientWidth
}

/** @fit
 * given width: 320..2000
 * return: 320..2000
 */
function negativeNeedsWideViewport(width: number) {
  return width
}

export const negativeAmbientClientWidthTooBroad = negativeNeedsWideViewport(document.documentElement.clientWidth)

/** @fit
 * given rect.x: 0..100
 * given rect.right: 0..100
 * given rect.y: 0..100
 * given rect.bottom: 0..100
 * return.x: 50..100
 */
export default (rect: {x: number; right: number; y: number; bottom: number}) => ({
  x: rect.x + (rect.right - rect.x) / 2,
  y: rect.y + (rect.bottom - rect.y) / 2,
})

/** @fit
 * given items[].height: 1..100
 * given items.length: 1..50
 * given gap: 0..10
 * spaced(return.rows, gap)
 */
export function negativeLoopCursorMovesWithoutPush(items: {height: number}[], gap: number) {
  const rows: {y: number; height: number}[] = []
  let y = 0
  for (const item of items) {
    if (item.height > 50) rows.push({y, height: item.height})
    y += item.height + gap
  }
  return {rows}
}

/** @fit
 * given items[].height: 1..100
 * given items.length: 1..50
 * return: 0..5000
 */
export function negativeLoopStaleBodyClaim(items: {height: number}[]): number {
  let y = 0
  for (const item of items) {
    const snapshot = y // @fit 0..0
    y += item.height + snapshot - snapshot
  }
  return y
}

/** @fit
 * given value: 0..10
 * return: 0..10
 */
export function negativeInlineCallBudget(value: number) {
  return chain1(value)
}

function chain1(value: number) {
  return chain2(value)
}

function chain2(value: number) {
  return chain3(value)
}

function chain3(value: number) {
  return chain4(value)
}

function chain4(value: number) {
  return chain5(value)
}

function chain5(value: number) {
  return chain6(value)
}

function chain6(value: number) {
  return chain7(value)
}

function chain7(value: number) {
  return chain8(value)
}

function chain8(value: number) {
  return chain9(value)
}

function chain9(value: number) {
  return chain10(value)
}

function chain10(value: number) {
  return chain11(value)
}

function chain11(value: number) {
  return chain12(value)
}

function chain12(value: number) {
  return value
}

// The former division-cancellation rules reasoned through a float quotient
// that can round across the integer boundary: with float pointers,
// cellSize = 4.044367056305642 and count = 13 admit
// floor(pointer / cellSize) == count even though pointer < count * cellSize.
// The integer variants are in-domain true but need a quotient-boundary margin
// the checker cannot yet justify, so all three report unknown.

/** @fit
 * given total: int 0..6000
 * given count: int 1..200
 * return >= total
 */
export function negativeCeilDivisionRoundsAcrossTotal(total: number, count: number) {
  return Math.ceil(total / count) * count
}

/** @fit
 * given pointer: 0..100000
 * given cellSize: int 1..1000
 * given count: int 1..1000
 * given pointer < count * cellSize
 * return < count
 */
export function negativeFloorHitIndexRoundsAcrossCount(pointer: number, cellSize: number, count: number) {
  const maxPointer = count * cellSize
  return pointer < maxPointer ? Math.floor(pointer / cellSize) : 0
}

// Conditional flush loops (push guarded by i % 3 or a last-index test, with a
// reset accumulator) rebind their cursor through a rounded computation the
// loop analysis cannot classify as an additive step yet, so their sequence
// facts stay underived for fractional data.

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given y: 0..1000
 * given gap: 0..10
 * return.rows[].bottom == return.rows[].y + return.rows[].height
 * nondecreasing(return.rows.y)
 * spaced(return.rows, gap)
 */
export function negativeSegmentedFlushSequenceFactsUnderived(items: {height: number}[], y: number, gap: number) {
  const rows = []
  let nextRowTop = y
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
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

// The real-arithmetic identities the rounding gate rejects: each of these
// proved before the gate and has an IEEE counterexample in its given range.

/** @fit
 * given x: 0..100
 * return == x
 */
export function negativeDivisionCancellationRounds(x: number) {
  // x = 0.9: (0.9 / 3) * 3 is 0.8999999999999999
  return (x / 3) * 3
}

/** @fit
 * given x: 0..100
 * given y: 0..1000000000
 * return == x
 */
export function negativeAddSubtractCancellationRounds(x: number, y: number) {
  // x = 0.1, y = 1e9: the sum absorbs x's low bits
  return x + y - y
}

/** @fit
 * given x: 1..100
 * return > x
 */
export function negativeSubUlpMarginIsAbsorbed(x: number) {
  // x = 1: 1 + 1e-30 === 1
  return x + 1e-30
}

/** @fit
 * given n: int 0..100
 * return == n * 0.1
 */
export function negativeRepeatedAdditionIsNotMultiplication(n: number) {
  // n = 6: six 0.1 additions give 0.6, but 6 * 0.1 is 0.6000000000000001
  let total = 0
  for (let i = 0; i < n; i++) {
    total += 0.1
  }
  return total
}

// Infinity is in-domain (`0..Infinity` is the canonical unbounded range), and
// these ops manufacture NaN from non-NaN operands: Infinity - Infinity,
// 0 * Infinity, and Infinity % d are all NaN, which fails every comparison.

/** @fit
 * given a: 0..Infinity
 * given b: 0..Infinity
 * given a >= b
 * return >= 0
 */
export function negativeInfinityMinusInfinityIsNaN(a: number, b: number) {
  return a - b
}

/** @fit
 * given a: 0..1
 * given b: 0..Infinity
 * return >= 0
 */
export function negativeZeroTimesInfinityIsNaN(a: number, b: number) {
  return a * b
}

/** @fit
 * given a: 0..Infinity
 * given b: 1..1000
 * return >= 0
 */
export function negativeInfinityModuloIsNaN(a: number, b: number) {
  return a % b
}
