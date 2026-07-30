# Freerange

Freerange shows you the range of every `number` in your TypeScript codebase, letting you find potential `NaN`, `Infinity`, division by zero, out-of-bounds array indexes, and more.

- **Uses the official TypeScript API**. Not a new language, not a fork. No annotations, no library functions.
- **Static**. Freerange works at compile (build) time, like TS. No need to start your app. AI agents can now guarantee UI layouts without ever touching the browser!
- **Fast**. Uses a negligible fraction of TypeScript's analysis time.
- **Robust**. Adversarially tested by agents against thousands of edge cases.

Freerange is deliberately designed to cater to a useful (and growing) subset of TypeScript, and gives concrete guidance for moving important calculations into that subset, so that your code and math can meet in the middle to unlock the most proof power without much ergonomics drawbacks. AI agents are especially well-suited to refactor such code, and we highly recommend you asking them to do so. However, if you/they do find an unsupported TS feature truly valuable, please file an issue!

## Install

```sh
bun install --dev @chenglou/freerange # npm install works too of course
```

## API

There's no API =). Your TypeScript code provides enough information for Freerange's analysis. We recommend that your agents shape code in the analysis-friendly ways described below.

## Commands

- `fr`: print project errors and warnings
- `fr --audit`: print every function's contracts, plus refactor suggestions to help Freerange analyze better. Great for agents

Pass a file path to either command to filter down to just that file's report.

`fr` directly uses TypeScript under the hood, so it naturally respects your `tsconfig`. We output TS errors before our analysis, so technically, you can swap out your explicit `tsc --noEmit` command for `fr` and nothing changes!

## Examples

### 1: Catch UI Sizing Bug

```ts
function gridColumnCount(containerWidth: number) {
  return Math.floor(containerWidth / 240)
}

function gridItemWidth(containerWidth: number) {
  return containerWidth / gridColumnCount(containerWidth)
}

gridItemWidth(200)
```

`bun fr` (or `npx fr`) outputs:

```zsh
index.ts:9:1 - error [inferred-requirement]: call to gridItemWidth violates its nonzero divisor requirement (division at index.ts:6:10)
```

How it works: Freerange follows `200` into `gridItemWidth`, then through the call to `gridColumnCount`. It works out that `Math.floor(200 / 240)` is `0`, then catches the later division by that result. TypeScript only knows that these values are numbers; Freerange follows their ranges through both functions.

### 2: Static `console.assert`

Did you know that `console.log` has a lesser-known sibling: `console.assert`? When the assertion is true, it stays silent. When the assertion is false, it reports a failure.

By itself, `console.assert` isn't as universally useful as `console.log`. Freerange changes that by analyzing `console.assert` **statically**:

```ts
export function itemColumn(itemIndex: number, columnCount: number): number {
  console.assert(Number.isInteger(columnCount))
  console.assert(columnCount >= 1)

  const index = Math.max(0, Math.floor(itemIndex))
  const column = index % columnCount

  console.assert(column < columnCount)
  return column
}
```

In the example above, calling `itemColumn(0, 2.2)` produces an error (`columnCount` should be an integer) **at compile time**, not at runtime! No need to start a browser to know that the code is wrong here.

`console.assert` calls at the very beginning of a function, before any other statement, are caller requirements. Like parameter types, every caller must satisfy them.
Any `console.assert` later in the function will be proven by Freerange for the function itself. Otherwise, Freerange reports an error.

For simplicity and predictability, `console.assert` currently works only in named top-level functions and accepts simple numeric checks:
- `Number.isInteger`, `Number.isFinite`, `Number.isNaN`
- Strict comparisons (`===`, `!==`, `<`, `>`, `<=`, `>=`) using number literals, object paths, and `array.length`
- References to module constants. For caller requirements, the constant must resolve to a numeric literal

We also don't support aliasing `console.assert`, e.g. `const assert = console.assert`.

For more complex assertions, like inline calculations, extract them into variables:

```ts
const availableWidth = frame.right - frame.left
console.assert(availableWidth >= 0)
```

(You can strip `console.assert` in production with bundler or Bun's drop feature, as you may already be doing.)

#### Things Worth Asserting

There are infinitely many assertable things. Here are some good, non-noisy ones:
- Guarantee that two UI items don't overlap:
  ```ts
  console.assert(input.bottom < content.top)
  ```
- Guarantee that a virtualized list never renders more items than intended:
  ```ts
  const visibleItemCount = endIndex - startIndex
  console.assert(visibleItemCount <= MAX_VISIBLE_ITEM_COUNT)
  ```
- Ensure that two separately calculated values are equal:
  ```ts
  const frame = {
    input: {bottom: inputBottom},
    inputTray: {bottom: inputBottom},
  }
  console.assert(frame.inputTray.bottom === frame.input.bottom)
  ```

Every plain `number` parameter, including a number field in a fixed-shape object parameter, already requires a finite, non-`NaN` value. Freerange also checks whether a divisor may be `0` and the other conditions shown by `fr --audit`. You don't need to assert the same information explicitly.

## Writing Analyzable TypeScript

Freerange deliberately analyzes a restricted part of TypeScript. When code leaves that scope, `fr --audit` says so instead of guessing what the code does. Freerange currently supports:

- Named, synchronous top-level functions. Both `function size(...) {}` and direct `const size = (...) => ...` declarations work. Freerange follows calls between functions in the same file
- Numbers, booleans, strings, nullable values, plain objects, tagged unions, dense arrays, and fixed tuples
- `if`/`else`, ternaries, non-fallthrough `switch`, `&&`, `||`, `!`, `??`, `for`, `while`, and `for...of` loops
- Arithmetic, comparisons, object field and array reads, selected `Math` operations, and `Number.isInteger`, `Number.isFinite`, and `Number.isNaN`

Freerange could theoretically support a much larger subset of TS, and did before its public release. Those patterns often made numeric inference and proofs much harder and slower, however, and some questions are undecidable in general. Now that AI agents write code, we strongly recommend asking agents to refactor important calculations into shapes that Freerange analyzes well, guided by `fr --audit`. Code that is easy to analyze tends to resemble functional programming: immutable data, explicit inputs and outputs, and clean, direct control flow.

Use precise TypeScript types. Avoid `any`, casts, and suppression comments, and parse external data before passing it to a numeric helper. A file containing `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `eval` is rejected because its declared types cannot be trusted.

Before changing an input rule, decide what the application should do. If `columnCount` must be a positive integer, either require that with leading `console.assert` calls or normalize it with `Math.max(1, Math.floor(columnCount))`. Only normalize when the application wants that runtime behavior. Audit code: `[encode-input-rule]`.

### Numeric Analysis

For each `number`, Freerange remembers its lowest and highest possible values, whether it is an integer, whether it may be `NaN` or infinite, and at most one exact value that has been ruled out. It reasons about JavaScript floating-point numbers rather than ideal real numbers and does not use a general-purpose theorem prover.

Freerange also supports numeric phantom types, e.g. `type Pixels = number & {readonly __brand: 'pixels'}`.

#### No common-subexpression elimination

Freerange does not replace repeated calculations with one stored result, even when their source code is identical. This function checks one subtraction, then divides by a newly evaluated subtraction:

```ts
export function progressBar(value: number, start: number, end: number): number {
  if (end - start === 0) return 0
  return (value - start) / (end - start)
}
```

Calculate the subtraction once when the check and division must use the same result:

```ts
export function progressBar(value: number, start: number, end: number): number {
  const span = end - start
  if (span === 0) return 0
  return (value - start) / span
}
```

Freerange recognizes aliases, repeated reads of the same immutable field or array position, and the same argument passed to multiple parameters. A newly evaluated calculation or function call is a new value. Audit code: `[guard-derived-value]`.

#### Ranges use inclusive endpoints

Freerange stores every range using its lowest and highest included values. JavaScript numbers are discrete, so the neighboring representable number can often express a strict endpoint: `Math.random()` is stored as `0..0.9999999999999999` and reported as `at least 0 and less than 1`. This needs no rewrite.

#### Branches merge into one continuous range

Freerange combines both branch results into one continuous range. Here `width` becomes `240..480`, which includes `300` even though neither branch returns it:

```ts
export function previewRatio(compact: boolean): number {
  const width = compact ? 240 : 480
  return 100 / (width - 300)
}
```

Keep a calculation inside each branch when it depends on the separate alternatives:

```ts
export function previewRatio(compact: boolean): number {
  if (compact) return 100 / (240 - 300)
  return 100 / (480 - 300)
}
```

A broad but safe range may need no rewrite.

#### A number remembers at most one excluded value

After `code !== 240` and `code !== 300`, Freerange may remember only the later exclusion. When an operation depends on a particular exclusion, check the value that the operation uses:

```ts
const divisor = code - 240
if (divisor === 0) return 0
return 100 / divisor
```

Freerange does not retain arbitrary sets such as "every number except 240 and 300."

#### No transitive reasoning between comparisons

Freerange does not combine `left <= middle` and `middle <= right` to prove `left <= right`:

```ts
if (left > middle) throw new Error('out of order')
if (middle > right) throw new Error('out of order')
console.assert(left <= right) // unproven
```

When one value is built from another, keep the relationship visible in that calculation:

```ts
const gap = Math.max(0, requestedGap)
const left = navRight + gap
console.assert(navRight <= left)
```

If the values arrive independently, Freerange may leave the relationship unproven.

#### No algebraic inversion of conditions

Freerange narrows the direct operands of a comparison but does not rearrange `width * 2 > 10` to derive `width > 5`. Check the value used by the later operation:

```ts
export function previewScale(width: number): number {
  if (width <= 5) return 1
  return 100 / width
}
```

#### No algebraic normalization

Freerange does not rewrite expressions using associativity, commutativity, or distributivity. Those rules do not always preserve JavaScript floating-point results:

```ts
const amount = 9_007_199_254_740_992
const first = 3 + amount + 2 // 9007199254740998
const second = 1 + amount + 4 // 9007199254740996
```

Choose the operation order whose floating-point behavior the application wants. For example, `frameWidth / (imageWidth / imageHeight)` introduces a ratio that can round to zero; `(frameWidth * imageHeight) / imageWidth` avoids that particular problem, although the two expressions can still round differently. Audit code: `[use-direct-operands]`.

#### Numeric truthiness is unsupported

Freerange does not guess what a number used as a condition means. Write `width === 0` instead of relying on a truthy or falsy number such as `width || 1`. Audit code: `[write-explicit-condition]`.

### Functions

Put important calculations in named synchronous functions. A React component, callback, or async function can call a plain helper:

```tsx
export function fittedImageHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  return (frameWidth * Math.max(1, imageHeight)) / Math.max(1, imageWidth)
}

function ImageCard(props: {frameWidth: number; imageWidth: number; imageHeight: number}) {
  const height = fittedImageHeight(props.frameWidth, props.imageWidth, props.imageHeight)
  return <img style={{height}} />
}
```

Literal default parameters and omitted optional parameters work in supported same-file calls. Object and calculated defaults do not. Passing more arguments than the implementation declares is unsupported.

#### A function return does not include how the value was calculated

Freerange evaluates supported same-file helpers using what the caller knows. It keeps what the helper may return, including numeric ranges and object fields, but not an equation such as "this result is exactly `end - start`":

```ts
function span(start: number, end: number): number {
  return end - start
}

export function progressBar(value: number, start: number, end: number): number {
  return (value - start) / span(start, end)
}
```

When the caller needs that exact calculation, calculate and check it in the caller, then pass the result to a helper. The same limitation applies to booleans: `true` from `isValidIndex(values, index)` does not tell the caller which checks made it true, so write those checks where they protect the array read.

#### Imported function bodies are not analyzed

Freerange does not follow imported functions. Keep a numeric rule that needs analysis in a supported helper with explicit inputs:

```ts
export function labelWidthFromMeasurement(measuredWidth: number): number {
  return Math.max(120, measuredWidth + 32)
}
```

An unsupported caller can pass `measureText(text)` into this helper, allowing Freerange to verify the rule but not the imported measurement. Imported constants work when their initializer resolves to a numeric literal such as `export const GAP = 24`. Runtime import cycles are outside Freerange's scope: an imported module must finish initializing before analyzed code reads its values. Type-only import cycles are fine.

#### No higher-order function analysis

Freerange does not analyze callbacks passed to higher-order functions such as `reduce`, `map`, or `filter`. For a simple scalar aggregation, write the loop directly:

```ts
export function totalWidth(widths: number[]): number {
  let total = 0
  for (let index = 0; index < widths.length; index += 1) {
    total += widths[index]!
  }
  return total
}
```

This is not a general replacement for `map` or `filter`: object and array writes remain unsupported, and callback arguments, effects, and result allocation may matter. Audit code: `[use-loop-for-aggregation]`.

### Objects, Arrays, and Changing State

Freerange reads plain objects, fixed tuples, dense arrays, and tagged unions declared in the project through at most eight nested levels. Give each union case a tag, use an exhaustive non-fallthrough `switch`, and keep deeply nested or unclassifiable data outside important numeric helpers.

Freerange assumes that property reads are stable and perform no work during one analyzed synchronous call. A getter or Proxy that changes its answer or performs work is outside the scope.

#### No object and array writes

Freerange allows local variables to be reassigned but does not track writes through an object or array. Return a new value when the application does not require mutation or stable object identity:

```ts
export function moveRight(point: {x: number; y: number}, distance: number): {x: number; y: number} {
  return {x: point.x + distance, y: point.y}
}
```

Object spread is also unsupported because JavaScript copies only an object's own enumerable properties, which may not match the fields declared by its TypeScript type. List the fields explicitly. Rebuilding an object is not equivalent to mutation when other code observes its identity or the mutation.

#### Reads of changing state are not referentially transparent

Referential transparency means that evaluating the same expression again is equivalent to reusing its previous result. Freerange does not make that assumption for a clock, viewport, scroll position, or mutable module binding. Store one read when the check and later use should observe the same value:

```ts
export function viewportScale(): number {
  const viewportWidth = window.innerWidth
  if (viewportWidth === 0) return 0
  return 100 / viewportWidth
}
```

Keep separate reads when two observations are intentional, such as two clock reads used to measure elapsed time.

#### Array reads require dense arrays and valid indexes

Use `values[index] ?? fallback` only when the application wants a fallback. Otherwise, prove that `index` is an integer from zero through `values.length - 1` before using `values[index]!`. A bounds check cannot detect a hole in a sparse array, so Freerange expects arrays to be dense. Audit codes: `[handle-missing-element]`, `[guard-array-index]`.

### Loops

#### Loops find stable ranges, not exact formulas

Freerange checks a loop until the possible values at the start of an iteration stop changing. It does not simulate the exact runtime iteration count or derive a formula for the final value:

```ts
export function fixedTotal(): number {
  let total = 0
  for (let index = 0; index < 3; index += 1) {
    total += 2
  }
  return total
}
```

Freerange knows that the result is a nonnegative integer but does not derive that it is exactly `6`. Ordinary counting loops usually settle after two or three checks. If a range still changes after 16 checks, Freerange stops analyzing that path. Write a formula directly when it is the intended implementation, but do not replace repeated floating-point arithmetic with multiplication unless the different rounding behavior is acceptable.

Code outside this scope may make a result less precise or stop analysis. Freerange does not publish a stronger guarantee by pretending that unsupported code was understood. If an unsupported pattern is important and cannot be reasonably refactored, please file an issue.

## Recommended TypeScript Config

The only TypeScript compiler option that Freerange mandates is `strictNullChecks` (otherwise the analysis is too unsafe), which is enabled when `strict` is on. We generally recommend enabling the options below as well. They aren't necessary for Freerange's analysis, but they help AI agents and humans write safer code that is more likely to be analyzable:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

## `fr --audit` Output

Freerange uses a few terms consistently:

- `requires`: a condition the caller must satisfy. The function's guarantees assume the condition is true.
- `ensures`: a guarantee about the returned value whenever the function returns.
- `assumes`: an input condition Freerange accepts without proving, such as an array being dense or every element of a `number[]` being finite.
- `proves`: a successful static `console.assert` check.
- `unsupported`: Freerange cannot analyze the function because it uses code outside the analyzed subset. Freerange shows the first blocker you can potentially refactor.
- `partially supported`: Freerange can analyze some, but not all, of the function.
- `skipped`: some top-level statements in the modules weren't analyzed.

### Caller Requirements

Every plain `number` parameter must be finite and not `NaN`. The same rule applies to numeric fields in fixed-shape object parameters, even when the function does not read them. Numeric literal types such as `1 | 2` already satisfy the rule. Nullable numbers, arrays, tuples, and tagged unions use more specific `assumes` lines instead. A supported literal default can satisfy the requirement when a caller omits an argument.

Division and array reads can create additional requirements. Freerange tries to express them using the function's parameters so that supported same-file callers can prove them, pass them to their own callers, or report a definitely invalid argument. If a condition cannot be expressed that way, `fr --audit` prints a local `assumes` line instead.

A caller requirement is not automatically a bug. For example, `requires: columns >= 1` means the function is safe under that condition; it does not mean Freerange found a caller passing zero. Freerange checks supported same-file calls, but it is not a repository-wide call-site verifier. Imported calls and unsupported callers may remain unchecked.

An `ensures` line assumes its `requires` and `assumes`. A requirement may be a real API rule, or it may expose a relationship Freerange cannot currently prove. An assumption may identify a real input boundary or an analysis limitation. Decide what the program should do before changing code to remove either one.

Always read the coverage line. No findings does not mean an unsupported file is safe. A derived guarantee becoming weaker, for example `at least 54` becoming `at least 0`, appears in the audit rather than the shorter findings output.

## Development

```sh
bun install
bun run check
```

## Credits

[Infer](https://github.com/facebook/infer), [AlphaProof](https://deepmind.google/blog/ai-solves-imo-problems-at-silver-medal-level/)
