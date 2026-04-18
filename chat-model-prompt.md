# External Chat Prompt: Freerange Direction

Historical prompt sent to an outside chat model. Do not treat this as the canonical state of the verifier. Use [README.md](./README.md), [todo.md](./todo.md), and [research.md](./research.md) first.

You do not have access to the codebase. Please reason from this prompt only.

## Project

This repo is about codifying the code patterns we want for a new era of UI apps written with AI. The demos are less important as one-off apps and more important as evidence for reusable patterns: if an agent regenerated a future UI from the docs, the result should be structurally good.

The subproject here is a static Freerange for ordinary TypeScript layout code.

The verifier reads normal TS functions plus strict `@fit` comments. It proves those comments from source, or reports `fail` / `unknown`. It does not run app code, start browsers, take screenshots, collect runtime traces, sample random inputs, compare fixtures, or treat unit tests as proof. Annotations are erased like TS types.

We are intentionally okay with TypeScript-like unsoundness in spirit. This does not need to be Coq. But we do not want "verification" to become just unit tests with better branding. If a fact is claimed as a verifier guarantee, it should come from static analysis of the source plus explicit assumptions.

## Current User-Facing DSL

Function contracts look like this:

```ts
/** @fit
 * given width: 0..1000
 * result.capped: 0..320
 * result.overflow >= 0
 */
function cappedOverflow(width: number) {
  const capped = Math.min(width, 320)
  return {capped, overflow: width - capped}
}
```

Rules:

- `given ...` lines are assumptions / preconditions.
- Bare lines are facts the checker must prove.
- Unsupported syntax is a parser error, not prose.
- Top-level `given` facts are trusted.
- Same-file helper calls prove the callee's `given` facts at the call site.
- A `@fit` block can sit directly above supported loops:

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

Loop specs use the same language. Loop-local `given` facts are trusted from that point forward. Bare loop checks are checked after the loop. Loop specs name locals directly; they do not have `result`.

Current supported facts include:

- intervals: `0..1000`, `int 0..10`
- comparisons: `==`, `>=`, `<=`, `>`, `<`
- basic arithmetic, bounded division, modulo for non-negative values / positive divisors
- `Math.floor`, `ceil`, `round`, `trunc`, `abs`, `sqrt`, `min`, `max`
- small known math facts such as `ceil(total / count) * count >= total`, floor hit testing, modulo bounds, order preservation through known-positive scale/divide
- tiny linear reduction from ranges and comparisons
- `.length`, array literals, spread append length, literal indexing, proven half-open array indexes
- per-object and per-item domains like `row.height: 0..40` and `items[].height: 0..40`
- one append-only running-sum `for...of` loop shape

Current sequence-ish vocabulary:

```ts
nondecreasing(rows.top)
spaced(rows, gap)
lastEnd(rows) == bottom
```

`nondecreasing` / `spaced` are atoms. `lastEnd(rows)` is an expression helper.

## Current Concern

The public DSL is starting to smell like it could grow into a second programming language.

For example, `spaced(rows, gap)` really means something like:

```ts
for each adjacent pair prev, next:
  next.top == prev.top + prev.height + gap
```

And current `lastEnd(rows)` means:

```ts
rows[rows.length - 1].top + rows[rows.length - 1].height
```

For the recognized running-sum loop, it can also be derived as:

```ts
y - gap
```

after this loop body:

```ts
rows.push({top: y, height: item.height})
y += item.height + gap
```

If we expose the decomposed form directly, we are tempted toward user-authored quantifiers, lambdas, folds, adjacent-pair callbacks, custom reducers, and maybe something Turing-complete-looking:

```ts
forall adjacent(rows, (prev, next) =>
  next.top == prev.top + prev.height + gap
)
```

That feels wrong for the committed public annotation language. It duplicates app logic in a second proof-ish language, creates more syntax for agents and humans to mess up, and makes the verifier feel less like TypeScript annotations and more like a mini theorem-proving language.

My current instinct:

- Keep the committed public DSL boring.
- Avoid public lambdas / callbacks / `forall` / arbitrary folds if possible forever.
- Let the checker internally lower named layout facts into quantifier-like or abstract-interpretation machinery.
- Let future prose-assisted/spec-driven workflows compile to structured facts or hidden IR, but do not commit prose as truth.
- Use ordinary TS source inference first. If a normal loop already proves a fact, infer it from the source.
- Add named generic layout facts only when a repeated UI shape earns a name.

Examples of a better public surface might be:

```ts
nondecreasing(rows.top)
stacked(rows, top, height, gap)
lastEnd(rows, top, height) == bottom
sum(rows.height) <= availableHeight
```

But this is still unsettled. `stacked` might be too semantic, `lastEnd` might still be unclear, and `sum(...)` may be the beginning of aggregate DSL creep.

Naming concern:

- `spaced` is better than an axis-specific name, but it still quietly assumes row-like `top` / `height` fields until views exist.
- `lastEnd` is clearer than a bottom-specific name, but still has the empty-sequence limitation. `extentEnd(rows, empty: top)` may be the better eventual total helper.
- `nondecreasing(rows.top)` is intentionally explicit about direction. Do not add aliases like `ordered`, `ascending`, or `increasing` until they mean something distinct.

## What Real UI Layouts Need

The verifier should care about guarantees app layouts actually need:

- bounds: widths, heights, offsets, indexes stay in usable domains
- no overflow: child inside parent, text line fits offered width, cells fit columns
- non-negative geometry: widths/heights/gaps/available space do not go negative
- order: rows/fragments/items are ordered by top/left/index/text offset
- contiguity/coverage: rows stack without overlap, text fragments cover a text range, columns cover a width
- length/index relations: generated rows match input items, indexes are inside arrays, visible ranges are valid
- helper contracts: userland `clamp`, center, grid math, and measurement helpers carry their contracts through calls
- text layout: Pretext means text geometry becomes userland data, so we can prove more ordinary and extraordinary text facts

Pretext-specific future facts might include:

- every line width fits the offered width
- fragments are ordered by text offset
- adjacent fragments cover a line's text range
- line ranges cover the rendered text range
- selection rects come from the same fragments used for paint
- decorative prefixes that affect wrapping are included in the measured stream

Geometry direction is also unsettled. We may start with plain field comparisons:

```ts
given child.x >= parent.x
given child.x + child.w <= parent.x + parent.w
```

and only add something like `rectInside(child, parent)` if the repeated shape deserves a name and gives better failure messages. We also do not want to accidentally dictate field names too hard: `x/y/w/h` vs `x/y/width/height` should be deliberate.

## Current Biases / Constraints

- Static-only. No runtime traces, no screenshots, no browser seam checks, no sampled sweeps.
- Prefer reducers, interval facts, source inference, object/array domains, and helper contracts before adding new atoms.
- Keep app code natural. Do not rewrite app code into checker-shaped helper calls.
- Keep annotations concise enough that humans might read them and agents can write them safely.
- Parser should yell on bad syntax. No recovery heuristics, no legacy aliases.
- Reports should be honest about assumptions. A future report should make trusted top-level and loop-local `given` facts loud.
- Add a positive pattern and a negative expected message for each new proof shape.
- Module/import summaries are future work; today helper tracking is same-file and transitive.
- We want this to compose with spec-driven development. A future LLM might translate prose to structured facts under the hood, but the committed layer should still be deterministic and checkable.

## Ask

Please explore very creative adjacent ideas. I am not asking for a generic abstract interpretation explanation. I want design options and risks for the future of this DSL and verifier.

Questions to think through:

1. Can the public DSL avoid lambdas, callbacks, `forall`, and arbitrary folds forever? If yes, what should replace them?
2. What is a good public vocabulary for sequence/layout facts that stays generic without becoming a programming language?
3. How should facts like `spaced` and `lastEnd` be decomposed internally while staying pleasant externally?
4. Should we have atoms like `stacked(...)`, aggregate expressions like `sum(rows.height)`, role declarations like `rows: verticalSpans(top, height)`, or something stranger?
5. How much can be inferred from ordinary TS loops, array operations, and helper contracts before users need to annotate?
6. What hidden IR would you use under the hood if the public DSL stays boring?
7. How can reports stay understandable if a named fact lowers into several internal constraints?
8. How do we avoid overfitting to demos while still covering real UI layout needs?
9. What prior-art-adjacent ideas should we steal from refinement types, liquid types, design systems, spreadsheets, databases, CSS layout, proof assistants, model checkers, constraint solvers, or UI test tooling?
10. What are the surprising / weird ideas here that might be worth prototyping, even if they sound too speculative?

Please be concrete. Invent possible syntax, internal representations, and report messages. Also challenge the assumptions above where they seem wrong.
