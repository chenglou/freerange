type Box = {
  x: number
  y: number
  width: number
  height: number
}

type Point = {
  x: number
  y: number
}

type TextAnchor = 'left' | 'middle'

type TextBlock = {
  box: Box
  lines: string[]
  className: string
  lineHeight: number
  firstBaselineOffset: number
  anchor: TextAnchor
  insetX: number
}

type PlotLabels = {
  low: TextBlock
  mid: TextBlock
  high: TextBlock
  branch: TextBlock
  collapse: TextBlock
}

type ColumnKind = 'ordered' | 'inverted'

type ColumnSpec = {
  kind: ColumnKind
  panelX: number
  panelY: number
  panelWidth: number
}

type ColumnGeometry = {
  kind: ColumnKind
  panel: Box
  title: TextBlock
  note: TextBlock
  plot: Box
  labels: PlotLabels
  formula: TextBlock
  yThresholdX: number
  uThresholdX: number
  yBranchY: number
  uBranchY: number
  diagonalStart: Point
  diagonalEnd: Point
  middleIntervalWidth: number
}

type ColumnContent = {
  titleLines: string[]
  noteLines: string[]
  formulaLines: string[]
  lowLabelLines: string[]
  midLabelLines: string[]
  highLabelLines: string[]
  branchLabelLines: string[]
  collapseLabelLines: string[]
  midLineHeight: number
  midBaseline: number
  collapseLineHeight: number
  collapseBaseline: number
}

type ColumnPlotCase = {
  yThresholdX: number
  uThresholdX: number
  midBox: Box
  collapseBox: Box
  diagonalStart: Point
  diagonalEnd: Point
  middleIntervalWidth: number
}

type KeyPointGeometry = {
  box: Box
  text: TextBlock
}

type DiagramGeometry = {
  width: number
  height: number
  marginX: number
  titleSubtitleGap: number
  columnGap: number
  panelPad: number
  noteGap: number
  titleNoteGap: number
  plotToFormulaGap: number
  panelToKeyGap: number
  keyPad: number
  title: TextBlock
  subtitle: TextBlock
  left: ColumnGeometry
  right: ColumnGeometry
  key: KeyPointGeometry
}

const PAGE_WIDTH = 1200
const OUTER_MARGIN_X = 60
const TOP_MARGIN = 34
const BOTTOM_MARGIN = 34
const TITLE_HEIGHT = 42
const SUBTITLE_HEIGHT = 62
const TITLE_SUBTITLE_GAP = 8
const SUBTITLE_TO_PANELS_GAP = 24
const COLUMN_GAP = 32
const PANEL_PAD = 20
const PANEL_TITLE_HEIGHT = 32
const TITLE_NOTE_GAP = 10
const NOTE_HEIGHT = 54
const NOTE_PLOT_GAP = 18
const PLOT_HEIGHT = 266
const PLOT_TO_FORMULA_GAP = 18
const FORMULA_HEIGHT = 82
const PANEL_TO_KEY_GAP = 24
const KEY_HEIGHT = 76
const KEY_PAD = 18
const KEY_TEXT_HEIGHT = 40

const PLOT_INSET_X = 46
const PLOT_INSET_TOP = 34
const PLOT_INSET_BOTTOM = 42
const LEFT_Y_THRESHOLD_OFFSET = 134
const LEFT_U_THRESHOLD_OFFSET = 332
const RIGHT_U_THRESHOLD_OFFSET = 142
const RIGHT_Y_THRESHOLD_OFFSET = 332
const Y_BRANCH_OFFSET_FROM_TOP = 154
const U_BRANCH_OFFSET_FROM_TOP = 82
const REGION_LABEL_Y_OFFSET = 26
const BRANCH_LABEL_WIDTH = 106
const BRANCH_LABEL_HEIGHT = 24
const REGION_LABEL_WIDTH = 112
const REGION_LABEL_HEIGHT = 24
const COLLAPSE_LABEL_WIDTH = 190
const COLLAPSE_LABEL_HEIGHT = 26

const TEXT_INSET_X = 16
const CENTER_INSET_X = 0
const TITLE_LINE_HEIGHT = 30
const TITLE_BASELINE = 29
const SUBTITLE_LINE_HEIGHT = 24
const SUBTITLE_BASELINE = 26
const COLUMN_TITLE_LINE_HEIGHT = 22
const COLUMN_TITLE_BASELINE = 22
const NOTE_LINE_HEIGHT = 20
const NOTE_BASELINE = 22
const FORMULA_LINE_HEIGHT = 21
const FORMULA_BASELINE = 29
const LABEL_LINE_HEIGHT = 14
const LABEL_BASELINE = 16
const SMALL_LABEL_LINE_HEIGHT = 13
const SMALL_LABEL_BASELINE = 11
const KEY_LINE_HEIGHT = 22
const KEY_BASELINE = 15

const MAIN_TITLE_LINES = ['Clamp Form Needs Ordered Bounds']
const SUBTITLE_LINES = [
  'E = x + min(-y, y + max(x, -z - y)) = x - max(y, min(-x - y, z))',
  '= x - clamp(y, z, -x - y) only when y <= -x - y',
]
const ORDERED_TITLE_LINES = ['Ordered bounds']
const ORDERED_NOTE_LINES = [
  'Assume y <= u, where u = -x - y.',
  'The middle region is a real interval.',
]
const ORDERED_FORMULA_LINES = [
  'C(z) = max(y, min(z, u)) = clamp(y, z, u)',
  'Therefore E = x - C(z) = x - clamp(y, z, -x - y).',
]
const INVERTED_TITLE_LINES = ['Inverted bounds']
const INVERTED_NOTE_LINES = [
  'Assume y > u, where u = -x - y.',
  'The requested middle interval is empty.',
]
const INVERTED_FORMULA_LINES = [
  'Since min(z, u) <= u < y, max(y, min(z, u)) = y.',
  'The original expression takes the y branch, not a valid ordered clamp.',
]
const ORDERED_LOW_LABEL_LINES = ['z < y']
const ORDERED_MID_LABEL_LINES = ['y <= z <= u']
const ORDERED_HIGH_LABEL_LINES = ['z > u']
const ORDERED_BRANCH_LABEL_LINES = ['C(z) = y']
const ORDERED_COLLAPSE_LABEL_LINES = ['C(z) = u']
const INVERTED_LOW_LABEL_LINES = ['z < u']
const INVERTED_MID_LABEL_LINES = ['empty interval', 'y <= z <= u']
const INVERTED_HIGH_LABEL_LINES = ['z > y']
const INVERTED_BRANCH_LABEL_LINES = ['C(z) = y']
const INVERTED_COLLAPSE_LABEL_LINES = ['collapse:', 'C(z) = y']
const KEY_POINT_LINES = [
  'Key point: the final clamp notation is valid under y <= -x - y.',
  'When the bounds invert, the original max/min expression collapses to the y branch instead.',
]

function makeBox(x: number, y: number, width: number, height: number): Box {
  return {x, y, width, height}
}

function makePoint(x: number, y: number): Point {
  return {x, y}
}

function columnContent(kind: ColumnKind): ColumnContent {
  switch (kind) {
    case 'ordered':
      return {
        titleLines: ORDERED_TITLE_LINES,
        noteLines: ORDERED_NOTE_LINES,
        formulaLines: ORDERED_FORMULA_LINES,
        lowLabelLines: ORDERED_LOW_LABEL_LINES,
        midLabelLines: ORDERED_MID_LABEL_LINES,
        highLabelLines: ORDERED_HIGH_LABEL_LINES,
        branchLabelLines: ORDERED_BRANCH_LABEL_LINES,
        collapseLabelLines: ORDERED_COLLAPSE_LABEL_LINES,
        midLineHeight: LABEL_LINE_HEIGHT,
        midBaseline: LABEL_BASELINE,
        collapseLineHeight: LABEL_LINE_HEIGHT,
        collapseBaseline: LABEL_BASELINE,
      }
    case 'inverted':
      return {
        titleLines: INVERTED_TITLE_LINES,
        noteLines: INVERTED_NOTE_LINES,
        formulaLines: INVERTED_FORMULA_LINES,
        lowLabelLines: INVERTED_LOW_LABEL_LINES,
        midLabelLines: INVERTED_MID_LABEL_LINES,
        highLabelLines: INVERTED_HIGH_LABEL_LINES,
        branchLabelLines: INVERTED_BRANCH_LABEL_LINES,
        collapseLabelLines: INVERTED_COLLAPSE_LABEL_LINES,
        midLineHeight: SMALL_LABEL_LINE_HEIGHT,
        midBaseline: SMALL_LABEL_BASELINE,
        collapseLineHeight: SMALL_LABEL_LINE_HEIGHT,
        collapseBaseline: SMALL_LABEL_BASELINE,
      }
  }
}

/** @fit
 * return.title.box.y == TOP_MARGIN
 * return.subtitle.box.y == return.title.box.y + return.title.box.height + TITLE_SUBTITLE_GAP
 * return.titleSubtitleGap == TITLE_SUBTITLE_GAP
 * return.titleSubtitleGap: 0..10
 * return.left.panel.width == return.right.panel.width
 * return.right.panel.x == return.left.panel.x + return.left.panel.width + COLUMN_GAP
 * return.left.panel.y == return.right.panel.y
 * return.left.panel.y >= return.subtitle.box.y + return.subtitle.box.height + SUBTITLE_TO_PANELS_GAP
 * return.left.panel.x + return.left.panel.width <= return.right.panel.x
 * return.left.panel.y + return.left.panel.height == return.left.formula.box.y + return.left.formula.box.height + PANEL_PAD
 * return.right.panel.y + return.right.panel.height == return.right.formula.box.y + return.right.formula.box.height + PANEL_PAD
 * return.left.plot.x >= return.left.panel.x + PANEL_PAD
 * return.left.plot.y >= return.left.panel.y + PANEL_PAD
 * return.left.plot.x + return.left.plot.width <= return.left.panel.x + return.left.panel.width - PANEL_PAD
 * return.left.plot.y + return.left.plot.height <= return.left.panel.y + return.left.panel.height - PANEL_PAD
 * return.right.plot.x >= return.right.panel.x + PANEL_PAD
 * return.right.plot.y >= return.right.panel.y + PANEL_PAD
 * return.right.plot.x + return.right.plot.width <= return.right.panel.x + return.right.panel.width - PANEL_PAD
 * return.right.plot.y + return.right.plot.height <= return.right.panel.y + return.right.panel.height - PANEL_PAD
 * return.left.formula.box.y == return.left.plot.y + return.left.plot.height + PLOT_TO_FORMULA_GAP
 * return.right.formula.box.y == return.right.plot.y + return.right.plot.height + PLOT_TO_FORMULA_GAP
 * return.left.title.box.y + return.left.title.box.height <= return.left.note.box.y
 * return.left.note.box.y + return.left.note.box.height <= return.left.plot.y
 * return.left.plot.y + return.left.plot.height <= return.left.formula.box.y
 * return.right.title.box.y + return.right.title.box.height <= return.right.note.box.y
 * return.right.note.box.y + return.right.note.box.height <= return.right.plot.y
 * return.right.plot.y + return.right.plot.height <= return.right.formula.box.y
 * return.left.panel.y + return.left.panel.height <= return.key.box.y
 * return.right.panel.y + return.right.panel.height <= return.key.box.y
 * return.key.box.x >= return.marginX
 * return.key.box.x + return.key.box.width <= return.width - return.marginX
 * return.key.text.box.x >= return.key.box.x + KEY_PAD
 * return.key.text.box.y >= return.key.box.y + KEY_PAD
 * return.key.text.box.x + return.key.text.box.width <= return.key.box.x + return.key.box.width - KEY_PAD
 * return.key.text.box.y + return.key.text.box.height <= return.key.box.y + return.key.box.height - KEY_PAD
 * return.left.labels.low.box.x >= return.left.plot.x
 * return.left.labels.low.box.y >= return.left.plot.y
 * return.left.labels.low.box.x + return.left.labels.low.box.width <= return.left.plot.x + return.left.plot.width
 * return.left.labels.low.box.y + return.left.labels.low.box.height <= return.left.plot.y + return.left.plot.height
 * return.left.labels.mid.box.x >= return.left.plot.x
 * return.left.labels.mid.box.y >= return.left.plot.y
 * return.left.labels.mid.box.x + return.left.labels.mid.box.width <= return.left.plot.x + return.left.plot.width
 * return.left.labels.mid.box.y + return.left.labels.mid.box.height <= return.left.plot.y + return.left.plot.height
 * return.left.labels.high.box.x >= return.left.plot.x
 * return.left.labels.high.box.y >= return.left.plot.y
 * return.left.labels.high.box.x + return.left.labels.high.box.width <= return.left.plot.x + return.left.plot.width
 * return.left.labels.high.box.y + return.left.labels.high.box.height <= return.left.plot.y + return.left.plot.height
 * return.right.labels.low.box.x >= return.right.plot.x
 * return.right.labels.low.box.y >= return.right.plot.y
 * return.right.labels.low.box.x + return.right.labels.low.box.width <= return.right.plot.x + return.right.plot.width
 * return.right.labels.low.box.y + return.right.labels.low.box.height <= return.right.plot.y + return.right.plot.height
 * return.right.labels.mid.box.x >= return.right.plot.x
 * return.right.labels.mid.box.y >= return.right.plot.y
 * return.right.labels.mid.box.x + return.right.labels.mid.box.width <= return.right.plot.x + return.right.plot.width
 * return.right.labels.mid.box.y + return.right.labels.mid.box.height <= return.right.plot.y + return.right.plot.height
 * return.right.labels.high.box.x >= return.right.plot.x
 * return.right.labels.high.box.y >= return.right.plot.y
 * return.right.labels.high.box.x + return.right.labels.high.box.width <= return.right.plot.x + return.right.plot.width
 * return.right.labels.high.box.y + return.right.labels.high.box.height <= return.right.plot.y + return.right.plot.height
 * return.left.yThresholdX < return.left.uThresholdX
 * return.right.yThresholdX > return.right.uThresholdX
 * return.right.middleIntervalWidth == 0
 * return.right.diagonalStart.y == return.right.yBranchY
 * return.right.diagonalEnd.y == return.right.yBranchY
 */
export function createDiagramGeometry(): DiagramGeometry {
  const contentWidth = PAGE_WIDTH - OUTER_MARGIN_X * 2
  const columnWidth = (contentWidth - COLUMN_GAP) / 2
  const titleBox = makeBox(OUTER_MARGIN_X, TOP_MARGIN, contentWidth, TITLE_HEIGHT)
  const title = {
    box: titleBox,
    lines: MAIN_TITLE_LINES,
    className: 'main-title',
    lineHeight: TITLE_LINE_HEIGHT,
    firstBaselineOffset: TITLE_BASELINE,
    anchor: 'middle' as TextAnchor,
    insetX: CENTER_INSET_X,
  }
  const subtitleBox = makeBox(
    OUTER_MARGIN_X,
    title.box.y + title.box.height + TITLE_SUBTITLE_GAP,
    contentWidth,
    SUBTITLE_HEIGHT,
  )
  const subtitle = {
    box: subtitleBox,
    lines: SUBTITLE_LINES,
    className: 'subtitle-text',
    lineHeight: SUBTITLE_LINE_HEIGHT,
    firstBaselineOffset: SUBTITLE_BASELINE,
    anchor: 'middle' as TextAnchor,
    insetX: CENTER_INSET_X,
  }
  const panelY = subtitle.box.y + subtitle.box.height + SUBTITLE_TO_PANELS_GAP
  const leftPanelX = OUTER_MARGIN_X
  const rightPanelX = leftPanelX + columnWidth + COLUMN_GAP
  const leftColumn = makeColumnGeometry({
    kind: 'ordered',
    panelX: leftPanelX,
    panelY,
    panelWidth: columnWidth,
  })
  const rightColumn = makeColumnGeometry({
    kind: 'inverted',
    panelX: rightPanelX,
    panelY,
    panelWidth: columnWidth,
  })
  const panelBottom = leftColumn.panel.y + leftColumn.panel.height
  const keyBox = makeBox(OUTER_MARGIN_X, panelBottom + PANEL_TO_KEY_GAP, contentWidth, KEY_HEIGHT)
  const keyTextBox = makeBox(keyBox.x + KEY_PAD, keyBox.y + KEY_PAD, keyBox.width - KEY_PAD * 2, KEY_TEXT_HEIGHT)
  const keyText = {
    box: keyTextBox,
    lines: KEY_POINT_LINES,
    className: 'key-text',
    lineHeight: KEY_LINE_HEIGHT,
    firstBaselineOffset: KEY_BASELINE,
    anchor: 'left' as TextAnchor,
    insetX: TEXT_INSET_X,
  }
  return {
    width: PAGE_WIDTH,
    height: keyBox.y + keyBox.height + BOTTOM_MARGIN,
    marginX: OUTER_MARGIN_X,
    titleSubtitleGap: TITLE_SUBTITLE_GAP,
    columnGap: COLUMN_GAP,
    panelPad: PANEL_PAD,
    noteGap: NOTE_PLOT_GAP,
    titleNoteGap: TITLE_NOTE_GAP,
    plotToFormulaGap: PLOT_TO_FORMULA_GAP,
    panelToKeyGap: PANEL_TO_KEY_GAP,
    keyPad: KEY_PAD,
    title,
    subtitle,
    left: leftColumn,
    right: rightColumn,
    key: {
      box: keyBox,
      text: keyText,
    },
  }
}

/** @fit
 * given spec.panelX: 0..2000
 * given spec.panelY: 0..2000
 * given spec.panelWidth: 500..700
 * return.panel.x == spec.panelX
 * return.panel.y == spec.panelY
 * return.panel.width == spec.panelWidth
 * return.title.box.x == return.panel.x + PANEL_PAD
 * return.title.box.y == return.panel.y + PANEL_PAD
 * return.note.box.y == return.title.box.y + return.title.box.height + TITLE_NOTE_GAP
 * return.plot.y == return.note.box.y + return.note.box.height + NOTE_PLOT_GAP
 * return.formula.box.y == return.plot.y + return.plot.height + PLOT_TO_FORMULA_GAP
 * return.panel.y + return.panel.height == return.formula.box.y + return.formula.box.height + PANEL_PAD
 * return.plot.x >= return.panel.x + PANEL_PAD
 * return.plot.x + return.plot.width <= return.panel.x + return.panel.width - PANEL_PAD
 */
function makeColumnGeometry(spec: ColumnSpec): ColumnGeometry {
  const content = columnContent(spec.kind)
  const titleBox = makeBox(spec.panelX + PANEL_PAD, spec.panelY + PANEL_PAD, spec.panelWidth - PANEL_PAD * 2, PANEL_TITLE_HEIGHT)
  const title = {
    box: titleBox,
    lines: content.titleLines,
    className: 'column-title',
    lineHeight: COLUMN_TITLE_LINE_HEIGHT,
    firstBaselineOffset: COLUMN_TITLE_BASELINE,
    anchor: 'middle' as TextAnchor,
    insetX: CENTER_INSET_X,
  }
  const noteBox = makeBox(title.box.x, title.box.y + title.box.height + TITLE_NOTE_GAP, title.box.width, NOTE_HEIGHT)
  const note = {
    box: noteBox,
    lines: content.noteLines,
    className: 'note-text',
    lineHeight: NOTE_LINE_HEIGHT,
    firstBaselineOffset: NOTE_BASELINE,
    anchor: 'left' as TextAnchor,
    insetX: TEXT_INSET_X,
  }
  const plot = makeBox(title.box.x, note.box.y + note.box.height + NOTE_PLOT_GAP, title.box.width, PLOT_HEIGHT)
  const formulaBox = makeBox(title.box.x, plot.y + plot.height + PLOT_TO_FORMULA_GAP, title.box.width, FORMULA_HEIGHT)
  const formula = {
    box: formulaBox,
    lines: content.formulaLines,
    className: 'formula-text',
    lineHeight: FORMULA_LINE_HEIGHT,
    firstBaselineOffset: FORMULA_BASELINE,
    anchor: 'left' as TextAnchor,
    insetX: TEXT_INSET_X,
  }
  const panelHeight = formula.box.y + formula.box.height + PANEL_PAD - spec.panelY
  const panel = makeBox(spec.panelX, spec.panelY, spec.panelWidth, panelHeight)
  const graphLeft = plot.x + PLOT_INSET_X
  const graphRight = plot.x + plot.width - PLOT_INSET_X
  const yBranchY = plot.y + Y_BRANCH_OFFSET_FROM_TOP
  const uBranchY = plot.y + U_BRANCH_OFFSET_FROM_TOP
  const plotCase: ColumnPlotCase = spec.kind === 'ordered'
    ? {
      yThresholdX: plot.x + LEFT_Y_THRESHOLD_OFFSET,
      uThresholdX: plot.x + LEFT_U_THRESHOLD_OFFSET,
      midBox: makeBox(plot.x + LEFT_Y_THRESHOLD_OFFSET + 26, plot.y + REGION_LABEL_Y_OFFSET, REGION_LABEL_WIDTH + 28, REGION_LABEL_HEIGHT),
      collapseBox: makeBox(plot.x + LEFT_U_THRESHOLD_OFFSET - 30, uBranchY + 14, BRANCH_LABEL_WIDTH, BRANCH_LABEL_HEIGHT),
      diagonalStart: makePoint(plot.x + LEFT_Y_THRESHOLD_OFFSET, yBranchY),
      diagonalEnd: makePoint(plot.x + LEFT_U_THRESHOLD_OFFSET, uBranchY),
      middleIntervalWidth: LEFT_U_THRESHOLD_OFFSET - LEFT_Y_THRESHOLD_OFFSET,
    }
    : {
      yThresholdX: plot.x + RIGHT_Y_THRESHOLD_OFFSET,
      uThresholdX: plot.x + RIGHT_U_THRESHOLD_OFFSET,
      midBox: makeBox(plot.x + RIGHT_U_THRESHOLD_OFFSET + 60, plot.y + REGION_LABEL_Y_OFFSET, COLLAPSE_LABEL_WIDTH, REGION_LABEL_HEIGHT),
      collapseBox: makeBox(plot.x + RIGHT_Y_THRESHOLD_OFFSET - 138, yBranchY + 18, COLLAPSE_LABEL_WIDTH, COLLAPSE_LABEL_HEIGHT),
      diagonalStart: makePoint(graphLeft, yBranchY),
      diagonalEnd: makePoint(graphRight, yBranchY),
      middleIntervalWidth: 0,
    }
  const lowBox = makeBox(graphLeft + 4, plot.y + REGION_LABEL_Y_OFFSET, REGION_LABEL_WIDTH, REGION_LABEL_HEIGHT)
  const highBox = makeBox(graphRight - REGION_LABEL_WIDTH - 4, plot.y + REGION_LABEL_Y_OFFSET, REGION_LABEL_WIDTH, REGION_LABEL_HEIGHT)
  const branchBox = makeBox(graphLeft + 16, yBranchY - BRANCH_LABEL_HEIGHT - 8, BRANCH_LABEL_WIDTH, BRANCH_LABEL_HEIGHT)
  const labels = {
    low: {
      box: lowBox,
      lines: content.lowLabelLines,
      className: 'plot-label',
      lineHeight: LABEL_LINE_HEIGHT,
      firstBaselineOffset: LABEL_BASELINE,
      anchor: 'middle' as TextAnchor,
      insetX: CENTER_INSET_X,
    },
    mid: {
      box: plotCase.midBox,
      lines: content.midLabelLines,
      className: 'plot-label',
      lineHeight: content.midLineHeight,
      firstBaselineOffset: content.midBaseline,
      anchor: 'middle' as TextAnchor,
      insetX: CENTER_INSET_X,
    },
    high: {
      box: highBox,
      lines: content.highLabelLines,
      className: 'plot-label',
      lineHeight: LABEL_LINE_HEIGHT,
      firstBaselineOffset: LABEL_BASELINE,
      anchor: 'middle' as TextAnchor,
      insetX: CENTER_INSET_X,
    },
    branch: {
      box: branchBox,
      lines: content.branchLabelLines,
      className: 'plot-label',
      lineHeight: LABEL_LINE_HEIGHT,
      firstBaselineOffset: LABEL_BASELINE,
      anchor: 'middle' as TextAnchor,
      insetX: CENTER_INSET_X,
    },
    collapse: {
      box: plotCase.collapseBox,
      lines: content.collapseLabelLines,
      className: 'plot-label',
      lineHeight: content.collapseLineHeight,
      firstBaselineOffset: content.collapseBaseline,
      anchor: 'middle' as TextAnchor,
      insetX: CENTER_INSET_X,
    },
  }
  return {
    kind: spec.kind,
    panel,
    title,
    note,
    plot,
    labels,
    formula,
    yThresholdX: plotCase.yThresholdX,
    uThresholdX: plotCase.uThresholdX,
    yBranchY,
    uBranchY,
    diagonalStart: plotCase.diagonalStart,
    diagonalEnd: plotCase.diagonalEnd,
    middleIntervalWidth: plotCase.middleIntervalWidth,
  }
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function rect(box: Box, className: string, rx = 6) {
  return `<rect class="${className}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${rx}"/>`
}

function line(x1: number, y1: number, x2: number, y2: number, className: string) {
  return `<line class="${className}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
}

function path(points: Point[], className: string) {
  const [first, ...rest] = points
  if (first == null) return ''
  const commands = [`M ${first.x} ${first.y}`]
  for (const point of rest) {
    commands.push(`L ${point.x} ${point.y}`)
  }
  return `<path class="${className}" d="${commands.join(' ')}"/>`
}

function renderText(block: TextBlock) {
  const firstY = block.box.y + block.firstBaselineOffset
  let x = block.box.x + block.insetX
  let anchor = ''
  switch (block.anchor) {
    case 'left':
      break
    case 'middle':
      x = block.box.x + block.box.width / 2
      anchor = ' text-anchor="middle"'
      break
  }

  const tspans = []
  for (let i = 0; i < block.lines.length; i++) {
    const lineText = block.lines[i]!
    tspans.push(`<tspan x="${x}" y="${firstY + i * block.lineHeight}">${escapeXml(lineText)}</tspan>`)
  }
  return `<text class="${block.className}"${anchor}>${tspans.join('')}</text>`
}

function drawAxes(column: ColumnGeometry) {
  const graphLeft = column.plot.x + PLOT_INSET_X
  const graphRight = column.plot.x + column.plot.width - PLOT_INSET_X
  const graphTop = column.plot.y + PLOT_INSET_TOP
  const graphBottom = column.plot.y + column.plot.height - PLOT_INSET_BOTTOM
  return [
    line(graphLeft, graphBottom, graphRight, graphBottom, 'axis'),
    line(graphLeft, graphBottom, graphLeft, graphTop, 'axis'),
    `<path class="axis-arrow" d="M ${graphRight} ${graphBottom} l -8 -4 l 0 8 z"/>`,
    `<path class="axis-arrow" d="M ${graphLeft} ${graphTop} l -4 8 l 8 0 z"/>`,
    `<text class="axis-label" x="${graphRight - 10}" y="${graphBottom + 28}">z</text>`,
    `<text class="axis-label" x="${graphLeft - 34}" y="${graphTop + 8}">C(z)</text>`,
  ].join('\n')
}

function drawPlotLabel(label: TextBlock, boxClassName: string) {
  return [rect(label.box, boxClassName, 5), renderText(label)].join('\n')
}

function drawOrderedPlot(column: ColumnGeometry) {
  const graphLeft = column.plot.x + PLOT_INSET_X
  const graphRight = column.plot.x + column.plot.width - PLOT_INSET_X
  const graphBottom = column.plot.y + column.plot.height - PLOT_INSET_BOTTOM
  const graph = path(
    [
      makePoint(graphLeft, column.yBranchY),
      column.diagonalStart,
      column.diagonalEnd,
      makePoint(graphRight, column.uBranchY),
    ],
    'graph ordered-graph',
  )
  return [
    drawAxes(column),
    line(column.yThresholdX, column.plot.y + PLOT_INSET_TOP, column.yThresholdX, graphBottom, 'threshold'),
    line(column.uThresholdX, column.plot.y + PLOT_INSET_TOP, column.uThresholdX, graphBottom, 'threshold'),
    graph,
    line(column.yThresholdX, graphBottom - 7, column.yThresholdX, graphBottom + 7, 'tick'),
    line(column.uThresholdX, graphBottom - 7, column.uThresholdX, graphBottom + 7, 'tick'),
    `<text class="tick-label" x="${column.yThresholdX}" y="${graphBottom + 24}" text-anchor="middle">y</text>`,
    `<text class="tick-label" x="${column.uThresholdX}" y="${graphBottom + 24}" text-anchor="middle">u</text>`,
    drawPlotLabel(column.labels.low, 'plot-label-box'),
    drawPlotLabel(column.labels.mid, 'plot-label-box'),
    drawPlotLabel(column.labels.high, 'plot-label-box'),
    drawPlotLabel(column.labels.branch, 'branch-label-box'),
    drawPlotLabel(column.labels.collapse, 'branch-label-box'),
  ].join('\n')
}

function drawInvertedPlot(column: ColumnGeometry) {
  const graphLeft = column.plot.x + PLOT_INSET_X
  const graphRight = column.plot.x + column.plot.width - PLOT_INSET_X
  const graphBottom = column.plot.y + column.plot.height - PLOT_INSET_BOTTOM
  const graph = path([makePoint(graphLeft, column.yBranchY), makePoint(graphRight, column.yBranchY)], 'graph inverted-graph')
  return [
    drawAxes(column),
    line(column.uThresholdX, column.plot.y + PLOT_INSET_TOP, column.uThresholdX, graphBottom, 'threshold'),
    line(column.yThresholdX, column.plot.y + PLOT_INSET_TOP, column.yThresholdX, graphBottom, 'threshold'),
    graph,
    `<path class="empty-bracket" d="M ${column.uThresholdX + 16} ${graphBottom - 18} C ${column.uThresholdX + 64} ${graphBottom - 46}, ${column.yThresholdX - 64} ${graphBottom - 46}, ${column.yThresholdX - 16} ${graphBottom - 18}"/>`,
    `<text class="tick-label" x="${column.uThresholdX}" y="${graphBottom + 24}" text-anchor="middle">u</text>`,
    `<text class="tick-label" x="${column.yThresholdX}" y="${graphBottom + 24}" text-anchor="middle">y</text>`,
    drawPlotLabel(column.labels.low, 'plot-label-box'),
    drawPlotLabel(column.labels.mid, 'empty-label-box'),
    drawPlotLabel(column.labels.high, 'plot-label-box'),
    drawPlotLabel(column.labels.branch, 'branch-label-box'),
    drawPlotLabel(column.labels.collapse, 'branch-label-box strong'),
  ].join('\n')
}

function drawPlot(column: ColumnGeometry) {
  switch (column.kind) {
    case 'ordered':
      return drawOrderedPlot(column)
    case 'inverted':
      return drawInvertedPlot(column)
  }
}

function drawColumn(column: ColumnGeometry) {
  return [
    rect(column.panel, 'panel', 8),
    rect(column.title.box, 'reserved title-box', 6),
    rect(column.note.box, 'reserved note-box', 6),
    rect(column.plot, 'reserved plot-box', 6),
    rect(column.formula.box, 'reserved formula-box', 6),
    renderText(column.title),
    renderText(column.note),
    drawPlot(column),
    renderText(column.formula),
  ].join('\n')
}

export function renderDiagramSvg(geometry: DiagramGeometry) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.width}" height="${geometry.height}" viewBox="0 0 ${geometry.width} ${geometry.height}" role="img" aria-labelledby="title desc">
  <title id="title">Clamp identity domain condition diagram</title>
  <desc id="desc">A two-column diagram showing ordered and inverted clamp bounds for E equals x minus max of y and min of -x minus y and z.</desc>
  <style>
    :root { color-scheme: light; }
    svg { background: #fbfaf6; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .reserved { fill: #fffdf8; stroke: #c9bfae; stroke-width: 1.2; }
    .title-box { fill: #fff7df; stroke: #b78318; }
    .subtitle-box { fill: #f5fbff; stroke: #70a9c8; }
    .panel { fill: #f8f6f0; stroke: #6f7668; stroke-width: 1.5; }
    .note-box { fill: #ffffff; }
    .plot-box { fill: #fcfcfb; stroke: #a9b0a5; }
    .formula-box { fill: #eef7f1; stroke: #76a783; }
    .key-box { fill: #1f2a24; stroke: #1f2a24; }
    .axis, .tick { stroke: #343b35; stroke-width: 1.7; }
    .axis-arrow { fill: #343b35; }
    .threshold { stroke: #8d948a; stroke-width: 1.2; stroke-dasharray: 5 5; }
    .graph { fill: none; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
    .ordered-graph { stroke: #246b8f; }
    .inverted-graph { stroke: #a04452; }
    .empty-bracket { fill: none; stroke: #a04452; stroke-width: 2; stroke-dasharray: 4 4; }
    .plot-label-box { fill: #ffffff; stroke: #ccd2c8; }
    .empty-label-box { fill: #fff1f2; stroke: #ca7b86; }
    .branch-label-box { fill: #e9f4f8; stroke: #7aa8bd; }
    .branch-label-box.strong { fill: #fff0f2; stroke: #c76975; }
    text { fill: #1e261f; letter-spacing: 0; }
    .main-title { font-size: 26px; font-weight: 760; }
    .subtitle-text { font-size: 17px; font-weight: 540; }
    .column-title { font-size: 19px; font-weight: 720; }
    .note-text { font-size: 14px; font-weight: 520; }
    .formula-text { font-size: 14px; font-weight: 560; }
    .axis-label, .tick-label { font-size: 13px; font-weight: 650; }
    .plot-label { font-size: 12px; font-weight: 680; }
    .key-text { fill: #fffdf6; font-size: 17px; font-weight: 680; }
  </style>
  ${rect(geometry.title.box, 'reserved title-box', 8)}
  ${rect(geometry.subtitle.box, 'reserved subtitle-box', 8)}
  ${renderText(geometry.title)}
  ${renderText(geometry.subtitle)}
  ${drawColumn(geometry.left)}
  ${drawColumn(geometry.right)}
  ${rect(geometry.key.box, 'key-box', 8)}
  ${renderText(geometry.key.text)}
</svg>
`
}

await Bun.write(new URL('./diagram.svg', import.meta.url), renderDiagramSvg(createDiagramGeometry()))
