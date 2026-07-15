# Freerange

Freerange shows you the range of every `number` in your TypeScript codebase, thus letting you find potential `NaN`, `Infinity`, divide by 0, out-of-bound array index, etc.

- **Uses the offical TypeScript API**. Not a new language, not a fork. No annotations, no library functions.
- **Static**. Freerange works at compile (build) time, like TS. No need to start your app. AI agents can now guarantee UI layouts without ever touching the browser!
- **Fast**. Uses a negligible fraction of TS' analysis time.
- **Robust**. Adversarially tested by agents against thousands of edge-case code.

Freerange is deliberately designed for code that can be refactored, especially code written or maintained by agents. It does not try to understand every TypeScript pattern. It accepts a small, predictable subset and gives concrete guidance for moving important calculations into that subset.

## Try It

```sh
bun install --dev @chenglou/freerange
bun fr
```

```ts
function aspectRatio(width: number, height: number) {
  return width / height
}

aspectRatio(10, 0)
```

`fr` outputs:

```zsh
index.ts:5:1 - error [inferred-requirement]: call to aspectRatio violates its nonzero divisor requirement (division at index.ts:2:10)
```

How it works: Freerange consults TypeScript to find that `height` is indeed a `number`. Then infers that it shouldn't be `0`. It then checks the callers of `aspectRatio` and found that the `height` passed is `0`, thus errors. For convenience, it also assumes a few other things, e.g. `width` and `height` don't want to be `NaN` and infinite.

## Commands

- `fr`: print project errors and warnings
- `fr --audit`: print every function's contracts, plus refactor suggestions to help Freerange analyze better. Great for agents

Pass your file path to either command to filter down to just that file's report.

`fr` directly uses TypeScript under the hood, so it naturally respects your `tsconfig`. We output TS errors before our analysis, so technically, you can swap out your explicit `tsc` command for `fr` and nothing changes!

## One production example

Our production app positions an input bar, a tray below it, and the surrounding content from the window size. We added one line:

```ts
windowSizeY = Math.max(320, windowSizeY)
```

Real windows are almost always taller than 320 pixels. The line states a product rule: layout below that height is unsupported. Freerange then derived facts several calculations later:

```text
ensures: return.inputTray.top is a finite number at least 54
ensures: return.nav.bottom is a finite number at least 320
```

Nobody wrote `54` as a bound. Freerange combined the window minimum, the gap, and the input-row height. If a later refactor weakens or removes that guarantee, the contract changes with the code.

The same production pass found a different problem in image-fitting code. A 0 by 0 image caused division by zero, followed by `0 * Infinity`, which produces `NaN`. The function now handles missing image dimensions before doing the calculation, and its report no longer requires every caller to do so.

## Reading the output

Freerange uses a few terms consistently:

- `requires`: a condition the caller must satisfy. The function's guarantees assume the condition is true.
- `ensures`: a guarantee about the returned value whenever the function returns.
- `assumes`: an input condition Freerange accepts without proving, such as a number parameter being finite and not `NaN`.
- `proves`: a successful static `console.assert` check.
- `unsupported`: the function uses code outside the analyzed subset. Freerange names the first blocker so the code can be reshaped and checked again.
- `stopped`: Freerange analyzed part of the function, but at least one path could not continue. Facts marked `on analyzed paths` are not a contract for the whole function.
- `skipped`: module setup contained a statement Freerange did not analyze. Values that statement could change are not trusted afterward.

A caller requirement is not automatically a bug. For example, `requires: columns >= 1` means the function is safe under that condition; it does not mean Freerange found a caller passing zero. Freerange checks supported same-file calls, but it is not a repository-wide call-site verifier. Imported calls and unsupported callers may remain unchecked.

An `ensures` line assumes its `requires` and `assumes`. A requirement may be a real API rule, or it may expose a relationship Freerange cannot currently prove. An assumption may identify a real input boundary or an analysis limitation. Decide what the program should do before changing code to remove either one.

Always read the coverage line. No findings does not mean an unsupported file is safe. A derived guarantee becoming weaker, for example `at least 54` becoming `at least 0`, appears in the audit rather than the shorter findings output.

## Static `console.assert`

Did you know that `console.log` has a less known sibling: `console.assert`? When the value of the assert is true, it stays silent. When it's false, it prints `false`.

Before Freerange, `console.assert` isn't as universally useful as `console.log`. But this now changes! We decided to analyze `console.assert` **statically**:

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

In the example above, calling `itemColumn(0, 2.2)` errors (`columnCount` should be an integer), **at compile time**, not at runtime! No need to start a browser to know that the code's wrong here.

`console.assert` calls at the very beginning of a function, before any other statement, are caller requirements. Like parameter types, every caller must satisfy them.
Any `console.assert` later in the function will be proven by Freerange for the function itself. Otherwise we error.

For simplicity and predictability, `console.assert` currently works only in named top-level functions and accepts simple numeric checks:
- `Number.isInteger`, `Number.isFinite`, `Number.isNaN`
- Strict comparison (`===`, `!==`, `<`, `>`, `<=`, `>=`) using number literals, object paths and array.length
- References to module constants. For caller requirements, the constant must resolve to a numeric literal

We also don't support aliasing `console.assert`, e.g. `const assert = console.assert`.

For more complex assertions, like inline calculations, extract them into variables:

```ts
const availableWidth = frame.right - frame.left
console.assert(availableWidth >= 0)
```

(You can feel free to strip `console.assert` in production like you're probably been doing already.)

### Things Worth Asserting

There are infinitely many assertable things. Here are some good, non-noisy ones:
- Guarantee that 2 UI items don't overlap:
  ```ts
  console.assert(input.bottom < content.top)
  ```
- Guarantee that a virtualized list never renders more items than intended:
  ```ts
  const visibleItemCount = endIndex - startIndex
  console.assert(visibleItemCount <= MAX_VISIBLE_ITEM_COUNT)
  ```
- Ensure two separate values are equal, given different calculations:
  ```ts
  const frame = {
    input: {bottom: inputBottom},
    inputTray: {bottom: inputBottom},
  }
  console.assert(frame.inputTray.bottom === frame.input.bottom)
  ```

Freerange already defaults to inferring that the relevant numbers shouldn't be `NaN`, `Infinity`, `0` (for division denominators) and whatever else. You can see them in `fr --audit`. You don't need to explicitly asserting unnecessary info.

## Writing analyzable TypeScript

Freerange's supported subset is a small set of general rules, not a list copied from the current example projects. The practical approach is to keep framework code as it is and move the numeric part that deserves a contract into a small plain function.

**Keep the numeric part small and explicit.** Put important calculations in synchronous named top-level function declarations with explicit inputs. A React component, callback, or async function can call the helper even when the surrounding framework code remains unsupported.

```tsx
export function fittedImageHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  const width = Math.max(1, imageWidth)
  const height = Math.max(1, imageHeight)
  return (frameWidth * height) / width
}

function ImageCard(props: {frameWidth: number; imageWidth: number; imageHeight: number}) {
  const height = fittedImageHeight(props.frameWidth, props.imageWidth, props.imageHeight)
  return <img style={{height}} />
}
```

**Model different cases explicitly.** Use a tagged union when behavior differs by shape, then switch on its string or boolean tag. Do not mix unrelated kinds of value in one binding or use `any` to bypass the distinction.

**State real domain rules in executable code.** A virtualized grid may define its column count as a positive integer, and an application may define a minimum supported window size. Do not add a clamp merely to improve a report. A clamp changes runtime behavior and belongs only where that behavior is intended.

**Guard the exact value an operation uses.** If the divisor is `oldMax - oldMin`, bind the subtraction to `oldSpan` and check `oldSpan === 0`. Checking `oldMin === oldMax` does not currently prove a later fact about the separately calculated subtraction.

Be careful with precomputed ratios. Two positive numbers can divide to an exact result so tiny that JavaScript rounds it to zero. In image layout, `(frameWidth * imageHeight) / imageWidth` can therefore be easier to verify than `frameWidth / (imageWidth / imageHeight)` once the original dimensions are checked. The expressions may round differently, so precision-sensitive code must choose its evaluation order intentionally.

**Treat records and arrays as immutable after construction.** Rebuild a plain record by listing its fields, for example `{width, height: layout.height}`. Object spread is outside the subset because JavaScript copies own enumerable properties rather than simply reading every declared field. Rebuilding is not a general replacement for mutation when callers observe object identity or the mutation itself. Sparse array construction and element writes are unsupported. An array supplied by a caller is assumed to be dense, and the report states that assumption.

**Snapshot state before calculating.** Copy module or reactive state to a local before checking and using it. Write `const currentScale = scale; if (currentScale !== null) return currentScale`, rather than checking one read of `scale` and returning another. Separate module reads may see separate values; the local makes the intended identity explicit.

**Use direct control flow.** Write the numeric condition you mean instead of relying on truthiness. Use exhaustive tagged-union switches without fallthrough. Use explicit loops for simple dense-array aggregation. Array callbacks are not automatically equivalent to loops because holes, callback arguments, returned arrays, and side effects can be observable.

**Let TypeScript establish the shape.** Parse and validate outside data, then pass checked values into the numeric helper. Casts and `any` are not proof; Freerange carries those values without numeric claims, and a path stops when an operation needs one to be a number. A file containing `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `eval` is rejected because its declared types cannot be trusted.

## Current limits

Freerange mostly tracks each number independently: its lower and upper bounds, whether it is an integer, whether it may be `NaN`, whether it may be infinite, and at most one constant excluded by a branch. A later branch that excludes a different number may replace the earlier exclusion, so guard the exact divisor shortly before using it when several exclusions matter. Freerange does not solve arbitrary equations or remember every relationship between separately calculated values. When branches meet, the result covers every branch.

Inside an assertion, Freerange can follow a small set of common UI calculations through named values: `Math.min` and `Math.max`, adding or subtracting a nonnegative value, matching multiplication by a nonnegative factor, positive remainder bounds, and fields read from a freshly constructed record. These rules do not provide general transitivity. Knowing `left <= middle` and `middle <= right` does not by itself prove `left <= right`.

Loops are analyzed until their state stops changing; Freerange does not unroll runtime iterations or derive a closed formula. Ordinary counting loops usually settle after two or three analysis passes. A loop that still changes after 16 passes is reported as stopped. The limit guarantees that analysis finishes and may conservatively reject an unusually long chain of loop-carried values.

Project-owned records, tuples, arrays, and tagged unions are followed through at most eight nested levels. A deeper property becomes unknown, while a function whose root input type cannot be represented is unsupported. Pass the finite fields a calculation uses instead of passing a recursive application model.

Function calls are analyzed when Freerange can see and support the callee. Same-file calls are evaluated with the caller's current numeric information. Imported functions are not followed, and a callee's contract is not removed merely because every visible caller happens to be safe. Imported constants are followed only when they resolve to a plain numeric literal such as `export const GAP = 24`.

Unknown calls, callback ordering, mutation through aliases, caught exceptions, and most framework effects remain outside the subset. A same-file call may use a supported literal default parameter. Object and calculated defaults remain unsupported, as do extra runtime arguments beyond the implementation's declared parameters.

A bare array read is treated as possibly missing regardless of `noUncheckedIndexedAccess`. An asserted read such as `values[index]!` records an in-bounds assumption when Freerange cannot prove the index. A `for...of` loop proves its own reads in bounds. Optional and rest tuples are unsupported; use a fixed tuple or an array.

Freerange assumes property reads are side-effect-free and stable during one analyzed synchronous calculation. Snapshot class, framework, or reactive state into plain local values before passing it to a numeric helper. A getter or Proxy that performs work or changes its answer is outside the model.

Three limits deliberately lose precision rather than risk a wrong result: 16 updates at a loop header, eight levels of recursive type inspection, and at most one visit per function instruction while expanding a caller requirement. Hitting a limit stops analysis, makes a nested value unknown, or falls back to a local assumption. No limit silently strengthens a claim.

## Recommended TypeScript Config

The only TypeScript config that Freerange mandates is `strictNullChecks`, which is already on by default for TypeScript (otherwise the analysis is too unsafe).
We do recommend generally having the configs below enabled too. They're not necessary for Freerange's analysis; it's just that when they're on, AI agents (and you) end up writing code that are much less dangerous and more likely to be analyzable:

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

## Development

```sh
bun install
bun run check
```
