# Development

```sh
bun install
bun check
```

## Day-To-Day

- `bun run test` — run every Bun test and local snapshot in four worker processes
- `bun run test:update` — update every local test snapshot
- `bun fr.ts --help` — print the CLI command shapes
- `bun fr.ts check path/to/file.ts` — check one or more files and print only failures plus a pass/fail/requires/unknown summary
- `bun fr.ts check` — read the nearest `tsconfig.json`, like `tsc`, and check those source files
- `bun fr.ts check --annotations-only path/to/file.ts` — quieter local pass that proves written annotations without the broad callsite scan
- `bun fr.ts check --audit path/to/file.ts` — advisory cleanup for redundant `Math.min`, `Math.max`, exact min/max ternary choices, always-known `if` conditions, and redundant `??` fallbacks; composes with `--annotations-only`
- `bun fr.ts infer path/to/file.ts` — show inferred ranges and relationships, explicit checks, redundancy, and unsupported code for every function in a file; add `--function name` for one function, or `--annotations-only` for the quieter annotated-function view
- `bun run bench -- --runs 3 path/to/file.ts` — dev-only timing for explicit files, including cold load, warmed load/verify medians, and a load-phase split
- `bun knip` — flag unused files, exports, types, dependencies, and binaries (config in [knip.config.ts](./knip.config.ts))
- `bun run check` — local gate: typecheck, lint, knip, and every Bun test and snapshot

## Current Sources Of Truth

- [README.md](./README.md) — short project front door
- [DOCUMENTATION.md](./DOCUMENTATION.md) — user-facing syntax, glossary, and supported checker behavior
- [spec/number.md](./spec/number.md) — public rules for finite numbers, infinities, `NaN`, and floating-point arithmetic
- [tests/source-checking/patterns.ts](./tests/source-checking/patterns.ts), [tests/loops/loop-patterns.ts](./tests/loops/loop-patterns.ts), and [tests/imports/import-patterns.ts](./tests/imports/import-patterns.ts) — runnable source examples; the loop catalog is a fast focused `fr check` target during loop work
- [tests/source-checking/negative-patterns.ts](./tests/source-checking/negative-patterns.ts) and [tests/imports/negative-import-patterns.ts](./tests/imports/negative-import-patterns.ts) — intentionally bad source examples
- [negative-patterns.expected.txt](./negative-patterns.expected.txt) — expected results for all negative checks
- [infer-snapshots.expected.txt](./infer-snapshots.expected.txt) — stable dev-only snapshots of inferred ranges and relationships
- [eval-snapshots.expected.txt](./eval-snapshots.expected.txt) — selected results from evaluating source code
- [interpreter-snapshots.expected.txt](./interpreter-snapshots.expected.txt) — interpreter values, counts and hashes of all derived facts, origin facts, issues, and effects
- [todo.md](./todo.md) — current priorities and limitations
- [research.md](./research.md) — durable direction notes

## Important Files

CLI and reports:

- [fr.ts](./fr.ts) — main CLI entrypoint
- [src/reports.ts](./src/reports.ts), [src/check-core.ts](./src/check-core.ts), and [src/reporting.ts](./src/reporting.ts) — check/infer orchestration and report formatting
- [src/obligations.ts](./src/obligations.ts) and [src/proof-facts.ts](./src/proof-facts.ts) — proof obligations and proof traces

Contracts and source evaluation:

- [src/parser.ts](./src/parser.ts), [src/function-contracts.ts](./src/function-contracts.ts), [src/type-contracts.ts](./src/type-contracts.ts), [src/contract-typecheck.ts](./src/contract-typecheck.ts), [src/prepared-contracts.ts](./src/prepared-contracts.ts), [src/value-specs.ts](./src/value-specs.ts), [src/check-specs.ts](./src/check-specs.ts), [src/givens.ts](./src/givens.ts), and [src/function-call-contracts.ts](./src/function-call-contracts.ts) — parsing, type-contract expansion, TypeScript checking, prepared assumptions and checks, whole-value type syntax, input contracts, and helper-call requirements
- [src/interpreter/](./src/interpreter), [src/interpreter/context.ts](./src/interpreter/context.ts), [src/interpreter/number-cases.ts](./src/interpreter/number-cases.ts), [src/interpreter/state-cases.ts](./src/interpreter/state-cases.ts), [src/interpreter/call-targets.ts](./src/interpreter/call-targets.ts), [src/interpreter/function-effects.ts](./src/interpreter/function-effects.ts), [src/interpreter/platform-effects.ts](./src/interpreter/platform-effects.ts), [src/interpreter/expression-effects.ts](./src/interpreter/expression-effects.ts), [src/interpreter/forget.ts](./src/interpreter/forget.ts), [src/prepared-call.ts](./src/prepared-call.ts), [src/function-evaluation.ts](./src/function-evaluation.ts), [src/function-inputs.ts](./src/function-inputs.ts), and [src/function-shape.ts](./src/function-shape.ts) — source evaluation, numeric and whole-state alternatives, frame state and run output, TypeScript binding-based call resolution, function and platform effects, repeatable-expression checks, conservative invalidation, call preparation, function setup, `this`, nested functions, and helper-call recording
- [src/modules.ts](./src/modules.ts), [src/module-values.ts](./src/module-values.ts), [src/program-env.ts](./src/program-env.ts), [src/shapes.ts](./src/shapes.ts), and [src/ts-diagnostics.ts](./src/ts-diagnostics.ts) — TypeScript-backed file loading, user-code diagnostics and formatting, imports, top-level constants, and exact TypeScript type queries

Facts, values, and proof:

- [src/domain-types.ts](./src/domain-types.ts), [src/value-domain.ts](./src/value-domain.ts), [src/number-domain.ts](./src/number-domain.ts), [src/array-summary.ts](./src/array-summary.ts), [src/domain-paths.ts](./src/domain-paths.ts), and [src/domain.ts](./src/domain.ts) — abstract values, numeric ranges and operation records, arrays, paths, and the compatibility facade
- [src/facts.ts](./src/facts.ts), [src/assumptions.ts](./src/assumptions.ts), [src/branch-context.ts](./src/branch-context.ts), [src/linear.ts](./src/linear.ts), [src/proof.ts](./src/proof.ts), and [src/proof-rules.ts](./src/proof-rules.ts) — published facts, numeric assumptions, branch identity, reachability, linear expressions, and comparison proof rules
- [src/indexed-facts.ts](./src/indexed-facts.ts), [src/sequence-facts.ts](./src/sequence-facts.ts), [src/bound-index.ts](./src/bound-index.ts), [src/interpreter/loop-transfer.ts](./src/interpreter/loop-transfer.ts), and [src/loop-summary.ts](./src/loop-summary.ts) — index facts, adjacent sequence facts, the loop analysis, and recurrence closed forms

Dev tools and harnesses:

- [bench.ts](./bench.ts) and [bench-core.ts](./bench-core.ts) — dev-only timing tools
- [tests/domain](./tests/domain), [tests/calls](./tests/calls), [tests/interpreter](./tests/interpreter), [tests/loops](./tests/loops), [tests/ranges](./tests/ranges), [tests/type-contracts](./tests/type-contracts), [tests/purity](./tests/purity), [tests/reports](./tests/reports), and [tests/cli](./tests/cli) — domain operations, calls, interpreter state, loops, ranges, type contracts, purity, reports, and CLI behavior
- [tests/parser](./tests/parser), [tests/source-checking](./tests/source-checking), [tests/imports](./tests/imports), [tests/interpreter-matrix](./tests/interpreter-matrix), and [tests/orchestration](./tests/orchestration) — parser, runnable source examples, imports, interpreter combinations, and test inventory checks
- [tests/snapshot](./tests/snapshot) and [snapshot.ts](./snapshot.ts) — local snapshot comparisons and infrastructure

## Infer Tool

`bun fr.ts infer path/to/file.ts` is for adoption and debugging, not public annotation generation. The user-facing command behavior lives in [DOCUMENTATION.md](./DOCUMENTATION.md); this section is only the maintenance policy.

Selected inference functions are snapshotted in [infer-snapshots.expected.txt](./infer-snapshots.expected.txt), including every fact reported for each function. Add a function when its inferred behavior becomes important enough that we would notice losing it. Unsupported snapshots should keep the first missing root and the next distinct blocker, not every property-access echo from the same root.

Use [eval-snapshots.expected.txt](./eval-snapshots.expected.txt) for results from evaluating source code that are too specific for the public `infer` catalog: summarized literal data, IIFEs, default parameters, loop results, and unsupported stops.

`infer` must stay total. Recursive helper cycles should report an unsupported recursion stop. Do not recursively copy TypeScript object or array structure just to make `infer` prettier; ask TypeScript only for the exact node or path the checker is using.

Treat `infer`, `check --audit`, and normal reports as one workflow: inspect what the source proves, keep the useful `@fit` comments, then decide whether a remaining failure needs another input contract, uses code Freerange does not support, calls a helper without enough contract information, or exposes a real checker gap.

Do not grow TypeScript type logic just to make `infer` prettier. Keep [src/shapes.ts](./src/shapes.ts) as a small query layer over the TypeScript checker: ask for `return.rows[].height`, `input[0].height`, or the exact expression being read; do not walk a whole return type and copy every property into Freerange. Whole-value contract syntax is the narrow exception: [src/parser.ts](./src/parser.ts) lowers Freerange range leaves, then [src/value-specs.ts](./src/value-specs.ts) resolves the surrounding TypeScript type syntax just far enough to check the written contract.

Do not invent containers from a written path. `given input.width: 0..10` may attach a range only after `input.width` is already a numeric path according to TypeScript or real source evaluation. If `input` is `{}`, `input.width` is a string, or `items` is not an array, report the given as unknown instead of creating `input`, `width`, or `items[]`. Values created by the code are different: `{width: 10}`, `rows.push(...)`, `items.map(...)`, and `row.width = 10` can still create facts because the JavaScript did that work.

## Audit Mode

Audit findings are advisory and do not change the normal `check` exit status. Add a finding only when the current analysis proves it.

## Adding Support

[tests/source-checking/patterns.ts](./tests/source-checking/patterns.ts), [tests/loops/loop-patterns.ts](./tests/loops/loop-patterns.ts), and [tests/imports/import-patterns.ts](./tests/imports/import-patterns.ts) are the runnable source examples; loop fixtures go in the loop catalog.

[tests/source-checking/negative-patterns.ts](./tests/source-checking/negative-patterns.ts) and [tests/imports/negative-import-patterns.ts](./tests/imports/negative-import-patterns.ts) have intentionally bad source examples. Their expected results live in [negative-patterns.expected.txt](./negative-patterns.expected.txt).

Put a regression in the suite that owns the behavior. Add a runnable source example when the behavior belongs in a catalog, and add a negative example when its diagnostic matters.

Run:

```sh
bun run check
```

Run `bun run test:update` when the current behavior is the new snapshot baseline. Update snapshots only after reading the diff and deciding the behavior is intentional.
