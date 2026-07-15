function unsupported(value: number): number {
  return [value].reduce((total, item) => total + item, 0)
}

export function requiredNonnegative(value: number): number {
  console.assert(value >= 0)
  const result = value
  console.assert(result >= 0)
  return result
}

export function requiredPositiveInteger(value: number): number {
  console.assert(Number.isInteger(value))
  console.assert(value >= 1)
  return 10 / value
}

export function propagatedRequirement(width: number): number {
  return requiredNonnegative(width - 1)
}

export function safeCaller(): number {
  return requiredNonnegative(5)
}

export function unsafeCaller(): number {
  return requiredNonnegative(-1)
}

export function unsafeWrapper(): number {
  return unsafeCaller()
}

export function unnameableCaller(useFirst: boolean, first: number, second: number): number {
  const selected = useFirst ? first : second
  return requiredNonnegative(selected)
}

function requiredThenThrows(value: number): never {
  console.assert(value >= 0)
  throw new Error('done')
}

export function callsRequiredThrow(value: number, shouldThrow: boolean): number {
  if (shouldThrow) requiredThenThrows(value)
  return 1
}

export function unprovenThenProven(value: number): number {
  const result = value
  console.assert(result >= 1)
  const bounded = Math.max(0, result)
  console.assert(bounded >= 0)
  return bounded
}

export function refuted(value: number): number {
  const positive = Math.max(1, value)
  console.assert(positive < 0)
  return positive
}

export function refutedThenProven(value: number): number {
  const positive = Math.max(1, value)
  console.assert(positive < 0)
  console.assert(positive >= 1)
  return positive
}

export function dead(value: number): number {
  const positive = Math.max(1, value)
  if (positive < 0) console.assert(value >= 0)
  return value
}

export function assertionsDoNotNarrow(value: number): number {
  const result = value
  console.assert(result > 0)
  console.assert(result >= 0)
  return result
}

export function partialAfterAssertion(value: number): number {
  const bounded = Math.max(0, value)
  console.assert(bounded >= 0)
  return unsupported(bounded)
}

export function assumptionAfterAssertion(
  useFirst: boolean,
  first: number,
  second: number,
): number {
  const bounded = Math.max(0, first)
  console.assert(bounded >= 0)
  const divisor = useFirst ? first : second
  return 1 / divisor
}
