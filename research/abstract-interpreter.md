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

- `src/interpreter/context.ts`: frames, issues, and flow
- `src/interpreter/evaluate.ts`: finite literals, objects/arrays, local calls, ordered defaults, IIFEs, `map`, finite `filter`, finite `for..of`, `push`, branch refinement, property assignment, and simple alias-preserving mutation
- `src/interpreter/format.ts`: value-tree snapshots for the new harness
- `verify-new-interpreter-snapshots.ts`: focused kernels for parallel evolution

Old extraction order, still useful as a map of remaining semantic families:

1. interpreter state helpers
2. top-level literal/module value reading
3. call/default/IIFE semantics
4. statement/control-flow evaluation
5. expression evaluation
6. array built-ins and mutation invalidation

After each slice, run `bun run check`. Behavior changes only after the extraction snapshots are stable.
