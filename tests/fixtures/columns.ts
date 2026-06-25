function clamp(min: number, value: number, max: number): number {
  return value > max ? max : value < min ? min : value
}

export function columnsForWidth(containerWidth: number): number {
  return clamp(1, Math.floor((containerWidth - 24) / 244), 7)
}
