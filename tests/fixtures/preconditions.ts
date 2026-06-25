function clamp(minimum: number, value: number, maximum: number): number {
  return value > maximum ? maximum : value < minimum ? minimum : value
}

export function divideWidth(width: number, columnCount: number): number {
  return width / columnCount
}

export function divideThroughCaller(width: number, columnCount: number): number {
  return divideWidth(width, columnCount)
}

export function divideThroughTwoCallers(width: number, columnCount: number): number {
  return divideThroughCaller(width, columnCount)
}

export function divideAfterGap(width: number, gap: number): number {
  return divideWidth(width, width - gap)
}

export function divideByClampedColumnCount(width: number): number {
  const columnCount = clamp(1, Math.floor(width / 244), 7)
  return divideWidth(width, columnCount)
}
