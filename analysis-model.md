# Why Freerange Prefers Certain Code

Freerange deliberately does not search for arbitrary proofs. It follows a small, predictable set of rules through ordinary TypeScript. Most of its refactoring advice follows directly from the limits below.

## Freerange Remembers Values, Not Arbitrary Equations

For each number, Freerange remembers a range, whether the value is an integer, whether it may be `NaN` or infinite, and at most one excluded number. It does not generally remember relationships between two separate values.

For example, this check establishes a relationship between `start` and `end`:

```ts
if (end === start) return 0
```

The later division uses a different value, produced by subtraction:

```ts
return (value - start) / (end - start)
```

Freerange does not turn `end !== start` into a lasting equation about every later expression containing those values. Calculate the value that matters, then check and reuse it:

```ts
const span = end - start
if (span === 0) return 0
return (value - start) / span
```

Even writing `end - start` in both places is not enough, because each written subtraction is a separate evaluation. The local variable makes the checked divisor and the used divisor the same value.

## Information Only Affects Code Reached After the Check

Freerange analyzes code in execution order. An `if` narrows the branch that follows it:

```ts
if (divisor === 0) return 0
return total / divisor
```

A check after the division cannot help the earlier operation. An interior `console.assert` also cannot replace the guard:

```ts
const checkedDivisor = divisor
console.assert(checkedDivisor !== 0)
return total / checkedDivisor
```

At runtime, `console.assert` reports a failure and continues. Freerange therefore treats an interior assertion as something to prove, not permission to trust the condition afterward.

Leading assertions have a different purpose. A consecutive group at the very beginning of a function describes what every caller must provide:

```ts
export function columnWidth(totalWidth: number, columns: number): number {
  console.assert(Number.isInteger(columns))
  console.assert(columns >= 1)
  return totalWidth / columns
}
```

Once an ordinary statement appears, later assertions are checks inside the function rather than caller requirements. Leading requirements are intentionally simple: they can compare one input with a fixed numeric value, but cannot express a relationship such as `end !== start` between two unknown inputs.

## Calls and Changing Reads Are New Observations

Freerange does not assume that two function calls return the same result merely because their source text matches:

```ts
return boundedOpacity(value) - boundedOpacity(value)
```

If the program means to use one result twice, say so:

```ts
const opacity = boundedOpacity(value)
return opacity - opacity
```

The same rule applies to mutable module state and browser state. Two reads may observe different values:

```ts
if (currentScale === 0) return 0
return width / currentScale
```

Take one snapshot when the program intends one observation:

```ts
const scale = currentScale
if (scale === 0) return 0
return width / scale
```

Do not take one snapshot when the difference between two observations is the point, such as measuring elapsed time with two clock reads.

## Branches Eventually Become One Combined Range

When both sides of a branch can continue, Freerange combines their possible values. It does not keep an unlimited list of paths and their conditions.

Caller requirements follow the same rule. This function requires `divisor` to be nonzero without retaining the condition “only when enabled”:

```ts
export function optionalRatio(enabled: boolean, total: number, divisor: number): number {
  if (enabled) return total / divisor
  return 0
}
```

If zero should be handled only on the enabled path, write that behavior:

```ts
export function optionalRatio(enabled: boolean, total: number, divisor: number): number {
  if (!enabled) return 0
  if (divisor === 0) return 0
  return total / divisor
}
```

Keep the unconditional requirement when zero is invalid regardless of `enabled`.

This combination also explains why Freerange stores separated possibilities conservatively. If one branch returns `1..2` and another returns `10..11`, later code sees the covering range `1..11`, not both ranges separately.

## Assertions Check Written Claims, but Do Not Create New Premises

Freerange does not use one interior assertion to prove another:

```ts
console.assert(navRight <= contentLeft)
console.assert(contentLeft <= panelLeft)
console.assert(navRight <= panelLeft)
```

The third assertion must follow from the values that produced `navRight` and `panelLeft`; the first two assertions do not establish a transitive rule.

Keep relationships visible in the calculations when they are true by construction:

```ts
const contentGap = Math.max(0, requestedContentGap)
const panelGap = Math.max(0, requestedPanelGap)
const contentLeft = navRight + contentGap
const panelLeft = contentLeft + panelGap

console.assert(navRight <= panelLeft)
```

If the values arrive independently, Freerange may correctly leave the assertion unproven.

## Array Reads Need a Complete Index Check

Freerange models a `number[]` as a length plus one range covering every element. It does not keep a separate value for every runtime position.

An asserted read such as `values[index]!` needs three facts:

- `index` is an integer
- `index >= 0`
- `index < values.length`

Write those checks against the same array being read:

```ts
export function valueAt(values: number[], index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return 0
  return values[index]!
}
```

The length check alone permits `1.5`. Checking another array's length says nothing about `values[index]`. If a missing element has a real fallback value, use `values[index] ?? fallback` instead.

Freerange assumes external arrays are dense. A bounds check cannot prove that `[1, , 3]` has an element at index `1`.

## Objects and Arrays Are Immutable During Analysis

Freerange treats supported objects and arrays as immutable after construction. This removes the need to guess which aliases a mutation may affect.

Property writes and mutating array methods are therefore outside the analyzed subset:

```ts
export function moveRight(point: {x: number; y: number}, distance: number): {x: number; y: number} {
  point.x += distance
  return point
}
```

Return a new value with explicit fields:

```ts
export function moveRight(point: {x: number; y: number}, distance: number): {x: number; y: number} {
  return {
    x: point.x + distance,
    y: point.y,
  }
}
```

Object spread is also unsupported. JavaScript copies only an object's own enumerable properties, which may not match the fields declared by its TypeScript type. Listing the fields performs the reads the calculation actually depends on.

## Freerange Follows Only Supported Same-File Calls

Freerange can analyze a supported function call in the same file using the caller's current values. It does not follow imported functions, framework scheduling, or collection callbacks.

Keep unknown work outside the numeric helper:

```ts
import {measureText} from './text-engine.ts'

export function labelWidthFromMeasurement(measuredWidth: number): number {
  return Math.max(120, measuredWidth + 32)
}

export function labelWidth(text: string): number {
  return labelWidthFromMeasurement(measureText(text))
}
```

Freerange can publish a contract for `labelWidthFromMeasurement`. It still cannot verify what `measureText` returns or prove the call from `labelWidth`.

For a simple dense-array aggregation, an explicit loop exposes the numeric work:

```ts
export function totalWidth(widths: number[]): number {
  let total = 0
  for (let index = 0; index < widths.length; index += 1) {
    total += widths[index]!
  }
  return total
}
```

This does not make a loop a general replacement for `map` or `filter`, whose new arrays, holes, and callback effects are observable.

## Freerange Uses JavaScript Numbers, Not Algebraic Real Numbers

Freerange analyzes arithmetic in the written order. It does not rearrange formulas according to real-number algebra because JavaScript rounds and can overflow or underflow.

This intermediate ratio can round to zero:

```ts
const aspectRatio = imageWidth / imageHeight
return frameWidth / aspectRatio
```

When the application's behavior permits it, working from the original dimensions avoids that particular intermediate:

```ts
const width = Math.max(1, imageWidth)
const height = Math.max(1, imageHeight)
return (frameWidth * height) / width
```

The second formula can still round differently, and its multiplication can overflow. Choose the evaluation order whose floating-point behavior matches the application rather than treating the rewrite as algebraic simplification.
