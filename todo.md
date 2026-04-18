# Freerange Todo

This is the fresh-agent handoff.

The project is a static checker for ordinary TS layout code plus strict `@fit` comments. Keep the public DSL small: ranges, comparisons, field paths, and named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, aliases, prose-as-truth, browser runs, runtime traces, sampled sweeps, or screenshots.

Prefer source inference, intervals, small reducers, array/object domains, and helper contracts before adding atoms. Every new proof shape gets one positive pattern and at least one negative expected message.

## Current Surface

- Function specs use `@fit`. `given` lines are trusted input facts; bare lines are facts to prove.
- Loop specs also use `@fit` on the supported append-only `for...of` shape. Placement decides scope. Loop checks name locals directly; they do not have `result`.
- Supported sequence names are `nondecreasing(rows.top)`, `spaced(rows, gap)`, and `lastEnd(rows)`.
- `extentEnd(rows, top)` handles the empty-row case for append-only row loops.
- Wildcard comparisons support one collection side and one scalar side. The collection side may be nested:

```ts
rows[].top + rows[].height <= parent.bottom
fragments[].width <= offeredWidth
sections[].rows[].height <= maxHeight
```

- Two wildcard collection sides are intentionally unsupported until their semantics are explicit.
- Array mutation is conservative: `reverse` and `sort` forget sequence facts, while `splice` and indexed assignment forget length/item facts.
- Simple `for...of` scalar running sums like `total += item.height` produce numeric ranges when the increment is known non-negative.
- Named local imports can call exported function declarations with `@fit` contracts when TypeScript resolves them to local source. Cross-file calls use the contract as a summary; imported bodies are not inlined at the call site.

## Do Next

1. **Finish input honesty.**
   Top-level `given` now only names input roots, and loop-level `given` rejects `result`, loop-built arrays, and mutable cursors. Next:
   - decide how much expression shape to allow inside those roots
   - catch more contradictory input promises before they make later checks look proven

2. **Make helper/import report lines clearer.**
   Comparison reports now say `trusted from function @fit`, `trusted from loop @fit`, `read from code`, or `source-proved imported contract`. Next report work is keeping helper/import failures easy to scan without adding new public syntax: unsupported imports, missing contracts, and any future trusted summaries.

3. **Design two-collection wildcard semantics before implementing them.**
   Keep the current one-wildcard-vs-scalar rule. `rows[].height <= maxHeight` is anonymous `for every row`. Never let `rows[].top <= boxes[].bottom` guess its meaning.
   - repeated labels could mean same index, e.g. `rows[i]` with `boxes[i]`
   - different labels could mean all pairs, e.g. `children[i]` with `blockers[j]`
   - source/id matching probably wants a SQL-ish join relation, not bracket labels alone

4. **Turn thin scalar sums into better internal measures.**
   Simple non-negative `total += row.height` already gives ranges. Next useful shapes are still source inference, not public folds:
   - conditional totals/counts
   - min/max accumulation
   - totals that feed later comparisons and reports cleanly

5. **Use real demos as pressure tests.**
   The checker is ready for small demos that stay inside the current surface: helper contracts across files, row stacks, maps/indexed rows/conditional rows, one-sided wildcard bounds, and scalar totals. Do not add an atom just because a demo would look nicer with one.

6. **Delay views until field-name pressure earns them.**
   Views are likely the right long-term answer, but do not add them just to make the first row loop nicer. Add the first view only when field names become real pressure across rows/columns/text/rects:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

   A view is only a field mapping. It must not assert layout facts.

7. **Add Pretext facts through generic range/lineage facts first.**
   Try these before text-specific atoms:
   - `fragments[].width <= offeredWidth`
   - `nondecreasing(fragments.textStart)`
   - `partitions(fragments, textRange)`
   - `sourceOrder(lines, fragments)`
   - `sameSource(selectionRects, paintFragments)`

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
- Early geometry atoms. Field math already works; keep writing `child.x + child.w <= parent.x + parent.w` until repeated demos earn a name like `inside`.
- Exhaustive integer sweeps. Keep them out unless a finite-domain static proof explicitly earns its complexity.

## Current Limitations

- Import support is deliberately tiny: named imports can use TypeScript resolution to local source, including relative paths, `tsconfig` path aliases, and explicit named re-exports. Packages, declaration-only imports, namespace/default imports, wildcard barrels, summary files, and stale-summary policy are still out.
- No public views yet.
- Impossible `given` checks are still small: empty ranges and direct contradictions against earlier ranges are caught, not every possible inconsistent set.
- `given` root checks are intentionally strict; loop-level `given` cannot describe local aliases yet.
- Loop-level `@fit` only attaches to supported append-only loops.
- Loop-local `given` facts that pass the input-root check are trusted from that point forward, not proved against earlier state.
- Wildcard comparisons support one collection side and one scalar side only.
- Mutation handling only forgets facts; it does not infer precise facts after mutation.
- Scalar accumulation support is thin: non-negative `+=` running sums work, but no `reduce`, conditional counts/totals, min/max accumulation, or public aggregate syntax yet.
- No general loops, nonlinear solver, TS type narrowing, overloads, generics, classes, async, closures, strings, booleans, or unions.
