const doubleScratch = new Float64Array(1)
const doubleScratchBits = new BigUint64Array(doubleScratch.buffer)

export function nextDoubleDown(value: number): number {
  if (value === Number.NEGATIVE_INFINITY) return value
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_VALUE
  if (value === 0) return -Number.MIN_VALUE
  doubleScratch[0] = value
  doubleScratchBits[0] = doubleScratchBits[0]! + (value > 0 ? -1n : 1n)
  return doubleScratch[0]
}

export function nextDoubleUp(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return value
  if (value === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE
  if (value === 0) return Number.MIN_VALUE
  doubleScratch[0] = value
  doubleScratchBits[0] = doubleScratchBits[0]! + (value > 0 ? 1n : -1n)
  return doubleScratch[0]
}
