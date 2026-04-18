# Freerange Research

Future-useful notes. Keep this about direction and tried ideas, not a changelog.

## Direction

The public DSL should be a small layout constraint catalog over ordinary TS values. It should not become a second programming language.

Good public surface:

```ts
given width: 0..1000
rows.length == items.length
rows[].height: 0..40
rows[].top + rows[].height <= parent.bottom
nondecreasing(rows.top)
spaced(rows, gap)
extentEnd(rows, top) == bottom
```

Avoid public syntax like:

```ts
forall adjacent(rows, (prev, next) => next.top == prev.top + prev.height + gap)
sum(rows.map(row => row.height + gap))
```

Users may name layout shapes. They should not write traversals.

## Views

Views are probably the right way to keep future atoms generic without forcing app field names:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

A view should only map fields. It should not assert layout properties. Do not add views just to make the first row loop prettier; add them when rows/columns/text/rects create real field-name pressure.

Once views exist, current facts can become less ad hoc:

```ts
nondecreasing(rows.start)
spaced(rows, gap)
extentEnd(rows, top) == bottom
inside(child, parent)
partitions(fragments, textRange)
```

## Empty Extents

`lastEnd(rows)` is useful but partial. It requires `rows.length > 0`.

The total shape should be:

```ts
extentEnd(rows, top) == bottom
```

This matters because the ordinary stack loop:

```ts
let y = top
for (const item of items) {
  rows.push({top: y, height: item.height})
  y += item.height + gap
}
return {rows, bottom: y - gap}
```

is wrong for empty `items` when `gap > 0`. A better implementation is:

```ts
const bottom = rows.length === 0 ? top : y - gap
```

The checker should catch this cleanly.

## Source Inference

Keep app code natural. A checker that understands locals, loops, arrays, object literals, `?.`, `??`, and `Math.min` / `Math.max` / `Math.floor` / `Math.ceil` buys more than proof-shaped runtime helpers.

High-value inference:

- `items.map(...)` preserves length and simple field domains; source order can come later when there is a public fact that needs it.
- append-only `for...of` can infer length, cursor recurrence, `spaced`, `nondecreasing`, and per-item field ranges.
- conditional push should infer `rows.length <= items.length`, not equal length. Subsequence/source order can come later when a fact needs it.
- indexed loops should infer index ranges. One-to-one source order can come later when a fact needs it.
- thin running sums like `total += row.height` and guarded sums like `if (...) total += row.height` already give numeric ranges. Next reducer-like work should be min/max accumulation and cleaner reports when totals feed later facts.
- mutation like `sort`, `reverse`, `splice`, and indexed assignment should kill sequence facts unless summarized.

## Wildcard Semantics

One-sided `[]` is anonymous `for every item here`:

```ts
rows[].height <= maxHeight
sections[].rows[].height <= maxHeight
```

Do not give two-sided `[]` a hidden meaning:

```ts
rows[].top <= boxes[].bottom
```

That could mean same index, all pairs, matched by source item, matched by id, or adjacent rows. The syntax should carry the relationship.

Einops is a useful taste reference: named axes make repetition meaningful. A future syntax could use repeated labels for same-index comparison:

```ts
rows[i].top <= boxes[i].bottom
```

and different labels for all-pairs comparison:

```ts
children[i].right <= blockers[j].left
```

SQL is the taste reference for source/id matching: name the relation. If two collections match by source item, fragment id, line id, or range ownership, bracket labels alone are probably not enough.

Keep this as design pressure, not implemented syntax, until a real demo needs it.

## Internal IR

A layered IR seems better than one giant SMT encoding:

- scalar refinements: intervals, small linear facts, symbolic equality, modulo/congruence facts
- object/path facts: `Field(row, "top")`, `Path(rows, i, "height")`
- sequence facts: `Len(rows)`, `Elem(rows, i)`, append histories, source maps
- views: spans, ranges, rects, logical rects
- layout constraints: `Nondecreasing`, `Spaced`, `Inside`, `Partitions`, `SameSource`
- loop summaries: cursor recurrences and append summaries
- optional backend obligations: SMT later, only where earned

Named facts should have both a human lowering and a proof rule. E.g. `spaced(rows, gap)` means adjacent starts differ by previous size plus `gap`, but the proof rule can come from a recognized cursor loop.

## Module Boundaries

Imports should find contracts, not turn Freerange into a second TypeScript compiler. The first useful rule is:

- same-file helpers may still be read from source
- cross-file calls use exported `@fit` contracts as summaries
- imported helper contracts must be proved from source in the same run before callers can use them
- imported bodies are not inlined at the call site

The resolver follows named imports through TypeScript module resolution when they land on local source files, and it follows explicit named re-export barrels. That is enough for relative helpers, `.tsx` helpers, and `tsconfig` path aliases without committing to package exports, declaration-only imports, wildcard barrels, summary files, stale-summary trust, or workspace caches.

Next, reports need to say whether a fact came from source, a trusted `given`, a source-proved imported contract, or a trusted summary. Do not let a checked-in summary launder a failed source proof.

## Reports

Reports matter as much as proof power. Each serious atom needs a report template.

Good report shape:

```txt
unknown: spaced(rows, gap)

Need for adjacent rows:
  next.top == prev.top + prev.height + gap

Proved from loop:
  next.top == prev.top + prev.height

Missing term:
  + gap
```

Reports should separate:

- proved from source
- trusted top-level `given`
- trusted loop-local `given`
- source-proved imported contract
- trusted summary, if that ever exists
- unsupported

Also add vacuity warnings. Inconsistent assumptions should not make everything look beautifully proved.

## Atom Admission

Before adding an atom, require:

- UI-independent name
- field-name-independent view, if the fact is shape-based
- written semantic lowering
- "does not imply" section
- positive pattern
- negative pattern
- report template
- at least three non-demo use cases

`spaced`, `inside`, `partitions`, `sourceOrder`, and `sameSource` are promising. `goodRows`, `chatLayout`, and app-specific atoms are not.

## Prior Art To Steal From

- Refinement / liquid types: small decidable predicates close to code, checked statically.
- Dafny: clear assume/assert split and useful failed-obligation diagnostics, not proof-heavy user code.
- Constraint programming global constraints: named constraints with solver-owned decompositions.
- CSS logical vocabulary: prefer start/end, inline/block, main/cross over physical-only names.
- Spreadsheets: dependency chains humans understand.
- SQL checks: named local constraints and clear failure labels.
- SystemVerilog assertions: `assume` / `assert` / maybe future `cover`, not the syntax.
- SMT / Alloy: backend and counterexample inspiration, not public syntax.

## Worked

- Start with tiny abstract domains. Intervals, path-sensitive narrowing, append-only sequence facts, and exact string facts carried farther than heavier numeric theories would have early.
- Split intervals by layout seams. Column bands, line-left / line-interior / line-right regions, and branch-local facts were clearer than one giant interval.
- Preserve remembered expressions when possible. Keeping an expression around after a clear `Math.min` / `Math.max` winner helped prove center-line and aspect-ratio facts without a heavier solver.
- Read source by default. Use summaries only for genuinely opaque helper boundaries, and make the report say which helper was trusted.
- Use mutation/red probes as research signals. They are good for finding holes in the proof surface, but they should not become verifier guarantees.
- `life-calendar` was a useful hard numeric example: `**`, `Math.sqrt`, `Math.ceil`, integer facts after `ceil(life / countX)`, and half-open grid hit testing.

## Did Not Earn Itself

- Treating browser behavior as statically proved.
- Hard-coding app helper names into the analyzer.
- Rewriting app code into checker-shaped helpers like `add(...)` / `sub(...)`.
- Public lambdas, `forall`, arbitrary folds, aliases, or prose as truth.
- Giant unsplit intervals.
- Pulling in every demo at once before a second shape was actually understood.
- SMT, octagons, or polyhedra up front. Let a real layout law earn them.
