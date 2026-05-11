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
 * given width: int 320..1600
 * return: int 320..1600
 */
export function constantBoundedInput(width: number) {
  return width
}

/** @fit
 * given value: int 0..10
 * return: int 5..15
 */
export function outputRangeFact(value: number) {
  const shifted = value + 5
  return shifted
}

/** @fit
 * given min <= max
 * return >= min
 * return <= max
 */
export const arrowFunctionContract = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export const arrowInlineClaims = (
  value: number, // @fit 0..10
) => ({
  next: value + 1, // @fit 1..11
})

type PatternRect = {x: number; y: number; width: number; height: number}

export const destructuredArrowParamClaims = ({x, y, width, height}: PatternRect) => ({
  x2: x + width, // @fit == x + width
  y2: y + height, // @fit == y + height
})

function tupleCenterOffsets(sourceX: number, sourceY: number, targetX: number, targetY: number): [number, number, number, number] {
  const xOffset = Math.abs(targetX - sourceX) / 2
  const yOffset = Math.abs(targetY - sourceY) / 2
  return [sourceX + xOffset, sourceY + yOffset, xOffset, yOffset]
}

export function arrayDestructuredLocalClaims(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const [, , offsetX, offsetY] = tupleCenterOffsets(sourceX, sourceY, targetX, targetY)
  return {
    offsetX, // @fit >= 0
    offsetY, // @fit >= 0
  }
}

export function localInlineRangeFacts() {
  // @fit int 0..10
  const index = Math.floor(4.2)
  const index2 = index + 1 // @fit int 0..10
  return index2
}

export function inlineObjectFieldRangeFacts() {
  return {
    width: 12, // @fit int 0..20
    nested: {
      // @fit int 0..3
      index: Math.floor(2.5),
    },
  }
}

/** @fit
 * return: 5..15
 */
export function inlineParamRangeFact(
  value: number, // @fit 0..10
) {
  return value + 5
}

/** @fit
 * given min <= max
 * return: 0..100
 */
export function inlineParamFactsMixWithFunctionFacts(
  value: number, // @fit 0..100
  min: number, // @fit 0..100
  max: number, // @fit 0..100
) {
  return Math.max(min, Math.min(value, max))
}

export function inlineParamGivensOnlyDoNotAuditBody(
  value: number, // @fit 0..10
) {
  return helperWithNarrowInput(value + 100)
}

function helperWithNarrowInput(
  value: number, // @fit 0..10
) {
  return value
}

/** @fit
 * given value: 0..5
 * return.high > return.low
 * return.low < return.high
 */
export function scalarComparisons(value: number) {
  const low = value
  const high = value + 10
  return {low, high}
}

/** @fit
 * given value: int 0..5
 * return.square: int 0..25
 * return.half: 0..2.5
 */
export function straightLineArithmetic(value: number) {
  const square = value ** 2
  const half = value / 2
  return {square, half}
}

/** @fit
 * given value: 10..20
 * return.width: 14..24
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
 * given value: 0..10
 * return: 4..14
 */
export function sameFilePureHelperCall(value: number) {
  return addPatternGap(value)
}

type LiteralColumnSpec =
  | {kind: 'ordered'; panelWidth: number}
  | {kind: 'inverted'; panelWidth: number}

function literalColumnGeometry(spec: LiteralColumnSpec, panelX: number) {
  switch (spec.kind) {
    case 'ordered': {
      const yThresholdX = panelX + 100
      const uThresholdX = panelX + 300
      return {
        kind: spec.kind,
        yThresholdX,
        uThresholdX,
        emptyIntervalWidth: uThresholdX - yThresholdX,
        collapseValueY: spec.panelWidth,
      }
    }
    case 'inverted': {
      const yThresholdX = panelX + 300
      const uThresholdX = panelX + 100
      return {
        kind: spec.kind,
        yThresholdX,
        uThresholdX,
        emptyIntervalWidth: 0,
        collapseValueY: spec.panelWidth,
      }
    }
  }
}

function literalIfColumnGeometry(kind: 'ordered' | 'inverted', panelX: number) {
  if (kind === 'ordered') {
    const yThresholdX = panelX + 100
    const uThresholdX = panelX + 300
    return {kind, yThresholdX, uThresholdX}
  }
  const yThresholdX = panelX + 300
  const uThresholdX = panelX + 100
  return {kind, yThresholdX, uThresholdX}
}

function booleanLiteralOffset(useFallback: boolean, top: number) {
  if (useFallback) return {slotY: top + 36}
  return {slotY: top}
}

/** @fit
 * given panelX: 0..1000
 * return.ordered.yThresholdX < return.ordered.uThresholdX
 * return.ordered.emptyIntervalWidth == 200
 * return.inverted.yThresholdX > return.inverted.uThresholdX
 * return.inverted.emptyIntervalWidth == 0
 * return.ifOrdered.yThresholdX < return.ifOrdered.uThresholdX
 * return.ifInverted.yThresholdX > return.ifInverted.uThresholdX
 */
export function finiteLiteralDiscriminantsSpecialize(panelX: number) {
  return {
    ordered: literalColumnGeometry({kind: 'ordered', panelWidth: 400}, panelX),
    inverted: literalColumnGeometry({kind: 'inverted', panelWidth: 400}, panelX),
    ifOrdered: literalIfColumnGeometry('ordered', panelX),
    ifInverted: literalIfColumnGeometry('inverted', panelX),
  }
}

/** @fit
 * given top: 0..1000
 * return.inline.slotY == top
 * return.fallback.slotY == top + 36
 */
export function booleanLiteralBranchesSpecialize(top: number) {
  return {
    inline: booleanLiteralOffset(false, top),
    fallback: booleanLiteralOffset(true, top),
  }
}

/** @fit
 * given value: int 0..10
 * return: int 3..7
 */
export function ternaryBranchJoin(value: number) {
  return value > 5 ? 7 : 3
}

/** @fit
 * given value: 0..100
 * given max: 10..50
 * return: 0..50
 * return <= max
 */
export function handwrittenMinTernary(value: number, max: number) {
  return value < max ? value : max
}

/** @fit
 * given value: 0..100
 * given min: 10..50
 * return: 10..100
 * return >= min
 */
export function handwrittenMaxTernary(value: number, min: number) {
  return value > min ? value : min
}

/** @fit
 * given value: 2..8
 * return.floorValue: int 1..4
 * return.ceilValue: int 1..4
 * return.floorValue <= value / 2
 * value / 2 >= return.floorValue
 * return.ceilValue >= value / 2
 * value / 2 <= return.ceilValue
 * return.roundValue: int 1..4
 * return.truncValue: int 1..4
 * return.sqrtValue: 1..3
 * return.absValue: 0..3
 * return.minValue: 2..4
 * return.minValue <= 4
 * return.maxValue: 4..8
 * return.maxValue >= 4
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
 * given width: 0..1000
 * given scale: 0..10
 * given floor: 0..1000
 * return.fitted <= width * scale
 * return.fitted <= 400
 * return.raised >= floor
 * return.raised >= width * scale
 */
export function mathChoiceCarriesBranchFacts(width: number, scale: number, floor: number) {
  const scaled = width * scale
  return {
    fitted: Math.min(scaled, 400),
    raised: Math.max(floor, scaled),
  }
}

/** @fit
 * given total: int 0..6000
 * given count: int 1..200
 * return >= total
 */
export function ceilDivisionCoversTotal(total: number, count: number) {
  return Math.ceil(total / count) * count
}

/** @fit
 * given pointer: 0..100000
 * given cellSize: int 1..1000
 * given count: int 1..1000
 * given pointer < count * cellSize
 * return >= 0
 * return < count
 */
export function floorHitIndexInsideCount(pointer: number, cellSize: number, count: number) {
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
 * given py < _countY * blockSize
 * return >= 0
 * return < countX * _countY
 */
export function flattenedGridHitIndex(px: number, py: number, blockSize: number, countX: number, _countY: number) {
  return Math.floor(py / blockSize) * countX + Math.floor(px / blockSize)
}

/** @fit
 * given items.length: int 1..50
 * given index: int 0..<items.length
 * return >= 0
 * return < items.length
 */
export function halfOpenIndexGiven(items: number[], index: number) {
  const length = items.length
  return index < length ? index : index
}

/** @fit
 * given scale > 0
 * return > 0
 */
export function positiveComparisonGiven(scale: number) {
  return scale
}

/** @fit
 * given content: 0..1000
 * given available: 0..1000
 * given scale: 0..8
 * given content <= available
 * return.scaled <= return.limit
 * return.swapped <= return.limit
 */
export function positiveScaleKeepsOrder(content: number, available: number, scale: number) {
  return {
    scaled: content * scale,
    swapped: scale * content,
    limit: available * scale,
  }
}

/** @fit
 * given scale > 0
 * given content * scale <= available * scale
 * return <= available
 */
export function positiveScaleCancellationKeepsOrder(content: number, available: number, scale: number) {
  void available
  void scale
  return content
}

/** @fit
 * given scale < 0
 * given content <= available
 * return <= content * scale
 */
export function negativeScaleFlipsOrder(content: number, available: number, scale: number) {
  void content
  return available * scale
}

/** @fit
 * given scale < 0
 * given available * scale <= content * scale
 * return <= available
 */
export function negativeScaleCancellationKeepsOrder(content: number, available: number, scale: number) {
  void available
  void scale
  return content
}

/** @fit
 * given width >= 100
 * given width <= 200
 * return >= 100
 * return <= 200
 */
export function comparisonOnlyGivenBounds(width: number) {
  return width
}

/** @fit
 * given x: -10..10
 * given y: -10..10
 * return >= 0
 */
export function logicalAndGuardCarriesBothFacts(x: number, y: number) {
  if (x >= 0 && y >= 0) return x + y
  return 0
}

/** @fit
 * given x: -10..10
 * given y: -10..10
 * return >= 0
 */
export function logicalOrExitCarriesBothFacts(x: number, y: number) {
  if (x < 0 || y < 0) return 0
  return x + y
}

/** @fit
 * given x: -10..10
 * given y: -10..10
 * return >= 0
 */
export function logicalNotGuardCarriesFact(x: number, y: number) {
  if (!(x < 0) && !(y < 0)) return x + y
  return 0
}

/** @fit
 * given content: 0..1000
 * given available: 0..1000
 * given columns: int 1..12
 * given content <= available
 * return.cell <= return.maxCell
 */
export function positiveDivisionKeepsOrder(content: number, available: number, columns: number) {
  return {
    cell: content / columns,
    maxCell: available / columns,
  }
}

/** @fit
 * given left <= right
 * return.floorLeft <= return.floorRight
 * return.ceilLeft <= return.ceilRight
 */
export function roundingKeepsNonStrictOrder(left: number, right: number) {
  return {
    floorLeft: Math.floor(left),
    floorRight: Math.floor(right),
    ceilLeft: Math.ceil(left),
    ceilRight: Math.ceil(right),
  }
}

/** @fit
 * given index: int 0..10000
 * given count: int 1..1000
 * return: int 0..999
 * return < count
 */
export function moduloWrapsInsideCount(index: number, count: number) {
  return index % count
}

/** @fit
 * given width: 0..1000
 * given minWidth: 0..1000
 * return >= minWidth
 */
export function guardReturnKeepsMinimum(width: number, minWidth: number) {
  if (width < minWidth) return minWidth
  return width
}

/** @fit
 * given width: 0..100
 * return: 0..100
 */
export function branchAssignmentFallsThrough(width: number) {
  let chosen = 0
  if (width > 40) {
    chosen = width
  }
  return chosen
}

/** @fit
 * return.total: 11 | 22
 */
export function branchStateKeepsCorrelatedAssignments(flag: boolean) {
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
 * return.total: 11 | 22
 */
export function conditionalExpressionPrunesContradictoryNumericCases(n: number) {
  const x = n > 4 ? 1 : 2
  const y = n > 4 ? 10 : 20
  return {total: x + y}
}

/** @fit
 * given a: int 0..1
 * given b: int 0..1
 * given c: int 0..1
 * return: int 0..7
 */
export function statePartitionBudgetAllowsEightStates(a: number, b: number, c: number) {
  let total = 0
  if (a > 0) total += 1
  if (b > 0) total += 2
  if (c > 0) total += 4
  return total
}

/** @fit
 * given a: int 0..1
 * given b: int 0..1
 * given c: int 0..1
 * given d: int 0..1
 * return: 1
 */
export function statePartitionBudgetPreservesStableFacts(a: number, b: number, c: number, d: number) {
  let _total = 0
  const stable = 1
  if (a > 0) _total += 1
  if (b > 0) _total += 2
  if (c > 0) _total += 4
  if (d > 0) _total += 8
  return stable
}

/** @fit
 * given step: -10..10
 * return > 0
 */
export function throwGuardNarrowsPositive(step: number) {
  if (step <= 0) {
    throw new Error('step must be positive')
  }
  return step
}

/** @fit
 * given step: -10..10
 * return > 0
 */
export function returnBranchIgnoresThrowingPath(step: number) {
  if (step > 0) return step
  throw new Error('step must be positive')
}

/** @fit
 * given value: -100..100
 * given min: 1..100
 * given max: 1..100
 * given min <= max
 * return: -1..1
 */
export function elseIfBranchesReturn(value: number, min: number, max: number) {
  if (value < -min) {
    return -1
  } else if (value > max) {
    return 1
  }
  return 0
}

export function mathSignRange(
  value: number, // @fit -10..10
) {
  return Math.sign(value) // @fit int -1..1
}

/** @fit
 * given value: 0..10000
 * return: 0..100
 */
export function signedSqrtNonnegative(value: number) {
  return Math.sign(value) * Math.sqrt(Math.abs(value))
}

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
 * given top: 0..1000
 * given step: 0..40
 * given gap: 0..10
 * return.rows.length == items.length
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 * lastEnd(return.rows) == return.bottom
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
 * given item.height: 0..40
 * given item.top: 0..1000
 * return.bottom >= item.top
 * return.height: 0..40
 */
export function objectFieldDomain(item: {top: number; height: number}) {
  return {height: item.height, bottom: item.top + item.height}
}

/** @fit
 * given base.x: 0..100
 * given y: 0..100
 * return.x: 0..100
 * return.y: 0..100
 */
export function objectSpreadKeepsFields(base: {x: number}, y: number) {
  return {
    ...base,
    y,
  } satisfies {x: number; y: number}
}

/** @fit
 * return.rows == input.rows
 */
export function arrayIdentityEquality(input: {rows: {height: number}[]}) {
  return {rows: input.rows}
}

/** @fit
 * given child.x: 0..1000
 * given child.w: 0..500
 * given parent.x: 0..1000
 * given parent.w: 0..2000
 * given child.x >= parent.x
 * given child.x + child.w <= parent.x + parent.w
 * return.right <= parent.x + parent.w
 */
export function rectInsideAsFieldMath(child: {x: number; w: number}, parent: {x: number; w: number}) {
  return {right: child.x + child.w, parentRight: parent.x + parent.w}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given index: int 0..49
 * given index < items.length
 * return: 0..40
 */
export function indexedPerItemField(items: {height: number}[], index: number) {
  return items[index]!.height
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * return.bottom >= top
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 * lastEnd(return.rows) == return.bottom
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
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 * return.rows[].rowRect.height: 0..40
 * nondecreasing(return.rows.rowRect.top)
 * return.rows[$i + 1].rowRect.top == return.rows[$i].rowRect.top + return.rows[$i].rowRect.height + gap
 */
export function nestedRowRectRunningSumLoop(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({rowRect: {top: y, height: item.height}, source: item})
    y += item.height + gap
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 * return.rows[$i + 1].top >= return.rows[$i].bottom + gap
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 */
export function segmentedStackRows(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let nextRowTop = top
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const layoutHeight = item.height
    rowHeight = Math.max(rowHeight, layoutHeight)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      rows.push({top: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + gap
      rowHeight = 0
    }
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 * return.rows[$i + 1].top >= return.rows[$i].bottom + gap
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 */
export function segmentedStackRowsInlineBottom(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let nextRowTop = top
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      rows.push({top: rowTop, height: rowHeight, bottom: rowTop + rowHeight})
      nextRowTop = rowTop + rowHeight + gap
      rowHeight = 0
    }
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.measurements.length == items.length
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 */
export function segmentedStackRowsWithSideAppend(items: {height: number}[], top: number, gap: number) {
  const rows = []
  const measurements = []
  let nextRowTop = top
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const layoutHeight = item.height
    measurements.push({layoutHeight})
    rowHeight = Math.max(rowHeight, layoutHeight)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      rows.push({top: rowTop, height: rowHeight, bottom: rowBottom})
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
 * given top: 0..1000
 * given step: 0..40
 * return.length == items.length
 * return[]: 0..3000
 */
export function scalarPushLoop(items: number[], top: number, step: number) {
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

type TypedShapeParams = {
  items: {height: number}[]
}

type OptionalRowsShape = {
  rows?: {height: number}[]
}

/** @fit
 * return >= 0
 */
export function guardedOptionalRowsLength(input: OptionalRowsShape) {
  if (input.rows == null) return 0
  return input.rows.length
}

declare const structuralShapeApi: {
  wrapRows(items: {height: number}[]): {rows: {height: number}[]}
  row(item: {height: number}): {height: number; cells: {width: number}[]}
}

/** @fit
 * return.rows.length >= 0
 */
export function typedArrayParamShape(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * return.rows.length >= 0
 */
export function typedObjectParamArrayShape(params: TypedShapeParams) {
  const rows = params.items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * return.rows.length >= 0
 */
export function propertyAccessCallShape(items: {height: number}[]) {
  return structuralShapeApi.wrapRows(items)
}

/** @fit
 * return.rows.length == items.length
 * return.rows[].cells.length >= 0
 */
export function mapCallbackReturnShape(items: {height: number}[]) {
  const rows = items.map(item => structuralShapeApi.row(item))
  return {rows}
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
 * given top: 0..1000
 * given gap: 0..10
 * return.bottom >= top
 * return.rows.length == items.length
 */
export function localLoopAnnotation(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let y = top
  /** @fit
   * given items[].height: 0..40
   * rows.length == items.length
   * rows[].height: 0..40
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

type TypeFieldSpring = {
  pos: number
  dest: number
  k: number // @fit > 0
  b: number // @fit >= 0
}

type TypeFieldRows = {
  rows: {
    height: number // @fit 0..40
  }[]
}

/** @fit
 * return > 0
 */
export function typeFieldParamGiven(spring: TypeFieldSpring) {
  return spring.k
}

export function typeFieldReturnCheck(): TypeFieldSpring {
  return {pos: 0, dest: 0, k: 290, b: 30}
}

/** @fit
 * return > 0
 */
export function typeFieldCallBoundary() {
  const spring = {pos: 0, dest: 0, k: 290, b: 30}
  return typeFieldParamGiven(spring)
}

/** @fit
 * return.rows[].height: 0..40
 */
export function typeFieldArrayElementGiven(input: TypeFieldRows) {
  const rows = input.rows.map(row => ({height: row.height}))
  return {rows}
}

export function typeFieldLocalBoundary() {
  const spring: TypeFieldSpring = {pos: 0, dest: 0, k: 290, b: 30}
  return spring
}

export function typeFieldSatisfiesReturn() {
  return {pos: 0, dest: 0, k: 290, b: 30} satisfies TypeFieldSpring
}

export function typeFieldAsReturn() {
  return {pos: 0, dest: 0, k: 290, b: 30} as TypeFieldSpring
}

type TypeRelationSpring = {
  k: number
  b: number
  // @fit k > b
}

/** @fit
 * high >= low
 */
type TypeRelationBounds = {
  low: number
  high: number
}

type TypeRelationRows = {
  rows: {
    top: number
    bottom: number
    // @fit bottom >= top
    cells: {
      left: number
      right: number
      // @fit right >= left
    }[]
  }[]
}

/** @fit
 * return > spring.b
 */
export function typeRelationParamGiven(spring: TypeRelationSpring) {
  return spring.k
}

export function typeRelationReturnCheck(): TypeRelationSpring {
  return {k: 290, b: 30}
}

export function typeRelationBlockReturnCheck(): TypeRelationBounds {
  return {low: 0, high: 10}
}

/** @fit
 * return > 0
 */
export function typeRelationCallBoundary() {
  const spring = {k: 290, b: 30}
  return typeRelationParamGiven(spring)
}

export function typeRelationNestedReturnCheck(): TypeRelationRows {
  return {rows: [{top: 0, bottom: 10, cells: [{left: 1, right: 4}]}]}
}

/** @fit
 * return >= y
 * return: 0..Infinity
 */
export function oneSidedInfinityAdd(
  y: number, // @fit 0..Infinity
  gapTop: number, // @fit 0..Infinity
) {
  return y + gapTop
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 */
export function segmentedStackRowsWithGuardLocalResetAlias(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let nextRowTop = top
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      const rowBottom = rowTop + rowHeight
      const resetHeight = 0
      rows.push({top: rowTop, height: rowHeight, bottom: rowBottom})
      nextRowTop = rowBottom + gap
      rowHeight = resetHeight
    }
  }
  return {rows}
}

export function inlineComparisonFacts(
  value: number, // @fit 0..100
  max: number, // @fit >= value
) {
  const next = value + 1 // @fit > value
  return {
    width: Math.min(value, max), // @fit <= max
    next, // @fit > value
  }
}

export function inlineReturnComparisonFact(
  value: number, // @fit 0..100
  max: number, // @fit >= value
) {
  return Math.min(value, max) // @fit <= max
}

export function inlineComparisonPrefixVariants(
  value: number, // @fit >= min
  min: number, // @fit 0..100
  max: number, // @fit >= value
) {
  const exact = value // @fit == value
  const above = value + 1 // @fit > value
  const below = value - 1 // @fit < value
  const floored = Math.max(value, min) // @fit >= min
  return {
    atLeast: floored, // @fit >= min
    atMost: Math.min(value, max), // @fit <= max
    exact, // @fit == value
    above, // @fit > value
    below, // @fit < value
  }
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * extentEnd(return.rows, top) == return.bottom
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
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 */
export function mapRowsKeepsLengthAndFields(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..100
 * return.rows.length == items.length
 * return.rows[].index: int 0..49
 * return.rows[].index < items.length
 * return.rows[].height: 0..40
 */
export function mapRowsKeepsIndexAndClampedFields(items: {height: number}[]) {
  const rows = items.map((item, index) => ({
    index,
    height: clampLayoutValue(item.height, 0, 40),
  }))
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * return.rows[].index: int 0..49
 * return.rows[].index < items.length
 */
export function mapBlockRowsWithDestructure(items: {height: number}[]) {
  const rows = items.map((item, index) => {
    const {height} = item
    return {index, height}
  })
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..100
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * return.rows[].index: int 0..49
 * return.rows[].index < items.length
 */
export function mapFunctionBlockRows(items: {height: number}[]) {
  const rows = items.map(function (item, index) {
    const height = clampLayoutValue(item.height, 0, 40)
    return {index, height}
  })
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: -40..40
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 */
export function mapIfBranchRows(items: {height: number}[]) {
  const rows = items.map(item => {
    const {height} = item
    if (height < 0) return {height: 0}
    return {height}
  })
  return {rows}
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
 * given params.top: 0..1000
 * return.rows.length == params.items.length
 * return.rows[].index: int 0..49
 * return.rows[].index < params.items.length
 * return.rows[].height: 0..40
 * return.bottom >= params.top
 * nondecreasing(return.rows.top)
 * lastEnd(return.rows) == return.bottom
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
 * given top: 0..1000
 * return.rows.length <= items.length
 * return.rows[].top: 0..3000
 * return.rows[].height: 0..40
 * return.bottom >= top
 */
export function conditionalPushRowsWithCursor(items: {height: number; visible: boolean}[], top: number) {
  const rows = []
  let y = top
  for (const item of items) {
    if (item.visible) rows.push({top: y, height: item.height})
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
export function indexedConditionalPushRows(items: {height: number; visible: boolean}[]) {
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
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function filteredRowsKeepElementDomain(items: {height: number; visible: boolean}[]) {
  const rows = items.filter(item => item.visible)
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: -40..40
 * return.rows.length <= items.length
 * return.rows[].height > 0
 */
export function filteredRowsCarryPredicate(items: {height: number; visible: boolean}[]) {
  const rows = items.filter(item => item.height > 0)
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: -40..40
 * return.rows.length <= items.length
 * return.rows[].height >= 0
 */
export function filteredRowsCarryBlockPredicate(items: {height: number; visible: boolean}[]) {
  const rows = items.filter(item => {
    return item.height >= 0
  })
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
export function filteredMappedRowsKeepBaseLineage(items: {height: number; visible: boolean}[]) {
  const rows = items
    .filter(item => item.visible)
    .map(item => ({height: item.height}))
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
 * given top: 0..1000
 * given gap: 0..10
 * given parent.bottom: 4000..5000
 * return.rows[].top <= parent.bottom
 * return.rows[].top + return.rows[].height <= parent.bottom
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
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[$i].height == items[$i].height
 */
export function sameIndexRowsKeepItemHeight(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows[$i].top <= return.rows[$i + 1].top
 */
export function adjacentBoundIndexRowsAreNondecreasing(items: {height: number}[]) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows}
}

/** @fit
 * given sections[].rows[].height: 0..40
 * given maxHeight: 40..100
 * return.sections[].rows[].height: 0..40
 * return.sections[].rows[].height <= maxHeight
 */
export function nestedWildcardRows(sections: {rows: {height: number}[]}[], maxHeight: number) {
  return {sections, maxHeight}
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[].height: 0..40
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
 * given width: 0..1000
 * return.capped: 0..320
 * return.overflow >= 0
 */
export function pathSensitiveMinOverflow(width: number) {
  const capped = Math.min(width, 320)
  const overflow = width - capped
  return {capped, overflow}
}

/** @fit
 * given width: 0..1000
 * return.overflow >= 0
 */
export function pathSensitiveMinOverflowTernaryInset(width: number, folder: boolean) {
  const inset = folder ? 108 : 68
  const capped = Math.min(width, inset)
  return {overflow: width - capped}
}

/** @fit
 * given width: 0..1000
 * given padding: 0..120
 * return.content: 0..1000
 * return.leftover >= 0
 */
export function pathSensitiveMaxLeftover(width: number, padding: number) {
  const content = Math.max(width - padding, 0)
  const leftover = width - content
  return {content, leftover}
}

/** @fit
 * given value: -1000..1000
 * given min: -1000..1000
 * given max: -1000..1000
 * given max >= min
 * return >= min
 * return <= max
 */
function clampLayoutValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

/** @fit
 * given value: -1000..1000
 * return: 0..320
 */
export function userlandClamp(value: number) {
  return clampLayoutValue(value, 0, 320)
}

/** @fit
 * given bounds.min: -1000..1000
 * given bounds.max: -1000..1000
 * given bounds.min <= bounds.max
 * given value: -1000..1000
 * return >= bounds.min
 * return <= bounds.max
 */
export function userlandClampThroughScalarAliases(bounds: {min: number; max: number}, value: number) {
  const low = bounds.min
  const high = bounds.max
  const min = low
  const max = high
  return clampLayoutValue(value, min, max)
}

/** @fit
 * given position.cols: 0..1000
 * given w: 0..position.cols
 * given value: -1000..1000
 * return >= 0
 * return <= position.cols - w
 */
export function userlandClampThroughArithmeticAlias(position: {cols: number}, w: number, value: number) {
  const {cols} = position
  const max = cols - w
  return clampLayoutValue(value, 0, max)
}

/** @fit
 * given extent[0][0]: -1000..1000
 * given extent[1][0]: -1000..1000
 * given width: 0..10
 * given value: -1000..1000
 * given extent[0][0] <= extent[1][0] - width
 * return >= extent[0][0]
 * return <= extent[1][0] - width
 */
export function userlandClampThroughFixedElementPaths(extent: [[number, number], [number, number]], width: number, value: number) {
  return clampLayoutValue(value, extent[0][0], extent[1][0] - width)
}

export function silentHelperSummaryFeedsReturnField(
  containerWidth: number, // @fit 320..2000
) {
  const cols = conditionalClampLayoutValue(1, Math.floor(containerWidth / 240), 7)
  return {
    cols, // @fit int 1..7
  }
}

function loopReadHelper(index: number) {
  return index + 1
}

export function forgettableLoopNamedCallPreservesUnrelated(
  items: number[],
  value: number, // @fit 0..10
) {
  let scratch = 0
  const kept = value
  for (let i = 1; i < items.length - 1; i++) {
    scratch += loopReadHelper(i)
  }
  return kept // @fit 0..10
}

export function forgettableWhileLoopPreservesUnrelated(
  items: number[],
  value: number, // @fit 0..10
) {
  let scratch = 0
  let i = 0
  const kept = value
  while (i < items.length) {
    scratch += items[i]!
    i++
  }
  return kept // @fit 0..10
}

/** @fit
 * return.length == 2
 * return[1]: 0..10
 */
export function scalarStringishMutationPreservesTupleFacts(
  items: number[],
  value: number, // @fit 0..10
): [string, number] {
  let path = ''
  path += `M ${items.length}`
  return [path, value]
}

/** @fit
 * given value: -1000..1000
 * given min: -1000..1000
 * given max: -1000..1000
 * given max >= min
 * return >= min
 * return <= max
 */
export function userlandClampWithVariableBounds(value: number, min: number, max: number) {
  return clampLayoutValue(value, min, max)
}

/** @fit
 * given min: -1000..1000
 * given value: -1000..1000
 * given max: -1000..1000
 * given max >= min
 * return >= min
 * return <= max
 */
function conditionalClampLayoutValue(min: number, value: number, max: number) {
  return value > max ? max : value < min ? min : value
}

/** @fit
 * given min: -1000..1000
 * given value: -1000..1000
 * given max: -1000..1000
 * given max >= min
 * return >= min
 * return <= max
 */
function ifClampLayoutValue(min: number, value: number, max: number) {
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
 * return.cols: int 1..7
 */
export function localHelperPostconditionRange(containerWidth: number) {
  const cols = conditionalClampLayoutValue(1, Math.floor(containerWidth / 240), 7)
  return {cols}
}

/** @fit
 * given value: -1000..1000
 * return: 0..320
 */
export function ifClampFeedsLocalHelper(value: number) {
  return ifClampLayoutValue(0, value, 320)
}

type TypedTupleRows = [{height: number}, {height: number}]

/** @fit
 * return.length == 2
 * return[0].height == input[0].height
 * return[1].height == input[1].height
 */
export function typedTupleSlotShape(input: TypedTupleRows) {
  return input
}

/** @fit
 * given items.length: int 0..100
 * return: int 0..100
 */
export function arrayLengthRange(items: number[]) {
  return items.length
}

/** @fit
 * return: int 3..3
 */
export function arrayLiteralLength() {
  const values = [10, 20, 30]
  return values.length
}

/** @fit
 * given index: int 0..2
 * return: int 10..30
 */
export function arrayLiteralIndex(index: number) {
  return [10, 20, 30][index]
}

/** @fit
 * given index: 0 | 2
 * return: 10 | 30
 */
export function arrayLiteralFiniteIndexCases(index: number) {
  const values: [10, 20, 30] = [10, 20, 30]
  return values[index]
}

/** @fit
 * return: int 30..30
 */
export function arrayLiteralAtLast() {
  const values: [10, 20, 30] = [10, 20, 30]
  return values.at(-1)!
}

/** @fit
 * return: int 20..20
 */
export function arrayLiteralAtSecondLast() {
  const values: [10, 20, 30] = [10, 20, 30]
  return values.at(-2)!
}

/** @fit
 * given items.length: int 1..50
 * given items[]: 0..40
 * return: 0..40
 */
export function arrayAtLastKeepsElementDomain(items: number[]) {
  return items.at(-1)!
}

/** @fit
 * given items.length: int 2..50
 * given items[]: 0..40
 * return: 0..40
 */
export function arrayAtSecondLastKeepsElementDomain(items: number[]) {
  return items.at(-2)!
}

/** @fit
 * given count: int 0..100
 * return.length == count
 */
export function typedArrayConstructorKeepsLength(count: number) {
  return new Int8Array(count)
}

/** @fit
 * given items.length: int 0..100
 * return.length == items.length
 */
export function typedArrayConstructorKeepsSourceLength(items: number[]) {
  return new Uint16Array(items.length)
}

/** @fit
 * given items.length: int 1..50
 * given items[]: 0..40
 * given focused: int 0..<items.length
 * return: 0..40
 */
export function strictIntegerPredecessorArrayIndex(items: number[], focused: number) {
  if (focused > 0) return items[focused - 1]!
  return items[0]!
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given focused: int 0..<items.length
 * return.current: 0..40
 */
export function focusedIndexKeepsElementDomain(items: {height: number}[], focused: number) {
  return {current: items[focused]!.height}
}

/** @fit
 * given items.length: int 2..50
 * given items[].height: 0..40
 * given focused: int 1..<items.length
 * return.currentTop >= return.previousTop
 */
export function focusedIndexUsesAdjacentSequenceFact(items: {height: number}[], focused: number) {
  const rows = []
  let top = 0
  for (const item of items) {
    rows.push({top, height: item.height})
    top += item.height
  }
  return {
    previousTop: rows[focused - 1]!.top,
    currentTop: rows[focused]!.top,
  }
}

/** @fit
 * given items.length: int 2..50
 * given items[].height: 0..40
 * given focused: int 0..<items.length
 * given focused + 1 < items.length
 * return.nextTop >= return.currentTop
 */
export function focusedIndexUsesForwardAdjacentSequenceFact(items: {height: number}[], focused: number) {
  const rows = []
  let top = 0
  for (const item of items) {
    rows.push({top, height: item.height})
    top += item.height
  }
  return {
    currentTop: rows[focused]!.top,
    nextTop: rows[focused+1]!.top,
  }
}

/** @fit
 * given focused: int 0..1000
 * return: int 0..1000
 */
export function nestedBranchLocalReturnChecks(focused: number) {
  if (focused > 0) {
    if (focused > 1) return focused - 2 // @fit >= 0
    return 0
  }
  return focused // @fit == 0
}

/** @fit
 * given navSizeX: 82 | 214
 * return: 82 | 214
 * return >= 82
 * return <= 214
 */
export function literalUnionGivenPassesThrough(navSizeX: number) {
  return navSizeX
}

export function literalUnionGivenOnParam(
  searchSlot: number, // @fit 0 | 40 | 200 | 213
) {
  return searchSlot + 14 // @fit 14 | 54 | 214 | 227
}

/** @fit
 * return: 0 | 100
 */
export function literalUnionBranchReturn(folder: boolean) {
  return folder ? 0 : 100
}

/** @fit
 * given count: int 1..50
 * given focused: int 0..<count
 * return.targetIndex: int 0..49
 * return.targetIndex < count
 */
export function ternaryBranchLocalFieldChecks(count: number, focused: number) {
  return focused > 0
    ? {
      count,
      targetIndex: focused - 1, // @fit >= 0
    }
    : {
      count,
      targetIndex: focused, // @fit == 0
    }
}

/** @fit
 * given focused: int 0..50
 * return: int 0..49
 */
export function nullableBranchKeepsPresentNumberFacts(focused: number) {
  const previous = focused > 0 ? focused - 1 : null
  if (previous == null) return 0
  return previous
}

/** @fit
 * given count: int 1..50
 * given focused: int 0..<count
 * return.targetIndex: int 0..49
 * return.targetIndex < count
 */
export function nullableBranchKeepsPresentObjectFacts(count: number, focused: number) {
  const previous = focused > 0 ? {count, targetIndex: focused - 1} : null
  return previous != null ? previous : {count, targetIndex: focused}
}

/** @fit
 * given focused: int 0..50
 * return: int 0..49
 */
export function nullablePropertyGuardKeepsPresentObjectFacts(focused: number) {
  const state = {
    previous: focused > 0 ? {targetIndex: focused - 1} : null,
  }
  if (state.previous == null) return 0
  return state.previous.targetIndex
}

export function typeofUndefinedGuardKeepsOptionalNumber(max?: number) {
  if (typeof max !== 'undefined') {
    return Math.max(max, 0) // @fit >= max
  }
  return 0
}

export function optionalPropertyNullishFallbackFeedsMath(dimensions: {width?: number}) {
  return Math.max(dimensions?.width ?? 0, 0) // @fit >= 0
}

export function nullableObjectOptionalChainFallbackFeedsMath(dimensions: {width: number} | null) {
  return Math.max(dimensions?.width ?? 0, 0) // @fit >= 0
}

/** @fit
 * given items.length: int 0..100
 * given index: int 0..100
 * given index < items.length
 * return.index >= 0
 * return.index < items.length
 * return.length == items.length
 */
export function halfOpenArrayIndex(items: number[], index: number) {
  return {index, length: items.length}
}

/** @fit
 * given items.length: int 0..20
 * return.length: int 1..21
 * return.length == items.length + 1
 */
export function spreadAppendLength(items: number[], value: number) {
  return [...items, value]
}

/** @fit
 * given items.length: int 0..10
 * return: int 0..10
 */
function shortArrayLength(items: number[]) {
  return items.length
}

/** @fit
 * given items.length: int 0..10
 * return: int 0..10
 */
export function arrayLengthGivenThroughHelper(items: number[]) {
  return shortArrayLength(items)
}

/** @fit
 * given containee: 0..10000
 * given container: 0..10000
 * return == (container - containee) / 2
 */
export function exactExpressionIdentity(containee: number, container: number) {
  return (container - containee) / 2
}

/** @fit
 * given containee: 0..1000
 * given container: 0..1000
 * given container >= containee
 * return >= 0
 */
export function centeredOffset(containee: number, container: number) {
  return (container - containee) / 2
}

/** @fit
 * given containee: 0..1000
 * given container: 0..1000
 * given container >= containee
 * return >= 0
 */
export function centeredOffsetThroughHelper(containee: number, container: number) {
  return centeredOffset(containee, container)
}

/** @fit
 * given containee: 0..1000
 * given padding: 0..100
 * given container: 0..1200
 * given container >= containee + padding
 * return.offset >= 0
 */
export function centeredOffsetWithPaddingSlack(containee: number, padding: number, container: number) {
  return {offset: (container - containee) / 2, padding}
}

/** @fit
 * given value: 4..14
 * return: 5..15
 */
function trackedInnerGiven(value: number) {
  return value + 1
}

/** @fit
 * given value: 0..10
 * return: 5..15
 */
function trackedMiddleGiven(value: number) {
  return trackedInnerGiven(value + patternGap)
}

/** @fit
 * given value: 0..10
 * return: 5..15
 */
export function transitiveGivenTracking(value: number) {
  return trackedMiddleGiven(value)
}

export function inlineCommentFormatVariants(
  // @fit 0..10
  lineParam: number,
  trailingParam: number, // @fit 0..10
) {
  // @fit int 0..10
  const lineLocal = Math.floor(lineParam)
  const trailingLocal = Math.floor(trailingParam) // @fit int 0..10
  return {
    // @fit int 0..10
    lineField: lineLocal,
    trailingField: trailingLocal, // @fit int 0..10
  }
}

/** @fit
 * given total: int -6000..6000
 * given count: int 1..200
 * return >= total
 */
export function ceilDivisionCoversSignedTotal(total: number, count: number) {
  return Math.ceil(total / count) * count
}

/** @fit
 * given width: 0..1000
 * given cap: 0..1000
 * given limit: 0..1000
 * return <= Math.min(width, cap)
 */
export function mathMinCanBeComparisonBound(width: number, cap: number, limit: number) {
  const capped = Math.min(width, cap)
  return Math.min(capped, limit)
}

/** @fit
 * given low * scale <= _mid * scale
 * given _mid * scale <= _high * scale
 * return <= _high * scale
 */
export function opaqueInequalityGraphTransitivity(low: number, _mid: number, _high: number, scale: number) {
  return low * scale
}

/** @fit
 * given low <= mid
 * given mid <= high
 * return.low <= return.mid
 * return.mid <= return.high
 */
function orderedTriple(low: number, mid: number, high: number) {
  return {low, mid, high}
}

/** @fit
 * given low <= mid
 * given mid <= high
 * return.low <= return.high
 */
export function helperResultComparisonFactsCompose(low: number, mid: number, high: number) {
  return orderedTriple(low, mid, high)
}

export const topLevelInlineCallClaim = clampLayoutValue(2, 1, 3) // @fit 2

export class ClassMethodThisClaims {
  constructor(
    public top: number,
    public height: number,
    public width: number,
  ) {}

  /** @fit
   * given this.top: 0..1000
   * given this.height: 0..1000
   * return == this.top + this.height
   * return: 0..2000
   */
  get bottom() {
    return this.top + this.height
  }

  /** @fit
   * given this.width: 0..1000
   * given this.height: 0..1000
   * return: 0..1000000
   */
  area() {
    return this.width * this.height
  }
}

/** @fit
 * given box.top: 0..1000
 * given box.height: 0..1000
 * return: 0..2000
 */
export function classGetterSummary(box: ClassMethodThisClaims) {
  return box.bottom
}

/** @fit
 * given box.width: 0..1000
 * given box.height: 0..1000
 * return: 0..1000000
 */
export function classMethodSummary(box: ClassMethodThisClaims) {
  return box.area()
}

/** @fit
 * return: int 0..Infinity
 */
export function ambientDocumentElementClientWidth() {
  return document.documentElement.clientWidth
}

/** @fit
 * return: int 0..Infinity
 */
export function ambientBareInnerWidth() {
  return innerWidth
}

/** @fit
 * return: int 0..Infinity
 */
export function ambientCanvasWidth(canvas: HTMLCanvasElement) {
  return canvas.width
}

/** @fit
 * return: 0..Infinity
 */
export function ambientResizeObserverInlineSize(size: ResizeObserverSize) {
  return size.inlineSize
}

/** @fit
 * given rect.left: -1000..1000
 * given rect.right: -1000..1000
 * given rect.top: -1000..1000
 * given rect.bottom: -1000..1000
 * return.x: -1000..1000
 * return.y: -1000..1000
 */
export default (rect: {left: number; right: number; top: number; bottom: number}) => ({
  x: rect.left + (rect.right - rect.left) / 2,
  y: rect.top + (rect.bottom - rect.top) / 2,
})
