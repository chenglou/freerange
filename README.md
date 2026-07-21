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

Freerange supports a subset of TS:
- Named, synchronous top-level functions in a file; Freerange follows calls between functions in the same file
- Numbers, booleans, strings, nullable values, plain objects, tagged unions, dense arrays, and fixed tuples
- `if`/`else`, ternaries, non-fallthrough `switch`, `&&`, `||`, `!`, `??`, `for`, `while`, and `for...of` loops
- Arithmetic, comparisons, object field and array reads, selected `Math` operations, and `Number.isInteger`, `Number.isFinite`, and `Number.isNaN`

Freerange could theoretically support a much larger subset of TS, and did before its public release. Those patterns often made numeric inference and proofs much harder and slower, however, and some questions are undecidable in general. Now that AI agents write code, we strongly recommend asking agents to refactor important calculations into shapes that Freerange analyzes well, guided by `fr --audit`. Code that is easy to analyze tends to resemble functional programming: immutable data, explicit inputs and outputs, and clean, direct control flow.

- **Put important calculations in small named functions.** A React component, callback, or async function can call a plain synchronous helper. Keep any helper functions that Freerange needs to inspect in the same file.
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

- **Name a calculation before checking it.** If the divisor is `oldMax - oldMin`, write `const oldSpan = oldMax - oldMin`, check `oldSpan === 0`, and divide by `oldSpan`. Checking `oldMin === oldMax` does not tell Freerange about the separately calculated `oldSpan`. Audit code: `[guard-derived-value]`.

- **Decide how invalid inputs should be handled before using them.** If `columnCount` must be a positive integer, either require that with leading `console.assert` calls or normalize it with `Math.max(1, Math.floor(columnCount))`. Only normalize when the application actually wants that runtime behavior. Audit code: `[encode-input-rule]`.

- **Choose the order of arithmetic deliberately.** Formulas that are equivalent on paper can round, overflow, or underflow differently with JavaScript numbers. For example, `frameWidth / (imageWidth / imageHeight)` introduces a ratio that can round to zero; `(frameWidth * imageHeight) / imageWidth` avoids that particular problem. The two expressions can still round differently. Audit code: `[use-direct-operands]`.

- **Decide what a missing array element means.** Use `values[index] ?? fallback` only when the application really wants a fallback. Otherwise, prove that `index` is an integer from zero through `values.length - 1` before using `values[index]!`. A bounds check cannot detect a hole in a sparse array, so Freerange expects arrays to be dense. Audit codes: `[handle-missing-element]`, `[guard-array-index]`.

- **Write the condition and loop directly.** Prefer `width === 0` over using a number as a condition, such as `width || 1`. Use a regular loop for a simple dense-array calculation when callback arguments, callback effects, and a newly allocated result array do not matter. Audit codes: `[write-explicit-condition]`, `[use-loop-for-aggregation]`.

- **Write object copies explicitly.** Use `{width: layout.width, height: layout.height}` instead of `{...layout}`. Use dense arrays and fixed-length tuples, and do not modify objects or arrays after creating them. Rebuilding an object is not equivalent to mutation when other code observes its identity or the mutation.

- **Give each union case a tag and switch on it.** Use a tagged union when different cases carry different fields. Make the `switch` exhaustive and do not use fallthrough.

- **Check and use the same local value.** When a value comes from module, class, or reactive state, store it in a local first. For example, write `const currentScale = scale; if (currentScale !== null) return currentScale` instead of checking one read of `scale` and returning another.

- **Use precise TypeScript types.** Avoid `any`, casts, and suppression comments. Parse external data before passing it to a numeric helper, give the helper typed parameters, and pass only the fields it uses. A file containing `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `eval` is rejected because its declared types cannot be trusted.

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

A caller requirement is not automatically a bug. For example, `requires: columns >= 1` means the function is safe under that condition; it does not mean Freerange found a caller passing zero. Freerange checks supported same-file calls, but it is not a repository-wide call-site verifier. Imported calls and unsupported callers may remain unchecked.

An `ensures` line assumes its `requires` and `assumes`. A requirement may be a real API rule, or it may expose a relationship Freerange cannot currently prove. An assumption may identify a real input boundary or an analysis limitation. Decide what the program should do before changing code to remove either one.

Always read the coverage line. No findings does not mean an unsupported file is safe. A derived guarantee becoming weaker, for example `at least 54` becoming `at least 0`, appears in the audit rather than the shorter findings output.

## Analysis Scope

Freerange deliberately analyzes a restricted part of TypeScript. When code leaves that scope, `fr --audit` says so instead of guessing what the code does. If an unsupported pattern is important in production code and cannot be reasonably refactored, please file an issue. We're open to expanding the scope when the added complexity proves worthwhile.

### Numbers

Freerange's numeric analysis is designed for layouts and other everyday application code. For each TypeScript `number`, Freerange remembers its lowest and highest possible values, whether it is an integer, whether it may be `NaN` or infinite, and at most one exact value that has been ruled out. For example, after `value !== 0`, Freerange remembers that `value` cannot be `0`.

Freerange does not keep gaps or arbitrary sets of possible numbers. If one branch produces `1..2` and another produces `10..11`, Freerange keeps the combined range `1..11`. A later check that rules out a different exact value may replace the value remembered from an earlier check.

Freerange recognizes repeated uses of the same stored value, including local aliases, stable property and array reads, lengths, and the same argument passed to multiple parameters of a function in the same file. For example, `const span = right - left; span - span` is exactly `0` unless `span` is infinite or `NaN`. Two separately evaluated expressions are not assumed to produce the same value just because their source code looks alike. Store the result in a local when the equality matters.

Freerange does not search for arbitrary relationships between different values or use a general-purpose theorem prover. Those approaches made earlier versions less predictable without proving much more real code. Freerange also reasons about JavaScript floating-point numbers rather than ideal real numbers. Real-number algebra would produce false guarantees because JavaScript arithmetic rounds and can overflow or underflow.

### Function calls

Freerange analyzes supported function calls in the same file using what it knows at each call. It does not analyze imported functions. It reads an imported constant only when the constant resolves to a numeric literal such as `export const GAP = 24`. Literal default parameters work in supported calls; object and calculated defaults do not. Passing more arguments than the implementation declares is also unsupported.

Freerange does not guess what an unknown function does, when a callback runs, which exceptions are caught, how another reference might change an object, or how a framework schedules work.

### Static assertions

Inside a `console.assert`, Freerange can prove several common UI calculations through named values: `Math.min` and `Math.max`, adding or subtracting a nonnegative value, multiplying both sides of a comparison by the same nonnegative value, `index % columnCount < columnCount` when `columnCount` is positive, and fields read from a newly created object. Freerange does not chain arbitrary comparisons: `left <= middle` and `middle <= right` do not by themselves prove `left <= right`.

### Loops

Freerange checks a loop repeatedly until the possible values at the start of an iteration stop changing. It does not simulate every runtime iteration or try to derive a formula for the final value. Ordinary counting loops usually settle after two or three checks. If the possible values still change after 16 checks, Freerange stops analyzing that path.

### Objects and arrays

Freerange reads plain objects, tuples, arrays, and tagged unions declared in your project through at most eight nested levels. A deeper property becomes unknown. A function is unsupported when one of its parameter types cannot be represented within this scope.

Freerange assumes that reading a property returns the same value and performs no work during one analyzed function call. A getter or Proxy that changes its answer or performs work is outside the scope. Property writes, including assignments that invoke setters, are unsupported. Object spread is also unsupported because JavaScript copies only an object's own enumerable properties, which may not match the fields declared by its TypeScript type.

### Caller requirements

Every plain `number` parameter must be finite and not `NaN`. The same rule applies to numeric fields in fixed-shape object parameters, even when the function does not read them. Numeric literal types such as `1 | 2` already satisfy the rule. Nullable numbers, arrays, tuples, and tagged unions use more specific `assumes` lines instead. When a caller omits an argument with a supported literal default, the default can satisfy the requirement automatically.

Calls to supported functions in the same file either prove these requirements, require their own callers to satisfy them, or report a definitely invalid argument. After a call proves that an argument is finite, later uses of that same stored value can reuse the result. Writing `console.assert(Number.isFinite(value))` at the start of a function is allowed but normally redundant. `Number.isInteger(value)` is stronger and replaces the finite requirement.

Division and array reads can create additional requirements. Freerange tries to express each requirement using the function's parameters so that callers can be checked. Later operations can reuse the requirement only when they use the same stored value in the same branch. Assigning a new value or repeating the calculation starts over. Freerange traces each intermediate value at most once; if it cannot express the condition using the parameters, `fr --audit` prints a local `assumes` condition instead.

Code outside this scope may make a result less precise or stop analysis. Freerange does not publish a stronger guarantee by pretending that unsupported code was understood.

## Development

```sh
bun install
bun run check
```

## Credits

[Infer](https://github.com/facebook/infer), [AlphaProof](https://deepmind.google/blog/ai-solves-imo-problems-at-silver-medal-level/)
