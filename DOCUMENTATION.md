# Freerange Documentation

Freerange is a static checker for strict `@fit` comments over ordinary TypeScript. It is intentionally small: comments state facts, source code earns them, and reports say where proof stopped.

The first big use-case is UI layout, because layout bugs are easy for agents to write and hard to verify from screenshots alone. The same approach should grow beyond layout: data-to-view cardinality, hit targets, scroll anchoring, text ranges, animation bounds, and other small invariants that matter in UI code.

## Glossary

```ts
@fit // marker for a Freerange spec block. Put it immediately above a function declaration, or above a supported loop when the fact belongs to that loop.
given width: 0..1000 // trusted input fact. Think precondition, not proof.
result.width: 0..320 // check fact. Freerange must prove this from source.
a..b // JavaScript number in the inclusive interval from a to b.
int a..b // integer in the inclusive interval from a to b.
items[] // every item in one collection. Freerange supports one wildcard collection side per comparison today.
result // the returned value of a function-level spec.
loop spec // a `@fit` block above a supported loop. It names locals directly; there is no `result`.
source-proved // earned from TypeScript source, branch facts, or a checked helper contract.
trusted // accepted from a `given` line.
unknown // not proven. This is not a soft pass.
fail // proven outside the requested range, or proven false.
helper contract // a helper function's own `@fit` block, proven once and used as the call-site summary.
imported contract // an exported helper contract from local source, reached through TypeScript module resolution.
atom // a named layout fact like `nondecreasing(rows.top)`, `spaced(rows, gap)`, or `extentEnd(rows, top)`.
infer // the dev x-ray: `bun run infer path --function name`. It prints curated facts the checker already knows.
shape-diff // the dev x-ray for TypeScript shape piggybacking. It shows object/array shape TypeScript knows that Freerange did not get from its own source reader.
```

## Adoption

When adding Freerange to existing code, start with code that is already trying to be pure: sizing helpers, layout model functions, hit-testing helpers, row builders, scroll math, and small imported math utilities.

Good first targets:

- a helper that clamps or centers a value
- a function returning `{width, height}`, `{rows, bottom}`, or `{items, contentHeight}`
- a loop that pushes one output item per input item
- a `map` that preserves length
- a helper used by several layout functions

Bad first targets:

- DOM mutation, rendering, or canvas/WebGL code
- app event handlers with many side effects
- string parsers, markdown walkers, and large switches
- layout code that is only understandable after executing browser APIs
- a giant function where the useful proof boundary should be a helper

Adoption pass:

1. Run `bun run infer path/to/file.ts --function name` before writing comments. Let the checker show what it already knows. If a report looks like a shape problem, run `bun run shape-diff path/to/file.ts --function name` to see whether TypeScript already knows the missing object/array structure.
2. Add `given` lines only for input domains the source cannot prove: viewport ranges, item dimensions, index bounds, positive counts, and non-negative gaps.
3. Add a small number of high-value checks. Prefer facts that would catch real agent mistakes: preserved length, non-negative sizes, bounds inside a parent, monotone positions, and final extents.
4. If the code shape is unsupported, do not contort the whole function. Extract a small pure helper or leave the function alone for now.
5. If a loop has a local `@fit`, use `infer` to see which loop checks are already source-proved. Keep explicit checks when they are useful documentation; remove them when they are only noise.
6. When a report is `unknown`, decide which bucket it belongs to: missing input fact, unsupported source shape, helper boundary needing a contract, or a real missing proof feature.

The goal is not to annotate everything. The goal is to make important UI code harder for an agent to silently break.

## A First Check

Put `@fit` immediately above a function declaration:

```ts
/** @fit
 * given width: 0..1000
 * result.capped: 0..320
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
  trusted from function @fit: given width: 0..1000
  read from code: rows[].index >= 0
  branch fact from code: width - 320 <= 0
  source-proved imported contract: layout-math.ts#clampWidth: result: 0..320
```

That distinction matters. Facts from `given` are promises. Facts from code, branch splits, and imported contracts are earned from source.

## Input Facts

Use `given` for the input domain:

```ts
/** @fit
 * given containee: 0..1000
 * given container: 0..1000
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
given width: 0..1000
given item.height: 0..40
given items[].height: 0..40
```

Comparison `given` lines can use simple arithmetic over input paths:

```ts
given container >= containee + padding
given index < items.length
```

They cannot call methods, index arrays by a local index, or put derived expressions on the range side:

```ts
// Not accepted as input facts.
given width + 1: 0..10
given items[index] >= 0
given width.toString() == 10
```

Freerange also rejects the obvious impossible inputs:

```ts
/** @fit
 * given width: 500..400
 */
function impossible(width: number) {
  return width
}

/** @fit
 * given width >= 100
 * given width <= 50
 */
function impossibleComparison(width: number) {
  return width
}

/** @fit
 * given left >= middle
 * given middle >= right
 * given right > left
 */
function impossibleChain(left: number, middle: number, right: number) {
  return {left, middle, right}
}
```

Loop-level `given` works the same way, but is trusted from that point in the function forward.

## Ranges

```ts
/** @fit
 * given width: 0..1000
 * given items.length: int 0..100
 * result.x: 10..20
 * result.index: int 0..9
 */
```

`a..b` means a JavaScript number in that interval. `int a..b` also says the value is an integer.

Ranges can describe object fields and array items:

```ts
/** @fit
 * given item.height: 0..40
 * given items[].height: 0..40
 * result.rows[].height: 0..40
 */
```

`items[]` means every item in `items`.

Nested array paths are fine when there is only one collection side:

```ts
/** @fit
 * given sections[].rows[].height: 0..40
 * given maxHeight: 40..100
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

Most comparisons are numeric. One non-numeric equality is supported because it falls out of normal source shape: the exact same object or array expression can equal itself through the returned structure.

```ts
/** @fit
 * result.rows == input.rows
 */
function carryRows(input: {rows: {height: number}[]}) {
  return {rows: input.rows}
}
```

Freerange does not compare array contents or object fields recursively for equality. It only proves the same source expression.

The checker carries small linear facts from ranges and comparisons:

```ts
/** @fit
 * given content: 0..1000
 * given padding: 0..100
 * given width: 0..1200
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
 * given width: 0..1000
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
 * given value: 4..14
 * result: 5..15
 */
function addOne(value: number) {
  return value + 1
}

/** @fit
 * given width: 0..10
 * result: 5..15
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
 * given width: 0..1000
 * result: 0..320
 */
export function clampWidth(width: number) {
  return Math.min(width, 320)
}

// card.ts
import {clampWidth} from './layout-math'

/** @fit
 * given width: 0..1000
 * result: 0..320
 */
function cardWidth(width: number) {
  return clampWidth(width)
}
```

Freerange follows named imports that TypeScript resolves to local `.ts`, `.tsx`, `.mts`, or `.cts` source files. That includes relative imports and `tsconfig` `paths` aliases. It proves the imported function's own contract from source, then uses that contract at the call site. It can also read exported numeric constants from those local modules. It does not inline imported function bodies.

TypeScript shape is a separate, weaker kind of help. If TypeScript knows an imported type alias, utility type, generic instantiation, or helper return is an object or array, Freerange can use that structure so paths like `result.rows.length` are meaningful. That does not prove numeric domains. An imported helper still needs a source-proved `@fit` contract before its result can satisfy `result.width: 0..320` or `result.height >= 0`.

Optional and nullable properties stay conservative:

```ts
type MaybeRows = {
  rows?: {height: number}[]
}

/** @fit
 * result.rows.length >= 0
 */
function maybeRows(input: MaybeRows) {
  return {rows: input.rows}
}
```

Freerange reports this as unknown because `rows` may be absent.

When an import boundary cannot be used, the report says which bucket it fell into:

```txt
imported helper contract was not available
helper: clampWidth from ./layout-math
reason: resolved to layout-math.ts#clampWidth, but that function has no @fit contract

imported helper contract failed in source before this call could trust it
helper: clampWidth from ./layout-math
failed check: layout-math.ts:clampWidth: result: 0..320
```

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
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given index: int 0..49
 * given index < items.length
 * result: 0..40
 */
function indexedPerItemField(items: {height: number}[], index: number) {
  return items[index]!.height
}
```

Supported today:

- `items.length`
- `items[]: 0..400`
- `items[].height: 0..40`
- array literal length and item values
- `[...items, value]` length
- bounded literal indexing
- `items[index]` when `index` is proven integer and `0 <= index < items.length`
- `items.map(item => expression)` and `items.map((item, index) => expression)` for length, item fields, and map index facts
- simple block-bodied `items.map(...)` callbacks with local `const` bindings and a `return`
- conditional push length, e.g. `rows.length <= items.length`

`map` support is deliberately tiny:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * result.rows.length == items.length
 * result.rows[].height: 0..40
 */
function mapRows(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}
```

The callback must have an item parameter and optional index parameter. Expression bodies work. Tiny block bodies also work when they are just local `const` bindings plus a `return`; this keeps normal code normal without turning callbacks into a public Freerange language.

Array mutation is conservative. `reverse()` and `sort()` keep length and item domains, but drop row-order facts like `nondecreasing`, `spaced`, `lastEnd`, and `extentEnd`. `splice()` and indexed assignment make length and item facts unknown.

## Scalar Loops

Freerange supports narrow accumulator shapes:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * result: 0..2000
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
 * given items.length: int 0..50
 * given items[].height: 0..40
 * result: 0..2000
 */
function visibleHeight(items: {height: number; visible: boolean}[]) {
  let total = 0
  for (const item of items) {
    if (item.visible) total += item.height
  }
  return total
}
```

Simple min/max accumulators work when the assignment keeps the same target on one side:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].width: 0..80
 * result: 0..80
 */
function widest(items: {width: number}[]) {
  let maxWidth = 0
  for (const item of items) {
    maxWidth = Math.max(maxWidth, item.width)
  }
  return maxWidth
}
```

This is useful when the increment or candidate range is known. It is not general reducer support:

```ts
items.reduce(...)
total = total + item.height
Math.max(...items.map(item => item.width))
```

Those should land only when real code needs them, not as public `sum(map(...))` syntax.

## Row Loops

This is the main layout shape today:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * result.rows.length == items.length
 * result.rows[].height: 0..40
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
- `rows[].height: 0..40`
- `nondecreasing(rows.top)` when the cursor increment is non-negative
- `spaced(rows, gap)` when the cursor advances by `height + gap`
- `lastEnd(rows) == bottom` when rows are known non-empty
- `extentEnd(rows, top) == bottom` when the source has the same empty fallback

`lastEnd(rows)` means the end of the final row. It only works when the rows are known non-empty.

`extentEnd(rows, top)` means `top` for empty rows, otherwise the end of the final row. Use this for stacks that can be empty.

The indexed loop shape is also supported:

```ts
/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * result.rows.length == items.length
 * result.rows[].index: int 0..49
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
 * given params.items.length: int 1..50
 * given params.items[].height: 0..40
 * given params.top: 0..1000
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
 * given items.length: int 0..50
 * given items[].height: 0..40
 * result.rows.length <= items.length
 * result.rows[].height: 0..40
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
   * given items[].height: 0..40
   * rows.length == items.length
   * rows[].height: 0..40
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
- obvious TypeScript shapes through a small provider: arrays, readonly arrays, object type literals, local and imported interfaces/type aliases, utility types like `Pick`, generic instantiations, unions, intersections, and helper return shapes
- numeric top-level constants
- `const` / `let` locals with initializers
- `return expression`
- ternaries
- return-style `if` guards
- direct same-file function calls
- same-file return type shapes when a helper body is outside the source subset
- named imports of exported numeric constants and `@fit` function declarations when TypeScript resolves them to local source
- TypeScript-known imported object/array shape, without treating it as a source-proved helper contract
- explicit named re-exports of source-proved `@fit` function declarations
- object literals with normal properties, shorthand properties, and object spread
- `as` / `satisfies` wrappers
- array literals, spread, `.length`, bounded indexing
- expression-bodied `items.map(...)`, plus tiny block-bodied callbacks with local `const` bindings and `return`
- simple `for...of` scalar running sums with direct or guarded `+=`
- simple scalar min/max accumulators like `maxWidth = Math.max(maxWidth, item.width)`
- append-only `for...of` row loops
- simple indexed `for` loops over `items.length`, including current-item aliases and cursor updates
- one guarded conditional push inside a `for...of`
- shared-factor arithmetic like `a * scale <= b * scale` when the checker can prove the factor is non-negative
- conservative invalidation for `reverse`, `sort`, `splice`, and indexed assignment
- conservative skipping for unsupported indexed-style `for` loops whose header and body are read-only except for roots Freerange forgets

Anything outside this surface should become `unknown`, not a fake proof.

## Missing On Purpose

Not supported yet:

- browser runs, screenshots, runtime traces, sampled sweeps
- package imports, declaration-only imports, namespace/default imports, or wildcard `export *` barrels as source-proved `@fit` helper contracts
- classes, methods, async, generators
- destructured params, rest params, default params
- general TS control-flow narrowing, overload semantics, and generic value reasoning
- general closures or callback reasoning
- strings, booleans, branded types, and semantic narrowing beyond structural object/array shape
- public lambdas, `forall`, filters, arbitrary folds, prose-as-truth
- geometry names like `rectInside`, `rectEquals`, `nonOverlapX`, `nonOverlapY`
- Pretext text facts
- table/grid/flex column negotiation
- general loops
- general nonlinear arithmetic beyond the small named shapes above

This list should shrink through source inference first and public syntax second. If ordinary TypeScript already says the thing clearly, Freerange should understand the code instead of asking the user to write a cleverer comment.
