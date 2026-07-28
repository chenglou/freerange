# Common Freerange Patterns

Give this guide to an agent that is adapting TypeScript for Freerange. These examples are not magic spellings. First decide what the program should do with an invalid input, then choose the matching structure.

The main idea is simple: Freerange carries what it learns forward through the exact value that was checked. A local alias still refers to that value. Repeating a calculation or function call produces a new value. An `if` guard affects the code reached through that branch; an interior `console.assert` only asks Freerange to prove something.

| Code shape | Freerange behavior |
| --- | --- |
| `const saved = value` | `saved` and `value` refer to the same value |
| Repeated read of the same immutable property or array position | Refers to the same value within Freerange's object model |
| `end - start` written twice | Two calculations; a check on one does not check the other |
| `normalize(value)` called twice | Two calls; their results are not assumed equal |
| A direct `if` condition | Narrows values in the branch it controls |
| An interior `console.assert` | Checks a claim but does not narrow later code |
| A supported call to a function in the same file | Freerange follows the call |
| An imported call or callback | Freerange does not follow the call |

## Calculate Once, Then Check and Use That Value

This check does not remove the division requirement because the subtraction is evaluated again:

```ts
export function progressBar(value: number, start: number, end: number): number {
  if (end - start === 0) return 0
  return (value - start) / (end - start)
}
```

Store the result and use that same result for both operations:

```ts
export function progressBar(value: number, start: number, end: number): number {
  const span = end - start
  if (span === 0) return 0
  return (value - start) / span
}
```

Returning `0` is application behavior, not an analysis trick. Throw instead if equal endpoints are an unrecoverable bug. If callers are supposed to prevent equal endpoints, leave the inferred requirement in place.

## Pass the Calculated Value Across a Function Boundary

With the original `progressBar(value, start, end)` signature, checking two unknown fields at the caller does not prove that the separately calculated divisor inside `progressBar` is nonzero. Freerange deliberately does not retain arbitrary relationships between separate inputs.

When the caller calculates the span, pass that span directly to the helper:

```ts
function progressFromSpan(value: number, start: number, span: number): number {
  return (value - start) / span
}

export function downloadProgress(download: {value: number; start: number; end: number}): number {
  const span = download.end - download.start
  if (!Number.isFinite(span) || span === 0) return 0
  return progressFromSpan(download.value, download.start, span)
}
```

The finite check matters because subtracting two finite numbers can still overflow. If the application already restricts these values to a smaller range, write those input requirements instead of adding a fallback that the application does not want.

## Read Changing State Once

Separate reads of mutable module state and browser state may produce different values. A check on one read therefore does not apply to another:

```ts
let currentScale = 1

export function setScale(scale: number): void {
  currentScale = scale
}

export function scaledWidth(width: number): number {
  if (currentScale === 0) return 0
  return width / currentScale
}
```

Take one snapshot for the calculation:

```ts
export function scaledWidth(width: number): number {
  const scale = currentScale
  if (scale === 0) return 0
  return width / scale
}
```

Use the same pattern for a value such as `performance.now()` only when the program intends to check and reuse one observation. Two clock reads are necessary when the elapsed time between them is the point.

## Store a Function Result When Equality Matters

Two supported calls are analyzed independently, even when their source text is identical:

```ts
function boundedOpacity(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function opacityDifference(value: number): number {
  return boundedOpacity(value) - boundedOpacity(value)
}
```

Store one result when the program means to reuse one result:

```ts
export function opacityDifference(value: number): number {
  const opacity = boundedOpacity(value)
  return opacity - opacity
}
```

Freerange can prove that the second version returns exactly `0`.

## Use a Guard When Later Code Relies on the Check

An interior assertion does not stop JavaScript or narrow the following division:

```ts
export function ratio(total: number, divisor: number): number {
  const checkedDivisor = divisor
  console.assert(checkedDivisor !== 0)
  return total / checkedDivisor
}
```

Use control flow when execution must not continue with the invalid value:

```ts
export function ratio(total: number, divisor: number): number {
  const checkedDivisor = divisor
  if (checkedDivisor === 0) return 0
  return total / checkedDivisor
}
```

Leading `console.assert` calls are different: they describe what callers must provide. All caller requirements must be consecutive at the very beginning of the function. They can state direct checks on one input, such as `columns >= 1` or `Number.isInteger(columns)`, but cannot express a relationship such as `end !== start` between two unknown inputs. Handle the relationship in the function or pass a derived value such as `span`.

Each assertion must contain one direct comparison or supported `Number` check. Split `console.assert(Number.isInteger(columns) && columns >= 1)` into two consecutive assertions.

## Do Not Use One Assertion to Prove Another

Assertions are checked independently. Freerange does not use the first two assertions below as premises for the third:

```ts
console.assert(navRight <= contentLeft)
console.assert(contentLeft <= panelLeft)
console.assert(navRight <= panelLeft)
```

When the relationship follows from construction, keep that construction visible:

```ts
const contentGap = Math.max(0, requestedContentGap)
const panelGap = Math.max(0, requestedPanelGap)
const contentLeft = navRight + contentGap
const panelLeft = contentLeft + panelGap

console.assert(navRight <= panelLeft)
```

If the values arrive independently, Freerange may correctly leave the third assertion unproven. Adding more assertions does not create a proof.

## Keep Multi-Part Guards in the Control Flow

A stored single comparison can narrow a branch, but a stored `&&` or `||` result cannot:

```ts
export function valueAt(values: number[], index: number): number {
  const valid = Number.isInteger(index) && index >= 0 && index < values.length
  if (!valid) return 0
  return values[index]!
}
```

Write the checks directly in the `if`, or as a sequence of early returns:

```ts
export function valueAt(values: number[], index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return 0
  return values[index]!
}
```

## Check the Exact Array Being Read

An array index must be an integer, at least `0`, and below the length of the same array. Checking only the bounds still permits fractional indexes:

```ts
export function columnWidth(columnWidths: number[], index: number): number {
  if (index >= 0 && index < columnWidths.length) return columnWidths[index]!
  return 0
}
```

Check all three conditions against `columnWidths`:

```ts
export function columnWidth(columnWidths: number[], index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= columnWidths.length) return 0
  return columnWidths[index]!
}
```

Use `columnWidths[index] ?? fallback` instead when a missing element genuinely has a fallback value. A bounds check assumes a dense array; it cannot detect a hole in a sparse array.

The upper-bound check must also use the array being read. Checking `index < rowWidths.length` does not prove that `columnWidths[index]` exists.

## Handle Branch-Specific Requirements Explicitly

Freerange does not publish conditional caller requirements. This function therefore requires `divisor` to be nonzero even though only one branch divides:

```ts
export function optionalRatio(enabled: boolean, total: number, divisor: number): number {
  if (enabled) return total / divisor
  return 0
}
```

If a zero divisor should be handled only when the feature is enabled, write that behavior:

```ts
export function optionalRatio(enabled: boolean, total: number, divisor: number): number {
  if (!enabled) return 0
  if (divisor === 0) return 0
  return total / divisor
}
```

Keep the unconditional requirement when zero is invalid input regardless of `enabled`.

## Use a Loop for a Simple Array Aggregation

Freerange does not run collection callbacks such as the function passed to `reduce`:

```ts
export function totalWidth(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0)
}
```

An indexed loop exposes the accumulator and every numeric operation:

```ts
export function totalWidth(widths: number[]): number {
  let total = 0
  for (let index = 0; index < widths.length; index += 1) {
    total += widths[index]!
  }
  return total
}
```

This rewrite is appropriate for a dense array, a reduction with an initial value, and a callback whose arguments or effects do not matter. Do not mechanically rewrite `map` or `filter`: creating a new array, preserving holes, and running callback effects are observable behavior.

## Keep Unknown Work Outside the Numeric Helper

Freerange does not follow imported functions or callbacks. Wrapping an imported call does not make the call proven:

```ts
import {measureText} from './text-engine.ts'

export function labelWidth(text: string): number {
  return Math.max(120, measureText(text) + 32)
}
```

Move the calculation that can be checked into a plain helper with explicit numeric inputs:

```ts
export function labelWidthFromMeasurement(measuredWidth: number): number {
  return Math.max(120, measuredWidth + 32)
}

export function labelWidth(text: string): number {
  return labelWidthFromMeasurement(measureText(text))
}
```

Freerange can publish a contract for `labelWidthFromMeasurement`; it still cannot verify what `measureText` returns. A React component can call the numeric helper directly. A collection callback can also call a named helper, but Freerange proves only the helper itself, not when or how the collection operation invokes it.

## Preserve the Intended Floating-Point Calculation

Algebraically equivalent formulas can behave differently as JavaScript numbers. This intermediate ratio can round to zero:

```ts
export function fittedHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  const aspectRatio = imageWidth / imageHeight
  return frameWidth / aspectRatio
}
```

When the application's rules allow it, use the original dimensions directly:

```ts
export function fittedHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  const width = Math.max(1, imageWidth)
  const height = Math.max(1, imageHeight)
  return (frameWidth * height) / width
}
```

This is not real-number simplification: the two formulas can round differently, and the multiplication can overflow. Choose the version whose floating-point behavior matches the application.
