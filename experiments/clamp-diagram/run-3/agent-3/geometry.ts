import {writeFileSync} from 'node:fs'

type Rect = {
  x: number
  y: number
  width: number
  height: number
}

type Segment = {
  x1: number
  y1: number
  x2: number
  y2: number
}

type TextMetric = {
  width: number
  height: number
}

export type TextMetricsInput = {
  topTitle: TextMetric
  topSubtitle: TextMetric
  topFormula: TextMetric
  orderedPanelTitle: TextMetric
  orderedPanelAssumption: TextMetric
  orderedPanelNote: TextMetric
  invertedPanelTitle: TextMetric
  invertedPanelAssumption: TextMetric
  invertedPanelNote: TextMetric
  orderedRegionLeft: TextMetric
  orderedRegionMiddle: TextMetric
  orderedRegionRight: TextMetric
  orderedFormulaLeft: TextMetric
  orderedFormulaMiddle: TextMetric
  orderedFormulaRight: TextMetric
  emptyInterval: TextMetric
  finalLineLabel: TextMetric
  guideLineLabel: TextMetric
  invertedFormula: TextMetric
  tickY: TextMetric
  tickU: TextMetric
}

type TextLine = {
  text: string
  className: string
  fontSize: number
  lineHeight: number
}

type TextBlock = {
  lines: TextLine[]
  paddingX: number
  paddingY: number
  align: 'left' | 'center'
}

const REGION_LABEL_PAD_X = 8
const REGION_LABEL_PAD_Y = 4
const FORMULA_CARD_PAD_X = 12
const FORMULA_CARD_PAD_Y = 12
const EMPTY_LABEL_PAD_X = 8
const EMPTY_LABEL_PAD_Y = 5
const LINE_LABEL_PAD_X = 4
const LINE_LABEL_PAD_Y = 2
const TICK_LABEL_PAD_X = 2
const TICK_LABEL_PAD_Y = 1

const TEXT_BLOCKS = {
  topTitle: {
    lines: [{text: 'Min/max reduction as a clamp-shaped graph', className: 'title', fontSize: 28, lineHeight: 34}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  topSubtitle: {
    lines: [{text: 'Let u = -x - y and C(z) = max(y, min(z, u)); then E = x - C(z).', className: 'subtitle', fontSize: 14, lineHeight: 18}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  topFormula: {
    lines: [
      {text: 'E = x + min(-y, y + max(x, -z - y))', className: 'formula', fontSize: 17, lineHeight: 24},
      {text: '  = x - max(y, min(-x - y, z))', className: 'formula', fontSize: 17, lineHeight: 24},
      {text: '  = x - clamp(y, z, -x - y) only when y <= -x - y', className: 'formula', fontSize: 17, lineHeight: 24},
    ],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  orderedPanelTitle: {
    lines: [{text: 'Ordered bounds', className: 'panel-title', fontSize: 18, lineHeight: 22}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  orderedPanelAssumption: {
    lines: [{text: 'y <= u, equivalently x + 2y <= 0', className: 'panel-note', fontSize: 13, lineHeight: 18}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  orderedPanelNote: {
    lines: [{text: 'The middle pass-through exists, so C(z) is an honest clamp.', className: 'panel-note', fontSize: 13, lineHeight: 18}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  invertedPanelTitle: {
    lines: [{text: 'Inverted bounds', className: 'panel-title', fontSize: 18, lineHeight: 22}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  invertedPanelAssumption: {
    lines: [{text: 'y > u, equivalently x + 2y > 0', className: 'panel-note', fontSize: 13, lineHeight: 18}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  invertedPanelNote: {
    lines: [{text: 'The ordered clamp interval is empty; the shape degenerates.', className: 'panel-note', fontSize: 13, lineHeight: 18}],
    paddingX: 0,
    paddingY: 0,
    align: 'left',
  },
  orderedRegionLeft: {
    lines: [
      {text: 'z < y', className: 'region-label', fontSize: 12, lineHeight: 14},
      {text: 'C = y', className: 'region-sub', fontSize: 11, lineHeight: 14},
    ],
    paddingX: REGION_LABEL_PAD_X,
    paddingY: REGION_LABEL_PAD_Y,
    align: 'center',
  },
  orderedRegionMiddle: {
    lines: [
      {text: 'y <= z <= u', className: 'region-label', fontSize: 12, lineHeight: 14},
      {text: 'C = z', className: 'region-sub', fontSize: 11, lineHeight: 14},
    ],
    paddingX: REGION_LABEL_PAD_X,
    paddingY: REGION_LABEL_PAD_Y,
    align: 'center',
  },
  orderedRegionRight: {
    lines: [
      {text: 'z > u', className: 'region-label', fontSize: 12, lineHeight: 14},
      {text: 'C = u', className: 'region-sub', fontSize: 11, lineHeight: 14},
    ],
    paddingX: REGION_LABEL_PAD_X,
    paddingY: REGION_LABEL_PAD_Y,
    align: 'center',
  },
  orderedFormulaLeft: {
    lines: [
      {text: 'z < y', className: 'formula-head', fontSize: 12, lineHeight: 18},
      {text: 'C = y', className: 'formula-small', fontSize: 11.4, lineHeight: 18},
      {text: 'E = x - y', className: 'formula-small', fontSize: 11.4, lineHeight: 18},
    ],
    paddingX: FORMULA_CARD_PAD_X,
    paddingY: FORMULA_CARD_PAD_Y,
    align: 'left',
  },
  orderedFormulaMiddle: {
    lines: [
      {text: 'y <= z <= u', className: 'formula-head', fontSize: 12, lineHeight: 18},
      {text: 'C = z', className: 'formula-small', fontSize: 11.4, lineHeight: 18},
      {text: 'E = x - z', className: 'formula-small', fontSize: 11.4, lineHeight: 18},
    ],
    paddingX: FORMULA_CARD_PAD_X,
    paddingY: FORMULA_CARD_PAD_Y,
    align: 'left',
  },
  orderedFormulaRight: {
    lines: [
      {text: 'z > u', className: 'formula-head', fontSize: 12, lineHeight: 18},
      {text: 'C = u', className: 'formula-small', fontSize: 11.4, lineHeight: 18},
      {text: 'E = 2x + y', className: 'formula-small', fontSize: 11.4, lineHeight: 18},
    ],
    paddingX: FORMULA_CARD_PAD_X,
    paddingY: FORMULA_CARD_PAD_Y,
    align: 'left',
  },
  emptyInterval: {
    lines: [{text: 'empty: y <= z <= u', className: 'empty-text', fontSize: 12, lineHeight: 16}],
    paddingX: EMPTY_LABEL_PAD_X,
    paddingY: EMPTY_LABEL_PAD_Y,
    align: 'center',
  },
  finalLineLabel: {
    lines: [{text: 'C(z) = y', className: 'line-label', fontSize: 13, lineHeight: 17}],
    paddingX: LINE_LABEL_PAD_X,
    paddingY: LINE_LABEL_PAD_Y,
    align: 'left',
  },
  guideLineLabel: {
    lines: [{text: 'dashed guide: min(z,u) <= y', className: 'line-label', fontSize: 13, lineHeight: 17}],
    paddingX: LINE_LABEL_PAD_X,
    paddingY: LINE_LABEL_PAD_Y,
    align: 'left',
  },
  invertedFormula: {
    lines: [
      {text: 'u < y, so max(y, min(z,u)) = y', className: 'formula-head', fontSize: 12, lineHeight: 20},
      {text: 'E = x - y for all z', className: 'formula-small', fontSize: 11.4, lineHeight: 18},
    ],
    paddingX: FORMULA_CARD_PAD_X,
    paddingY: FORMULA_CARD_PAD_Y,
    align: 'left',
  },
  tickY: {
    lines: [{text: 'y', className: 'tick-label', fontSize: 13, lineHeight: 16}],
    paddingX: TICK_LABEL_PAD_X,
    paddingY: TICK_LABEL_PAD_Y,
    align: 'center',
  },
  tickU: {
    lines: [{text: 'u=-x-y', className: 'tick-label', fontSize: 13, lineHeight: 16}],
    paddingX: TICK_LABEL_PAD_X,
    paddingY: TICK_LABEL_PAD_Y,
    align: 'center',
  },
} satisfies Record<string, TextBlock>

function estimateMetric(lines: TextLine[]): TextMetric {
  const width = Math.max(...lines.map(line => line.text.length * line.fontSize * 0.62))
  const height = lines.reduce((sum, line) => sum + line.lineHeight, 0)
  return {width, height}
}

export const exampleMetrics: TextMetricsInput = {
  topTitle: estimateMetric(TEXT_BLOCKS.topTitle.lines),
  topSubtitle: estimateMetric(TEXT_BLOCKS.topSubtitle.lines),
  topFormula: estimateMetric(TEXT_BLOCKS.topFormula.lines),
  orderedPanelTitle: estimateMetric(TEXT_BLOCKS.orderedPanelTitle.lines),
  orderedPanelAssumption: estimateMetric(TEXT_BLOCKS.orderedPanelAssumption.lines),
  orderedPanelNote: estimateMetric(TEXT_BLOCKS.orderedPanelNote.lines),
  invertedPanelTitle: estimateMetric(TEXT_BLOCKS.invertedPanelTitle.lines),
  invertedPanelAssumption: estimateMetric(TEXT_BLOCKS.invertedPanelAssumption.lines),
  invertedPanelNote: estimateMetric(TEXT_BLOCKS.invertedPanelNote.lines),
  orderedRegionLeft: estimateMetric(TEXT_BLOCKS.orderedRegionLeft.lines),
  orderedRegionMiddle: estimateMetric(TEXT_BLOCKS.orderedRegionMiddle.lines),
  orderedRegionRight: estimateMetric(TEXT_BLOCKS.orderedRegionRight.lines),
  orderedFormulaLeft: estimateMetric(TEXT_BLOCKS.orderedFormulaLeft.lines),
  orderedFormulaMiddle: estimateMetric(TEXT_BLOCKS.orderedFormulaMiddle.lines),
  orderedFormulaRight: estimateMetric(TEXT_BLOCKS.orderedFormulaRight.lines),
  emptyInterval: estimateMetric(TEXT_BLOCKS.emptyInterval.lines),
  finalLineLabel: estimateMetric(TEXT_BLOCKS.finalLineLabel.lines),
  guideLineLabel: estimateMetric(TEXT_BLOCKS.guideLineLabel.lines),
  invertedFormula: estimateMetric(TEXT_BLOCKS.invertedFormula.lines),
  tickY: estimateMetric(TEXT_BLOCKS.tickY.lines),
  tickU: estimateMetric(TEXT_BLOCKS.tickU.lines),
}

/** @fit
 * given metrics.topTitle.width: 0..720
 * given metrics.topTitle.height: 0..44
 * given metrics.topSubtitle.width: 0..760
 * given metrics.topSubtitle.height: 0..24
 * given metrics.topFormula.width: 0..700
 * given metrics.topFormula.height: 0..80
 * given metrics.orderedPanelTitle.width: 0..220
 * given metrics.orderedPanelTitle.height: 0..28
 * given metrics.orderedPanelAssumption.width: 0..360
 * given metrics.orderedPanelAssumption.height: 0..24
 * given metrics.orderedPanelNote.width: 0..480
 * given metrics.orderedPanelNote.height: 0..24
 * given metrics.invertedPanelTitle.width: 0..220
 * given metrics.invertedPanelTitle.height: 0..28
 * given metrics.invertedPanelAssumption.width: 0..360
 * given metrics.invertedPanelAssumption.height: 0..24
 * given metrics.invertedPanelNote.width: 0..480
 * given metrics.invertedPanelNote.height: 0..24
 * given metrics.orderedRegionLeft.width: 0..90
 * given metrics.orderedRegionLeft.height: 0..32
 * given metrics.orderedRegionMiddle.width: 0..260
 * given metrics.orderedRegionMiddle.height: 0..32
 * given metrics.orderedRegionRight.width: 0..90
 * given metrics.orderedRegionRight.height: 0..32
 * given metrics.orderedFormulaLeft.width: 0..110
 * given metrics.orderedFormulaLeft.height: 0..60
 * given metrics.orderedFormulaMiddle.width: 0..110
 * given metrics.orderedFormulaMiddle.height: 0..60
 * given metrics.orderedFormulaRight.width: 0..110
 * given metrics.orderedFormulaRight.height: 0..60
 * given metrics.emptyInterval.width: 0..160
 * given metrics.emptyInterval.height: 0..20
 * given metrics.finalLineLabel.width: 0..90
 * given metrics.finalLineLabel.height: 0..20
 * given metrics.guideLineLabel.width: 0..240
 * given metrics.guideLineLabel.height: 0..20
 * given metrics.invertedFormula.width: 0..260
 * given metrics.invertedFormula.height: 0..44
 * given metrics.tickY.width: 0..20
 * given metrics.tickY.height: 0..18
 * given metrics.tickU.width: 0..70
 * given metrics.tickU.height: 0..18
 * return.viewBox.x == 0
 * return.viewBox.y == 0
 * return.columns.left.width == return.columns.right.width
 * return.columns.left.x >= return.viewBox.x
 * return.columns.left.y >= return.viewBox.y
 * return.columns.left.x + return.columns.left.width <= return.columns.right.x
 * return.columns.right.x + return.columns.right.width <= return.viewBox.x + return.viewBox.width
 * return.columns.right.y + return.columns.right.height <= return.viewBox.y + return.viewBox.height
 * return.top.title.width == metrics.topTitle.width
 * return.top.subtitle.width == metrics.topSubtitle.width
 * return.top.formula.width == metrics.topFormula.width
 * return.top.formula.y + return.top.formula.height <= return.columns.left.y
 * return.ordered.panelText.title.x + return.ordered.panelText.title.width <= return.columns.left.x + return.columns.left.width
 * return.ordered.panelText.assumption.x + return.ordered.panelText.assumption.width <= return.columns.left.x + return.columns.left.width
 * return.ordered.panelText.note.x + return.ordered.panelText.note.width <= return.columns.left.x + return.columns.left.width
 * return.inverted.panelText.title.x + return.inverted.panelText.title.width <= return.columns.right.x + return.columns.right.width
 * return.inverted.panelText.assumption.x + return.inverted.panelText.assumption.width <= return.columns.right.x + return.columns.right.width
 * return.inverted.panelText.note.x + return.inverted.panelText.note.width <= return.columns.right.x + return.columns.right.width
 * return.ordered.panelText.note.y + return.ordered.panelText.note.height <= return.ordered.plot.y
 * return.inverted.panelText.note.y + return.inverted.panelText.note.height <= return.inverted.plot.y
 * return.ordered.plot.x >= return.columns.left.x
 * return.ordered.plot.y >= return.columns.left.y
 * return.ordered.plot.x + return.ordered.plot.width <= return.columns.left.x + return.columns.left.width
 * return.ordered.plot.y + return.ordered.plot.height <= return.columns.left.y + return.columns.left.height
 * return.inverted.plot.x >= return.columns.right.x
 * return.inverted.plot.y >= return.columns.right.y
 * return.inverted.plot.x + return.inverted.plot.width <= return.columns.right.x + return.columns.right.width
 * return.inverted.plot.y + return.inverted.plot.height <= return.columns.right.y + return.columns.right.height
 * return.ordered.thresholdY.x < return.ordered.thresholdU.x
 * return.inverted.thresholdU.x < return.inverted.thresholdY.x
 * return.ordered.lower.x1 == return.ordered.plot.x
 * return.ordered.lower.x2 == return.ordered.thresholdY.x
 * return.ordered.lower.y1 == return.ordered.lower.y2
 * return.ordered.diagonal.x1 == return.ordered.thresholdY.x
 * return.ordered.diagonal.y1 == return.ordered.lower.y1
 * return.ordered.diagonal.x2 == return.ordered.thresholdU.x
 * return.ordered.diagonal.y2 == return.ordered.upper.y1
 * return.ordered.upper.x1 == return.ordered.thresholdU.x
 * return.ordered.upper.x2 == return.ordered.plot.x + return.ordered.plot.width
 * return.ordered.upper.y1 == return.ordered.upper.y2
 * return.ordered.lower.y1 >= return.ordered.plot.y
 * return.ordered.lower.y1 <= return.ordered.plot.y + return.ordered.plot.height
 * return.ordered.diagonal.x1 >= return.ordered.plot.x
 * return.ordered.diagonal.x2 <= return.ordered.plot.x + return.ordered.plot.width
 * return.ordered.diagonal.y1 >= return.ordered.plot.y
 * return.ordered.diagonal.y1 <= return.ordered.plot.y + return.ordered.plot.height
 * return.ordered.diagonal.y2 >= return.ordered.plot.y
 * return.ordered.diagonal.y2 <= return.ordered.plot.y + return.ordered.plot.height
 * return.ordered.upper.y1 >= return.ordered.plot.y
 * return.ordered.upper.y1 <= return.ordered.plot.y + return.ordered.plot.height
 * return.inverted.finalLine.x1 == return.inverted.plot.x
 * return.inverted.finalLine.x2 == return.inverted.plot.x + return.inverted.plot.width
 * return.inverted.finalLine.y1 == return.inverted.finalLine.y2
 * return.inverted.guideDiagonal.x2 == return.inverted.thresholdU.x
 * return.inverted.guidePlateau.x1 == return.inverted.thresholdU.x
 * return.inverted.guidePlateau.x2 == return.inverted.plot.x + return.inverted.plot.width
 * return.inverted.guidePlateau.y1 == return.inverted.guidePlateau.y2
 * return.inverted.guideDiagonal.y1 >= return.inverted.finalLine.y1
 * return.inverted.guideDiagonal.y2 >= return.inverted.finalLine.y1
 * return.inverted.guidePlateau.y1 >= return.inverted.finalLine.y1
 * return.inverted.finalLine.y1 >= return.inverted.plot.y
 * return.inverted.finalLine.y1 <= return.inverted.plot.y + return.inverted.plot.height
 * return.inverted.guideDiagonal.x1 >= return.inverted.plot.x
 * return.inverted.guideDiagonal.x2 <= return.inverted.plot.x + return.inverted.plot.width
 * return.inverted.guideDiagonal.y1 >= return.inverted.plot.y
 * return.inverted.guideDiagonal.y1 <= return.inverted.plot.y + return.inverted.plot.height
 * return.inverted.guideDiagonal.y2 >= return.inverted.plot.y
 * return.inverted.guideDiagonal.y2 <= return.inverted.plot.y + return.inverted.plot.height
 * return.inverted.guidePlateau.y1 >= return.inverted.plot.y
 * return.inverted.guidePlateau.y1 <= return.inverted.plot.y + return.inverted.plot.height
 * return.ordered.leftRegion.width >= 0
 * return.ordered.middleRegion.width >= 0
 * return.ordered.rightRegion.width >= 0
 * return.inverted.emptyMarker.x1 == return.inverted.thresholdU.x
 * return.inverted.emptyMarker.x2 == return.inverted.thresholdY.x
 * return.inverted.emptyMarker.x1 < return.inverted.emptyMarker.x2
 * return.ordered.axis.x1 >= return.ordered.plot.x
 * return.ordered.axis.x2 <= return.ordered.plot.x + return.ordered.plot.width
 * return.inverted.axis.x1 >= return.inverted.plot.x
 * return.inverted.axis.x2 <= return.inverted.plot.x + return.inverted.plot.width
 * return.ordered.labels.leftRegion.width == metrics.orderedRegionLeft.width + REGION_LABEL_PAD_X * 2
 * return.ordered.labels.middleRegion.width == metrics.orderedRegionMiddle.width + REGION_LABEL_PAD_X * 2
 * return.ordered.labels.rightRegion.width == metrics.orderedRegionRight.width + REGION_LABEL_PAD_X * 2
 * return.ordered.labels.leftRegion.height == metrics.orderedRegionLeft.height + REGION_LABEL_PAD_Y * 2
 * return.ordered.labels.middleRegion.height == metrics.orderedRegionMiddle.height + REGION_LABEL_PAD_Y * 2
 * return.ordered.labels.rightRegion.height == metrics.orderedRegionRight.height + REGION_LABEL_PAD_Y * 2
 * return.ordered.labels.leftRegion.x >= return.ordered.leftRegion.x
 * return.ordered.labels.leftRegion.x + return.ordered.labels.leftRegion.width <= return.ordered.leftRegion.x + return.ordered.leftRegion.width
 * return.ordered.labels.rightRegion.x >= return.ordered.rightRegion.x
 * return.ordered.labels.rightRegion.x + return.ordered.labels.rightRegion.width <= return.ordered.rightRegion.x + return.ordered.rightRegion.width
 * return.ordered.labels.leftRegion.y + return.ordered.labels.leftRegion.height <= return.ordered.upper.y1
 * return.ordered.labels.rightRegion.y + return.ordered.labels.rightRegion.height <= return.ordered.upper.y1
 * return.ordered.labels.middleRegion.x >= return.columns.left.x
 * return.ordered.labels.middleRegion.x + return.ordered.labels.middleRegion.width <= return.columns.left.x + return.columns.left.width
 * return.ordered.labels.middleRegion.y >= return.ordered.plot.y
 * return.ordered.labels.middleRegion.y + return.ordered.labels.middleRegion.height <= return.ordered.labels.leftFormula.y
 * return.ordered.labels.middleRegion.fallback: 0 | 1
 * return.ordered.labels.leftFormula.width == metrics.orderedFormulaLeft.width + FORMULA_CARD_PAD_X * 2
 * return.ordered.labels.middleFormula.width == metrics.orderedFormulaMiddle.width + FORMULA_CARD_PAD_X * 2
 * return.ordered.labels.rightFormula.width == metrics.orderedFormulaRight.width + FORMULA_CARD_PAD_X * 2
 * return.ordered.labels.leftFormula.height == metrics.orderedFormulaLeft.height + FORMULA_CARD_PAD_Y * 2
 * return.ordered.labels.middleFormula.height == metrics.orderedFormulaMiddle.height + FORMULA_CARD_PAD_Y * 2
 * return.ordered.labels.rightFormula.height == metrics.orderedFormulaRight.height + FORMULA_CARD_PAD_Y * 2
 * return.ordered.labels.leftFormula.x >= return.columns.left.x
 * return.ordered.labels.rightFormula.x + return.ordered.labels.rightFormula.width <= return.columns.left.x + return.columns.left.width
 * return.ordered.labels.leftFormula.x + return.ordered.labels.leftFormula.width <= return.ordered.labels.middleFormula.x
 * return.ordered.labels.middleFormula.x + return.ordered.labels.middleFormula.width <= return.ordered.labels.rightFormula.x
 * return.ordered.labels.leftFormula.y >= return.ordered.plot.y + return.ordered.plot.height
 * return.ordered.labels.rightFormula.y + return.ordered.labels.rightFormula.height <= return.columns.left.y + return.columns.left.height
 * return.inverted.labels.emptyInterval.width == metrics.emptyInterval.width + EMPTY_LABEL_PAD_X * 2
 * return.inverted.labels.emptyInterval.height == metrics.emptyInterval.height + EMPTY_LABEL_PAD_Y * 2
 * return.inverted.labels.emptyInterval.x >= return.columns.right.x
 * return.inverted.labels.emptyInterval.x + return.inverted.labels.emptyInterval.width <= return.columns.right.x + return.columns.right.width
 * return.inverted.labels.emptyInterval.y + return.inverted.labels.emptyInterval.height <= return.inverted.finalLine.y1
 * return.inverted.labels.finalLine.width == metrics.finalLineLabel.width + LINE_LABEL_PAD_X * 2
 * return.inverted.labels.finalLine.height == metrics.finalLineLabel.height + LINE_LABEL_PAD_Y * 2
 * return.inverted.labels.finalLine.y + return.inverted.labels.finalLine.height <= return.inverted.finalLine.y1
 * return.inverted.labels.guideLine.width == metrics.guideLineLabel.width + LINE_LABEL_PAD_X * 2
 * return.inverted.labels.guideLine.height == metrics.guideLineLabel.height + LINE_LABEL_PAD_Y * 2
 * return.inverted.labels.guideLine.y >= return.inverted.guidePlateau.y1
 * return.inverted.labels.guideLine.x + return.inverted.labels.guideLine.width <= return.inverted.plot.x + return.inverted.plot.width
 * return.inverted.labels.guideLine.y + return.inverted.labels.guideLine.height <= return.inverted.axis.y1
 * return.inverted.labels.finalFormula.width == metrics.invertedFormula.width + FORMULA_CARD_PAD_X * 2
 * return.inverted.labels.finalFormula.height == metrics.invertedFormula.height + FORMULA_CARD_PAD_Y * 2
 * return.inverted.labels.finalFormula.x >= return.columns.right.x
 * return.inverted.labels.finalFormula.x + return.inverted.labels.finalFormula.width <= return.columns.right.x + return.columns.right.width
 * return.inverted.labels.finalFormula.y >= return.inverted.plot.y + return.inverted.plot.height
 * return.inverted.labels.finalFormula.y + return.inverted.labels.finalFormula.height <= return.columns.right.y + return.columns.right.height
 * return.ordered.ticks.yLabel.width == metrics.tickY.width + TICK_LABEL_PAD_X * 2
 * return.ordered.ticks.uLabel.width == metrics.tickU.width + TICK_LABEL_PAD_X * 2
 * return.inverted.ticks.yLabel.width == metrics.tickY.width + TICK_LABEL_PAD_X * 2
 * return.inverted.ticks.uLabel.width == metrics.tickU.width + TICK_LABEL_PAD_X * 2
 * return.ordered.ticks.yLabel.x + return.ordered.ticks.yLabel.width <= return.ordered.ticks.uLabel.x
 * return.inverted.ticks.uLabel.x + return.inverted.ticks.uLabel.width <= return.inverted.ticks.yLabel.x
 */
export function buildGeometry(metrics: TextMetricsInput) {
  const viewBox: Rect = {x: 0, y: 0, width: 1200, height: 800}

  const topTitle: Rect = {x: 54, y: 22, width: metrics.topTitle.width, height: metrics.topTitle.height}
  const topSubtitle: Rect = {x: 54, y: 62, width: metrics.topSubtitle.width, height: metrics.topSubtitle.height}
  const topFormula: Rect = {x: 54, y: 88, width: metrics.topFormula.width, height: metrics.topFormula.height}

  const marginX = 54
  const columnGap = 36
  const columnTop = 172
  const columnHeight = 580
  const columnWidth = (viewBox.width - marginX * 2 - columnGap) / 2

  const leftColumn: Rect = {x: marginX, y: columnTop, width: columnWidth, height: columnHeight}
  const rightColumn: Rect = {
    x: marginX + columnWidth + columnGap,
    y: columnTop,
    width: columnWidth,
    height: columnHeight,
  }

  const orderedPanelText = {
    title: {x: leftColumn.x + 24, y: leftColumn.y + 28, width: metrics.orderedPanelTitle.width, height: metrics.orderedPanelTitle.height},
    assumption: {x: leftColumn.x + 24, y: leftColumn.y + 54, width: metrics.orderedPanelAssumption.width, height: metrics.orderedPanelAssumption.height},
    note: {x: leftColumn.x + 24, y: leftColumn.y + 78, width: metrics.orderedPanelNote.width, height: metrics.orderedPanelNote.height},
  }
  const invertedPanelText = {
    title: {x: rightColumn.x + 24, y: rightColumn.y + 28, width: metrics.invertedPanelTitle.width, height: metrics.invertedPanelTitle.height},
    assumption: {x: rightColumn.x + 24, y: rightColumn.y + 54, width: metrics.invertedPanelAssumption.width, height: metrics.invertedPanelAssumption.height},
    note: {x: rightColumn.x + 24, y: rightColumn.y + 78, width: metrics.invertedPanelNote.width, height: metrics.invertedPanelNote.height},
  }

  const plotOffsetX = 78
  const plotTop = columnTop + 172
  const plotWidth = columnWidth - 130
  const plotHeight = 244
  const leftPlot: Rect = {x: leftColumn.x + plotOffsetX, y: plotTop, width: plotWidth, height: plotHeight}
  const rightPlot: Rect = {x: rightColumn.x + plotOffsetX, y: plotTop, width: plotWidth, height: plotHeight}

  const orderedYx = leftPlot.x + 108
  const orderedUx = leftPlot.x + 278
  const orderedLowerY = leftPlot.y + 178
  const orderedUpperY = leftPlot.y + 66
  const axisY = leftPlot.y + leftPlot.height - 30

  const orderedLower: Segment = {x1: leftPlot.x, y1: orderedLowerY, x2: orderedYx, y2: orderedLowerY}
  const orderedDiagonal: Segment = {x1: orderedYx, y1: orderedLowerY, x2: orderedUx, y2: orderedUpperY}
  const orderedUpper: Segment = {x1: orderedUx, y1: orderedUpperY, x2: leftPlot.x + leftPlot.width, y2: orderedUpperY}

  const orderedLeftRegion = {x: leftPlot.x, y: leftPlot.y, width: orderedYx - leftPlot.x, height: leftPlot.height}
  const orderedMiddleRegion = {x: orderedYx, y: leftPlot.y, width: orderedUx - orderedYx, height: leftPlot.height}
  const orderedRightRegion = {x: orderedUx, y: leftPlot.y, width: leftPlot.x + leftPlot.width - orderedUx, height: leftPlot.height}

  const orderedLeftRegionLabelWidth = metrics.orderedRegionLeft.width + REGION_LABEL_PAD_X * 2
  const orderedMiddleRegionLabelWidth = metrics.orderedRegionMiddle.width + REGION_LABEL_PAD_X * 2
  const orderedRightRegionLabelWidth = metrics.orderedRegionRight.width + REGION_LABEL_PAD_X * 2
  const orderedLeftRegionLabelHeight = metrics.orderedRegionLeft.height + REGION_LABEL_PAD_Y * 2
  const orderedMiddleRegionLabelHeight = metrics.orderedRegionMiddle.height + REGION_LABEL_PAD_Y * 2
  const orderedRightRegionLabelHeight = metrics.orderedRegionRight.height + REGION_LABEL_PAD_Y * 2
  const orderedLeftRegionLabel: Rect = {
    x: orderedLeftRegion.x + (orderedLeftRegion.width - orderedLeftRegionLabelWidth) / 2,
    y: leftPlot.y + 14,
    width: orderedLeftRegionLabelWidth,
    height: orderedLeftRegionLabelHeight,
  }
  const orderedRightRegionLabel: Rect = {
    x: orderedRightRegion.x + (orderedRightRegion.width - orderedRightRegionLabelWidth) / 2,
    y: leftPlot.y + 14,
    width: orderedRightRegionLabelWidth,
    height: orderedRightRegionLabelHeight,
  }

  let orderedMiddleRegionLabelX = orderedMiddleRegion.x + (orderedMiddleRegion.width - orderedMiddleRegionLabelWidth) / 2
  let orderedMiddleRegionLabelY = leftPlot.y + 14
  let orderedMiddleRegionFallback = 0
  if (orderedMiddleRegionLabelWidth > orderedMiddleRegion.width) {
    orderedMiddleRegionLabelX = leftColumn.x + 24
    orderedMiddleRegionLabelY = leftPlot.y + leftPlot.height + 12
    orderedMiddleRegionFallback = 1
  }

  const orderedMiddleRegionLabel = {
    x: orderedMiddleRegionLabelX,
    y: orderedMiddleRegionLabelY,
    width: orderedMiddleRegionLabelWidth,
    height: orderedMiddleRegionLabelHeight,
    fallback: orderedMiddleRegionFallback,
  }

  const formulaGap = 24
  const orderedLeftFormulaWidth = metrics.orderedFormulaLeft.width + FORMULA_CARD_PAD_X * 2
  const orderedMiddleFormulaWidth = metrics.orderedFormulaMiddle.width + FORMULA_CARD_PAD_X * 2
  const orderedRightFormulaWidth = metrics.orderedFormulaRight.width + FORMULA_CARD_PAD_X * 2
  const formulaGroupWidth = orderedLeftFormulaWidth + orderedMiddleFormulaWidth + orderedRightFormulaWidth + formulaGap * 2
  const formulaGroupX = leftColumn.x + (leftColumn.width - formulaGroupWidth) / 2
  const formulaY = leftPlot.y + leftPlot.height + 64
  const orderedLeftFormula: Rect = {
    x: formulaGroupX,
    y: formulaY,
    width: orderedLeftFormulaWidth,
    height: metrics.orderedFormulaLeft.height + FORMULA_CARD_PAD_Y * 2,
  }
  const orderedMiddleFormula: Rect = {
    x: orderedLeftFormula.x + orderedLeftFormula.width + formulaGap,
    y: formulaY,
    width: orderedMiddleFormulaWidth,
    height: metrics.orderedFormulaMiddle.height + FORMULA_CARD_PAD_Y * 2,
  }
  const orderedRightFormula: Rect = {
    x: orderedMiddleFormula.x + orderedMiddleFormula.width + formulaGap,
    y: formulaY,
    width: orderedRightFormulaWidth,
    height: metrics.orderedFormulaRight.height + FORMULA_CARD_PAD_Y * 2,
  }

  const orderedTickYLabel: Rect = {
    x: orderedYx - (metrics.tickY.width + TICK_LABEL_PAD_X * 2) / 2,
    y: axisY + 13,
    width: metrics.tickY.width + TICK_LABEL_PAD_X * 2,
    height: metrics.tickY.height + TICK_LABEL_PAD_Y * 2,
  }
  const orderedTickULabel: Rect = {
    x: orderedUx - (metrics.tickU.width + TICK_LABEL_PAD_X * 2) / 2,
    y: axisY + 13,
    width: metrics.tickU.width + TICK_LABEL_PAD_X * 2,
    height: metrics.tickU.height + TICK_LABEL_PAD_Y * 2,
  }

  const invertedUx = rightPlot.x + 132
  const invertedYx = rightPlot.x + 270
  const invertedFinalY = rightPlot.y + 70
  const invertedGuideStartY = rightPlot.y + 176
  const invertedGuideY = rightPlot.y + 128
  const invertedAxisY = rightPlot.y + rightPlot.height - 30

  const invertedFinalLine: Segment = {
    x1: rightPlot.x,
    y1: invertedFinalY,
    x2: rightPlot.x + rightPlot.width,
    y2: invertedFinalY,
  }
  const invertedGuideDiagonal: Segment = {
    x1: rightPlot.x,
    y1: invertedGuideStartY,
    x2: invertedUx,
    y2: invertedGuideY,
  }
  const invertedGuidePlateau: Segment = {
    x1: invertedUx,
    y1: invertedGuideY,
    x2: rightPlot.x + rightPlot.width,
    y2: invertedGuideY,
  }

  const emptyIntervalLabel: Rect = {
    x: invertedUx + 8,
    y: rightPlot.y + 10,
    width: metrics.emptyInterval.width + EMPTY_LABEL_PAD_X * 2,
    height: metrics.emptyInterval.height + EMPTY_LABEL_PAD_Y * 2,
  }
  const finalLineLabel: Rect = {
    x: invertedFinalLine.x1 + 214,
    y: invertedFinalLine.y1 - (metrics.finalLineLabel.height + LINE_LABEL_PAD_Y * 2) - 10,
    width: metrics.finalLineLabel.width + LINE_LABEL_PAD_X * 2,
    height: metrics.finalLineLabel.height + LINE_LABEL_PAD_Y * 2,
  }
  const guideLineLabel: Rect = {
    x: invertedGuidePlateau.x1 + 18,
    y: invertedGuidePlateau.y1 + 8,
    width: metrics.guideLineLabel.width + LINE_LABEL_PAD_X * 2,
    height: metrics.guideLineLabel.height + LINE_LABEL_PAD_Y * 2,
  }
  const invertedFormulaWidth = metrics.invertedFormula.width + FORMULA_CARD_PAD_X * 2
  const invertedFormula: Rect = {
    x: rightColumn.x + (rightColumn.width - invertedFormulaWidth) / 2,
    y: rightPlot.y + rightPlot.height + 36,
    width: invertedFormulaWidth,
    height: metrics.invertedFormula.height + FORMULA_CARD_PAD_Y * 2,
  }

  const invertedTickULabel: Rect = {
    x: invertedUx - (metrics.tickU.width + TICK_LABEL_PAD_X * 2) / 2,
    y: invertedAxisY + 13,
    width: metrics.tickU.width + TICK_LABEL_PAD_X * 2,
    height: metrics.tickU.height + TICK_LABEL_PAD_Y * 2,
  }
  const invertedTickYLabel: Rect = {
    x: invertedYx - (metrics.tickY.width + TICK_LABEL_PAD_X * 2) / 2,
    y: invertedAxisY + 13,
    width: metrics.tickY.width + TICK_LABEL_PAD_X * 2,
    height: metrics.tickY.height + TICK_LABEL_PAD_Y * 2,
  }

  return {
    viewBox,
    top: {
      title: topTitle,
      subtitle: topSubtitle,
      formula: topFormula,
    },
    columns: {
      left: leftColumn,
      right: rightColumn,
    },
    ordered: {
      panelText: orderedPanelText,
      plot: leftPlot,
      axis: {x1: leftPlot.x, y1: axisY, x2: leftPlot.x + leftPlot.width, y2: axisY},
      cAxis: {x1: leftPlot.x, y1: leftPlot.y + 18, x2: leftPlot.x, y2: axisY},
      thresholdY: {x: orderedYx, tickTop: leftPlot.y + 50, tickBottom: axisY + 8},
      thresholdU: {x: orderedUx, tickTop: leftPlot.y + 50, tickBottom: axisY + 8},
      lower: orderedLower,
      diagonal: orderedDiagonal,
      upper: orderedUpper,
      leftRegion: orderedLeftRegion,
      middleRegion: orderedMiddleRegion,
      rightRegion: orderedRightRegion,
      labels: {
        leftRegion: orderedLeftRegionLabel,
        middleRegion: orderedMiddleRegionLabel,
        rightRegion: orderedRightRegionLabel,
        leftFormula: orderedLeftFormula,
        middleFormula: orderedMiddleFormula,
        rightFormula: orderedRightFormula,
      },
      ticks: {
        yLabel: orderedTickYLabel,
        uLabel: orderedTickULabel,
      },
    },
    inverted: {
      panelText: invertedPanelText,
      plot: rightPlot,
      axis: {x1: rightPlot.x, y1: invertedAxisY, x2: rightPlot.x + rightPlot.width, y2: invertedAxisY},
      cAxis: {x1: rightPlot.x, y1: rightPlot.y + 18, x2: rightPlot.x, y2: invertedAxisY},
      thresholdU: {x: invertedUx, tickTop: rightPlot.y + 50, tickBottom: invertedAxisY + 8},
      thresholdY: {x: invertedYx, tickTop: rightPlot.y + 50, tickBottom: invertedAxisY + 8},
      finalLine: invertedFinalLine,
      guideDiagonal: invertedGuideDiagonal,
      guidePlateau: invertedGuidePlateau,
      emptyMarker: {x1: invertedUx, y: rightPlot.y + 30, x2: invertedYx},
      labels: {
        emptyInterval: emptyIntervalLabel,
        finalLine: finalLineLabel,
        guideLine: guideLineLabel,
        finalFormula: invertedFormula,
      },
      ticks: {
        uLabel: invertedTickULabel,
        yLabel: invertedTickYLabel,
      },
    },
  }
}

const geometry = buildGeometry(exampleMetrics)

const n = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2)
const rectAttrs = (rect: Rect) => `x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}"`
const lineAttrs = (segment: Segment) => `x1="${n(segment.x1)}" y1="${n(segment.y1)}" x2="${n(segment.x2)}" y2="${n(segment.y2)}"`
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function renderTextBlock(rect: Rect, block: TextBlock) {
  let currentY = rect.y + block.paddingY
  const x = block.align === 'center' ? rect.x + rect.width / 2 : rect.x + block.paddingX
  const anchor = block.align === 'center' ? ' text-anchor="middle"' : ''
  return block.lines.map(line => {
    currentY += line.fontSize
    const text = `<text x="${n(x)}" y="${n(currentY)}" class="${line.className}"${anchor}>${escapeText(line.text)}</text>`
    currentY += line.lineHeight - line.fontSize
    return text
  }).join('\n  ')
}

function formulaCard(rect: Rect, block: TextBlock) {
  return `<rect ${rectAttrs(rect)} rx="6" class="formula-card"/>\n  ${renderTextBlock(rect, block)}`
}

export function renderSvg() {
  const g = geometry
  const ordered = g.ordered
  const inverted = g.inverted
  const orderedPlotEnd = ordered.plot.x + ordered.plot.width
  const invertedPlotEnd = inverted.plot.x + inverted.plot.width

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${g.viewBox.x} ${g.viewBox.y} ${g.viewBox.width} ${g.viewBox.height}" role="img" aria-labelledby="title desc">
  <title id="title">Clamp-shaped min/max reduction geometry</title>
  <desc id="desc">Two equal-width columns compare ordered bounds y &lt;= u and inverted bounds y &gt; u for C(z) = max(y, min(z, u)), where u = -x - y and E = x - C(z).</desc>
  <defs>
    <pattern id="blue-stripe" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="#eaf4ff"/>
      <path d="M0 8 L8 0" stroke="#aacbe8" stroke-width="1"/>
    </pattern>
    <pattern id="amber-dots" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="#fff3d7"/>
      <circle cx="2" cy="2" r="1.1" fill="#d9b65b"/>
      <circle cx="7" cy="7" r="1.1" fill="#d9b65b"/>
    </pattern>
    <pattern id="green-grid" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="#eaf8ef"/>
      <path d="M0 5 H10 M5 0 V10" stroke="#a9d8b8" stroke-width="0.8"/>
    </pattern>
    <pattern id="empty-hatch" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="#fff0f0"/>
      <path d="M-2 8 L8 -2 M2 10 L10 2" stroke="#d88a8a" stroke-width="1.1"/>
    </pattern>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 Z" fill="#4a5568"/>
    </marker>
  </defs>
  <style>
    svg { font-family: Helvetica, Arial, sans-serif; background: #fbfbf8; color: #172026; }
    .title { font-family: Helvetica, Arial, sans-serif; font-size: 28px; font-weight: 760; fill: #172026; }
    .subtitle { font-family: Helvetica, Arial, sans-serif; font-size: 14px; fill: #46525c; }
    .formula { font-family: Menlo, Consolas, monospace; font-size: 17px; fill: #1f2933; }
    .panel { fill: #ffffff; stroke: #cfd7df; stroke-width: 1.5; }
    .panel-title { font-family: Helvetica, Arial, sans-serif; font-size: 18px; font-weight: 720; fill: #172026; }
    .panel-note { font-family: Helvetica, Arial, sans-serif; font-size: 13px; fill: #4a5568; }
    .plot-frame { fill: none; stroke: #b9c3cc; stroke-width: 1.2; }
    .axis { stroke: #4a5568; stroke-width: 1.4; marker-end: url(#arrow); }
    .c-axis { stroke: #4a5568; stroke-width: 1.2; marker-end: url(#arrow); }
    .tick { stroke: #596775; stroke-width: 1.1; stroke-dasharray: 4 4; }
    .tick-label { font-family: Menlo, Consolas, monospace; font-size: 13px; fill: #2b3640; }
    .region-label { font-family: Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 700; fill: #27313a; }
    .region-sub { font-family: Menlo, Consolas, monospace; font-size: 11px; fill: #4a5568; }
    .graph { fill: none; stroke: #0e7490; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
    .guide { fill: none; stroke: #8b5e34; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 9 7; }
    .final { fill: none; stroke: #b42318; stroke-width: 5; stroke-linecap: round; }
    .line-label { font-family: Menlo, Consolas, monospace; font-size: 13px; font-weight: 720; fill: #172026; }
    .formula-card { fill: #f7fafc; stroke: #cfd7df; stroke-width: 1; }
    .formula-head { font-family: Menlo, Consolas, monospace; font-size: 12px; font-weight: 760; fill: #27313a; }
    .formula-small { font-family: Menlo, Consolas, monospace; font-size: 11.4px; fill: #334150; }
    .empty-band { fill: url(#empty-hatch); stroke: #c24137; stroke-width: 1; }
    .empty-text { font-family: Menlo, Consolas, monospace; font-size: 12px; font-weight: 740; fill: #7a1f18; }
  </style>

  ${renderTextBlock(g.top.title, TEXT_BLOCKS.topTitle)}
  ${renderTextBlock(g.top.subtitle, TEXT_BLOCKS.topSubtitle)}
  ${renderTextBlock(g.top.formula, TEXT_BLOCKS.topFormula)}

  <rect ${rectAttrs(g.columns.left)} rx="8" class="panel"/>
  <rect ${rectAttrs(g.columns.right)} rx="8" class="panel"/>

  ${renderTextBlock(ordered.panelText.title, TEXT_BLOCKS.orderedPanelTitle)}
  ${renderTextBlock(ordered.panelText.assumption, TEXT_BLOCKS.orderedPanelAssumption)}
  ${renderTextBlock(ordered.panelText.note, TEXT_BLOCKS.orderedPanelNote)}

  ${renderTextBlock(inverted.panelText.title, TEXT_BLOCKS.invertedPanelTitle)}
  ${renderTextBlock(inverted.panelText.assumption, TEXT_BLOCKS.invertedPanelAssumption)}
  ${renderTextBlock(inverted.panelText.note, TEXT_BLOCKS.invertedPanelNote)}

  <rect ${rectAttrs(ordered.leftRegion)} fill="url(#blue-stripe)" opacity="0.9"/>
  <rect ${rectAttrs(ordered.middleRegion)} fill="url(#amber-dots)" opacity="0.95"/>
  <rect ${rectAttrs(ordered.rightRegion)} fill="url(#green-grid)" opacity="0.95"/>
  <rect ${rectAttrs(ordered.plot)} class="plot-frame"/>
  <line ${lineAttrs(ordered.axis)} class="axis"/>
  <line ${lineAttrs(ordered.cAxis)} class="c-axis"/>
  <line x1="${n(ordered.thresholdY.x)}" y1="${n(ordered.thresholdY.tickTop)}" x2="${n(ordered.thresholdY.x)}" y2="${n(ordered.thresholdY.tickBottom)}" class="tick"/>
  <line x1="${n(ordered.thresholdU.x)}" y1="${n(ordered.thresholdU.tickTop)}" x2="${n(ordered.thresholdU.x)}" y2="${n(ordered.thresholdU.tickBottom)}" class="tick"/>
  <path d="M ${n(ordered.lower.x1)} ${n(ordered.lower.y1)} L ${n(ordered.lower.x2)} ${n(ordered.lower.y2)} L ${n(ordered.diagonal.x2)} ${n(ordered.diagonal.y2)} L ${n(ordered.upper.x2)} ${n(ordered.upper.y2)}" class="graph"/>
  <text x="${n(ordered.plot.x + 12)}" y="${n(ordered.cAxis.y1 - 8)}" class="tick-label" text-anchor="middle">C</text>
  <text x="${n(orderedPlotEnd + 16)}" y="${n(ordered.axis.y1 + 5)}" class="tick-label" text-anchor="middle">z</text>
  ${renderTextBlock(ordered.ticks.yLabel, TEXT_BLOCKS.tickY)}
  ${renderTextBlock(ordered.ticks.uLabel, TEXT_BLOCKS.tickU)}
  ${renderTextBlock(ordered.labels.leftRegion, TEXT_BLOCKS.orderedRegionLeft)}
  ${ordered.labels.middleRegion.fallback === 0 ? renderTextBlock(ordered.labels.middleRegion, TEXT_BLOCKS.orderedRegionMiddle) : ''}
  ${renderTextBlock(ordered.labels.rightRegion, TEXT_BLOCKS.orderedRegionRight)}

  ${ordered.labels.middleRegion.fallback === 1 ? renderTextBlock(ordered.labels.middleRegion, TEXT_BLOCKS.orderedRegionMiddle) : ''}
  ${formulaCard(ordered.labels.leftFormula, TEXT_BLOCKS.orderedFormulaLeft)}
  ${formulaCard(ordered.labels.middleFormula, TEXT_BLOCKS.orderedFormulaMiddle)}
  ${formulaCard(ordered.labels.rightFormula, TEXT_BLOCKS.orderedFormulaRight)}

  <rect ${rectAttrs(inverted.plot)} fill="#fffaf0"/>
  <rect x="${n(inverted.emptyMarker.x1)}" y="${n(inverted.plot.y)}" width="${n(inverted.emptyMarker.x2 - inverted.emptyMarker.x1)}" height="${n(inverted.plot.height)}" class="empty-band" opacity="0.68"/>
  <rect ${rectAttrs(inverted.plot)} class="plot-frame"/>
  <line ${lineAttrs(inverted.axis)} class="axis"/>
  <line ${lineAttrs(inverted.cAxis)} class="c-axis"/>
  <line x1="${n(inverted.thresholdU.x)}" y1="${n(inverted.thresholdU.tickTop)}" x2="${n(inverted.thresholdU.x)}" y2="${n(inverted.thresholdU.tickBottom)}" class="tick"/>
  <line x1="${n(inverted.thresholdY.x)}" y1="${n(inverted.thresholdY.tickTop)}" x2="${n(inverted.thresholdY.x)}" y2="${n(inverted.thresholdY.tickBottom)}" class="tick"/>
  <path d="M ${n(inverted.guideDiagonal.x1)} ${n(inverted.guideDiagonal.y1)} L ${n(inverted.guideDiagonal.x2)} ${n(inverted.guideDiagonal.y2)} L ${n(inverted.guidePlateau.x2)} ${n(inverted.guidePlateau.y2)}" class="guide"/>
  <line ${lineAttrs(inverted.finalLine)} class="final"/>
  <line x1="${n(inverted.emptyMarker.x1)}" y1="${n(inverted.emptyMarker.y)}" x2="${n(inverted.emptyMarker.x2)}" y2="${n(inverted.emptyMarker.y)}" stroke="#c24137" stroke-width="1.6" marker-start="url(#arrow)" marker-end="url(#arrow)"/>
  <text x="${n(inverted.plot.x + 12)}" y="${n(inverted.cAxis.y1 - 8)}" class="tick-label" text-anchor="middle">C</text>
  <text x="${n(invertedPlotEnd + 16)}" y="${n(inverted.axis.y1 + 5)}" class="tick-label" text-anchor="middle">z</text>
  ${renderTextBlock(inverted.ticks.uLabel, TEXT_BLOCKS.tickU)}
  ${renderTextBlock(inverted.ticks.yLabel, TEXT_BLOCKS.tickY)}
  ${renderTextBlock(inverted.labels.emptyInterval, TEXT_BLOCKS.emptyInterval)}
  ${renderTextBlock(inverted.labels.finalLine, TEXT_BLOCKS.finalLineLabel)}
  ${renderTextBlock(inverted.labels.guideLine, TEXT_BLOCKS.guideLineLabel)}

  ${formulaCard(inverted.labels.finalFormula, TEXT_BLOCKS.invertedFormula)}
</svg>
`
}

if (import.meta.main) {
  writeFileSync(new URL('./diagram.svg', import.meta.url), renderSvg())
}
