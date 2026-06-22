# Finite Numbers

This document specifies the intended behavior for JavaScript numbers in checked Freerange code.

Plain TypeScript `number` inputs to a checked function contract are finite by default. They exclude `NaN`, `Infinity`, and `-Infinity`.

An explicitly written range can include either infinity. Freerange does not support `NaN` in checked arithmetic: there is no `NaN` literal or `0..3 | NaN` contract syntax. If an operation may produce `NaN`, Freerange reports its result as unknown unless an earlier check proves the operation safe.

This is not exact-real arithmetic. Floating-point rounding, overflow, underflow, and signed zero still follow JavaScript.

## Numeric Sets

With no written range, numeric inputs to a checked contract use the finite default:

```ts
/** @fit
 * return >= 0
 */
function absolute(value: number) {
  return value >= 0 ? value : -value
}
```

An explicitly written range, e.g. `0..Infinity`, replaces the finite default:

```ts
/** @fit
 * given offset: 0..Infinity
 */
function scrollTo(offset: number) {
  // offset may be +Infinity, but not NaN or -Infinity
}
```

```ts
/** @fit
 * given position: -Infinity..Infinity
 */
function place(position: number) {
  // position may be finite or either infinity, but not NaN
}
```

The range operators say whether either infinity is included:

```ts
0..<Infinity               // finite and nonnegative
-Infinity<..<Infinity      // any finite number
0..Infinity                // nonnegative, including +Infinity
-Infinity..Infinity        // any non-NaN JavaScript number
```

Freerange rejects `NaN` or `Number.NaN` in a contract, including `NaN` in a range alternative, because checked arithmetic does not support `NaN`.

`int` makes every finite value in the range an integer. `int 0..Infinity` includes `Infinity`, while `int 0..<Infinity` does not.

## Where The Default Applies

The finite default applies to every number in a checked function's inputs:

- parameters
- fields reached through parameter object types
- array elements reached through parameter array types
- callback parameters when Freerange checks the callback and its caller

For `number | null`, `number | undefined`, and optional numeric fields, the numeric value is finite when present. Passing `null`, `undefined`, or omitting the field does not create a finite-number requirement.

Freerange rejects a checked recursive input type when it cannot apply the finite default to every number inside it. It does not silently check only the first level.

Calls to a checked function must prove that every number in its arguments fits an explicitly written range, or is finite when no range is written.

```ts
/** @fit
 * return: -Infinity<..<Infinity
 */
function needsFinite(value: number) {
  return value
}
```

Direct forwarding needs no extra annotation because both contracts use the same default:

```ts
/** @fit
 * return >= 0
 */
function outer(value: number) {
  return absolute(value)
}
```

Literal values and computations with proven finite bounds also pass directly. A computation that may overflow does not:

```ts
/** @fit
 * pure
 */
function doubled(value: number) {
  return needsFinite(value * 2)
  // requires value * 2 to be finite
}
```

The caller can provide a tighter bound, handle the overflow, or call a function whose explicit input range admits infinity:

```ts
/** @fit
 * given value: -100..100
 */
function boundedDouble(value: number) {
  return needsFinite(value * 2)
}
```

```ts
/** @fit
 * pure
 */
function checkedDouble(value: number) {
  const doubled = value * 2
  if (!Number.isFinite(doubled)) return null
  return needsFinite(doubled)
}
```

An ordinary local or return annotation such as `: number` does not erase what Freerange inferred. If a computation overflows, its result remains infinite even though TypeScript calls it `number`.

An unannotated helper in the same file does not assume its `number` parameters are finite. When Freerange can read the helper's source, it checks the helper using the values passed at each call.

## Operations That May Produce NaN

The result of an operation that may produce `NaN` stays unknown until its inputs rule out those cases. Freerange reports which condition is missing instead of inventing a range for the result.

These operations can produce `NaN`:

- addition: opposite infinities may produce `NaN`
- subtraction: equal infinities may produce `NaN`
- multiplication: zero and either infinity may produce `NaN`
- division: the supported form requires a nonzero divisor, and two infinite operands may produce `NaN`
- remainder: a zero divisor or infinite dividend may produce `NaN`
- exponentiation: some negative-base and exponent combinations may produce `NaN`

Multiplication of two finite values never produces `NaN`. It may overflow to either infinity:

```ts
/** @fit
 * pure
 */
function product(left: number, right: number) {
  return left * right // non-NaN, but possibly infinite
}
```

Examples:

```ts
Infinity - Infinity       // unknown: subtraction may produce NaN
0 * Infinity              // unknown: multiplication may produce NaN
Infinity / Infinity       // unknown: division may produce NaN
```

Overflow alone is not an error:

```ts
Number.MAX_VALUE * 2      // Infinity
```

That result can continue through operations that accept infinity, but it cannot satisfy an explicitly finite result range such as `return: -Infinity<..<Infinity` or be passed to a parameter assumed to be finite.

Later arithmetic does not necessarily make a value finite again. For example, if `value * 2` overflows to `Infinity`, dividing it by `2` still returns `Infinity` (`Infinity / 2 === Infinity`):

```ts
/** @fit
 * pure
 */
function doubledThenHalved(value: number) {
  return value * 2 / 2 // may be Infinity after the multiplication overflowed
}
```

## NaN Results

TypeScript still types an expression that produces `NaN` as `number`. Freerange reports its numerical result as unknown:

```ts
function invalidResult() {
  return NaN
}
```

```txt
return: unknown
reason: NaN is outside the checked numerical domain
```

A numeric `@fit` claim about that return value is `UNKNOWN`. If any return path may produce `NaN`, the return value stays unknown; Freerange does not keep the other paths as a union such as `0..3 | NaN`.

## Math Functions

Freerange checks supported JavaScript `Math` functions using their inputs and possible results:

- `abs`, `sign`, `min`, `max`, and rounding preserve non-`NaN` inputs
- `sin` and `cos` require finite inputs because either infinity returns `NaN`
- `sqrt` requires a nonnegative input
- `log`, `log2`, and `log10` require a nonnegative input; zero returns `-Infinity`
- `log1p` requires an input at least `-1`
- `asin` and `acos` require an input between `-1` and `1`
- `acosh` requires an input at least `1`
- `atanh` requires an input between `-1` and `1`; `-1` and `1` return infinities
- integer coercions such as `clz32` and `imul` return their documented finite integer ranges for supported inputs

Checks in ordinary code can prove that an input is valid:

```ts
/** @fit
 * pure
 * return: -Infinity..<Infinity
 */
function logarithm(value: number) {
  if (value < 0) return -Infinity
  return Math.log(value)
}
```

## Validation

A TypeScript `number` type alone does not make a value finite when it came from parsing, a library with only declarations, a browser API Freerange does not know, or unknown code. Check the value before doing arithmetic or passing it to a parameter assumed to be finite.

Freerange does not assume that an unannotated caller's parameters are finite. They need a proven finite range from a call site, or a check before they are passed to a checked function:

```ts
function externalEntry(value: number) {
  if (!Number.isFinite(value)) return
  needsFinite(value)
}
```

These checks narrow a value as follows:

| Check | True branch | False branch |
| --- | --- | --- |
| `Number.isFinite(value)` | `value` is finite | no finite guarantee |
| `Number.isNaN(value)` | `value` stays outside checked arithmetic | `value` is non-`NaN` and may include either infinity |
| `Number.isInteger(value)` | `value` is a finite integer | no additional guarantee |
| `Number.isSafeInteger(value)` | `value` is an integer in JavaScript's safe range | no additional guarantee |

This supports validation at the boundary without treating `NaN` as ordinary data:

```ts
const parsed = Number.parseFloat(text)
if (!Number.isFinite(parsed)) return null

return needsFinite(parsed)
```

The branch where `Number.isNaN(value)` is true may return, throw, or perform non-numeric work. Numeric operations on that value remain unsupported. The false branch may continue with finite values or either infinity.

When Freerange already knows a value excludes `NaN`, `Number.isNaN(value)` is always false. `Number.isFinite`, `Number.isInteger`, and `Number.isSafeInteger` still refine explicit ranges that include infinities or non-integers.

The coercive global `isFinite` and `isNaN` functions are outside this specification. Their string, null, and boolean conversions are a separate family.

## Comparisons And Control Flow

Checked numbers exclude `NaN`, so these opposite comparisons mean the same thing:

```ts
!(left >= right) == (left < right)
!(left > right) == (left <= right)
!(left <= right) == (left > right)
!(left < right) == (left >= right)
```

Self-equality and total ordering also hold:

```ts
value == value
left < right || left == right || left > right
```

These comparison rules apply to explicit infinities as well as finite values. They do not imply exact-real algebra or strict progress through floating-point addition.

The finite default makes this loop provable without a written `value == value` assumption:

```ts
/** @fit
 * given count: int 0..100
 * return >= 0
 */
function accumulatedMagnitude(value: number, count: number) {
  let total = 0
  for (let i = 0; i < count; i++) {
    total += value >= 0 ? value : -value
  }
  return total
}
```

## Floating-Point Algebra

Freerange preserves the grouping written in source. It does not reassociate arithmetic unless the known ranges prove the operations exact:

```ts
const leftGrouped = (1e16 + -1e16) + 1 // 1
const rightGrouped = 1e16 + (-1e16 + 1) // 0
```

Likewise, Freerange does not cancel `value * 2 / 2` to `value` unless it proves that the intermediate multiplication stays finite and both operations are exact. Bounds, comparisons, and monotonicity remain available when they are valid without reassociation.

## Diagnostics

Reports name the operation and the condition Freerange could not prove:

```txt
Math.asin(value) is unknown
missing: -1 <= value <= 1
```

```txt
zero * extent is unknown
known: zero = 0
known: extent: 0..Infinity
reason: zero and infinity may meet, producing NaN
```

```txt
needsFinite(value * 2): requires value * 2 to be finite
```

Report the first operation that may produce `NaN`, rather than repeating the same cause for every later expression that uses its result.

## Boundary

This specification supports:

- finite numbers by default at checked contract inputs
- ranges that explicitly include either infinity
- arithmetic whose JavaScript `NaN` cases have been ruled out
- validation through `Number.isFinite`, `Number.isNaN`, `Number.isInteger`, and `Number.isSafeInteger`
- comparisons, branches, loops, and checked calls over those values

Not supported:

- `NaN` in contract syntax
- intentional `NaN` returns or container elements
- arithmetic before checking values from parsing or unknown code
- numerical reasoning inside the true branch of `Number.isNaN`
- coercive global `isFinite` and `isNaN`
- exact-real identities that JavaScript rounding can break

Before adding intentional `NaN`, show where it comes from, where it is stored, and how the code branches on it.
