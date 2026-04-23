# Freerange Todo

This is the fresh-agent handoff.

The project is a static checker for ordinary TS layout code plus strict `@fit` comments. Keep the public DSL small: ranges, comparisons, field paths, and named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, aliases, prose-as-truth, browser runs, runtime traces, sampled sweeps, or screenshots.

Prefer source inference, intervals, small reducers, array/object domains, and helper contracts before adding atoms. Every new proof shape gets one positive pattern and at least one negative expected message.

## Current Surface

- Function specs use `@fit`. `given` lines and param `// @fit` comments are trusted input facts; bare lines and `result` lines are facts to prove.
- Loop specs also use `@fit` on supported `for...of` and indexed `for` loops. Placement decides scope. Loop checks name locals directly; they do not have `result`.
- Inline local and field checks use `@fit 0..foo` immediately before a single variable declaration, as a trailing `//` side comment, or on a simple object field. They are checks on that local value or field, not trusted givens. On simple identifier params, the same syntax is shorthand for a trusted `given`. Leading line/block comments and trailing `//` comments are supported; trailing block comments are intentionally not part of the current surface.
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
- Array lengths default to non-negative integers, and TypeScript-backed array/object shapes are used even when no `given` line names the path yet. This includes imported type aliases/interfaces, utility types like `Pick`, and generic call returns when TypeScript can see them.
- `items.at(-1)` works for non-empty arrays. It intentionally does not support `.at(-2)`, dynamic `.at(index)`, or same-loop "append then read previous last" recurrences yet. The bracket spelling `items[items.length - 1]` is also kept out of that same-loop recurrence shape so we do not accidentally prove the initial array snapshot.
- Strict integer branch facts can move by one step, so `focused > 0` proves `focused - 1 >= 0` for previous-index checks.
- Branch-local inline checks use ordinary TypeScript control flow. `if`/`else` and ternaries carry their condition into return and object-field checks; helper contracts are still unconditional after branches join.
- Non-number `==` is intentionally tiny: it only proves the exact same object or array source expression, like `result.rows == input.rows`.
- Object spread and `as` / `satisfies` wrappers preserve the underlying object facts.
- Simple `for...of` scalar running sums like `total += item.height` and `if (...) total += item.height` produce numeric ranges when the increment is known.
- Simple `for...of` and indexed-loop scalar extrema like `maxWidth = Math.max(maxWidth, item.width)` and `minWidth = Math.min(minWidth, item.width)` produce numeric ranges.
- Simple indexed `for` append loops can bind `const item = items[i]!`, advance numeric cursors with `+=`, and preserve guarded push length facts.
- `items.map(...)` preserves length, item field domains, and optional callback index facts for expression callbacks and tiny block callbacks with local `const` bindings plus `return`.
- `items.filter(...)` preserves item domains and proves only the subsequence length fact: `filtered.length <= items.length`.
- Unsupported indexed-style `for` loops can preserve unrelated facts only when their headers and bodies are read-only except for roots the checker forgets. Mutated roots become unknown.
- Named local imports can call exported function declarations with `@fit` contracts and can read exported numeric constants when TypeScript resolves them to local source. Cross-file calls use the contract as a summary; imported bodies are not inlined at the call site.
- `bun run infer path --function name` is a dev-only x-ray of result/local facts and supported loop-local facts. It separates function and loop specs into trusted, source-proved, not-inferred, and redundant lines, and redundant lines name the covering inferred fact. A curated slice is snapshotted in `infer-snapshots.expected.txt`; this is not a public annotation writer.
- `bun run audit:demos` summarizes which checked demo annotations are redundant versus source-proved keepers.
- `bun run shape-diff path --function name` is the dev-only TS piggyback x-ray. It compares Freerange-owned structural facts with TypeScript-only object/array shape for params, locals, return shapes, and call returns.

## Do Next

There are two tracks now: normal proof/report/demo work, and the TypeScript shape piggyback result. The experiment is useful enough to keep, but it should stay a shape oracle. It must not quietly replace the rest of the roadmap.

## Normal Proof Track

This was the next path before the TypeScript piggyback idea came up. Keep it visible so the shape work does not erase the boring proof/report/demo work that was already worth doing.

1. **Keep tightening input honesty.**
   `given` now only names input roots. Range facts must name one input path; comparison facts allow input paths, numbers, and simple arithmetic. Empty ranges, direct range contradictions, simple opposing comparisons like `given width >= 100` plus `given width <= 50`, and small chained contradictions like `left >= middle`, `middle >= right`, `right > left` are rejected before later checks can lean on them. Next useful step: keep widening that contradiction check only where reports stay obvious.

2. **Keep helper/import report lines boring and precise.**
   Comparison reports now say `trusted from function @fit`, `trusted from loop @fit`, `read from code`, `branch fact from code`, `source-proved helper contract`, or `source-proved imported contract`. Small comparison proof rules point at their missing obligation when possible: `scale >= 0` instead of repeating `content * scale <= available * scale`, `pointer < count * cellSize` instead of repeating `floor(pointer / cellSize) < count`, and `count > 0` for ceil-division coverage. Next report work is likely narrower missing-fact text for unsupported loop/indexed-product shapes in real demos.

3. **Turn scalar accumulators into better internal measures.**
   Non-negative `total += row.height`, guarded `if (...) total += row.height`, and simple min/max assignment loops give ranges. Unit guarded counts also know `count <= items.length`. Next useful shapes are still source inference, not public folds: totals and extrema that feed later comparisons and reports cleanly.

4. **Use real demos as pressure tests.**
   The checker is ready for small demos that stay inside the current surface: helper contracts across files, row stacks, maps/indexed rows/conditional rows, one-sided wildcard bounds, and scalar totals. Use `bun run infer` to see what the checker actually knows before adding a proof feature; its function and loop spec sections are useful for deciding which `@fit` lines are documentation versus real missing input facts. Do not add an atom just because a demo would look nicer with one.
   Current demo read: Pretext `layoutTemplateFrame` has good inferred length/measure facts now. Vibescript photo-gallery now has source-owned contracts on the real grid sizing, prompt visible sizing, line max sizes, line target math, stable edge hit areas, and item geometry. `getGridLayout` now carries explicit input domains, and the checker recognizes its guarded indexed row-boundary pushes well enough to prove `rowsTop` is non-empty. The remaining photo-gallery gaps are larger loop/product facts: prompt-layout summaries across the unsupported text loop, the same-loop previous-row recurrence, and the row-count relation behind `currentRow = Math.floor(i / cols)`.
   Photo-gallery spec-driven trial: two fresh workers rebuilt scratch galleries from docs plus a private formal packet and both landed the same 18 passing helper checks. The real demo now proves 56 checks across `layout.ts` and `prompt-layout.ts`, with scalar input domains mostly moved onto params and the line-size math back in one helper, so the next trial should feed workers more of the ground-truth source facts and tighten the prose packet around line sizing, neighbor visibility, edge-strip no-ops, overscan, bottom scroll runway, and optional animation handoff samples before asking for more Freerange power.
   Current infer sweep across checked demos: 92 explicit function checks are source-proved, 106 input facts are trusted, 0 are not-inferred, 51 are redundant because emitted inferred result facts already cover them, and 41 remain source-proved keepers. That is a cue to simplify comments, not to auto-delete public contracts.

5. **Postpone conditional helper contracts until callers need them.**
   Branch-local inline facts cover local proof. Do not add `when` or another public syntax yet. The future version would be an exported summary like: if the caller knows `focused > 0`, then `result.leftHitArea` is non-null and `result.leftHitArea.targetIndex == focused - 1`. That is conditional postcondition territory, not just nicer comment placement.

6. **Design two-collection wildcard semantics before implementing them.**
   Keep the current one-wildcard-vs-scalar rule. `rows[].height <= maxHeight` is anonymous `for every row`. Never let `rows[].top <= boxes[].bottom` guess its meaning.
   - repeated labels could mean same index, e.g. `rows[i]` with `boxes[i]`
   - different labels could mean all pairs, e.g. `children[i]` with `blockers[j]`
   - source/id matching probably wants a SQL-ish join relation, not bracket labels alone

7. **Delay views until field-name pressure earns them.**
   Views are likely the right long-term answer, but do not add them just to make the first row loop nicer. Add the first view only when field names become real pressure across rows/columns/text/rects:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

   A view is only a field mapping. It must not assert layout facts.

8. **Add Pretext facts through generic range/lineage facts first.**
   Try these before text-specific atoms:
   - `fragments[].width <= offeredWidth`
   - `nondecreasing(fragments.textStart)`
   - `partitions(fragments, textRange)`
   - `sourceOrder(lines, fragments)`
   - `sameSource(selectionRects, paintFragments)`

## TS Shape Piggyback Result

The spike paid for itself. We now have a small shape-provider boundary in `src/shapes.ts`, plus `bun run shape-diff` to inspect where TypeScript knows structure Freerange did not know.

What it improved:

- imported interfaces and type aliases now give structure
- `Pick`-style utility types give structure
- generic helper returns like `Box<T>` give structure at the call site
- unannotated helper return shapes can make object paths meaningful without pretending to prove ranges
- property-access calls, namespace-imported structural calls, and local bindings can use TypeScript object/array shape without becoming helper contracts
- scalar array pushes in supported loops now keep element shape/range, which closes the `stackLayout`-style `number[]` gap
- photo-gallery snapshots now keep a curated slice of prompt-layout and item-measurement structure

What it deliberately does not do:

- no numeric ranges from TypeScript types
- no linear facts, sequence facts, or proof obligations from TypeScript
- no imported function body inlining
- no trusting declaration files as source-proved helper contracts
- no optional/nullable property optimism
- no unbounded TypeScript walk through giant parser/library types

`shape-diff` was useful on the real pressure points:

- photo-gallery `getGridLayout` / `getLineLayout`: TypeScript exposes prompt-layout, measurement, item geometry, and hit-area structure even when Freerange has not proven numeric bounds.
- Pretext `layoutTemplateFrame`: TypeScript exposes `layoutBlockFrame` return structure, including `height`, `top`, `contentLeft`, and `quoteRailLefts`.
- broad `--all` sweeps stay fast because `src/shapes.ts` has depth/width limits and the tool compares against evaluated Freerange shape only where that is meaningful.

Keep watching the failure line. This turns bad if `src/shapes.ts` becomes a second TypeScript checker, if reports start treating shape as proof, or if normal checks get slow enough that the small shape win is not worth it.

## After The Shape Work

Before adding the next proof feature:

1. Keep the TS shape provider frozen around structural facts unless a real demo blocks on shape.
2. Re-run the normal proof track above and mark which items are still real.
3. Re-check whether photo-gallery and Pretext blockers are proof gaps, shape gaps, report gaps, or public-language gaps.

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

No aggregate callbacks, inline arithmetic, or folds. Source-level `.filter(...)`
is separate: it is only a subsequence summary, not a public aggregate language.

Callback contracts stay out until real demo pressure says otherwise. Users can
annotate concrete wrapper functions or claimed callback results; Freerange should
not grow a public function-type spec language just because higher-order calls
exist in TypeScript.

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
- TS shape reading now uses TypeScript as a structural oracle. It handles arrays, readonly arrays, object type literals, local and imported interfaces/type aliases, simple utility types, generic return instantiations, property-access call shape, namespace-imported structural call shape, unions, and intersections. Optional and nullable properties are still conservative unknowns, and huge types are bounded out.
- Wildcard comparisons support one collection side and one scalar side only.
- Mutation handling only forgets facts; it does not infer precise facts after mutation.
- Scalar accumulation support is thin: `+=` running sums, guarded `+=`, and simple min/max assignment loops work, but no `reduce`, spread aggregates, or public aggregate syntax yet.
- No general loops, nonlinear solver, TS type narrowing, overload semantics, general generic value reasoning, classes, async, closures, strings, booleans, or branded-value reasoning.
