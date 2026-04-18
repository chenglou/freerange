# Freerange

Static `@fit` checks for ordinary TypeScript layout code.

Freerange reads your function source and the `@fit` comment above it. It proves the comment from the code, or tells you where it cannot. No browser, screenshots, traces, sampled cases, fixtures, or app-code execution. Just source in, facts out.

This is for the boring UI math that keeps coming back:

```ts
row.top + row.height <= parent.bottom
rows.length == items.length
rows[].height: number[0, 40]
nondecreasing(rows.top)
spaced(rows, gap)
extentEnd(rows, top) == bottom
```

The comments are meant to feel like TypeScript types for layout values: small, strict, erased, and close to the code.

## Install

```sh
bun install
```

## Run

```sh
bun run test
```

That checks the good examples in [patterns.ts](./patterns.ts) / [import-patterns.ts](./import-patterns.ts), plus the stable bad-example messages in [negative-patterns.ts](./negative-patterns.ts).

To inspect your own file:

```sh
bun run verify path/to/file.ts
```

For development:

```sh
bun run check
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the repo map.

## A First Check

Put `@fit` immediately above a function declaration:

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

`given` lines describe inputs your function expects. They are trusted, like function preconditions.

Bare lines are things Freerange must prove from the source.

Unsupported annotation lines are errors. Unsupported source code becomes `unknown`.

## Reading Results

Each requested fact ends in one of three states:

- `pass`: proven
- `fail`: proven outside the requested range, or proven false
- `unknown`: not proven

`unknown` is not a soft pass. It usually means either the source shape is not supported yet, or the function needs another input fact.

A useful report says where facts came from:

```txt
known:
  trusted from function @fit: given width: number[0, 1000]
  read from code: width - 320 <= 0
  source-proved imported contract: layout-math.ts#clampWidth: result: number[0, 320]
```

That distinction matters. Facts from `given` are promises. Facts from code and imported contracts are earned from source.

## Input Facts

Use `given` for the input domain:

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

Top-level `given` can name function parameters and top-level numeric constants, including named imported numeric constants from local source. It cannot name `result`, locals created inside the function, or mutable values produced while the function runs. Those facts need to be proven from source.

Range `given` lines name one input path:

```ts
given width: number[0, 1000]
given item.height: number[0, 40]
given items[].height: number[0, 40]
```

Comparison `given` lines can use simple arithmetic over input paths:

```ts
given container >= containee + padding
given index < items.length
```

They cannot call methods, index arrays by a local index, or put derived expressions on the range side:

```ts
// Not accepted as input facts.
given width + 1: number[0, 10]
given items[index] >= 0
given width.toString() == 10
```

Freerange also rejects the obvious impossible inputs:

```ts
/** @fit
 * given width: number[500, 400]
 */
function impossible(width: number) {
  return width
}
```

Loop-level `given` works the same way, but is trusted from that point in the function forward.

## Ranges

```ts
/** @fit
 * given width: number[0, 1000]
 * given items.length: int[0, 100]
 * result.x: number[10, 20]
 * result.index: int[0, 9]
 */
```

`number[...]` means a JavaScript number in that interval. `int[...]` also says the value is an integer.

Ranges can describe object fields and array items:

```ts
/** @fit
 * given item.height: number[0, 40]
 * given items[].height: number[0, 40]
 * result.rows[].height: number[0, 40]
 */
```

`items[]` means every item in `items`.

Nested array paths are fine when there is only one collection side:

```ts
/** @fit
 * given sections[].rows[].height: number[0, 40]
 * given maxHeight: number[40, 100]
 * result.sections[].rows[].height <= maxHeight
 */
```

Freerange does not guess what two collection sides mean:

```ts
// Not supported yet.
rows[].top <= boxes[].bottom
```

That could mean same index, all pairs, visible pairs, or something else. The syntax should say that before the checker accepts it.

So `[]` stays the anonymous one-collection shorthand. If a future fact needs two collections, it should name the relationship instead of asking `[]` to guess.

## Comparisons

```ts
/** @fit
 * given container >= content
 * given index < items.length
 * result.left == (container - content) / 2
 * result.right > result.left
 */
```

Supported operators:

```ts
== >= <= > <
```

The checker carries small linear facts from ranges and comparisons:

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

It is intentionally not a full algebra system. It proves the common layout slack first.

## Math

Supported arithmetic:

```ts
+ - * / % **
```

Division needs a divisor range that excludes zero. `%` is supported for non-negative values and positive divisors. `**` is currently useful for non-negative squares and constant bases.

Supported `Math` calls:

```ts
Math.floor
Math.ceil
Math.round
Math.trunc
Math.abs
Math.sqrt
Math.min
Math.max
```

Some layout facts are built in because they show up everywhere:

```ts
Math.floor(x) <= x
Math.ceil(x) >= x
Math.ceil(total / count) * count >= total
index % count < count
```

`Math.min` and `Math.max` keep the small branch facts they introduce:

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

## Helpers

When a checked helper is called, its input facts become things the caller must prove:

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

Same-file helpers can still be read from source. If their own `@fit` contract is proven, result facts like `result >= min` and `result <= max` also narrow the caller's local value.

Imported helpers use their exported `@fit` contract as the module boundary:

```ts
// layout-math.ts
/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
export function clampWidth(width: number) {
  return Math.min(width, 320)
}

// card.ts
import {clampWidth} from './layout-math'

/** @fit
 * given width: number[0, 1000]
 * result: number[0, 320]
 */
function cardWidth(width: number) {
  return clampWidth(width)
}
```

Freerange follows named imports that TypeScript resolves to local `.ts`, `.tsx`, `.mts`, or `.cts` source files. That includes relative imports and `tsconfig` `paths` aliases. It proves the imported function's own contract from source, then uses that contract at the call site. It can also read exported numeric constants from those local modules. It does not inline imported function bodies.

Explicit named re-export barrels work too:

```ts
export {clampWidth} from './layout-math'
export {clampWidth as cardClampWidth} from './layout-math'
```

This is intentionally small: package imports, declaration-only imports, namespace imports, default imports, and wildcard `export *` barrels stay opaque for now.

## Arrays

Freerange understands the common array facts that layout code tends to need:

```ts
/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * given index: int[0, 49]
 * given index < items.length
 * result: number[0, 40]
 */
function indexedPerItemField(items: {height: number}[], index: number) {
  return items[index]!.height
}
```

Supported today:

- `items.length`
- `items[]: number[0, 400]`
- `items[].height: number[0, 40]`
- array literal length and item values
- `[...items, value]` length
- bounded literal indexing
- `items[index]` when `index` is proven integer and `0 <= index < items.length`
- `items.map(item => expression)` for length and item fields
- conditional push length, e.g. `rows.length <= items.length`

`map` support is deliberately tiny:

```ts
/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 */
function mapRows(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}
```

The callback must be a one-parameter expression body. This is source inference, not a public callback language.

Array mutation is conservative. `reverse()` and `sort()` keep length and item domains, but drop row-order facts like `nondecreasing`, `spaced`, `lastEnd`, and `extentEnd`. `splice()` and indexed assignment make length and item facts unknown.

## Scalar Loops

Freerange supports narrow accumulator shapes:

```ts
/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result: number[0, 2000]
 */
function totalHeight(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total += item.height
  }
  return total
}
```

Guarded totals and counts work too:

```ts
/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result: number[0, 2000]
 */
function visibleHeight(items: {height: number; visible: boolean}[]) {
  let total = 0
  for (const item of items) {
    if (item.visible) total += item.height
  }
  return total
}
```

This is useful when the increment is known non-negative. It is not general reducer support yet:

```ts
items.reduce(...)
total = total + item.height
maxWidth = Math.max(maxWidth, item.width)
```

Those should land as source inference when real demos need them, not as public `sum(map(...))` syntax.

## Row Loops

This is the main layout shape today:

```ts
/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * given top: number[0, 1000]
 * given gap: number[0, 10]
 * result.rows.length == items.length
 * result.rows[].height: number[0, 40]
 * nondecreasing(result.rows.top)
 * spaced(result.rows, gap)
 * extentEnd(result.rows, top) == result.bottom
 */
function stackRows(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let y = top
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height + gap
  }
  const bottom = rows.length === 0 ? top : y - gap
  return {rows, bottom}
}
```

Freerange proves:

- `rows.length == items.length`
- `rows[].height: number[0, 40]`
- `nondecreasing(rows.top)` when the cursor increment is non-negative
- `spaced(rows, gap)` when the cursor advances by `height + gap`
- `lastEnd(rows) == bottom` when rows are known non-empty
- `extentEnd(rows, top) == bottom` when the source has the same empty fallback

`lastEnd(rows)` means the end of the final row. It only works when the rows are known non-empty.

`extentEnd(rows, top)` means `top` for empty rows, otherwise the end of the final row. Use this for stacks that can be empty.

The indexed loop shape is also supported:

```ts
/** @fit
 * given items.length: int[1, 50]
 * given items[].height: number[0, 40]
 * result.rows.length == items.length
 * result.rows[].index: int[0, 49]
 * result.rows[].index < items.length
 */
function indexedRows(items: {height: number}[]) {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    rows.push({index: i, height: items[i]!.height})
  }
  return {rows}
}
```

The body may also bind the current item and advance a simple numeric cursor:

```ts
/** @fit
 * given params.items.length: int[1, 50]
 * given params.items[].height: number[0, 40]
 * given params.top: number[0, 1000]
 * result.rows.length == params.items.length
 * nondecreasing(result.rows.top)
 * lastEnd(result.rows) == result.bottom
 */
function indexedStackRows(params: {items: {height: number}[]; top: number}) {
  const rows = []
  let y = params.top
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i]!
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows, bottom: y}
}
```

Conditional push gets a weaker, honest fact:

```ts
/** @fit
 * given items.length: int[0, 50]
 * given items[].height: number[0, 40]
 * result.rows.length <= items.length
 * result.rows[].height: number[0, 40]
 */
function visibleRows(items: {height: number; visible: boolean}[]) {
  const rows = []
  for (const item of items) {
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}
```

It does not claim equal length.

## Loop Specs

Put `@fit` immediately above a supported loop when the fact belongs to that loop:

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

The marker is still `@fit`. Placement decides the scope. Loop specs name locals directly; there is no `result` inside a loop spec.

Loop `given` lines can describe function inputs. They cannot describe loop-built values like `rows` or mutable cursors like `y`.

## Supported Source

The checker understands a small pure subset:

- function declarations
- simple named parameters
- numeric top-level constants
- `const` / `let` locals with initializers
- `return expression`
- ternaries
- return-style `if` guards
- direct same-file function calls
- named imports of exported numeric constants and `@fit` function declarations when TypeScript resolves them to local source
- explicit named re-exports of source-proved `@fit` function declarations
- object literals with normal or shorthand properties
- array literals, spread, `.length`, bounded indexing
- expression-bodied `items.map(...)`
- simple `for...of` scalar running sums with direct or guarded `+=`
- append-only `for...of` row loops
- simple indexed `for` loops over `items.length`, including current-item aliases and cursor updates
- one guarded conditional push inside a `for...of`
- conservative invalidation for `reverse`, `sort`, `splice`, and indexed assignment

Anything outside this surface should become `unknown`, not a fake proof.

## Missing On Purpose

Not supported yet:

- browser runs, screenshots, runtime traces, sampled sweeps
- package imports, declaration-only imports, namespace/default imports, or wildcard `export *` barrels
- classes, methods, async, generators
- destructured params, rest params, default params
- TS type narrowing, generics, overloads
- general closures or callback reasoning
- strings, booleans, unions, branded types
- public lambdas, `forall`, filters, arbitrary folds, prose-as-truth
- geometry names like `rectInside`, `rectEquals`, `nonOverlapX`, `nonOverlapY`
- Pretext text facts
- table/grid/flex column negotiation
- general loops
- general nonlinear arithmetic

When something on this list earns its way in, add the smallest useful pattern first. Prefer one positive example and one negative message.

## Add New Support

[patterns.ts](./patterns.ts) and [import-patterns.ts](./import-patterns.ts) are the runnable catalog of good examples.

[negative-patterns.ts](./negative-patterns.ts) and [negative-import-patterns.ts](./negative-import-patterns.ts) have the bad examples. Their expected reports live in [negative-patterns.expected.txt](./negative-patterns.expected.txt).

For a new guarantee:

1. Add the smallest good pattern.
2. Add a bad pattern with a useful expected message.
3. Run:

```sh
bun run test
bun run check
```

Before adding a public name, write down:

- what it means
- what it does not imply
- what source shape proves it
- what the report should say when it fails
- why the name is not demo-specific

Prefer better source inference before more public syntax. If ordinary TypeScript already says the thing clearly, make Freerange understand that code instead of asking the user to write a cleverer comment.
