# Finite Numbers

This document specifies the intended behavior for JavaScript numbers in checked Freerange code.

Plain TypeScript `number` inputs to a checked function contract are finite by default. They exclude `NaN`, `Infinity`, and `-Infinity`.

An explicit range can admit either infinity. `NaN` stays outside Freerange's checked numerical domain: there is no `NaN` literal or `0..3 | NaN` contract syntax. If an operation may produce `NaN`, Freerange reports the operation as unknown unless an earlier check proves it safe.

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

An explicit range states the full accepted set for that path and replaces the finite default:

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

Infinity endpoints keep their literal meaning:

```ts
0..<Infinity               // finite and nonnegative
-Infinity<..<Infinity      // any finite number
0..Infinity                // nonnegative, including +Infinity
-Infinity..Infinity        // any non-NaN JavaScript number
```

Contract uses of `NaN` or `Number.NaN`, including `NaN` in a range alternative, are rejected with a direct message that `NaN` is outside the checked numerical domain.

`int` constrains the finite members of a range to integers. An infinity endpoint remains admitted when it is inclusive, so `int 0..Infinity` differs from the finite `int 0..<Infinity`.

## Where The Default Applies

The finite default covers numeric leaves at a checked function's input boundary:

- parameters
- fields reached through parameter object types
- array elements reached through parameter array types
- callback parameters when Freerange checks the callback and its caller

For `number | null`, `number | undefined`, and optional numeric fields, the numeric value is finite when present. Passing `null`, `undefined`, or omitting the field does not create a finite-number requirement.

Freerange rejects a checked recursive input type when it cannot publish one finite precondition that covers every recursive numeric leaf. It does not silently constrain only the first level.

A checked function contract with finite-default parameters publishes an implicit finite precondition. Calls that use that contract must prove the corresponding arguments finite. An explicit parameter range publishes that requirement instead.

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

Unannotated same-file helpers do not publish implicit call requirements merely because their parameters use TypeScript `number`. Freerange evaluates those helpers from the actual argument values when their source is available.

## Operations That May Produce NaN

An operation that may produce `NaN` is unknown until its inputs rule out the invalid cases. Freerange reports the missing premise at that operation instead of assigning the result an invented broad range.

The arithmetic family includes:

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

That result can continue through operations that accept infinity, but it cannot satisfy an explicitly finite result range such as `return: -Infinity<..<Infinity` or enter a finite-default parameter.

Later arithmetic does not restore finiteness merely because its real-number form would cancel:

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

A numeric `@fit` return claim over that result is `UNKNOWN`. If only one return path may produce `NaN`, the joined result is still unknown; Freerange does not retain the other paths as a union such as `0..3 | NaN`.

## Math Functions

Freerange models JavaScript `Math` functions by their input domains and output guarantees:

- `abs`, `sign`, `min`, `max`, and rounding preserve non-`NaN` inputs
- `sin` and `cos` require finite inputs because either infinity returns `NaN`
- `sqrt` requires a nonnegative input
- `log`, `log2`, and `log10` require a nonnegative input; zero returns `-Infinity`
- `log1p` requires an input at least `-1`
- `asin` and `acos` require an input between `-1` and `1`
- `acosh` requires an input at least `1`
- `atanh` requires an input between `-1` and `1`; either endpoint returns an infinity
- integer coercions such as `clz32` and `imul` return their documented finite integer ranges for supported inputs

Guards provide domain facts in ordinary source:

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

Parsing, declaration-only library results, browser values without a documented platform fact, and values changed by unknown code are not assumed finite from their TypeScript `number` type. Validate them before checked arithmetic or before passing them to a finite-default parameter.

An unannotated function that Freerange scans only as a caller does not receive the finite input default. Its parameters must come from actual caller facts or be validated before entering a checked contract:

```ts
function externalEntry(value: number) {
  if (!Number.isFinite(value)) return
  needsFinite(value)
}
```

The supported validation family is:

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

Every value in the checked numerical domain excludes `NaN`, so ordinary comparison complements hold:

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

These facts apply to explicit infinities as well as finite values. They do not imply exact-real algebra or strict progress through floating-point addition.

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

Reports name the operation and the missing premise:

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

Keep the first operation that leaves the checked numerical domain so later expression failures do not repeat the same cause.

## Boundary

This specification supports:

- finite numbers by default at checked contract inputs
- explicit infinity endpoints in ranges
- arithmetic whose JavaScript `NaN` cases have been ruled out
- validation through `Number.isFinite`, `Number.isNaN`, `Number.isInteger`, and `Number.isSafeInteger`
- comparisons, branches, loops, and checked calls over those values

It deliberately leaves out:

- `NaN` in contract syntax
- intentional `NaN` returns or container elements
- arithmetic before validation on parsing or foreign results
- numerical reasoning inside the true branch of `Number.isNaN`
- coercive global `isFinite` and `isNaN`
- exact-real identities that JavaScript rounding can break

If a checked use needs intentional `NaN`, define the concrete call, storage, and control-flow requirements before extending this boundary.
