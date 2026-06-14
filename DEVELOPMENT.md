# Development Setup

```sh
bun install
```

## Day-To-Day

- `bun run test` — focused checker suites, positive patterns, stable negative messages, CLI regressions, and curated inference snapshots
- `bun run test:parser` — focused parser-layer checks in [tests/parser](./tests/parser) for contract syntax classification and TS type lowering
- `bun run fr --help` — print the CLI command shapes
- `bun run fr check path/to/file.ts` — check one or more files and print only failures plus a pass/fail/requires/unknown summary
- `bun run fr check` — read the nearest `tsconfig.json`, like `tsc`, and check those source files
- `bun run fr check --annotations-only path/to/file.ts` — quieter local pass that proves written annotations without the broad callsite scan
- `bun run fr check --audit path/to/file.ts` — advisory cleanup for redundant `Math.min`, `Math.max`, exact min/max ternary choices, always-known `if` conditions, and redundant `??` fallbacks; composes with `--annotations-only`
- `bun run fr infer path/to/file.ts` — main CLI view of inferred facts, explicit checks, redundancy, and unsupported proof spots for every function in a file; add `--function name` for one function, or `--annotations-only` for the quieter annotated-function view
- `bun run bench -- --runs 3` — dev-only timing for the current sibling demo contract set, including cold load, warmed load/verify medians, and a load-phase split; pass files to time a custom set
- `bun run verify:demos` — verify the current checked Vibescript/Pretext demo contracts from sibling checkouts
- `bun run verify:photo-gallery` — snapshot `fr infer --all` over the local photo-gallery so annotation work starts from source facts and unsupported stops
- `bun run verify:eval` — curated interpreter-adjacent snapshots for facts, shapes, and unsupported stops we do not want to lose during source-evaluation work
- `bun run verify:interpreter` — run the interpreter on focused tests and snapshot the abstract return values it builds
- `bun run verify:semantics` — snapshot the internal obligation/proof-trace shape for a tiny checked fixture
- `bun run verify:corpus` — reproducible external corpus sweep over every `@fit` source file when `/Users/chenglou/github/freerange-corpus` is present
- `bun run verify:bench` — loose warmed performance guard for demo-contract load and verification time
- `bun run audit:demos` — summarize which demo `@fit` checks are likely-removable redundant noise versus public-looking explicit contracts
- `bun run knip` — flag unused files, exports, types, dependencies, and binaries (config in [knip.config.ts](./knip.config.ts))
- `bun run check` — full local gate: pattern tests, parser tests, demo contracts, eval/interpreter/semantic/corpus/bench snapshots, typecheck, lint, and knip

## Current Sources Of Truth

- [README.md](./README.md) — short project front door
- [DOCUMENTATION.md](./DOCUMENTATION.md) — user-facing syntax, glossary, adoption guide, and supported checker surface
- [tests/patterns/patterns.ts](./tests/patterns/patterns.ts), [tests/patterns/loop-patterns.ts](./tests/patterns/loop-patterns.ts), and [tests/imports/import-patterns.ts](./tests/imports/import-patterns.ts) — positive pattern specimens; loop-patterns.ts is the loop-analysis catalog and a fast focused `fr check` target during loop work
- [tests/patterns/negative-patterns.ts](./tests/patterns/negative-patterns.ts) and [tests/imports/negative-import-patterns.ts](./tests/imports/negative-import-patterns.ts) — intentionally bad patterns
- [negative-patterns.expected.txt](./negative-patterns.expected.txt) — stable negative report output
- [infer-snapshots.expected.txt](./infer-snapshots.expected.txt) — stable dev-only inferred-facts snapshots
- [demo-contracts.expected.txt](./demo-contracts.expected.txt), [photo-gallery-infer.expected.txt](./photo-gallery-infer.expected.txt), [eval-snapshots.expected.txt](./eval-snapshots.expected.txt), [interpreter-snapshots.expected.txt](./interpreter-snapshots.expected.txt), [semantic-snapshots.expected.txt](./semantic-snapshots.expected.txt), and [corpus-probes.expected.txt](./corpus-probes.expected.txt) — stable harness snapshots for demos, the local photo-gallery infer inventory, interpreter-adjacent facts, focused interpreter tests, proof-trace shape, and the external corpus sweep
- [todo.md](./todo.md) — current priorities and limitations
- [research.md](./research.md) — durable direction notes

## Important Files

CLI and reports:

- [fr.ts](./fr.ts) — main CLI entrypoint
- [src/reports.ts](./src/reports.ts), [src/check-core.ts](./src/check-core.ts), and [src/reporting.ts](./src/reporting.ts) — check/infer orchestration and report formatting
- [src/obligations.ts](./src/obligations.ts) and [src/proof-facts.ts](./src/proof-facts.ts) — proof obligations and proof traces

Contracts and source evaluation:

- [src/parser.ts](./src/parser.ts), [src/function-contracts.ts](./src/function-contracts.ts), [src/contract-typecheck.ts](./src/contract-typecheck.ts), [src/prepared-contracts.ts](./src/prepared-contracts.ts), [src/value-specs.ts](./src/value-specs.ts), [src/check-specs.ts](./src/check-specs.ts), [src/givens.ts](./src/givens.ts), and [src/function-call-contracts.ts](./src/function-call-contracts.ts) — parsing, type-contract expansion, TypeScript checking, prepared assumptions/proofs/body claims, whole-value type syntax, input assumptions, and helper-call requirements
- [src/interpreter/](./src/interpreter), [src/interpreter/context.ts](./src/interpreter/context.ts), [src/interpreter/call-targets.ts](./src/interpreter/call-targets.ts), [src/interpreter/function-effects.ts](./src/interpreter/function-effects.ts), [src/prepared-call.ts](./src/prepared-call.ts), [src/function-evaluation.ts](./src/function-evaluation.ts), [src/function-inputs.ts](./src/function-inputs.ts), and [src/function-shape.ts](./src/function-shape.ts) — source evaluation, frame state and run output, source-backed function implementations, TypeScript binding-based call resolution, function effects and purity, call preparation, function setup, `this`, nested functions, and helper-call recording
- [src/modules.ts](./src/modules.ts), [src/module-values.ts](./src/module-values.ts), [src/program-env.ts](./src/program-env.ts), and [src/shapes.ts](./src/shapes.ts) — TypeScript-backed file loading, user-code diagnostics, imports, top-level constants, and exact TypeScript type queries

Facts, values, and proof:

- [src/domain-types.ts](./src/domain-types.ts), [src/value-domain.ts](./src/value-domain.ts), [src/number-domain.ts](./src/number-domain.ts), [src/array-summary.ts](./src/array-summary.ts), [src/domain-paths.ts](./src/domain-paths.ts), and [src/domain.ts](./src/domain.ts) — abstract values, numeric ranges and operation records, arrays, paths, and the compatibility facade
- [src/facts.ts](./src/facts.ts), [src/assumptions.ts](./src/assumptions.ts), [src/constraint-reachability.ts](./src/constraint-reachability.ts), [src/linear.ts](./src/linear.ts), [src/proof.ts](./src/proof.ts), and [src/proof-rules.ts](./src/proof-rules.ts) — published facts, assumptions, linear expressions, and comparison proof rules
- [src/indexed-facts.ts](./src/indexed-facts.ts), [src/sequence-facts.ts](./src/sequence-facts.ts), [src/bound-index.ts](./src/bound-index.ts), [src/interpreter/loop-transfer.ts](./src/interpreter/loop-transfer.ts), and [src/loop-summary.ts](./src/loop-summary.ts) — index facts, adjacent sequence facts, the loop analysis, and recurrence closed forms

Dev tools and harnesses:

- [bench.ts](./bench.ts) and [bench-core.ts](./bench-core.ts) — dev-only timing tools
- [test.ts](./test.ts) — small orchestrator for focused checker suites
- [tests/check](./tests/check), [tests/calls](./tests/calls), [tests/interpreter](./tests/interpreter), [tests/ranges](./tests/ranges), [tests/type-contracts](./tests/type-contracts), and [tests/cli](./tests/cli) — focused checker, call evaluation, interpreter frame ownership, range-reduction, type-contract, and CLI/project regressions
- [tests/parser](./tests/parser), [tests/patterns](./tests/patterns), [tests/imports](./tests/imports), [tests/interpreter-matrix](./tests/interpreter-matrix), import-pattern fixtures, and `*.expected.txt` snapshots — parser, pattern, import, interpreter, and report coverage
- `verify-*.ts`, [corpus-probes.ts](./corpus-probes.ts), [audit-demo-contracts.ts](./audit-demo-contracts.ts), [demo-contract-paths.ts](./demo-contract-paths.ts), and [snapshot.ts](./snapshot.ts) — snapshot, demo, corpus, audit, and benchmark harnesses

## Infer Tool

`bun run fr infer path/to/file.ts` is for adoption and debugging, not public annotation generation. The user-facing command behavior lives in [DOCUMENTATION.md](./DOCUMENTATION.md); this section is only the maintenance policy.

The best inference examples are snapshotted in [infer-snapshots.expected.txt](./infer-snapshots.expected.txt). Add to that file when an inferred fact becomes important enough that we would notice losing it. The local photo-gallery has its own broad all-functions snapshot in [photo-gallery-infer.expected.txt](./photo-gallery-infer.expected.txt); use that one before adding gallery annotations so source-known facts and unsupported stops are visible. Unsupported snapshots should keep the first missing root and the next distinct blocker, not every property-access echo from the same root.

Use [eval-snapshots.expected.txt](./eval-snapshots.expected.txt) for interpreter facts that are too specific for the public `infer` catalog but important during source-evaluation work: summarized literal data, IIFEs, default params, callback mutation invalidation, exact TypeScript path fallbacks, and unsupported stops.

`infer` must stay total. Recursive helper cycles should report an unsupported recursion stop. Do not recursively copy TypeScript object or array structure just to make `infer` prettier; ask TypeScript only for the exact node or path the checker is using.

Treat `infer`, `check --audit`, `audit:demos`, and normal reports as one
adoption loop: inspect what source proves, keep the human-important `@fit`
comments, then classify any remaining failure as missing input fact, unsupported
source shape, helper boundary, or real proof gap.

Do not grow TypeScript type logic just to make `infer` prettier. Keep [src/shapes.ts](./src/shapes.ts) as a small query layer over the TypeScript checker: ask for `return.rows[].height`, `input[0].height`, or the exact expression being read; do not walk a whole return type and copy every property into Freerange. Whole-value contract syntax is the narrow exception: [src/parser.ts](./src/parser.ts) lowers Freerange range leaves, then [src/value-specs.ts](./src/value-specs.ts) resolves the surrounding TypeScript type syntax just far enough to check the written contract.

Do not invent containers from a written path. `given input.width: 0..10` may attach a range only after `input.width` is already a numeric path according to TypeScript or real source evaluation. If `input` is `{}`, `input.width` is a string, or `items` is not an array, report the given as unknown instead of creating `input`, `width`, or `items[]`. Source-created values are different: `{width: 10}`, `rows.push(...)`, `items.map(...)`, and `row.width = 10` can still create facts because the JavaScript did that work.

## Selector Audit

`bun run fr check --audit path/to/file.ts` is advisory and exits like normal `check`. Keep it about cleanup that current facts prove: redundant `Math.min`, `Math.max`, exact min/max ternaries, known `if` conditions, and `??` fallbacks. This is separate from `audit:demos`, which summarizes redundant demo annotations.

## External Corpus Probes

Keep external repo experiments outside this checkout. The current scratch space
is `/Users/chenglou/github/freerange-corpus`; use isolated branches there and
bring only general Freerange fixes back into this repo.

[corpus-probes.ts](./corpus-probes.ts) discovers every source file with an `@fit` comment under the corpus root, excluding dependency and build-output trees. It groups files by top-level project and nearest `tsconfig.json`, then [corpus-probes.expected.txt](./corpus-probes.expected.txt) snapshots the exact file list plus TypeScript preflight errors or strict check summaries, including callsite `requires`. If the corpus checkout is missing, `bun run verify:corpus` skips instead of making normal repo work depend on local scratch state.

A good corpus iteration is one of two small loops:

- read-only: run `bun run fr infer file` or `bun run fr check file` on a likely helper file, then classify the first blocker as missing input fact, unsupported source shape, helper boundary, report wording, or real proof gap.
- annotation: add one or two `@fit` comments to a small numeric/layout-heavy helper, run `bun run fr check file`, classify the first blocker, then add a local pattern test before changing checker behavior.

Do not leave comments in corpus branches just to make a repo look covered. If a file is mostly async, dynamic graph mutation, or strings, the useful result may simply be "not a Freerange fit yet."

## Adding Support

[tests/patterns/patterns.ts](./tests/patterns/patterns.ts), [tests/patterns/loop-patterns.ts](./tests/patterns/loop-patterns.ts), and [tests/imports/import-patterns.ts](./tests/imports/import-patterns.ts) are the runnable catalog of good examples; loop fixtures go in loop-patterns.ts.

[tests/patterns/negative-patterns.ts](./tests/patterns/negative-patterns.ts) and [tests/imports/negative-import-patterns.ts](./tests/imports/negative-import-patterns.ts) have the bad examples. Their expected reports live in [negative-patterns.expected.txt](./negative-patterns.expected.txt).

For a new guarantee:

1. Add the smallest good pattern.
2. Add a bad pattern with a useful expected message.
3. Run:

```sh
bun run test
bun run check
```

Snapshot harnesses accept `--update` when the current behavior is the new baseline, for example `bun verify-eval-snapshots.ts --update`. Update snapshots only after reading the diff and deciding the behavior is intentional.
