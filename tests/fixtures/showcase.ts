// A subset-conformant miniature of the demo's world: module state trees, spring physics,
// nullable frame timing, config tuples, and array processing — everything the analyzer
// models today, in the shapes agents are asked to write.

type Spring = {pos: number; dest: number; v: number}

const stiffness = 290
const damping = 30
const msPerStep = 4

// A tuple config table: constant reads are exact and proven in bounds.
const gapSizes = [4, 8, 24] as const

// Module state: a record tree off a let root, rebound by functions (declared-shape hedge),
// and a nullable frame clock.
let cursor = {x: 0, y: 0}
let animatedUntilTime: number | null = null

export function springStep(s: Spring): Spring {
  const t = msPerStep / 1000
  const acceleration = -stiffness * (s.pos - s.dest) - damping * s.v
  const v = s.v + acceleration * t
  const pos = s.pos + v * t
  return {pos, dest: s.dest, v}
}

export function springDone(s: Spring): boolean {
  return Math.abs(s.v) < 0.01 && Math.abs(s.dest - s.pos) < 0.01
}

export function frameSteps(now: number): number {
  const last = animatedUntilTime ?? now
  const steps = Math.floor((now - last) / msPerStep)
  return Math.max(0, Math.min(steps, 100))
}

export function advanceClock(now: number): void {
  animatedUntilTime = now
}

export function moveCursor(nx: number, ny: number): void {
  cursor = {x: nx, y: ny}
}

export function cursorDistance(): number {
  return Math.abs(cursor.x) + Math.abs(cursor.y)
}

export function middleGap(): number {
  return gapSizes[1] * gapSizes.length
}

export function totalClamped(values: number[]): number {
  let sum = 0
  for (const value of values) {
    sum = sum + Math.max(0, Math.min(value, 10))
  }
  return sum
}

export function firstPositive(values: number[]): number {
  for (const value of values) {
    if (value > 0) {
      return value
    }
  }
  return 0
}

export function headOr(values: number[], fallback: number): number {
  if (values.length > 0) {
    return values[0]!
  }
  return fallback
}

export function widthPerColumn(grid: {columnCount: number}, width: number): number {
  return width / grid.columnCount
}
