# Abstract Interpreter Spine

Freerange is an abstract interpreter. The cutover made that explicit and retired the old evaluator instead of keeping two engines alive.

## Goal

Keep the public checker small: ordinary TypeScript source in, earned `@fit` facts out. The interpreter owns source evaluation; contract checking, reports, `infer`, and `doctor` query the same abstract state instead of each growing their own recognizer.

Current milestone: one interpreter owns source evaluation. The checker layer owns contracts, reports, `infer`, and `doctor`; the next cleanup is carving `src/check-core.ts` into clearer pieces.

## Abstract Values

`Value` remains the semantic currency:

- numbers: intervals, integer bit, finite cases, linear expression, provenance
- literals: finite booleans / strings
- objects: required known props
- arrays: length, collection element summary, tuple/product slots, sequence summary
- nullable / null / unknown

TypeScript shape is a fallback adapter, not proof. It can say a path exists as `number`; it cannot prove the numeric domain unless source or a checked contract earned it.

## State

The interpreter frame is:

- `program`: current module
- `env`: root name to abstract value
- `assumptions`: branch, given, and source-earned linear facts
- `stack`: call/report path
- `issues`: unsupported source-shape diagnostics
- `loopStack`, `conditionalDepth`, and claim hooks for loop/report boundaries
- optional mode fields: object path and call-obligation recording

The checker context around that frame owns input roots, parsed checks, and the
current call-obligation mode. Closures and IIFEs clone state; only deliberate
mutation propagation can change an outer env.

## Calls

Call evaluation has four paths:

- same-file body evaluation when source is available
- imported checked-contract summaries when source resolves locally
- class method/getter calls with `this`
- selected built-ins such as `Math`, array reads, `map`, and `filter`

Default parameter initializers run in parameter order in the callee env. Omitted args and explicit `undefined` / optional args fall through to those defaults; rest params and destructured defaults stay outside the surface until real pressure earns them.

## Mutation

Mutation is conservative. A clear assignment/call names one or more root values, including alias roots. Those roots are invalidated before evaluation continues. Unsupported side effects return `unknown`.

Do not preserve a field fact through a mutation just because the current proof does not use that field. Root invalidation is boring and honest.

## Modules

Module loading owns:

- TypeScript-backed source and symbol resolution
- checked function boundaries
- imports / exports
- top-level `const` literals

Imported function bodies are not inlined as a shortcut. They either have checked contracts or they provide only TypeScript shape fallback.

## Reports

Every unsupported stop should be one of:

- missing input fact
- unsupported source shape
- unavailable helper boundary
- real proof gap
- mutation invalidation

Diagnostics should point at the check location and the construction boundary when possible. `infer` and snapshots are the adoption and interpreter-evolution guardrails.

## Rewrite Style

The parallel phase is over. Keep useful shared concepts, but do not preserve old evaluator control flow just because it existed last week.

Current core:

- `src/interpreter/context.ts`: frames, issues, assumptions, claim hooks, and flow
- `src/interpreter/source-syntax.ts`: small TypeScript syntax readers for loop shapes, guard safety, push calls, and cursor/index paths
- `src/interpreter/forgettable-loop.ts`: read-only loop-header/body checks for conservative root invalidation when the loop itself is outside the modeled iteration surface
- `src/interpreter/loop-effects.ts`: scalar loop-effect collection/finalization for running sums, conditional sums, extrema, and cursor checks
- `src/interpreter/loop-values.ts`: index-derived element values, cursor replacement inside appended elements, and loop append shapes for sequence summaries
- `src/interpreter/math.ts`: numeric `Math.*` primitives
- `src/interpreter/refine.ts`: branch-frame creation and path/literal refinement from conditions
- `src/interpreter/scope.ts`: loop/block scoped-name collection and environment save/restore
- `src/interpreter/value-path.ts`: symbolic path reads/writes, exact index paths, and alias-preserving container replacement
- `src/interpreter/evaluate.ts`: finite literals, objects/arrays, arithmetic and `Math` primitives, local/imported/aliased calls, ordered defaults, parameter type shapes for direct kernels, class method/getter `this`, IIFEs, summary `map`/`filter`, symbolic `for..of`, tuple/product slot reads, `push`, continuation-aware `if`/`else if` joins, finite-literal `switch`, throw exits, branch refinement, property assignment, simple alias-preserving mutation, guarded scalar flushes, claim-boundary checks for locals/returns/object fields, and array origin summaries for map/filter/loop push
- `src/interpreter/format.ts`: value-tree, origin-fact, and unsupported-shape snapshots
- `verify-interpreter-snapshots.ts`: focused kernels for interpreter evolution

## Cutover Notes

The interpreter now answers function bodies, top-level inline checks, local inline checks, return checks, object-field checks, type-boundary checks, supported loop reports, and helper-call obligations. `src/check.ts` is the public checker front door; `src/check-core.ts` holds the current checker shell around interpreter state.

The useful comparison was behavioral, not architectural. The old evaluator helped reveal missing surfaces, then got deleted with the differential harness once demos, negative reports, inferred facts, focused interpreter kernels, the corpus sweep, and type/lint all had enough coverage.

Lessons worth keeping:

- Preserve environment identity at checker boundaries. Hooks and contract summaries may hold the original `EvalContext.env` map, so interpreter expression evaluation copies the result entries back into that map instead of replacing it. That kept helper-summary facts from disappearing.
- Synthetic branch frames are interpreter details. Inline return/object/type claims from `if`, conditional, and indexed-guard branches should report at the owning body stack, not leak names like `<conditional-true>`.
- Loop effects compose by owned targets. Guarded scalar flushes can live with unrelated side appends, but mixing guarded flushes with unguarded pushes to the same array stays rejected because the resulting element stream is not one coherent proof shape.
- Source evaluation belongs in `src/interpreter/*`; checker code should parse comments, apply givens, ask proofs, and format reports. Unsupported-shape diagnostics should carry the source line when the interpreter knows the node. When a new source family appears, prefer extending the interpreter domain over adding a report-only recognizer.

Next cleanup target: keep extracting clear pieces from `src/check-core.ts` now that evaluator control flow is gone. The public language does not need to grow for that; it should mostly make the code easier to reason about.
