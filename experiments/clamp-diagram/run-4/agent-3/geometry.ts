export type TrustedTextBox = {
  width: number
  height: number
}

export type TrustedTextLayoutInput = {
  title: TrustedTextBox
  formulaChain: TrustedTextBox
  orderedColumnTitle: TrustedTextBox
  invertedColumnTitle: TrustedTextBox
  orderedAssumptionNote: TrustedTextBox
  invertedAssumptionNote: TrustedTextBox
  orderedLeftRegionLabel: TrustedTextBox
  orderedMiddleRegionLabel: TrustedTextBox
  orderedRightRegionLabel: TrustedTextBox
  orderedLeftFormulaCard: TrustedTextBox
  orderedMiddleFormulaCard: TrustedTextBox
  orderedRightFormulaCard: TrustedTextBox
  invertedEmptyIntervalLabel: TrustedTextBox
  invertedFinalLineLabel: TrustedTextBox
  invertedGuideLabel: TrustedTextBox
  invertedFormulaCard: TrustedTextBox
  tickY: TrustedTextBox
  tickU: TrustedTextBox
  tickZ: TrustedTextBox
  axisC: TrustedTextBox
  keyPoint: TrustedTextBox
}

const SVG_WIDTH = 1200
const SVG_HEIGHT = 780
const COLUMN_WIDTH = 544
const COLUMN_TOP = 160
const LEFT_COLUMN_X = 40
const RIGHT_COLUMN_X = 616
const PLOT_Y = 260
const PLOT_WIDTH = 448
const PLOT_HEIGHT = 270
const PLOT_BOTTOM = 530
const ORDERED_PLOT_X = 88
const INVERTED_PLOT_X = 664
const ORDERED_PLOT_RIGHT = 536
const INVERTED_PLOT_RIGHT = 1112
const ORDERED_Y_X = 220
const ORDERED_U_X = 404
const ORDERED_LOWER_C_Y = 450
const ORDERED_UPPER_C_Y = 336
const INVERTED_U_X = 816
const INVERTED_Y_X = 960
const INVERTED_FINAL_C_Y = 342
const INVERTED_GUIDE_START_Y = 492
const INVERTED_GUIDE_U_Y = 440
const AXIS_Y = 492
const COLUMN_TITLE_Y = 166
const COLUMN_NOTE_Y = 206
const LABEL_PAD_X = 8
const LABEL_PAD_Y = 5
const CARD_PAD_X = 10
const CARD_PAD_Y = 8
const TICK_PAD_X = 4
const TICK_PAD_Y = 2

type Box = {
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

/** @fit
 * return.x == x
 * return.y == y
 * return.width == width
 * return.height == height
 * return.right == x + width
 * return.bottom == y + height
 */
function box(x: number, y: number, width: number, height: number): Box {
  return {
    x,
    y,
    width,
    height,
    right: x + width,
    bottom: y + height,
  }
}

/** @fit
 * return.x1 == x1
 * return.y1 == y1
 * return.x2 == x2
 * return.y2 == y2
 */
function segment(x1: number, y1: number, x2: number, y2: number) {
  return {x1, y1, x2, y2}
}

/** @fit
 * given formulaTop: 588..588
 * given text.orderedMiddleRegionLabel.width: 0..220
 * given text.orderedMiddleRegionLabel.height: 0..46
 * return.width == text.orderedMiddleRegionLabel.width + 16
 * return.height == text.orderedMiddleRegionLabel.height + 10
 * return.width: 16..236
 * return.height: 10..56
 * return.slot: 0 | 1
 * return.x >= ORDERED_PLOT_X
 * return.right <= ORDERED_PLOT_RIGHT
 * return.y >= PLOT_Y
 * return.bottom <= formulaTop
 */
function placeOrderedMiddleRegionLabel(text: TrustedTextLayoutInput, formulaTop: number) {
  const width = text.orderedMiddleRegionLabel.width + LABEL_PAD_X * 2
  const height = text.orderedMiddleRegionLabel.height + LABEL_PAD_Y * 2
  const middleBandWidth = ORDERED_U_X - ORDERED_Y_X
  const preferredSlotWidth = middleBandWidth - 12

  if (width <= preferredSlotWidth) {
    const x = ORDERED_Y_X + (middleBandWidth - width) / 2 // @fit >= ORDERED_Y_X
    const y = PLOT_Y + 124
    const right = x + width // @fit <= ORDERED_U_X
    const bottom = y + height // @fit <= PLOT_BOTTOM
    return {x, y, width, height, right, bottom, slot: 0}
  }

  const x = ORDERED_PLOT_X + (PLOT_WIDTH - width) / 2 // @fit >= ORDERED_PLOT_X
  const y = formulaTop - height - 2 // @fit >= PLOT_BOTTOM
  const right = x + width // @fit <= ORDERED_PLOT_RIGHT
  const bottom = y + height // @fit <= formulaTop
  return {x, y, width, height, right, bottom, slot: 1}
}

/** @fit
 * given text.title.width: 0..640
 * given text.title.height: 0..42
 * given text.formulaChain.width: 0..920
 * given text.formulaChain.height: 0..60
 * given text.orderedColumnTitle.width: 0..240
 * given text.orderedColumnTitle.height: 0..28
 * given text.invertedColumnTitle.width: 0..240
 * given text.invertedColumnTitle.height: 0..28
 * given text.orderedAssumptionNote.width: 0..500
 * given text.orderedAssumptionNote.height: 0..42
 * given text.invertedAssumptionNote.width: 0..500
 * given text.invertedAssumptionNote.height: 0..42
 * given text.orderedLeftRegionLabel.width: 0..100
 * given text.orderedLeftRegionLabel.height: 0..24
 * given text.orderedMiddleRegionLabel.width: 0..220
 * given text.orderedMiddleRegionLabel.height: 0..46
 * given text.orderedRightRegionLabel.width: 0..100
 * given text.orderedRightRegionLabel.height: 0..24
 * given text.orderedLeftFormulaCard.width: 0..144
 * given text.orderedLeftFormulaCard.height: 0..46
 * given text.orderedMiddleFormulaCard.width: 0..144
 * given text.orderedMiddleFormulaCard.height: 0..46
 * given text.orderedRightFormulaCard.width: 0..144
 * given text.orderedRightFormulaCard.height: 0..46
 * given text.invertedEmptyIntervalLabel.width: 0..240
 * given text.invertedEmptyIntervalLabel.height: 0..42
 * given text.invertedFinalLineLabel.width: 0..270
 * given text.invertedFinalLineLabel.height: 0..32
 * given text.invertedGuideLabel.width: 0..180
 * given text.invertedGuideLabel.height: 0..32
 * given text.invertedFormulaCard.width: 0..280
 * given text.invertedFormulaCard.height: 0..46
 * given text.tickY.width: 0..36
 * given text.tickY.height: 0..18
 * given text.tickU.width: 0..36
 * given text.tickU.height: 0..18
 * given text.tickZ.width: 0..36
 * given text.tickZ.height: 0..18
 * given text.axisC.width: 0..36
 * given text.axisC.height: 0..18
 * given text.keyPoint.width: 0..1080
 * given text.keyPoint.height: 0..54
 * return.svg.width == 1200
 * return.svg.height == 780
 * return.columns.left.width == return.columns.right.width
 * return.columns.left.x + return.columns.left.width <= return.columns.right.x
 * return.columns.right.right <= return.svg.width
 * return.columns.left.bottom == return.ordered.formulaRegion.bottom + 18
 * return.columns.right.bottom == return.inverted.formulaRegion.bottom + 18
 * return.columns.left.bottom <= return.keyPoint.y
 * return.columns.right.bottom <= return.keyPoint.y
 * return.keyPoint.width == text.keyPoint.width + 40
 * return.keyPoint.height == text.keyPoint.height + 16
 * return.keyPoint.x >= 0
 * return.keyPoint.right <= return.svg.width
 * return.keyPoint.bottom <= return.svg.height
 * return.title.width == text.title.width + 40
 * return.title.height == text.title.height + 16
 * return.title.x >= 0
 * return.title.right <= return.svg.width
 * return.title.bottom <= return.formulaChain.y
 * return.formulaChain.width == text.formulaChain.width + 32
 * return.formulaChain.height == text.formulaChain.height + 8
 * return.formulaChain.x >= 0
 * return.formulaChain.right <= return.svg.width
 * return.formulaChain.bottom <= return.columns.left.y
 * return.ordered.columnTitle.width == text.orderedColumnTitle.width + 16
 * return.ordered.columnTitle.height == text.orderedColumnTitle.height + 8
 * return.inverted.columnTitle.width == text.invertedColumnTitle.width + 16
 * return.inverted.columnTitle.height == text.invertedColumnTitle.height + 8
 * return.ordered.columnTitle.x >= return.columns.left.x
 * return.ordered.columnTitle.right <= return.columns.left.right
 * return.inverted.columnTitle.x >= return.columns.right.x
 * return.inverted.columnTitle.right <= return.columns.right.right
 * return.ordered.columnTitle.y >= return.columns.left.y
 * return.inverted.columnTitle.y >= return.columns.right.y
 * return.ordered.columnTitle.bottom <= return.ordered.note.y
 * return.inverted.columnTitle.bottom <= return.inverted.note.y
 * return.ordered.note.width == text.orderedAssumptionNote.width + 16
 * return.inverted.note.width == text.invertedAssumptionNote.width + 16
 * return.ordered.note.right <= return.columns.left.right
 * return.inverted.note.right <= return.columns.right.right
 * return.ordered.note.bottom <= return.ordered.plot.y
 * return.inverted.note.bottom <= return.inverted.plot.y
 * return.ordered.plot.x >= return.columns.left.x
 * return.ordered.plot.right <= return.columns.left.right
 * return.ordered.plot.y >= return.columns.left.y
 * return.ordered.plot.bottom <= return.columns.left.bottom
 * return.inverted.plot.x >= return.columns.right.x
 * return.inverted.plot.right <= return.columns.right.right
 * return.inverted.plot.y >= return.columns.right.y
 * return.inverted.plot.bottom <= return.columns.right.bottom
 * return.ordered.thresholds.yX >= return.ordered.plot.x
 * return.ordered.thresholds.yX < return.ordered.thresholds.uX
 * return.ordered.thresholds.uX <= return.ordered.plot.right
 * return.ordered.thresholds.upperCY >= return.ordered.plot.y
 * return.ordered.thresholds.upperCY < return.ordered.thresholds.lowerCY
 * return.ordered.thresholds.lowerCY <= return.ordered.plot.bottom
 * return.ordered.regions.leftWidth >= 0
 * return.ordered.regions.middleWidth >= 0
 * return.ordered.regions.rightWidth >= 0
 * return.ordered.regions.leftWidth + return.ordered.regions.middleWidth + return.ordered.regions.rightWidth == return.ordered.plot.width
 * return.ordered.graph.axis.x1 == return.ordered.plot.x
 * return.ordered.graph.axis.x2 == return.ordered.plot.right
 * return.ordered.graph.axis.y1 == return.ordered.graph.axis.y2
 * return.ordered.graph.axis.y1 >= return.ordered.plot.y
 * return.ordered.graph.axis.y1 <= return.ordered.plot.bottom
 * return.ordered.graph.lower.x1 == return.ordered.plot.x
 * return.ordered.graph.lower.x2 == return.ordered.thresholds.yX
 * return.ordered.graph.lower.y1 == return.ordered.graph.lower.y2
 * return.ordered.graph.lower.y1 >= return.ordered.plot.y
 * return.ordered.graph.lower.y1 <= return.ordered.plot.bottom
 * return.ordered.graph.diagonal.x1 == return.ordered.graph.lower.x2
 * return.ordered.graph.diagonal.y1 == return.ordered.graph.lower.y2
 * return.ordered.graph.diagonal.x2 == return.ordered.graph.upper.x1
 * return.ordered.graph.diagonal.y2 == return.ordered.graph.upper.y1
 * return.ordered.graph.upper.x1 == return.ordered.thresholds.uX
 * return.ordered.graph.upper.x2 == return.ordered.plot.right
 * return.ordered.graph.upper.y1 == return.ordered.graph.upper.y2
 * return.ordered.graph.upper.y1 >= return.ordered.plot.y
 * return.ordered.graph.upper.y1 <= return.ordered.plot.bottom
 * return.ordered.labels.leftRegion.width == text.orderedLeftRegionLabel.width + 16
 * return.ordered.labels.leftRegion.height == text.orderedLeftRegionLabel.height + 10
 * return.ordered.labels.middleRegion.width == text.orderedMiddleRegionLabel.width + 16
 * return.ordered.labels.middleRegion.height == text.orderedMiddleRegionLabel.height + 10
 * return.ordered.labels.rightRegion.width == text.orderedRightRegionLabel.width + 16
 * return.ordered.labels.rightRegion.height == text.orderedRightRegionLabel.height + 10
 * return.ordered.labels.leftRegion.x >= return.ordered.plot.x
 * return.ordered.labels.leftRegion.right <= return.ordered.thresholds.yX
 * return.ordered.labels.leftRegion.bottom <= return.ordered.ticks.y.y
 * return.ordered.labels.middleRegion.x >= return.ordered.plot.x
 * return.ordered.labels.middleRegion.right <= return.ordered.plot.right
 * return.ordered.labels.middleRegion.bottom <= return.ordered.formulaRegion.top
 * return.ordered.labels.rightRegion.x >= return.ordered.thresholds.uX
 * return.ordered.labels.rightRegion.right <= return.ordered.plot.right
 * return.ordered.ticks.y.width == text.tickY.width + 8
 * return.ordered.ticks.u.width == text.tickU.width + 8
 * return.ordered.ticks.z.width == text.tickZ.width + 8
 * return.ordered.ticks.y.x >= return.ordered.plot.x
 * return.ordered.ticks.u.right <= return.ordered.plot.right
 * return.ordered.ticks.z.x >= return.ordered.plot.right
 * return.ordered.ticks.z.right <= return.columns.left.right
 * return.ordered.ticks.y.right <= return.ordered.ticks.u.x
 * return.ordered.ticks.y.bottom <= return.ordered.plot.bottom
 * return.ordered.ticks.u.bottom <= return.ordered.plot.bottom
 * return.ordered.ticks.z.bottom <= return.ordered.plot.bottom
 * return.ordered.axisLabel.width == text.axisC.width + 8
 * return.ordered.axisLabel.x >= return.columns.left.x
 * return.ordered.axisLabel.right <= return.ordered.plot.x
 * return.ordered.axisLabel.bottom <= return.ordered.plot.bottom
 * return.ordered.formulaCards.left.width == text.orderedLeftFormulaCard.width + 20
 * return.ordered.formulaCards.middle.width == text.orderedMiddleFormulaCard.width + 20
 * return.ordered.formulaCards.right.width == text.orderedRightFormulaCard.width + 20
 * return.ordered.formulaRegion.top == return.ordered.plot.bottom + 58
 * return.ordered.formulaRegion.bottom == return.ordered.formulaRegion.top + 62
 * return.ordered.formulaCards.left.y == return.ordered.formulaRegion.top
 * return.ordered.formulaCards.middle.y == return.ordered.formulaRegion.top
 * return.ordered.formulaCards.right.y == return.ordered.formulaRegion.top
 * return.ordered.formulaCards.left.right <= return.ordered.formulaCards.middle.x
 * return.ordered.formulaCards.middle.right <= return.ordered.formulaCards.right.x
 * return.ordered.formulaCards.right.right <= return.columns.left.right
 * return.ordered.labels.middleRegion.bottom <= return.ordered.formulaCards.left.y
 * return.ordered.formulaCards.left.bottom <= return.ordered.formulaRegion.bottom
 * return.ordered.formulaCards.middle.bottom <= return.ordered.formulaRegion.bottom
 * return.ordered.formulaCards.right.bottom <= return.ordered.formulaRegion.bottom
 * return.inverted.thresholds.uX >= return.inverted.plot.x
 * return.inverted.thresholds.uX < return.inverted.thresholds.yX
 * return.inverted.thresholds.yX <= return.inverted.plot.right
 * return.inverted.regions.beforeUWidth >= 0
 * return.inverted.regions.betweenUAndYWidth >= 0
 * return.inverted.regions.afterYWidth >= 0
 * return.inverted.regions.emptyYToUWidth == 0
 * return.inverted.graph.axis.x1 == return.inverted.plot.x
 * return.inverted.graph.axis.x2 == return.inverted.plot.right
 * return.inverted.graph.axis.y1 == return.inverted.graph.axis.y2
 * return.inverted.graph.axis.y1 >= return.inverted.plot.y
 * return.inverted.graph.axis.y1 <= return.inverted.plot.bottom
 * return.inverted.graph.final.x1 == return.inverted.plot.x
 * return.inverted.graph.final.x2 == return.inverted.plot.right
 * return.inverted.graph.final.y1 == return.inverted.graph.final.y2
 * return.inverted.graph.final.y1 >= return.inverted.plot.y
 * return.inverted.graph.final.y1 <= return.inverted.graph.guideFlat.y1
 * return.inverted.graph.guideDiag.x2 == return.inverted.thresholds.uX
 * return.inverted.graph.guideDiag.y2 == return.inverted.graph.guideFlat.y1
 * return.inverted.graph.guideFlat.x1 == return.inverted.thresholds.uX
 * return.inverted.graph.guideFlat.x2 == return.inverted.plot.right
 * return.inverted.graph.guideFlat.y1 == return.inverted.graph.guideFlat.y2
 * return.inverted.graph.guideFlat.y1 <= return.inverted.plot.bottom
 * return.inverted.labels.emptyInterval.width == text.invertedEmptyIntervalLabel.width + 16
 * return.inverted.labels.finalLine.width == text.invertedFinalLineLabel.width + 16
 * return.inverted.labels.guide.width == text.invertedGuideLabel.width + 16
 * return.inverted.labels.emptyInterval.x >= return.inverted.plot.x
 * return.inverted.labels.emptyInterval.right <= return.inverted.plot.right
 * return.inverted.labels.emptyInterval.bottom <= return.inverted.labels.finalLine.y
 * return.inverted.labels.finalLine.right <= return.inverted.plot.right
 * return.inverted.labels.finalLine.bottom <= return.inverted.labels.guide.y
 * return.inverted.labels.guide.x >= return.inverted.plot.x
 * return.inverted.labels.guide.right <= return.inverted.plot.right
 * return.inverted.labels.guide.bottom <= return.inverted.plot.bottom
 * return.inverted.ticks.u.width == text.tickU.width + 8
 * return.inverted.ticks.y.width == text.tickY.width + 8
 * return.inverted.ticks.z.width == text.tickZ.width + 8
 * return.inverted.ticks.u.x >= return.inverted.plot.x
 * return.inverted.ticks.y.right <= return.inverted.plot.right
 * return.inverted.ticks.z.x >= return.inverted.plot.right
 * return.inverted.ticks.z.right <= return.columns.right.right
 * return.inverted.ticks.u.right <= return.inverted.ticks.y.x
 * return.inverted.ticks.u.bottom <= return.inverted.plot.bottom
 * return.inverted.ticks.y.bottom <= return.inverted.plot.bottom
 * return.inverted.ticks.z.bottom <= return.inverted.plot.bottom
 * return.inverted.axisLabel.width == text.axisC.width + 8
 * return.inverted.axisLabel.x >= return.columns.right.x
 * return.inverted.axisLabel.right <= return.inverted.plot.x
 * return.inverted.axisLabel.bottom <= return.inverted.plot.bottom
 * return.inverted.formulaCards.main.width == text.invertedFormulaCard.width + 20
 * return.inverted.formulaRegion.top == return.inverted.plot.bottom + 58
 * return.inverted.formulaRegion.bottom == return.inverted.formulaRegion.top + 62
 * return.inverted.formulaCards.main.y == return.inverted.formulaRegion.top
 * return.inverted.formulaCards.main.x >= return.columns.right.x
 * return.inverted.formulaCards.main.right <= return.columns.right.right
 * return.inverted.formulaCards.main.bottom <= return.inverted.formulaRegion.bottom
 */
export function buildGeometry(text: TrustedTextLayoutInput) {
  const titleWidth = text.title.width + 40
  const titleHeight = text.title.height + 16
  const title = box((SVG_WIDTH - titleWidth) / 2, 22, titleWidth, titleHeight)

  const chainWidth = text.formulaChain.width + 32
  const chainHeight = text.formulaChain.height + 8
  const formulaChain = box((SVG_WIDTH - chainWidth) / 2, 92, chainWidth, chainHeight)

  const orderedPlot = box(ORDERED_PLOT_X, PLOT_Y, PLOT_WIDTH, PLOT_HEIGHT)
  const invertedPlot = box(INVERTED_PLOT_X, PLOT_Y, PLOT_WIDTH, PLOT_HEIGHT)
  const fallbackMiddleLabelMaxHeight = 46 + LABEL_PAD_Y * 2
  const formulaShelfGap = 2
  const formulaRowHeight = 46 + CARD_PAD_Y * 2
  const formulaTop = orderedPlot.bottom + fallbackMiddleLabelMaxHeight + formulaShelfGap
  const formulaBottom = formulaTop + formulaRowHeight
  const columnBottom = formulaBottom + 18
  const columnHeight = columnBottom - COLUMN_TOP
  const leftColumn = box(LEFT_COLUMN_X, COLUMN_TOP, COLUMN_WIDTH, columnHeight)
  const rightColumn = box(RIGHT_COLUMN_X, COLUMN_TOP, COLUMN_WIDTH, columnHeight)
  const keyPointWidth = text.keyPoint.width + 40
  const keyPoint = box(
    (SVG_WIDTH - keyPointWidth) / 2,
    columnBottom + 18,
    keyPointWidth,
    text.keyPoint.height + 16,
  )

  const orderedColumnTitleWidth = text.orderedColumnTitle.width + LABEL_PAD_X * 2
  const orderedColumnTitle = box(
    LEFT_COLUMN_X + (COLUMN_WIDTH - orderedColumnTitleWidth) / 2,
    COLUMN_TITLE_Y,
    orderedColumnTitleWidth,
    text.orderedColumnTitle.height + TICK_PAD_Y * 4,
  )
  const invertedColumnTitleWidth = text.invertedColumnTitle.width + LABEL_PAD_X * 2
  const invertedColumnTitle = box(
    RIGHT_COLUMN_X + (COLUMN_WIDTH - invertedColumnTitleWidth) / 2,
    COLUMN_TITLE_Y,
    invertedColumnTitleWidth,
    text.invertedColumnTitle.height + TICK_PAD_Y * 4,
  )

  const orderedNote = box(
    LEFT_COLUMN_X + 16,
    COLUMN_NOTE_Y,
    text.orderedAssumptionNote.width + LABEL_PAD_X * 2,
    text.orderedAssumptionNote.height + LABEL_PAD_Y * 2,
  )
  const invertedNote = box(
    RIGHT_COLUMN_X + 16,
    COLUMN_NOTE_Y,
    text.invertedAssumptionNote.width + LABEL_PAD_X * 2,
    text.invertedAssumptionNote.height + LABEL_PAD_Y * 2,
  )

  const orderedLeftRegionLabel = box(
    ORDERED_PLOT_X + 8,
    ORDERED_LOWER_C_Y + 10,
    text.orderedLeftRegionLabel.width + LABEL_PAD_X * 2,
    text.orderedLeftRegionLabel.height + LABEL_PAD_Y * 2,
  )
  const orderedMiddleRegionLabel = placeOrderedMiddleRegionLabel(text, formulaTop)
  const orderedRightRegionLabel = box(
    ORDERED_U_X + 8,
    ORDERED_UPPER_C_Y - 50,
    text.orderedRightRegionLabel.width + LABEL_PAD_X * 2,
    text.orderedRightRegionLabel.height + LABEL_PAD_Y * 2,
  )
  const orderedYTick = box(
    ORDERED_Y_X - 22,
    AXIS_Y + 10,
    text.tickY.width + TICK_PAD_X * 2,
    text.tickY.height + TICK_PAD_Y * 2,
  )
  const orderedUTick = box(
    ORDERED_U_X - 22,
    AXIS_Y + 10,
    text.tickU.width + TICK_PAD_X * 2,
    text.tickU.height + TICK_PAD_Y * 2,
  )
  const orderedZTick = box(
    ORDERED_PLOT_RIGHT + 4,
    AXIS_Y + 10,
    text.tickZ.width + TICK_PAD_X * 2,
    text.tickZ.height + TICK_PAD_Y * 2,
  )
  const orderedAxisLabel = box(
    LEFT_COLUMN_X + 2,
    PLOT_Y + 4,
    text.axisC.width + TICK_PAD_X * 2,
    text.axisC.height + TICK_PAD_Y * 2,
  )

  const orderedLeftFormula = box(
    LEFT_COLUMN_X + 12,
    formulaTop,
    text.orderedLeftFormulaCard.width + CARD_PAD_X * 2,
    text.orderedLeftFormulaCard.height + CARD_PAD_Y * 2,
  )
  const orderedMiddleFormula = box(
    LEFT_COLUMN_X + 190,
    formulaTop,
    text.orderedMiddleFormulaCard.width + CARD_PAD_X * 2,
    text.orderedMiddleFormulaCard.height + CARD_PAD_Y * 2,
  )
  const orderedRightFormula = box(
    LEFT_COLUMN_X + 368,
    formulaTop,
    text.orderedRightFormulaCard.width + CARD_PAD_X * 2,
    text.orderedRightFormulaCard.height + CARD_PAD_Y * 2,
  )

  const invertedEmptyIntervalLabel = box(
    INVERTED_PLOT_X + 104,
    PLOT_Y + 18,
    text.invertedEmptyIntervalLabel.width + LABEL_PAD_X * 2,
    text.invertedEmptyIntervalLabel.height + LABEL_PAD_Y * 2,
  )
  const invertedFinalLineLabel = box(
    INVERTED_PLOT_X + 150,
    PLOT_Y + 74,
    text.invertedFinalLineLabel.width + LABEL_PAD_X * 2,
    text.invertedFinalLineLabel.height + LABEL_PAD_Y * 2,
  )
  const invertedGuideLabel = box(
    INVERTED_PLOT_X + 16,
    PLOT_Y + 196,
    text.invertedGuideLabel.width + LABEL_PAD_X * 2,
    text.invertedGuideLabel.height + LABEL_PAD_Y * 2,
  )
  const invertedUTick = box(
    INVERTED_U_X - 22,
    AXIS_Y + 10,
    text.tickU.width + TICK_PAD_X * 2,
    text.tickU.height + TICK_PAD_Y * 2,
  )
  const invertedYTick = box(
    INVERTED_Y_X - 22,
    AXIS_Y + 10,
    text.tickY.width + TICK_PAD_X * 2,
    text.tickY.height + TICK_PAD_Y * 2,
  )
  const invertedZTick = box(
    INVERTED_PLOT_RIGHT + 4,
    AXIS_Y + 10,
    text.tickZ.width + TICK_PAD_X * 2,
    text.tickZ.height + TICK_PAD_Y * 2,
  )
  const invertedAxisLabel = box(
    RIGHT_COLUMN_X + 2,
    PLOT_Y + 4,
    text.axisC.width + TICK_PAD_X * 2,
    text.axisC.height + TICK_PAD_Y * 2,
  )
  const invertedFormula = box(
    RIGHT_COLUMN_X + 122,
    formulaTop,
    text.invertedFormulaCard.width + CARD_PAD_X * 2,
    text.invertedFormulaCard.height + CARD_PAD_Y * 2,
  )

  return {
    svg: {width: SVG_WIDTH, height: SVG_HEIGHT},
    title,
    formulaChain,
    keyPoint,
    columns: {left: leftColumn, right: rightColumn},
    ordered: {
      columnTitle: orderedColumnTitle,
      note: orderedNote,
      plot: orderedPlot,
      formulaRegion: {top: formulaTop, bottom: formulaBottom},
      thresholds: {
        yX: ORDERED_Y_X,
        uX: ORDERED_U_X,
        lowerCY: ORDERED_LOWER_C_Y,
        upperCY: ORDERED_UPPER_C_Y,
        axisY: AXIS_Y,
      },
      regions: {
        leftWidth: ORDERED_Y_X - ORDERED_PLOT_X,
        middleWidth: ORDERED_U_X - ORDERED_Y_X,
        rightWidth: ORDERED_PLOT_RIGHT - ORDERED_U_X,
      },
      graph: {
        axis: segment(ORDERED_PLOT_X, AXIS_Y, ORDERED_PLOT_RIGHT, AXIS_Y),
        lower: segment(ORDERED_PLOT_X, ORDERED_LOWER_C_Y, ORDERED_Y_X, ORDERED_LOWER_C_Y),
        diagonal: segment(ORDERED_Y_X, ORDERED_LOWER_C_Y, ORDERED_U_X, ORDERED_UPPER_C_Y),
        upper: segment(ORDERED_U_X, ORDERED_UPPER_C_Y, ORDERED_PLOT_RIGHT, ORDERED_UPPER_C_Y),
      },
      labels: {
        leftRegion: orderedLeftRegionLabel,
        middleRegion: orderedMiddleRegionLabel,
        rightRegion: orderedRightRegionLabel,
      },
      ticks: {
        y: orderedYTick,
        u: orderedUTick,
        z: orderedZTick,
      },
      axisLabel: orderedAxisLabel,
      formulaCards: {
        left: orderedLeftFormula,
        middle: orderedMiddleFormula,
        right: orderedRightFormula,
      },
    },
    inverted: {
      columnTitle: invertedColumnTitle,
      note: invertedNote,
      plot: invertedPlot,
      formulaRegion: {top: formulaTop, bottom: formulaBottom},
      thresholds: {
        uX: INVERTED_U_X,
        yX: INVERTED_Y_X,
        finalCY: INVERTED_FINAL_C_Y,
        guideStartY: INVERTED_GUIDE_START_Y,
        guideUY: INVERTED_GUIDE_U_Y,
        axisY: AXIS_Y,
      },
      regions: {
        beforeUWidth: INVERTED_U_X - INVERTED_PLOT_X,
        betweenUAndYWidth: INVERTED_Y_X - INVERTED_U_X,
        afterYWidth: INVERTED_PLOT_RIGHT - INVERTED_Y_X,
        emptyYToUWidth: Math.max(0, INVERTED_U_X - INVERTED_Y_X),
      },
      graph: {
        axis: segment(INVERTED_PLOT_X, AXIS_Y, INVERTED_PLOT_RIGHT, AXIS_Y),
        final: segment(INVERTED_PLOT_X, INVERTED_FINAL_C_Y, INVERTED_PLOT_RIGHT, INVERTED_FINAL_C_Y),
        guideDiag: segment(INVERTED_PLOT_X, INVERTED_GUIDE_START_Y, INVERTED_U_X, INVERTED_GUIDE_U_Y),
        guideFlat: segment(INVERTED_U_X, INVERTED_GUIDE_U_Y, INVERTED_PLOT_RIGHT, INVERTED_GUIDE_U_Y),
      },
      labels: {
        emptyInterval: invertedEmptyIntervalLabel,
        finalLine: invertedFinalLineLabel,
        guide: invertedGuideLabel,
      },
      ticks: {
        u: invertedUTick,
        y: invertedYTick,
        z: invertedZTick,
      },
      axisLabel: invertedAxisLabel,
      formulaCards: {
        main: invertedFormula,
      },
    },
  }
}

/** @fit
 * return.title.width: 0..640
 * return.title.height: 0..42
 * return.formulaChain.width: 0..920
 * return.formulaChain.height: 0..60
 * return.orderedColumnTitle.width: 0..240
 * return.orderedColumnTitle.height: 0..28
 * return.invertedColumnTitle.width: 0..240
 * return.invertedColumnTitle.height: 0..28
 * return.orderedAssumptionNote.width: 0..500
 * return.orderedAssumptionNote.height: 0..42
 * return.invertedAssumptionNote.width: 0..500
 * return.invertedAssumptionNote.height: 0..42
 * return.orderedLeftRegionLabel.width: 0..100
 * return.orderedLeftRegionLabel.height: 0..24
 * return.orderedMiddleRegionLabel.width: 0..220
 * return.orderedMiddleRegionLabel.height: 0..46
 * return.orderedRightRegionLabel.width: 0..100
 * return.orderedRightRegionLabel.height: 0..24
 * return.orderedLeftFormulaCard.width: 0..144
 * return.orderedLeftFormulaCard.height: 0..46
 * return.orderedMiddleFormulaCard.width: 0..144
 * return.orderedMiddleFormulaCard.height: 0..46
 * return.orderedRightFormulaCard.width: 0..144
 * return.orderedRightFormulaCard.height: 0..46
 * return.invertedEmptyIntervalLabel.width: 0..240
 * return.invertedEmptyIntervalLabel.height: 0..42
 * return.invertedFinalLineLabel.width: 0..270
 * return.invertedFinalLineLabel.height: 0..32
 * return.invertedGuideLabel.width: 0..180
 * return.invertedGuideLabel.height: 0..32
 * return.invertedFormulaCard.width: 0..280
 * return.invertedFormulaCard.height: 0..46
 * return.tickY.width: 0..36
 * return.tickY.height: 0..18
 * return.tickU.width: 0..36
 * return.tickU.height: 0..18
 * return.tickZ.width: 0..36
 * return.tickZ.height: 0..18
 * return.axisC.width: 0..36
 * return.axisC.height: 0..18
 * return.keyPoint.width: 0..1080
 * return.keyPoint.height: 0..54
 */
export function exampleTrustedTextLayout(): TrustedTextLayoutInput {
  return {
    title: {width: 560, height: 34},
    formulaChain: {width: 760, height: 56},
    orderedColumnTitle: {width: 132, height: 24},
    invertedColumnTitle: {width: 136, height: 24},
    orderedAssumptionNote: {width: 480, height: 34},
    invertedAssumptionNote: {width: 480, height: 34},
    orderedLeftRegionLabel: {width: 58, height: 16},
    orderedMiddleRegionLabel: {width: 96, height: 16},
    orderedRightRegionLabel: {width: 58, height: 16},
    orderedLeftFormulaCard: {width: 120, height: 42},
    orderedMiddleFormulaCard: {width: 120, height: 42},
    orderedRightFormulaCard: {width: 144, height: 42},
    invertedEmptyIntervalLabel: {width: 226, height: 34},
    invertedFinalLineLabel: {width: 247, height: 28},
    invertedGuideLabel: {width: 180, height: 32},
    invertedFormulaCard: {width: 280, height: 42},
    tickY: {width: 10, height: 16},
    tickU: {width: 10, height: 16},
    tickZ: {width: 10, height: 16},
    axisC: {width: 10, height: 16},
    keyPoint: {width: 1080, height: 44},
  }
}

/** @fit
 * return.svg.width == 1200
 * return.svg.height == 780
 * return.columns.left.width == return.columns.right.width
 * return.columns.left.bottom <= return.keyPoint.y
 * return.keyPoint.bottom <= return.svg.height
 * return.ordered.graph.diagonal.x1 == return.ordered.graph.lower.x2
 * return.ordered.graph.diagonal.x2 == return.ordered.graph.upper.x1
 * return.inverted.regions.emptyYToUWidth == 0
 */
export function buildExampleGeometry() {
  return buildGeometry(exampleTrustedTextLayout())
}

const textContent = {
  title: ['Min/max reduction as a clamp graph'],
  formulaChain: [
    'E = x + min(-y, y + max(x, -z - y))',
    '= x - max(y, min(-x - y, z))',
    '= x - clamp(y, z, -x - y) when y <= -x - y',
  ],
  orderedColumnTitle: ['Ordered bounds'],
  invertedColumnTitle: ['Inverted bounds'],
  orderedNote: [
    'Assume y <= u, equivalently x + 2y <= 0.',
    'The lower, pass-through, and upper regimes all exist.',
  ],
  invertedNote: [
    'Assume y > u, equivalently x + 2y > 0.',
    'The clamp interval reverses, so max forces C(z) = y.',
  ],
  orderedLeftRegion: ['z < y'],
  orderedMiddleRegion: ['y <= z <= u'],
  orderedRightRegion: ['z > u'],
  orderedLeftFormula: ['z < y', 'C = y', 'E = x - y'],
  orderedMiddleFormula: ['y <= z <= u', 'C = z', 'E = x - z'],
  orderedRightFormula: ['z > u', 'C = u', 'E = x - u', '= 2x + y'],
  invertedEmpty: ['empty interval:', 'no z satisfies y <= z <= u'],
  invertedFinal: ['C(z) = y, so', 'E = x - y for all z'],
  invertedGuide: ['dashed guide:', 'min(z, u) stays below y'],
  invertedFormula: ['u < y makes the middle band empty', 'C(z) = max(y, min(z, u)) = y', 'E = x - y'],
  tickY: ['y'],
  tickU: ['u'],
  tickZ: ['z'],
  axisC: ['C'],
  keyPoint: [
    'Key point: the final clamp notation is valid under y <= -x - y.',
    'When the bounds invert, the original max/min expression collapses to the y branch instead.',
  ],
}

function esc(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function rectAttrs(rect: Box) {
  return `x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"`
}

function lineAttrs(line: {x1: number; y1: number; x2: number; y2: number}) {
  return `x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}"`
}

function textCell(
  id: string,
  rect: Box,
  lines: string[],
  textClass: string,
  options: {anchor?: 'start' | 'middle'; rectClass?: string; rx?: number; visibleBox?: boolean} = {},
) {
  const anchor = options.anchor ?? 'start'
  const textX = anchor === 'middle' ? rect.x + rect.width / 2 : rect.x + 8
  const lineStep = rect.height / (lines.length + 1)
  const tspans = lines
    .map((line, index) => `<tspan x="${textX}" y="${rect.y + lineStep * (index + 1)}">${esc(line)}</tspan>`)
    .join('')
  const boxMarkup = options.visibleBox === false
    ? ''
    : `<rect class="${options.rectClass ?? 'label-box'}" ${rectAttrs(rect)} rx="${options.rx ?? 5}"/>`

  return `${boxMarkup}
    <clipPath id="${id}-clip"><rect ${rectAttrs(rect)}/></clipPath>
    <text class="${textClass}" text-anchor="${anchor}" dominant-baseline="middle" clip-path="url(#${id}-clip)">${tspans}</text>`
}

export function renderDiagramSvg() {
  const g = buildExampleGeometry()
  const orderedPlot = g.ordered.plot
  const invertedPlot = g.inverted.plot

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${g.svg.width}" height="${g.svg.height}" viewBox="0 0 ${g.svg.width} ${g.svg.height}" role="img" aria-labelledby="svg-title svg-desc" data-text-layout-source="trusted-example-boxes">
  <title id="svg-title">Geometric reduction of a min/max expression into a clamp-shaped graph</title>
  <desc id="svg-desc">Two equal-width columns compare ordered bounds y less than or equal to u with inverted bounds y greater than u. Text is clipped to externally supplied reserved text boxes; geometry is generated from checked layout data.</desc>
  <defs>
    <marker id="arrow-dark" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#253040"/>
    </marker>
    <marker id="arrow-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#b0454a"/>
    </marker>
    <style>
      .bg { fill: #fbfcfe; }
      .panel { fill: #f4f6f9; stroke: #c9d1dc; stroke-width: 1.2; }
      .plot { fill: #ffffff; stroke: #9aa8b8; stroke-width: 1.2; }
      .shade-left { fill: #eaf3ff; }
      .shade-mid { fill: #edf8ee; }
      .shade-right { fill: #fff3dd; }
      .shade-muted { fill: #f3eefb; }
      .axis { stroke: #253040; stroke-width: 1.4; marker-end: url(#arrow-dark); }
      .axis-light { stroke: #253040; stroke-width: 1.2; marker-end: url(#arrow-dark); }
      .grid { stroke: #d9e0e9; stroke-width: 1; }
      .guide { stroke: #8a94a6; stroke-width: 1.2; stroke-dasharray: 6 5; }
      .guide-curve { stroke: #7757c8; stroke-width: 3.2; stroke-dasharray: 9 7; fill: none; }
      .clamp { stroke: #13805d; stroke-width: 5; fill: none; stroke-linecap: round; stroke-linejoin: round; }
      .point { fill: #13805d; stroke: #ffffff; stroke-width: 2; }
      .label-box { fill: #ffffff; stroke: #bdc7d4; stroke-width: 1; }
      .formula-card { fill: #fffaf0; stroke: #d6b46c; stroke-width: 1.1; }
      .empty-box { fill: #fff5f6; stroke: #d9969a; stroke-width: 1.1; }
      .key-point-box { fill: #f2fbf6; stroke: #8ac6a4; stroke-width: 1.1; }
      .title { font: 700 28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #182230; }
      .subtitle { font: 500 15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #2d3a4b; }
      .chain { font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #344156; }
      .col-title { font: 700 19px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #182230; }
      .note { font: 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #4a586d; }
      .axis-text { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #253040; }
      .small { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #324055; }
      .small-strong { font: 700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #243047; }
      .card-text { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #243047; }
      .key-point { font: 600 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #1f3d32; }
      .red { fill: #9f3d43; }
    </style>
  </defs>

  <rect class="bg" x="0" y="0" width="${g.svg.width}" height="${g.svg.height}"/>
  ${textCell('title', g.title, textContent.title, 'title', {anchor: 'middle', visibleBox: false})}
  ${textCell('formula-chain', g.formulaChain, textContent.formulaChain, 'chain', {anchor: 'middle', visibleBox: false})}

  <rect class="panel" ${rectAttrs(g.columns.left)} rx="8"/>
  <rect class="panel" ${rectAttrs(g.columns.right)} rx="8"/>
  ${textCell('ordered-column-title', g.ordered.columnTitle, textContent.orderedColumnTitle, 'col-title', {anchor: 'middle', visibleBox: false})}
  ${textCell('inverted-column-title', g.inverted.columnTitle, textContent.invertedColumnTitle, 'col-title', {anchor: 'middle', visibleBox: false})}
  ${textCell('ordered-note', g.ordered.note, textContent.orderedNote, 'note', {visibleBox: false})}
  ${textCell('inverted-note', g.inverted.note, textContent.invertedNote, 'note', {visibleBox: false})}

  <g id="ordered-plot">
    <rect class="plot" ${rectAttrs(orderedPlot)}/>
    <rect class="shade-left" x="${orderedPlot.x}" y="${orderedPlot.y}" width="${g.ordered.regions.leftWidth}" height="${orderedPlot.height}"/>
    <rect class="shade-mid" x="${g.ordered.thresholds.yX}" y="${orderedPlot.y}" width="${g.ordered.regions.middleWidth}" height="${orderedPlot.height}"/>
    <rect class="shade-right" x="${g.ordered.thresholds.uX}" y="${orderedPlot.y}" width="${g.ordered.regions.rightWidth}" height="${orderedPlot.height}"/>
    <line class="grid" x1="${orderedPlot.x}" y1="${g.ordered.thresholds.upperCY}" x2="${orderedPlot.right}" y2="${g.ordered.thresholds.upperCY}"/>
    <line class="grid" x1="${orderedPlot.x}" y1="${g.ordered.thresholds.lowerCY}" x2="${orderedPlot.right}" y2="${g.ordered.thresholds.lowerCY}"/>
    <line class="guide" x1="${g.ordered.thresholds.yX}" y1="${orderedPlot.y}" x2="${g.ordered.thresholds.yX}" y2="${g.ordered.thresholds.axisY}"/>
    <line class="guide" x1="${g.ordered.thresholds.uX}" y1="${orderedPlot.y}" x2="${g.ordered.thresholds.uX}" y2="${g.ordered.thresholds.axisY}"/>
    <line class="axis-light" x1="${orderedPlot.x}" y1="${orderedPlot.bottom}" x2="${orderedPlot.x}" y2="${orderedPlot.y}"/>
    <line class="axis" ${lineAttrs(g.ordered.graph.axis)}/>
    ${textCell('ordered-axis-c', g.ordered.axisLabel, textContent.axisC, 'axis-text', {anchor: 'middle', visibleBox: false})}
    ${textCell('ordered-tick-y', g.ordered.ticks.y, textContent.tickY, 'axis-text', {anchor: 'middle', visibleBox: false})}
    ${textCell('ordered-tick-u', g.ordered.ticks.u, textContent.tickU, 'axis-text', {anchor: 'middle', visibleBox: false})}
    ${textCell('ordered-tick-z', g.ordered.ticks.z, textContent.tickZ, 'axis-text', {anchor: 'middle', visibleBox: false})}
    <path class="clamp" d="M ${g.ordered.graph.lower.x1} ${g.ordered.graph.lower.y1} L ${g.ordered.graph.lower.x2} ${g.ordered.graph.lower.y2} L ${g.ordered.graph.diagonal.x2} ${g.ordered.graph.diagonal.y2} L ${g.ordered.graph.upper.x2} ${g.ordered.graph.upper.y2}"/>
    <circle class="point" cx="${g.ordered.graph.lower.x2}" cy="${g.ordered.graph.lower.y2}" r="5"/>
    <circle class="point" cx="${g.ordered.graph.upper.x1}" cy="${g.ordered.graph.upper.y1}" r="5"/>
    ${textCell('ordered-left-region', g.ordered.labels.leftRegion, textContent.orderedLeftRegion, 'small-strong', {anchor: 'middle'})}
    ${textCell('ordered-middle-region', g.ordered.labels.middleRegion, textContent.orderedMiddleRegion, 'small-strong', {anchor: 'middle'})}
    ${textCell('ordered-right-region', g.ordered.labels.rightRegion, textContent.orderedRightRegion, 'small-strong', {anchor: 'middle'})}
  </g>

  <g id="ordered-cards">
    ${textCell('ordered-left-card', g.ordered.formulaCards.left, textContent.orderedLeftFormula, 'card-text', {rectClass: 'formula-card', rx: 7})}
    ${textCell('ordered-middle-card', g.ordered.formulaCards.middle, textContent.orderedMiddleFormula, 'card-text', {rectClass: 'formula-card', rx: 7})}
    ${textCell('ordered-right-card', g.ordered.formulaCards.right, textContent.orderedRightFormula, 'card-text', {rectClass: 'formula-card', rx: 7})}
  </g>

  <g id="inverted-plot">
    <rect class="plot" ${rectAttrs(invertedPlot)}/>
    <rect class="shade-muted" ${rectAttrs(invertedPlot)}/>
    <line class="grid" x1="${invertedPlot.x}" y1="${g.inverted.thresholds.finalCY}" x2="${invertedPlot.right}" y2="${g.inverted.thresholds.finalCY}"/>
    <line class="grid" x1="${invertedPlot.x}" y1="${g.inverted.thresholds.guideUY}" x2="${invertedPlot.right}" y2="${g.inverted.thresholds.guideUY}"/>
    <line class="guide" x1="${g.inverted.thresholds.uX}" y1="${invertedPlot.y}" x2="${g.inverted.thresholds.uX}" y2="${g.inverted.thresholds.axisY}"/>
    <line class="guide" x1="${g.inverted.thresholds.yX}" y1="${invertedPlot.y}" x2="${g.inverted.thresholds.yX}" y2="${g.inverted.thresholds.axisY}"/>
    <line class="axis-light" x1="${invertedPlot.x}" y1="${invertedPlot.bottom}" x2="${invertedPlot.x}" y2="${invertedPlot.y}"/>
    <line class="axis" ${lineAttrs(g.inverted.graph.axis)}/>
    ${textCell('inverted-axis-c', g.inverted.axisLabel, textContent.axisC, 'axis-text', {anchor: 'middle', visibleBox: false})}
    ${textCell('inverted-tick-u', g.inverted.ticks.u, textContent.tickU, 'axis-text', {anchor: 'middle', visibleBox: false})}
    ${textCell('inverted-tick-y', g.inverted.ticks.y, textContent.tickY, 'axis-text', {anchor: 'middle', visibleBox: false})}
    ${textCell('inverted-tick-z', g.inverted.ticks.z, textContent.tickZ, 'axis-text', {anchor: 'middle', visibleBox: false})}
    <path class="guide-curve" d="M ${g.inverted.graph.guideDiag.x1} ${g.inverted.graph.guideDiag.y1} L ${g.inverted.graph.guideDiag.x2} ${g.inverted.graph.guideDiag.y2} L ${g.inverted.graph.guideFlat.x2} ${g.inverted.graph.guideFlat.y2}"/>
    <path class="clamp" d="M ${g.inverted.graph.final.x1} ${g.inverted.graph.final.y1} L ${g.inverted.graph.final.x2} ${g.inverted.graph.final.y2}"/>
    <line x1="${g.inverted.thresholds.yX}" y1="310" x2="${g.inverted.thresholds.uX}" y2="310" stroke="#b0454a" stroke-width="2" marker-start="url(#arrow-red)" marker-end="url(#arrow-red)"/>
    ${textCell('inverted-empty', g.inverted.labels.emptyInterval, textContent.invertedEmpty, 'small', {rectClass: 'empty-box', rx: 7})}
    ${textCell('inverted-final', g.inverted.labels.finalLine, textContent.invertedFinal, 'small-strong', {rx: 7})}
    ${textCell('inverted-guide', g.inverted.labels.guide, textContent.invertedGuide, 'small', {rx: 7})}
  </g>

  <g id="inverted-card">
    ${textCell('inverted-card-main', g.inverted.formulaCards.main, textContent.invertedFormula, 'card-text', {rectClass: 'formula-card', rx: 7})}
  </g>
  ${textCell('key-point', g.keyPoint, textContent.keyPoint, 'key-point', {rectClass: 'key-point-box', rx: 8})}
</svg>
`
}

if (import.meta.main) {
  await Bun.write(new URL('./diagram.svg', import.meta.url), renderDiagramSvg())
}
