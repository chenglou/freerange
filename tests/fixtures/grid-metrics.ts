function clamp(min: number, value: number, max: number): number {
  return value > max ? max : value < min ? min : value
}

export function calculateGridMetrics(containerWidth: number): {
  columnCount: number
  maximumBoxWidth: number
} {
  const boxMinimumWidth = 220
  const horizontalGap = 24
  const columnCount = clamp(
    1,
    Math.floor((containerWidth - horizontalGap) / (boxMinimumWidth + horizontalGap)),
    7,
  )
  const maximumBoxWidth = Math.max(
    1,
    (containerWidth - horizontalGap - columnCount * horizontalGap) / columnCount,
  )
  return {columnCount, maximumBoxWidth}
}

export function maximumBoxWidthForContainer(containerWidth: number): number {
  const gridMetrics = calculateGridMetrics(containerWidth)
  return gridMetrics.maximumBoxWidth
}
