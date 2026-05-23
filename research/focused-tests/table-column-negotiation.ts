// Table column negotiation with single-column and spanning cells tightening
// the same local width vector.

export type TableCellConstraint = {
  start: number
  span: number
  minWidth: number
}

export type TableColumnLayout = {
  widths: number[]
  totalWidth: number
}

export function negotiateTableColumns(
  columnCount: number,
  cells: TableCellConstraint[],
  columnGap: number,
): TableColumnLayout {
  const widths: number[] = []
  for (let column = 0; column < columnCount; column++) widths.push(0)

  for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
    const cell = cells[cellIndex]!

    if (cell.span === 1) {
      const column = cell.start
      widths[column] = Math.max(widths[column]!, cell.minWidth)
      continue
    }

    let currentWidth = Math.max(0, cell.span - 1) * columnGap
    for (let column = cell.start; column < cell.start + cell.span; column++) {
      currentWidth += widths[column]!
    }

    const missing = cell.minWidth - currentWidth
    if (missing > 0) {
      const extraPerColumn = missing / cell.span
      for (let column = cell.start; column < cell.start + cell.span; column++) {
        widths[column] = widths[column]! + extraPerColumn
      }
    }
  }

  let totalWidth = Math.max(0, columnCount - 1) * columnGap
  for (let column = 0; column < widths.length; column++) totalWidth += widths[column]!

  return {widths, totalWidth}
}
