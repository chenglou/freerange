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

The real product pivot is make `infer` / `audit` / reports the adoption loop. Freerange should help humans and agents find the static red lines in normal TypeScript, then keep those lines honest. A good flow is:

```txt
read code
run infer
write only the product-important @fit comments
run check
use reports to classify the gap
```

This keeps comments immediately adoptable in chunks. A separate spec compiler or agent can sit on top later, but the core checker should stay boring.

The intrinsic/extrinsic verification note is [research/intrinsic-extrinsic-verification.md](./research/intrinsic-extrinsic-verification.md): stable value guarantees belong in representation, phase-local or algorithm-shaped guarantees belong in checked producers. This is the philosophical frame behind giving agents final contracts without forcing every intermediate construction through a narrow API.

## Spec-Driven Demos

The photo-gallery scratch trial is the best signal so far for agent-driven, spec-driven UI work. Two fresh agents got only Vibescript docs plus a private packet with Freerange-style source facts. Both produced runnable grid/line galleries, pure helper tests, browser-owned semantic reports, and the same 18 passing `@fit` checks on the same five seams.

The useful part was not "the whole app is formally verified." The useful part was that the spec made the statically known geometry boring:

- grid columns and max box width
- plain object geometry fields
- previous/next index math
- stable line hit boxes

That was enough to keep both agents away from screenshot or runner-side layout guesses. Browser reports stayed on browser-owned outcomes: hash sync, native selection, scroll restore, and occlusion.

It also found a spec bug before implementation: a nullable left hit area cannot honestly promise `return.left.targetIndex` for every focused index. Splitting previous/next target helpers from nullable edge control flow made the contract true.

No new primitive was needed. The current surface of ranges, comparisons, constants, helper contracts, and source inference was enough for the useful static part. The remaining misses were product-spec misses: exact line sizing, neighbor visibility, edge no-ops, overscan, bottom scroll runway, link target, and optional animation handoff samples.

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

- TS shapes are worth reading before asking for more comments. Arrays get non-negative integer lengths; finite literal unions give ordinary discriminant branches a small static domain; object/interface/type-alias/union/intersection shapes let sparse `@fit` comments still evaluate natural code. The useful boundary is now `src/shapes.ts`: TypeScript can tell us structural shape across imported aliases, utility types, generic instantiations, property-access calls, namespace-imported structural calls, and helper returns, but it must not give Freerange numeric ranges, sequence facts, or proof obligations. Source-backed type-field `@fit` comments are the exception because they are Freerange source, not TS shape. The walk is deliberately depth/width bounded so broad parser/library types do not become our problem.
- Ambient browser facts are a separate exception from TypeScript shape. A tiny dedicated table can say DOM-owned layout dimensions are non-negative when TypeScript resolves the property to `lib.dom.d.ts`; that is platform knowledge, not a user type fact. Keep it narrow: `document.documentElement.clientWidth` is useful, `{clientWidth: number}` is not special, and scroll offsets stay signed because RTL, overscroll, and rubber-banding make non-negative facts false.
- `items.map(...)` preserves length, simple field domains, optional callback index facts, and a same-index origin fact from the collection summary, not by unrolling every literal slot. `items.filter(...)` records an order-preserving subset origin, carries simple true-side item facts from expression-bodied and one-return predicates, and map/filter chains compose the origin back to the base source for `fr infer`. Richer source-order facts can come later when there is a public fact that needs them.
- `items.filter(...)` should stay a source summary, not a public callback language: output items keep the source item domain, output length is at most source length, `infer` can say the output is an order-preserving subset, and direct predicate facts like `item.height > 0` can narrow the output item.
- Length-bearing constructors are a small Pretext-shaped but generic source fact: `new Int8Array(segStarts.length)` preserves `.length == segStarts.length`. This does not prove typed-array element semantics, mutation, or bidi correctness; it only keeps the shape fact that later structural contracts need.
- Inline `// @fit 0..foo` is now placement-sensitive in the useful way: on params it is an input assumption, exactly like a lifted `given`; on locals and object fields it is a targeted check. That keeps boring scalar domains and red-line variables next to the code without turning `given` into a local escape hatch.
- append-only `for...of` can infer length, scalar-array element shape, cursor recurrence, `spaced`, `nondecreasing`, and per-item field ranges.
- Loop inference should keep splitting source reading from meaning. `src/loop-source.ts` can recognize narrow TypeScript shapes, but it should emit pushes, scalar updates, guards, and extrema. `src/loop-summary.ts` is the boundary for turning those summaries into array element facts and sequence facts.
- conditional push should infer `rows.length <= items.length`, not equal length. Subsequence/source order can come later when a fact needs it.
- indexed loops should infer index ranges and carry whichever pushed field actually came from the loop index, not only a field literally named `index`. One-to-one source order can come later when a fact needs it.
- thin running sums like `total += row.height`, guarded sums like `if (...) total += row.height`, and simple `min = Math.min(min, row.width)` / `max = Math.max(max, row.width)` assignment loops give numeric ranges. Next scalar-effect work should be cleaner reports when those measures feed later facts.
- `throw` guards are normal control flow, not an unsupported statement. If one branch exits, the later code should inherit the facts from the branch that can still run. This is the boring source-inference answer for positive-step and validated-input helpers.
- mutation like `sort`, `reverse`, `splice`, and indexed assignment should kill sequence facts unless summarized. Unsupported loop bodies can also be useful when they are only side effects on roots we can forget; preserve unrelated facts, never stale mutated-root facts.
- `fr infer` is useful as an inferred-facts view: it should show curated return/local facts and loop-local facts, not every internal linear assumption. Function and loop output should keep separating input assumptions, checked claims, not-inferred claims, and the narrower redundant checks already covered by emitted inferred facts. Redundant lines should name the covering fact, because otherwise the output is only a vibe. That lets authors shorten noisy `@fit` comments without losing the important guarantees. The important examples now live in `infer-snapshots.expected.txt`, so losing inference coverage is a normal test failure. Keep it focused on adoption instead of turning it into an annotation writer.
- `fr check --audit` should stay source-shaped, not become a style linter. The current family is pure choices where current facts prove one value, branch, condition, or fallback cannot affect the result: `Math.min`, `Math.max`, exact min/max ternaries, always-known `if` conditions, and redundant `??` fallbacks. Userland clamp helpers should join only when they report through the same source-owned shape instead of one helper-specific warning.
- `bun run shape-diff` compares evaluated Freerange structural facts with TypeScript-only shape for params, locals, and returns; raw call-return probing is opt-in. It helped classify photo-gallery and Pretext blockers: TypeScript could see prompt layout, measurement, item geometry, edge hit-area, and `layoutBlockFrame` structure; the remaining work is mostly proof/report/product semantics, not object-path blindness.

Corpus loop notes:

- Keep cloned external probes isolated under `/Users/chenglou/github/freerange-corpus`. The repo now has a full correctness sweep over every discovered `@fit` source file there, grouped by project and nearest `tsconfig.json`; current snapshot: 38 files, 143 check passes, 0 fail, 2 requires, 0 unknown. Do not pretend those branches are product integrations; they are red-line specimens for finding general source shapes.
- The April corpus report sweep across `xyflow`, `tldraw`, `fabric.js`, `interact.js`, `2d-geometry`, `dagre`, `d3-scale`, `gridstack.js`, `angular-grid-layout`, and `moveable` mostly found adoption polish, not proof-language pressure. Tuple-heavy files needed readable fixed array lengths like `return.length == 5`, not recurrence noise. Unknown identifiers should propagate through element and binary expressions so the report names the real blocker instead of saying "expected an array" or "expected numbers."
- The first `xyflow` probe was worth it immediately. `packages/system/src/utils/general.ts` wanted contracts on `clamp`, rect/box conversion, box union, and overlap area. The fixes were general: named `const` arrow/function-expression boundaries, typed object destructuring params, helper summaries that can narrow a stored local when preconditions prove, and `0..Infinity * 0..Infinity` staying `0..Infinity` instead of becoming `NaN..NaN`.
- The next `xyflow` edge-geometry pass added tuple-shaped pressure: `getEdgeCenter` and `getBezierEdgeCenter` naturally return `[centerX, centerY, offsetX, offsetY]`, and callers destructure skipped slots. Supporting array binding patterns was a better answer than asking code to name throwaway locals or wrap tuple returns in objects.
- `straight-edge` and `smoothstep-edge` found three root fixes, all general. Proof helpers must decline weird internal expression strings instead of crashing. Source-proved tuple-slot facts such as `return[2] >= 0` need to survive helper/import summaries. And functions with SVG/string-building side effects should keep proving unrelated numeric tuple facts: simple fall-through branches now join local envs, local assignment is supported, and unsupported scalar/object mutations forget only the changed root.
- The aliasing fix belongs at helper binding and call-site rebasing, not in each proof rule. Caller numeric values now carry their bottomed-out linear form through local aliases and callee parameters, and reports/infer print the same caller-side expressions after helper calls. That lets `max = cols - w` prove a helper's `max >= min` from the original `given w <= params.cols`, and when it cannot prove the call it reports `cols - w`, not a callee-local `max`. The rebase pass must still respect expression syntax: parameter names can rewrite value identifiers, but not callee names like `min(...)` or `max(...)`. The same pass exposed that fixed tuple slots like `extent[1][0]` are honest input paths for `given` lines; dynamic `items[index]` is still source proof, not an input fact.
- The TS-native spike was useful as a substrate test, not a replacement proof engine. TypeScript should own syntax diagnostics, project file context, and module identity where that makes Freerange less hand-rolled; Freerange should keep intervals, helper contracts, sequence summaries, and report meaning. The production slice now follows that line: explicit file checks still check only those entries, but the TypeScript program includes the nearest tsconfig file set for type lookup; syntax errors report TypeScript diagnostic codes before proof starts; imports bind to the final local source declaration TypeScript resolves, so explicit and star barrels no longer need a Freerange export graph. Keep future compiler-adjacent adoption in this shape unless a bigger spike proves the proof engine itself gets simpler.
- Guarded branch joins should retain useful branch cases when ordinary interval joining would hide a small finite result. This is still source inference, not a new annotation language: `flag ? 0 : 100` can prove `return: 0 | 100`, while broad arithmetic still reports the interval and the branch-produced values when a finite-set claim is wrong.
- Control-flow truth and proof truth are different. A failed universal comparison over case-split values does not make an `if` branch impossible; mixed cases should stay `maybe`, and branch refinement should attach the condition to each surviving case. That is enough for normal assignment-style clamps without a clamp-specific recognizer.
- Symbolic index precision should use the same small case layer, but only for tuple/product slots. Normal arrays are summarized collections; exact index cases like `0 | 2` should select slots only when the target is tuple-shaped. Broad index ranges keep the element summary instead of pretending every symbolic index is understood. Specific source reads like `items[focused].top` now keep concrete path terms, and local adjacent sequence facts can instantiate previous/current and current/next neighborhoods once bounds prove them live.
- Nullable shape support should stay tied to real TypeScript control flow for now. A guarded read of an optional property can use the narrowed shape at that expression; optional numeric values can feed normal math after `typeof value !== 'undefined'` or a numeric `??` fallback; a nullable local or property path constructed from branch source facts can expose its present-side facts after `== null` / `!= null`; an unguarded optional path should remain unknown rather than becoming an optimistic nullable object domain.
- Else-if support was a control-flow hole, not a new proof idea. TypeScript represents `else if` as an `IfStatement` inside the outer `else`, so the right fix was to evaluate that nested branch with the same continuation. That made xyflow's `calcAutoPanVelocity` ordinary source again and moved the focused `general`/resizer slice to 27 checked claims and 15 clean callsite checks.
- The first speculative-contract pass was useful but not satisfying enough to promote inferred contracts. It tried simple return-vs-param comparisons and scanned calls against provisional requirements. That exposed real-looking obligations like `min <= max`, but also inverse facts like `max <= min` when the speculative candidate was silly. We removed the separate command; the durable path is explicit contracts plus `infer`, not generated law.
- Row sequence summaries should be path-aware internally. A pushed `{rowRect: {top, height}}` can earn `nondecreasing(rows.rowRect.top)` and exact adjacent `rowRect` facts using the same sequence relation layer as top-level rows. Keep pathless `spaced`, `lastEnd`, and `extentEnd` on the old top-level row shape until views give nested spans an explicit public name.
- The first non-xyflow pass stayed similarly boring. `d3-scale/src/radial.js` wanted `Math.sign` for signed square/unsquare helpers. `dagre/lib/greedy-fas.ts` wanted numeric-limit indexed loops for `range(limit)`. `tldraw/packages/editor/src/lib/primitives/utils.ts` passed small precision helpers with existing arithmetic. `masonry/masonry.js` did not get source comments because the useful layout seams are old-JS prototype assignments over `this`, plus `while` loops and dynamic calls; adding inert comments there would lie about coverage.
- The second external sweep added `floating-ui`, `dnd-kit`, `react-grid-layout`, `d3-dag`, `Chart.js`, and `fabric.js`. The useful new pressure is not another one-off atom:
  - `floating-ui` is full of axis-parametric geometry: `coords[axis]`, `overflow[side]`, placement switches, platform callbacks, and async middleware. The pure arithmetic is good, but the natural spec wants either directional views or first-class axis aliases, not many copied X/Y comments.
  - `dnd-kit` and `fabric.js` put the cleanest geometry behind class methods and getters: rectangle `right`, `bottom`, `center`, `area`, `containsPoint`, intersection area, rounded-rect radii. Freerange supports local `@fit` checks on class methods/getters with `this` as an input root, same-file member summaries, and imported local-source class-member summaries for ordinary property/method calls.
  - `react-grid-layout` is a strong fit for the current arithmetic surface: column width, grid-to-pixel positions, clamped `calcXY` / `calcWH`, and background cell dimensions. The repeated friction is tuple/indexed params (`margin[0]`, `containerPadding[1]`), `Number.isFinite` branch refinement, and public clamp preconditions.
  - `Chart.js` has a few small clamp/size helpers, but the interesting layout/data helpers use DOM/CSS measurement, sorted-window `while` loops, and `slice(start, end)`. A verifier should not pretend to own browser measurement there; the possible static seam is "cropped subsequence stays within sorted bounds," which needs monotone array facts first.
  - `d3-dag` is graph algorithm pressure: node/link mutation, `entries()` indexed iteration, Map/set state, tuple node sizes, and routed link points. It argues for staying humble. Freerange can check extracted geometry seams, not whole graph layout algorithms yet.
- The next corpus batch added `gridstack.js`, `angular-grid-layout`, `moveable`, `interact.js`, and `2d-geometry`. The useful general addition was recognizing anonymous default-exported arrow/function expressions as local check boundaries; Interact's `center(rect)` shape is exactly that. The remaining blockers were proof-shape pressure, not new syntax pressure: relational facts do not yet refine `round((a - b) / positive) + 1` ranges, optional object branches lose exact object-field equalities, nested branch mutation in small geometry helpers is still unsupported, and ternary min/max written by hand is harder to prove than `Math.min` / `Math.max`.
- Focused post-alias corpus rerun: react-grid-layout's clamp-heavy calculation files and xyflow's general/resizer utilities both check clean with ordinary input facts. The xyflow parent clamp case was useful because it stayed boring: say child dimensions are non-negative and no larger than the measured parent dimensions, then the existing helper contract proves the clamped position.
- This is the right feedback loop: annotate a small real helper file, let reports show the first honest blocker, fix the root if it is general, then add a tiny positive and negative kernel before moving to the next corpus file.

Infinity hygiene:

- `Infinity` is a real range bound, not a fallback for "I did not think about this." Use it when a value is physically unbounded from the code's point of view, like scroll offsets, cumulative layout positions, or generic clamp inputs. Use finite upper bounds only when they are product/support facts, real caller facts, or real caps in the code.
- Finite caps that merely make proofs pass should be treated as debt. The better end state is usually a relational fact (`index < items.length`, `width <= maxWidth`, `top == previous bottom + gap`) or a code cap. If neither exists yet, leave the finite cap visible and call it out.

Demo notes from the first infer pass:

- Pretext `layoutTemplateFrame` now exposes the useful boring facts: block count is preserved, `bubbleHeight` and `totalHeight` share the same running measure, and the `usedContentWidth` max accumulator stays numeric. The next real blocker there is not min/max; it is whether we want better contracts around helper return measures like `layoutBlockFrameResult.height`.
- Vibescript photo-gallery became much more useful once the real demo owned the small facts directly: grid image caps, width capping, line max sizes, edge targets, stable hit boxes, prompt visible sizing, and item geometry. The useful version is the trimmed one; one-off row/column/index helpers inflated the pass count without making the app code clearer.
- Vibescript photo grid now proves the row-height packing loop's row metadata and gaps. The remaining product-shaped gaps are row count, item-to-row/column adjacency, and prompt/text loop summaries; those should keep coming from real demos before we add more language.
- The broader Pretext markdown parser shows noisy but honest unsupported shapes: switches, `continue`, `null`, counted loops over scalar bounds, and text/string work. Most of that is not layout proof pressure yet.

## Wildcard Semantics

One-sided `[]` is anonymous `for every item here`:

```ts
rows[].height <= maxHeight
sections[].rows[].height <= maxHeight
```

Do not give two-sided anonymous `[]` a hidden meaning:

```ts
rows[].top <= boxes[].bottom
```

That could mean same index, all pairs, matched by source item, matched by id, or adjacent rows. The syntax should carry the relationship.

Einops is a useful taste reference: named axes make repetition meaningful. Repeated labels now mean same-index comparison when matching lengths are proven:

```ts
rows[$i].top <= boxes[$i].bottom
```

The first adjacent form is deliberately tiny:

```ts
rows[$i].top <= rows[$i + 1].top
```

It lowers to an adjacent sequence relation. The same internal relation layer can
also prove specific red lines when a loop emitted the exact relation:

```ts
rows[$i + 1].top >= rows[$i].bottom + gap
```

This is still not a general quantified expression language. Adjacent formulas
only work over one collection and only when a source summary emitted the matching
sequence fact. All-pairs comparison and source/id matching are still future work.
Different labels might eventually mean all-pairs comparison:

```ts
children[$i].right <= blockers[$j].left
```

SQL is the taste reference for source/id matching: name the relation. If two collections match by source item, fragment id, line id, or range ownership, bracket labels alone are probably not enough.

## Internal IR

A layered IR seems better than one giant SMT encoding. This is mostly internal, but it should be visible through `infer`, audits, and report provenance:

The interpreter cutover note is [research/abstract-interpreter.md](./research/abstract-interpreter.md): one engine now owns source evaluation; the remaining work is clearer module boundaries around that engine and the checker shell.

- scalar refinements: intervals, small finite sets, small linear facts, symbolic equality, modulo/congruence facts
- object/path facts: `Field(row, "top")`, `Path(rows, i, "height")`
- sequence facts: `Len(rows)`, `Elem(rows, i)`, append histories, source maps
- views: spans, ranges, rects, logical rects
- layout constraints: `Nondecreasing`, `Spaced`, `Inside`, `Partitions`, `SameSource`
- loop summaries: cursor recurrences and append summaries
- optional backend obligations: SMT later, only where earned

The important boundary is source readers emit reusable facts, contract comments become explicit obligations, and checks query the fact inventory. The current code has started this split: `src/fact-inventory.ts` owns published fact identity/indexing, `src/facts.ts` publishes interpreter values into that inventory, `src/obligations.ts` attaches proof-obligation/proof-trace metadata to checks, and `src/proof-facts.ts` publishes the small set of facts a proof saw without changing the public CLI. For example, a cursor loop should first emit facts like:

```txt
rows.length == items.length
rows[].bottom == rows[].top + rows[].height
rows[$i + 1].top >= rows[$i].bottom + gap
nondecreasing(rows.top)
spaced(rows, gap)
```

Then public checks, atoms, `infer`, and report wording all consume the same fact inventory. `src/facts.ts` now owns the typed inferred fact output, and `src/sequence-facts.ts` owns adjacent sequence relation queries. Object-array and parallel-array code should converge here when they prove the same layout relation.

`semantic-snapshots.expected.txt` is the tiny guard for this internal layer. It should stay small: obligation boundary, structured goal, proof step, and facts used. Bigger user-facing output still belongs in normal negative/report snapshots.

Collection/sequence/proof-context/numeric ownership should keep leaving the general value domain. `src/domain-types.ts` owns the shared abstract value types; `src/array-summary.ts` owns summary merging and empty-branch lineage joins; `src/assumptions.ts` owns linear/comparison assumption identity; `src/number-domain.ts` owns numeric construction, finite cases, arithmetic, running sums, and extrema; `src/domain.ts` still re-exports those helpers while callers settle. That is the model for future domain splitting: move one coherent ownership boundary, keep behavior flat, then let imports migrate when the payoff is clear.

Named facts should have both a human lowering and a proof rule. E.g. `spaced(rows, gap)` means adjacent starts differ by previous size plus `gap`, but the proof rule can come from a recognized cursor loop.

Comparison proof rules are now their own small layer. Keep it modest: a rule matches one goal, asks for ordinary obligations, and uses the same obligations for proving and report text. Current examples include signed shared factors/divisors, positive cancellation, non-strict `floor` / `ceil` monotonicity, and floor hit-index bounds:

```txt
goal: content * scale <= available * scale
known: content <= available
missing: scale >= 0

goal: floor(pointer / cellSize) < count
known: cellSize > 0
missing: pointer < count * cellSize

goal: floor(y / cell) * countX + floor(x / cell) < countX * countY
known: x < countX * cell, cell > 0, countX > 0
missing: y < countY * cell
```

This should grow only when a proof shape would otherwise split into separate proof and report helpers.

## Module Boundaries

Imports should find contracts, not turn Freerange into a second TypeScript compiler. The first useful rule is:

- same-file helpers may still be read from source
- cross-file calls use exported `@fit` contracts as summaries
- imported helper contracts must be proved from source in the same run before callers can use them
- imported bodies are not inlined at the call site

The resolver asks TypeScript for the final declaration behind an import when that declaration lives in local source, and it can recover local source from a declaration file with one source in its declaration map. That means explicit named re-export barrels and source `export *` barrels collapse to the same import binding as a direct import. Top-level `const` helper bindings still have to be statically known, and the final target still has to be a supported `Math` call, same-file helper, or local-source imported helper. That is enough for relative helpers, `.tsx` helpers, `tsconfig` path aliases, built workspace packages with source maps, and code like `export const max = Math.max` without committing to arbitrary package exports, declaration-only summaries, stale-summary trust, mutable helper bindings, or workspace caches.

TypeScript shape comparison is not a helper contract. It is okay for TS to say "this return value has `.rows.length`" or "this generic `Box<T>` has `.value`." It is not okay for TS type shape itself to prove `rows[].height: 0..40`, `spaced(rows, gap)`, or an imported helper's numeric postcondition. Source-backed type-field comments may prove field ranges across local imports, but the contract still comes from reading Freerange comments in source. This distinction is why structural fallback is useful without becoming a summary system. Namespace-qualified helper calls and namespace-qualified type references may now use local checked `@fit` contracts, but the contract still comes from source, not from TypeScript shape.

We tried automatic inferred return exports in branch `codex/implicit-return-summaries-experiment` (`ff3626e`). The shape was conceptually nice: prove a helper once, infer small returned-return facts, then export those facts at call sites. In practice it grew a real subsystem: summary caching, public-expression filtering, return-expression rebasing, provenance, and boundary assumptions. The demo audit did not show enough line-count win. The lines it might delete were mostly the useful public contracts we still want humans and agents to read, such as `clamp: return >= min`, `gridImageSizeX: return <= naturalSizeX`, and prompt visible-sizing caps. At the time, pruning only the obvious `>= 0` lines dropped checked demo contracts from 125 to 113; the current sibling-demo gate is leaner for other reasons. Keep `infer` as an adoption tool for now, not a caller-visible summary API. Revisit only if multiple real demos show repeated helper contracts that are clearly noise rather than red-line documentation.

Structural equality should stay small too. Proving `return.rows == input.rows` because both sides are the same source expression is useful. Recursive object/array equality is a different feature and should wait for a real need.

Reports now say whether a fact came from source, a branch split, an assumed `given`, a checked same-file helper contract, or a checked imported contract. Keep that boundary visible if assumed summaries ever land; do not let a checked-in summary launder a failed source check.

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

- inferred from code
- inferred from branch
- assumed input `given`
- assumed loop-local `given`
- checked same-file helper contract
- checked imported contract
- assumed summary, if that ever exists
- unsupported

Unsupported source reports should include the source line when the interpreter
knows the node. That line is where proof stopped, not necessarily where the
human-written `@fit` claim lives. If a missing root makes later property,
element, or assignment reads fall apart, report the missing root once and keep
the next distinct blocker. A short unsupported list is easier to act on than a
trace of every failed child expression.

For shared-factor arithmetic, missing facts should name the small human obligation. If the code has:

```ts
content * scale <= available * scale
```

and `content <= available` is known, the missing line should be `scale >= 0`, not a restatement of the whole product comparison.

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
- Read source by default. Use summaries only for genuinely opaque helper boundaries, and make the report say which helper was assumed.
- Use mutation/red probes as research signals. They are good for finding holes in the proof surface, but they should not become verifier guarantees.
- `life-calendar` was a useful hard numeric example: `**`, `Math.sqrt`, `Math.ceil`, integer facts after `ceil(life / countX)`, and half-open grid hit testing.
- Bad `given` lines are not harmless. Reject small linear contradictions before proof, including chained comparisons and obvious range/comparison chains, so the rest of the checker never gets to prove from an empty input set.

## Did Not Earn Itself

- Treating browser behavior as statically proved.
- Hard-coding app helper names into the analyzer.
- Rewriting app code into checker-shaped helpers like `add(...)` / `sub(...)`.
- Public lambdas, `forall`, arbitrary folds, aliases, or prose as truth.
- Giant unsplit intervals.
- Pulling in every demo at once before a second shape was actually understood.
- SMT, octagons, or polyhedra up front. Let a real layout law earn them.
