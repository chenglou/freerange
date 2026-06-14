# Research Findings

Durable observations about Freerange's design. Insight per bullet — not a changelog, not a todo, not a rulebook.

## Direction

[DOCUMENTATION.md](./DOCUMENTATION.md) is the product position for supported contracts. New support should either fit the public surface described there or deliberately change that surface.

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
- Mutation keeps only the facts covered by the operation's written rule. `reverse()` and `sort(compare)` preserve basic array facts but discard ordering and spacing. Unsupported loop forms are rejected instead of partially interpreted.

## `Infinity` Is A Real Bound

Use `Infinity` for physically unbounded values: scroll offsets, cumulative layout positions, generic clamp inputs. Finite upper bounds should reflect a real product fact, caller promise, or code cap — not "I want the proof to pass." A finite cap that only exists to satisfy the checker is debt; the better end state is a relational fact (`index < items.length`, `width <= maxWidth`, `top == previous bottom + gap`) or an actual cap in the code.

## TypeScript Owns Syntax And Identity; Freerange Owns Meaning

TypeScript handles normal code diagnostics, project file resolution, and module identity. Freerange handles intervals, helper contracts, sequence summaries, and reports. The split keeps Freerange from re-implementing TS.

`@fit` lines follow the same split. Freerange lowers the written contract to a small TypeScript check first: `given input.width: 0..10` reads `input.width` as a number, `items[].height` reads one array item, and `return: {width: 0..10}` uses TypeScript's object/type syntax around the numeric leaf. If TypeScript rejects that lowered code, Freerange reports the contract as unknown and does not use it as an assumption or proof.

That contract check needs its own TypeScript program, separate from the one whose checker answers Freerange's analysis queries, and the separation is load-bearing rather than accidental. TypeScript only assigns types to nodes it parsed and bound into a program — a node built with `ts.factory` returns the error type, because binding (which attaches symbols, scopes, and flow) happens during parse and never runs on a synthesized node. So a contract can only be checked by splicing it into the file as text and re-parsing, which shifts every later position, gives all-new node objects, and can perturb inferred types (a `satisfies`-wrapped return can widen `1 | 0` to `number`). Freerange's own analysis needs the opposite: the user's code as written, with original positions for reports and `.getText()`, original node identity for the statement-keyed spec indexes, and unperturbed inferred types. Two different source texts, so two trees; merging them would force reverse position mapping, re-keying, and inference-perturbation tolerance for a few percent of runtime. The cheap win is to keep the two programs but share the expensive artifact between them: the contract program reuses the project program's already-parsed, already-bound SourceFiles (lib.d.ts dominates) under the exact options they were bound by, so only the spliced twins are fresh. Safe because bind state is written once onto the SourceFile and checker state is per-program.

## Contracts Have One Preparation Point

Parse comments and classify their placement on the original TypeScript tree. Then, once the full program is available, expand type contracts, collect variable/return type boundaries, run the contract TypeScript check, and build the lists and node indexes the checker consumes. A rejected written contract is removed by exact object identity. A contract inherited from a type keeps one shared `{sourceId, pos}` object from the type declaration to every instantiated use, so rejection never depends on line/text string keys.

The prepared function data separates assumptions from proofs, keeps accepted local/return/property claims on their original nodes, and partitions loop-local claims from invalid loop `return` claims once. It also records the few static decisions used by orchestration: whether the function has an annotation surface, needs body evaluation, records helper calls, or has call preconditions. Evaluation and proof results stay out. An object-property template is prepared once, but its actual `return.tile.width` path is still instantiated when the object executes because only then is that path known.

Top-level executable code uses the same prepared body data as functions. Annotation checking continues across unrelated unsupported top-level statements so one browser-only statement cannot hide a later typed value or loop contract.

## Helper Aliasing Lives At The Boundary

Resolve helper bindings at the call site and rebase parameter names to caller-side expressions there. Don't carry alias logic into every proof rule. Reports get to say `cols - w >= 0`, not a private helper parameter name.

Function and variable identity comes from TypeScript bindings, not identifier text. Keep symbols while tracking reads, writes, and aliases; keep one body-bearing implementation-node family while caching or composing a function's effects. A resolved function carries its source program with that implementation, including when it is passed as a callback; effect and purity analysis accept that pair as one reference and cache by both parts. Import provenance stays separate because it belongs to the caller-facing route. Convert identities back to source names only for reports and interpreter root invalidation. If a function-scoped value cannot be resolved to a body, report it as unknown rather than matching a same-named top-level function.

## Calls Have One Preparation Point

Evaluate the receiver and written arguments once, from left to right, then bind defaults in parameter order. The finalized entry environment is the semantic source of truth, including when a later default mutates an earlier identifier or destructured binding. Contract checking localizes those final bindings instead of projecting them again from argument values. Caller source text and the final bound leaves stay separate as report provenance. This keeps runtime order, body analysis, precondition checks, summaries, and report text on one call result without forcing them to share one representation.

## Purity Has One Effect Description

A source-backed free function has one effect description: outside reads, receiver and argument mutation, retained arguments, callback effects, environment observation, and calls whose behavior is unavailable. Direct calls, imports, callbacks, contract helper calls, expression rechecking, and loop bounds consume that description instead of maintaining smaller local definitions of pure.

Platform calls use one table with the same information. Callback entries name the callback argument, what each callback parameter can reach, and the `thisArg`. Mutation and retention entries name the receiver or exact argument positions. The interpreter may know more about a supported result, such as the length of `items.map(...)`, but it still gets call effects from this table.

Unknown behavior is a supported outcome, not a request for another recognizer. Class member calls and user construction are unknown even when source is visible because runtime dispatch, base constructors, and field initializers are larger than one selected body. Function-scoped function values are unknown until their callable identity is represented. Platform operations with hidden iteration, property reads, conversion, or default ordering stay unknown until the whole family has a written effect rule. Mutable module objects and arrays are outside state; only immutable primitive bindings are stable reads.

When a platform call is deliberately unsupported, its classification carries the explanation. Evaluation, purity checks, contract helper checks, and calls through other helpers use that same explanation. A broad TypeScript return type does not make the call supported: Freerange may preserve that type while still reporting that the call's behavior is unknown.

Expression repeatability is narrower than function purity but derives from the same descriptions. A branch condition or loop bound may be read again only when that expression has no mutation, environment observation, accessor call, or unknown call. Calls still evaluate the callable, receiver, and arguments once in JavaScript order before support is decided, so rejecting a call cannot erase effects that already happened.

## Interpreter Runs Separate State From Findings

An interpreter request supplies the starting program, environment, assumptions, stack, and optional hooks. Frames keep mutable execution state flat, but share one immutable run policy and one append-only output unless an internal analysis pass explicitly isolates them. Results return final state separately from issues, effects, and audits. Create child, imported, branch, state-case, audit, and loop frames through the same derivation helper so each one says what it copies, shares, clears, or replaces.

## Control-Flow Truth Versus Proof Truth

A failed universal comparison over case-split values does not make an `if` branch impossible. Mixed cases stay `maybe`. If two of the eight branch states satisfy `width > 0` and six don't, the branch is still reachable — proof has to handle the joined set, not declare the branch dead.

## Numeric Alternatives Follow One Branch Construct

One execution of an `if`/`else`, `switch`, or conditional expression may produce several values that must stay together. Put those values in one result, or assign them inside the same branch:

```ts
const layout = width >= 600
  ? {columns: 3, gap: 24}
  : {columns: 2, gap: 16}
```

The object fields came from one decision, so arithmetic, comparisons, helper returns, dynamic range bounds, and tuple indexing may combine only the matching alternatives. The same rule applies when one branch assigns both local variables.

Separate branch constructs do not recover that relationship from matching text:

```ts
const columns = width >= 600 ? 3 : 2
const gap = width >= 600 ? 24 : 16
```

Those are two decisions. Freerange does not assume they chose matching sides, even when the conditions are textually identical, mathematically equivalent, or use the same input. Two calls to the same helper are also separate executions. For a mapped collection, reading the same output slot twice keeps that slot's choice; reading two different slots does not assume the source items made the same choice.

Branch identity and numeric facts are separate data. A branch arm records which decision produced a value. A numeric assumption records a fact such as `width >= 600`. The false side of `width > 0` cannot generally add `width <= 0`, because `NaN` also takes the false branch.

When separate choices are combined, Freerange still uses conclusions that hold for every combination. A broad bound may pass, and a value outside every possible dynamic range may fail. If some combinations pass and others fail, the result is unknown because deciding it would require the missing relationship.

Exact alternatives have a fixed budget of eight. When a computation exceeds that budget, its overall numeric bounds remain usable, but a claim that needs the individual choices reports unknown and names the limit.

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

Reject app-specific names. Add a built-in only when the general operation and its limits are clear.

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

The per-iteration effect of each scalar must land in a small closed algebra — unchanged, `+= delta`, `min`/`max` with a candidate, or a plain rebind — with written compose and join rules. Anything outside the algebra makes that one variable unknown instead of failing the whole loop. Sequence relations come from subtracting consecutive pushed elements' linear forms (with pre-state symbols advanced by the path's delta and per-iteration names renamed apart); a relation is emitted when the residue is loop-invariant. When rounding hides the linear relation, the evaluated number keeps the binary addition tree and operand snapshots that produced it. Previous-row fields stay as named leaves, while a subtree with no previous-row field stays one loop-invariant amount. A segmented row loop can therefore connect `nextTop = bottom + gap` to the pushed `bottom` even after the height accumulator resets, without re-evaluating expression text against the later state.

Keep exact comparisons and evaluated addition trees as separate relation cases. Exact comparisons may use algebra; evaluated trees may commute immediate `+` children but may not reassociate. They support `spaced` and a zero-gap `lastEnd` when the final cursor ran the exact same operation as the final row end. They do not support subtracting a rounded gap after the loop. When two pushed fields hold the same operand snapshot, emit the true relation for each field instead of choosing one name. Both cases require the compared values to exclude `NaN`.

Array summary accumulation and branch joins have different rules. Accumulation unions compatible facts from one analyzed producer. A branch join keeps the guarantee shared by every branch, so `==` joined with `>=` keeps `>=`, matches facts by semantic identity rather than list position, joins their numeric bounds, and drops `lastEnd` or `extentEnd` when the position/size paths differ. An empty branch keeps adjacency facts because they hold vacuously, but not end facts. Any arbitrary `push`, or a later loop that starts from a non-empty array, clears the old sequence summary; a new producer earns facts only after its whole append behavior is analyzed.

Two findings worth keeping:

- Names are only safe to share when they denote one well-defined quantity for the iteration. The evaluator's fallback names coined from expression text (`max(rowHeight, h)`) break this once a mutated variable moves between two reads, so the analysis re-mints such values with fresh symbols at every binding and assignment. Same-iteration reuse through a local stays recognizable; cross-statement text coincidences cannot cancel.
- Interval narrowing needs more than one round. The widened first pass can leave a max-accumulator's floor unanchored (`max(unbounded, h)` has no lower bound), and only the next round, run against the proven hulls, anchors it. Iterate pre-state hulls to a small fixpoint, and validate each round's closed forms against the previous post-loop hull before accepting.

The standard names for the pieces: abstract interpretation fixpoints (Cousot), widening/narrowing, and scalar evolution's `{start, +, step}` recurrences derived from semantics. The relation layer over pushed sequences is a small bespoke relational domain on top.

## Floats Prove By Exactness Or Monotonicity, Never By Algebra

Program arithmetic gets its algebraic linear form only when the operation provably rounds nothing; everything else gets an opaque solver atom, keeping only its hull and whatever monotone facts survive rounding. Separately, values produced by actual source evaluation keep a small operation record with the operand values read at that moment. The operation tree is the stable identity; bounds, grid, and NaN facts can narrow later without changing which operation ran. A branch join keeps the tree only when both sides describe the same operation, then merges the operand facts instead of keeping one branch's snapshot. Immediate `+` and `*` operands may swap, but the tree never reassociates. Mutation still invalidates an affected tree, and synthetic bound calculations do not get one. The exactness family is checkable from data the values already carry: every runtime value is an integer multiple of `2^grid` (so `int` is grid 0 and `x * 0.5` lands on grid −1), and a result on the grid with magnitude at most `2^(53+grid)` is representable, so ECMA's round-of-exact-real returns it untouched. Array lengths sit in the window for free because JS caps them at `2^32 − 1`.

What survives rounding without exactness, each verified by brute force against exact rationals:

- Rounding is monotone, so `real(L) <= real(R)` carries `fl(L) <= fl(R)` for one operation per side. This recovers most float inequality proving — `y + gap >= y`, `(cols - w) >= 0` from `w <= cols` — without granting the results any algebra.
- Sign survives op by op: a positive real sum or difference of doubles is at least `2^-1074` (all doubles share that grid), which rounding cannot cross, so even strict sign carries through `+` and `-`. Products and quotients keep `>= 0` but can underflow a strict sign to zero.
- Commutativity is bitwise; reassociation is not. Expression keys may sort the two operands of `+` and `*` but never flatten across nesting.
- Equality across rounding needs the same recorded operation over the same operand snapshots, or exactness. `(x / 3) * 3 == x` has runtime counterexamples in both directions (~4% of doubles each way), and one-sided `<=`/`>=` versions are just as false.
- `%` never rounds (the exact remainder is always representable; 150k checks), and `x - x` is exactly `+0` for finite x.

Strictness through rounding is the recurring trap: two real values that differ can round to the same double, so strict conclusions need exactness, an integer gap, or a margin past the boundary. The deleted floor/ceil division rules are the canonical case — `floor(p / cell) < count` fails at ordinary layout magnitudes (cell 4.044367056305642, count 13) because the quotient rounds onto the boundary; "error below one" is no defense against a cliff.

NaN is the other axis: it fails every comparison, so any trusted or observed fact about a value certifies it non-NaN, while a fully unconstrained value proves nothing reflexive (`x == x` included). The same certificate logic decides when a counterexample vertex is a real witness: only variables pinned by givens or checked contracts anchor a disproof; a derived hull over-approximates its correlations.

NaN is also manufactured from clean operands: `Infinity - Infinity`, `0 * Infinity`, `Infinity / Infinity`, and `Infinity % d` are NaN, and `0..Infinity` givens keep Infinity in-domain. The domain's NaN exclusion works through one invariant: a NaN-capable result must present a fully unbounded hull. Sums and differences widen that way naturally; multiplication, division, and modulo had to widen explicitly because their corner filtering hid the NaN case. Conclusions about a rounded result then check the operands, not just the result's hull — a hull side is only reachable at infinity when no trusted fact pins a finite constant bound there, so `given x <= 1000` rules +Infinity out even while the hull stays open below.

The converse direction needs its own bit: overflow-capable is not NaN-capable. A finite value divided by 0.998 reaches ±Infinity, so its hull is honestly fully unbounded, yet no input makes it NaN — and an echo claim (`return == pos + velocity / 0.998`) is true even at the overflow, because `Infinity == Infinity` holds while `NaN == NaN` does not. The op that proved its operands avoid the indeterminate forms records that (`neverNaN`); any reconstruction of the value drops the bit, and a hull-containment check must refuse to let a NaN-excluding value stand in for one that admits it. One-sided finiteness is not enough: with only `given x < Infinity`, `x - x` still reaches `-Infinity - -Infinity` = NaN.

Finiteness is expressible without new syntax: over doubles, `x < Infinity` is exactly `x <= Number.MAX_VALUE`, so strict bounds against ±Infinity desugar to inclusive ±MAX_VALUE — as facts and as hull endpoints. The same rule applies to exclusive range endpoints (`0..<Infinity`, including `int` ranges, where the floor/ceil adjustment must not run on the infinite endpoint: `ceil(Infinity) - 1` is still Infinity), and to constant-bound comparison givens, which narrow the bounded side's hull like range givens do — a true comparison excludes NaN on both sides.

The range family completes by mirroring the existing glyph: `a<..b` and `a<..<b` read as the comparison chain they mean (`0<..10` is 0 < x <= 10), so `-Infinity<..<Infinity` is one-line finiteness. Two parse facts make the spelling safe: no valid TS expression ends with `<` (relational and shift operators need a right operand, generic argument lists close with `>`), so a `<` glued to `..` is always the marker; and the range delimiter must be exactly two dots — checking only the match position lets `0...10` split as `0.` + `10` and silently mean `0..10`, so reject dot runs on both sides. A union's envelope is a conjunctive fact (at least the smallest case lower, at most the largest case upper), but strictness at a tied extremum follows the inclusive case: an endpoint admitted by any one case is admitted by the union.
