export type Rect = {
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

export type Axis = {
  x1: number
  y1: number
  x2: number
  y2: number
  arrowTipX: number
  arrowTipY: number
}

export type Threshold = {
  x: number
  top: number
  bottom: number
  labelBox: Rect
}

export type OrderedCaseGeometry = {
  panel: Rect
  titleBox: Rect
  plot: Rect
  axis: Axis
  thresholds: {
    lowerY: Threshold
    upperNegXMinusY: Threshold
  }
  regions: {
    belowY: Rect
    between: Rect
    aboveUpper: Rect
  }
  labels: {
    belowY: Rect
    between: Rect
    aboveUpper: Rect
    clampNote: Rect
    resultNote: Rect
  }
}

export type InvertedCaseGeometry = {
  panel: Rect
  titleBox: Rect
  plot: Rect
  axis: Axis
  thresholds: {
    upperNegXMinusY: Threshold
    lowerY: Threshold
  }
  regions: {
    degenerate: Rect
    invertedGap: Rect
  }
  labels: {
    degeneration: Rect
    thresholdNote: Rect
    resultNote: Rect
  }
}

export type DiagramGeometry = {
  viewBox: Rect
  formulaBox: Rect
  ordered: OrderedCaseGeometry
  inverted: InvertedCaseGeometry
}

/** @fit
 * given width: 0..2000
 * given height: 0..2000
 * return.x == x
 * return.y == y
 * return.width == width
 * return.height == height
 * return.right == x + width
 * return.bottom == y + height
 * return.right >= return.x
 * return.bottom >= return.y
 */
export function rect(x: number, y: number, width: number, height: number): Rect {
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
 * given x1 <= x2
 * return.x1 == x1
 * return.x2 == x2
 * return.y1 == y
 * return.y2 == y
 * return.arrowTipX == x2
 * return.arrowTipY == y
 * return.x1 <= return.x2
 */
export function horizontalAxis(x1: number, x2: number, y: number): Axis {
  return {
    x1,
    y1: y,
    x2,
    y2: y,
    arrowTipX: x2,
    arrowTipY: y,
  }
}

/** @fit
 * return.viewBox.x == 0
 * return.viewBox.y == 0
 * return.formulaBox.x >= return.viewBox.x
 * return.formulaBox.y >= return.viewBox.y
 * return.formulaBox.right <= return.viewBox.right
 * return.formulaBox.bottom <= return.ordered.panel.y
 * return.formulaBox.bottom <= return.inverted.panel.y
 * return.ordered.panel.x >= return.viewBox.x
 * return.ordered.panel.y >= return.viewBox.y
 * return.ordered.panel.right <= return.viewBox.right
 * return.ordered.panel.bottom <= return.viewBox.bottom
 * return.inverted.panel.x >= return.viewBox.x
 * return.inverted.panel.y >= return.viewBox.y
 * return.inverted.panel.right <= return.viewBox.right
 * return.inverted.panel.bottom <= return.viewBox.bottom
 * return.ordered.panel.right <= return.inverted.panel.x
 * return.ordered.titleBox.x >= return.ordered.panel.x
 * return.ordered.titleBox.y >= return.ordered.panel.y
 * return.ordered.titleBox.right <= return.ordered.panel.right
 * return.ordered.titleBox.bottom <= return.ordered.plot.y
 * return.inverted.titleBox.x >= return.inverted.panel.x
 * return.inverted.titleBox.y >= return.inverted.panel.y
 * return.inverted.titleBox.right <= return.inverted.panel.right
 * return.inverted.titleBox.bottom <= return.inverted.plot.y
 * return.ordered.plot.x >= return.ordered.panel.x
 * return.ordered.plot.y >= return.ordered.panel.y
 * return.ordered.plot.right <= return.ordered.panel.right
 * return.ordered.plot.bottom <= return.ordered.panel.bottom
 * return.inverted.plot.x >= return.inverted.panel.x
 * return.inverted.plot.y >= return.inverted.panel.y
 * return.inverted.plot.right <= return.inverted.panel.right
 * return.inverted.plot.bottom <= return.inverted.panel.bottom
 * return.ordered.thresholds.lowerY.x < return.ordered.thresholds.upperNegXMinusY.x
 * return.inverted.thresholds.upperNegXMinusY.x < return.inverted.thresholds.lowerY.x
 * return.ordered.regions.belowY.width >= 0
 * return.ordered.regions.between.width >= 0
 * return.ordered.regions.aboveUpper.width >= 0
 * return.inverted.regions.degenerate.width >= 0
 * return.inverted.regions.invertedGap.width >= 0
 * return.ordered.regions.belowY.x == return.ordered.plot.x
 * return.ordered.regions.belowY.right == return.ordered.thresholds.lowerY.x
 * return.ordered.regions.between.x == return.ordered.thresholds.lowerY.x
 * return.ordered.regions.between.right == return.ordered.thresholds.upperNegXMinusY.x
 * return.ordered.regions.aboveUpper.x == return.ordered.thresholds.upperNegXMinusY.x
 * return.ordered.regions.aboveUpper.right == return.ordered.plot.right
 * return.inverted.regions.degenerate.x == return.inverted.plot.x
 * return.inverted.regions.degenerate.right == return.inverted.plot.right
 * return.inverted.regions.invertedGap.x == return.inverted.thresholds.upperNegXMinusY.x
 * return.inverted.regions.invertedGap.right == return.inverted.thresholds.lowerY.x
 * return.ordered.labels.belowY.x >= return.ordered.regions.belowY.x
 * return.ordered.labels.belowY.right <= return.ordered.regions.belowY.right
 * return.ordered.labels.belowY.y >= return.ordered.regions.belowY.y
 * return.ordered.labels.belowY.bottom <= return.ordered.regions.belowY.bottom
 * return.ordered.labels.between.x >= return.ordered.regions.between.x
 * return.ordered.labels.between.right <= return.ordered.regions.between.right
 * return.ordered.labels.between.y >= return.ordered.regions.between.y
 * return.ordered.labels.between.bottom <= return.ordered.regions.between.bottom
 * return.ordered.labels.aboveUpper.x >= return.ordered.regions.aboveUpper.x
 * return.ordered.labels.aboveUpper.right <= return.ordered.regions.aboveUpper.right
 * return.ordered.labels.aboveUpper.y >= return.ordered.regions.aboveUpper.y
 * return.ordered.labels.aboveUpper.bottom <= return.ordered.regions.aboveUpper.bottom
 * return.ordered.labels.belowY.right <= return.ordered.labels.between.x
 * return.ordered.labels.between.right <= return.ordered.labels.aboveUpper.x
 * return.ordered.thresholds.lowerY.labelBox.right <= return.ordered.thresholds.upperNegXMinusY.labelBox.x
 * return.inverted.thresholds.upperNegXMinusY.labelBox.right <= return.inverted.thresholds.lowerY.labelBox.x
 * return.ordered.axis.x1 >= return.ordered.plot.x
 * return.ordered.axis.x2 <= return.ordered.plot.right
 * return.ordered.axis.y1 >= return.ordered.plot.bottom
 * return.ordered.axis.y1 <= return.ordered.panel.bottom
 * return.inverted.axis.x1 >= return.inverted.plot.x
 * return.inverted.axis.x2 <= return.inverted.plot.right
 * return.inverted.axis.y1 >= return.inverted.plot.bottom
 * return.inverted.axis.y1 <= return.inverted.panel.bottom
 * return.ordered.labels.clampNote.x >= return.ordered.panel.x
 * return.ordered.labels.clampNote.right <= return.ordered.panel.right
 * return.ordered.labels.clampNote.y >= return.ordered.axis.y1
 * return.ordered.labels.clampNote.bottom <= return.ordered.labels.resultNote.y
 * return.ordered.labels.resultNote.x >= return.ordered.panel.x
 * return.ordered.labels.resultNote.right <= return.ordered.panel.right
 * return.ordered.labels.resultNote.bottom <= return.ordered.panel.bottom
 * return.inverted.labels.degeneration.x >= return.inverted.panel.x
 * return.inverted.labels.degeneration.right <= return.inverted.panel.right
 * return.inverted.labels.degeneration.y >= return.inverted.axis.y1
 * return.inverted.labels.degeneration.bottom <= return.inverted.labels.thresholdNote.y
 * return.inverted.labels.thresholdNote.x >= return.inverted.panel.x
 * return.inverted.labels.thresholdNote.right <= return.inverted.panel.right
 * return.inverted.labels.thresholdNote.bottom <= return.inverted.labels.resultNote.y
 * return.inverted.labels.resultNote.x >= return.inverted.panel.x
 * return.inverted.labels.resultNote.right <= return.inverted.panel.right
 * return.inverted.labels.resultNote.bottom <= return.inverted.panel.bottom
 */
export function createDiagramGeometry(): DiagramGeometry {
  const viewBox = rect(0, 0, 1120, 760)
  const formulaBox = rect(48, 20, 1024, 96)

  const panelY = 140
  const panelHeight = 580
  const orderedPanelX = 36
  const orderedPanelWidth = 660
  const invertedPanelX = 730
  const invertedPanelWidth = 354

  const orderedPanel = rect(orderedPanelX, panelY, orderedPanelWidth, panelHeight)
  const invertedPanel = rect(invertedPanelX, panelY, invertedPanelWidth, panelHeight)

  const orderedTitleBox = rect(62, 158, 600, 58)
  const invertedTitleBox = rect(752, 158, 308, 58)

  const plotY = 280
  const plotHeight = 132
  const orderedPlotX = orderedPanelX + 34
  const orderedPlotWidth = orderedPanelWidth - 70
  const invertedPlotX = invertedPanelX + 34
  const invertedPlotWidth = invertedPanelWidth - 68

  const orderedPlot = rect(orderedPlotX, plotY, orderedPlotWidth, plotHeight)
  const invertedPlot = rect(invertedPlotX, plotY, invertedPlotWidth, plotHeight)

  const orderedLowerX = orderedPlotX + 160
  const orderedUpperX = orderedPlotX + 420
  const invertedUpperX = invertedPlotX + 88
  const invertedLowerX = invertedPlotX + 198

  const orderedBelowY = rect(orderedPlot.x, orderedPlot.y, orderedLowerX - orderedPlot.x, orderedPlot.height)
  const orderedBetween = rect(orderedLowerX, orderedPlot.y, orderedUpperX - orderedLowerX, orderedPlot.height)
  const orderedAboveUpper = rect(orderedUpperX, orderedPlot.y, orderedPlot.right - orderedUpperX, orderedPlot.height)

  const invertedDegenerate = rect(invertedPlot.x, invertedPlot.y, invertedPlot.width, invertedPlot.height)
  const invertedGap = rect(invertedUpperX, invertedPlot.y, invertedLowerX - invertedUpperX, invertedPlot.height)

  const orderedAxis = horizontalAxis(orderedPlot.x, orderedPlot.right, orderedPlot.bottom + 28)
  const invertedAxis = horizontalAxis(invertedPlot.x, invertedPlot.right, invertedPlot.bottom + 28)

  const orderedLowerThreshold = {
    x: orderedLowerX,
    top: orderedPlot.y,
    bottom: orderedPlot.bottom,
    labelBox: rect(orderedLowerX - 24, orderedAxis.y1 + 16, 48, 22),
  }
  const orderedUpperThreshold = {
    x: orderedUpperX,
    top: orderedPlot.y,
    bottom: orderedPlot.bottom,
    labelBox: rect(orderedUpperX - 58, orderedAxis.y1 + 16, 116, 22),
  }
  const invertedUpperThreshold = {
    x: invertedUpperX,
    top: invertedPlot.y,
    bottom: invertedPlot.bottom,
    labelBox: rect(invertedUpperX - 58, invertedAxis.y1 + 16, 116, 22),
  }
  const invertedLowerThreshold = {
    x: invertedLowerX,
    top: invertedPlot.y,
    bottom: invertedPlot.bottom,
    labelBox: rect(invertedLowerX - 24, invertedAxis.y1 + 16, 48, 22),
  }

  return {
    viewBox,
    formulaBox,
    ordered: {
      panel: orderedPanel,
      titleBox: orderedTitleBox,
      plot: orderedPlot,
      axis: orderedAxis,
      thresholds: {
        lowerY: orderedLowerThreshold,
        upperNegXMinusY: orderedUpperThreshold,
      },
      regions: {
        belowY: orderedBelowY,
        between: orderedBetween,
        aboveUpper: orderedAboveUpper,
      },
      labels: {
        belowY: rect(88, 316, 122, 62),
        between: rect(250, 314, 220, 66),
        aboveUpper: rect(512, 316, 126, 62),
        clampNote: rect(74, 500, 584, 70),
        resultNote: rect(74, 590, 584, 78),
      },
    },
    inverted: {
      panel: invertedPanel,
      titleBox: invertedTitleBox,
      plot: invertedPlot,
      axis: invertedAxis,
      thresholds: {
        upperNegXMinusY: invertedUpperThreshold,
        lowerY: invertedLowerThreshold,
      },
      regions: {
        degenerate: invertedDegenerate,
        invertedGap,
      },
      labels: {
        degeneration: rect(760, 500, 300, 58),
        thresholdNote: rect(760, 574, 300, 46),
        resultNote: rect(760, 640, 300, 46),
      },
    },
  }
}

export const diagramGeometry = createDiagramGeometry()

function attrs(values: Record<string, string | number>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')
}

function rectElement(box: Rect, extra: Record<string, string | number> = {}) {
  return `<rect ${attrs({x: box.x, y: box.y, width: box.width, height: box.height, ...extra})}/>`
}

function escapeText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function textLines(x: number, y: number, lines: string[], className: string, lineHeight = 18) {
  const [first, ...rest] = lines
  const tspans = [`<tspan x="${x}" y="${y}">${escapeText(first ?? '')}</tspan>`]
  for (let i = 0; i < rest.length; i++) {
    tspans.push(`<tspan x="${x}" dy="${lineHeight}">${escapeText(rest[i] ?? '')}</tspan>`)
  }
  return `<text class="${className}">${tspans.join('')}</text>`
}

function labelBox(box: Rect, lines: string[], className = 'label') {
  const textX = box.x + 12
  const textY = box.y + 20
  return [
    rectElement(box, {class: 'label-bg'}),
    textLines(textX, textY, lines, className),
  ].join('\n')
}

function thresholdLine(threshold: Threshold, className: string) {
  return `<line class="${className}" x1="${threshold.x}" y1="${threshold.top}" x2="${threshold.x}" y2="${threshold.bottom}"/>`
}

function axisElement(axis: Axis) {
  return [
    `<line class="axis" x1="${axis.x1}" y1="${axis.y1}" x2="${axis.x2}" y2="${axis.y2}"/>`,
    `<path class="axis" d="M ${axis.arrowTipX} ${axis.arrowTipY} l -9 -5 v 10 Z"/>`,
  ].join('\n')
}

export function renderDiagramSvg(g: DiagramGeometry = diagramGeometry) {
  const {ordered, inverted} = g

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${g.viewBox.x} ${g.viewBox.y} ${g.viewBox.width} ${g.viewBox.height}" role="img" aria-labelledby="title desc">
  <title id="title">Geometric min/max/clamp-shaped reduction</title>
  <desc id="desc">Two panels compare ordered and inverted bounds for the expression E = x - max(y, min(z, -x-y)).</desc>
  <defs>
    <pattern id="leftHatch" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="#cfe8ff"/>
      <path d="M 0 10 L 10 0" stroke="#72a9d9" stroke-width="1.2"/>
    </pattern>
    <pattern id="middleDots" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="#d9f3dc"/>
      <circle cx="5" cy="5" r="1.4" fill="#68a875"/>
    </pattern>
    <pattern id="rightHatch" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="#fde7b6"/>
      <path d="M 0 0 L 10 10 M 10 0 L 0 10" stroke="#d09b36" stroke-width="1"/>
    </pattern>
    <pattern id="degenerateLines" width="9" height="9" patternUnits="userSpaceOnUse">
      <rect width="9" height="9" fill="#f3d2d0"/>
      <path d="M 0 4.5 H 9" stroke="#c77772" stroke-width="1.2"/>
    </pattern>
    <pattern id="gapHatch" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="#ffffff" opacity="0.35"/>
      <path d="M -1 9 L 9 -1" stroke="#9a5752" stroke-width="1"/>
    </pattern>
  </defs>
  <style>
    .page { fill: #fbfaf7; }
    .formula-bg { fill: #ffffff; stroke: #d9d2c7; stroke-width: 1.5; }
    .panel { fill: #ffffff; stroke: #2f3844; stroke-width: 1.6; rx: 8; }
    .ordered-panel { stroke: #31618f; }
    .inverted-panel { stroke: #93463f; }
    .title { fill: #18212b; font: 700 23px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #44505f; font: 500 15px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .formula { fill: #18212b; font: 500 21px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .small-formula { fill: #18212b; font: 600 15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .note { fill: #2c3440; font: 500 14px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label { fill: #1f2833; font: 650 15px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label-small { fill: #1f2833; font: 650 13px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label-bg { fill: rgba(255,255,255,0.88); stroke: rgba(47,56,68,0.22); stroke-width: 1; rx: 6; }
    .plot-frame { fill: none; stroke: #26313d; stroke-width: 1.4; }
    .threshold { stroke: #26313d; stroke-width: 2.2; stroke-dasharray: 5 5; }
    .threshold-hot { stroke: #8f302a; stroke-width: 2.2; stroke-dasharray: 5 5; }
    .separator { stroke: rgba(38,49,61,0.4); stroke-width: 1.1; }
    .axis { stroke: #26313d; fill: #26313d; stroke-width: 1.6; }
    .tick-label { fill: #18212b; font: 700 15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .brace { fill: none; stroke: #8f302a; stroke-width: 1.8; }
  </style>

  ${rectElement(g.viewBox, {class: 'page'})}
  ${rectElement(g.formulaBox, {class: 'formula-bg', rx: 10})}
  ${textLines(68, 50, [
    'E = x + min(-y, y + max(x, -z - y))',
    '= x - max(y, min(-x - y, z))',
    '= x - clamp(z; lower y, upper -x-y) only when y <= -x-y',
  ], 'formula', 28)}

  ${rectElement(ordered.panel, {class: 'panel ordered-panel'})}
  ${rectElement(inverted.panel, {class: 'panel inverted-panel'})}

  ${textLines(ordered.titleBox.x, ordered.titleBox.y + 24, [
    'Ordered bounds',
    'y <= -x-y, equivalently x + 2y <= 0',
  ], 'title', 24)}
  ${textLines(inverted.titleBox.x, inverted.titleBox.y + 24, [
    'Inverted bounds',
    'y > -x-y, equivalently x + 2y > 0',
  ], 'title', 24)}

  ${rectElement(ordered.regions.belowY, {fill: 'url(#leftHatch)'})}
  ${rectElement(ordered.regions.between, {fill: 'url(#middleDots)'})}
  ${rectElement(ordered.regions.aboveUpper, {fill: 'url(#rightHatch)'})}
  ${rectElement(ordered.plot, {class: 'plot-frame'})}
  ${thresholdLine(ordered.thresholds.lowerY, 'threshold')}
  ${thresholdLine(ordered.thresholds.upperNegXMinusY, 'threshold')}
  <line class="separator" x1="${ordered.regions.belowY.right}" y1="${ordered.plot.y}" x2="${ordered.regions.belowY.right}" y2="${ordered.plot.bottom}"/>
  <line class="separator" x1="${ordered.regions.between.right}" y1="${ordered.plot.y}" x2="${ordered.regions.between.right}" y2="${ordered.plot.bottom}"/>
  ${labelBox(ordered.labels.belowY, ['z < y', 'inner = y', 'E = x - y'], 'label-small')}
  ${labelBox(ordered.labels.between, ['y <= z <= -x-y', 'inner = z', 'E = x - z'], 'label')}
  ${labelBox(ordered.labels.aboveUpper, ['z > -x-y', 'inner = -x-y', 'E = 2x + y'], 'label-small')}
  ${axisElement(ordered.axis)}
  <text class="tick-label" x="${ordered.thresholds.lowerY.labelBox.x + 18}" y="${ordered.thresholds.lowerY.labelBox.y + 16}">y</text>
  <text class="tick-label" x="${ordered.thresholds.upperNegXMinusY.labelBox.x + 9}" y="${ordered.thresholds.upperNegXMinusY.labelBox.y + 16}">-x-y</text>
  <text class="subtitle" x="${ordered.axis.x2 - 14}" y="${ordered.axis.y1 + 29}">z</text>
  ${labelBox(ordered.labels.clampNote, [
    'The middle term is an honest clamp only here:',
    'max(y, min(z, -x-y)) = clamp(z; y, -x-y).',
  ], 'note')}
  ${labelBox(ordered.labels.resultNote, [
    'Therefore E has three visible pieces:',
    'x - y, then x - z, then 2x + y.',
  ], 'note')}

  ${rectElement(inverted.regions.degenerate, {fill: 'url(#degenerateLines)'})}
  ${rectElement(inverted.regions.invertedGap, {fill: 'url(#gapHatch)'})}
  ${rectElement(inverted.plot, {class: 'plot-frame'})}
  ${thresholdLine(inverted.thresholds.upperNegXMinusY, 'threshold-hot')}
  ${thresholdLine(inverted.thresholds.lowerY, 'threshold-hot')}
  <path class="brace" d="M ${inverted.thresholds.upperNegXMinusY.x} ${inverted.plot.y - 16} C ${inverted.thresholds.upperNegXMinusY.x + 18} ${inverted.plot.y - 30}, ${inverted.thresholds.lowerY.x - 18} ${inverted.plot.y - 30}, ${inverted.thresholds.lowerY.x} ${inverted.plot.y - 16}"/>
  <text class="note" x="${inverted.thresholds.upperNegXMinusY.x + 9}" y="${inverted.plot.y - 34}">no ordered clamp interval</text>
  ${axisElement(inverted.axis)}
  <text class="tick-label" x="${inverted.thresholds.upperNegXMinusY.labelBox.x + 9}" y="${inverted.thresholds.upperNegXMinusY.labelBox.y + 16}">-x-y</text>
  <text class="tick-label" x="${inverted.thresholds.lowerY.labelBox.x + 18}" y="${inverted.thresholds.lowerY.labelBox.y + 16}">y</text>
  <text class="subtitle" x="${inverted.axis.x2 - 14}" y="${inverted.axis.y1 + 29}">z</text>
  ${labelBox(inverted.labels.degeneration, [
    'Clamp-shaped, but degenerate:',
    'min(z, -x-y) <= -x-y < y,',
    'so max(y, min(z, -x-y)) = y.',
  ], 'note')}
  ${labelBox(inverted.labels.thresholdNote, [
    'The would-be upper threshold is',
    'left of the lower threshold.',
  ], 'note')}
  ${labelBox(inverted.labels.resultNote, [
    'For every z region:',
    'E = x - y.',
  ], 'note')}
</svg>
`
}

export const diagramSvg = renderDiagramSvg(diagramGeometry)
