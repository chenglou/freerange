# Freerange

Static `@fit` checks for ordinary TypeScript layout code.

The checker reads function source plus strict `@fit` comments. It proves the comments from source, or reports `fail` / `unknown`. It does not run app code, open browsers, take screenshots, sample cases, or compare fixtures.

Annotations are erased like TS types.

The public DSL should stay boring. Use ranges, comparisons, field paths, wildcard paths, and a small catalog of named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, aliases, or prose-as-truth. The checker can use quantifier-ish machinery internally; users should not write traversals.

## Run

```sh
bun run test
```

That checks the positive patterns in [patterns.ts](./patterns.ts) and the stable negative messages in [negative-patterns.ts](./negative-patterns.ts).

To inspect another file:

```sh
bun verify.ts path/to/file.ts
```

## Write A Spec

Put a `@fit` block immediately above a function declaration:

```ts
/** @fit
 * given width: number[0, 1000]
 * result.capped: number[0, 320]
 * result.overflow >= 0
 */
function cappedOverflow(width: number) {
  const capped = Math.min(width, 320)
  return {capped, overflow: width - capped}
}
```

This is not prose. Unsupported lines are parser errors.

`given` lines are input assumptions. Bare lines are facts the checker must prove.

Put a `@fit` block immediately above a supported `for...of` when the fact belongs to that loop:

```ts
function stackRows(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let y = top
  /** @fit
   * given items[].height: number[0, 40]
   * rows.length == items.length
   * rows[].height: number[0, 40]
   * nondecreasing(rows.top)
   * spaced(rows, gap)
   * lastEnd(rows) == y - gap
   */
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height + gap
  }
  return {rows, bottom: y - gap}
}
```

The same marker is used for functions and loops; placement decides the scope. Loop specs use the same language. `given` facts are trusted from that point forward. Bare lines are checked after the loop. Name local values directly; loop specs do not have `result`, and loop `given` lines can only describe function inputs, not loop-built values like `rows` or mutable cursors like `y`.

## Annotation Language

Ranges:

```ts
given width: number[0, 1000]
given items.length: int[0, 100]
result.x: number[10, 20]
result.index: int[0, 9]
```

`number[...]` means any real-ish JS number in that interval. `int[...]` also requires integer-ness.

Comparisons:

```ts
given container >= content
given index < items.length
result.left == (container - content) / 2
result.right > result.left
```

Supported comparison operators: `==`, `>=`, `<=`, `>`, `<`.

Sequence atoms:

```ts
nondecreasing(result.rows.top)
spaced(result.rows, gap)
lastEnd(result.rows) == result.bottom
```

Only `nondecreasing` and `spaced` are atoms today. `lastEnd(rows)` and `extentEnd(rows, emptyValue)` are expression helpers, so use them inside comparisons.

Future names should be explicit, not cute. E.g. prefer `nondecreasing` over `monotone`, and do not accept aliases unless the second word means a different fact.

## Design Direction

The long-term shape is a layout constraint catalog, not a theorem language.

Good public facts:

```ts
rows[].height: number[0, 40]
rows[].top + rows[].height <= parent.bottom
nondecreasing(rows.top)
spaced(rows, gap)
extentEnd(rows, top) == bottom
```

Bad public facts:

```ts
forall adjacent(rows, (prev, next) => next.top == prev.top + prev.height + gap)
sum(rows.map(row => row.height + gap)) <= availableHeight
```

Views are likely the future escape hatch for field-name pressure:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

Views are not implemented yet. When they land, they should only map fields; they should not assert layout facts.

## What `given` Does

Use `given` for the function's required input domain:

```ts
/** @fit
 * given containee: number[0, 1000]
 * given container: number[0, 1000]
 * given container >= containee
 * result >= 0
 */
function centeredOffset(containee: number, container: number) {
  return (container - containee) / 2
}
```

Top-level `given` lines are trusted input facts. They can name function parameters and top-level numeric constants. They cannot name `result` or locals created inside the function; those facts must be proved from source.

The checker also rejects impossible input facts:

```ts
/** @fit
 * given width: number[500, 400]
 */
function impossible(width: number) {
  return width
}
```

When a verified same-file helper is called, its `given` lines become things the caller must prove:

```ts
/** @fit
 * given value: number[4, 14]
 * result: number[5, 15]
 */
function addOne(value: number) {
  return value + 1
}

/** @fit
 * given width: number[0, 10]
 * result: number[5, 15]
 */
function caller(width: number) {
  return addOne(width + 4)
}
```

This tracking is same-file and transitive. Imports are not followed yet.

## Source Subset

The checker understands a small pure subset:

- function declarations
- simple named parameters
- numeric top-level constants
- `const` / `let` locals with initializers
- `return expression`
- ternaries
- return-style `if` guards
- direct same-file function calls
- object literals with normal or shorthand properties
- array literals, array spread, `.length`, and bounded literal indexing
- expression-bodied `items.map(...)` for length and field domains
- append-only `for...of` loops, including running-sum rows and conditional push
- simple indexed `for` loops over `items.length`
- conservative array mutation handling for `reverse`, `sort`, `splice`, and indexed assignment

Unsupported source becomes `unknown`; unsupported annotation syntax is an error.

## Number Math

Arithmetic:

- `+`, `-`, unary `+`, unary `-`
- `*`
- `/`, only when the divisor range excludes zero
- `%`, only for non-negative values and positive divisors
- `**`, currently useful for non-negative squares and constant bases

Math calls:

- `Math.floor`
- `Math.ceil`
- `Math.round`
- `Math.trunc`
- `Math.abs`
- `Math.sqrt`, only over non-negative ranges
- `Math.min`
- `Math.max`

Known facts include:

- `Math.floor(x) <= x`
- `Math.ceil(x) >= x`
- `Math.ceil(total / count) * count >= total`, when `total >= 0` and `count > 0`
- `Math.floor(pointer / cellSize) < count`, when `pointer < count * cellSize` and `cellSize > 0`
- `index % count < count`, when `index >= 0` and `count > 0`
- multiplying both sides by the same known non-negative value preserves `<=`
- dividing both sides by the same known positive value preserves `<=`

`Math.min` / `Math.max` keep small local branch facts:

```ts
/** @fit
 * given width: number[0, 1000]
 * result.overflow >= 0
 */
function overflow(width: number) {
  const capped = Math.min(width, 320)
  return {overflow: width - capped}
}
```

That works because either `capped == width`, or `capped == 320` and `width >= 320`.

## Linear Facts

The checker carries tiny linear facts from ranges and comparisons.

This proves ordinary slack:

```ts
/** @fit
 * given content: number[0, 1000]
 * given padding: number[0, 100]
 * given width: number[0, 1200]
 * given width >= content + padding
 * result >= 0
 */
function remaining(width: number, content: number) {
  return width - content
}
```

It is not a full linear solver. It reduces a few known non-negative facts, bounded by a small depth.

## Arrays

Supported today:

- `given items.length: int[0, 100]`
- `given row.height: number[0, 40]`
- `given items[]: number[0, 400]`
- `given items[].height: number[0, 40]`
- wildcard comparisons with one collection side and one scalar side, e.g. `rows[].top + rows[].height <= parent.bottom`
- nested wildcard paths on that one collection side, e.g. `sections[].rows[].height <= maxHeight`
- reading `items.length`
- reading object fields with declared domains
- reading `items[index].height` after `0 <= index < items.length`
- array literal length
- array literal element values
- `[...items, value]` length
- `items.map(item => ...)` length and item fields
- conditional push length, e.g. `rows.length <= items.length`
- index checks when the index is proven integer and `0 <= index < array.length`

Example:

```ts
/** @fit
 * given items.length: int[0, 100]
 * given index: int[0, 100]
 * given index < items.length
 * result.index < items.length
 */
function keepIndex(items: number[], index: number) {
  return {index}
}
```

Array mutation is deliberately conservative. `reverse()` and `sort()` keep length and item domains, but drop sequence facts like `nondecreasing`, `spaced`, and `lastEnd`. `splice()` and indexed assignment make length and item facts unknown.

Not supported yet:

- two wildcard collections in one comparison, e.g. `rows[].top <= boxes[].bottom`
- precise facts after `splice()` or indexed assignment
- arbitrary indexed values from unknown arrays

## Running Sums

The first loop primitive is this shape:

```ts
/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 * nondecreasing(result.rows.top)
 * spaced(result.rows, gap)
 * extentEnd(result.rows, top) == result.bottom
 */
function stackRows(items: Item[], top: number, gap: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: item.height, source: item})
    y += item.height + gap
  }
  const bottom = rows.length === 0 ? top : y - gap
  return {rows, bottom}
}
```

It proves:

- `rows.length == items.length`
- `nondecreasing(rows.top)`, when the increment is non-negative
- `spaced(rows, gap)`, when the increment is `height + gap`
- `lastEnd(rows)`, when the input length is known non-empty and each pushed row has `top` and `height`
- `extentEnd(rows, top)`, when the code uses the same empty fallback

It also accepts a scalar row height and `y += rowHeight`, which means `spaced(rows, 0)`.

Conditional push proves `rows.length <= items.length` and row field domains. It does not claim equal length.

## Results

Each check is:

- `pass`: proven
- `fail`: proven false or outside the requested range
- `unknown`: the checker could not prove it

`unknown` is real. It is not a soft pass.

Failure reports say whether a useful fact was trusted from `@fit` or read from code:

```txt
known:
  trusted from function @fit: given width: number[0, 1000]
  read from code: width - 320 <= 0
```

## Missing On Purpose

Not supported yet:

- browser runs, screenshots, runtime traces, sampled sweeps
- imports or module summaries
- classes, methods, closures, async, generators
- destructured params, rest params, default params
- TS type narrowing, generics, overloads
- strings, booleans, unions, branded types
- geometry atoms: `rectInside`, `rectEquals`, `nonOverlapX`, `nonOverlapY`
- Pretext text facts
- table/grid/flex column negotiation
- general loops
- general nonlinear arithmetic

If you need a guarantee and it is in this list, add a pattern first. Prefer one positive pattern and one negative message.

## Add New Support

Use [patterns.ts](./patterns.ts) as the runnable catalog. Put one clear good example there.

Use [negative-patterns.ts](./negative-patterns.ts) for the matching bad example, and update [negative-patterns.expected.txt](./negative-patterns.expected.txt).

Then run:

```sh
bun run test
bun check
```

Keep the guarantee static. Red probes are fine while designing a fact, but do not commit runtime evidence as the verifier's proof.

Before adding a public atom, write down:

- what it means
- what it does not imply
- the source shape that proves it
- the failure message it should produce
- why the name is not demo-specific

Prefer growing source inference before growing public syntax.
