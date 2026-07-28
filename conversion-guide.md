# Converting Code for Freerange

These examples cover the analysis limits most likely to affect a refactor. Each rewrite makes the program's intended behavior easier for Freerange to follow. Preserve the application's behavior; do not add a fallback or change a calculation merely to silence a report.

## No automatic common-subexpression matching

Freerange does not match two calculations merely because their source code is identical. This code checks one subtraction, then divides by a newly evaluated subtraction:

```ts
export function progressBar(value: number, start: number, end: number): number {
  if (end - start === 0) return 0
  return (value - start) / (end - start)
}
```

Name the value that must remain the same:

```ts
export function progressBar(value: number, start: number, end: number): number {
  const span = end - start
  if (span === 0) return 0
  return (value - start) / span
}
```

Freerange recognizes aliases, repeated reads of the same immutable field or array position, and the same argument passed to multiple parameters. A newly evaluated calculation or function call starts over.

## Objects and arrays are immutable

Freerange allows local variables to be reassigned, but rejects writes through an object or array:

```ts
export function moveRight(point: {x: number; y: number}, distance: number): {x: number; y: number} {
  point.x += distance
  return point
}
```

Return a new value and list the fields explicitly:

```ts
export function moveRight(point: {x: number; y: number}, distance: number): {x: number; y: number} {
  return {
    x: point.x + distance,
    y: point.y,
  }
}
```

## Read changing state once when one observation is intended

Each clock, viewport, scroll, or mutable module read may produce a fresh value:

```ts
export function viewportScale(): number {
  if (window.innerWidth === 0) return 0
  return 100 / window.innerWidth
}
```

Store one read when the program intends to check and reuse one observation:

```ts
export function viewportScale(): number {
  const viewportWidth = window.innerWidth
  if (viewportWidth === 0) return 0
  return 100 / viewportWidth
}
```

Keep separate reads when the difference between two observations is intentional, such as two clock reads used to measure elapsed time.

## No open-interval representation; exact neighboring floats can represent some strict bounds

Freerange does not store open intervals. JavaScript numbers are discrete, so an exact neighboring float can sometimes express a strict limit. For example:

```ts
export function randomOpacity(): number {
  return Math.random()
}
```

Freerange stores the range as `0` through `0.9999999999999999` and reports it as `at least 0 and less than 1`. This needs no user rewrite.

## No transitivity between separate comparisons

Freerange does not combine `left <= middle` and `middle <= right` to prove `left <= right`:

```ts
export function checkOrder(left: number, middle: number, right: number): number {
  if (left > middle) throw new Error('out of order')
  if (middle > right) throw new Error('out of order')
  console.assert(left <= right) // unproven
  return right
}
```

Keep an important relationship visible in the calculation when it is true by construction:

```ts
export function panelLeft(navRight: number, requestedGap: number): number {
  const gap = Math.max(0, requestedGap)
  const left = navRight + gap
  console.assert(navRight <= left)
  return left
}
```

If the values arrive independently, Freerange may correctly leave the relationship unproven.

## No backward algebraic solving

A person can see that reaching this division means `width * 2 > 10`, and therefore `width > 5`. Freerange does not work backward through the multiplication:

```ts
export function previewScale(width: number): number {
  if (width * 2 <= 10) return 1
  return 100 / width
}
```

Write the condition directly:

```ts
export function previewScale(width: number): number {
  if (width <= 5) return 1
  return 100 / width
}
```

## No algebraic rearrangement; Freerange follows JavaScript's written evaluation order

Expressions that are equal in ordinary algebra can produce different JavaScript numbers:

```ts
const amount = 9_007_199_254_740_992
const first = 3 + amount + 2 // 9007199254740998
const second = 1 + amount + 4 // 9007199254740996
```

Freerange does not rearrange either expression into `amount + 5`. Choose the calculation order whose floating-point behavior the application wants. If both uses must be identical, calculate the value once and reuse it.

## Branches keep one continuous range, not separate alternatives

Freerange combines both branch results into one continuous range. Here `width` becomes `240..480`, which includes `300` even though neither branch returns it:

```ts
export function previewRatio(compact: boolean): number {
  const width = compact ? 240 : 480
  return 100 / (width - 300)
}
```

Keep the calculation inside each branch when it depends on the separate alternatives:

```ts
export function previewRatio(compact: boolean): number {
  if (compact) return 100 / (240 - 300)
  return 100 / (480 - 300)
}
```

This matters only when later code depends on a gap in the possible values. A broad but safe return range may need no rewrite.

## At most one exact excluded number is remembered

After these checks, Freerange may remember that `code` is not `300` and forget the earlier exclusion of `240`:

```ts
export function reservedCodeRatio(code: number): number {
  if (code === 240) return 0
  if (code === 300) return 0
  return 100 / (code - 240)
}
```

Calculate and check the value that the next operation actually uses:

```ts
export function reservedCodeRatio(code: number): number {
  if (code === 300) return 0
  const divisor = code - 240
  if (divisor === 0) return 0
  return 100 / divisor
}
```

Freerange does not retain arbitrary sets such as "every number except 240 and 300."

## Supported same-file helpers keep the calculation

Freerange follows one returned calculation through supported calls in the same file. Requirements created inside the helper are written using the caller's values:

```ts
function span(start: number, end: number): number {
  return end - start
}

export function progressBar(value: number, start: number, end: number): number {
  return (value - start) / span(start, end)
}
```

Here `progressBar` requires `end - start` to be nonzero. A caller can handle the zero case without moving the subtraction out of `span`:

```ts
export function progressBar(value: number, start: number, end: number): number {
  const calculatedSpan = span(start, end)
  if (calculatedSpan === 0) return 0
  return (value - start) / calculatedSpan
}
```

The example treats a zero span as `0`; use a throw or a caller requirement when that better matches the application. If a helper can return several different calculations, Freerange combines their possible values just as it does for the equivalent inline branches. It does not invent a relationship that the inline form would also lose.

## No cross-module contracts; only supported calls in the same file are followed

Freerange does not follow a function imported from another module:

```ts
import {measureText} from './text-engine.ts'

export function labelWidth(text: string): number {
  return Math.max(120, measureText(text) + 32)
}
```

Put the numeric work in a supported helper with explicit inputs:

```ts
export function labelWidthFromMeasurement(measuredWidth: number): number {
  return Math.max(120, measuredWidth + 32)
}

export function labelWidth(text: string): number {
  return labelWidthFromMeasurement(measureText(text))
}
```

Freerange can prove `labelWidthFromMeasurement`, but not the imported measurement. Imported constants still work when their initializer ultimately resolves to a numeric literal.

## No collection callbacks such as `map` or `filter`. Loops are read-only with respect to arrays

Freerange does not run callbacks passed to `reduce`, `map`, or `filter`:

```ts
export function totalWidth(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0)
}
```

An explicit loop can read the array and update a local scalar:

```ts
export function totalWidth(widths: number[]): number {
  let total = 0
  for (let index = 0; index < widths.length; index += 1) {
    total += widths[index]!
  }
  return total
}
```

Freerange still does not support growing or modifying an output array inside the loop. A loop is therefore not a general replacement for `map` or `filter`.

## Return boolean checks directly

Freerange carries the meaning of a directly returned condition through supported same-file calls:

```ts
function isValidIndex(values: number[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < values.length
}

export function valueAt(values: number[], index: number): number {
  if (!isValidIndex(values, index)) return 0
  return values[index]!
}
```

The guard proves that the array read is safe. Keep a compound condition in the return expression. Storing it first loses the connection between the boolean and its checks, just as the equivalent stored boolean does when written inline:

```ts
function isValidIndex(values: number[], index: number): boolean {
  const valid = Number.isInteger(index) && index >= 0 && index < values.length
  return valid
}
```

## Interior `console.assert` does not narrow

An interior assertion asks Freerange to prove a claim. It does not make the following division trust that claim:

```ts
export function ratio(total: number, divisor: number): number {
  const checkedDivisor = divisor
  console.assert(checkedDivisor !== 0)
  return total / checkedDivisor
}
```

Use control flow when execution must stop or choose a fallback:

```ts
export function ratio(total: number, divisor: number): number {
  if (divisor === 0) return 0
  return total / divisor
}
```

Leading `console.assert` calls are different. A consecutive group at the beginning of a function describes what callers must provide and does narrow the function body.

## Loops try to find a stable range after a few iterations; they do not derive formulas or general loop invariants

Freerange does not simulate the exact iteration count, even when the bound is a literal:

```ts
export function fixedTotal(): number {
  let total = 0
  for (let index = 0; index < 3; index += 1) {
    total += 2
  }
  return total
}
```

Freerange knows that the result is a nonnegative integer, but does not derive that it is exactly `6`. If a formula is part of the intended implementation, write the formula directly. Do not rewrite repeated floating-point arithmetic as multiplication unless the different rounding behavior is acceptable.
