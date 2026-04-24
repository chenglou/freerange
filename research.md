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

This keeps comments immediately adoptable in chunks. A separate spec compiler or agent can sit on top later, but the core checker should stay boring: comments state facts, source code earns them, and reports say where proof stopped.

## Spec-Driven Demos

The photo-gallery scratch trial is the best signal so far for agent-driven, spec-driven UI work. Two fresh agents got only Vibescript docs plus a private packet with Freerange-style source facts. Both produced runnable grid/line galleries, pure helper tests, browser-owned semantic reports, and the same 18 passing `@fit` checks on the same five seams.

The useful part was not "the whole app is formally verified." The useful part was that the spec made the source-owned geometry boring:

- grid columns and max box width
- plain object geometry fields
- previous/next index math
- stable line hit boxes

That was enough to keep both agents away from screenshot or runner-side layout guesses. Browser reports stayed on browser-owned outcomes: hash sync, native selection, scroll restore, and occlusion.

It also found a spec bug before implementation: a nullable left hit area cannot honestly promise `result.left.targetIndex` for every focused index. Splitting previous/next target helpers from nullable edge control flow made the contract true.

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

- TS shapes are worth reading before asking for more comments. Arrays get non-negative integer lengths; object/interface/type-alias/union/intersection shapes let sparse `@fit` comments still evaluate natural code. The useful boundary is now `src/shapes.ts`: TypeScript can tell us structural shape across imported aliases, utility types, generic instantiations, property-access calls, namespace-imported structural calls, and helper returns, but it must not give Freerange numeric ranges, sequence facts, or proof obligations. The walk is deliberately depth/width bounded so broad parser/library types do not become our problem.
- `items.map(...)` preserves length, simple field domains, and optional callback index facts. Expression callbacks and tiny block callbacks are enough for the code we have seen; source order can come later when there is a public fact that needs it.
- `items.filter(...)` is worth supporting as a boring subsequence summary: output items keep the source item domain and output length is at most source length. Do not let that grow into predicate logic yet.
- Inline `// @fit 0..foo` is now placement-sensitive in the useful way: on params it is a trusted input domain, exactly like a lifted `given`; on locals and object fields it is a targeted check. That keeps boring scalar domains and red-line variables next to the code without turning `given` into a local escape hatch.
- append-only `for...of` can infer length, scalar-array element shape, cursor recurrence, `spaced`, `nondecreasing`, and per-item field ranges.
- Loop inference should keep splitting source reading from meaning. `src/loop-source.ts` can recognize narrow TypeScript shapes, but it should emit pushes, scalar updates, guards, and extrema. `src/loop-summary.ts` is the boundary for turning those summaries into array element facts and sequence facts.
- conditional push should infer `rows.length <= items.length`, not equal length. Subsequence/source order can come later when a fact needs it.
- indexed loops should infer index ranges. One-to-one source order can come later when a fact needs it.
- thin running sums like `total += row.height`, guarded sums like `if (...) total += row.height`, and simple `min = Math.min(min, row.width)` / `max = Math.max(max, row.width)` assignment loops give numeric ranges. Next reducer-like work should be cleaner reports when those measures feed later facts.
- mutation like `sort`, `reverse`, `splice`, and indexed assignment should kill sequence facts unless summarized. Unsupported loop bodies can also be useful when they are only side effects on roots we can forget; preserve unrelated facts, never stale mutated-root facts.
- `bun run infer` is useful as a checker x-ray: it should show curated result/local facts and loop-local facts, not every internal linear assumption. Function and loop output should keep separating trusted givens, source-proved checks, not-inferred checks, and the narrower redundant checks already covered by emitted inferred facts. Redundant lines should name the covering fact, because otherwise the output is only a vibe. That lets authors shorten noisy `@fit` comments without losing the important guarantees. The important examples now live in `infer-snapshots.expected.txt`, so losing inference coverage is a normal test failure. Keep it dev-only until the output is consistently useful on demos.
- `bun run shape-diff` is a different x-ray. It compares evaluated Freerange structural facts with TypeScript-only shape for params, locals, and returns; raw call-return probing is opt-in. It helped classify photo-gallery and Pretext blockers: TypeScript could see prompt layout, measurement, item geometry, edge hit-area, and `layoutBlockFrame` structure; the remaining work is mostly proof/report/product semantics, not object-path blindness.

Corpus loop notes:

- Keep cloned external probes isolated under `/Users/chenglou/github/freerange-corpus`. Current pressure set: `tldraw`, `dagre`, `xyflow`, `d3-scale`, and `masonry`. Do not pretend those branches are product integrations; they are red-line specimens for finding general source shapes.
- The first `xyflow` probe was worth it immediately. `packages/system/src/utils/general.ts` wanted contracts on `clamp`, rect/box conversion, box union, and overlap area. The fixes were general: named `const` arrow/function-expression boundaries, typed object destructuring params, helper summaries that can narrow a stored local when preconditions prove, and `0..Infinity * 0..Infinity` staying `0..Infinity` instead of becoming `NaN..NaN`.
- The next `xyflow` edge-geometry pass added tuple-shaped pressure: `getEdgeCenter` and `getBezierEdgeCenter` naturally return `[centerX, centerY, offsetX, offsetY]`, and callers destructure skipped slots. Supporting array binding patterns was a better answer than asking code to name throwaway locals or wrap tuple returns in objects.
- This is the right feedback loop: annotate a small real helper file, let reports show the first honest blocker, fix the root if it is general, then add a tiny positive and negative kernel before moving to the next corpus file.

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

- scalar refinements: intervals, small linear facts, symbolic equality, modulo/congruence facts
- object/path facts: `Field(row, "top")`, `Path(rows, i, "height")`
- sequence facts: `Len(rows)`, `Elem(rows, i)`, append histories, source maps
- views: spans, ranges, rects, logical rects
- layout constraints: `Nondecreasing`, `Spaced`, `Inside`, `Partitions`, `SameSource`
- loop summaries: cursor recurrences and append summaries
- optional backend obligations: SMT later, only where earned

The important boundary is source readers emit reusable facts, and contract checks query those facts. For example, a cursor loop should first emit facts like:

```txt
rows.length == items.length
rows[].bottom == rows[].top + rows[].height
rows[$i + 1].top >= rows[$i].bottom + gap
nondecreasing(rows.top)
spaced(rows, gap)
```

Then public checks, atoms, `infer`, and report wording all consume the same fact inventory. `src/facts.ts` now owns the typed inferred fact output, and `src/sequence-facts.ts` owns adjacent sequence relation queries. Object-array and parallel-array code should converge here when they prove the same layout relation.

Named facts should have both a human lowering and a proof rule. E.g. `spaced(rows, gap)` means adjacent starts differ by previous size plus `gap`, but the proof rule can come from a recognized cursor loop.

Comparison proof rules are now their own small layer. Keep it modest: a rule matches one goal, asks for ordinary obligations, and uses the same obligations for proving and report text. The first examples are shared positive factors/divisors and floor hit-index bounds:

```txt
goal: content * scale <= available * scale
known: content <= available
missing: scale >= 0

goal: floor(pointer / cellSize) < count
known: cellSize > 0
missing: pointer < count * cellSize
```

This should grow only when a proof shape would otherwise split into separate proof and report helpers.

## Module Boundaries

Imports should find contracts, not turn Freerange into a second TypeScript compiler. The first useful rule is:

- same-file helpers may still be read from source
- cross-file calls use exported `@fit` contracts as summaries
- imported helper contracts must be proved from source in the same run before callers can use them
- imported bodies are not inlined at the call site

The resolver follows named imports through TypeScript module resolution when they land on local source files, and it follows explicit named re-export barrels. That is enough for relative helpers, `.tsx` helpers, and `tsconfig` path aliases without committing to package exports, declaration-only imports, wildcard barrels, summary files, stale-summary trust, or workspace caches.

TypeScript shape piggybacking is not a helper contract. It is okay for TS to say "this return value has `.rows.length`" or "this generic `Box<T>` has `.value`." It is not okay for TS type shape to prove `rows[].height: 0..40`, `spaced(rows, gap)`, or an imported helper's numeric postcondition. This distinction is why structural fallback is useful without becoming a summary system, and why namespace imports can provide shape while still not providing trusted `@fit` contracts.

We tried automatic inferred result exports in branch `codex/implicit-result-summaries-experiment` (`ff3626e`). The shape was conceptually nice: prove a helper once, infer small returned-result facts, then export those facts at call sites. In practice it grew a real subsystem: summary caching, public-expression filtering, result-expression rebasing, provenance, and boundary assumptions. The demo audit did not show enough line-count win. The lines it might delete were mostly the useful public contracts we still want humans and agents to read, such as `clamp: result >= min`, `gridImageSizeX: result <= naturalSizeX`, and prompt visible-sizing caps. We only pruned the obvious `>= 0` lines already covered by concrete ranges; checked demo contracts dropped from 125 to 113. Keep `infer` as an adoption x-ray for now, not a caller-visible summary API. Revisit only if multiple real demos show repeated helper contracts that are clearly noise rather than red-line documentation.

Structural equality should stay small too. Proving `result.rows == input.rows` because both sides are the same source expression is useful. Recursive object/array equality is a different feature and should wait for a real need.

Reports now say whether a fact came from source, a branch split, a trusted `given`, a source-proved same-file helper contract, or a source-proved imported contract. Keep that boundary visible if trusted summaries ever land; do not let a checked-in summary launder a failed source proof.

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
- source-proved same-file helper contract
- source-proved imported contract
- trusted summary, if that ever exists
- unsupported

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
- Read source by default. Use summaries only for genuinely opaque helper boundaries, and make the report say which helper was trusted.
- Use mutation/red probes as research signals. They are good for finding holes in the proof surface, but they should not become verifier guarantees.
- `life-calendar` was a useful hard numeric example: `**`, `Math.sqrt`, `Math.ceil`, integer facts after `ceil(life / countX)`, and half-open grid hit testing.
- Bad `given` lines are not harmless. Reject small linear contradictions before proof, including chained comparisons, so the rest of the checker never gets to prove from an empty input set.

## Did Not Earn Itself

- Treating browser behavior as statically proved.
- Hard-coding app helper names into the analyzer.
- Rewriting app code into checker-shaped helpers like `add(...)` / `sub(...)`.
- Public lambdas, `forall`, arbitrary folds, aliases, or prose as truth.
- Giant unsplit intervals.
- Pulling in every demo at once before a second shape was actually understood.
- SMT, octagons, or polyhedra up front. Let a real layout law earn them.
