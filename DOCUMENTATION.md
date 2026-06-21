**DO NOT EDIT THIS DOC UNLESS THE USER SAYS SO**

Freerange seamlessly augments existing TypeScript types with extra info, for much more verifiability.

Among its use-cases, the biggest focus is to verify TS layout code through carrying proper ranges for numbers. This allows e.g. AI agents to easily verify that their layout rectangles don't overlap (or do overlap), is of certain min/max sizes, is, say, properly stack in a monotonically increasing fashion, etc.

Main usage:

```ts
/**
 * @fit
 * given min <= max
 * return >= min
 * return <= max
 */
function clamp(min: number, value: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

clamp(10, 5, 3)
```

```zsh
❯ fr check layout.ts
clampTest.ts:10:<top-level>
  FAIL: clamp(10, 5, 3): requires min <= max
  caller passed: min: 10, max: 3
  missing: 10 <= 3
```

## Features Overview

```ts
/** @fit
 * pure
 */
function hasPositiveArea(tile: {width: number; height: number}) {
  return tile.width > 0 && tile.height > 0
}

/** @fit
 * given photos.length: int 0..200
 * given availableWidth: 320..<2000
 * given photos[].naturalWidth > 0
 * return.tiles[].width > 0
 * return.tiles[].height > 0
 * return.tiles[$i].width <= photos[$i].naturalWidth
 * return.tiles[$i + 1].top >= return.tiles[$i].bottom
 * hasPositiveArea(return.tiles[])
 * nondecreasing(return.tiles.top)
 */
function layoutPhotos(availableWidth: number, photos: Photo[]) {
  const columnWidth = availableWidth / 3 // @fit > 0
  const tiles = []
  /** @fit
   * tiles.length == photos.length
   */
  for (const photo of photos) {
    tiles.push({top: 0, width: Math.min(columnWidth, photo.naturalWidth)})
  }
  return {
    columnCount: 3, // @fit 1 | 2 | 3
    tiles,
  }
}

/** @fit
 * cells.length: int 0..200
 * cells[].right >= cells[].left
 */
type PhotoGrid = {
  gap: number // @fit >= 0
  cells: {
    left: number
    right: number
    width: number // @fit > 0
  }[]
}
```

`given` lines are input assumptions. All other lines are for Freerange to prove to be true. `return` refers to the return value.
Inline `//` comments need to be on the same line as the type/value field, the function parameter, or the value declaration.
Block comments need to be above the function, type, and loop scope.
At top level, attached value/field comments and supported loop blocks work the same way as inside a function. Contracts inside a nested callback or other nested function are rejected instead of being silently skipped.
`items[]` means every item in an array. Use `$i` on left and right side of an operator to express matching positions across arrays. `$i + 1` works the way you think. Currently `[$i + 2]` and `[$i - 1]` aren't supported.
For operators, we support `==` `<` `>` `<=` `>=` but not yet `!=`
**You can call your regular TS functions in the `@fit` contract**! As long as they're considered "pure" by Freerange (see Purity section below) and can be interpreted.
`pure` belongs only in the `@fit` block above a function. Putting it on a loop is rejected because it describes the whole function's behavior, not a value to prove at one program point. If a called function has no available body, Freerange reports the purity claim as unknown instead of guessing.
An `@fit` line that's just a pure TS expression that returns a boolean, is checked by Freerange to be true, like `hasPositiveArea` and `nondecreasing` above (`nondecreasing` is a helper that comes with Freerange).

Syntax Glossary's at the end of the docs.

## Contracts API

Freerange checks the annotated function body, types, and their usages, to ensure the `@fit` contracts are upheld. Here's an example of a responsive 2D grid where the column count is calculated to be between 1 and 7, and each item's width is derived from that:

```ts
/** @fit
 * given availableWidth: int 160..Infinity
 * return: int 1..7
 */
function columnCount(availableWidth: number) {
  const preferredCellWidth = availableWidth >= 700 ? 320 : 160
  const rawColumnCount = Math.floor(availableWidth / preferredCellWidth)
  return Math.min(7, Math.max(1, rawColumnCount))
}

/** @fit
 * given items.length: int 0..200
 * given items[].preferredWidth: int 1..Infinity
 * given availableWidth: int 160..Infinity
 * return.cells.length == items.length
 * return.cells[].width > 0
 */
function layoutGrid(availableWidth: number, items: {preferredWidth: number}[]) {
  const columns = columnCount(availableWidth)
  const cellWidth = availableWidth / columns
  const cells = items.map(item => ({
    width: Math.min(item.preferredWidth, cellWidth),
    preferredWidth: item.preferredWidth,
  }))
  return {cells}
}
```

Given the input TS types and Freerange's extra specs, the function bodies and calls are analyzed through "abstract interpretation" and "symbolic execution", then checked against those specs.

Let's run `fr infer grid.ts`. Look at how much information Freerange captures, statically, for you and AI agents to verify:

```txt
grid.ts:columnCount
return:
  return: int 1..7
locals:
  preferredCellWidth: 160 | 320
  rawColumnCount: int 0..Infinity
checked:
  return: int 1..7
assumptions:
  given availableWidth: int 160..Infinity
redundant:
  return: int 1..7 (covered by return: int 1..7)

grid.ts:layoutGrid
return:
  return.cells.length == items.length
  return.cells.length: int 0..200
  return.cells[].preferredWidth == items[].preferredWidth
  return.cells[].preferredWidth: int 1..Infinity
  return.cells[].width: 1..Infinity
  return.cells follows items by index
locals:
  columns: int 1..7
  cellWidth: 22.857142857142858..Infinity
  cells.length == items.length
  cells.length: int 0..200
  cells[].preferredWidth == items[].preferredWidth
  cells[].preferredWidth: int 1..Infinity
  cells[].width: 1..Infinity
  cells follows items by index
checked:
  return.cells.length == items.length
  return.cells[].width > 0
assumptions:
  given items.length: int 0..200
  given items[].preferredWidth: int 1..Infinity
  given availableWidth: int 160..Infinity
redundant:
  return.cells.length == items.length (covered by return.cells.length == items.length)
  return.cells[].width > 0 (covered by return.cells[].width: 1..Infinity)
```

### Purity

```ts
/** @fit
 * pure
 */
function widthWithPadding(width: number, padding: number) {
  return width + padding * 2
}
```

A function marked as `pure` is checked for purity:
- it doesn't mutate arguments, `this`, or closure variables
- it doesn't read outside state that other code can change
- it doesn't do I/O, e.g. `console.log`
- it doesn't call nondeterministic APIs like `Date.now()` and `Math.random()`
- it doesn't call code whose behavior Freerange cannot inspect, e.g. an imported library that only has `.d.ts` and not original `.ts` files

Local mutations are allowed.

The purity check is **transitive**, aka every function that the annotated `pure` function calls, is checked too. These latter functions themselves don't need to be annotated; Freerange will just check them for you. In fact, you don't need to annotate a function as `pure` at all, unless you want to guarantee that it should stay so, when others modify that function in the future and make impure mistakes.

### Numerics

Freerange checks ranges and comparisons over ordinary numerical expressions:

```ts
width: 0..1000
index: int 0..<items.length
width * 2 + gap <= containerWidth
focusedIndex < items.length
columns: 5 | 6 | 7
```

Function `number` arguments checked by Freerange, by convenient default, exclude `-Infinity`, `Infinity` and `NaN` (unless annotated otherwise), since these 3 special values would invalidate most important proof statements (e.g. `NaN` breaks boolean comparison by always producing `false`, and `x - x` or `x * 0` can be `NaN` if `x` includes `Infinity`).

This includes addition, subtraction, multiplication by a known value, and division when the required facts about the divisor are known. Floating-point arithmetic follows JS evaluation and respects floating-point imprecision.

Freerange keeps up to 8 exact numeric alternatives. Beyond that, it keeps their overall range. E.g. `1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9` becomes `1..9`. Checks that only need the range can still pass. Checks that need the individual choices become `unknown` and report that the numeric-alternative limit was exceeded.

### Array

```ts
rows[].height: 0..40
rows[].top >= 0
rows[$i].height == items[$i].height
rows[$i].height == rows[$i + 1].height

rows.length == items.length
rows.length: int 0..200
```

`rows[].height: 0..40` means "the rows array, which contains objects with a field `height`, has that `height` between 0 and 40".
`$i` designates any item index. Reusing `$i` means the same position. Across differing arrays, their lengths must be proven equal.
`$i + 1` designates the next item, `$i - 1` the previous item, and are supported in direct comparisons with `$i` from the same array. You can't currently do `$i + 2`, or `$i + 1` across differing arrays.

Array elements require homogeneous (aka the same) contracts. To have differing contracts per array element, use tuples instead, just like you'd do it in regular TypeScript.

### Tuple

```ts
type Size = [width: number, height: number]

/** @fit
 * given size[0]: 1..2000
 * given size[1]: 1..2000
 * return[0] == size[1]
 * return[1] == size[0]
 */
function rotateSize(size: Size): [number, number] {
  return [size[1], size[0]]
}
```

Freerange supports TypeScript tuples, aka fixed-length arrays whose items can have different properties. Empty, named, mutable and readonly tuples are supported too; optional and rest elements inside tuples aren't supported.
Tuple facts follow the type used at each boundary. For example, `values` below becomes a regular array:

```ts
const size: [number, number] = [100, 80]
const values: number[] = size
```

Writing to an existing tuple position is supported. After `push`, `reverse`, or `sort`, Freerange treats it as a regular array. After `splice`, the mutated array becomes unknown.

### Boolean

```ts
return.width > 0 && !(return.height <= 0)
```

Supported checks can be combined with `&&` and negated with `!`. TODO: `||` is not supported yet.

### Built-Ins

We expose some useful functions in `@fit` comments:

```ts
nondecreasing(values: number[]): boolean // values in the array should prove to be bigger than or equal to their previous cell value
spaced(rows: {top: number; height: number}[], gap: number): boolean // each next row should prove to start after previous top + previous height + gap
lastEnd(rows: {top: number; height: number}[]): number // returns the final row's .top + .height; rows must prove non-empty
extentEnd(rows: {top: number; height: number}[], emptyValue: number): number // returns emptyValue for empty rows, otherwise the final row's .top + .height
noOverlap(rows)
```

### Custom Functions

```ts
function hasPositiveArea(tile: {width: number; height: number}) {
  return tile.width > 0 && tile.height > 0
}

/** @fit
 * hasPositiveArea(return.tiles[])
 */
function layoutPhotos() {
  return {tiles: [{width: 100, height: 80}]}
}
```

Freerange lets you invoke your own pure boolean functions in contracts! A call passes when Freerange proves it returns `true`, fails when it proves `false`, and remains unknown when Freerange cannot decide.
Not every pure function can be checked. Freerange reports `unknown` when the function uses an operation it cannot interpret yet, e.g. `includes`, `reduce`, or a `while` loop.

### Types

```ts
/** @fit
 * cells.length: int 0..200
 * cells[].right >= cells[].left
 */
type PhotoGrid = {
  gap: number // @fit >= 0
  cells: {
    left: number
    right: number
    width: number // @fit > 0
  }[]
}
```

Contracts on types are a convenience API to avoid repeating the same default `@fit` lines every time the type is used. They're inlined into the places that use them. If a type is used for function arguments, its contracts are automatically considered as `given`s (aka input assumptions). If it is used for the return value instead, its contracts are considered as things Freerange should infer and prove.

You cannot put a contract onto a generic (e.g. `T`) type argument unless TypeScript resolves it into a proper number in the end.

## Inference

To verify the contracts, Freerange does "inference" over the related code. Example:

```ts
/** @fit
 * given availableWidth: int 320..1200
 * return: 50..600
 */
function columnWidth(availableWidth: number) {
  const gap = 16

  if (availableWidth >= 600) return (availableWidth - gap * 2) / 3
  return (availableWidth - gap) / 2
}
```

Here, Freerange reads the `given` contract line plus the function body itself, and attempts to use various proof techniques to ensure that the returned value abides by the contract.

Freerange inferred lots of facts! Here's what we infer:
- Input facts, aka `given`s, are not proven from the function body. Freerange trusts them in the function, then checks them at visible call sites. Boolean givens like `given isValidLayout(input)` are kept as that exact fact. A few known built-ins, e.g. `given spaced(rows, gap)`, also add their documented row/order facts.
- Source calls follow JavaScript order: evaluate the receiver, then each written argument from left to right, once. Parameter defaults run in the called function only when the argument is omitted or `undefined`; a later default can read or change an earlier identifier or destructured binding. Exact tuple call spreads and function rest parameters are supported. Rest elements inside tuple types, unknown-length call spreads, and defaults inside destructuring parameters are reported as unsupported.
- Loop facts follow the values used when each expression ran. E.g. a segmented row loop may compute `bottom = top + height`, reset `height`, then set `nextTop = bottom + gap`; Freerange still derives the row-bottom identity and spacing from the captured values.
- Rechecking the same numeric operation still works after a branch narrows an input. Swapping the two operands of numeric `+` or `*` also names the same result; regrouping nested operations does not.
- Every returned field that's a number, be it array of numbers or object with nested number fields, gets their inferred range and number type, e.g. `0..<10` or `int 5..20`, and disjoint union values if applicable, e.g. `1 | 3 | 5` if the returned value is one of those 3 numbers inferred from some if-else in the function body.
- In the future, we can and might infer more convenience facts, such as `return.array1.length == return.array2.length`. But for now, to preserve a simple mental model and avoid bad surprises during code changes, we ask the user/agent to write those out explicitly in the function's `@fit` contracts.

Freerange comes out of the box understanding the relevant DOM and JS apis, e.g. it knows that `array.length` is `int 0..4294967295` (the JS cap) and DOM `element.offsetWidth` is `int 0..<Infinity`. Full glossary at the end of the docs.
It also understands useful `Math.*` calls. For example, it can prove `Math.floor(x) <= x`, `x < Math.floor(x) + 1`, `x <= Math.ceil(x)`, `Math.ceil(x) <= x + 1`, and `x - 0.5 <= Math.round(x) <= x + 0.5`. Claims follow how JS evaluates them: `x + 1` in a claim rounds like the code would, so the strict ceil bound holds as `<=`.

#### Branches

Freerange keeps values from the same if-else/ternary/switch branches together when their relationship matters:

```ts
function layout(pinned: boolean) {
  let left = 0
  let width = 100

  if (pinned) {
    left = 20
    width = 80
  }

  return {left, width}
}
```

This infers `{left: 0, width: 100} | {left: 20, width: 80}` instead of broadening each field separately to `{left: 0..20, width: 80..100}`.

Freerange keeps up to 8 branch states. Beyond that, it reports that the branch-state limit was exceeded, then only keeps facts that are uniformly true in every branch. This is to avoid combinatorial explosion of states later on.

#### Loops

Freerange tracks your loop and the consequences of each variable that the loop body affect. **TODO**: there's something about 32 ifs limit here. Document.

## Commands

```zsh
Usage:
  fr check [--annotations-only] [--audit] [file.ts ...]
  fr infer [--function name] [--annotations-only] [--all] file.ts ...
  fr infer --all
```

`fr check` checks your project for `@fit` contract correctness (you can also pass it one or more files to check). It reuses your existing TypeScript, so it understands `tsconfig.json`. Normal TypeScript errors are printed in TypeScript's usual format before any contract proving. Everything in the comments are type checked as well. If a contract has a TypeScript error, Freerange reports it and does not use that contract as an assumption or proof. A function with such an error is not proved from the remaining lines; unrelated top-level annotations are still checked.

Use `fr check --annotations-only` to check annotated places and skip the broader scan of unannotated code that calls annotated functions. Use `--audit` for cleanup advice: redundant `Math.min/max` choices, `if` branches, `??` fallbacks, etc.

`fr infer file.ts` shows the facts Freerange deduced for that file. It's like TypeScript's inferred-type hover, except for the layout facts in the file. Pass `--function funcName` to focus on just that function. Use `fr infer --all` for a project summary, or `fr infer --all file.ts` for the detailed all-function view of that file.

### Check Results

`fr check` reports four outcomes:

- `PASS`: Freerange proved the claim for every input allowed by its `given` lines.
- `FAIL`: Freerange proved the claim false. At a call, this also means the written arguments definitely violate a `given`.
- `REQUIRES`: a call needs a fact that its caller has not proved. Add a caller `given`, validate before the call, or pass a narrower value.
- `UNKNOWN`: Freerange could neither prove nor disprove the claim.

For example, given:

```ts
function hasPositiveWidth(box: {width: number}) {
  return box.width > 0
}
```

`hasPositiveWidth({width: 0})` fails. But `hasPositiveWidth({width})`, where `width` is only known to be a number (but no more info), is `unknown`.

## Glossary

### Syntax

```ts
@fit // marker for a Freerange spec block. Put it immediately above a named function, named `const` arrow/function expression, anonymous default export, class method/getter, or supported loop.
// block form for function, loop, and type contract blocks:
/**
 * @fit
 * ...
 */
given width: 0..1000 // input assumption. Think precondition, not proof.
given this.width: 0..1000 // input assumption for an instance method/getter.
given min <= max // input relation. Supported comparisons are `==`, `>=`, `<=`, `>`, and `<`.
given isValidLayout(input) // input boolean assumption. Freerange trusts it inside and checks callers.
return.width: 0..320 // check fact. Freerange must prove this from source.
bottom >= top // bare check relation. Freerange must prove this from source.
2 // exact-number shorthand for 2..2.
a..b // JavaScript number in the inclusive interval from a to b.
a..<b // JavaScript number from a up to, but not including, b.
a<..b // JavaScript number above a, up to and including b. The `<` excludes the endpoint it touches; read the dots as the value: a < x <= b.
a<..<b // JavaScript number strictly between a and b.
int a..b // integer in the inclusive interval from a to b.
int a..<b // integer from a up to, but not including, b.
int a<..b // integer above a: `int 0<..10` is the integers 1..10.
0..<Infinity // any finite double at least 0: excluding Infinity caps at Number.MAX_VALUE.
-Infinity<..<Infinity // any finite double, sign included. Also excludes NaN — NaN satisfies no comparison. Mind the difference from -Infinity<..Infinity, whose inclusive upper end still admits Infinity.
0 | 40 | 200 // exact finite numeric set.
0..10 | 20..30 // numeric alternatives. The value must fit one branch of the union.
low() | high() // pure expression union.
return: {left: 0, width: 20..100} | {left: 20, width: 80} // whole returned object union
return: TileBox<{width: 10..20}> // type aliases, interfaces, generics, and type-only imports declared in your source can be used in whole-value specs.
width: number, // @fit 0..1000 // param shorthand for `given width: 0..1000`.
width: number, // @fit >= min // param shorthand for `given width >= min`.
// @fit 0..100 // local/field/return shorthand for proving the attached value is in a range.
// @fit <= max // local/field/return shorthand for proving the attached value `<= max`.
height: number // @fit 0..40 // required type-field contract, reused at explicit typed boundaries.
items[] // every item in one anonymous collection.
items[$i] // same-index label. Reusing `$i` means matching positions across collections, when lengths are proven equal.
items[$i + 1] // adjacent label form. Currently supports monotone checks and adjacent row relations the checker inferred from a sequence loop.
items[$i - 1] // similar to above
nondecreasing(rows.top) // built-in check: each next row top is at least the previous row top.
isValidLayout(return) // pure boolean call. Freerange must prove it returns true.
spaced(rows, gap) // built-in check: adjacent rows are separated by previous height plus `gap`.
lastEnd(rows) // built-in expression: the end of the final row. Needs rows proven non-empty.
extentEnd(rows, top) // built-in expression: `top` when rows are empty, otherwise the end of the final row.
return // the returned value of a function-level spec.
```

### Inference Built-Ins

```ts
array.length: int 0..4294967295
element.clientWidth/clientHeight/scrollWidth/scrollHeight: int 0..<Infinity
element.offsetWidth/offsetHeight: int 0..<Infinity
canvas.width/height: int 0..<Infinity
image.width/height/naturalWidth/naturalHeight: int 0..<Infinity
video.width/height/videoWidth/videoHeight: int 0..<Infinity
pictureInPictureWindow.width/height: int 0..<Infinity
screen.width/height/availWidth/availHeight: int 0..<Infinity
window.innerWidth/innerHeight/outerWidth/outerHeight: int 0..<Infinity
innerWidth/innerHeight/outerWidth/outerHeight: int 0..<Infinity
resizeObserverSize.inlineSize/blockSize: 0..Infinity
visualViewport.width/height: 0..<Infinity
Math.floor/ceil/round/trunc(value) // inferred result ranges, non-strict order preservation, and ordinary rounding-loss bounds
Math.PI/E/LN10/LN2/LOG10E/LOG2E/SQRT1_2/SQRT2
Math.pow(base, exponent), Math.cbrt/fround/f16round/clz32(value), Math.imul(left, right) // inferred result ranges; clz32 and imul use coarse integer ranges unless inputs are exact
Math.exp/expm1/log/log2/log10/log1p/asin/acos/atan/sinh/asinh/tanh/acosh/atanh(value) // inferred ranges for monotone numeric functions, with domain checks where JS would otherwise produce NaN
Number.isFinite/isNaN/isInteger/isSafeInteger(value) // guards that refine numeric values
```

```ts
array.push(value) // appends one value and returns the new length
array.at(-k) // k must be an inline positive integer; proves length >= k, then returns the matching tuple slot or array item type
array.map((item, index, array) => value) // returns one output item per input item
array.filter((item, index, array) => keep) // returns an order-preserving subset
array.reverse() // keeps length and item ranges, but drops row-order facts
array.sort(compare) // keeps length and item ranges, but drops row-order facts
array.splice(start, deleteCount, ...items) // mutates the array; Freerange makes it unknown
```
