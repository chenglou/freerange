# Freerange Todo

This is the fresh-agent handoff.

The project is a static checker for ordinary TS layout code plus strict `@fit` comments. Keep the public DSL small: ranges, comparisons, field paths, and named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, aliases, prose-as-truth, browser runs, runtime traces, sampled sweeps, or screenshots.

Prefer source inference, intervals, small reducers, array/object domains, and helper contracts before adding atoms. Every new proof shape gets one positive pattern and at least one negative expected message.

## Current Surface

- Function specs use `@fit`. `given` lines are trusted assumptions; bare lines are facts to prove.
- Loop specs also use `@fit` on the supported append-only `for...of` shape. Placement decides scope. Loop checks name locals directly; they do not have `result`.
- Supported sequence names are `nondecreasing(rows.top)`, `spaced(rows, gap)`, and `lastEnd(rows)`.
- Wildcard comparisons support one collection side and one scalar side:

```ts
rows[].top + rows[].height <= parent.bottom
fragments[].width <= offeredWidth
```

- Two wildcard collection sides and nested wildcards are intentionally unsupported until their semantics are explicit.

## Do Next

1. **Restrict trusted assumptions.**
   Top-level `given` should only mention params, globals, and imported assumptions. It should not mention `result` or mutable locals. Loop-local `given` should be ambient input facts only, e.g. `given items[].height: number[0, 40]`, not `given rows.length == items.length`.

2. **Add an assumption ledger.**
   Reports should separate `proved from source`, `trusted top-level given`, `trusted loop-local given`, `proved helper contract`, `trusted helper summary`, and `unsupported`. Also add a vacuity check for inconsistent assumptions, e.g. `given width: number[500, 400]`.

3. **Add `extentEnd(rows, empty: top)`.**
   `lastEnd(rows)` is only valid for non-empty rows. `extentEnd` should handle empty rows and catch the realistic `bottom = y - gap` bug when `items.length` may be `0`.

4. **Improve wildcard comparisons carefully.**
   Keep the current one-wildcard-vs-scalar rule. Next useful steps:
   - same-item comparisons only if the syntax makes same-item semantics explicit
   - zip/cross comparisons only if the syntax makes zip/cross semantics explicit
   - nested wildcard paths like `sections[].rows[].height`
   Do not silently guess what two wildcard sides mean.

5. **Broaden source inference before adding atoms.**
   Add common TS shapes:
   - `items.map(...)` preserves length and source order
   - conditional push gives `rows.length <= items.length` and subsequence/source order, not equal length
   - indexed loops infer `rows[].index: int[0, items.length - 1]`
   - boring reducers like `total += row.height` become internal measures
   - mutation like `sort`, `reverse`, `splice`, or indexed assignment kills sequence facts unless summarized

6. **Improve sequence reports.**
   `spaced(rows, gap)` failures should say what adjacent rows need, what the loop proved, and what term is missing. Wildcard failures should say "every `rows[]` item" and name the smallest useful missing fact.

7. **Delay views until field-name pressure earns them.**
   Views are likely the right long-term answer, but do not add them just to make the first row loop nicer. Add the first view only when field names become real pressure across rows/columns/text/rects:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

   A view is only a field mapping. It must not assert layout facts.

8. **Prefer plain geometry first.**
   Start with field comparisons:

```ts
child.x >= parent.x
child.x + child.w <= parent.x + parent.w
```

   Add `inside(child, parent)` only when repeated reports prove the name earns itself. If it lands, decide whether it includes non-negative width/height; probably yes.

9. **Add Pretext facts through generic range/lineage facts first.**
   Try these before text-specific atoms:
   - `fragments[].width <= offeredWidth`
   - `nondecreasing(fragments.textStart)`
   - `partitions(fragments, textRange)`
   - `sourceOrder(lines, fragments)`
   - `sameSource(selectionRects, paintFragments)`

10. **Add module/import summaries.**
    Same-file helper tracking is enough for the prototype, not for a helper library. Summaries must report when they were trusted.

## Public DSL Governance

Before adding a public atom, write its mini spec:

- UI-independent name, e.g. `spaced`, `inside`, `partitions`
- required shape/view, if any
- exact lowering in ordinary words
- what it does **not** imply
- positive pattern
- negative pattern
- report template
- at least three non-demo use cases

Good atoms name layout concepts. Bad atoms name apps or vibes: `goodRows`, `chatLayout`, `validTextLayout`, `masonryLooksBalanced`.

Aggregates are okay only if they stay path-only:

```ts
total(rows.height)
max(lines.width)
count(visibleRows)
```

No aggregate callbacks, filters, inline arithmetic, or folds.

## Useful Weird Prototypes

- `freerange infer stackRows`: generate candidate annotations; user chooses what to commit.
- `cover appendOnly(rows)`: not a guarantee, just asserts the checker recognized a source pattern.
- proof dependency output: show which loop/source facts a guarantee depended on.
- symbolic mini-diagrams in reports, not screenshots.
- generated docs page per atom with semantics, non-implications, proof patterns, and common failures.
- constraint mining over many layouts to discover repeated loop summaries before adding atoms.

## Made Less Urgent

- Numeric atoms. Existing interval math, small linear reduction, ceil/floor/modulo facts, positive scale/divide facts, and `Math.min` / `Math.max` branch facts cover a lot.
- Clamp atoms. Userland clamp works through helper contracts plus `Math.min` / `Math.max`.
- `sameLength` as a primitive. Append/running-sum inference often proves length directly.
- Early geometry atoms. Many first cases are ordinary comparisons plus wildcard facts.
- Exhaustive integer sweeps. Keep them out unless a finite-domain static proof explicitly earns its complexity.

## Current Limitations

- No import graph or module summaries.
- No public views yet.
- No `extentEnd(rows, empty)` yet.
- No assumption ledger or vacuity warnings yet.
- `given` is still too permissive.
- Loop-level `@fit` only attaches to the supported append-only `for...of` loop.
- Loop-local `given` facts are trusted from that point forward, not proved against earlier state.
- Wildcard comparisons support one collection side and one scalar side only.
- No nested wildcard paths.
- No conditional push, indexed loop, `map`, reducer, or mutation-kills-facts summaries yet.
- No general loops, nonlinear solver, TS type narrowing, overloads, generics, classes, async, closures, strings, booleans, or unions.
