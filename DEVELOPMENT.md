# Development Setup

```sh
bun install
```

## Day-To-Day

- `bun run test` — positive patterns, stable negative messages, and curated inference snapshots
- `bun run test:parser` — focused parser-layer checks for contract syntax classification and TS type lowering
- `bun run fr --help` — print the CLI command shapes
- `bun run fr check path/to/file.ts` — check one or more files and print only failures plus a pass/fail/requires/unknown summary
- `bun run fr check` — read the nearest `tsconfig.json`, like `tsc`, and check those source files
- `bun run fr check --annotations-only path/to/file.ts` — quieter local pass that proves written annotations without the broad callsite scan
- `bun run fr check --audit path/to/file.ts` — advisory cleanup for redundant `Math.min`, `Math.max`, exact min/max ternary choices, always-known `if` conditions, and redundant `??` fallbacks; composes with `--annotations-only`
- `bun run fr infer path/to/file.ts` — main CLI view of inferred facts, explicit checks, redundancy, and unsupported proof spots for every function in a file; add `--function name` for one function, or `--annotations-only` for the quieter annotated-function view
- `bun run shape-diff path/to/file.ts --function name` — dev-only comparison of evaluated Freerange shape and TypeScript-only shape; add `--calls` when raw call-return types matter
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
- [tests/patterns/patterns.ts](./tests/patterns/patterns.ts) and [tests/imports/import-patterns.ts](./tests/imports/import-patterns.ts) — positive pattern specimens
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

- [src/parser.ts](./src/parser.ts), [src/value-specs.ts](./src/value-specs.ts), [src/check-specs.ts](./src/check-specs.ts), [src/givens.ts](./src/givens.ts), [src/function-contracts.ts](./src/function-contracts.ts), and [src/function-call-contracts.ts](./src/function-call-contracts.ts) — parsing, whole-value type syntax, input assumptions, contract collection, and helper-call requirements
- [src/interpreter/](./src/interpreter), [src/function-evaluation.ts](./src/function-evaluation.ts), [src/function-inputs.ts](./src/function-inputs.ts), [src/interpreter-state.ts](./src/interpreter-state.ts), and [src/function-shape.ts](./src/function-shape.ts) — source evaluation, function setup, `this`, nested functions, and helper-call recording
- [src/modules.ts](./src/modules.ts), [src/module-values.ts](./src/module-values.ts), [src/program-env.ts](./src/program-env.ts), and [src/shapes.ts](./src/shapes.ts) — TypeScript-backed file loading, imports, top-level constants, and structural shape fallback

Facts, values, and proof:

- [src/domain-types.ts](./src/domain-types.ts), [src/value-domain.ts](./src/value-domain.ts), [src/number-domain.ts](./src/number-domain.ts), [src/array-summary.ts](./src/array-summary.ts), [src/domain-paths.ts](./src/domain-paths.ts), and [src/domain.ts](./src/domain.ts) — abstract values, numeric ranges, arrays, paths, and the compatibility facade
- [src/facts.ts](./src/facts.ts), [src/assumptions.ts](./src/assumptions.ts), [src/constraint-reachability.ts](./src/constraint-reachability.ts), [src/linear.ts](./src/linear.ts), [src/proof.ts](./src/proof.ts), and [src/proof-rules.ts](./src/proof-rules.ts) — published facts, assumptions, linear expressions, and comparison proof rules
- [src/indexed-facts.ts](./src/indexed-facts.ts), [src/sequence-facts.ts](./src/sequence-facts.ts), [src/bound-index.ts](./src/bound-index.ts), [src/loop-source.ts](./src/loop-source.ts), and [src/loop-summary.ts](./src/loop-summary.ts) — index, adjacent sequence, and loop facts

Dev tools and harnesses:

- [shape-diff.ts](./shape-diff.ts), [src/shape-inspect.ts](./src/shape-inspect.ts), [bench.ts](./bench.ts), and [bench-core.ts](./bench-core.ts) — dev-only shape and timing tools
- [test.ts](./test.ts), [parser-tests.ts](./parser-tests.ts), [tests/patterns/patterns.ts](./tests/patterns/patterns.ts), [tests/patterns/negative-patterns.ts](./tests/patterns/negative-patterns.ts), import-pattern fixtures, and `*.expected.txt` snapshots — parser, pattern, and report coverage
- `verify-*.ts`, [corpus-probes.ts](./corpus-probes.ts), [audit-demo-contracts.ts](./audit-demo-contracts.ts), [demo-contract-paths.ts](./demo-contract-paths.ts), and [snapshot.ts](./snapshot.ts) — snapshot, demo, corpus, audit, and benchmark harnesses

## Infer Tool

`bun run fr infer path/to/file.ts` is for adoption and debugging, not public annotation generation. The user-facing command behavior lives in [DOCUMENTATION.md](./DOCUMENTATION.md); this section is only the maintenance policy.

The best inference examples are snapshotted in [infer-snapshots.expected.txt](./infer-snapshots.expected.txt). Add to that file when an inferred fact becomes important enough that we would notice losing it. The local photo-gallery has its own broad all-functions snapshot in [photo-gallery-infer.expected.txt](./photo-gallery-infer.expected.txt); use that one before adding gallery annotations so source-known facts and unsupported stops are visible. Unsupported snapshots should keep the first missing root and the next distinct blocker, not every property-access echo from the same root.

Use [eval-snapshots.expected.txt](./eval-snapshots.expected.txt) for interpreter facts that are too specific for the public `infer` catalog but important during source-evaluation work: summarized literal data, IIFEs, default params, callback mutation invalidation, shape fallbacks, and unsupported stops.

`infer` must stay total. Recursive helper cycles should report an unsupported recursion stop and fall back to TypeScript shape when available; TypeScript shape reading is also depth/width/node bounded.

Treat `infer`, `check --audit`, `audit:demos`, and normal reports as one
adoption loop: inspect what source proves, keep the human-important `@fit`
comments, then classify any remaining failure as missing input fact, unsupported
source shape, helper boundary, or real proof gap.

Do not grow TypeScript type logic just to make `infer` or `shape-diff` prettier. Keep `src/shapes.ts` as a small, bounded structural adapter over the TypeScript checker; do not recreate TypeScript's type system inside Freerange. Whole-value contract syntax is the narrow exception: `src/parser.ts` lowers Freerange range leaves, then `src/value-specs.ts` resolves the surrounding TypeScript type syntax just far enough to check the written contract.

## Selector Audit

`bun run fr check --audit path/to/file.ts` is advisory and exits like normal `check`. Keep it about cleanup that current facts prove: redundant `Math.min`, `Math.max`, exact min/max ternaries, known `if` conditions, and `??` fallbacks. This is separate from `audit:demos`, which summarizes redundant demo annotations.

## External Corpus Probes

Keep external repo experiments outside this checkout. The current scratch space
is `/Users/chenglou/github/freerange-corpus`; use isolated branches there and
bring only general Freerange fixes back into this repo.

[corpus-probes.ts](./corpus-probes.ts) discovers every source file with an `@fit` comment under the corpus root, excluding dependency and build-output trees. It groups files by top-level project and nearest `tsconfig.json`, then [corpus-probes.expected.txt](./corpus-probes.expected.txt) snapshots the exact file list plus strict check summaries, including callsite `requires`. If the corpus checkout is missing, `bun run verify:corpus` skips instead of making normal repo work depend on local scratch state.

A good corpus iteration is one of two small loops:

- read-only: run `bun run fr infer file` or `bun run fr check file` on a likely helper file, then classify the first blocker as missing input fact, unsupported source shape, helper boundary, report wording, or real proof gap.
- annotation: add one or two `@fit` comments to a small numeric/layout-heavy helper, run `bun run fr check file`, classify the first blocker, then add a local pattern test before changing checker behavior.

Do not leave comments in corpus branches just to make a repo look covered. If a file is mostly async, dynamic graph mutation, or strings, the useful result may simply be "not a Freerange fit yet."

## Shape Diff Tool

`bun run shape-diff path/to/file.ts --function name` compares object/array structure Freerange kept with structure TypeScript can see. It answers a narrower question than `infer`: did Freerange lose because it did not know a shape TypeScript already knew?

Raw call-return probing is opt-in with `--calls`, because calls are often consumed by a later local or return value. These facts are about shape, not proof. Seeing `shape.rows[].height: number` means the field exists as a number; it does not mean the checker knows `height: 0..40`.

Use this when a report says a property or array path is unknown. If `shape-diff` sees the structure, the blocker is likely proof logic or missing input facts. If `shape-diff` does not see it, the blocker is still shape reading. The TypeScript walk has depth/width limits on purpose, so huge parser/library types are declined instead of turning the tool into a second checker.

## Adding Support

[tests/patterns/patterns.ts](./tests/patterns/patterns.ts) and [tests/imports/import-patterns.ts](./tests/imports/import-patterns.ts) are the runnable catalog of good examples.

[tests/patterns/negative-patterns.ts](./tests/patterns/negative-patterns.ts) and [tests/imports/negative-import-patterns.ts](./tests/imports/negative-import-patterns.ts) have the bad examples. Their expected reports live in [negative-patterns.expected.txt](./negative-patterns.expected.txt).

For a new guarantee:

1. Add the smallest good pattern.
2. Add a bad pattern with a useful expected message.
3. Run:

```sh
bun run test
bun run check
```

Before adding a public name, write down:

- what it means
- what it does not imply
- what source shape proves it
- what the report should say when it fails
- why the name is not demo-specific

Prefer better source inference before more public syntax. If ordinary TypeScript already says the thing clearly, make Freerange understand that code instead of asking the user to write a cleverer comment.

Snapshot harnesses accept `--update` when the current behavior is the new baseline, for example `bun verify-eval-snapshots.ts --update`. Update snapshots only after reading the diff and deciding the behavior is intentional.
