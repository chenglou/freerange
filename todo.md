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
- Named relative imports can call exported function declarations with `@fit` contracts. Cross-file calls use the contract as a summary; imported bodies are not inlined at the call site.

## Do Next

1. **Tighten `given` beyond root names.**
   Top-level `given` now only names input roots, and loop-level `given` rejects `result`, loop-built arrays, and mutable cursors. The next step is deciding how much expression shape to allow inside those roots.

2. **Make helper report lines clearer.**
   Comparison reports now say `trusted from function @fit`, `trusted from loop @fit`, or `read from code`. Helper calls still mostly appear as separate checks; make that output easier to scan without adding new public syntax.

3. **Improve wildcard comparisons carefully.**
   Keep the current one-wildcard-vs-scalar rule. Next useful steps:
   - same-item comparisons only if the syntax makes same-item semantics explicit
   - zip/cross comparisons only if the syntax makes zip/cross semantics explicit
   Do not silently guess what two wildcard sides mean.

4. **Broaden source inference before adding atoms.**
   `items.map(...)`, indexed loops, and conditional push now have small summaries. Next useful source shape:
   - boring reducers like `total += row.height` become internal measures

5. **Delay views until field-name pressure earns them.**
   Views are likely the right long-term answer, but do not add them just to make the first row loop nicer. Add the first view only when field names become real pressure across rows/columns/text/rects:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

   A view is only a field mapping. It must not assert layout facts.

6. **Prefer plain geometry first.**
   Start with field comparisons:

```ts
child.x >= parent.x
child.x + child.w <= parent.x + parent.w
```

   Add `inside(child, parent)` only when repeated reports prove the name earns itself. If it lands, decide whether it includes non-negative width/height; probably yes.

7. **Add Pretext facts through generic range/lineage facts first.**
   Try these before text-specific atoms:
   - `fragments[].width <= offeredWidth`
   - `nondecreasing(fragments.textStart)`
   - `partitions(fragments, textRange)`
   - `sourceOrder(lines, fragments)`
   - `sameSource(selectionRects, paintFragments)`

8. **Grow imports one boring step at a time.**
   Named imports now go through TypeScript resolution when they point at local source, and explicit named re-export barrels are followed. Next useful steps are better imported-contract report provenance and a sharper project/workspace story. Do not add package imports, declaration-only imports, wildcard barrels, or summary-file trust before reports can say exactly what was source-proved.

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

- Import support is deliberately tiny: named imports can use TypeScript resolution to local source, including relative paths, `tsconfig` path aliases, and explicit named re-exports. Packages, declaration-only imports, namespace/default imports, wildcard barrels, summary files, and stale-summary policy are still out.
- No public views yet.
- Impossible `given` checks are still small: empty ranges and direct contradictions against earlier ranges are caught, not every possible inconsistent set.
- `given` root checks are intentionally strict; loop-level `given` cannot describe local aliases yet.
- Loop-level `@fit` only attaches to supported append-only loops.
- Loop-local `given` facts that pass the input-root check are trusted from that point forward, not proved against earlier state.
- Wildcard comparisons support one collection side and one scalar side only.
- Mutation handling only forgets facts; it does not infer precise facts after mutation.
- No reducer summaries yet.
- No general loops, nonlinear solver, TS type narrowing, overloads, generics, classes, async, closures, strings, booleans, or unions.
