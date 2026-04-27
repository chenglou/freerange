# Freerange Documentation

Freerange is a static checker for strict `@fit` comments over ordinary TypeScript.

The first big use-case is UI layout, because layout bugs are easy for agents to write and hard to verify from screenshots alone. The same approach should grow beyond layout: data-to-view cardinality, hit targets, scroll anchoring, text ranges, animation bounds, and other small invariants that matter in UI code.

## Glossary

```ts
@fit // marker for a Freerange spec block. Put it immediately above a named function, named `const` arrow/function expression, anonymous default export, class method/getter, or supported loop.
given width: 0..1000 // input assumption. Think precondition, not proof.
given this.width: 0..1000 // input assumption for an instance method/getter.
return.width: 0..320 // check fact. Freerange must prove this from source.
2 // exact-number shorthand for 2..2.
a..b // JavaScript number in the inclusive interval from a to b.
a..<b // JavaScript number from a up to, but not including, b.
int a..b // integer in the inclusive interval from a to b.
0 | 40 | 200 // exact finite numeric set.
width: number, // @fit 0..1000 // param shorthand for `given width: 0..1000`.
width: number, // @fit >= min // param shorthand for `given width >= min`.
// @fit 0..100 // local/field/return shorthand for proving the attached value is in a range.
// @fit <= max // local/field/return shorthand for proving the attached value `<= max`.
items[] // every item in one anonymous collection.
items[$i] // same-index label. Reusing `$i` means matching positions across collections, when lengths are proven equal.
items[$i + 1] // adjacent label form. Currently supports monotone checks and adjacent row relations the checker inferred from a sequence loop.
return // the returned value of a function-level spec.
loop spec // a `@fit` block above a supported loop. It names locals directly; there is no `return`.
checked // an explicit `@fit` check Freerange verified from code.
assumptions // valid `given` lines in `infer` output.
unknown // not proven. This is not a soft pass.
fail // proven outside the requested range, or proven false.
helper contract // a helper function's own `@fit` block, proven once and used as the call-site summary.
imported contract // an exported helper contract from local source, reached through TypeScript module resolution or a local declaration map.
atom // a named layout fact like `nondecreasing(rows.top)`, `spaced(rows, gap)`, or `extentEnd(rows, top)`.
infer // `fr infer path --function name`. It prints facts Freerange inferred and shows which explicit checks are assumptions, checked, not-inferred, or redundant with the covering fact.
shape-diff // dev tool that compares object/array structure Freerange kept with structure TypeScript can see.
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

The working loop is: run `infer`, write the few comments that are product red
lines, run `check`, and use the report to see which fact the source did not
earn yet.

1. Run `fr infer path/to/file.ts --function name` before writing comments. Let the checker show what it already knows. If a report looks like a shape problem, run `bun run shape-diff path/to/file.ts --function name` to see whether TypeScript already knows the missing object/array structure.
2. Add input domains the source cannot prove: viewport ranges, item dimensions, index bounds, positive counts, and non-negative gaps. Put simple scalar domains and one-sided scalar relations on params with `// @fit`; keep object paths, array paths, and grouped relations in the function block.
3. Add a small number of high-value checks. Prefer facts that would catch real agent mistakes: preserved length, non-negative sizes, bounds inside a parent, monotone positions, and final extents.
4. If the code shape is unsupported, do not contort the whole function. Extract a small pure helper or leave the function alone for now.
5. Use `infer` to see which function and loop claims already pass from code. `redundant` means emitted inferred facts already cover the check; the output names the covering fact. Keep explicit checks when they are useful documentation and remove them when they are only noise.
6. When a report is `unknown`, decide which bucket it belongs to: missing input fact, unsupported source shape, helper boundary needing a contract, or a real missing proof feature.

The goal is not to annotate everything. The goal is to make important UI code harder for an agent to silently break.

## Commands

`fr check` is the normal proof command: it proves the claims you wrote. With
file args, it checks those files. With no args, it reads the nearest
`tsconfig.json` and checks that source set. On success it prints only the
summary:

```txt
fr check: 42 files, 115 pass, 0 fail, 0 unknown
```

Add `--calls` when you also want the callsite scan:

```sh
fr check --calls path/to/file.ts
```

This checks the claims you wrote first, then scans annotated helper calls more
broadly. `REQUIRES` is not a failed spec; it is a clue about where a caller may
need a `given`, a wrapper contract, or earlier validation. Definite bad calls
still fail.

`fr doctor` is the focused version of that second half. It skips checking written
claims and only prints the callsite scan, which is useful while adopting
Freerange in a file that does not have many claims yet.

`fr infer --function name path/to/file.ts` prints facts Freerange inferred about
the return, surviving locals, and supported loops. It also shows which explicit
comments are checked or assumed, which comments are redundant with inferred
facts, and which unsupported source spots blocked proof.

`fr scout --function helper path/to/file.ts` is an experimental read-only probe
for the "what if inferred helper facts mattered?" question. It tries simple
candidate facts like `return <= max`, prints the input facts those candidates
would need, then scans calls against those provisional requirements. This is
not a contract generator. It is intentionally noisier than `doctor`; use it to
study a helper, not to decide whether a file is correct.

When `check` or `doctor` prints a non-pass line, it also prints the next useful
adoption command when there is one. Usually that is the caller or failing
function's `fr infer --function ...` command; for `doctor REQUIRES` it is a
reminder to either add a caller fact, validate before the call, or wrap the
helper behind a narrower contract.

Failure reports point at the spec line when they can:

```txt
layout.ts:17:placeRows
  UNKNOWN return.rows[$i + 1].top >= return.rows[$i].bottom + gap
  need: rows[$i + 1].top >= rows[$i].bottom + gap
  known:
    assumed from input: given gap: 0..20
  missing: a sequence relation for adjacent row positions
```

For agents, the useful loop is `fr infer`, edit the smallest source/spec seam,
then `fr check`. Treat `missing:` as the next thing to prove or the next input
fact to say out loud.

## A First Check

Put `@fit` immediately above a named function, named `const` arrow/function expression, anonymous default export, or class method/getter:

```ts
/** @fit
 * return.capped: 0..320
 * return.overflow >= 0
 */
function cappedOverflow(
  width: number, // @fit 0..1000
) {
  const capped = Math.min(width, 320)
  return {capped, overflow: width - capped}
}
```

Param `// @fit` comments are input assumptions, exactly as if they were lifted to `given` lines in the function block. Use them for boring scalar domains and small scalar relations:

```ts
/** @fit
 * given min <= max
 * return: 0..100
 */
function clampToUiRange(
  value: number, // @fit 0..100
  min: number, // @fit 0..100
  max: number, // @fit 0..100
) {
  return Math.max(min, Math.min(value, max))
}
```

Attached comparisons use the annotated value as the left side:

```ts
function bounded(
  value: number, // @fit >= min
  min: number, // @fit 0..100
) {
  return value
}
```

Function-level `given` lines are still the right place for object paths, array paths, and relations that are clearer as a group:

```ts
/** @fit
 * given rows.length: int 0..100
 * given rows[].height: 0..40
 * given min <= max
 */
```

`given` lines and param inline facts describe inputs your function expects. They do not ask Freerange to audit the function body by themselves.

Bare lines and `return` lines are claims Freerange must prove from the source.

Unsupported annotation lines are errors. Unsupported source code becomes `unknown`.

For instance methods and getters, `this` is an input root:

```ts
class Rect {
  constructor(
    public top: number,
    public height: number,
  ) {}

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

Same-file calls like `rect.bottom` and `rect.area()` use the checked class-member contract too. The receiver becomes `this`, so a getter that says `given this.height: 0..1000` makes the caller prove `rect.height: 0..1000`.

## What Gets Checked

Freerange starts from claims, not from the whole file.

- `given ...` and param `// @fit ...` are boundary facts. They are checked at call sites and become assumptions inside the function, but they do not trigger body proof on their own.
- `return...`, bare comparisons, and atoms are function-level claims. They make Freerange evaluate enough of the body to prove the requested facts.
- Local, top-level variable, object-field, and return `// @fit ...` comments are targeted claims. Freerange proves that value and reports helper preconditions needed for that proof.
- Loop `@fit` blocks are targeted loop claims. Loop specs name locals directly; there is no `return` inside a loop.
- Helper preconditions are reported when the helper call is inside the value being proved. If the call cannot satisfy a `given`, the report prints the caller-side obligation, such as `missing at call site: 0 <= cols - w`. If an earlier unclaimed local stores a helper return, Freerange may still use the proven helper summary later, but only when that call's preconditions prove silently. Missing preconditions prevent the summary; they do not leak a private report line.

Freerange does not audit arbitrary top-level calls or unclaimed statements. A call like `clamp(4, 3, 2)` only produces a report when it is inside a function or inline value that Freerange is proving. This is enough to check a quick helper probe:

```ts
const probe = clamp(4, 2, 3) // @fit 2
```

So this is only a boundary contract:

```ts
function helper(
  width: number, // @fit 320..2000
) {
  return otherHelper(width)
}
```

And this asks for proof:

```ts
/** @fit
 * return: 0..100
 */
function helper(
  width: number, // @fit 320..2000
) {
  return otherHelper(width)
}
```

## Local Checks

When a fact belongs to one local value, keep it near that value:

```ts
function hitIndex(pointer: number, cellSize: number) {
  // @fit int 0..100
  const index = Math.floor(pointer / cellSize)
  const clamped = Math.min(index, 100) // @fit int 0..100
  return clamped
}
```

On locals, object fields, and returns, inline `@fit` is shorthand for the value it is attached to. A range checks the attached value's range. A leading comparison operator checks the attached value against the right side:

```ts
const index = focused - step // @fit >= 0
const capped = Math.min(width, maxWidth) // @fit <= maxWidth

return {
  width: container - padding * 2, // @fit 0..1200
  targetIndex: focused + step, // @fit < items.length
  rows: {
    count: rows.length, // @fit int 0..100
  },
}
```

There it is a check, not an input `given`. On params, the same small syntax means an input `given`: `// @fit 0..100` becomes `given param: 0..100`, and `// @fit >= min` becomes `given param >= min`. Inline comments can be written as a leading line/block comment or a trailing `//` side comment. Trailing block comments are not supported; use `// @fit ...` when the fact sits beside code. Object-field inline checks support simple identifier fields and nested object literals. Computed keys, methods, accessors, and spreads do not grow special annotation behavior.

Branch-local facts use ordinary TypeScript branches. Put the fact on the value made inside that branch; Freerange carries the `if` or ternary condition while checking it:

```ts
if (focused > 0) return focused - 1 // @fit >= 0
return focused // @fit == 0

return focused > 0
  ? {
    targetIndex: focused - 1, // @fit >= 0
  }
  : {
    targetIndex: focused, // @fit == 0
  }
```

Function-level `return` facts still mean every return after the branches are joined.
When branches produce distinct concrete values, the joined value can stay a small
finite set:

```ts
/** @fit
 * return: 0 | 100
 */
function tabOffset(isPinned: boolean) {
  return isPinned ? 0 : 100
}
```

Exact-operand ternaries written as hand-rolled min/max also keep their branch facts:

```ts
const capped = width < max ? width : max // like Math.min(width, max)
const raised = height < min ? min : height // like Math.max(height, min)
```

Simple side-effecting branches can fall through too. Freerange joins the two local environments after the `if`:

```ts
/** @fit
 * given width: 0..100
 * return: 0..100
 */
function pickWidth(width: number) {
  let chosen = 0
  if (width > 40) {
    chosen = width
  }
  return chosen
}
```

Those joined branch cases can feed later branches. A normal handwritten clamp can
therefore use assignments instead of expression-shaped `Math.min` / `Math.max`:

```ts
/** @fit
 * given max >= min
 * return >= min
 * return <= max
 */
function clamp(value: number, min: number, max: number) {
  let next = value
  if (next < min) next = min
  if (next > max) next = max
  return next
}
```

Guard branches that throw are treated as exits. The code after the `if` keeps the
facts from the surviving path:

```ts
/** @fit
 * given step: -10..10
 * return > 0
 */
function positiveStep(step: number) {
  if (step <= 0) throw new Error('step must be positive')
  return step
}
```

Assignments are conservative. Plain local assignment keeps the assigned value. Property/index assignment and unsupported scalar `+=` forget the changed root, so unrelated facts can still prove while stale facts about the mutated value cannot. Unsupported `while` / `do while` loops get the same treatment when their condition is side-effect-free and the body only mutates clear local roots.

## Reading Results

Each requested fact ends in one of three states:

- `pass`: proven
- `fail`: proven outside the requested range, or proven false
- `unknown`: not proven

`unknown` is not a soft pass. It usually means either the source shape is not supported yet, or the function needs another input fact.

A useful report says where facts came from:

```txt
known:
  assumed from input: given width: 0..1000
  inferred from code: rows[].index >= 0
  inferred from branch: width - 320 <= 0
  checked imported contract: layout-math.ts#clampWidth: return: 0..320
```

That distinction matters. Facts from `given` are promises. Facts from code, branch splits, and imported contracts are earned from source.

## Input Facts

Use `given` for the input domain:

```ts
/** @fit
 * given containee: 0..1000
 * given container: 0..1000
 * given container >= containee
 * return >= 0
 */
function centeredOffset(containee: number, container: number) {
  return (container - containee) / 2
}
```

Top-level `given` can name function parameters and top-level numeric constants, including named imported numeric constants from local source. It cannot name `return`, locals created inside the function, or mutable values produced while the function runs. Those facts need to be proven from source.

Range `given` lines name one input path:

```ts
given width: 0..1000
given item.height: 0..40
given items[].height: 0..40
given extent[1][0]: 0..1000
```

Comparison `given` lines can use simple arithmetic over input paths:

```ts
given container >= containee + padding
given index < items.length
given child.width <= extent[1][0] - extent[0][0]
```

Fixed tuple/array slots like `extent[1][0]` are input paths. Dynamic reads like `items[index]` are source expressions and need the index bounds proven from code. `given` lines cannot call methods, index arrays by a local index, or put derived expressions on the range side:

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

/** @fit
 * given left >= middle
 * given middle >= right
 * given right: 20..30
 * given left: 0..10
 */
function impossibleRangeChain(left: number, middle: number, right: number) {
  return {left, middle, right}
}
```

Loop-level `given` works the same way, but is assumed from that point in the function forward.

## Ranges

```ts
/** @fit
 * given width: 0..1000
 * given items.length: int 0..100
 * return.x: 10..20
 * return.index: int 0..9
 */
```

`a..b` means a JavaScript number in that inclusive interval. A single expression like `2` is shorthand for `2..2`. `int a..b` also says the value is an integer. `a..<b` makes the upper bound exclusive. A small `|` list means the value must be exactly one of those numeric choices:

```ts
index: int 0..<items.length
scale: 0..Infinity
modeOffset: 0 | 40 | 200 | 213
```

Lower-exclusive and open-ended range spellings are not part of the language right now. Use a comparison when that is the clearer fact:

```ts
given scale > 0
return > 0
```

Bounds can be numeric literals, `Infinity`, or the same simple input arithmetic accepted by `given` comparisons.

Ranges can describe object fields and array items:

```ts
/** @fit
 * given item.height: 0..40
 * given items[].height: 0..40
 * return.rows[].height: 0..40
 */
```

`items[]` means every item in `items`.

Nested array paths are fine when one collection is being discussed:

```ts
/** @fit
 * given sections[].rows[].height: 0..40
 * given maxHeight: 40..100
 * return.sections[].rows[].height <= maxHeight
 */
```

Anonymous `[]` does not guess what two collection sides mean:

```ts
// Not supported yet.
rows[].top <= boxes[].bottom
```

That could mean same index, all pairs, visible pairs, or something else. The syntax should say that before the checker accepts it.

The same collection can appear on both sides. That means every item in that
collection must satisfy the relation:

```ts
/** @fit
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 */
```

So `[]` stays the anonymous one-collection shorthand.

When you really mean same index, use a bound index label:

```ts
/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[$i].height == items[$i].height
 */
function sameIndexRows(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}
```

Reusing `$i` means the compared collections must have matching lengths. This is
not a TypeScript variable and it is not a numeric ghost parameter; it only binds
array positions inside the spec.

The first adjacent form is intentionally tiny. It can prove monotone neighboring
checks from an inferred `nondecreasing` row fact:

```ts
/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows[$i].top <= return.rows[$i + 1].top
 */
function monotoneRows(items: {height: number}[]) {
  const rows = []
  let y = 0
  for (const item of items) {
    rows.push({top: y, height: item.height})
    y += item.height
  }
  return {rows}
}
```

It can also consume an exact adjacent row relation when a supported loop proves
one:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given gap: 0..10
 * return.rows[$i + 1].top >= return.rows[$i].bottom + gap
 */
function spacedRows(items: {height: number}[], gap: number) {
  const rows = []
  let nextRowTop = 0
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    rowHeight = Math.max(rowHeight, items[i]!.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const top = nextRowTop
      const bottom = top + rowHeight
      rows.push({top, height: rowHeight, bottom})
      nextRowTop = bottom + gap
      rowHeight = 0
    }
  }
  return {rows}
}
```

This does not replace the named atoms. Prefer `nondecreasing(rows.top)` and
`spaced(rows, gap)` when those names express the intent better. Labels are the
escape hatch for specific red lines that do not deserve a public atom.

The adjacent path can be nested. If a loop pushes rows shaped like
`{rowRect: {top, height}}`, Freerange can prove
`nondecreasing(rows.rowRect.top)` and exact neighboring `rowRect.top` facts.
The pathless `spaced(rows, gap)`, `lastEnd(rows)`, and `extentEnd(rows, top)`
remain top-level row shorthands until views earn a real syntax.

## Comparisons

```ts
/** @fit
 * given container >= content
 * given index < items.length
 * return.left == (container - content) / 2
 * return.right > return.left
 */
```

Supported operators:

```ts
== >= <= > <
```

Most comparisons are numeric. One non-numeric equality is supported because it falls out of normal source shape: the exact same object or array expression can equal itself through the returned structure.

```ts
/** @fit
 * return.rows == input.rows
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
 * return >= 0
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
Math.sign
Math.min
Math.max
```

Some layout facts are built in because they show up everywhere:

```ts
Math.floor(x) <= x
Math.ceil(x) >= x
Math.ceil(total / count) * count >= total // when count > 0
Math.floor(pointer / cellSize) < count // when cellSize > 0 and pointer < count * cellSize
Math.floor(y / cell) * countX + Math.floor(x / cell) < countX * countY // when both coordinates are inside a positive integer grid
index % count < count
```

`Math.min`, `Math.max`, and `Math.sign` keep the small branch facts they introduce:

```ts
/** @fit
 * given width: 0..1000
 * return.overflow >= 0
 */
function overflow(width: number) {
  const capped = Math.min(width, 320)
  return {overflow: width - capped}
}
```

That works because either `capped == width`, or `capped == 320` and `width >= 320`. Freerange also recognizes the exact hand-written ternary form when the branches are the compared operands, such as `width < 320 ? width : 320`. For assignment-style code, it keeps small case splits across later `if` branches, which is enough for ordinary two-branch clamps. It does not treat arbitrary conditionals as min/max.

## Helpers

When a checked helper is called, its input facts become things the caller must prove:

```ts
/** @fit
 * given value: 4..14
 * return: 5..15
 */
function addOne(value: number) {
  return value + 1
}

/** @fit
 * given width: 0..10
 * return: 5..15
 */
function caller(width: number) {
  return addOne(width + 4)
}
```

Same-file helpers can still be read from source. If their own `@fit` contract is proven and the call satisfies its input facts, return facts like `return >= min` and `return <= max` also narrow the caller's local value. Same-file class methods and getters work the same way, with the receiver bound to `this`. Freerange keeps the caller's bottomed-out numeric expressions through local aliases and helper parameters, so a local `const max = cols - w` can satisfy a helper's `given min <= max` from `given w <= params.cols`. Reports and inferred facts use those caller-side expressions too: if the helper cannot prove `max >= min`, the caller sees `cols - w >= 0`, not a private helper name. It may use a proven summary even when the helper call was stored in an unannotated local before a later `@fit` check. It does not use the summary when the call preconditions are missing or false.

Tuple-shaped helper contracts work through destructuring too. A checked helper can promise `return.length == 4`, `return[2] >= 0`, and `return[3] >= 0`; a caller can write `const [, , offsetX, offsetY] = center(...)` and keep those slot facts.

Imported helpers use their exported `@fit` contract as the module boundary:

```ts
// layout-math.ts
/** @fit
 * given width: 0..1000
 * return: 0..320
 */
export function clampWidth(width: number) {
  return Math.min(width, 320)
}

// card.ts
import {clampWidth} from './layout-math'

/** @fit
 * given width: 0..1000
 * return: 0..320
 */
function cardWidth(width: number) {
  return clampWidth(width)
}
```

Freerange follows named imports, default imports, and namespace-qualified helper calls that TypeScript resolves to local `.ts`, `.tsx`, `.mts`, or `.cts` source files. That includes relative imports and `tsconfig` `paths` aliases. If TypeScript resolves a local workspace package to a declaration file, Freerange can use a single-source declaration map to recover the local source file. It proves the imported function's own contract from source, then uses that contract at the call site. It can also read named exported numeric constants from those local modules. It does not inline imported function bodies, and it never trusts `.d.ts` declarations as checked contracts.

Ordinary top-level `const` bindings of known helpers work too:

```ts
const {min, max} = Math
const clampValue = clampWidth
export default max
```

Every hop must be statically known: a top-level `const`, import, or export whose final target is a supported `Math` call, a same-file helper, or a local-source imported helper. Mutable helper bindings are not followed.

TypeScript shape is a separate, weaker kind of help. If TypeScript knows an imported type alias, utility type, generic instantiation, property-access call, namespace-imported call, or helper return is an object or array, Freerange can use that structure so paths like `return.rows.length` are meaningful. That does not prove numeric domains. An imported helper still needs a checked `@fit` contract before its return can satisfy `return.width: 0..320` or `return.height >= 0`.

Optional and nullable values stay conservative:

```ts
type MaybeRows = {
  rows?: {height: number}[]
}

/** @fit
 * return.rows.length >= 0
 */
function maybeRows(input: MaybeRows) {
  return {rows: input.rows}
}
```

Freerange reports this as unknown because `rows` may be absent.
If ordinary TypeScript control flow narrows the property first, Freerange can use
the narrowed shape at that expression:

```ts
/** @fit
 * return >= 0
 */
function guardedRowsLength(input: MaybeRows) {
  if (input.rows == null) return 0
  return input.rows.length
}
```

The same applies to optional numeric params. A guard that proves the undefined
side is gone lets normal math use the value:

```ts
function floorAtZero(max?: number) {
  if (typeof max !== 'undefined') {
    return Math.max(max, 0) // @fit >= max
  }
  return 0
}
```

For the common "use zero when absent" shape, nullish fallback is also numeric
when both sides are numeric:

```ts
function safeWidth(dimensions: {width?: number}) {
  return Math.max(dimensions?.width ?? 0, 0) // @fit >= 0
}
```

Freerange also keeps source facts for a nullable value made by a branch, but only
after an ordinary null guard proves the present side. The guard can name a local
or a property path:

```ts
/** @fit
 * given focused: int 0..50
 * return: int 0..49
 */
function previousIndex(focused: number) {
  const previous = focused > 0 ? focused - 1 : null
  if (previous == null) return 0
  return previous
}

/** @fit
 * given focused: int 0..50
 * return: int 0..49
 */
function previousFromState(focused: number) {
  const state = {
    previous: focused > 0 ? {targetIndex: focused - 1} : null,
  }
  if (state.previous == null) return 0
  return state.previous.targetIndex
}
```

When an import boundary cannot be used, the report says which bucket it fell into:

```txt
imported helper contract was not available
helper: clampWidth from ./layout-math
reason: resolved to layout-math.ts#clampWidth, but that function has no @fit contract

imported helper contract failed in source before this call could use it
helper: clampWidth from ./layout-math
failed check: layout-math.ts:clampWidth: return: 0..320
```

Explicit named re-export barrels work too:

```ts
export {clampWidth} from './layout-math'
export {clampWidth as cardClampWidth} from './layout-math'
```

This is intentionally small: package imports only work when TypeScript lands on local source or a declaration map points back to one local source file. Declaration-only imports without that source map, wildcard `export *` barrels, and unchecked summary files stay opaque.

## Arrays

Freerange understands the common array facts that layout code tends to need:

```ts
/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given index: int 0..49
 * given index < items.length
 * return: 0..40
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
- finite array/tuple element access like `return[2] >= 0`
- TypeScript-known required fixed tuple slots, including fixed length and per-slot shape
- optional/rest tuple shapes keep safe length ranges, but do not expose exact per-slot facts
- local and parameter array destructuring, including skipped tuple slots like `const [, , offsetX] = center`
- `[...items, value]` length
- bounded literal indexing; exact finite index cases like `0 | 2` only read those slots
- `items[index]` when `index` is proven integer and `0 <= index < items.length`
- symbolic reads like `items[focused]` keep the element domain but use the concrete path in reports; local adjacent sequence facts can specialize previous/current and current/next neighborhoods once bounds prove them live
- `items.at(-k)` for constant negative integer `k` when `items.length >= k`; dynamic `.at(index)` is not in the static subset yet
- Same-loop previous-last recurrences are not proven yet. `rows.at(-1)` and `rows[rows.length - 1]` are both kept conservative inside loop summaries so Freerange does not mistake the initial array for the evolving one.
- `items.map(item => expression)` and `items.map((item, index) => expression)` for length, item fields, and map index facts
- small block-bodied `items.map(...)` callbacks, including arrow or function-expression callbacks with local `const` bindings, side-effect-free return branches, and a final `return`
- `items.filter(item => predicate)` for same item fields and `filtered.length <= items.length`
- map/filter chains preserve the base origin fact for `fr infer`, so `items.filter(...).map(...)` is still reported as an order-preserving subset of `items`
- conditional push length in supported `for...of` and indexed loops, e.g. `rows.length <= items.length`
- same-index labels in comparisons, e.g. `rows[$i].height == items[$i].height`, when same-index collection lengths can be proven equal
- adjacent labels over one collection, e.g. `rows[$i].top <= rows[$i + 1].top` and inferred row-spacing relations like `rows[$i + 1].top >= rows[$i].bottom + gap`

Strict branch checks know integer steps. If `focused` is proven integer, `focused > 0` is enough to prove `focused - 1 >= 0`; `focused >= 0` is not. That matters for previous/next indices:

```ts
if (focused > 0) return items[focused - 1]!
```

`map` support is deliberately tiny:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[].height: 0..40
 */
function mapRows(items: {height: number}[]) {
  const rows = items.map(item => ({height: item.height}))
  return {rows}
}
```

The callback must have an item parameter and optional index parameter. Expression bodies work. Tiny block bodies also work when they are local `const` bindings, side-effect-free `if` branches that return, and a final `return`. That keeps normal code normal without turning callbacks into a public Freerange language.

`fr infer` also prints the immediate origin fact for maps, such as
`return.rows follows items by index`. It is an inferred fact, not a new public
annotation.

`filter` support is even smaller:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
function visibleRows(items: {height: number; visible: boolean}[]) {
  const rows = items.filter(item => item.visible)
  return {rows}
}
```

Freerange treats this as a subsequence: same item domain, length between zero and the source length. It does not prove `rows.length == items.length`, and it does not reason about the predicate beyond requiring a simple side-effect-free expression. `fr infer` prints this as an order-preserving subset fact.

Array mutation is conservative. `reverse()` and `sort()` keep length and item domains, but drop row-order facts like `nondecreasing`, `spaced`, `lastEnd`, and `extentEnd`. `splice()` and indexed assignment make length and item facts unknown.

## Scalar Loops

Freerange supports narrow accumulator shapes:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
 */
function totalHeight(items: {height: number}[]) {
  let total = 0
  for (const item of items) {
    total += item.height
  }
  return total
}
```

The update can also be a direct self-assignment when the added expression does
not read the accumulator:

```ts
total = total + item.height
total = Math.max(item.height, minHeight) + total
```

Guarded totals and counts work too:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * return: 0..2000
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
 * return: 0..80
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
total = Math.max(item.height, minHeight)
total += Math.max(total, item.height)
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
- `lastEnd(rows) == bottom` when rows are known non-empty
- `extentEnd(rows, top) == bottom` when the source has the same empty fallback

`lastEnd(rows)` means the end of the final row. It only works when the rows are known non-empty.

`extentEnd(rows, top)` means `top` for empty rows, otherwise the end of the final row. Use this for stacks that can be empty.

The indexed loop shape is also supported:

```ts
/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * return.rows.length == items.length
 * return.rows[].rowIndex: int 0..<items.length
 */
function indexedRows(items: {height: number}[]) {
  const rows = []
  for (let rowIndex = 0; rowIndex < items.length; rowIndex++) {
    rows.push({rowIndex, height: items[rowIndex]!.height})
  }
  return {rows}
}
```

The loop-index field does not have to be named `index`; Freerange follows the actual pushed field. The body may also bind the current item and advance a simple numeric cursor:

```ts
/** @fit
 * given params.items.length: int 1..50
 * given params.items[].height: 0..40
 * given params.top: 0..1000
 * return.rows.length == params.items.length
 * nondecreasing(return.rows.top)
 * lastEnd(return.rows) == return.bottom
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
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 */
function visibleRows(items: {height: number; visible: boolean}[]) {
  const rows = []
  for (const item of items) {
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}
```

The same weaker fact works in the supported indexed loop shape. The guarded block may also update a simple numeric cursor; the honest length fact is still `rows.length <= items.length`.

It does not claim equal length.

Segmented row loops can also prove the row-boundary shape when the guarded block
pushes one row, advances the next row cursor by `bottom + gap` or the equivalent
`top + height + gap`, and resets the per-row max:

```ts
/** @fit
 * given items.length: int 0..50
 * given items[].height: 0..40
 * given top: 0..1000
 * given gap: 0..10
 * return.rows.length <= items.length
 * return.rows[].height: 0..40
 * return.rows[].bottom == return.rows[].top + return.rows[].height
 * nondecreasing(return.rows.top)
 * spaced(return.rows, gap)
 */
function segmentedRows(items: {height: number}[], top: number, gap: number) {
  const rows = []
  let nextRowTop = top
  let rowHeight = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rowHeight = Math.max(rowHeight, item.height)
    if (i % 3 === 2 || i === items.length - 1) {
      const rowTop = nextRowTop
      rows.push({top: rowTop, height: rowHeight, bottom: rowTop + rowHeight})
      nextRowTop = rowTop + rowHeight + gap
      rowHeight = 0
    }
  }
  return {rows}
}
```

That still only proves what the source earns. It proves `rows.length <=
items.length`, not the exact row count or a `ceil(items.length / columns)` fact.

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

The marker is still `@fit`. Placement decides the scope. Loop specs name locals directly; there is no `return` inside a loop spec.

Loop `given` lines can describe function inputs. They cannot describe loop-built values like `rows` or mutable cursors like `y`.

## Supported Source

The checker understands a small pure subset:

- function declarations, named `const` arrow/function expressions, and anonymous default-exported function/arrow boundaries
- class methods and getters, with `this` as an input root for instance members
- simple named parameters and typed object/array destructuring parameters
- param inline `// @fit` domains and attached comparisons on simple identifier parameters
- obvious TypeScript shapes through a small bounded provider: arrays, readonly arrays, object type literals, local and imported interfaces/type aliases, utility types like `Pick`, generic instantiations, unions, intersections, property-access call shapes, namespace-imported structural call shapes, and helper return shapes
- numeric top-level constants
- `const` / `let` locals with initializers, including object and array binding patterns
- `return expression`, with optional inline range/comparison checks
- ternaries, including exact-operand min/max forms like `a < b ? a : b`
- return-style `if` guards, `throw` guards, and simple fall-through `if` / `else` branches
- branch-created and TypeScript-backed nullable values refined by ordinary `== null` / `!= null` guards, `typeof value !== 'undefined'` for optional values, and numeric `??` fallbacks such as `dimensions?.width ?? 0`
- plain local assignment, plus conservative forgetting for property/index assignment and unsupported scalar `+=`
- direct same-file function calls, class method calls, and class getter reads
- named pure calls only; function-valued parameters and arbitrary callbacks are not treated as callees with contracts
- same-file return type shapes when a helper body is outside the source subset
- named imports of exported numeric constants, plus named/default/namespace-qualified exported `@fit` functions when TypeScript resolves them to local source or a local declaration map recovers source; top-level `const` helper bindings can point at those same targets
- TypeScript-known imported object/array shape, without treating it as a checked helper contract
- explicit named re-exports of checked `@fit` functions
- object literals with normal properties, shorthand properties, and object spread
- `as` / `satisfies` wrappers
- array literals, spread, `.length`, bounded indexing
- symbolic element reads with concrete path reporting, plus previous/current and current/next specialization for inferred adjacent sequence facts
- expression-bodied `items.map(...)`, plus tiny block-bodied arrow/function callbacks with local `const` bindings, side-effect-free return branches, and `return`; TypeScript can fill structural callback return shape while source still owns the array length
- expression-bodied `items.filter(...)` as a subsequence summary with same item domain and length no larger than source length
- composed map/filter origin facts in `fr infer`
- simple `for...of` scalar running sums with direct or guarded `+=`
- append-only scalar-array pushes like `rows.push(y)` in a supported loop
- simple scalar min/max accumulators like `maxWidth = Math.max(maxWidth, item.width)`
- append-only `for...of` row loops
- simple indexed `for` loops over `items.length`, including current-item aliases and cursor updates
- simple numeric-limit indexed loops such as `for (let i = 0; i < limit; i++) values.push(i)`
- guarded conditional pushes inside supported `for...of` and indexed loops, including simple cursor updates in the guarded block
- guarded segmented row-boundary pushes that prove `bottom == top + height`, `nondecreasing(rows.top)`, `spaced(rows, gap)`, and exact adjacent row relations
- same-index labels in comparisons, plus adjacent `$i + 1` comparisons backed by inferred sequence facts
- shared-factor arithmetic like `a * scale <= b * scale` when the checker can prove the factor is non-negative
- conservative invalidation for `reverse`, `sort`, `splice`, and indexed assignment
- conservative skipping for unsupported indexed-style `for`, `while`, and `do while` loops whose conditions and bodies are read-only except for roots Freerange forgets

Anything outside this surface should become `unknown`, not a fake proof.

## Missing On Purpose

Not supported yet:

- browser runs, screenshots, runtime traces, sampled sweeps
- published package imports, declaration-only imports without a local source map, wildcard `export *` barrels, or unchecked summary files as checked `@fit` helper contracts.
- prototype-assigned JavaScript methods, async, generators
- rest params and default params
- general TS control-flow narrowing, overload semantics, and generic value reasoning
- higher-order call contracts, general closures, or callback reasoning
- strings, booleans, branded types, and semantic narrowing beyond structural object/array shape
- public lambdas, `forall`, arbitrary folds, prose-as-truth
- numeric ghost parameters like `0..$n`, all-pairs labels, source/id matching labels, and adjacent formulas not backed by an inferred sequence fact
- geometry names like `rectInside`, `rectEquals`, `nonOverlapX`, `nonOverlapY`
- Pretext text facts
- table/grid/flex column negotiation
- general loops
- general nonlinear arithmetic beyond the small named shapes above

This list should shrink through source inference first and public syntax second. If ordinary TypeScript already says the thing clearly, Freerange should understand the code instead of asking the user to write a cleverer comment.
