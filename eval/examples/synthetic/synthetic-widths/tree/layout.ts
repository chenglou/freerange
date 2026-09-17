// Widths for the synthetic example corpus: an assert that follows from its leading asserts, one a stored input makes false, and one inside a function outside the supported subset.
export function splitWidth(total: number, parts: number): number {
  console.assert(total >= 0)
  console.assert(parts >= 1)
  const share = total / parts
  console.assert(share <= total)
  return share
}

export function insetWidth(width: number, inset: number): number {
  console.assert(width >= 0)
  const inner = width - inset * 2
  console.assert(inner >= 0)
  return inner
}

export function sumWidths(widths: number[]): number {
  let total = 0
  widths.forEach(width => {
    total += width
  })
  console.assert(total >= 0)
  return total
}
