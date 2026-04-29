# Abstract Interpreter Spine

Freerange is already an abstract interpreter. The rewrite should make that explicit, but the old evaluator is now a reference implementation, not a cage.

## Goal

Keep the public checker small: ordinary TypeScript source in, earned `@fit` facts out. The interpreter owns source evaluation; contract checking, reports, `infer`, and `doctor` query the same abstract state instead of each growing their own recognizer.

First milestone: a fresh interpreter core running beside `check.ts` on focused kernels. Old snapshots catch surprises; they do not decide the design.

## Abstract Values

`Value` remains the semantic currency:

- numbers: intervals, integer bit, finite cases, linear expression, provenance
- literals: finite booleans / strings
- objects: required known props
- arrays: length, finite slots, element summary, sequence summary
- nullable / null / unknown

TypeScript shape is a fallback adapter, not proof. It can say a path exists as `number`; it cannot prove the numeric domain unless source or a checked contract earned it.

## State

The interpreter state is:

- `program`: current module
- `env`: root name to abstract value
- `assumptions`: branch, given, and source-earned linear facts
- `inputRoots`: roots allowed in `given`
- `stack`: call/report path
- `checks`: obligations discovered while evaluating
- optional mode fields: call-obligation recording, object path, loop/infer collection

This state should become a named module boundary before semantics change. Closures and IIFEs clone state; only deliberate mutation propagation can change an outer env.

## Calls

Call evaluation has four paths:

- same-file body evaluation when source is available
- imported checked-contract summaries when source resolves locally
- class method/getter calls with `this`
- selected built-ins such as `Math`, array reads, `map`, and `filter`

Default parameter initializers run in parameter order in the callee env. Explicit `undefined`, rest params, and destructured defaults stay outside the surface until real pressure earns them.

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

Diagnostics should point at the check location and the construction boundary when possible. `infer` and snapshots are the adoption and rewrite guardrails.

## Rewrite Style

Do not swap the engine in one move. Build the new core in parallel, then compare. Useful old helpers are fine when they describe shared concepts, but do not copy old evaluator control flow just to preserve its shape.

Current parallel core:

- `src/interpreter/context.ts`: frames, issues, assumptions, and flow
- `src/interpreter/evaluate.ts`: finite literals, objects/arrays, arithmetic and `Math` primitives, local calls, ordered defaults, parameter type shapes for direct kernels, IIFEs, `map`, finite `filter`, finite `for..of`, `push`, branch refinement, property assignment, simple alias-preserving mutation, and array origin summaries for map/filter/loop push
- `src/interpreter/format.ts`: value-tree and origin-fact snapshots for the new harness
- `verify-new-interpreter-snapshots.ts`: focused kernels for parallel evolution

The fresh core is now allowed to answer `infer` for eligible bodies without loop reports. That includes unannotated finite `for..of` loops. Annotated loops still stay on the old evaluator because those reports are not just return values; they include loop-local checked/assumed/not-inferred bookkeeping.

Naming rule learned during the first adoption pass: a fresh local array literal should get a local path such as `items[]`, but a fresh local object literal should keep scalar field expressions such as `imageSizeX`. The object itself can be named for aliasing and property access, but renaming every scalar leaf erases useful source equalities.

Fresh finite `for..of` loop pushes now record only origin lineage: unconditional pushes follow the source by index, and pushes under `if` become order-preserving subsets. Sequence facts such as `spaced`, `lastEnd`, cursor recurrence, and loop-local report sections still belong to the old loop-summary path until the fresh state has explicit loop bookkeeping.

When the source array is not finite but has an element domain, the fresh core can run a deliberately tiny abstract `for..of` pass for append loops. The body may bind local values, call `rows.push(...)`, or guard that push with an `if`. Unguarded pushes mean one push per source element, so the target length follows the source length. Guarded pushes keep only element facts and subsequence origin.

That abstract pass now also handles trailing scalar cursor updates such as `y += step`, `y = y + step`, and `y = step + y`. The update must come after any push that reads the cursor, and the increment cannot depend on an earlier cursor update. The interpreter records cursor paths from the pushed syntax, then applies the running-sum result after the body, so `let y = top; rows.push(y); y += step` keeps both `rows[]` ranges and the final `y == runningSum(...)`.

Guarded scalar totals are a separate small loop-effect shape: `if (item.visible) count += 1` or `if (item.visible) total += item.height` produces the conditional running-sum range and the extra comparison facts such as `count <= items.length` when the source proves them. Scalar extrema are another pure loop effect: `maxWidth = Math.max(maxWidth, item.width)` and `minWidth = Math.min(minWidth, item.width)` keep the target range bounded by the start value and the item domain. Fresh `for..of` and indexed loops both use this effect path now. For now, these scalar-effect loops cannot also push rows, mix in cursor updates, or use an `else` branch. Those combinations stay on the legacy path until the fresh loop state can model them directly.

The first consolidation pass after the indexed-loop sprint made scalar effects explicit and added a shared loop body walker. Fresh `for..of` and indexed loops now share one pending effect object, one effect recognizer, one effect finalizer, and the same "scalar effects must be terminal" body ordering rule. The next vocabulary pass renamed symbolic loop frames and append records directly in the code, so `for..of` and indexed loops no longer hide behind the older reducer/push names internally. Push/origin handling is still split because the two loop sources earn those facts differently.

The fresh core also has the first indexed `for` loop shapes: `for (let i = 0; i < limit; i++) values.push(i)` and `for (let i = 0; i < items.length; i++) rows.push(...)`. The limit must already be a non-negative integer. Array-source loops bind `items[i]` through the normal array element domain, carry one-push-per-item origin for separate target arrays, and give pushed index fields the same element-path range and comparison assumptions as the old indexed loop path. Guarded indexed pushes keep element facts and become order-preserving subsets, and indexed append loops can apply trailing scalar cursor updates such as `y += step` after guarded or unguarded pushes. Sequence/spacing summaries for guarded indexed cursor loops and loop-local `@fit` reports are still legacy-only.

Old extraction order, still useful as a map of remaining semantic families:

1. interpreter state helpers
2. top-level literal/module value reading
3. call/default/IIFE semantics
4. statement/control-flow evaluation
5. expression evaluation
6. array built-ins and mutation invalidation

After each slice, run `bun run check`. Behavior changes only after the extraction snapshots are stable.
