# Research Findings

Durable observations about Freerange's design. Insight per bullet — not a changelog, not a todo, not a rulebook.

## Direction

The system is split into three named regions and the page that lists them — `VOCABULARY.md` — is the product position. Core: linear scalar arithmetic, universal claims over adjacent array pairs, per-element claims, boolean composition. Catalog: named decidables with documented rules (`Math.*`, sequence shorthand, layout primitives). Outside: arbitrary-pair quantifier, polynomial inequalities, transcendental shape claims, set-of-set claims. Anything that wanders out of this split is either a bug against the page or a candidate to redraw the page deliberately. The page is the stopping condition for "are we done with this round."

The public surface is a small layout catalog over ordinary TS values. Users name layout shapes; they shouldn't write traversals. The catalog reads:

```ts
given width: 0..1000
rows.length == items.length
rows[].height: 0..40
rows[].top + rows[].height <= parent.bottom
nondecreasing(rows.top)
spaced(rows, gap)
extentEnd(rows, top) == bottom
```

Not:

```ts
forall adjacent(rows, (prev, next) => next.top == prev.top + prev.height + gap)
sum(rows.map(row => row.height + gap))
```

The product is `infer` + `check` + reports: a way for humans and agents to find the static red lines in normal TypeScript and keep them honest. The checker stays boring; a spec compiler or agent can sit on top later.

## Total Versus Partial Built-Ins

`lastEnd(rows)` is useful but partial — it needs `rows.length > 0`. The total form catches the empty-row bug for free:

```ts
extentEnd(rows, top) == bottom
```

So the natural ordinary loop:

```ts
let y = top
for (const item of items) {
  rows.push({top: y, height: item.height})
  y += item.height + gap
}
return {rows, bottom: y - gap}
```

is wrong when `items` is empty and `gap > 0`. The fix is `bottom: rows.length === 0 ? top : y - gap`. Built-ins should default to total forms; partial ones need a stated precondition.

## Views Map Fields, Not Layouts

Views are the right shape for keeping the catalog field-name-independent:

```ts
view rows as spans(start: .top, size: .height)
view child as rect(x: .x, y: .y, width: .w, height: .h)
view fragments as ranges(start: .textStart, end: .textEnd)
```

A view should only map fields, not assert layout properties. Once views exist, current built-ins generalize cleanly:

```ts
nondecreasing(rows.start)
spaced(rows, gap)
extentEnd(rows, top) == bottom
inside(child, parent)
partitions(fragments, textRange)
```

Add views when rows/columns/text/rects create real field-name pressure, not to make one loop prettier.

## Source Reading Beats More Comments

A checker that understands locals, loops, arrays, object literals, `?.`, `??`, and small `Math.*` calls buys more than proof-shaped runtime helpers. The useful inference categories:

- TS shapes first, written shape only when TS declines. The checker can read structural shape across imported aliases, utility types, generic instantiations, property-access calls, and helper returns — but TS shape never gives numeric ranges, sequence relations, or proof goals.
- Type-field `@fit` comments are the exception: they are Freerange source walked through TS.
- Ambient JS/DOM facts are a separate small table. `document.documentElement.clientWidth >= 0` is platform knowledge, not a TS shape fact. Keep narrow: scroll offsets stay signed because of RTL, overscroll, rubber-banding.
- Inline `// @fit` is placement-sensitive on purpose. On params it's an input assumption; on locals and fields it's a check. Same syntax, opposite jobs, by position.
- `items.map(...)` preserves length, item field domains, and a same-index origin. `items.filter(...)` keeps source item domain, length no larger than source, true-side item facts, and an order-preserving subset origin. Source readers emit these as reusable facts.
- `throw` guards are normal control flow. Post-guard code inherits the surviving path's facts. This is the boring source answer for positive-step and validated-input helpers.
- Append-only loops infer length, scalar-array element shape, cursor recurrence, `spaced`, `nondecreasing`, and per-item field ranges.
- Conditional push proves `rows.length <= items.length`, not equal length. Source order can come when a fact needs it.
- Mutation (`sort`, `reverse`, `splice`, indexed assignment) kills sequence facts unless summarized. Unsupported loop bodies are still useful when they only touch roots Freerange can forget.

## `Infinity` Is A Real Bound

Use `Infinity` for physically unbounded values: scroll offsets, cumulative layout positions, generic clamp inputs. Finite upper bounds should reflect a real product fact, caller promise, or code cap — not "I want the proof to pass." A finite cap that only exists to satisfy the checker is debt; the better end state is a relational fact (`index < items.length`, `width <= maxWidth`, `top == previous bottom + gap`) or an actual cap in the code.

## TypeScript Owns Syntax And Identity; Freerange Owns Meaning

TypeScript handles normal code diagnostics, project file resolution, and module identity. Freerange handles intervals, helper contracts, sequence summaries, and reports. The split keeps Freerange from re-implementing TS.

`@fit` lines follow the same split. Freerange lowers the written contract to a small TypeScript check first: `given input.width: 0..10` reads `input.width` as a number, `items[].height` reads one array item, and `return: {width: 0..10}` uses TypeScript's object/type syntax around the numeric leaf. If TypeScript rejects that lowered code, Freerange reports the contract as unknown and does not use it as an assumption or proof.

That contract check needs its own TypeScript program, separate from the one whose checker answers Freerange's analysis queries, and the separation is load-bearing rather than accidental. TypeScript only assigns types to nodes it parsed and bound into a program — a node built with `ts.factory` returns the error type, because binding (which attaches symbols, scopes, and flow) happens during parse and never runs on a synthesized node. So a contract can only be checked by splicing it into the file as text and re-parsing, which shifts every later position, gives all-new node objects, and can perturb inferred types (a `satisfies`-wrapped return can widen `1 | 0` to `number`). Freerange's own analysis needs the opposite: the user's code as written, with original positions for reports and `.getText()`, original node identity for the statement-keyed spec indexes, and unperturbed inferred types. Two different source texts, so two trees; merging them would force reverse position mapping, re-keying, and inference-perturbation tolerance for a few percent of runtime. The cheap win is to keep the two programs but share the expensive artifact between them: the contract program reuses the project program's already-parsed, already-bound SourceFiles (lib.d.ts dominates) under the exact options they were bound by, so only the spliced twins are fresh. Safe because bind state is written once onto the SourceFile and checker state is per-program.

## Helper Aliasing Lives At The Boundary

Resolve helper bindings at the call site and rebase parameter names to caller-side expressions there. Don't carry alias logic into every proof rule. Reports get to say `cols - w >= 0`, not a private helper parameter name.

Function and variable identity comes from TypeScript bindings, not identifier text. Keep symbols while tracking reads, writes, and aliases; keep the implementation node while caching or composing a function's effects. Convert those identities back to source names only for reports and interpreter root invalidation. If a function-scoped value cannot be resolved to a body, report it as unknown rather than matching a same-named top-level function.

## Calls Have One Preparation Point

Evaluate the receiver and written arguments once, from left to right, then bind defaults in parameter order. The execution frame keeps live object references because a later argument can mutate an earlier one. Contract checking derives its localized parameter environment from those same values instead of evaluating source expressions again. This keeps runtime order, body analysis, precondition checks, summaries, and report text on one call result without forcing them to share one representation.

## Control-Flow Truth Versus Proof Truth

A failed universal comparison over case-split values does not make an `if` branch impossible. Mixed cases stay `maybe`. If two of the eight branch states satisfy `width > 0` and six don't, the branch is still reachable — proof has to handle the joined set, not declare the branch dead.

## Tuple/Product Versus Collection

Symbolic index precision belongs to tuple/product values: typed slots, fixed length, per-slot shape. Normal arrays stay summarized collections, with element-domain facts and length facts but no per-slot precision. Annotating a value as a tuple is how the user asks for slot-level reasoning.

## Wildcard Semantics

One-sided `[]` is anonymous "for every item here":

```ts
rows[].height <= maxHeight
sections[].rows[].height <= maxHeight
```

Two-sided anonymous `[]` is ambiguous — could mean same index, all pairs, matched by source item, matched by id, or adjacent rows. So the syntax has to carry the relationship:

```ts
rows[$i].top <= boxes[$i].bottom         // same index
rows[$i].top <= rows[$i + 1].top         // adjacent over one collection
```

Einops is the taste reference: named axes make repetition meaningful. SQL is the taste reference for source/id matching — if collections match by item, fragment, or range ownership, bracket labels alone aren't enough; name the relation.

All-pairs (`children[$i].right <= blockers[$j].left`) is a future shape.

## Layered Fact Model

Better than one giant solver encoding. Source readers emit reusable facts; contract comments become explicit checks; checks query the shared store. The layers:

- scalar refinements: intervals, small finite sets, linear relations, equalities, modulo/congruence
- object/path facts: `Field(row, "top")`, `Path(rows, i, "height")`
- sequence facts: lengths, element summaries, append histories, source maps
- views: spans, ranges, rects
- layout constraints: `Nondecreasing`, `Spaced`, `Inside`, `Partitions`, `SameSource`
- loop summaries: cursor recurrences and append summaries
- optional SMT backend later, only where earned

A cursor loop emits facts like:

```txt
rows.length == items.length
rows[].bottom == rows[].top + rows[].height
rows[$i + 1].top >= rows[$i].bottom + gap
nondecreasing(rows.top)
spaced(rows, gap)
```

Then public checks, built-ins, `infer`, and report wording all consume the same store. Object-array and parallel-array code should converge here when they prove the same layout relation.

## Forgetting A Root Means Forgetting It In Every Store

A fact about a path lives in more than one place: the env value, the symbolic identity a snapshot carries (its linear form and expression text), and standing assumptions like `given input.width: 0..10`. When a call mutates `input`, dropping only the env value is not enough — the others re-prove the stale fact. A given is a precondition true at entry, not a body-wide invariant, so a re-read of `input.width` after the mutation must not be re-narrowed by the surviving assumption; and a snapshot `const w = input.width` taken before the mutation keeps the range it copied but must lose the `input.width` identity, or a later read cancels against it (`w - input.width` folding to a proved 0, `w == input.width` matching by text). So havocing a root resets its value, drops every assumption naming a path under it, and strips the symbolic linear/text identity from values read earlier — keeping their proven numeric range, dropping only the now-false tie.

## Comparison Rules Stay Modest

A rule matches one goal, asks for ordinary checks, and uses the same checks for proving and report text. Traces name the winning or blocking rule, not a flattened `numeric.comparison`. Examples:

```txt
goal: content * scale <= available * scale
known: content <= available
missing: scale >= 0

goal: floor(pointer / cellSize) < count
known: cellSize > 0
missing: pointer < count * cellSize
```

Before adding a stronger backend, simplify into smaller goals when the rewrite is sound. `ceil(width / 2) <= outer` becomes `width / 2 <= outer` when `outer` is proven integer. Handle rounding as a family — `floor(x) <= x < floor(x) + 1`, `ceil(x) - 1 < x <= ceil(x)`, `x - 0.5 <= round(x) <= x + 0.5`, non-strict monotonicity for the supported rounding calls, sign-gated `trunc` — not one function at a time.

## Imports Find Contracts

Same-file helpers can be read from source. Cross-file calls use exported `@fit` contracts as summaries. Imported contracts must be proved in the same run before callers use them. Imported bodies are never inlined.

TS shape is not a helper contract. It can say "this return has `.rows.length`"; it cannot prove `rows[].height: 0..40`. Source-backed type-field comments are the one exception: those are Freerange contracts that happen to live on TS types.

## Reports Carry Origin

Each fact in a report names where it came from:

- inferred from code
- inferred from branch
- assumed input `given`
- assumed loop-local `given`
- checked same-file helper contract
- checked imported contract
- unsupported

Missing facts name the small obligation, not a whole product. If the code has `content * scale <= available * scale` and `content <= available` is known, the report says `missing: scale >= 0`, not a restatement of the product comparison.

If a missing root makes later property, element, or assignment reads fall apart, report the missing root once and keep the next distinct blocker. A short unsupported list is easier to act on than every failed child expression.

Inconsistent assumptions need vacuity warnings — bad `given` lines should not make everything look proved.

## Built-In Admission Criteria

Before adding a built-in like `spaced` or `inside`:

- UI-independent name
- field-name-independent view, if shape-based
- written semantic lowering
- "does not imply" section
- positive pattern
- negative pattern
- report template
- at least three non-demo use cases

`spaced`, `inside`, `partitions`, `sourceOrder`, `sameSource` are promising. `goodRows`, `chatLayout`, and app-specific names are not.

## Intrinsic Versus Extrinsic

Stable value guarantees belong in representation; phase-local or algorithm-shaped guarantees belong in checked producers. Note: [research/intrinsic-extrinsic-verification.md](./research/intrinsic-extrinsic-verification.md). The frame matters because it explains why Freerange can give agents final contracts without forcing every intermediate construction through a narrow API.

## Prior Art Worth Stealing From

- Refinement / liquid types — small decidable predicates close to code, checked statically.
- Dafny — clear assume/assert split and useful failed-check diagnostics.
- Constraint programming global constraints — named constraints with solver-owned decompositions.
- CSS logical vocabulary — start/end, inline/block, main/cross over physical-only names.
- Spreadsheets — dependency chains humans can read.
- SQL checks — named local constraints, clear failure labels.
- SystemVerilog assertions — `assume` / `assert` / future `cover`, not the syntax.
- SMT / Alloy — backend and counterexample inspiration, not public syntax.

## Loop Analysis Is A Transfer Function, Not A Recognizer Catalog

The loop analysis evaluates the body once per control-flow path on a generalized iteration: every variable the body writes starts as an unbounded pre-state symbol. Any bound the evaluator derives from that state holds at every iteration, which kills the first-iteration-snapshot bug class outright (a claim like `const snapshot = y // @fit 0..0` inside a body used to pass against iteration one's env; it is now disproven with a counterexample).

The per-iteration effect of each scalar must land in a small closed algebra — unchanged, `+= delta`, `min`/`max` with a candidate, or a plain rebind — with written compose and join rules. Anything outside the algebra makes that one variable unknown instead of failing the whole loop. Sequence relations come from subtracting consecutive pushed elements' linear forms (with pre-state symbols advanced by the path's delta and per-iteration names renamed apart); a relation is emitted when the residue is loop-invariant. No source-text matching anywhere in the pipeline.

Two findings worth keeping:

- Names are only safe to share when they denote one well-defined quantity for the iteration. The evaluator's fallback names coined from expression text (`max(rowHeight, h)`) break this once a mutated variable moves between two reads, so the analysis re-mints such values with fresh symbols at every binding and assignment. Same-iteration reuse through a local stays recognizable; cross-statement text coincidences cannot cancel.
- Interval narrowing needs more than one round. The widened first pass can leave a max-accumulator's floor unanchored (`max(unbounded, h)` has no lower bound), and only the next round, run against the proven hulls, anchors it. Iterate pre-state hulls to a small fixpoint, and validate each round's closed forms against the previous post-loop hull before accepting.

The standard names for the pieces: abstract interpretation fixpoints (Cousot), widening/narrowing, and scalar evolution's `{start, +, step}` recurrences derived from semantics. The relation layer over pushed sequences is a small bespoke relational domain on top.

## Floats Prove By Exactness Or Monotonicity, Never By Algebra

Program arithmetic gets its algebraic linear form only when the operation provably rounds nothing; everything else becomes one opaque atom named by its computation, keeping only its hull and whatever monotone facts survive rounding. The exactness family is checkable from data the values already carry: every runtime value is an integer multiple of `2^grid` (so `int` is grid 0 and `x * 0.5` lands on grid −1), and a result on the grid with magnitude at most `2^(53+grid)` is representable, so ECMA's round-of-exact-real returns it untouched. Array lengths sit in the window for free because JS caps them at `2^32 − 1`.

What survives rounding without exactness, each verified by brute force against exact rationals:

- Rounding is monotone, so `real(L) <= real(R)` carries `fl(L) <= fl(R)` for one operation per side. This recovers most float inequality proving — `y + gap >= y`, `(cols - w) >= 0` from `w <= cols` — without granting the results any algebra.
- Sign survives op by op: a positive real sum or difference of doubles is at least `2^-1074` (all doubles share that grid), which rounding cannot cross, so even strict sign carries through `+` and `-`. Products and quotients keep `>= 0` but can underflow a strict sign to zero.
- Commutativity is bitwise; reassociation is not. Expression keys may sort the two operands of `+` and `*` but never flatten across nesting.
- Equality across rounding needs identical computation (same atom) or exactness. `(x / 3) * 3 == x` has runtime counterexamples in both directions (~4% of doubles each way), and one-sided `<=`/`>=` versions are just as false.
- `%` never rounds (the exact remainder is always representable; 150k checks), and `x - x` is exactly `+0` for finite x.

Strictness through rounding is the recurring trap: two real values that differ can round to the same double, so strict conclusions need exactness, an integer gap, or a margin past the boundary. The deleted floor/ceil division rules are the canonical case — `floor(p / cell) < count` fails at ordinary layout magnitudes (cell 4.044367056305642, count 13) because the quotient rounds onto the boundary; "error below one" is no defense against a cliff.

NaN is the other axis: it fails every comparison, so any trusted or observed fact about a value certifies it non-NaN, while a fully unconstrained value proves nothing reflexive (`x == x` included). The same certificate logic decides when a counterexample vertex is a real witness: only variables pinned by givens or checked contracts anchor a disproof; a derived hull over-approximates its correlations.

NaN is also manufactured from clean operands: `Infinity - Infinity`, `0 * Infinity`, `Infinity / Infinity`, and `Infinity % d` are NaN, and `0..Infinity` givens keep Infinity in-domain. The domain's NaN exclusion works through one invariant: a NaN-capable result must present a fully unbounded hull. Sums and differences widen that way naturally; multiplication, division, and modulo had to widen explicitly because their corner filtering hid the NaN case. Conclusions about a rounded result then check the operands, not just the result's hull — a hull side is only reachable at infinity when no trusted fact pins a finite constant bound there, so `given x <= 1000` rules +Infinity out even while the hull stays open below.

The converse direction needs its own bit: overflow-capable is not NaN-capable. A finite value divided by 0.998 reaches ±Infinity, so its hull is honestly fully unbounded, yet no input makes it NaN — and an echo claim (`return == pos + velocity / 0.998`) is true even at the overflow, because `Infinity == Infinity` holds while `NaN == NaN` does not. The op that proved its operands avoid the indeterminate forms records that (`neverNaN`); any reconstruction of the value drops the bit, and a hull-containment check must refuse to let a NaN-excluding value stand in for one that admits it. One-sided finiteness is not enough: with only `given x < Infinity`, `x - x` still reaches `-Infinity - -Infinity` = NaN.

Finiteness is expressible without new syntax: over doubles, `x < Infinity` is exactly `x <= Number.MAX_VALUE`, so strict bounds against ±Infinity desugar to inclusive ±MAX_VALUE — as facts and as hull endpoints. The same rule applies to exclusive range endpoints (`0..<Infinity`, including `int` ranges, where the floor/ceil adjustment must not run on the infinite endpoint: `ceil(Infinity) - 1` is still Infinity), and to constant-bound comparison givens, which narrow the bounded side's hull like range givens do — a true comparison excludes NaN on both sides.

The range family completes by mirroring the existing glyph: `a<..b` and `a<..<b` read as the comparison chain they mean (`0<..10` is 0 < x <= 10), so `-Infinity<..<Infinity` is one-line finiteness. Two parse facts make the spelling safe: no valid TS expression ends with `<` (relational and shift operators need a right operand, generic argument lists close with `>`), so a `<` glued to `..` is always the marker; and the range delimiter must be exactly two dots — checking only the match position lets `0...10` split as `0.` + `10` and silently mean `0..10`, so reject dot runs on both sides. A union's envelope is a conjunctive fact (at least the smallest case lower, at most the largest case upper), but strictness at a tied extremum follows the inclusive case: an endpoint admitted by any one case is admitted by the union.
