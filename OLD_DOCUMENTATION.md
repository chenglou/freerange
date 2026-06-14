# Old Documentation Notes

Salvage pile. Bits to pluck into `DOCUMENTATION.md` on the next pass. Each section here is something the main doc currently doesn't cover.

## Where To Start

Good first targets:

- a helper that clamps or centers a value
- a function returning `{width, height}` or `{rows, bottom}`
- a loop that pushes one output item per input item
- a `map` that preserves length

Bad first targets:

- event handlers with side effects
- string parsers, markdown walkers, large switches
- huge functions where the real proof boundary should be a smaller helper

Don't annotate everything. Annotate the layout math an agent could silently break.

## Class Members

For instance methods and getters, `this` is an input root:

```ts
class Rect {
  constructor(public top: number, public height: number) {}

  /** @fit
   * given this.top: 0..1000
   * given this.height: 0..1000
   * return == this.top + this.height
   */
  get bottom() {
    return this.top + this.height
  }
}
```

Same-file calls like `rect.bottom` and `rect.area()` reuse the checked contract. The receiver becomes `this`, so a getter saying `given this.height: 0..1000` makes the caller prove `rect.height: 0..1000`.

## What Gets Checked

Two kinds of `@fit` lines, with different jobs:

- `given ...` and param `// @fit ...` are **input facts**. They are checked where the function is called, then assumed inside.
- `return ...`, bare relations, and built-in calls like `nondecreasing(...)` are **checks**. They make Freerange interpret enough of the body to prove the requested thing.

Local, top-level, field, and return `// @fit ...` are local checks. The attached value is what gets proven.

Loop `@fit` blocks are loop checks. They name locals directly; no `return` inside a loop.

Helper preconditions get reported separately. If a helper says `given min <= max` and the caller can't prove it, the report distinguishes the helper requirement, what the caller passed, and the caller-side missing relation, e.g. `missing: cols - w >= 0`.

A call like `unannotatedHelper(4, 3, 2)` has no contract to check. A call like `clamp(4, 3, 2)` does.

## Reading Reports

Four statuses:

- `pass` — proven
- `fail` — proven false
- `unknown` — not proven, but not proven false either. Usually means the known facts still admit good and bad cases, or the source shape isn't supported, or an input fact is missing.
- `requires` — a helper call needs a precondition the caller hasn't proven

A useful report names where each fact came from:

```txt
known:
  assumed from input: given width: 0..1000
  inferred from code: rows[].index >= 0
  inferred from branch: width - 320 <= 0
  checked imported contract: layout-math.ts#clampWidth: return: 0..320
```

`given` facts are promises. Code, branch, and imported facts are earned.

## Inline Local Checks

Keep the check next to the value:

```ts
function hitIndex(pointer: number, cellSize: number) {
  const index = Math.floor(pointer / cellSize) // @fit int 0..100
  const clamped = Math.min(index, 100) // @fit int 0..100
  return clamped
}
```

On params, the same syntax means an input `given`. On locals, fields, and returns, it means a check. A range like `// @fit 0..100` checks the attached value's range. A leading operator like `// @fit <= maxWidth` checks the attached value against the right side.

## Type-Field Contracts

```ts
/** @fit
 * k > b
 */
type Spring = {
  pos: number
  dest: number
  k: number // @fit > 0
  b: number // @fit > 0
}
```

A param typed `Spring` arrives with `given spring.k > 0`, `given spring.b > 0`, and `given spring.k > spring.b`. A function returning `Spring`, or a local typed `Spring`, must prove those.

Type contracts can name nested array paths: `rows[].bottom >= rows[].top`. Shorthand comments on fields inside `rows: {...}[]` become `rows[].height: 0..40`. Optional fields stay conservative on purpose: presence-dependent contracts need a separate "if present" model.

## Branch-Local Facts

Put the check on the value made inside the branch:

```ts
if (focused > 0) return focused - 1 // @fit >= 0
return focused // @fit == 0
```

Function-level `return` facts still mean every return after branches join.

Repeated `let` reassignments inside `if` keep correlated values. If one branch gives `x = 1, y = 10` and the other gives `x = 2, y = 20`, `x + y` later is `11 | 22`, not the invented cross-product `12 | 21`.

Freerange keeps up to 8 reachable branch states. Past that, it keeps facts identical in every branch, forgets facts that differ, and reports the state-partition budget. Checks needing the forgotten facts become `unknown`.

Guard branches that `throw` are treated as exits. Code after the `if` keeps the surviving path's facts.

## Assignment And Mutation

Plain local assignment keeps the assigned value. Property/index assignment and unsupported scalar `+=` forget the changed root, so unrelated facts can still prove while stale facts about the mutated value cannot. Unsupported `while` / `do while` get the same treatment when the condition is side-effect-free and the body only mutates clear local roots.

## Comparisons Compose

If source or checked helper contracts give `a <= b` and `b <= c`, Freerange uses that to prove `a <= c`. Strict checks still need a strict edge somewhere in the chain.

Shared factors use the sign Freerange can prove. Non-negative factor preserves non-strict order; positive factor can be cancelled; negative factor flips order:

```ts
content <= available
// proves content * scale <= available * scale when scale >= 0

content * scale <= available * scale
// proves content <= available when scale > 0

content <= available
// proves available * scale <= content * scale when scale < 0
```

## Math Built-Ins

```ts
Math.floor(x) <= x
Math.ceil(x) >= x
Math.floor(a) <= Math.floor(b)  // when a <= b
Math.ceil(a) <= Math.ceil(b)    // when a <= b
Math.ceil(total / count) * count >= total  // when count > 0
index % count < count
```

`Math.min`, `Math.max`, and `Math.sign` keep small branch facts. `Math.min(width, 320)` means either `capped == width`, or `capped == 320 and width >= 320`. The hand-written form `width < 320 ? width : 320` is recognized as the same thing.

## Helper Calls

Imported helpers use their exported `@fit` contract as the boundary. Freerange follows named imports, default imports, namespace-qualified calls, and `export *` barrels when TypeScript lands on a local `.ts`/`.tsx`/`.mts`/`.cts` source. It does not inline imported bodies, and it never trusts `.d.ts` as a checked contract.

Re-export forms:

```ts
export {clampWidth} from './layout-math'
export {clampWidth as cardClampWidth} from './layout-math'
export * from './layout-math'
```

Top-level rebindings work when every hop is statically known:

```ts
const {min, max} = Math
const clampValue = clampWidth
export default max
```

When an import boundary can't be used, the report names which case:

```txt
imported helper contract was not available
helper: clampWidth from ./layout-math
reason: resolved to layout-math.ts#clampWidth, but that function has no @fit contract
```

## Optionals

```ts
type MaybeRows = { rows?: {height: number}[] }

function maybeRows(input: MaybeRows) {
  return {rows: input.rows}  // unknown: rows may be absent
}

function guardedRowsLength(input: MaybeRows) {
  if (input.rows == null) return 0
  return input.rows.length  // ok
}
```

Same for optional numeric params:

```ts
function floorAtZero(max?: number) {
  if (typeof max !== 'undefined') return Math.max(max, 0) // @fit >= max
  return 0
}

function safeWidth(d: {width?: number}) {
  return Math.max(d?.width ?? 0, 0) // @fit >= 0
}
```

A nullable made by a branch keeps its source facts after the null guard:

```ts
function previousIndex(focused: number) {
  const previous = focused > 0 ? focused - 1 : null
  if (previous == null) return 0
  return previous  // int 0..49 when given focused: int 0..50
}
```

## Arrays

Supported:

- `items.length`, `items[]`, `items[].field`, array literal length
- tuple/product fixed-slot reads like `tuple[2]`
- typed tuple slots, including required fixed length and shape; optional/rest stay safe but don't expose per-slot facts
- destructuring with skipped slots: `const [, , offsetX] = center`
- `[...items, value]` length
- length-bearing constructors: `new Array(count)`, `new Int8Array(count)`
- `items[index]` when `index` is proven integer and `0 <= index < items.length`
- `items.at(-k)` for tuple/product values with constant negative `k` and known length
- `items.map(...)` expression bodies and tiny block bodies with `const` locals, side-effect-free `if`/`return`, and a final `return`
- `items.filter(...)` as an order-preserving subset with same item domain and `filtered.length <= items.length`; expression and one-line `return` block predicates carry true-side facts
- map/filter chains preserve the base origin fact

Mutation is conservative. `reverse()` and `sort()` keep length and item domains but drop row-order facts. `splice()` and indexed assignment make length and item facts unknown.

Strict branch checks know integer steps. If `focused` is proven integer, `focused > 0` proves `focused - 1 >= 0`; `focused >= 0` does not.

## Same-Index And Adjacent Labels

```ts
return.rows[$i].height == items[$i].height
return.rows[$i].top <= return.rows[$i + 1].top
return.rows[$i + 1].top >= return.rows[$i].bottom + gap
```

Reusing `$i` means matching positions when lengths are proven equal. `$i + 1` is an adjacent label; it's not a TS variable. `$i + 2` and `$i - 1` aren't supported.

Adjacent labels work when an inferred sequence fact backs them (monotone from `nondecreasing(rows.top)`, exact spacing from a supported segmented loop).

## Loops — Scalar Accumulators

Running sums:

```ts
function totalHeight(items: {height: number}[]) {
  let total = 0
  for (const item of items) total += item.height
  return total  // 0..2000 when items[].height: 0..40 and items.length: int 0..50
}
```

The update can also be self-assignment when the added expression doesn't read the accumulator: `total = total + item.height` or `total = Math.max(item.height, minHeight) + total`.

Guarded totals and counts:

```ts
function visibleHeight(items: {height: number; visible: boolean}[]) {
  let total = 0
  for (const item of items) if (item.visible) total += item.height
  return total
}
```

Min/max accumulators when the assignment keeps the same target on one side:

```ts
function widest(items: {width: number}[]) {
  let maxWidth = 0
  for (const item of items) maxWidth = Math.max(maxWidth, item.width)
  return maxWidth
}
```

Not general reducer support. `items.reduce(...)`, `total = Math.max(item.height, minHeight)`, and `Math.max(...items.map(...))` aren't proven.

## Loops — Row Stacks

The main layout shape:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 * extentEnd(return.rows, top) == return.bottom
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
- `lastEnd(rows) == bottom` when rows are non-empty
- `extentEnd(rows, top) == bottom` when the source has the same empty fallback

Indexed-loop variant:

```ts
for (let i = 0; i < items.length; i++) {
  const item = items[i]!
  rows.push({top: y, height: item.height})
  y += item.height
}
```

The loop-index field doesn't have to be named `index`; Freerange follows the actual pushed field.

Conditional push gets a weaker but honest fact: `rows.length <= items.length`. It doesn't claim equal length.

Segmented row loops can prove row-boundary shape when the guarded block pushes one row, advances the next-row cursor by `bottom + gap` (or `top + height + gap`), and resets the per-row max.

## Loop Specs

Put `@fit` directly above the loop when the fact belongs there:

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

Placement decides scope. Loop specs name locals directly; no `return`. Loop `given` can describe function inputs but not loop-built values like `rows` or cursors like `y`.

## Supported Source

Small pure subset:

- function decls, named `const` arrow/function expressions, anonymous default-exported boundaries
- immediately-invoked arrow/function with surrounding locals
- class methods and getters, `this` as input root
- simple named params, typed object/array destructuring params, param inline `// @fit`
- default-param fall-through for omitted or `undefined`/optional trailing args
- source-backed type-field comments on required fields (line and block forms)
- bounded TS shape: arrays, readonly arrays, object literals, local/imported interfaces and type aliases, `Pick`/etc., generic instantiations, unions, intersections, property-access call shapes
- finite TS literal domains for string literals and booleans, discriminant narrowing through branches
- top-level `const` literals of numbers, strings, booleans, `null`, plain object/array
- `const`/`let` with initializers, destructuring binding
- `return expression`, with optional inline range/comparison
- ternaries, including exact-operand min/max forms
- return-style `if` guards, `throw` guards, state-partitioned fall-through branches, small finite-literal `switch`
- nullable refinement via `== null`, `!= null`, `typeof !== 'undefined'`, and numeric `??`
- plain local assignment; conservative forgetting for property/index assignment and unsupported `+=`
- same-file calls, class method/getter reads
- named pure calls only; function-valued params and callbacks aren't callees-with-contracts
- imports of `const` literals and `@fit` functions/methods/getters when TypeScript resolves to local source (relative, `tsconfig` paths, declaration-map recovery)
- `as` / `satisfies` wrappers
- array literals, spread, `.length`, summarized items, bounded indexing, tuple slot reads
- length-bearing array constructors with one length argument
- expression-bodied `map` and `filter`, tiny block-bodied callbacks
- composed map/filter origin facts
- simple `for...of` running sums with direct or guarded `+=`
- append-only scalar-array pushes
- simple min/max accumulators
- append-only `for...of` and simple indexed `for` loops over `items.length`
- numeric-limit indexed loops like `for (let i = 0; i < limit; i++)`
- guarded conditional pushes inside supported loops, including simple cursor updates
- guarded segmented row-boundary pushes (`bottom == top + height`, `nondecreasing`, `spaced`, exact adjacent relations)
- same-index labels in comparisons; adjacent `$i + 1` backed by inferred sequence facts
- shared-factor arithmetic when the factor sign is proven
- conservative invalidation for `reverse`, `sort`, `splice`, indexed assignment
- explicit rejection of unsupported loop forms

Anything outside this should be `unknown`, not a fake pass.

## Missing On Purpose

- published package imports, declaration-only imports without a source map, or unchecked summary files as checked `@fit` contracts
- async, generators, prototype-assigned methods
- rest params, destructured default params
- type-field contracts on optional fields, declaration-only imported types, computed fields, index signatures, mapped types, generic substitution, cross-scope relation names
- general TS control-flow narrowing, overload semantics, generic value reasoning
- higher-order call contracts, general closures, callback reasoning
- broad strings, string operations, branded types, semantic narrowing beyond finite literal/object/array shape
- public lambdas, `forall`, arbitrary folds
- numeric ghost params like `0..$n`, all-pairs labels, source/id labels, adjacent formulas not backed by an inferred sequence fact
- geometry names like `rectInside`, `nonOverlapX`
- table/grid/flex column negotiation
- general loops
- nonlinear arithmetic beyond the small named shapes

This list shrinks through source inference first and public syntax second.
