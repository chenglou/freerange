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

The product is `infer` + `check` + reports: a way for humans and agents to see which constraints normal TypeScript code proves or violates. A spec compiler or agent can use those commands later without changing the checker.

## Total Versus Partial Built-Ins

`lastEnd(rows)` is useful but partial — it needs `rows.length > 0`. The total form also catches the empty-row bug:

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

Views can keep the catalog independent of field names:

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

Add views when several real cases need different field names, not to make one loop prettier.

## Source Reading Beats More Comments

A checker that understands locals, loops, arrays, object literals, `?.`, `??`, and small `Math.*` calls is more useful than requiring extra runtime helpers. The important rules are:

- Use TypeScript shapes first and written shapes only when TypeScript cannot answer. TypeScript supplies structural types and exact numeric literal types, but not general numeric ranges, sequence relations, or proof goals.
- Type-field `@fit` comments are the exception: they are Freerange contracts checked through TypeScript.
- Ambient JS/DOM facts are a separate small table. `document.documentElement.clientWidth >= 0` is platform knowledge, not a TS shape fact. Keep narrow: scroll offsets stay signed because of RTL, overscroll, rubber-banding.
- Inline `// @fit` is placement-sensitive on purpose. On params it's an input assumption; on locals and fields it's a check. Same syntax, opposite jobs, by position.
- `throw` guards are normal control flow. Code after the guard uses what is true on the surviving path, which supports positive-step and validated-input helpers.
- Append-only loops infer length, scalar-array element shape, cursor recurrence, `spaced`, `nondecreasing`, and per-item field ranges.
- Conditional push proves `rows.length <= items.length`, not equal length.
- Mutation keeps only what the operation guarantees. Unsupported loop forms are rejected instead of partially interpreted.

## Use `Infinity` When No Finite Bound Exists

Use `Infinity` for values with no real finite bound: scroll offsets, cumulative layout positions, and generic clamp inputs. A finite upper bound should come from the product, a caller contract, or a cap in the code — not from wanting a proof to pass. Otherwise, use the real comparison, e.g. `index < items.length`, `width <= maxWidth`, or `top == previous bottom + gap`.

## Let TypeScript Handle Syntax And Identity

TypeScript handles normal code diagnostics, project file resolution, and module identity. Freerange handles intervals, helper contracts, sequence summaries, and reports. The split keeps Freerange from re-implementing TS.

Contract type-checking needs its own TypeScript program, separate from the one whose checker answers Freerange's analysis queries. TypeScript only assigns useful types to nodes that belong to a SourceFile tree bound into a program. A standalone node built with `ts.factory` has no source positions, parents, or binding context and returns the error type. Freerange therefore checks a contract by splicing it into the file as text and parsing again. That shifts every later position, creates new node objects, and can change inferred types; for example, a `satisfies`-wrapped return can widen `1 | 0` to `number`.

Freerange's analysis needs the user's code as written: original positions for reports and `.getText()`, original node identity for statement-keyed contract indexes, and unchanged inferred types. The two source texts therefore need separate trees. Keep the two programs, but let the contract program reuse the project program's parsed and bound SourceFiles. Reuse is safe because binding state lives on each SourceFile, while each program keeps its own checker state. Only the files containing spliced contracts need a second parse.

## Contracts Have One Preparation Point

Parse comments and classify their placement on the original TypeScript tree. Then, once the full program is available, expand type contracts, collect variable/return type boundaries, run the contract TypeScript check, and build the lists and node indexes the checker consumes. A rejected written contract is removed by exact object identity. A contract inherited from a type keeps one shared `{sourceId, pos}` object from the type declaration to every instantiated use, so rejection never depends on line/text string keys.

The prepared function data separates assumptions from proofs, keeps accepted local/return/property claims on their original nodes, and partitions loop-local claims from invalid loop `return` claims once. It also records the few static decisions used by orchestration: whether the function has an annotation surface, needs body evaluation, records helper calls, or has call preconditions. Evaluation and proof results stay out. An object-property template is prepared once, but its actual `return.tile.width` path is still instantiated when the object executes because only then is that path known.

Top-level executable code uses the same prepared body data as functions. Annotation checking continues across unrelated unsupported top-level statements so one browser-only statement cannot hide a later typed value or loop contract.

## Resolve Helper Aliases At The Call Site

Resolve helper bindings at the call site and rebase parameter names to caller-side expressions there. Don't carry alias logic into every proof rule. Reports get to say `cols - w >= 0`, not a private helper parameter name.

Function and variable identities come from TypeScript bindings, not identifier text. Keep symbols while tracking reads, writes, and aliases. Keep one set of implementation nodes that have bodies when caching or composing a function's effects. A resolved function carries the TypeScript program that contains it, including when it is passed as a callback; effect and purity analysis use the function and program together as one reference. Keep import provenance separate because it describes the import path used by the caller. Convert identities back to source names only for reports and interpreter root invalidation. If a function-scoped value cannot be resolved to a body, report it as unknown rather than matching a same-named top-level function.

## Calls Have One Preparation Point

Evaluate the receiver and written arguments once, from left to right, then bind defaults in parameter order. Use the resulting parameter values for body analysis and contract checking, including when a later default mutates an earlier identifier or destructured binding. Do not derive those values again from the written arguments. Keep the caller's source text separately so reports can still show the original call. This lets runtime order, body analysis, precondition checks, summaries, and report text use one call result without requiring one representation for all of them.

## Purity Has One Effect Description

Describe a free function's effects once: outside reads, receiver and argument mutation, retained arguments, callback effects, environment observation, and calls whose behavior is unavailable. Direct calls, imports, callbacks, contract helper calls, expression rechecking, and loop bounds all use that description.

Platform calls use one table with the same information. Callback entries name the callback argument, what each callback parameter can reach, and the `thisArg`. Mutation and retention entries name the receiver or exact argument positions. The interpreter may know more about a supported result, such as the length of `items.map(...)`, but it still gets call effects from this table.

Report behavior as unknown instead of adding another partial recognizer. Class member calls and user construction are unknown even when source is visible because runtime dispatch, base constructors, and field initializers involve more than one selected body. Function-scoped function values are unknown until their callable identity is represented. Platform operations with hidden iteration, property reads, conversion, or default ordering stay unknown until the operation has a complete effect rule. Mutable module objects and arrays are outside state; only immutable primitive bindings are stable reads.

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

## Wildcard Semantics

One-sided `[]` is anonymous "for every item here":

```ts
rows[].height <= maxHeight
sections[].rows[].height <= maxHeight
```

Two-sided anonymous `[]` across different collections is ambiguous — it could mean same index, all pairs, matched by source item, or matched by id. The syntax has to say which one:

```ts
rows[$i].top <= boxes[$i].bottom         // same index
rows[$i].top <= rows[$i + 1].top         // adjacent over one collection
```

Einops shows how named axes make repetition meaningful. SQL shows why source or id matching needs a named relation: bracket labels alone are not enough when collections match by item, fragment, or range ownership.

All-pairs (`children[$i].right <= blockers[$j].left`) is a future shape.

## Keep Values, Assumptions, And Reports Separate

Evaluation produces abstract values and sequence information. Checks use those values with assumptions; `infer` turns them into the ranges and relationships shown in reports. Array values keep sequence information such as lengths, element ranges, source mappings, adjacent relations, and end values together. Do not flatten these jobs into one solver input. Add views or a stronger solver only when concrete cases need them.

## Forgetting A Root Means Forgetting It In Every Store

A fact about a path lives in more than one place: the env value, the symbolic identity a snapshot carries (its linear form and expression text), and standing assumptions like `given input.width: 0..10`. When a call mutates `input`, dropping only the env value is not enough — the others re-prove the stale fact. A given is a precondition true at entry, not a body-wide invariant, so a re-read of `input.width` after the mutation must not be re-narrowed by the surviving assumption; and a snapshot `const w = input.width` taken before the mutation keeps the range it copied but must lose the `input.width` identity, or a later read cancels against it (`w - input.width` folding to a proved 0, `w == input.width` matching by text). Forgetting a root therefore resets its value, drops every assumption naming a path under it, and strips the symbolic linear/text identity from values read earlier — keeping their proven numeric range, but dropping the now-false tie.

## Comparison Rules Stay Modest

A rule matches one goal, asks for ordinary checks, and uses the same checks for proving and report text. Traces name the rule that proved the goal or blocked proof, not a flattened `numeric.comparison`. Examples:

```txt
goal: content * scale <= available * scale
known: content <= available
missing: scale >= 0
```

Before adding a stronger backend, simplify into smaller goals when the rewrite is sound. `ceil(width / 2) <= outer` becomes `width / 2 <= outer` when `outer` is proven integer. Handle rounding as a family — `floor(x) <= x < floor(x) + 1`, `ceil(x) - 1 < x <= ceil(x)`, `x - 0.5 <= round(x) <= x + 0.5`, non-strict monotonicity for the supported rounding calls, sign-gated `trunc` — not one function at a time.

## Imports Find Contracts

Same-file helpers can be read from source. Cross-file calls use exported `@fit` contracts as summaries. Imported contracts must be proved in the same run before callers use them. Imported bodies are never inlined.

TS shape is not a helper contract. It can say "this return has `.rows.length`"; it cannot prove `rows[].height: 0..40`. Type-field comments are the one exception: those are Freerange contracts that happen to live on TS types.

## Reports Explain Their Evidence

When the source of a conclusion matters, the report should name it: code, an input contract, a branch, or a checked helper contract.

Missing information should name the small condition, not the whole expression. If the code has `content * scale <= available * scale` and `content <= available` is known, the report says `missing: scale >= 0`, not a restatement of the product comparison.

Inconsistent assumptions need vacuity warnings — bad `given` lines should not make everything look proved.

## Built-In Admission Criteria

Before adding a built-in like `spaced` or `inside`:

- UI-independent name
- field-name-independent view, if shape-based
- written semantic lowering
- "does not imply" section
- focused tests for the supported behavior and its limits
- report template
- at least three non-demo use cases

Reject app-specific names. Add a built-in only when the general operation and its limits are clear.

## Prior Art

- [Intrinsic and extrinsic verification](./research/intrinsic-extrinsic-verification.md) — keep stable guarantees in representations and check phase-specific guarantees in the code that produces them.
- Refinement / liquid types — small decidable predicates close to code, checked statically.
- Dafny — clear assume/assert split and useful failed-check diagnostics.
- Constraint programming global constraints — named constraints with decompositions handled by the solver.
- CSS logical vocabulary — start/end, inline/block, main/cross over physical-only names.
- Spreadsheets — dependency chains humans can read.
- SQL checks — named local constraints, clear failure labels.
- SystemVerilog assertions — `assume` / `assert` / future `cover`, not the syntax.
- SMT / Alloy — backend and counterexample inspiration, not public syntax.

## Loop Analysis Is A Transfer Function, Not A Recognizer Catalog

The loop analysis evaluates the body once per control-flow path on a generalized iteration: every variable the body writes starts as an unbounded pre-state symbol. Any bound the evaluator derives from that state holds at every iteration. For example, `const snapshot = y // @fit 0..0` inside a loop stays unknown: the initial `y = 0` does not apply to every iteration.

The per-iteration effect of each scalar must land in a small closed algebra — unchanged, `+= delta`, `min`/`max` with a candidate, or a plain rebind — with written compose and join rules. Anything outside the algebra makes that one variable unknown instead of failing the whole loop. Sequence relations come from subtracting consecutive pushed elements' linear forms (with pre-state symbols advanced by the path's delta and per-iteration names renamed apart); a relation is emitted when the residue is loop-invariant. When rounding hides the linear relation, the evaluated number keeps the binary addition tree and operand snapshots that produced it. Previous-row fields stay as named leaves, while a subtree with no previous-row field stays one loop-invariant amount. A segmented row loop can therefore connect `nextTop = bottom + gap` to the pushed `bottom` even after the height accumulator resets, without re-evaluating expression text against the later state.

Keep exact comparisons and evaluated addition trees as separate relation cases. Exact comparisons may use algebra; evaluated trees may commute immediate `+` children but may not reassociate. They support `spaced` and a zero-gap `lastEnd` when the final cursor ran the exact same operation as the final row end. They do not support subtracting a rounded gap after the loop. When two pushed fields hold the same operand snapshot, emit the true relation for each field instead of choosing one name. Both cases require the compared values to exclude `NaN`.

Array summary accumulation and branch joins have different rules. Accumulation unions compatible facts from one analyzed producer. A branch join keeps the guarantee shared by every branch, so `==` joined with `>=` keeps `>=`, matches facts by semantic identity rather than list position, joins their numeric bounds, and drops `lastEnd` or `extentEnd` when the position/size paths differ. An empty branch keeps adjacency facts because they hold vacuously, but not end facts. Any arbitrary `push`, or a later loop that starts from a non-empty array, clears the old sequence summary. Freerange derives new sequence facts only after analyzing all of the new producer's append behavior.

Two findings worth keeping:

- Names are only safe to share when they denote one well-defined quantity for the iteration. Fallback names derived from expression text (`max(rowHeight, h)`) break this once a mutated variable moves between two reads, so the analysis assigns a fresh symbol at every binding and assignment. Same-iteration reuse through a local stays recognizable; cross-statement text coincidences cannot cancel.
- Interval narrowing needs more than one round. The widened first pass can leave a max-accumulator's floor unanchored (`max(unbounded, h)` has no lower bound), and only the next round, run against the proven hulls, anchors it. Iterate pre-state hulls to a small fixpoint, and validate each round's closed forms against the previous post-loop hull before accepting.

The standard names for the pieces: abstract interpretation fixpoints (Cousot), widening/narrowing, and scalar evolution's `{start, +, step}` recurrences derived from semantics. The relation layer over pushed sequences is a small bespoke relational domain on top.

## Floats Prove By Exactness Or Monotonicity, Never By Algebra

Program arithmetic gets its algebraic linear form only when the operation provably rounds nothing; everything else gets an opaque solver atom, keeping only its hull and whatever monotone facts survive rounding. Separately, values produced by actual source evaluation keep a small operation record with the operand values read at that moment. The operation tree is the stable identity; bounds, grid, and NaN facts can narrow later without changing which operation ran. A branch join keeps the tree only when both sides describe the same operation, then merges the operand facts instead of keeping one branch's snapshot. Immediate `+` and `*` operands may swap, but the tree never reassociates. Mutation still invalidates an affected tree, and synthetic bound calculations do not get one. Exactness can be checked from data the values already carry: every runtime value is an integer multiple of `2^grid` (so `int` is grid 0 and `x * 0.5` lands on grid −1), and a result on the grid with magnitude at most `2^(53+grid)` is representable, so ECMA's round-of-exact-real returns it untouched. Array lengths always fit because JS caps them at `2^32 − 1`.

What survives rounding without exactness, each verified by brute force against exact rationals:

- Rounding is monotone, so `real(L) <= real(R)` carries `fl(L) <= fl(R)` for one operation per side. This recovers most float inequality proving — `y + gap >= y`, `(cols - w) >= 0` from `w <= cols` — without granting the results any algebra.
- Sign survives op by op: a positive real sum or difference of doubles is at least `2^-1074` (all doubles share that grid), which rounding cannot cross, so even strict sign carries through `+` and `-`. Products and quotients keep `>= 0` but can underflow a strict sign to zero.
- Commutativity is bitwise; reassociation is not. Expression keys may sort the two operands of `+` and `*` but never flatten across nesting.
- Equality across rounding needs the same recorded operation over the same operand snapshots, or exactness. `(x / 3) * 3 == x` has runtime counterexamples in both directions, and one-sided `<=`/`>=` versions are just as false.
- `%` never rounds because the exact remainder is always representable, and `x - x` is exactly `+0` for finite x.

Strictness through rounding is the recurring problem: two real values that differ can round to the same double, so strict conclusions need exactness, an integer gap, or a margin past the boundary. The floor/ceil division case is the clearest example — `floor(p / cell) < count` fails at ordinary layout magnitudes (cell 4.044367056305642, count 13) because the quotient rounds onto the boundary. An error bound below one does not help at an integer boundary.

Track `NaN` separately from numeric bounds because it fails every comparison. Any trusted or observed comparison about a value proves it is not `NaN`, while a fully unconstrained value cannot even prove `x == x`. Counterexamples use a stricter rule: only variables constrained by givens or checked contracts can anchor a disproof. Branch observations do not constrain caller inputs, and a derived hull may include combinations that the source cannot produce.

Operations on values that are not `NaN` can still produce `NaN`: `Infinity - Infinity`, `0 * Infinity`, `Infinity / Infinity`, and `Infinity % d`. A `0..Infinity` given still includes `Infinity`. A result that may be `NaN` uses a fully unbounded hull. Sums and differences widen that way naturally; multiplication, division, and modulo must widen explicitly because checking only their finite corners hides the `NaN` case. Conclusions about a rounded result check the operands, not just the result's hull. An infinite hull endpoint is reachable only when no trusted fact gives it a finite constant bound, so `given x <= 1000` rules out `Infinity` even while the hull stays open below.

A separate distinction matters: an operation that may overflow does not necessarily produce `NaN`. A finite value divided by 0.998 can reach either infinity, so its hull is fully unbounded, yet no input produces `NaN`. The equality check `return == pos + velocity / 0.998` stays true at the overflow because `Infinity == Infinity`, while `NaN == NaN` is false. The value records possible `NaN` separately from its bounds; a hull-containment check must not let a value that excludes `NaN` stand in for one that allows it. One comparison does not make a value finite on both sides: `given x < Infinity` still allows `-Infinity`, so `x - x` may produce `NaN`.

Finiteness is expressible without new syntax: over doubles, `x < Infinity` is exactly `x <= Number.MAX_VALUE`, so strict comparisons against either infinity become inclusive comparisons against the corresponding finite limit. The same rule applies to exclusive ranges such as `0..<Infinity`, including `int` ranges; do not apply the normal floor or ceiling adjustment to infinity because `ceil(Infinity) - 1` is still `Infinity`. Constant comparison givens narrow numeric bounds like range givens do, and a true comparison excludes `NaN` on both sides.

The `<..` spelling is unambiguous because a valid TypeScript expression cannot end in `<`. Require exactly two dots so `0...10` is rejected instead of silently read as `0..10`.
