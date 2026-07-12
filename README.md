# Freerange

Freerange analyzes the numeric behavior of TypeScript functions. It reports conditions callers must satisfy, ranges and other facts about returned values, and the parts of a file it could not fully analyze.

## Commands

- `fr`: print TypeScript errors, Freerange findings, and coverage for the project
- `fr --audit`: print every function's analysis result and applicable refactoring suggestions

Both commands can take a file to narrow the output to just info for that file.

## One production example

Our production app positions an input bar, a tray below it, and the surrounding content from the window size. We added one line:

```ts
windowSizeY = Math.max(320, windowSizeY)
```

The branch almost never runs because real windows are taller than 320 pixels. Its purpose is to state an actual product rule: layout below that height is unsupported. With that rule in the code, Freerange derived facts several calculations later:

```text
ensures: return.inputTray.top is a finite number at least 54
ensures: return.nav.bottom is a finite number at least 320
```

Nobody wrote `54` as a bound. Freerange combined the window minimum, the gap, and the input-row height. If a later refactor weakens or removes that guarantee, the contract changes with the code.

The same analysis found a different problem in image-fitting code. A 0 by 0 image caused division by zero, followed by `0 * Infinity`, which produces `NaN`. The function now handles missing image dimensions before doing the calculation, and its report no longer requires every caller to do so.

TypeScript can tell you that a value is a number. Freerange tells you which numbers it can be, including whether `NaN` or Infinity is possible.

## Running it

- Like `tsc`, `bun fr.ts` searches the current directory and then its parents for the nearest `tsconfig.json`. It analyzes that project and its declared project references, then prints lint findings and coverage.
- `bun fr.ts src/some/file.ts` prints the project's lint findings narrowed to that file, under the same `tsconfig.json` a bare `bun fr.ts` finds — the file argument never changes which configuration governs. When a config exists, the file must belong to that project. Without a config, Freerange analyzes the file with its fallback TypeScript settings.
- `bun fr.ts --audit` prints every function's analysis result and the refactoring suggestions that apply, one unit per file, with project coverage at the end.
- `bun fr.ts --audit src/some/file.ts` prints exactly that file's unit of the project audit. Use this while moving a calculation into the supported subset.
- TypeScript diagnostics use TypeScript's own formatting. Freerange findings follow its plain and pretty location and color conventions; the project's `pretty` setting wins, otherwise `NO_COLOR`, `FORCE_COLOR`, and terminal detection decide. A file-specific error skips that file while clean files still analyze. A project-wide diagnostic, such as a missing package named in `compilerOptions.types`, skips that project's files because their type information cannot be trusted. The command exits with status 1 when TypeScript reports an error.

These commands write no files. Redirect stdout when you deliberately want a snapshot. No lint findings does not mean an unsupported or partially analyzed file is safe, so always read the coverage line. A change such as `at least 54` becoming `at least 0` is visible only in the audit's contract output, not in the lint findings.

## Reading contracts

- `requires`: a condition the caller must satisfy. The guarantee below it assumes the condition is true.
- `ensures`: a guarantee about the returned value whenever the function returns.
- `assumes`: an input condition Freerange accepts without proving, such as a number parameter being finite and not `NaN`.
- `unsupported`: the function uses code outside the analyzed subset. Only the first blocker is shown, so rerun after changing it.
- `stopped`: Freerange analyzed part of the function, but at least one path stopped. `on analyzed paths` describes only the paths that completed; it is not a contract for the whole function.
- `skipped`: module setup contained a statement Freerange did not analyze. Values that statement could change are not trusted afterward.

## Static assertions

Freerange treats a direct call to the standard `console.assert(condition)` as a static assertion when the call has exactly one argument, is a standalone statement, and appears in a named top-level function declaration. A local or imported value named `console` is not treated specially.

Consecutive assertions at the very start of the function declare caller requirements. A requirement may be `Number.isInteger(parameter)` or a direct comparison between one parameter and a numeric constant. Requirements narrow that parameter, print as `requires`, and are checked when Freerange analyzes a supported same-file call. Any assertion after another statement asks Freerange to prove the condition at that point:

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

Write one direct condition per assertion, e.g. two assertions for a lower and upper bound instead of one condition joined with `&&`. Conditions may use the side-effect-free arithmetic, property reads, and standard numeric checks Freerange already analyzes. An assertion condition may not call a user function, carry a message argument, introduce control flow, read an array element, or perform division or remainder. Bind such a calculation before the assertion when the function already establishes the calculation's requirements. This keeps the assertion from creating the condition needed to prove itself.

A later assertion does not narrow subsequent statements. If later code depends on a condition, use an ordinary `if` guard or make the condition a leading caller requirement. Every path in a function containing an assertion must finish analysis without site-specific assumptions; otherwise no assertion in that function is accepted as proven. A condition already known to fail or remain uncertain keeps that more specific result; an otherwise successful condition is blocked. Unproven, failing, blocked, and unreachable assertions are errors in `fr`. Successful assertions are quiet there and print as `proves` in `fr --audit`.

Freerange does not change `console.assert` at runtime. JavaScript still evaluates the condition and logs a failed assertion unless the application's build removes the call.

## Writing analyzable code

Freerange is deliberately designed for code that can be refactored, especially code written or maintained by agents. The goal is not to accept every TypeScript pattern. The goal is to make the useful boundary predictable and make good rewrites cheap.

The supported subset is a small set of general rules, not a list copied from the current example projects. A rule can be worthwhile when only one current function needs it if the rule is simple, complete, and easy to predict. Conversely, many matching call sites do not justify a collection of special cases. The examples below demonstrate the rules; they do not define them.

**Keep the numeric part small and explicit.** Put important calculations in synchronous named top-level function declarations with explicit inputs. A React component, callback, or async function can call the helper even when the surrounding framework code remains unsupported. Unsupported framework code does not need to be rewritten unless its numeric behavior needs a contract.

For example, keep image fitting in a plain function and let the component use its result:

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

**Do not mix unrelated types in one binding.** Use a tagged union when behavior differs by shape, and switch on its string or boolean tag. Do not use `any` to bypass that distinction.

**State real domain rules in executable code.** For example, a virtualized grid may define its column count as a positive integer, and an application may define a minimum supported window size. Do not add a clamp merely to improve a report. A clamp changes runtime behavior and belongs only where that behavior is intended.

**Guard the exact value an operation uses.** For example, if the divisor is `oldMax - oldMin`, bind that expression to `oldSpan` and check `oldSpan === 0`. Freerange does not generally remember an algebraic relationship between two separate values, so checking `oldMin === oldMax` does not currently prove a later fact about the subtraction.

Be careful with precomputed ratios. Two positive numbers can divide to an exact result so tiny that JavaScript rounds it to zero. In image layout, `(frameWidth * imageHeight) / imageWidth` can therefore be easier to verify than `frameWidth / (imageWidth / imageHeight)` once the original dimensions are checked. The two expressions may round differently, so precision-sensitive code must choose its evaluation order intentionally.

**Treat values as immutable after construction.** Rebuild a plain record by listing its fields, e.g. `{width, height: layout.height}`. Object spread is outside the supported subset because its runtime rules for inherited and enumerable properties are easy to model incorrectly. Rebuilding is not a general replacement for mutation when callers observe object identity or the mutation itself. Array writes often need a larger algorithm change rather than a mechanical rewrite.

**Snapshot unstable state before calculating.** Copy module or reactive state to a local before checking and using it. For example, write `const currentScale = scale; if (currentScale !== null) return currentScale`, rather than checking one read of `scale` and returning a second read. Freerange treats separate module reads as separate values; the local snapshot makes the intended identity explicit.

**Use direct control flow.** Write the numeric condition you mean instead of relying on truthiness, use exhaustive tagged-union switches without fallthrough, and use explicit loops for simple dense-array aggregation. Array callbacks are not automatically equivalent to loops because holes, callback arguments, returned arrays, and side effects can be observable.

**Let TypeScript establish the shape.** Do not use casts or `any` as proof. Freerange carries those values without numeric claims. Parse and validate outside data, then pass checked values into the numeric helper. A file containing `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `eval` is rejected because its declared types can no longer be trusted.

## Limits to expect

Freerange tracks each value's range, integer status, possible `NaN`, possible Infinity, and at most one constant excluded by a branch check. It does not keep arbitrary formulas or relationships between separate values. When branches meet, the result covers every branch. A later check that excludes a different interior constant can replace the earlier exclusion; guard the exact divisor immediately before using it when several exclusions matter.

Loops are analyzed until their state stops changing, without unrolling runtime iterations or deriving a closed formula. Ordinary counting loops usually stabilize after two or three analysis passes. A loop that still changes after 16 passes is reported as stopped. This limit also catches structures that grow one nested record per pass; it can conservatively stop an unusually long chain of loop-carried variables that would eventually stabilize.

Project-owned record, tuple, array, and tagged-union types are followed through at most eight nested levels. A deeper or recursive property becomes an unknown value, while a function whose root input type cannot be represented is unsupported. Pass the finite fields a calculation actually uses instead of passing a recursive or very large application model.

A caller requirement can follow local calculations, e.g. division by `width - 1` can report `width is not 1`. Freerange limits that expansion to the number of instructions in the function so repeated calculations cannot produce exponentially large text. A larger expansion prints a local `assumes` line instead. Guard the final local value inside the function when the condition belongs there.

Function calls are analyzed when Freerange can see and support the callee. A same-file call must currently pass every declared parameter explicitly, even when an optional parameter or default value lets JavaScript omit the argument. Unknown calls, callback order, mutation through aliases, and most framework effects stop the affected path or function. An imported constant is followed only when its initializer is a plain numeric literal, e.g. `export const GAP = 24`; calculated constants and imported function behavior are not inferred.

Freerange assumes that repeated reads of a property stay stable during one analyzed synchronous calculation. Snapshot framework or reactive state into plain local values before handing it to a numeric helper when that stability is not guaranteed.

Assertions can additionally prove a small set of local ordering patterns common in UI calculations: values selected by `Math.min` or `Math.max`, adding or subtracting a nonnegative value, matching multiplication by a nonnegative factor, positive remainder bounds, and fields read from a fresh record. This producer walk is available only while the assertion is checked. It does not add relationships to ordinary branches or return-contract inference, and it does not retain a proved assertion for later statements.

An `ensures` line assumes its `requires` and `assumes`. A `requires` line may be a real API condition, or it may expose a relationship Freerange cannot currently prove. An `assumes` line may identify an unchecked program boundary or an analysis limitation. Neither should be changed automatically without deciding what the program should do for that input.

## Audits

`bun fr.ts --audit` is the deep view intended for agents. For each file it prints coverage, every function's analysis result, and the locations where Freerange recognizes a useful refactoring pattern. Run `bun fr.ts --audit <file>` for the same output narrowed to one file.

Each pattern says when the rewrite applies and what behavior it may change. The catalog's before and after snippets are run through Freerange in the test suite, and behavior-sensitive examples also have runtime tests. To keep the output short, the audit prints one primary example for each cause and describes secondary options without repeating their code. The audit deliberately gives no recommendation when the syntax alone is not enough to choose a safe rewrite. For example, an unknown function call does not prove that the function contains numeric work worth extracting. The audit does not edit source code.

Library users can call `auditSource(file, source)` to receive the same coverage, source references, and guide IDs as structured data instead of parsing the formatted audit.

## Recommended TypeScript checks

Project mode uses the project's tsconfig unchanged and requires `strictNullChecks`, which preserves types such as `number | null` for the analysis. For clearer TypeScript errors before running Freerange, we recommend:

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

These are authoring recommendations, not all Freerange requirements. Freerange already treats a bare `values[index]` as possibly `undefined`, even without `noUncheckedIndexedAccess`, and handles optional properties conservatively without `exactOptionalPropertyTypes`.

Freerange does not trust values typed as `any`: it carries them without making claims, and a path stops when an operation needs the value to be a number. Fewer `any` values therefore produce more complete reports. Prefer `noImplicitAny`, and annotate or narrow remaining `any` values where practical.
