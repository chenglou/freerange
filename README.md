# Freerange

Freerange shows you the range of every `number` in your TypeScript codebase, letting you find potential `NaN`, `Infinity`, division by zero, out-of-bounds array indexes, and more.

- **Uses the official TypeScript API**. Not a new language, not a fork. No annotations, no library functions.
- **Static**. Freerange works at compile (build) time, like TS. No need to start your app. AI agents can now guarantee UI layouts without ever touching the browser!
- **Fast**. Uses a negligible fraction of TypeScript's analysis time.
- **Robust**. Adversarially tested by agents against thousands of edge cases.

Freerange is deliberately designed for code that can be refactored, especially code written or maintained by agents. It does not try to understand every TypeScript pattern. It accepts a small, predictable subset and gives concrete guidance for moving important calculations into that subset.

## Install

```sh
bun install --dev @chenglou/freerange
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

`bun fr` outputs:

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

(You can strip `console.assert` in production, as you may already be doing.)

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

Freerange already checks whether relevant numbers may be `NaN` or `Infinity`, whether a divisor may be `0`, and other conditions shown by `fr --audit`. You don't need to assert the same information explicitly.

## Writing Analyzable TypeScript

Freerange supports a subset of TS:
- Named, synchronous top-level functions in a file; Freerange follows calls between functions in the same file
- Numbers, booleans, strings, nullable values, plain objects, tagged unions, dense arrays, and fixed tuples
- `if`/`else`, ternaries, non-fallthrough `switch`, `&&`, `||`, `!`, `??`, `for`, `while`, and `for...of` loops
- Arithmetic, comparisons, object field and array reads, selected `Math` operations, and `Number.isInteger`, `Number.isFinite`, and `Number.isNaN`

Freerange could theoretically support a much larger subset of TS, and did before its public release. Those patterns often made numeric inference and proofs much harder and slower, however, and some questions are undecidable in general. Especially now that AI agents write code, we strongly recommend asking the agent to refactor important calculations into shapes that Freerange analyzes well. Code that is easy to analyze tends to resemble functional programming: immutable data, explicit inputs and outputs, and clean, direct control flow.

### Keep calculations small and explicit

Put important calculations in synchronous named top-level function declarations with explicit inputs. A React component, callback, or async function can call the helper even when the surrounding framework code remains unsupported.

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

Keep a calculation and any helper calls that Freerange needs to follow in the same file. Imported helpers can still be used, but Freerange will not inspect their bodies.

### Model different cases explicitly

Use a tagged union when behavior differs by shape, then switch on its string or boolean tag. Do not mix unrelated kinds of value in one binding or use `any` to bypass the distinction.

### State domain rules in code

**`[encode-input-rule]` Encode a real input rule where the calculation begins.** A virtualized grid may define its column count as a positive integer, for example `const columns = Math.max(1, Math.floor(columnCount))`. Do not add a clamp merely to improve a report. A clamp changes runtime behavior and belongs only where that behavior is intended; outside data may still need separate `NaN` validation.

Keep assertions direct and give names to intermediate calculations before asserting them. Write the relationship that matters rather than expecting Freerange to combine several other assertions.

### Guard the value the operation uses

**`[guard-derived-value]` Check the exact divisor.** If the divisor is `oldMax - oldMin`, bind the subtraction to `oldSpan` and check `oldSpan === 0`. Checking `oldMin === oldMax` does not prove a later fact about the separately calculated subtraction. A later branch can also replace an earlier excluded constant, so check the divisor shortly before using it when several exclusions matter. If zero is invalid input rather than a case the function handles, keep the caller requirement instead.

**`[use-direct-operands]` Use guarded dimensions directly instead of dividing by a ratio.** Two positive numbers can have a quotient so tiny that JavaScript rounds it to zero. In image layout, `(frameWidth * imageHeight) / imageWidth` can therefore be easier to verify than `frameWidth / (imageWidth / imageHeight)` once the original dimensions are checked. The expressions may round differently, multiplication may still overflow, and clamping nonpositive dimensions changes behavior, so precision-sensitive code must choose its evaluation order intentionally.

### Handle arrays and records deliberately

Treat records and arrays as immutable after construction. Rebuild a plain record by listing its fields, for example `{width, height: layout.height}`. Object spread is outside the subset because JavaScript copies own enumerable properties rather than simply reading every declared field. Rebuilding is not a general replacement for mutation when callers observe object identity or the mutation itself. Sparse array construction, element writes, and optional or rest tuples are unsupported. An array supplied by a caller is assumed to be dense, and the report states that assumption.

**`[handle-missing-element]` Handle a possibly missing array element.** A bare read such as `values[index]` is treated as possibly missing regardless of `noUncheckedIndexedAccess`. Use a fallback such as `values[index] ?? 0` only when that fallback is real application behavior; a bounds check alone does not detect a hole in a sparse array.

**`[guard-array-index]` Check an asserted array index.** Before using `values[index]!`, prove that `index` is an integer from zero through `values.length - 1`. If the function owns invalid-index behavior, handle that case directly. Otherwise keep the caller requirement. A `for...of` loop proves its own element reads in bounds.

### Use direct control flow

**`[write-explicit-condition]` Write the numeric case explicitly.** Use `width === 0`, `width > 0`, or the comparison that states the intended case instead of number truthiness such as `width || 1`. An explicit comparison can differ from truthiness for `NaN`, so choose the condition the program actually means.

**`[use-loop-for-aggregation]` Use an explicit loop for dense-array aggregation.** A `for` loop exposes the accumulator and each numeric step. This is suitable when the array is dense, the reduction has an initial value, and callback arguments or effects do not matter. Array methods and indexed loops can differ for sparse arrays, callbacks may expose their index and receiver, and methods such as `map` create a new array.

Use exhaustive tagged-union switches without fallthrough.

### Snapshot state before calculating

Copy module, class, or reactive state to a local before checking and using it. Write `const currentScale = scale; if (currentScale !== null) return currentScale`, rather than checking one read of `scale` and returning another. Freerange assumes property reads are side-effect-free and stable during one analyzed synchronous calculation. A getter or Proxy that performs work or changes its answer is outside the model; the local makes the intended identity explicit.

### Let TypeScript establish the shape

Parse and validate outside data, then pass checked values into the numeric helper. Casts and `any` are not proof; Freerange carries those values without numeric claims, and a path stops when an operation needs one to be a number. A file containing `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `eval` is rejected because its declared types cannot be trusted.

Pass the fields a calculation uses instead of passing a recursive application model.

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
- `assumes`: an input condition Freerange accepts without proving, such as a number parameter being finite and not `NaN`.
- `proves`: a successful static `console.assert` check.
- `unsupported`: the function uses code outside the analyzed subset. Freerange names the first blocker so the code can be reshaped and checked again.
- `stopped`: Freerange analyzed part of the function, but at least one path could not continue. Facts marked `on analyzed paths` are not a contract for the whole function.
- `skipped`: module setup contained a statement Freerange did not analyze. Values that statement could change are not trusted afterward.

A caller requirement is not automatically a bug. For example, `requires: columns >= 1` means the function is safe under that condition; it does not mean Freerange found a caller passing zero. Freerange checks supported same-file calls, but it is not a repository-wide call-site verifier. Imported calls and unsupported callers may remain unchecked.

An `ensures` line assumes its `requires` and `assumes`. A requirement may be a real API rule, or it may expose a relationship Freerange cannot currently prove. An assumption may identify a real input boundary or an analysis limitation. Decide what the program should do before changing code to remove either one.

Always read the coverage line. No findings does not mean an unsupported file is safe. A derived guarantee becoming weaker, for example `at least 54` becoming `at least 0`, appears in the audit rather than the shorter findings output.

## Analysis Limits

If your production code actually needs support beyond these limits, please file an issue! We're open to relaxing the limits.

### Numbers

Freerange's numeric analysis is designed around arithmetic used in layouts and other everyday application code. For each TypeScript `number`, Freerange tracks one continuous range, whether the value is an integer, whether it may be `NaN` or infinite, and at most one exact number that a branch proved impossible. For example, after `value !== 0`, Freerange can remember that `value` cannot be `0`.

Freerange does not keep separate ranges or arbitrary sets of possible numbers. If one branch produces `1..2` and another produces `10..11`, Freerange keeps the combined range `1..11`. A later check that rules out a different exact number may replace the number remembered from an earlier check.

Earlier versions included an exact rational linear prover based on Farkas' lemma and other relational machinery. The current analyzer does not use that machinery or an SMT solver. In practice, those approaches made analysis unpredictable without proving much more real-world code. We also decided against analyzing numbers as real numbers, which would have been sweet, because doing so produces false proofs: floating-point arithmetic is not associative, rounds results, and can overflow or underflow.

### Function calls

Freerange follows calls to supported functions in the same file using the ranges known at each call. Imported functions are not followed. Imported constants are followed only when they resolve to a numeric literal such as `export const GAP = 24`. Literal default parameters work in supported calls; object and calculated defaults do not. Passing more arguments than the implementation declares is also unsupported. Unknown calls, when callbacks run, caught exceptions, changes made through another reference to the same object, and most framework behavior remain outside the subset.

### Static assertions

Inside a `console.assert`, Freerange can follow common UI calculations through named values: `Math.min` and `Math.max`, addition or subtraction by a nonnegative value, the same multiplication by a nonnegative value on both sides of a comparison, the fact that `index % columnCount < columnCount` when `columnCount` is positive, and fields read from a freshly constructed record. Freerange does not chain arbitrary comparisons: `left <= middle` and `middle <= right` do not by themselves prove `left <= right`.

### Loops

Freerange analyzes a loop again until the ranges known at the start of an iteration stop changing. Freerange does not simulate every runtime iteration or try to produce a formula for the final value. Ordinary counting loops usually settle after two or three analysis passes. If the ranges still change after 16 passes, analysis stops for that path.

### Objects and arrays

Freerange follows records, tuples, arrays, and tagged unions declared in your project through at most eight nested levels. A deeper property becomes unknown. A function is unsupported when its top-level input type cannot be represented.

Property reads are assumed to be stable and side-effect-free during one analyzed function call. A getter or Proxy that changes its answer or performs work is outside the model. Property writes, including assignments that invoke setters, are unsupported. Object spread is also unsupported because JavaScript copies only an object's own enumerable properties, which may not match the fields declared by its TypeScript type.

### Caller requirements

When a division or array read creates a requirement inside a function, Freerange tries to express the requirement using the function's parameters so callers can be checked. Freerange follows each intermediate calculation at most once. If one pass cannot reach the parameters, Freerange prints a local `assumes` condition instead.

These limits may make a result less precise or stop analysis, but they cannot make a guarantee stronger than the code supports.

## Development

```sh
bun install
bun run check
```
