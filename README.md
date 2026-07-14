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

How it works: TypeScript knows that `height` is a number, but a number can still be zero. Freerange follows the calculation, sees that the division needs a nonzero `height`, and records that condition for callers. It then checks the visible call, sees that `0` breaks the condition, and reports both where the condition came from and where it was violated.

## Commands

- `fr`: print project errors and warnings
- `fr --audit`: print every function's contracts, plus code refactor suggestions to help Freerange analyze better

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

## Static Asserts

Freerange gives the standard one-argument `console.assert(condition)` a static meaning inside named top-level functions. TypeScript must resolve `console` to the environment's global console; a local or imported value named `console` is not treated specially.

Assertions at the very beginning of a function declare caller requirements. Assertions after any other statement ask Freerange to prove the condition at that point:

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

The first two assertions say what every caller must provide. They also let Freerange prove that the remainder is safe. The final assertion checks a useful result of the calculation.

### What is worth asserting?

Assert behavior that callers depend on, not every fact Freerange happens to prove. A useful assertion states something TypeScript cannot express and that a plausible type-correct refactor could break.

**Keep UI regions separated.** Numeric types cannot say that the input stays above the content:

```ts
console.assert(frame.input.bottom <= frame.content.top)
```

**Keep array windows valid.** Virtualized lists and paginated views usually need an ordered, in-bounds range:

```ts
console.assert(startIndex <= endIndex)
console.assert(endIndex <= itemCount)
```

**Keep values inside product limits.** A clamp often exists because rendering outside the range is invalid, not merely because the range is mathematically convenient:

```ts
const opacity = Math.min(1, Math.max(0, rawOpacity))
console.assert(opacity >= 0)
console.assert(opacity <= 1)
```

**Keep returned fields consistent.** Both fields below are ordinary numbers to TypeScript, but callers rely on the tray and input ending at the same edge:

```ts
const frame = {
  input: {bottom: inputBottom},
  inputTray: {bottom: inputBottom},
}
console.assert(frame.inputTray.bottom === frame.input.bottom)
return frame
```

**Declare real caller requirements.** A positive column count may genuinely belong to the caller, as in `itemColumn` above. Use a leading assertion only when invalid input should be rejected. If the function owns a sensible fallback, normalize or guard the value inside the function instead.

Avoid assertions that merely repeat every assignment, every `Math.max`, or every range Freerange can derive. An assertion opts the whole function into stricter checking, so a weak assertion can create work without protecting meaningful behavior.

### Assertion rules

Write one direct condition per assertion. An interior assertion may contain one numeric comparison (`===`, `!==`, `<`, `<=`, `>`, or `>=`) or one call to `Number.isInteger`, `Number.isFinite`, or `Number.isNaN`. Each comparison operand must be a name, numeric literal, property path, or array length.

Bind calculations before asserting over them:

```ts
const availableWidth = frame.right - frame.left
console.assert(availableWidth >= 0)
```

Do not put the subtraction directly inside the assertion. Split lower and upper bounds into two assertions instead of joining them with `&&`.

An assertion condition may not call a user function, carry a message argument, introduce control flow, read an array element, or perform arithmetic directly. These rules keep the meaning predictable and prevent an assertion from creating the evidence needed to prove itself.

A leading requirement may be `Number.isInteger(parameter)` or one comparison between a parameter and a fixed finite number. The number may be written directly or named by an immutable same-project constant whose initializer resolves to a numeric literal. Calculated and mutable constants are not accepted.

Assertions do not narrow later code. If later code depends on a condition, use an ordinary `if` guard or make the condition a leading caller requirement. Every path in a function containing an assertion must finish analysis without assuming that an unguarded divisor is nonzero or that an unproven array read is in bounds. Otherwise its assertions are blocked. Unproven, false, blocked, and unreachable assertions are errors in `fr`; successful assertions appear as `proves` in `fr --audit`.

Freerange does not change `console.assert` at runtime. JavaScript still evaluates the condition and logs a failed assertion unless the application's build removes the call.

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

## Refactoring audits

`fr --audit` is the detailed view intended for agents. It prints every function's result, file coverage, and the locations where Freerange recognizes a useful refactoring pattern.

Each suggestion says when the rewrite applies and what behavior it may change. The displayed before-and-after examples are analyzed in Freerange's test suite, and behavior-sensitive examples also have runtime tests. The audit gives no recommendation when syntax alone is not enough to choose safely. For example, an unknown function call does not show whether the function contains numeric work worth extracting.

## Recommended TypeScript checks

Project mode uses the project's `tsconfig.json` unchanged and requires `strictNullChecks`, which preserves types such as `number | null` for analysis. The following options give agents clearer TypeScript errors before Freerange runs:

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

These are recommendations, not all Freerange requirements. Freerange already treats `values[index]` as possibly missing without `noUncheckedIndexedAccess`, and handles optional properties conservatively without `exactOptionalPropertyTypes`. Fewer `any` values still produce more complete reports, so `noImplicitAny` is especially useful.

## Development

```sh
bun install
bun run check
```
