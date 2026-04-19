# Freerange Todo

This is the fresh-agent handoff.

The project is a static checker for ordinary TS layout code plus strict `@fit` comments. Keep the public DSL small: ranges, comparisons, field paths, and named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, aliases, prose-as-truth, browser runs, runtime traces, sampled sweeps, or screenshots.

Prefer source inference, intervals, small reducers, array/object domains, and helper contracts before adding atoms. Every new proof shape gets one positive pattern and at least one negative expected message.

## Current Surface

- Function specs use `@fit`. `given` lines are trusted input facts; bare lines are facts to prove.
- Loop specs also use `@fit` on supported `for...of` and indexed `for` loops. Placement decides scope. Loop checks name locals directly; they do not have `result`.
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
- Array lengths default to non-negative integers, and obvious local TS array/object shapes are used even when no `given` line names the path yet.
- Object spread and `as` / `satisfies` wrappers preserve the underlying object facts.
- Simple `for...of` scalar running sums like `total += item.height` and `if (...) total += item.height` produce numeric ranges when the increment is known.
- Simple `for...of` and indexed-loop scalar extrema like `maxWidth = Math.max(maxWidth, item.width)` and `minWidth = Math.min(minWidth, item.width)` produce numeric ranges.
- Simple indexed `for` append loops can bind `const item = items[i]!` and advance numeric cursors with `+=`.
- `items.map(...)` preserves length, item field domains, and optional callback index facts for expression callbacks and tiny block callbacks with local `const` bindings plus `return`.
- Unsupported indexed-style `for` loops can preserve unrelated facts only when their headers and bodies are read-only except for roots the checker forgets. Mutated roots become unknown.
- Named local imports can call exported function declarations with `@fit` contracts and can read exported numeric constants when TypeScript resolves them to local source. Cross-file calls use the contract as a summary; imported bodies are not inlined at the call site.
- `bun run infer path --function name` is a dev-only x-ray of result/local facts and supported loop-local facts. It separates loop specs into trusted, source-proved, and not-inferred lines. A curated slice is snapshotted in `infer-snapshots.expected.txt`; this is not a public annotation writer.

## Do Next

There are two tracks now: the normal proof/report/demo work we were about to do anyway, and the TypeScript shape piggyback experiment. The experiment should help us classify blockers. It should not quietly replace the rest of the roadmap.

## If We Do Not Do The TS Shape Experiment

This was the next path before the TypeScript piggyback idea came up. Keep it here so the experiment does not erase the boring work that was already worth doing.

1. **Keep tightening input honesty.**
   `given` now only names input roots. Range facts must name one input path; comparison facts allow input paths, numbers, and simple arithmetic. Empty ranges, direct range contradictions, simple opposing comparisons like `given width >= 100` plus `given width <= 50`, and small chained contradictions like `left >= middle`, `middle >= right`, `right > left` are rejected before later checks can lean on them. Next useful step: keep widening that contradiction check only where reports stay obvious.

2. **Keep helper/import report lines boring and precise.**
   Comparison reports now say `trusted from function @fit`, `trusted from loop @fit`, `read from code`, `branch fact from code`, `source-proved helper contract`, or `source-proved imported contract`. Small comparison proof rules point at their missing obligation when possible: `scale >= 0` instead of repeating `content * scale <= available * scale`, and `pointer < count * cellSize` instead of repeating `floor(pointer / cellSize) < count`. Next report work is likely sharper missing-fact text for rounding expressions that are not covered by a rule yet.

3. **Turn scalar accumulators into better internal measures.**
   Non-negative `total += row.height`, guarded `if (...) total += row.height`, and simple min/max assignment loops give ranges. Unit guarded counts also know `count <= items.length`. Next useful shapes are still source inference, not public folds: totals and extrema that feed later comparisons and reports cleanly.

4. **Use real demos as pressure tests.**
   The checker is ready for small demos that stay inside the current surface: helper contracts across files, row stacks, maps/indexed rows/conditional rows, one-sided wildcard bounds, and scalar totals. Use `bun run infer` to see what the checker actually knows before adding a proof feature; loop output is especially useful for deciding which local `@fit` lines are documentation versus real missing input facts. Do not add an atom just because a demo would look nicer with one.
   Current demo read: Pretext `layoutTemplateFrame` has good inferred length/measure facts now. Vibescript photo-gallery now has source-owned contracts on the real grid sizing, prompt visible sizing, line max sizes, line target math, stable edge hit areas, and item geometry. The remaining photo-gallery gaps are larger loop/product facts, not a request for a new public atom.
   Photo-gallery spec-driven trial: two fresh workers rebuilt scratch galleries from docs plus a private formal packet and both landed the same 18 passing helper checks. The real demo now proves 61 helper checks after trimming checker-shaped helper bloat, so the next trial should feed workers more of the ground-truth source facts and tighten the prose packet around line sizing, neighbor visibility, edge-strip no-ops, overscan, bottom scroll runway, and optional animation frame samples before asking for more Freerange power.

5. **Design two-collection wildcard semantics before implementing them.**
   Keep the current one-wildcard-vs-scalar rule. `rows[].height <= maxHeight` is anonymous `for every row`. Never let `rows[].top <= boxes[].bottom` guess its meaning.
   - repeated labels could mean same index, e.g. `rows[i]` with `boxes[i]`
   - different labels could mean all pairs, e.g. `children[i]` with `blockers[j]`
   - source/id matching probably wants a SQL-ish join relation, not bracket labels alone

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

## TS Shape Piggyback Experiment

Treat this as a bounded diagnostic spike, not a rewrite and not a fork.

1. **Add a shape-provider boundary.**
   The evaluator should ask one small interface for structural shape. The current syntactic reader is one backend. A TypeScript `Program` / `TypeChecker` backend is the experiment. Do not scatter `checker.getTypeAtLocation(...)` through `src/check.ts`.

2. **Use TypeScript only as a shape and symbol oracle.**
   TS may tell us that something is a number, array, object, property, imported alias, instantiated generic, or return shape. TS must not produce Freerange numeric ranges, linear facts, sequence facts, or proof obligations.

3. **Build a small fixture packet before touching demos.**
   The packet should include imported interfaces/type aliases, generic instantiation, a utility type like `Pick` or `Readonly`, an unannotated helper return object, local inferred object/array shapes, and a nullable or optional-property case that stays conservative.

4. **Add a dev-only shape diff.**
   The tool should answer: "is Freerange blind because proof logic is weak, or because shape reading lost the object?" Useful output compares Freerange shape and TS shape at function parameters, locals, indexed elements, helper returns, and imported symbols.

5. **Measure on real pressure.**
   Run the shape diff and infer snapshots on photo-gallery `getGridLayout` / `getLineLayout`, then Pretext `layoutTemplateFrame`. A good result turns "property expected an object" into structural knowledge without inventing bounds.

6. **Keep performance boring.**
   Compare `bun run check` before and after. TS program creation can cost something, but repeated per-node type queries should be cached by node/type/symbol. Around 1.5x is tolerable during the spike if coverage improves; 3x for small gains is not.

7. **Call failure clearly.**
   The experiment fails if it becomes a second TypeScript type walker, makes reports noisier, spreads TS checker calls everywhere, slows normal checks too much, or makes structural facts look like numeric proof facts.

## After The TS Shape Experiment

Do this reconciliation before adding the next proof feature:

1. Compare `infer-snapshots.expected.txt` before and after. Keep new facts only if they are stable, structural, and useful on demos.
2. Decide whether to keep, freeze, or delete parts of the local syntactic type reader.
3. Update `DOCUMENTATION.md`, `DEVELOPMENT.md`, `research.md`, and this file so they describe the actual source of shape knowledge.
4. Re-run the "If We Do Not Do The TS Shape Experiment" list above and mark which items are still real.
5. Re-check whether photo-gallery and Pretext blockers are proof gaps, shape gaps, report gaps, or public-language gaps.

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

- Import support is deliberately tiny: named imports can use TypeScript resolution to local source, including relative paths, `tsconfig` path aliases, exported numeric constants, and explicit named re-exports. Packages, declaration-only imports, namespace/default imports, wildcard barrels, summary files, and stale-summary policy are still out.
- Import failure reports distinguish unavailable contracts, unsupported import shapes, and imported contracts that failed in source.
- No public views yet.
- Impossible `given` checks are still small: empty ranges, direct contradictions against earlier ranges, simple opposing linear comparison bounds, and short chained linear contradictions are caught, not every possible inconsistent set.
- `given` root checks are intentionally strict; loop-level `given` cannot describe local aliases yet.
- Loop-level `@fit` only attaches to supported `for...of` and indexed `for` loops.
- Loop-local `given` facts that pass the input-root check are trusted from that point forward, not proved against earlier state.
- TS shape reading is syntactic and local. It handles arrays, readonly arrays, object type literals, local interfaces, local aliases, unions, and intersections; imported type declarations and optional properties are still opaque.
- Wildcard comparisons support one collection side and one scalar side only.
- Mutation handling only forgets facts; it does not infer precise facts after mutation.
- Scalar accumulation support is thin: `+=` running sums, guarded `+=`, and simple min/max assignment loops work, but no `reduce`, spread aggregates, or public aggregate syntax yet.
- No general loops, nonlinear solver, TS type narrowing, overloads, generics, classes, async, closures, strings, booleans, or branded-value reasoning.
