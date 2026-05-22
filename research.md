# Freerange Research

Durable design notes. Keep current priorities in [todo.md](./todo.md), command and repo details in [DEVELOPMENT.md](./DEVELOPMENT.md), and user-facing behavior in [DOCUMENTATION.md](./DOCUMENTATION.md). This file is for decisions we may revisit, open language questions, and lessons that survived more than one experiment.

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

The photo-gallery scratch trial is the best signal so far for agent-driven, spec-driven UI work. Two fresh agents got only Vibescript docs plus a private packet with Freerange-style source facts. Both produced runnable grid/line galleries, pure helper tests, browser behavior reports, and the same 18 passing `@fit` checks on the same five boundaries.

The useful part was not "the whole app is formally verified." The useful part was that the spec made the statically known geometry boring:

- grid columns and max box width
- plain object geometry fields
- previous/next index math
- stable line hit boxes

That was enough to keep the static claims on the geometry above.

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
- Whole-value specs cover the contract side of that boundary. `return: {left: 0, width: 100} | {left: 20, width: 80}` checks paired object cases from return cases; `return.left: 0 | 20` only checks the flattened field. Internally, keep this as TypeScript type syntax plus Freerange range slots, not as a parallel object/union tree. Keep this distinction visible in docs and reports because it is the user's way to choose between a cheap field fact and a paired value fact.
- Ambient browser facts are a separate exception from TypeScript shape. A tiny dedicated table can say DOM-owned layout dimensions are non-negative when TypeScript resolves the property to `lib.dom.d.ts`; that is platform knowledge, not a user type fact. Keep it narrow: `document.documentElement.clientWidth` is useful, `{clientWidth: number}` is not special, and scroll offsets stay signed because RTL, overscroll, and rubber-banding make non-negative facts false.
- `items.map(...)` preserves length, simple field domains, optional callback index facts, and a same-index origin fact from the collection summary, not by unrolling every literal slot. `items.filter(...)` keeps the source item domain, length no larger than the source length, simple true-side item facts, and an order-preserving subset origin.
- Length-bearing constructors are a small Pretext-shaped but generic source fact: `new Int8Array(segStarts.length)` preserves `.length == segStarts.length`. This does not prove typed-array element semantics, mutation, or bidi correctness; it only keeps the shape fact that later structural contracts need.
- Inline `// @fit 0..foo` is now placement-sensitive in the useful way: on params it is an input assumption, exactly like a lifted `given`; on locals and object fields it is a targeted check. That keeps boring scalar domains and red-line variables next to the code without turning `given` into a local escape hatch.
- Append-only loops can infer length, scalar-array element shape, cursor recurrence, `spaced`, `nondecreasing`, and per-item field ranges. `src/loop-source.ts` should keep recognizing narrow TypeScript shapes; `src/loop-summary.ts` should turn those summaries into array element facts and sequence facts.
- conditional push should infer `rows.length <= items.length`, not equal length. Subsequence/source order can come later when a fact needs it.
- indexed loops should infer index ranges and carry whichever pushed field actually came from the loop index, not only a field literally named `index`. One-to-one source order can come later when a fact needs it.
- thin running sums like `total += row.height`, guarded sums like `if (...) total += row.height`, and simple `min = Math.min(min, row.width)` / `max = Math.max(max, row.width)` assignment loops give numeric ranges. Next scalar-effect work should be cleaner reports when those measures feed later facts.
- `throw` guards are normal control flow, not an unsupported statement. If one branch exits, the later code should inherit the facts from the branch that can still run. This is the boring source-inference answer for positive-step and validated-input helpers.
- mutation like `sort`, `reverse`, `splice`, and indexed assignment should kill sequence facts unless summarized. Unsupported loop bodies can also be useful when they are only side effects on roots we can forget; preserve unrelated facts, never stale mutated-root facts.
- `infer` should show curated return/local facts and loop-local facts, not every internal linear assumption. Function and loop output should separate assumptions, checked claims, not-inferred claims, and redundant checks already covered by emitted inferred facts. Redundant lines should name the covering fact.
- `check --audit` should stay cleanup advice, not become a style linter. Userland clamp helpers should join only when they report through the same source shape instead of one helper-specific warning.

Other durable notes:

- `Infinity` is a real range bound, not a fallback for "I did not think about this." Use it when a value is physically unbounded from the code's point of view, like scroll offsets, cumulative layout positions, or generic clamp inputs. Use finite upper bounds only when they are product/support facts, real caller facts, or real caps in the code.
- Finite caps that merely make proofs pass should be treated as debt. The better end state is usually a relational fact (`index < items.length`, `width <= maxWidth`, `top == previous bottom + gap`) or a code cap. If neither exists yet, leave the finite cap visible and call it out.
- TypeScript should own syntax diagnostics, project file context, and module identity where that makes Freerange less hand-rolled. Freerange should keep intervals, helper contracts, sequence summaries, and report meaning.
- Helper aliasing belongs at helper binding and call-site rebasing, not in each proof rule. Reports should name caller-side expressions like `cols - w`, not callee-local parameter names.
- Control-flow truth and proof truth are different. A failed universal comparison over case-split values does not make an `if` branch impossible; mixed cases should stay `maybe`.
- Symbolic index precision should use small finite cases only for tuple/product slots. Normal arrays stay summarized collections.
- Nullable shape support should stay tied to real TypeScript control flow for now. Unguarded optional paths should remain unknown rather than becoming optimistic nullable object domains.
- Explicit contracts plus `infer` are the durable path for now, not generated helper laws.

Photo-gallery notes from the first infer pass:

- Vibescript photo-gallery became much more useful once the real demo owned the small facts directly: grid image caps, width capping, line max sizes, edge targets, stable hit boxes, prompt visible sizing, and item geometry. The useful version is the trimmed one; one-off row/column/index helpers inflated the pass count without making the app code clearer.
- Vibescript photo grid now proves the row-height packing loop's row metadata and gaps. The remaining product-shaped gaps are row count, item-to-row/column adjacency, and prompt/text loop summaries; those should keep coming from real demos before we add more language.

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

A layered fact model is better than one giant solver encoding. This is mostly internal, but it should be visible through `infer`, audits, and report provenance. The interpreter cutover note is [research/abstract-interpreter.md](./research/abstract-interpreter.md).

- scalar refinements: intervals, small finite sets, small linear facts, symbolic equality, modulo/congruence facts
- object/path facts: `Field(row, "top")`, `Path(rows, i, "height")`
- sequence facts: `Len(rows)`, `Elem(rows, i)`, append histories, source maps
- views: spans, ranges, rects, logical rects
- layout constraints: `Nondecreasing`, `Spaced`, `Inside`, `Partitions`, `SameSource`
- loop summaries: cursor recurrences and append summaries
- optional backend obligations: SMT later, only where earned

The important boundary is: source readers emit reusable facts, contract comments become explicit obligations, and checks query the fact inventory. For example, a cursor loop should first emit facts like:

```txt
rows.length == items.length
rows[].bottom == rows[].top + rows[].height
rows[$i + 1].top >= rows[$i].bottom + gap
nondecreasing(rows.top)
spaced(rows, gap)
```

Then public checks, atoms, `infer`, and report wording all consume the same fact inventory. `src/facts.ts` now owns the typed inferred fact output, and `src/sequence-facts.ts` owns adjacent sequence relation queries. Object-array and parallel-array code should converge here when they prove the same layout relation.

`semantic-snapshots.expected.txt` is the tiny guard for this internal layer. It should stay small: obligation boundary, structured goal, named proof step, and facts used. Bigger user-facing output still belongs in normal negative/report snapshots.

Named facts should have both a human lowering and a proof rule. E.g. `spaced(rows, gap)` means adjacent starts differ by previous size plus `gap`, but the proof rule can come from a recognized cursor loop.

Comparison proof rules should stay modest: a rule matches one goal, asks for ordinary obligations, and uses the same obligations for proving and report text. Proof traces should name the winning or blocking rule instead of flattening everything into `numeric.comparison`. Examples:

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

Before adding a stronger backend, simplify proof goals into smaller proof goals where the rewrite is sound. E.g. `ceil(width / 2) <= outer` can become `width / 2 <= outer` when `outer` is proven integer. Rounding should be handled as a family, not one function at a time: `floor(x) <= x < floor(x) + 1`, `ceil(x) - 1 < x <= ceil(x)`, `x - 0.5 <= round(x) <= x + 0.5`, non-strict monotonicity for the supported rounding calls, and sign-gated `trunc` bounds. `trunc` is not a disguised `floor` unless the sign is known. A simplification that cannot prove its smaller goal must not block a later stronger rule; backend dispatch should accept any passing rule, then keep the first useful blocked rule only for the final diagnostic.

## Module Boundaries

Imports should find contracts, not turn Freerange into a second TypeScript compiler. The first useful rule is:

- same-file helpers may still be read from source
- cross-file calls use exported `@fit` contracts as summaries
- imported helper contracts must be proved from source in the same run before callers can use them
- imported bodies are not inlined at the call site

The resolver asks TypeScript for the final declaration behind an import when that declaration lives in local source. That is enough for relative helpers, `.tsx` helpers, `tsconfig` path aliases, source barrels, and built workspace packages with declaration maps. It is not a reason to trust arbitrary package exports, declaration-only summaries, stale summaries, mutable helper bindings, or workspace caches.

TypeScript shape comparison is not a helper contract. It is okay for TS to say "this return value has `.rows.length`" or "this generic `Box<T>` has `.value`." It is not okay for TS type shape itself to prove `rows[].height: 0..40`, `spaced(rows, gap)`, or an imported helper's numeric postcondition. Source-backed type-field comments may prove field ranges across local imports, but the contract still comes from Freerange comments in source.

We tried automatic inferred return exports in branch `codex/implicit-return-summaries-experiment` (`ff3626e`). The shape was conceptually nice: prove a helper once, infer small returned-return facts, then export those facts at call sites. In practice it grew a real subsystem: summary caching, public-expression filtering, return-expression rebasing, provenance, and boundary assumptions. The demo audit did not show enough line-count win. The lines it might delete were mostly the useful public contracts we still want humans and agents to read, such as `clamp: return >= min`, `gridImageSizeX: return <= naturalSizeX`, and prompt visible-sizing caps. At the time, pruning only the obvious `>= 0` lines dropped checked demo contracts from 125 to 113; the current sibling-demo gate is leaner for other reasons. Keep `infer` as an adoption tool for now, not a caller-visible summary API. Revisit only if multiple real demos show repeated helper contracts that are clearly noise rather than red-line documentation.

Structural equality should stay small too. Proving `return.rows == input.rows` because both sides are the same source expression is useful. Recursive object/array equality is a different feature and should wait for a real need.

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
- unsupported

Unsupported source reports should include the source line when the interpreter knows the node. That line is where proof stopped, not necessarily where the human-written `@fit` claim lives. If a missing root makes later property, element, or assignment reads fall apart, report the missing root once and keep the next distinct blocker. A short unsupported list is easier to act on than a trace of every failed child expression.

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
- Split intervals by layout region. Column bands, line-left / line-interior / line-right regions, and branch-local facts were clearer than one giant interval.
- Preserve remembered expressions when possible. Keeping an expression around after a clear `Math.min` / `Math.max` winner helped prove center-line and aspect-ratio facts without a heavier solver.
- Read source by default. Use summaries only for genuinely opaque helper boundaries, and make the report say which helper was assumed.
- Use mutation/red probes as research signals. They are good for finding holes in the proof surface, but they should not become verifier guarantees.
- `life-calendar` was a useful hard numeric example: `**`, `Math.sqrt`, `Math.ceil`, integer facts after `ceil(life / countX)`, and half-open grid hit testing.
- Bad `given` lines are not harmless. Reject small linear contradictions before proof, including chained comparisons and obvious range/comparison chains, so the rest of the checker never gets to prove from an empty input set.

## Did Not Earn Itself

- Hard-coding app helper names into the analyzer.
- Rewriting app code into checker-shaped helpers like `add(...)` / `sub(...)`.
- Public lambdas, `forall`, arbitrary folds, aliases, or prose as truth.
- Giant unsplit intervals.
- Pulling in every demo at once before a second shape was actually understood.
- SMT, octagons, or polyhedra up front. Let a real layout law earn them.
