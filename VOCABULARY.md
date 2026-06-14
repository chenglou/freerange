# Vocabulary

What `@fit` claims Freerange will try to decide. Everything outside this list is rejected with a clear message.

## Core

The shapes the analyzer always tries. Decidable, fast.

### Comparisons over linear expressions

```
x <= y + 10
width * 2 + gap <= container
focusedIndex < items.length
```

Linear means: add, subtract, multiply by a known constant, divide by a known nonzero. Comparisons are `<`, `<=`, `==`, `>=`, `>`.

### Range claims

```
width: 0..1000
index: int 0..<items.length
mode: 'grid' | 'line'
```

Sugar for a pair of comparisons (plus an integer or finite-set refinement).

### Per-element claims

```
rows[].height: 0..40
rows[].top >= 0
items[].kind == 'visible'
```

Holds when the field on every element of the array satisfies the comparison or range.

### Adjacent-pair claims

```
rows[$i + 1].top >= rows[$i].bottom
rows[$i + 1].top == rows[$i].top + rows[$i].height + gap
```

Holds when the relation holds between every pair of consecutive elements.

### Same-index claims across two arrays

```
rows[$i].height == items[$i].height
labels[$i].width <= columns[$i].width
```

Holds when the relation holds at every shared index of two arrays of equal length.

### Length and presence facts

```
rows.length == items.length
rows.length: int 0..200
value != null
```

### Boolean composition

```
spaced(rows, 0) && rows[].height > 0
!noOverlap(boxes) || focused == null
```

`&&`, `||`, `!`, `==` between any of the above.

### Purity

```ts
/** @fit
 * pure
 */
function widthWithPadding(width: number, padding: number) {
  return width + padding * 2
}
```

`pure` is a function-level claim. It means calling the function:

- does not change its arguments, `this`, or outside state
- does not read outside state that other code can change
- does not perform I/O or read the clock or randomness
- does not call code whose behavior Freerange cannot inspect

Creating and changing local values is allowed. The annotation does not make a function pure; it asks Freerange to check the promise.

A source-backed free function may also be called from another `@fit` expression when Freerange proves it pure. The helper does not need its own `pure` line. A definite effect makes the claim fail. A call whose behavior is unavailable leaves the claim unknown.

## Named catalog

Decidable claims with documented rules. Users call these like functions; the analyzer queries facts rather than re-deriving them.

### Math

- `Math.min(a, b)`, `Math.max(a, b)` — interval bounds.
- `Math.floor(x)`, `Math.ceil(x)`, `Math.round(x)`, `Math.trunc(x)` — rounding bounds plus monotonicity.
- `Math.abs(x)` — nonnegative; flips sign-aware bounds.
- `Math.sqrt(x)` — monotonic for `x >= 0`.
- `Math.sign(x)` — finite literal set `{-1, 0, 1}`.

### Sequence shorthand

- `spaced(arr, gap)` — each next number equals the previous number plus `gap`, or each next row starts at the previous row's end plus `gap`.
- `nondecreasing(arr.field)` — every next item's field ≥ previous item's field.
- `lastEnd(arr)` — the last element's end coordinate. Requires `arr.length >= 1`.
- `extentEnd(arr, fallback)` — `lastEnd(arr)` when non-empty, `fallback` when empty. Total form.

These are queries against the array's relational facts. Row operations recognize `y/height`, `x/width`, `top/height`, and `start/size`. Map other names into one of those pairs first. For floating-point additions, an inferred equality keeps the grouping the source evaluated; it does not reassociate `a + (b + c)` into `(a + b) + c`.

### Layout

- `noOverlap(arr)` — no two items intersect. Decided by lifting from `spaced` when the array is sorted along one axis with `gap >= 0`. Otherwise unknown.

## TS expressions the analyzer recognizes

These appear in code bodies (and in `@fit` text) and reduce to vocabulary claims.

- `arr.every(item => P(item))` — equivalent to a per-element claim.
- `arr.some(item => P(item))` — equivalent to existence (the dual of `every` under negation).
- `arr.filter(P).length` — count of items satisfying `P`. Bounded by `arr.length`; tightens when `P` is decidable on the element summary.
- `arr.map(item => …)` — preserves length, summarizes the new element type.
- `arr.reverse()` and `arr.sort(compare)` — preserve basic array facts but discard ordering and spacing facts.

No special `count(...)`, `forall(...)`, `exists(...)` syntax. Users write the array methods they already know.

## Outside

Listed explicitly. The analyzer reports these as unsupported rather than guessing.

- **Arbitrary-pair claims**: `for distinct i ≠ j: P(arr[i], arr[j])` where `i` and `j` aren't adjacent. Includes freely-positioned 2D non-overlap (boxes at arbitrary screen positions, e.g. physics simulations). The lifting rule above covers the sorted-axis sub-case; everything else is outside.
- **General polynomial inequalities**: `dx*dx + dy*dy <= r*r` and similar.
- **Transcendental shape claims**: bounds on `Math.sin(x)`, `Math.cos(x)`, `Math.pow(x, y)` beyond the trivial interval `[-1, 1]` or monotonic cases.
- **Set cardinality beyond catalog**: claims about cardinalities of intersections, unions, multisets that don't reduce to a `filter(p).length` form.
- **Calls and mutations without a written rule**: `sort()` without a comparison function is unsupported. Other operations Freerange cannot summarize leave the affected facts unknown.

## How to read a failure

When a claim fails, the report names which part of the vocabulary the analyzer was trying to use, what fact it was missing, and where that fact would have come from. If the claim isn't in the vocabulary at all, the report says so and points here.
