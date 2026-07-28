# Freerange Analysis Guide

Freerange deliberately remembers a small, predictable set of information about a program. Each section below starts with something Freerange does not track or analyze, then shows a simple way to write the code that Freerange can follow.

Preserve the application's behavior when refactoring. Do not add a fallback, throw, or normalization merely to silence a report.

## No common-subexpression elimination

Common-subexpression elimination replaces repeated calculations with one stored result when doing so is safe. Freerange does not do that automatically: two calculations remain separate even when their source code is identical. This function checks one subtraction, then divides by a newly evaluated subtraction:

```ts
export function progressBar(value: number, start: number, end: number): number {
  if (end - start === 0) return 0
  return (value - start) / (end - start)
}
```

Calculate the subtraction once when the check and division must use the same result:

```ts
export function progressBar(value: number, start: number, end: number): number {
  const span = end - start
  if (span === 0) return 0
  return (value - start) / span
}
```

Freerange recognizes aliases, repeated reads of the same immutable field or array position, and the same argument passed to multiple parameters. A newly evaluated calculation or function call is a new value.

## No object and array writes

Freerange allows local variables to be reassigned, but does not track writes through an object or array:

```ts
export function moveRight(point: {x: number; y: number}, distance: number): {x: number; y: number} {
  point.x += distance
  return point
}
```

Return a new value when the application does not require mutation or stable object identity:

```ts
export function moveRight(point: {x: number; y: number}, distance: number): {x: number; y: number} {
  return {
    x: point.x + distance,
    y: point.y,
  }
}
```

Object spread is also unsupported. List the fields explicitly so the runtime object and its analyzed fields cannot differ because of inherited or non-enumerable properties.

## Reads of changing state are not referentially transparent

Referential transparency means that evaluating the same expression again is equivalent to reusing its previous result. Freerange does not make that assumption for a clock, viewport, scroll position, or mutable module binding. Each read may produce a different value:

```ts
export function viewportScale(): number {
  if (window.innerWidth === 0) return 0
  return 100 / window.innerWidth
}
```

Store one read when the check and later use are meant to observe the same value:

```ts
export function viewportScale(): number {
  const viewportWidth = window.innerWidth
  if (viewportWidth === 0) return 0
  return 100 / viewportWidth
}
```

Keep separate reads when the difference between two observations is intentional, such as two clock reads used to measure elapsed time.

## Ranges use inclusive endpoints

Freerange stores every numeric range using its lowest and highest included values. It does not directly store an open endpoint such as "less than 1." JavaScript numbers are discrete, so the neighboring representable number can often express the same range. For example:

```ts
export function randomOpacity(): number {
  return Math.random()
}
```

Freerange stores the range as `0` through `0.9999999999999999` and reports it as `at least 0 and less than 1`. This needs no user rewrite.

## No transitive reasoning between comparisons

Transitive reasoning would combine `left <= middle` and `middle <= right` to prove `left <= right`. Freerange does not make that inference:

```ts
export function checkOrder(left: number, middle: number, right: number): number {
  if (left > middle) throw new Error('out of order')
  if (middle > right) throw new Error('out of order')
  console.assert(left <= right) // unproven
  return right
}
```

When one value is built from another, keep the important relationship visible in that calculation:

```ts
export function panelLeft(navRight: number, requestedGap: number): number {
  const gap = Math.max(0, requestedGap)
  const left = navRight + gap
  console.assert(navRight <= left)
  return left
}
```

If the values arrive independently, Freerange may correctly leave the relationship unproven.

## No backward propagation through arithmetic

Backward propagation would use a condition on a calculation to narrow its inputs. A person can see that reaching this division means `width * 2 > 10`, and therefore `width > 5`. Freerange does not propagate that condition backward through the multiplication:

```ts
export function previewScale(width: number): number {
  if (width * 2 <= 10) return 1
  return 100 / width
}
```

Check the value that the later operation uses:

```ts
export function previewScale(width: number): number {
  if (width <= 5) return 1
  return 100 / width
}
```

## No algebraic normalization

Algebraic normalization rewrites expressions using rules such as associativity, commutativity, or distributivity. Those rules do not always preserve JavaScript floating-point results:

```ts
const amount = 9_007_199_254_740_992
const first = 3 + amount + 2 // 9007199254740998
const second = 1 + amount + 4 // 9007199254740996
```

Freerange follows JavaScript's written evaluation order and does not rearrange either expression into `amount + 5`. Choose the calculation order whose floating-point behavior the application wants. If both uses must be identical, calculate the value once and reuse it.

## Branches merge into one continuous range

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

## A number remembers at most one excluded value

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

## A function return does not include how the value was calculated

Freerange evaluates supported same-file helpers using what the caller knows. It keeps what the helper may return, including numeric ranges and object fields, but not an equation such as "this result is exactly `end - start`":

```ts
function span(start: number, end: number): number {
  return end - start
}

export function progressBar(value: number, start: number, end: number): number {
  return (value - start) / span(start, end)
}
```

When the caller needs to check that exact calculation, calculate and check it in the caller, then pass the checked result to a helper:

```ts
function progressFromSpan(value: number, start: number, span: number): number {
  return (value - start) / span
}

export function progressBar(value: number, start: number, end: number): number {
  const calculatedSpan = end - start
  if (!Number.isFinite(calculatedSpan) || calculatedSpan === 0) return 0
  return progressFromSpan(value, start, calculatedSpan)
}
```

The example treats a non-finite or zero span as `0`; use a throw or a caller requirement when that better matches the application. There is no need to move a calculation out of a helper when only the returned range matters.

Booleans follow the same rule. A function that returns `true` does not also tell the caller what its arguments must have been:

```ts
function isValidIndex(values: number[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < values.length
}

export function valueAt(values: number[], index: number): number {
  if (!isValidIndex(values, index)) return 0
  return values[index]!
}
```

Write the checks directly where they protect the array read:

```ts
export function valueAt(values: number[], index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return 0
  return values[index]!
}
```

## Imported function bodies are not analyzed

Freerange does not follow a function imported from another module:

```ts
import {measureText} from './text-engine.ts'

export function labelWidth(text: string): number {
  return Math.max(120, measureText(text) + 32)
}
```

Keep the numeric work that needs analysis in a supported helper with explicit inputs:

```ts
export function labelWidthFromMeasurement(measuredWidth: number): number {
  return Math.max(120, measuredWidth + 32)
}

export function labelWidth(text: string): number {
  return labelWidthFromMeasurement(measureText(text))
}
```

Freerange can prove `labelWidthFromMeasurement`, but not the imported measurement. Imported constants still work when their initializer ultimately resolves to a numeric literal.

## No higher-order function analysis

Higher-order functions such as `reduce`, `map`, and `filter` receive another function as an argument. Freerange does not analyze those callbacks:

```ts
export function totalWidth(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0)
}
```

For a simple aggregation, an explicit loop can read the array and update a local number:

```ts
export function totalWidth(widths: number[]): number {
  let total = 0
  for (let index = 0; index < widths.length; index += 1) {
    total += widths[index]!
  }
  return total
}
```

This rewrite works for a scalar aggregation. Because object and array writes are unsupported, an explicit loop still cannot build an output array and is not a general replacement for `map` or `filter`.

## Loops find stable ranges, not exact formulas

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
