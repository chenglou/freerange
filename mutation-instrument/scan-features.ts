// The triage's mechanism features (plan-a/triage-m2-m4/scan.ts `features`), boolean features only, for the entries with
// off-list rows in m2-m4. findings.tsv counts, per row, the firing inputs where each feature is true, e.g. how many of
// packRows' geometry:71 firings have gapY 0.
import {maxMagnitude, type Value} from './domain.ts'

function field(value: Value, name: string): Value {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value[name] : undefined
}

function numberField(value: Value, name: string): number {
  const found = field(value, name)
  return typeof found === 'number' ? found : NaN
}

function elements(value: Value): Value[] {
  return Array.isArray(value) ? value : []
}

function corridor(exit: Value, anchor: Value, panel: Value): Record<string, boolean> {
  const anchorX = numberField(anchor, 'x')
  const anchorY = numberField(anchor, 'y')
  const anchorWidth = numberField(anchor, 'width')
  const anchorHeight = numberField(anchor, 'height')
  const panelX = numberField(panel, 'x')
  const panelY = numberField(panel, 'y')
  const panelWidth = numberField(panel, 'width')
  const panelHeight = numberField(panel, 'height')
  const panelRight = panelX >= anchorX + anchorWidth
  const panelLeft = panelX + panelWidth <= anchorX
  const panelBelow = panelY >= anchorY + anchorHeight
  const panelAbove = panelY + panelHeight <= anchorY
  const horizontal = panelRight || panelLeft
  const edge = horizontal ? (panelX > anchorX ? panelX : panelX + panelWidth) : panelY > anchorY ? panelY : panelY + panelHeight
  const facing = panelRight ? panelX : panelLeft ? panelX + panelWidth : panelBelow ? panelY : panelY + panelHeight
  return {
    separated: panelRight || panelLeft || panelBelow || panelAbove,
    containsEdgeIsFacingEdge: edge === facing,
    exitOnEdgeLine: horizontal ? numberField(exit, 'x') === edge : numberField(exit, 'y') === edge,
    anchorWidthZero: anchorWidth === 0,
    anchorHeightZero: anchorHeight === 0,
    panelWidthZero: panelWidth === 0,
    panelHeightZero: panelHeight === 0,
  }
}

function inputField(frame: Value, inset: Value, maxWidth: Value): Record<string, boolean> {
  const content = field(frame, 'content')
  const topSidebar = field(frame, 'topSidebar')
  const contentLeft = numberField(content, 'left')
  const used = Math.max(Math.abs(contentLeft), Math.abs(numberField(content, 'right')), Math.abs(numberField(topSidebar, 'left')), maxMagnitude(inset), maxMagnitude(maxWidth))
  const unused = maxMagnitude([field(frame, 'nav'), field(frame, 'input'), field(frame, 'inputTray'), field(frame, 'sidebar'), field(frame, 'rightStrip'), field(content, 'top'), field(content, 'bottom'), field(topSidebar, 'right'), field(topSidebar, 'top'), field(topSidebar, 'bottom')])
  return {controlsBoundaryBelowContentLeft: numberField(topSidebar, 'left') - 16 < contentLeft, usedFieldsWithin1e4: used <= 1e4, unusedFieldsAbove1e4: unused > 1e4}
}

function rows(sizes: Value, gapX: Value, gapYArgument: Value): Record<string, boolean> {
  const items = elements(sizes)
  const gapY = gapYArgument === undefined ? gapX : gapYArgument
  return {
    anyNegativeElement: items.some((size) => numberField(size, 'width') < 0 || numberField(size, 'height') < 0),
    anyNegativeWidth: items.some((size) => numberField(size, 'width') < 0),
    anyNegativeHeight: items.some((size) => numberField(size, 'height') < 0),
    allHeightsZeroOrNegative: items.length > 0 && items.every((size) => numberField(size, 'height') <= 0),
    gapYZero: gapY === 0,
  }
}

function masonry(itemsArgument: Value, cols: Value, containerInnerSizeX: Value, imagesGap: Value): Record<string, boolean> {
  const items = elements(itemsArgument)
  const available = (typeof containerInnerSizeX === 'number' ? containerInnerSizeX : NaN) - (typeof imagesGap === 'number' ? imagesGap : NaN) * ((typeof cols === 'number' ? cols : NaN) - 1)
  const integerNonNegative = (item: Value) => Number.isInteger(numberField(item, 'width')) && Number.isInteger(numberField(item, 'height')) && numberField(item, 'width') >= 0 && numberField(item, 'height') >= 0
  return {
    availableSizeXNegative: available < 0,
    availableSizeXNonPositive: available <= 0,
    anyNegativeElement: items.some((item) => numberField(item, 'width') < 0 || numberField(item, 'height') < 0),
    anyNonIntegerElement: items.some((item) => !Number.isInteger(numberField(item, 'width')) || !Number.isInteger(numberField(item, 'height'))),
    anyJobWidthOver1e6: items.some((item) => (field(item, 'isStyle') === true ? numberField(item, 'width') * 3 : numberField(item, 'width')) > 1e6),
    allElementsNonNegativeIntegers: items.every(integerNonNegative),
  }
}

/** The boolean triage features of one input of `entry`, or null for an entry the triage had no features for. */
export function scanFeatures(entry: string, args: Value[]): Record<string, boolean> | null {
  switch (entry) {
    case 'menuHoverCorridorProperties': return corridor(args[0], args[1], args[2])
    case 'sidebarInputFieldHorizontalLayout': return inputField(args[0], args[1], args[2])
    case 'packRows': return rows(args[0], args[2], args[3])
    case 'packMasonry': return masonry(args[0], args[1], args[3], args[4])
    default: return null
  }
}
