type Box = {
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

/** @fit
 * given width >= 0
 * given height >= 0
 * return.x == x
 * return.y == y
 * return.width == width
 * return.height == height
 * return.width >= 0
 * return.height >= 0
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
 * return.viewBox.width > 0
 * return.viewBox.height > 0
 * return.header.x >= return.viewBox.x
 * return.header.y >= return.viewBox.y
 * return.header.right <= return.viewBox.right
 * return.header.bottom <= return.orderedPanel.y
 * return.orderedPanel.x >= return.viewBox.x
 * return.orderedPanel.y >= return.viewBox.y
 * return.orderedPanel.right <= return.viewBox.right
 * return.orderedPanel.bottom <= return.viewBox.bottom
 * return.invertedPanel.x >= return.viewBox.x
 * return.invertedPanel.y >= return.viewBox.y
 * return.invertedPanel.right <= return.viewBox.right
 * return.invertedPanel.bottom <= return.viewBox.bottom
 * return.orderedPanel.right + return.panelGap <= return.invertedPanel.x
 * return.orderedPlot.x >= return.orderedPanel.x
 * return.orderedPlot.y >= return.orderedPanel.y
 * return.orderedPlot.right <= return.orderedPanel.right
 * return.orderedPlot.bottom <= return.orderedPanel.bottom
 * return.invertedPlot.x >= return.invertedPanel.x
 * return.invertedPlot.y >= return.invertedPanel.y
 * return.invertedPlot.right <= return.invertedPanel.right
 * return.invertedPlot.bottom <= return.invertedPanel.bottom
 * return.orderedLowerThresholdX < return.orderedUpperThresholdX
 * return.invertedUpperThresholdX < return.invertedLowerThresholdX
 * return.orderedLeftRegion.width >= 0
 * return.orderedMiddleRegion.width >= 0
 * return.orderedRightRegion.width >= 0
 * return.invertedInvalidGap.width >= 0
 * return.orderedLeftRegion.x == return.orderedPlot.x
 * return.orderedLeftRegion.right == return.orderedLowerThresholdX
 * return.orderedMiddleRegion.x == return.orderedLowerThresholdX
 * return.orderedMiddleRegion.right == return.orderedUpperThresholdX
 * return.orderedRightRegion.x == return.orderedUpperThresholdX
 * return.orderedRightRegion.right == return.orderedPlot.right
 * return.invertedInvalidGap.x == return.invertedUpperThresholdX
 * return.invertedInvalidGap.right == return.invertedLowerThresholdX
 * return.orderedTitle.x >= return.orderedPanel.x
 * return.orderedTitle.right <= return.orderedPanel.right
 * return.orderedAssumption.y >= return.orderedTitle.bottom
 * return.orderedAssumption.right <= return.orderedPanel.right
 * return.orderedAssumption.bottom <= return.orderedPlot.y
 * return.invertedTitle.x >= return.invertedPanel.x
 * return.invertedTitle.right <= return.invertedPanel.right
 * return.invertedAssumption.y >= return.invertedTitle.bottom
 * return.invertedAssumption.right <= return.invertedPanel.right
 * return.invertedAssumption.bottom <= return.invertedPlot.y
 * return.orderedLeftLabel.x >= return.orderedLeftRegion.x
 * return.orderedLeftLabel.right <= return.orderedLeftRegion.right
 * return.orderedLeftLabel.y >= return.orderedLeftRegion.y
 * return.orderedLeftLabel.bottom <= return.orderedLeftRegion.bottom
 * return.orderedMiddleLabel.x >= return.orderedMiddleRegion.x
 * return.orderedMiddleLabel.right <= return.orderedMiddleRegion.right
 * return.orderedMiddleLabel.y >= return.orderedMiddleRegion.y
 * return.orderedMiddleLabel.bottom <= return.orderedMiddleRegion.bottom
 * return.orderedRightLabel.x >= return.orderedRightRegion.x
 * return.orderedRightLabel.right <= return.orderedRightRegion.right
 * return.orderedRightLabel.y >= return.orderedRightRegion.y
 * return.orderedRightLabel.bottom <= return.orderedRightRegion.bottom
 * return.invertedDegenerateLabel.x >= return.invertedInvalidGap.x
 * return.invertedDegenerateLabel.right <= return.invertedInvalidGap.right
 * return.invertedDegenerateLabel.y >= return.invertedInvalidGap.y
 * return.invertedDegenerateLabel.bottom <= return.invertedInvalidGap.bottom
 * return.orderedLowerThresholdLabel.x >= return.orderedPanel.x
 * return.orderedLowerThresholdLabel.right <= return.orderedUpperThresholdLabel.x
 * return.orderedUpperThresholdLabel.right <= return.orderedPanel.right
 * return.orderedLowerThresholdLabel.y >= return.orderedPlot.bottom
 * return.orderedUpperThresholdLabel.y >= return.orderedPlot.bottom
 * return.invertedUpperThresholdLabel.x >= return.invertedPanel.x
 * return.invertedUpperThresholdLabel.right <= return.invertedLowerThresholdLabel.x
 * return.invertedLowerThresholdLabel.right <= return.invertedPanel.right
 * return.invertedUpperThresholdLabel.y >= return.invertedPlot.bottom
 * return.invertedLowerThresholdLabel.y >= return.invertedPlot.bottom
 * return.orderedPiecewise.y >= return.orderedLowerThresholdLabel.bottom
 * return.orderedPiecewise.x >= return.orderedPanel.x
 * return.orderedPiecewise.right <= return.orderedPanel.right
 * return.orderedPiecewise.bottom <= return.orderedPanel.bottom
 * return.invertedPiecewise.y >= return.invertedUpperThresholdLabel.bottom
 * return.invertedPiecewise.x >= return.invertedPanel.x
 * return.invertedPiecewise.right <= return.invertedPanel.right
 * return.invertedPiecewise.bottom <= return.invertedPanel.bottom
 */
export function buildClampGeometry() {
  const viewBox = box(0, 0, 1200, 760)
  const header = box(44, 20, 1112, 82)

  const panelGap = 60
  const orderedPanel = box(50, 126, 520, 584)
  const invertedPanel = box(630, 126, 520, 584)

  const orderedTitle = box(76, 150, 310, 26)
  const orderedAssumption = box(76, 184, 420, 44)
  const invertedTitle = box(656, 150, 330, 26)
  const invertedAssumption = box(656, 184, 436, 44)

  const orderedPlot = box(90, 256, 440, 180)
  const invertedPlot = box(670, 256, 440, 180)

  const orderedLowerThresholdX = 200
  const orderedUpperThresholdX = 400
  const invertedUpperThresholdX = 790
  const invertedLowerThresholdX = 1010

  const orderedLeftRegion = box(
    orderedPlot.x,
    orderedPlot.y,
    orderedLowerThresholdX - orderedPlot.x,
    orderedPlot.height,
  )
  const orderedMiddleRegion = box(
    orderedLowerThresholdX,
    orderedPlot.y,
    orderedUpperThresholdX - orderedLowerThresholdX,
    orderedPlot.height,
  )
  const orderedRightRegion = box(
    orderedUpperThresholdX,
    orderedPlot.y,
    orderedPlot.right - orderedUpperThresholdX,
    orderedPlot.height,
  )
  const invertedInvalidGap = box(
    invertedUpperThresholdX,
    invertedPlot.y,
    invertedLowerThresholdX - invertedUpperThresholdX,
    invertedPlot.height,
  )

  const orderedLeftLabel = box(110, 302, 74, 70)
  const orderedMiddleLabel = box(246, 298, 108, 78)
  const orderedRightLabel = box(414, 298, 98, 78)
  const invertedDegenerateLabel = box(820, 304, 160, 74)

  const orderedLowerThresholdLabel = box(160, 452, 80, 24)
  const orderedUpperThresholdLabel = box(348, 452, 112, 24)
  const invertedUpperThresholdLabel = box(728, 452, 124, 24)
  const invertedLowerThresholdLabel = box(988, 452, 78, 24)

  const orderedPiecewise = box(76, 520, 454, 158)
  const invertedPiecewise = box(656, 520, 454, 158)

  return {
    viewBox,
    header,
    panelGap,
    orderedPanel,
    invertedPanel,
    orderedTitle,
    orderedAssumption,
    invertedTitle,
    invertedAssumption,
    orderedPlot,
    invertedPlot,
    orderedLowerThresholdX,
    orderedUpperThresholdX,
    invertedUpperThresholdX,
    invertedLowerThresholdX,
    orderedLeftRegion,
    orderedMiddleRegion,
    orderedRightRegion,
    invertedInvalidGap,
    orderedLeftLabel,
    orderedMiddleLabel,
    orderedRightLabel,
    invertedDegenerateLabel,
    orderedLowerThresholdLabel,
    orderedUpperThresholdLabel,
    invertedUpperThresholdLabel,
    invertedLowerThresholdLabel,
    orderedPiecewise,
    invertedPiecewise,
  }
}

type ClampGeometry = ReturnType<typeof buildClampGeometry>

function attrs(boxValue: Box): string {
  return `x="${boxValue.x}" y="${boxValue.y}" width="${boxValue.width}" height="${boxValue.height}"`
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function textLine(x: number, y: number, value: string, className = ''): string {
  const classAttr = className === '' ? '' : ` class="${className}"`
  return `<text${classAttr} x="${x}" y="${y}">${escapeText(value)}</text>`
}

function centeredText(boxValue: Box, lines: string[], className = 'label'): string {
  const lineHeight = 17
  const firstY = boxValue.y + (boxValue.height - lineHeight * (lines.length - 1)) / 2 + 5
  const x = boxValue.x + boxValue.width / 2
  return lines
    .map((line, index) => `<text class="${className}" x="${x}" y="${firstY + index * lineHeight}" text-anchor="middle">${escapeText(line)}</text>`)
    .join('\n')
}

function panelChrome(panel: Box, title: Box, assumption: Box, accent: string, titleLines: string[], assumptionLines: string[]): string {
  return `
    <rect class="panel" ${attrs(panel)} rx="8"/>
    <rect x="${panel.x}" y="${panel.y}" width="8" height="${panel.height}" fill="${accent}"/>
    ${centeredText(title, titleLines, 'panel-title')}
    ${centeredText(assumption, assumptionLines, 'panel-note')}
  `
}

function swatch(x: number, y: number, fill: string, pattern: string): string {
  return `<rect class="swatch" x="${x}" y="${y}" width="18" height="18" fill="${fill}"/><rect class="swatch-pattern" x="${x}" y="${y}" width="18" height="18" fill="url(#${pattern})"/>`
}

export function renderSvg(geometry: ClampGeometry): string {
  const g = geometry
  const orderedAxisY = g.orderedPlot.bottom + 18
  const invertedAxisY = g.invertedPlot.bottom + 18

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${g.viewBox.x} ${g.viewBox.y} ${g.viewBox.width} ${g.viewBox.height}" role="img" aria-labelledby="title desc">
  <title id="title">Clamp-shaped min/max reduction diagram</title>
  <desc id="desc">A geometric SVG showing ordered and inverted threshold cases for reducing E to a clamp-shaped expression.</desc>
  <defs>
    <pattern id="diag-hatch" width="8" height="8" patternUnits="userSpaceOnUse">
      <path d="M-2 8 L8 -2 M2 10 L10 2" stroke="#2563eb" stroke-width="1.4" opacity="0.55"/>
    </pattern>
    <pattern id="dot-grid" width="10" height="10" patternUnits="userSpaceOnUse">
      <circle cx="2.5" cy="2.5" r="1.4" fill="#166534" opacity="0.65"/>
    </pattern>
    <pattern id="vertical-stripe" width="8" height="8" patternUnits="userSpaceOnUse">
      <path d="M2 0 V8 M6 0 V8" stroke="#a16207" stroke-width="1.2" opacity="0.6"/>
    </pattern>
    <pattern id="cross-hatch" width="9" height="9" patternUnits="userSpaceOnUse">
      <path d="M0 0 L9 9 M9 0 L0 9" stroke="#be123c" stroke-width="1.1" opacity="0.6"/>
    </pattern>
  </defs>
  <style>
    svg { background: #f8fafc; color: #111827; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .headline { font-size: 20px; font-weight: 750; fill: #111827; }
    .subline { font-size: 15px; fill: #374151; }
    .panel { fill: #ffffff; stroke: #cbd5e1; stroke-width: 1.5; }
    .panel-title { font-size: 18px; font-weight: 750; fill: #0f172a; }
    .panel-note { font-size: 13.5px; fill: #334155; }
    .plot-frame { fill: none; stroke: #64748b; stroke-width: 1.4; }
    .threshold { stroke: #111827; stroke-width: 2; stroke-dasharray: 6 5; }
    .axis { stroke: #334155; stroke-width: 1.8; marker-end: url(#axis-arrow); }
    .axis-label { font-size: 14px; font-weight: 650; fill: #111827; }
    .label-chip { fill: rgba(255, 255, 255, 0.9); stroke: rgba(15, 23, 42, 0.22); stroke-width: 1; rx: 6; }
    .label { font-size: 13px; font-weight: 700; fill: #111827; }
    .threshold-label { font-size: 13px; font-weight: 700; fill: #111827; }
    .piecewise-title { font-size: 14px; font-weight: 750; fill: #111827; }
    .piecewise { font-size: 13px; fill: #1f2937; }
    .formula { font-size: 15px; fill: #111827; }
    .swatch { stroke: #475569; stroke-width: 0.8; }
    .swatch-pattern { stroke: none; }
    .invalid-note { font-size: 12.5px; font-weight: 700; fill: #881337; }
  </style>
  <defs>
    <marker id="axis-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 Z" fill="#334155"/>
    </marker>
  </defs>

  <g>
    ${textLine(g.header.x, g.header.y + 24, 'Geometry of the clamp-shaped reduction', 'headline')}
    ${textLine(g.header.x, g.header.y + 52, 'E = x + min(-y, y + max(x, -z - y)) = x - max(y, min(-x - y, z))', 'formula')}
    ${textLine(g.header.x, g.header.y + 76, 'It is x - clamp(y, z, -x - y) only under the ordered-bound assumption y <= -x - y.', 'subline')}
  </g>

  ${panelChrome(
    g.orderedPanel,
    g.orderedTitle,
    g.orderedAssumption,
    '#2563eb',
    ['Ordered bounds'],
    ['y <= -x - y, equivalently x + 2y <= 0', 'lower threshold y comes before upper -x-y'],
  )}

  <g>
    <rect ${attrs(g.orderedLeftRegion)} fill="#dbeafe"/>
    <rect ${attrs(g.orderedLeftRegion)} fill="url(#diag-hatch)"/>
    <rect ${attrs(g.orderedMiddleRegion)} fill="#dcfce7"/>
    <rect ${attrs(g.orderedMiddleRegion)} fill="url(#dot-grid)"/>
    <rect ${attrs(g.orderedRightRegion)} fill="#fef3c7"/>
    <rect ${attrs(g.orderedRightRegion)} fill="url(#vertical-stripe)"/>
    <rect class="plot-frame" ${attrs(g.orderedPlot)}/>
    <line class="threshold" x1="${g.orderedLowerThresholdX}" y1="${g.orderedPlot.y}" x2="${g.orderedLowerThresholdX}" y2="${g.orderedPlot.bottom}"/>
    <line class="threshold" x1="${g.orderedUpperThresholdX}" y1="${g.orderedPlot.y}" x2="${g.orderedUpperThresholdX}" y2="${g.orderedPlot.bottom}"/>
    <line class="axis" x1="${g.orderedPlot.x}" y1="${orderedAxisY}" x2="${g.orderedPlot.right}" y2="${orderedAxisY}"/>
    ${textLine(g.orderedPlot.right - 8, orderedAxisY + 24, 'z', 'axis-label')}
    <rect class="label-chip" ${attrs(g.orderedLeftLabel)}/>
    ${centeredText(g.orderedLeftLabel, ['z < y', 'inner = y', 'E = x - y'])}
    <rect class="label-chip" ${attrs(g.orderedMiddleLabel)}/>
    ${centeredText(g.orderedMiddleLabel, ['y <= z <= -x-y', 'inner = z', 'E = x - z'])}
    <rect class="label-chip" ${attrs(g.orderedRightLabel)}/>
    ${centeredText(g.orderedRightLabel, ['z > -x-y', 'inner = -x-y', 'E = 2x + y'])}
    ${centeredText(g.orderedLowerThresholdLabel, ['y'], 'threshold-label')}
    ${centeredText(g.orderedUpperThresholdLabel, ['-x - y'], 'threshold-label')}
  </g>

  <g>
    <rect class="label-chip" ${attrs(g.orderedPiecewise)}/>
    ${textLine(g.orderedPiecewise.x + 18, g.orderedPiecewise.y + 25, 'Ordered piecewise result', 'piecewise-title')}
    ${swatch(g.orderedPiecewise.x + 20, g.orderedPiecewise.y + 42, '#dbeafe', 'diag-hatch')}
    ${textLine(g.orderedPiecewise.x + 48, g.orderedPiecewise.y + 56, 'z < y: inner = y, so E = x - y', 'piecewise')}
    ${swatch(g.orderedPiecewise.x + 20, g.orderedPiecewise.y + 72, '#dcfce7', 'dot-grid')}
    ${textLine(g.orderedPiecewise.x + 48, g.orderedPiecewise.y + 86, 'y <= z <= -x-y: inner = z, so E = x - z', 'piecewise')}
    ${swatch(g.orderedPiecewise.x + 20, g.orderedPiecewise.y + 102, '#fef3c7', 'vertical-stripe')}
    ${textLine(g.orderedPiecewise.x + 48, g.orderedPiecewise.y + 116, 'z > -x-y: inner = -x-y, so E = 2x + y', 'piecewise')}
    ${textLine(g.orderedPiecewise.x + 20, g.orderedPiecewise.y + 146, 'Honest clamp form here: x - clamp(y, z, -x-y).', 'piecewise')}
  </g>

  ${panelChrome(
    g.invertedPanel,
    g.invertedTitle,
    g.invertedAssumption,
    '#be123c',
    ['Inverted bounds'],
    ['y > -x - y, equivalently x + 2y > 0', 'upper threshold -x-y is below lower threshold y'],
  )}

  <g>
    <rect ${attrs(g.invertedPlot)} fill="#e0f2fe"/>
    <rect ${attrs(g.invertedInvalidGap)} fill="#ffe4e6"/>
    <rect ${attrs(g.invertedInvalidGap)} fill="url(#cross-hatch)"/>
    <rect class="plot-frame" ${attrs(g.invertedPlot)}/>
    <line class="threshold" x1="${g.invertedUpperThresholdX}" y1="${g.invertedPlot.y}" x2="${g.invertedUpperThresholdX}" y2="${g.invertedPlot.bottom}"/>
    <line class="threshold" x1="${g.invertedLowerThresholdX}" y1="${g.invertedPlot.y}" x2="${g.invertedLowerThresholdX}" y2="${g.invertedPlot.bottom}"/>
    <line class="axis" x1="${g.invertedPlot.x}" y1="${invertedAxisY}" x2="${g.invertedPlot.right}" y2="${invertedAxisY}"/>
    ${textLine(g.invertedPlot.right - 8, invertedAxisY + 24, 'z', 'axis-label')}
    <rect class="label-chip" ${attrs(g.invertedDegenerateLabel)}/>
    ${centeredText(g.invertedDegenerateLabel, ['for every z', 'inner = y', 'E = x - y'])}
    ${centeredText(g.invertedUpperThresholdLabel, ['-x - y (upper)'], 'threshold-label')}
    ${centeredText(g.invertedLowerThresholdLabel, ['y (lower)'], 'threshold-label')}
    ${textLine(g.invertedInvalidGap.x + 18, g.invertedInvalidGap.y + 26, 'invalid clamp interval', 'invalid-note')}
  </g>

  <g>
    <rect class="label-chip" ${attrs(g.invertedPiecewise)}/>
    ${textLine(g.invertedPiecewise.x + 18, g.invertedPiecewise.y + 25, 'Degenerate clamp-shaped term', 'piecewise-title')}
    ${textLine(g.invertedPiecewise.x + 20, g.invertedPiecewise.y + 56, 'max(y, min(z, -x-y)) = y for all z.', 'piecewise')}
    ${textLine(g.invertedPiecewise.x + 20, g.invertedPiecewise.y + 86, 'Therefore E = x - y.', 'piecewise')}
    ${textLine(g.invertedPiecewise.x + 20, g.invertedPiecewise.y + 116, 'This is clamp-shaped, but not a valid ordered clamp.', 'piecewise')}
    ${textLine(g.invertedPiecewise.x + 20, g.invertedPiecewise.y + 146, 'The crossed band marks upper < lower.', 'piecewise')}
  </g>
</svg>
`
}

await Bun.write(new URL('diagram.svg', import.meta.url), renderSvg(buildClampGeometry()))
