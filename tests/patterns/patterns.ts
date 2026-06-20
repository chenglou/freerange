// Runnable checker pattern specimen. `bun run test` must run this file.
//
// Queued patterns:
// - `rectInside`
// - `rectEquals`
// - `nonOverlapX` / `nonOverlapY`
// - column/row width reasoning: tables, grids, flex-like negotiation, cells that cover multiple columns
// - Pretext text facts: line width fits, fragments are ordered, fragments cover ranges, selection rects reuse paint fragments

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

/** @fit
 * given x: 0..1000
 * given y: 0..1000
 * given width: 0..1000
 * given height: 0..1000
 */
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
  return helperWithNarrowInput(value)
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
  const square = value * value
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

function booleanLiteralOffset(useFallback: boolean, y: number) {
  if (useFallback) return {slotY: y + 36}
  return {slotY: y}
}

/** @fit
 * given panelX: int 0..1000
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
 * given y: 0..1000
 * return.inline.slotY == y
 * return.fallback.slotY == y + 36
 */
export function booleanLiteralBranchesSpecialize(y: number) {
  return {
    inline: booleanLiteralOffset(false, y),
    fallback: booleanLiteralOffset(true, y),
  }
}

/** @fit
 * return: {x: 0, width: 100} | {x: 20, width: 80}
 */
export function pairedObjectReturnShape(pinned: boolean) {
  if (pinned) return {x: 20, width: 80} as const
  return {x: 0, width: 100} as const
}

export function lowShapeBound() {
  return 10
}

export function highShapeBound() {
  return 20
}

/** @fit
 * return: {rows: {height: lowShapeBound()..highShapeBound()}[]}
 */
export function arrayObjectReturnShape() {
  return {
    rows: [
      {height: 10},
      {height: 20},
    ],
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
 * given scale < 0
 * given content <= available
 * return <= content * scale
 */
export function negativeScaleFlipsOrder(content: number, available: number, scale: number) {
  void content
  return available * scale
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
 * given x <= right
 * return.floorLeft <= return.floorRight
 * return.ceilLeft <= return.ceilRight
 */
export function roundingKeepsNonStrictOrder(x: number, right: number) {
  return {
    floorLeft: Math.floor(x),
    floorRight: Math.floor(right),
    ceilLeft: Math.ceil(x),
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
export function conditionalExpressionKeepsOneResultTogether(n: number) {
  const pair = n > 4
    ? {x: 1, y: 10}
    : {x: 2, y: 20}
  return {total: pair.x + pair.y}
}

/** @fit
 * return: 11 | 22
 */
export function conditionalTupleKeepsOneResultTogether(flag: boolean) {
  const pair = flag
    ? [1, 10] as const
    : [2, 20] as const
  return pair[0] + pair[1]
}

/** @fit
 * return.value: 4 | 20
 * return.bound: 5 | 20
 */
function groupedValueAndBound(flag: boolean) {
  return flag
    ? {value: 4, bound: 5}
    : {value: 20, bound: 20}
}

/** @fit
 * return.value <= return.bound
 */
export function oneGroupedHelperCallKeepsItsResultTogether(flag: boolean) {
  return groupedValueAndBound(flag)
}

function switchLayout(kind: 'compact' | 'wide') {
  switch (kind) {
    case 'compact':
      return {columns: 2, gap: 16}
    case 'wide':
      return {columns: 3, gap: 24}
  }
}

/** @fit
 * return: 18 | 27
 */
export function switchKeepsOneResultTogether(kind: 'compact' | 'wide') {
  const layout = switchLayout(kind)
  return layout.columns + layout.gap
}

/** @fit
 * given availableWidth: int 320..1200
 * return: 152..<390
 */
export function guardedColumnWidthKeepsInputRange(availableWidth: number) {
  const columns = availableWidth >= 600 ? 3 : 2
  const gap = 16
  return (availableWidth - gap * (columns - 1)) / columns
}

/** @fit
 * given value: int -10..10
 * return: 0..10
 */
export function guardedDivisorAlternativesExcludeZero(value: number) {
  const divisor = value >= 0 ? 1 : -1
  return value / divisor
}

/** @fit
 * given width: int 320..1200
 * return: 600..1200
 */
export function numericAlternativeRefinesOriginalGuard(width: number) {
  const columns = width >= 600 ? 3 : 2
  if (columns === 3) return width
  return 600
}

/** @fit
 * given width: int 320..1200
 * return: 320..<600
 */
export function numericAlternativeRefinesNegatedEquality(width: number) {
  const columns = width >= 600 ? 3 : 2
  if (columns !== 3) return width
  return 320
}

/** @fit
 * given n: int 0..10
 * return: 1
 */
export function correlatedNumericAlternativesDecideComparison(n: number) {
  const left = n > 4 ? 1 : 2
  const right = n > 4 ? 10 : 20
  return left < right ? 1 : 0
}

/** @fit
 * given n: int 0..10
 * return: 11 | 13
 */
export function compoundAdditionPreservesNumericAlternatives(n: number) {
  const increment = n > 4 ? 1 : 3
  let total = 10
  total += increment
  return total
}

/** @fit
 * return: -199 | -100 | -9 | 90
 */
export function independentNumericGuardsKeepEveryCombination(a: number, b: number) {
  const left = a > 0 ? 1 : 100
  const right = b > 0 ? 10 : 200
  return left - right
}

/** @fit return: 1 | 100 */
function guardedLeft(value: number) {
  return value > 0 ? 1 : 100
}

/** @fit return: 10 | 200 */
function guardedRight(value: number) {
  return value > 0 ? 10 : 200
}

/** @fit
 * return: -199 | -100 | -9 | 90
 */
export function helperCallsKeepIndependentArgumentsIndependent(a: number, b: number) {
  return guardedLeft(a) - guardedRight(b)
}

/** @fit
 * given items.length: 2
 * return: 2 | 4
 */
export function repeatedCollectionSlotKeepsItsOwnChoice(items: {flag: boolean}[]) {
  const values = items.map(item => item.flag ? 1 : 2)
  return values[0]! + values[0]!
}

/** @fit
 * return: 1
 */
export function booleanGuardComparisonPassesWhenEveryPairPasses(flag: boolean) {
  const left = flag ? 1 : 2
  const right = flag ? 10 : 20
  return left < right ? 1 : 0
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
 * given item.height: 0..40
 * given item.y: 0..1000
 * return.bottom >= item.y
 * return.height: 0..40
 */
export function objectFieldDomain(item: {y: number; height: number}) {
  return {height: item.height, bottom: item.y + item.height}
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
 * return == 16
 */
export function compoundAssignmentsComputeExactly() {
  let value = 10
  value -= 2
  value *= 2
  return value
}

/** @fit
 * given a: int -1000..1000
 * given b: int -1000..1000
 * given a + 2 * b >= 0
 * given a - 2 * b >= 0
 * a + b >= 0
 * return >= 0
 */
export function linearCombinationNeedsFractionalMultipliers(a: number, b: number) {
  return a + b
}

/** @fit
 * given x1 >= 0
 * given x2 >= 0
 * given x3 >= 0
 * given x4 >= 0
 * given x5 >= 0
 * given x6 >= 0
 * given x7 >= 0
 * given x8 >= 0
 * x1 + x2 + x3 + x4 + x5 + x6 + x7 + x8 >= 0
 * return >= 0
 */
export function longNonnegativeSumHasNoDepthCliff(x1: number, x2: number, x3: number, x4: number, x5: number, x6: number, x7: number, x8: number) {
  return x1 + x2 + x3 + x4 + x5 + x6 + x7 + x8
}

function sumPair(x: number, right: number) {
  let total = x
  total += right
  return total
}

/** @fit
 * given width: 0..100
 * return: 0..300
 */
export function helperLocalMutationKeepsCallerFacts(width: number) {
  const padded = sumPair(width, 100)
  return padded + width
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

/** @fit
 * k > b
 */
type TypeRelationSpring = {
  k: number
  b: number
}

/** @fit
 * high >= low
 */
type TypeRelationBounds = {
  low: number
  high: number
}

/** @fit
 * rows[].bottom >= rows[].y
 * rows[].cells[].right >= rows[].cells[].x
 */
type TypeRelationRows = {
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

export function typeRelationArrayPathReturnCheck(): TypeRelationRows {
  return {rows: [{y: 0, bottom: 10, cells: [{x: 1, right: 4}]}]}
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

export function inlineComparisonFacts(
  value: number, // @fit int 0..100
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
  value: number, // @fit int 0..100
  min: number, // @fit <= value
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
 * return.rows.length == items.length
 * return.rows[$i].height == items[$i].height
 */
export function sameIndexRowsKeepItemHeight(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
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
    rows.push({y: y, height: item.height})
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
 * given input[0].height: 0..100
 * given input[1].height: 0..100
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
  return [10, 20, 30][index]!
}

/** @fit
 * given index: 0 | 2
 * return: 10 | 30
 */
export function arrayLiteralFiniteIndexCases(index: 0 | 2) {
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
  let y = 0
  for (const item of items) {
    rows.push({y, height: item.height})
    y += item.height
  }
  return {
    previousTop: rows[focused - 1]!.y,
    currentTop: rows[focused]!.y,
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
  const width = dimensions?.width ?? 0
  return Math.max(Number.isFinite(width) ? width : 0, 0) // @fit >= 0
}

export function nullableObjectOptionalChainFallbackFeedsMath(dimensions: {width: number} | null) {
  const width = dimensions?.width ?? 0
  return Math.max(Number.isFinite(width) ? width : 0, 0) // @fit >= 0
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
    public y: number,
    public height: number,
    public width: number,
  ) {}

  /** @fit
   * given this.y: 0..1000
   * given this.height: 0..1000
   * return == this.y + this.height
   * return: 0..2000
   */
  get bottom() {
    return this.y + this.height
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

// Finiteness without magnitude: a strict bound against ±Infinity is the
// userland spelling for "any finite double". The computation below can
// overflow to ±Infinity (velocity / 0.998 exceeds MAX_VALUE) but never
// reaches NaN, so the value still equals itself.

/** @fit
 * given pos > -Infinity
 * given pos < Infinity
 * given velocity > -Infinity
 * given velocity < Infinity
 * return == pos + velocity / 0.998
 */
export function decayedRestingPoint(pos: number, velocity: number) {
  return pos + velocity / 0.998
}

/** @fit
 * given size: -Infinity<..<Infinity
 * given scale: -Infinity<..<Infinity
 * return == size * scale
 */
export function scaledExtentEcho(size: number, scale: number) {
  return size * scale
}

/** @fit
 * given x: -Infinity<..<Infinity
 * return == 0
 */
export function selfDifferenceOfFiniteInput(x: number) {
  return x - x
}

// `a<..b` reads as the comparison chain it means: a < x <= b. The exclusive
// int lower steps one whole number inward.

/** @fit
 * given fraction: 0<..1
 * return > 0
 */
export function strictlyPositiveFraction(fraction: number) {
  return fraction
}

/** @fit
 * given count: int 0<..10
 * return >= 1
 */
export function countedAtLeastOnce(count: number) {
  return count
}

// A union admits any one case, so its envelope holds as a fact: strict at an
// extremum only when every case there excludes it.

/** @fit
 * given width: 0..<5 | 10..<20
 * return < 20
 * return >= 0
 */
export function unionEnvelopeKeepsStrictUpper(width: number) {
  return width
}

/** @fit
 * given speed: 0<..5 | 10..20
 * return > 0
 */
export function unionEnvelopeKeepsStrictLower(speed: number) {
  return speed
}

// An int range excluding Infinity ends at MAX_VALUE (itself integral), so the
// product hull keeps its sign instead of widening over 0 * Infinity.
/** @fit
 * given count: int 1..<Infinity
 * given size: 0..<Infinity
 * return >= 0
 */
export function totalExtentOfCountedItems(count: number, size: number) {
  return count * size
}

/** @fit
 * pure
 * return: 0..100
 */
export function pureClampToHundred(x: number): number {
  // builds a local array and uses Math: no observable effect, deterministic.
  const limits = [0, 100] as const
  return Math.min(Math.max(x, limits[0]!), limits[1]!)
}

/** @fit
 * given rect.x: int -1000..1000
 * given rect.right: int -1000..1000
 * given rect.y: int -1000..1000
 * given rect.bottom: int -1000..1000
 * return.x: -1000..1000
 * return.y: -1000..1000
 */
export default (rect: {x: number; right: number; y: number; bottom: number}) => ({
  x: rect.x + (rect.right - rect.x) / 2,
  y: rect.y + (rect.bottom - rect.y) / 2,
})
