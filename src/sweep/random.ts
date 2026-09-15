// Seeded randomness, forked from the replay input-range prototype. Every generated input is addressed by
// (seed, entry ordinal, input index), so a process can regenerate input 73,012 of an entry without generating the
// inputs before it, and a child process sees exactly the inputs its parent planned.
// Ported unchanged from mutation-instrument-spike at bccf0dd (mutation-instrument/random.ts), except this comment.

export function lowbias32(input: number): number {
  let x = input >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

export type Random = {seed: number; counter: number}

/** The random stream of one input. The odd multipliers keep (entry 0, index 1) and (entry 1, index 0) apart. */
export function inputRandom(seed: number, entryOrdinal: number, index: number): Random {
  return {seed: lowbias32(seed ^ Math.imul(entryOrdinal, 0x9e3779b9) ^ Math.imul(index, 0x85ebca6b)), counter: 0}
}

/** A float in [0, 1). */
export function nextFloat(random: Random): number {
  random.counter += 1
  const high = lowbias32(random.seed ^ Math.imul(random.counter, 0x9e3779b9))
  const low = lowbias32(high ^ random.counter)
  return (high * 2 ** 21 + (low >>> 11)) / 2 ** 53
}

/** An integer from 0 through count - 1. */
export function nextIndex(random: Random, count: number): number {
  return Math.floor(nextFloat(random) * count)
}

const floatView = new Float64Array(1)
const bitsView = new BigUint64Array(floatView.buffer)

/** The adjacent representable double toward +Infinity, e.g. nextUp(0) === 5e-324. */
export function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Infinity) return value
  if (value === 0) return Number.MIN_VALUE
  floatView[0] = value
  bitsView[0] = value > 0 ? bitsView[0]! + 1n : bitsView[0]! - 1n
  return floatView[0]
}

/** The adjacent representable double toward -Infinity, e.g. nextDown(1) === 0.9999999999999999. */
export function nextDown(value: number): number {
  return -nextUp(-value)
}
