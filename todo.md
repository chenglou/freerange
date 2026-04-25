# Freerange Todo

This is the fresh-agent handoff.

The project is a static checker for ordinary TS layout code plus strict `@fit` comments. Keep the public DSL small: ranges, comparisons, field paths, and named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, aliases, prose-as-truth, browser runs, runtime traces, sampled sweeps, or screenshots.

Prefer source inference, intervals, small reducers, array/object domains, and helper contracts before adding atoms. Every new proof shape gets one positive pattern and at least one negative expected message.

The current product pivot is adoption, not a bigger DSL: make `infer`, `audit`, and reports the normal loop. A human or agent should ask what source already proves, keep only the red-line comments worth reading, and get a clear reason when proof stops.

## Current Surface

- Function specs use `@fit`. `given` lines and param `// @fit` comments are trusted input facts; bare lines and `return` lines are facts to prove.
- Function boundaries include named `function` declarations, named `const` arrow/function expressions, anonymous default-exported function/arrow boundaries, and class methods/getters. Instance class members can use `this` as an input root, and same-file property/method calls can use the checked class-member summary.
- Typed object and array destructuring params are supported as input bindings. Param inline `@fit` shorthand still only attaches to simple identifier params.
- Loop specs also use `@fit` on supported `for...of` and indexed `for` loops. Placement decides scope. Loop checks name locals directly; they do not have `return`.
- Inline local and field checks use `@fit 0..foo` immediately before a single variable declaration, as a trailing `//` side comment, or on a simple object field. They are checks on that local value or field, not trusted givens. On simple identifier params, the same syntax is shorthand for a trusted `given`. Leading line/block comments and trailing `//` comments are supported; trailing block comments are intentionally not part of the current surface.
- Supported sequence names are `nondecreasing(rows.top)`, `spaced(rows, gap)`, and `lastEnd(rows)`.
- `extentEnd(rows, top)` handles the empty-row case for append-only row loops.
- Anonymous wildcard comparisons support one collection at a time. The same collection may appear on both sides, and the collection side may be nested:

```ts
rows[].top + rows[].height <= parent.bottom
fragments[].width <= offeredWidth
sections[].rows[].height <= maxHeight
```

- Same-index labels are supported in comparisons when matching collection lengths can be proven, e.g. `rows[$i].height == items[$i].height`. Adjacent labels over one collection can consume inferred sequence relations, e.g. `rows[$i].top <= rows[$i + 1].top` from `nondecreasing(rows.top)` and `rows[$i + 1].top >= rows[$i].bottom + gap` from a row-spacing loop.
- Anonymous two-collection wildcard sides like `rows[].top <= boxes[].bottom` are intentionally unsupported; use labels only when same index is the intended relation.
- Array mutation is conservative: `reverse` and `sort` forget sequence facts, while `splice` and indexed assignment forget length/item facts.
- Array lengths default to non-negative integers, and TypeScript-backed array/object/tuple shapes are used even when no `given` line names the path yet. This includes imported type aliases/interfaces, utility types like `Pick`, required fixed tuple slots, and generic call returns when TypeScript can see them.
- Local array binding patterns are supported for finite arrays/tuples, including skipped slots. This lets tuple-returning geometry helpers keep ordinary destructuring like `const [, , offsetX] = getEdgeCenter(...)`.
- Tuple element facts also survive helper/import summaries: a source-proved `return[2] >= 0` can feed a caller's destructured `offsetX`.
- `items.at(-k)` works for constant negative integer `k` when the array is long enough. Dynamic `.at(index)` and same-loop "append then read previous last" recurrences are intentionally out. The bracket spelling `items[items.length - 1]` is also kept out of that same-loop recurrence shape so we do not accidentally prove the initial array snapshot.
- Strict integer branch facts can move by one step, so `focused > 0` proves `focused - 1 >= 0` for previous-index checks.
- Branch-local inline checks use ordinary TypeScript control flow. `if`/`else` and ternaries carry their condition into return and object-field checks; exact-operand ternaries like `a < b ? a : b` also behave like small min/max facts. Simple fall-through branches join local assignments afterward. Helper contracts are still unconditional after branches join.
- Assignment handling is conservative but no longer aborts unrelated proofs: local `x = expr` keeps `expr`, while property/index assignment and unsupported scalar `+=` forget the changed root. Unsupported `while` / `do while` loops can also be skipped this way when their conditions and bodies only have clear forgettable mutations.
- Non-number `==` is intentionally tiny: it only proves the exact same object or array source expression, like `return.rows == input.rows`.
- Object spread and `as` / `satisfies` wrappers preserve the underlying object facts.
- Simple `for...of` and indexed-loop scalar running sums like `total += item.height`, `total = total + item.height`, and `if (...) total += item.height` produce numeric ranges when the added expression is known and does not read the accumulator.
- Simple `for...of` and indexed-loop scalar extrema like `maxWidth = Math.max(maxWidth, item.width)` and `minWidth = Math.min(minWidth, item.width)` produce numeric ranges.
- Simple indexed `for` append loops can bind `const item = items[i]!`, carry the actual pushed loop-index field, advance numeric cursors with `+=`, preserve guarded push length facts even when the guarded block updates a cursor, and prove guarded segmented row-boundary facts such as `rows[].bottom == rows[].top + rows[].height`, `nondecreasing(rows.top)`, `spaced(rows, gap)`, and exact adjacent row relations.
- Numeric-limit indexed loops like `for (let i = 0; i < limit; i++) values.push(i)` preserve `values.length == limit` and `values[]: int 0..<limit`.
- `Math.sign` is in the numeric subset now; this came from `d3-scale`'s signed square/sqrt radial helpers.
- Loop proof meaning is split on purpose: `src/loop-source.ts` reads narrow TypeScript loop shapes, then `src/loop-summary.ts` turns the resulting pushes, scalar updates, guards, extrema, and cursor recurrences into reusable facts instead of stamping every sequence fact directly in `check.ts`.
- `items.map(...)` preserves length, item field domains, and optional callback index facts for expression callbacks and tiny block callbacks with local `const` bindings, side-effect-free return branches, and `return`.
- `items.filter(...)` preserves item domains and proves only the subsequence length fact: `filtered.length <= items.length`.
- Unsupported indexed-style `for`, `while`, and `do while` loops can preserve unrelated facts only when their headers/conditions and bodies are read-only except for roots the checker forgets. Mutated roots become unknown.
- Named, default, and namespace-qualified local imports can call exported functions with `@fit` contracts when TypeScript resolves them to local source. Named imports can also read exported numeric constants. Cross-file calls use the contract as a summary; imported bodies are not inlined at the call site.
- Proven helper summaries can narrow stored locals silently when the call preconditions prove. The checker emits call-precondition report lines only when a surrounding claim or `doctor` asked for them; otherwise missing preconditions simply prevent the summary from being trusted.
- `fr infer path --function name` is the x-ray of return/local facts and supported loop-local facts. It separates function and loop specs into trusted, source-proved, not-inferred, and redundant lines, and redundant lines name the covering inferred fact. A curated slice is snapshotted in `infer-snapshots.expected.txt`; this is not an annotation writer.
- Reports propagate unknown identifiers through element/binary expressions and render fixed tuple lengths as `return.length == 5` instead of internal length-building noise.
- `bun run audit:demos` summarizes which checked demo annotations are likely-removable redundant noise, public-looking redundant contracts, and source-proved keepers.
- `bun run shape-diff path --function name` is the dev-only TS piggyback x-ray. It compares Freerange-owned structural facts with TypeScript-only object/array shape for params, locals, return shapes, and call returns.

## Do Next

There are three active tracks now:

1. **Make infer/audit/report the adoption loop.**
   `infer` should be the factual inventory agents use before writing comments. `check` is the hard claim gate; `check --calls` adds the helper-call scan; `doctor` is that call scan by itself for adoption. `audit` should point at redundant demo noise without auto-deleting public contracts. Reports should bucket failures into missing input fact, unsupported source shape, helper boundary, or real proof gap.

2. **Move checker knowledge toward a typed fact layer.**
   Keep public comments small. Internally, source readers now emit reusable range/equality/sequence facts, and contracts query those facts. `spaced`, same-index checks, adjacent row checks, and future view-ish concepts should avoid becoming one recognizer per demo.

3. **Keep TypeScript shape piggybacking bounded.**
   The experiment paid for itself, but it is still a shape oracle. It must not quietly become numeric proof logic.

4. **Revisit open-ended range spelling later.**
   `int > 0` reads too much like a type operator, so keep today’s explicit `int 1..Infinity` spelling. A future shorthand like `int 1..` or `0..` may be worth it once inline annotations become common enough that `Infinity` is visual noise. Do not add it until the parser story is boring.

## Normal Proof Track

Keep this visible so shape work and IR cleanup do not erase the boring proof/report/demo work that was already worth doing.

1. **Keep tightening input honesty.**
   `given` now only names input roots. Range facts must name one input path; comparison facts allow input paths, numbers, and simple arithmetic. Empty ranges, direct range contradictions, simple opposing comparisons like `given width >= 100` plus `given width <= 50`, and small chained contradictions like `left >= middle`, `middle >= right`, `right > left` are rejected before later checks can lean on them. Next useful step: keep widening that contradiction check only where reports stay obvious.

2. **Keep helper/import report lines boring and precise.**
   Comparison reports now say `trusted from function @fit`, `trusted from loop @fit`, `read from code`, `branch fact from code`, `source-proved helper contract`, or `source-proved imported contract`. Small comparison proof rules point at their missing obligation when possible: `scale >= 0` instead of repeating `content * scale <= available * scale`, `pointer < count * cellSize` instead of repeating `floor(pointer / cellSize) < count`, `py < countY * blockSize` for flattened grid hit indices, and `count > 0` for ceil-division coverage. Next report work is likely narrower missing-fact text for unsupported loop/indexed-product shapes in real demos.

3. **Turn scalar accumulators into better internal measures.**
   Non-negative `total += row.height`, `total = total + row.height`, guarded `if (...) total += row.height`, and simple min/max assignment loops give ranges. Unit guarded counts also know `count <= items.length`. Next useful shapes are still source inference, not public folds: totals and extrema that feed later comparisons and reports cleanly.

4. **Use real demos as pressure tests, then prune.**
   The checker is ready for small demos that stay inside the current surface: helper contracts across files, row stacks, maps/indexed rows/conditional rows, one-collection wildcard bounds, and scalar totals. Use `fr infer` to see what the checker actually knows before adding a proof feature; its function and loop spec sections are useful for deciding which `@fit` lines are documentation versus real missing input facts. Do not add an atom just because a demo would look nicer with one.
   Current demo read: Pretext `layoutTemplateFrame` has good inferred length/measure facts now. Vibescript photo-gallery now has statically known contracts on the real grid sizing, prompt visible sizing, line max sizes, line target math, stable edge hit areas, item geometry, and guarded row metadata spacing. `getGridLayout` now carries explicit input domains and returns full row metadata instead of parallel `rowsTop` / `rowHeights` arrays. The remaining photo-gallery gaps are larger loop/product facts: prompt-layout summaries across the unsupported text loop and the row-count relation behind `currentRow = Math.floor(i / cols)`.
   Photo-gallery spec-driven trial: two fresh workers rebuilt scratch galleries from docs plus a private formal packet and both landed the same 18 passing helper checks. The real demo now proves 71 checks across `layout.ts` and `prompt-layout.ts`, with scalar input domains mostly moved onto params, line-size math back in one helper, and row metadata spacing checked on the grid loop, so the next trial should feed workers more of the ground-truth source facts and tighten the prose packet around line sizing, neighbor visibility, edge-strip no-ops, overscan, bottom scroll runway, and optional animation handoff samples before asking for more Freerange power.
   Current infer sweep across checked demos after the first small pruning pass: 56 explicit checks are source-proved, 98 input facts are trusted, 0 are not-inferred, 34 are redundant because emitted inferred facts already cover them, and 22 remain source-proved keepers. The audit now splits redundant lines into likely-removable noise and public-looking contracts so pruning stays conservative.

   Corpus loop has started in `/Users/chenglou/github/freerange-corpus`. The first pressure set was `tldraw`, `dagre`, `xyflow`, `d3-scale`, and `masonry`; the second read-only sweep added `floating-ui`, `dnd-kit`, `react-grid-layout`, `d3-dag`, `Chart.js`, and `fabric.js`. `xyflow` found named `const` arrow helpers, destructured params, silent helper summaries, interval multiplication over unbounded non-negative values, tuple geometry returns, tuple-slot helper summaries, fall-through branch joins, and conservative scalar/object assignment forgetting. `d3-scale` added `Math.sign` pressure. `dagre` added numeric-limit range-loop pressure. `tldraw` confirmed small precision helpers fit the current surface. New read-only lessons: class methods/getters with `this` are the natural home for geometry specs in `dnd-kit` and `fabric.js`, and the first local source-checking support has landed; Interact uses tiny anonymous default-exported helpers for geometry; axis-parametric property access is the big `floating-ui` shape; `react-grid-layout` mostly wants current arithmetic plus better tuple/indexed-param ergonomics; `Chart.js` and `d3-dag` quickly move into sorted-window loops, browser-owned measurement, and graph mutation.

5. **Add more realistic red mistakes.**
   Keep adding small negative kernels for mistakes agents actually make: wrong gap, off-by-one target index, missing row bottom, inverted clamp bounds, unbounded prompt height, stale row spacing after a loop refactor. The report wording is part of the feature.

6. **Postpone conditional helper contracts until callers need them.**
   Branch-local inline facts cover local proof. Do not add `when` or another public syntax yet. The future version would be an exported summary like: if the caller knows `focused > 0`, then `return.leftHitArea` is non-null and `return.leftHitArea.targetIndex == focused - 1`. That is conditional postcondition territory, not just nicer comment placement.

7. **Keep bound-index labels narrow.**
   Keep the current anonymous one-collection rule. `rows[].height <= maxHeight` is anonymous `for every row`, and `rows[].bottom == rows[].top + rows[].height` means every row satisfies that same-item relation. Never let `rows[].top <= boxes[].bottom` guess its meaning. Use labels only when the relationship is really same-index or a supported adjacent relation.
   - repeated labels mean same index, e.g. `rows[$i]` with `boxes[$i]`, and require proven matching lengths
   - adjacent labels work only over one collection and only when a sequence relation was inferred, e.g. `rows[$i].top <= rows[$i + 1].top` or `rows[$i + 1].top >= rows[$i].bottom + gap`
   - different labels could mean all pairs, e.g. `children[$i]` with `blockers[$j]`
   - source/id matching probably wants a SQL-ish join relation, not bracket labels alone
   - punt on numeric ghost symbols like `0..$n`. Index labels are bound variables (`items[$i]` means every valid item index), while numeric symbols would be existential/universal/generic parameters. Those are related ideas, but they bind differently, so do not reuse the syntax without a mini spec.

8. **Delay views until field-name pressure earns them.**
   Views are likely the right long-term answer, but do not add them just to make the first row loop nicer. Add the first view only when field names become real pressure across rows/columns/text/rects:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

   A view is only a field mapping. It must not assert layout facts.

9. **Add Pretext facts through generic range/lineage facts first.**
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

- Import support is deliberately tiny: named/default/namespace-qualified helper imports can use TypeScript resolution to local source, including relative paths, `tsconfig` path aliases, exported numeric constants for named imports, and explicit named re-exports. Packages, declaration-only imports, wildcard barrels, summary files, and stale-summary policy are still out.
- Import failure reports distinguish unavailable contracts, unsupported import shapes, and imported contracts that failed in source.
- No public views yet.
- Impossible `given` checks are still small: empty ranges, direct contradictions against earlier ranges, simple opposing linear comparison bounds, and short chained linear contradictions are caught, not every possible inconsistent set.
- `given` root checks are intentionally strict; loop-level `given` cannot describe local aliases yet.
- Loop-level `@fit` only attaches to supported `for...of` and indexed `for` loops.
- Loop-local `given` facts that pass the input-root check are trusted from that point forward, not proved against earlier state.
- TS shape reading now uses TypeScript as a structural oracle. It handles arrays, readonly arrays, required fixed tuple slots, safe optional/rest tuple length ranges, object type literals, local and imported interfaces/type aliases, simple utility types, generic return instantiations, property-access call shape, namespace-imported structural call shape, unions, and intersections. Optional/rest tuple slots, optional and nullable properties, and huge types are still conservative unknowns.
- Anonymous wildcard comparisons support one collection at a time. The same collection may appear on both sides. Labeled same-index comparisons can relate two collections when their lengths are proven equal. Adjacent formulas work only over one collection and only when a sequence relation was inferred; all-pairs and source/id matching are still unsupported.
- Mutation handling only forgets facts; it does not infer precise facts after mutation.
- Scalar accumulation support is thin: target-free `+=` and `total = total + delta` running sums, guarded `+=`, and simple min/max assignment loops work, but no `reduce`, spread aggregates, or public aggregate syntax yet.
- No general loops, nonlinear solver, TS type narrowing, overload semantics, general generic value reasoning, imported class-member summaries, async, closures, strings, booleans, or branded-value reasoning.
