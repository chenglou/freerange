# Freerange Todo

This is the living work queue after the interpreter cutover.

The project is a static checker for ordinary TS layout code plus strict `@fit` comments. Keep the public DSL small: ranges, comparisons, field paths, and named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, public alias syntax, prose-as-truth, browser runs, runtime traces, sampled sweeps, or screenshots.

Prefer source inference, intervals, small scalar loop effects, array/object domains, and helper contracts before adding atoms. Every new proof shape gets one positive pattern and at least one negative expected message.

The current product pivot is adoption, not a bigger DSL: make `infer`, `audit`, and reports the normal loop. A human or agent should ask what source already proves, keep only the red-line comments worth reading, and get a clear reason when proof stops.

## Current Surface

- Function specs use `@fit`. `given` lines and param `// @fit` comments are input assumptions; bare lines and `return` lines are facts to prove.
- Function boundaries include named `function` declarations, named `const` arrow/function expressions, anonymous default-exported function/arrow boundaries, and class methods/getters. Instance class members can use `this` as an input root, and same-file property/method calls can use the checked class-member summary.
- Typed object and array destructuring params are supported as input bindings. Param inline `@fit` shorthand still only attaches to simple identifier params.
- Loop specs also use `@fit` on supported `for...of` and indexed `for` loops. Placement decides scope. Loop checks name locals directly; they do not have `return`.
- Inline local and field checks use `// @fit 0..foo` immediately before a single variable declaration, as a trailing `//` side comment, or on a simple object field. They are checks on that local value or field, not input givens. On simple identifier params, the same syntax is shorthand for an input `given`. Block `@fit` comments are only for function, loop, and type contract blocks; attached facts use line comments.
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
- Array lengths default to non-negative integers, and TypeScript-backed array/object/tuple shapes are used even when no `given` line names the path yet. This includes imported type aliases/interfaces, utility types like `Pick`, finite string-literal/boolean unions, required fixed tuple slots, fixed tuple paths in `given` lines like `extent[1][0]`, and generic call returns when TypeScript can see them. Source-backed type-field `@fit` comments also survive local imports, including type-only imports and namespace-qualified type references.
- Browser-owned layout dimensions have a tiny ambient layer backed by TypeScript's DOM declarations: viewport, element, screen, canvas/image/video, visual viewport, and `ResizeObserverSize` dimensions get non-negative ranges. This must stay narrow and type-backed; app fields named `clientWidth` get no special trust, and scroll offsets do not get non-negative facts because RTL, overscroll, and rubber-banding can move them outside ordinary bounds.
- Optional/nullable values stay conservative until ordinary TypeScript control flow narrows the expression; guarded reads like `if (input.rows == null) return 0; return input.rows.length` can use the narrowed shape, optional numeric params can be used after `typeof value !== 'undefined'`, numeric `??` fallbacks like `dimensions?.width ?? 0` feed normal math, and branch-created nullable locals or property paths keep their present-side numeric facts after `== null` / `!= null` guards. Unguarded optional paths remain unknown.
- Local array binding patterns are supported for tuple/product-shaped values, including skipped slots. This lets tuple-returning geometry helpers keep ordinary destructuring like `const [, , offsetX] = getEdgeCenter(...)`.
- Normal arrays are summarized collections. Literal slots may be kept internally so a tuple annotation can recover them, but `map`, `filter`, `for...of`, and ordinary element reads consume the element summary instead of unrolling every slot.
- Tuple/product indexing consumes exact finite index cases, so `index: 0 | 2` reads slots 0 and 2 without widening through slot 1 when the target is tuple-shaped.
- Tuple element facts also survive helper/import summaries: a checked `return[2] >= 0` can feed a caller's destructured `offsetX`.
- `items.at(-k)` works on tuple/product-shaped values for constant negative integer `k` when the length is known. Dynamic `.at(index)` and same-loop "append then read previous last" recurrences are intentionally out. The bracket spelling `items[items.length - 1]` is also kept out of that same-loop recurrence shape so we do not accidentally prove the initial array snapshot.
- Strict integer branch facts can move by one step, so `focused > 0` proves `focused - 1 >= 0` for previous-index checks. Symbolic element reads now keep concrete paths like `items[focused].top`, and local adjacent sequence facts can specialize live previous/current and current/next neighborhoods.
- Symbolic element reads must prove the index is an integer and in bounds before using an element fact. When they pass, the checker rebases wildcard facts like `items[].height` onto the concrete source path such as `items[i].height`; when they do not, the path stays unknown instead of borrowing a fact from every slot.
- Branch-local inline checks use ordinary TypeScript control flow. `if`/`else`, ternaries, and small finite-literal `switch` branches carry their condition into return and object-field checks; joined branches can keep small finite numeric cases like `0 | 100`, and real TS literal unions like `'ordered' | 'inverted'` or `boolean` narrow through discriminants such as `spec.kind`. Exact-operand ternaries like `a < b ? a : b` also behave like small min/max facts. Simple fall-through branches join local assignments afterward, `throw` guards keep the surviving branch facts, and later branch conditions refine those cases enough for ordinary assignment-style clamps. Helper contracts are still unconditional after branches join.
- Assignment handling is conservative but no longer aborts unrelated proofs: local `x = expr` keeps `expr`, while property/index assignment and unsupported scalar `+=` forget the changed root. Unsupported `while` / `do while` loops can also be skipped this way when their conditions and bodies only have clear forgettable mutations.
- Non-number `==` is intentionally tiny: it only proves the exact same object or array source expression, like `return.rows == input.rows`.
- Object spread and `as` / `satisfies` wrappers preserve the underlying object facts.
- Simple `for...of` and indexed-loop scalar running sums like `total += item.height`, `total = total + item.height`, and `if (...) total += item.height` produce numeric ranges when the added expression is known and does not read the accumulator.
- Simple `for...of` and indexed-loop scalar extrema like `maxWidth = Math.max(maxWidth, item.width)` and `minWidth = Math.min(minWidth, item.width)` produce numeric ranges.
- Simple indexed `for` append loops can bind `const item = items[i]!`, carry the actual pushed loop-index field, advance numeric cursors with `+=`, preserve guarded push length facts even when the guarded block updates a cursor, and prove guarded segmented row-boundary facts such as `rows[].bottom == rows[].top + rows[].height`, `nondecreasing(rows.top)`, `spaced(rows, gap)`, and exact adjacent row relations. Ordinary stack loops can also infer nested cursor paths like `nondecreasing(rows.rowRect.top)` and adjacent `rowRect.top` facts; pathless `spaced`, `lastEnd`, and `extentEnd` stay tied to the top-level row shape.
- Numeric-limit indexed loops like `for (let i = 0; i < limit; i++) values.push(i)` preserve `values.length == limit` and `values[]: int 0..<limit`. Array-source indexed loops like `for (let i = 0; i < items.length; i++) rows.push({sourceIndex: i})` can also use `items[i]` element facts, record one-push-per-item or guarded-subset origin for a separate target array, apply trailing scalar cursor updates such as `y += step` after guarded or unguarded pushes, and run scalar effects such as guarded counts and min/max extrema.
- `Math.sign` is in the numeric subset now; this came from `d3-scale`'s signed square/sqrt radial helpers.
- Loop proof meaning is split on purpose: `src/loop-source.ts` reads narrow TypeScript loop shapes, then `src/loop-summary.ts` turns the resulting pushes, scalar updates, guards, extrema, and cursor recurrences into reusable facts instead of stamping every sequence fact directly in `check-core.ts`.
- `items.map(...)` preserves length, item field domains, optional callback index facts, and a same-index origin fact for expression callbacks and tiny block callbacks with local `const` bindings, side-effect-free return branches, and `return`.
- `items.filter(...)` preserves item domains, records an order-preserving subset origin fact, and proves only the subsequence length fact: `filtered.length <= items.length`. Map/filter chains compose this origin back to the base source for `fr infer`.
- Unsupported indexed-style `for`, `while`, and `do while` loops can preserve unrelated facts only when their headers/conditions and bodies are read-only except for roots the checker forgets. Mutated roots become unknown.
- Named, default, and namespace-qualified local imports can call exported functions with `@fit` contracts when TypeScript resolves them to local source, or when a declaration file has a single-source map back to local source. Named imports can also read exported numeric constants. Top-level `const` helper bindings can point at supported `Math` calls, same-file helpers, or local-source imported helpers; mutable helper bindings are reported instead of followed. Cross-file calls use the contract as a summary; imported bodies are not inlined at the call site.
- Proven helper summaries can narrow stored locals silently when the call preconditions prove. Caller numeric linears now stay bottomed out through local aliases and helper parameter binding, and helper-call reports/infer facts are rebased back to those caller expressions instead of stopping at arbitrary local names. Call reports carry structured precondition detail, so the output separates the required helper fact, what the caller passed, and the caller-side missing fact. Normal `fr check` reports supported callsites to annotated helpers; `fr check --annotations-only` keeps the quieter local pass.
- `fr infer path --function name` prints return/local facts and supported loop-local facts. It separates function and loop specs into assumptions, checked, not-inferred, and redundant lines, and redundant lines name the covering inferred fact. A curated slice is snapshotted in `infer-snapshots.expected.txt`; the local photo-gallery also has a broad `--all` inventory in `photo-gallery-infer.expected.txt` so annotation work can distinguish source-known facts from real gaps. This is not an annotation writer.
- Reports propagate unknown identifiers through element/binary expressions, render fixed tuple lengths as `return.length == 5` instead of internal length-building noise, and attach source line numbers to unsupported interpreter stops when the node is known.
- `bun run audit:demos` summarizes which checked demo annotations are likely-removable redundant noise, public-looking redundant contracts, and checked keepers.
- `bun run shape-diff path --function name` is the dev-only structure comparison. It compares Freerange-owned structural facts with TypeScript-only object/array shape for params, locals, return shapes, and call returns.

## Do Next

Active tracks now:

0. **Keep the interpreter as the one source evaluator.**
   Function bodies, top-level inline checks, local inline checks, return checks, object-field checks, type-boundary checks, loop reports, and helper-call obligations now run through the interpreter. The old evaluator and differential harness are gone. The first cleanup pass split contract collection, input binding, `given` assumption seeding, helper-call summaries, domain-path value access, and shape inspection out of `src/check-core.ts`. Keep moving report wording toward the same fact inventory and keep collapsing recognizers into typed fact/value queries when the boundary is obvious.

1. **Make infer/audit/report the adoption loop.**
   `infer` should be the factual inventory agents use before writing comments. Normal `check` proves written annotations and scans supported callsites to annotated helpers; `check --annotations-only` keeps the quieter local pass for adoption. `audit` should point at redundant demo noise without auto-deleting public contracts. Reports should bucket failures into missing input fact, unsupported source shape, helper boundary, or real proof gap.

2. **Move checker knowledge toward a typed fact layer.**
   Keep public comments small. Internally, source readers now emit reusable range/equality/sequence facts, and contracts query those facts. `spaced`, same-index checks, adjacent row checks, and future view-ish concepts should avoid becoming one recognizer per demo.

3. **Keep TypeScript shape comparison bounded.**
   The experiment paid for itself, but it is still a shape oracle. It must not quietly become numeric proof logic.

4. **Revisit open-ended range spelling later.**
   `int > 0` reads too much like a type operator, so keep today’s explicit `int 1..Infinity` spelling. A future shorthand like `int 1..` or `0..` may be worth it once inline annotations become common enough that `Infinity` is visual noise. Do not add it until the parser story is boring.

## Normal Proof Track

Keep this visible so shape work and IR cleanup do not erase the boring proof/report/demo work that was already worth doing.

1. **Keep tightening input honesty.**
   `given` now only names input roots. Range facts must name one input path; comparison facts allow input paths, numbers, and simple arithmetic. Empty ranges, direct range contradictions, simple opposing comparisons like `given width >= 100` plus `given width <= 50`, small chained contradictions like `left >= middle`, `middle >= right`, `right > left`, and obvious range/comparison chain contradictions are rejected before later checks can lean on them. Next useful step: keep widening that contradiction check only where reports stay obvious.

2. **Keep helper/import report lines boring and precise.**
   Comparison reports now say `assumed from input`, `assumed from loop @fit`, `inferred from code`, `inferred from branch`, `checked helper contract`, or `checked imported contract`. Small comparison proof rules point at their missing obligation when possible: `scale >= 0` instead of repeating `content * scale <= available * scale`, `pointer < count * cellSize` instead of repeating `floor(pointer / cellSize) < count`, `py < countY * blockSize` for flattened grid hit indices, and `count > 0` for ceil-division coverage. Next report work is likely narrower missing-fact text for unsupported loop/indexed-product shapes in real demos.

3. **Turn scalar accumulators into better internal measures.**
   Non-negative `total += row.height`, `total = total + row.height`, guarded `if (...) total += row.height`, and simple min/max assignment loops give ranges. Unit guarded counts also know `count <= items.length`. Next useful shapes are still source inference, not public folds: totals and extrema that feed later comparisons and reports cleanly.

4. **Use real demos as pressure tests, then prune.**
   The checker is ready for small demos that stay inside the current surface: helper contracts across files, row stacks, maps/indexed rows/conditional rows, one-collection wildcard bounds, and scalar totals. Use `fr infer` to see what the checker actually knows before adding a proof feature; its function and loop spec sections are useful for deciding which `@fit` lines are documentation versus real missing input facts. Do not add an atom just because a demo would look nicer with one.
   Current demo read: Pretext `layoutTemplateFrame` has good inferred length/measure facts now. Vibescript photo-gallery now has statically known contracts on the real grid sizing, prompt visible sizing, line max sizes, line target math, stable edge hit areas, item geometry, and guarded row metadata spacing. `getGridLayout` now carries explicit input domains and returns full row metadata instead of parallel `rowsTop` / `rowHeights` arrays. The remaining photo-gallery gaps are larger loop/product facts: prompt-layout summaries across the unsupported text loop and the row-count relation behind `currentRow = Math.floor(i / cols)`.
   Photo-gallery spec-driven trial: two fresh workers rebuilt scratch galleries from docs plus a private formal packet and both landed the same 18 passing helper checks. The real demo now proves 65 checked photo-gallery lines across `layout.ts` and `prompt-layout.ts`, with scalar input domains mostly moved onto params, line-size math back in one helper, and row metadata spacing checked on the grid loop, so the next trial should feed workers more of the ground-truth source facts and tighten the prose packet around line sizing, neighbor visibility, edge-strip no-ops, overscan, bottom scroll runway, and optional animation handoff samples before asking for more Freerange power. The full sibling-demo annotation gate is currently 94 pass, 0 fail, 0 requires, 0 unknown.
   The first infer sweep across checked demos after pruning showed the right adoption shape: explicit checks that pass from code, input facts called out as assumptions, no not-inferred lines in the curated set, and redundant checks named with their covering inferred fact. The audit now splits redundant lines into likely-removable noise and public-looking contracts so pruning stays conservative.

   Corpus work now has a correctness gate instead of a hand-picked pressure set. `bun run verify:corpus` discovers every `@fit` source file under `/Users/chenglou/github/freerange-corpus`, grouped by top-level project and nearest `tsconfig.json`, and snapshots the exact file list and summary. Current sweep: 38 files, 143 check passes, 0 fail, 2 requires, 0 unknown. The two `requires` are still in `angular-grid-layout`; they are useful adoption pressure, not proof-engine crashes. The earlier read-only batches still explain where support came from: `xyflow` found named `const` arrow helpers, destructured params, silent helper summaries, interval multiplication over unbounded non-negative values, tuple geometry returns, tuple-slot helper summaries, fall-through branch joins, and conservative scalar/object assignment forgetting; `d3-scale` added `Math.sign`; `dagre` added numeric-limit range-loop pressure; `tldraw` confirmed small precision helpers fit the current surface; `floating-ui` earned static helper-binding support through `export const min/max = Math.min/max`; `dnd-kit`, `fabric.js`, Interact, `react-grid-layout`, `Chart.js`, and `d3-dag` filled in class members, anonymous default helpers, tuple/indexed-param ergonomics, browser-owned measurement boundaries, and graph-mutation humility. `fr scout --function name` exists as a read-only experiment for inferred candidate call obligations, but it is intentionally noisy: broad `return <= param` probes find useful facts like `min <= max` and silly inverse facts too. Use it to study one helper, not as a contract writer. Older full-sweep bucket notes:
   - `tldraw`: declaration maps now recover `@tldraw/editor` source for `clampToRange`; the optional-`max` clamp source shape is supported, so the next useful read is broader unsupported geometry predicates and assertions rather than another clamp atom.
   - `react-grid-layout`: callsite checks mainly want missing input facts for clamp bounds, e.g. `0 <= cols - w`, `0 <= maxRows - h`, `0 <= cols`, and `0 <= maxRows`.
   - `xyflow`: the focused checked files are clean now. Remaining `infer --all` noise in `general.ts` is mostly outside the numeric layout subset: broad string/DOM helpers, object spread, and mutation of object fields.
   - `2d-geometry` and `litegraph`: annotated focused files check clean, but broad inference still lands on missing helper contracts for boolean geometry predicates like `EQ`, `EQ_0`, `GT`, `isPointInRect`, and `isInRectangle`, plus class/array-like object shapes that are not worth solving before a concrete numeric claim needs them.
   - `moveable`: still an environment/dependency-resolution probe. `@scena/matrix`, `@daybrush/utils`, `framework-utils`, and `css-to-mat` are not installed/resolved in this checkout, so do not treat those as Freerange declaration-map failures.

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
- no trusting declaration files as checked helper contracts; declaration maps only recover local source
- no unguarded optional/nullable optimism
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

- Numeric atoms. Existing interval math, small finite numeric sets, small linear reduction, ceil/floor/modulo facts, positive scale/divide facts, `Math.min` / `Math.max` branch facts, and case-aware handwritten clamps cover a lot.
- Clamp atoms. Userland clamp works through helper contracts plus `Math.min` / `Math.max`.
- `sameLength` as a primitive. Append/running-sum inference often proves length directly.
- Early geometry atoms. Field math already works; keep writing `child.x + child.w <= parent.x + parent.w` until repeated demos earn a name like `inside`.
- Exhaustive integer sweeps. Keep them out unless a finite-domain static proof explicitly earns its complexity.

## Current Limitations

- Import support is deliberately tiny: named/default/namespace-qualified helper imports can use TypeScript resolution to local source, including relative paths, `tsconfig` path aliases, single-source declaration maps back to local source, exported numeric constants for named imports, explicit named re-exports, and top-level `const` helper bindings whose final target is already in the supported call set. Type-field comments also work through local source-backed type imports. Published packages, declaration-only imports without local source maps, wildcard barrels, summary files, and stale-summary policy are still out.
- Import failure reports distinguish unavailable contracts, unsupported import shapes, and imported contracts that failed in source.
- No public views yet.
- Impossible `given` checks are still small: empty ranges, direct contradictions against earlier ranges, simple opposing linear comparison bounds, short chained linear contradictions, and obvious range/comparison chain contradictions are caught, not every possible inconsistent set.
- `given` root checks are intentionally strict; loop-level `given` cannot describe local aliases yet.
- Loop-level `@fit` only attaches to supported `for...of` and indexed `for` loops.
- Loop-local `given` facts that pass the input-root check are assumed from that point forward, not proved against earlier state.
- TS shape reading now uses TypeScript as a structural oracle. It handles arrays, readonly arrays, finite string-literal/boolean unions, required fixed tuple slots, safe optional/rest tuple length ranges, object type literals, local and imported interfaces/type aliases, simple utility types, generic return instantiations, property-access call shape, namespace-imported structural call shape, unions, intersections, guarded optional/nullable values, and numeric nullish fallbacks. Optional/rest tuple slots, unguarded optional/nullable values, broad strings, and huge types are still conservative unknowns.
- Anonymous wildcard comparisons support one collection at a time. The same collection may appear on both sides. Labeled same-index comparisons can relate two collections when their lengths are proven equal. Adjacent formulas work only over one collection and only when a sequence relation was inferred; all-pairs and source/id matching are still unsupported.
- Mutation handling only forgets facts; it does not infer precise facts after mutation.
- Scalar accumulation support is thin: target-free `+=` and `total = total + delta` running sums, guarded `+=`, and simple min/max assignment loops work, but no `reduce`, spread aggregates, or public aggregate syntax yet.
- No general loops, nonlinear solver, overload semantics, general generic value reasoning, imported class-member summaries, async, closures, broad string operations, or branded-value reasoning.
