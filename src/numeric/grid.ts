import {
  rationalCompare,
  rationalFromNumber,
  rationalFromParts,
  rationalIsZero,
  type Rational,
} from './rational.ts'

// A value pinned to zero sits on every grid; coarser than any nonzero
// double's grid (which ranges from -1074 through 1023).
export const zeroGrid = 1075

// Union of two values keeps only the grid both sit on (the finer exponent);
// intersection keeps the coarser of the two claims.
export function gridJoin(left: number | null, right: number | null): number | null {
  return left == null || right == null ? null : Math.min(left, right)
}

export function gridMeet(left: number | null, right: number | null): number | null {
  if (left == null) return right
  if (right == null) return left
  return Math.max(left, right)
}

// The finest dyadic grid one double sits on: value = m * 2^grid with m odd.
export function gridOfNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null
  if (value === 0) return zeroGrid
  const rational = rationalFromNumber(value)!
  let num = rational.num < 0n ? -rational.num : rational.num
  let grid = 0
  while ((num & 1n) === 0n) {
    num >>= 1n
    grid++
  }
  let den = rational.den
  while (den > 1n) {
    den >>= 1n
    grid--
  }
  return grid
}

const maximumFiniteSignificand = (1n << 53n) - 1n

// Every multiple of 2^grid through this magnitude is a finite double. The
// usual 2^(53+grid) precision window applies through grid 970; coarser grids
// near overflow stop at their largest finite multiple instead.
export function withinGridWindow(magnitude: Rational, grid: number): boolean {
  if (rationalIsZero(magnitude)) return true
  if (grid < -1074 || grid > 1023) return false
  const exponent = 53 + grid
  const threshold = grid <= 970
    ? exponent >= 0
      ? rationalFromParts(1n << BigInt(exponent), 1n)
      : rationalFromParts(1n, 1n << BigInt(-exponent))
    : rationalFromParts(
        (maximumFiniteSignificand >> BigInt(grid - 971)) << BigInt(grid),
        1n,
      )
  return rationalCompare(magnitude, threshold) <= 0
}
