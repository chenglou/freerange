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

## Commands

```zsh
Usage:
  fr check [--annotations-only] [--audit] [file.ts ...]
  fr infer [--function name] [--annotations-only] [--all] file.ts ...
  fr infer --all
```

`fr check` checks your project for `@fit` contract correctness (you can also pass it one or more files to check). It reuses your existing TypeScript, so it understands `tsconfig.json`. Normal TypeScript errors are printed in TypeScript's usual format before any contract proving. Everything in the comments are type checked as well; if a contract has a TypeScript error, Freerange reports it there and stops proving that function or top-level block.

Use `fr check --annotations-only` to check annotated places and skip the broader scan of unannotated code that calls annotated functions. Use `--audit` for cleanup advice: redundant `Math.min/max` choices, `if` branches, `??` fallbacks, etc.

`fr infer file.ts` shows the facts Freerange deduced for that file. It's like TypeScript's inferred-type hover, except for the layout facts in the file. Pass `--function funcName` to focus on just that function. Use `fr infer --all` for a project summary, or `fr infer --all file.ts` for the detailed all-function view of that file.

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
`items[]` means every item in an array. Use `$i` on left and right side of an operator to express matching positions across arrays. `$i + 1` works the way you think. Currently `[$i + 2]` and `[$i - 1]` aren't supported.
For operators, we support `==` `<` `>` `<=` `>=` but not yet `!=`
**You can use any regular TS functions in the `@fit` contract**! As long as Freerange sees that the functions are pure: they don't mutate inputs or outside state, read mutable outside state, depend on I/O, the clock, or randomness, or call code Freerange can't inspect. Local allocation and mutation are fine. You don't need to annotate a function as `pure` to use it in a contract; Freerange infers this. The optional `pure` line records your intent so a later refactor is checked too, including every function called by the body.
`pure` belongs only in the `@fit` block above a function. Putting it on a loop is rejected because it describes the whole function's behavior, not a value to prove at one program point. If a called function has no available body, Freerange reports the purity claim as unknown instead of guessing.
An `@fit` line that's just a pure TS expression that returns a boolean, is checked by Freerange to be true, like `hasPositiveArea` and `nondecreasing` above (`nondecreasing` is a helper that comes with Freerange).

Syntax Glossary's at the end of the docs.

## `@fit` Contracts Built-Ins

We expose some useful functions in `@fit` comments:

```ts
pure // ensure the function has no visible side effects, mutable outside reads, or nondeterminism
nondecreasing(values: number[]): boolean // values in the array should prove to be bigger than or equal to their previous cell value
spaced(rows: {top: number; height: number}[], gap: number): boolean // each next row should prove to start after previous top + previous height + gap
lastEnd(rows: {top: number; height: number}[]): number // returns the final row's .top + .height; rows must prove non-empty
extentEnd(rows: {top: number; height: number}[], emptyValue: number): number // returns emptyValue for empty rows, otherwise the final row's .top + .height
```

## Checking Contracts

Freerange checks the annotated function body, types, and their usages, to ensure the `@fit` contracts are upheld. Here's an example of a responsive 2D photo gallery grid where the column count is calculated to be between 1 and 7, and each photo tile's width is derived from that:

```ts
/** @fit
 * given availableWidth: int 160..Infinity
 * return: int 1..7
 */
function columnCount(availableWidth: number) {
  const preferredTileWidth = availableWidth >= 700 ? 320 : 160
  const rawColumnCount = Math.floor(availableWidth / preferredTileWidth)
  return Math.min(7, Math.max(1, rawColumnCount))
}

/** @fit
 * given photos.length: int 0..200
 * given photos[].naturalWidth: int 1..Infinity
 * given availableWidth: int 160..Infinity
 * return.tiles.length == photos.length
 * return.tiles[].width > 0
 */
function layoutPhotoGrid(availableWidth: number, photos: {naturalWidth: number}[]) {
  const columns = columnCount(availableWidth)
  const tileWidth = availableWidth / columns
  const tiles = photos.map(photo => ({
    width: Math.min(photo.naturalWidth, tileWidth),
    naturalWidth: photo.naturalWidth,
  }))
  return {tiles}
}
```

Given the input TS types and Freerange's extra specs, the function bodies and calls are analyzed through "abstract interpretation", then checked against those specs.

Let's run `fr infer gallery.ts`. Look at how much information Freerange captures, statically, for you and AI agents to verify:

```txt
gallery.ts:columnCount
return:
  return: int 1..7
locals:
  preferredTileWidth: 160 | 320
  rawColumnCount: int 0..Infinity
checked:
  return: int 1..7
assumptions:
  given availableWidth: int 160..Infinity
redundant:
  return: int 1..7 (covered by return: int 1..7)

gallery.ts:layoutPhotoGrid
return:
  return.tiles.length == photos.length
  return.tiles.length: int 0..200
  return.tiles[].naturalWidth == photos[].naturalWidth
  return.tiles[].naturalWidth: int 1..Infinity
  return.tiles[].width: 1..Infinity
  return.tiles follows photos by index
locals:
  columns: int 1..7
  tileWidth: 22.857142857142858..Infinity
  tiles.length == photos.length
  tiles.length: int 0..200
  tiles[].naturalWidth == photos[].naturalWidth
  tiles[].naturalWidth: int 1..Infinity
  tiles[].width: 1..Infinity
  tiles follows photos by index
checked:
  return.tiles.length == photos.length
  return.tiles[].width > 0
assumptions:
  given photos.length: int 0..200
  given photos[].naturalWidth: int 1..Infinity
  given availableWidth: int 160..Infinity
redundant:
  return.tiles.length == photos.length (covered by return.tiles.length == photos.length)
  return.tiles[].width > 0 (covered by return.tiles[].width: 1..Infinity)
```

### Inference Mental Model

Freerange inferred lots of facts! Here's what we infer:
- Input facts, aka `given`s, are not proven from the function body. Freerange trusts them in the function, then checks them at visible call sites. Boolean givens like `given isValidLayout(input)` are kept as that exact fact. A few known built-ins, e.g. `given spaced(rows, gap)`, also add their documented row/order facts.
- Every returned field that's a number, be it array of numbers or object with nested number fields, gets their inferred range and number type, e.g. `0..<10` or `int 5..20`, and disjoint union values if applicable, e.g. `1 | 3 | 5` if the returned value is one of those 3 numbers inferred from some if-else in the function body.
- In the future, we can and might infer more convenience facts, such as `return.array1.length == return.array2.length`. But for now, to preserve a simple mental model and avoid bad surprises during code changes, we ask the user/agent to write those out explicitly in the function's `@fit` contracts.

Freerange comes out of the box understanding the relevant DOM and JS apis, e.g. it knows that `array.length` is `int 0..4294967295` (the JS cap) and that DOM `element.offsetWidth` is `int 0..Infinity`. Full glossary at the end of the docs.
It also understands useful `Math.*` calls. For example, it can prove `Math.floor(x) <= x`, `x < Math.floor(x) + 1`, `x <= Math.ceil(x)`, `Math.ceil(x) <= x + 1`, and `x - 0.5 <= Math.round(x) <= x + 0.5`. Claims follow how JS evaluates them: `x + 1` in a claim rounds like the code would, so the strict ceil bound holds as `<=`.

#### Branches

The Inference of results that contain `|` is more nuanced to handle, due to state explosions. But generally, it works this way:

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

This infers as `{left: 0, width: 100} | {left: 20, width: 80}`

Freerange currently keeps up to 8 reachable branch states from code. If code needs more than that, it keeps facts that are identical in every branch, forgets facts that vary by branch, and reports that it hit the branch-state budget. Checks that need the forgotten facts become `unknown`. That 8-case budget is for inferred code branches, which isn't necessarily the same as the number of alternations of output like `1 | 2 | 3`.

(TypeScript avoids this problem by widening to `{left: number; width: number}`, which avoids needing to track branches, but this isn't good enough for Freerange)

#### Loops

Freerange tracks your loop and the consequences of each variable that the loop body affect. **TODO**: there's something about 32 ifs limit here. Document.

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
element.clientWidth/clientHeight/scrollWidth/scrollHeight: int 0..Infinity
element.offsetWidth/offsetHeight: int 0..Infinity
canvas.width/height: int 0..Infinity
image.width/height/naturalWidth/naturalHeight: int 0..Infinity
video.width/height/videoWidth/videoHeight: int 0..Infinity
pictureInPictureWindow.width/height: int 0..Infinity
screen.width/height/availWidth/availHeight: int 0..Infinity
window.innerWidth/innerHeight/outerWidth/outerHeight: int 0..Infinity
innerWidth/innerHeight/outerWidth/outerHeight: int 0..Infinity
resizeObserverSize.inlineSize/blockSize: 0..Infinity
visualViewport.width/height: 0..Infinity
Math.floor/ceil/round/trunc(value) // inferred result ranges, non-strict order preservation, and ordinary rounding-loss bounds
Math.PI/E/LN10/LN2/LOG10E/LOG2E/SQRT1_2/SQRT2
Math.pow(base, exponent), Math.cbrt/fround/f16round/clz32(value), Math.imul(left, right) // inferred result ranges; clz32 and imul use coarse integer ranges unless inputs are exact
Math.exp/expm1/log/log2/log10/log1p/asin/acos/atan/sinh/asinh/tanh/acosh/atanh(value) // inferred ranges for monotone numeric functions, with domain checks where JS would otherwise produce NaN
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
