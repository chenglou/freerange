# Development Setup

Install once:

```sh
bun install
```

## Day-To-Day

- `bun run test` — positive patterns, stable negative messages, and curated inference snapshots
- `bun run fr --help` — print the CLI command shapes
- `bun run fr check path/to/file.ts` — check one or more files and print only failures plus a pass/fail/requires/unknown summary
- `bun run fr check` — read the nearest `tsconfig.json`, like `tsc`, and check those source files
- `bun run fr check --annotations-only path/to/file.ts` — quieter local pass that proves written annotations without the broad callsite scan
- `bun run fr check --audit path/to/file.ts` — advisory selector cleanup for redundant `Math.min`, `Math.max`, and exact min/max ternary choices; composes with `--annotations-only`
- `bun run fr infer path/to/file.ts` — main CLI view of inferred facts, explicit checks, redundancy, and unsupported proof spots
- `bun run shape-diff path/to/file.ts --function name` — dev-only comparison of evaluated Freerange shape and TypeScript-only shape; add `--calls` when raw call-return types matter
- `bun run bench -- --runs 3` — dev-only timing for the current sibling demo contract set, including cold load, warmed load/verify medians, and a load-phase split; pass files to time a custom set
- `bun run verify:demos` — verify the current checked Vibescript/Pretext demo contracts from sibling checkouts
- `bun run verify:photo-gallery` — snapshot `fr infer --all` over the local photo-gallery so annotation work starts from source facts and unsupported stops
- `bun run verify:eval` — curated interpreter-adjacent snapshots for facts, shapes, and unsupported stops we do not want to lose during source-evaluation work
- `bun run verify:interpreter` — run the interpreter on focused kernels and snapshot the abstract return values it builds
- `bun run verify:corpus` — reproducible external corpus sweep over every `@fit` source file when `/Users/chenglou/github/freerange-corpus` is present
- `bun run verify:bench` — loose warmed performance guard for demo-contract load and verification time
- `bun run audit:demos` — summarize which demo `@fit` checks are likely-removable redundant noise versus public-looking explicit contracts
- `bun run check` — full local gate: pattern tests, demo contracts, eval/interpreter/corpus/bench snapshots, typecheck, and lint

## Current Sources Of Truth

- [README.md](./README.md) — short project front door
- [DOCUMENTATION.md](./DOCUMENTATION.md) — user-facing syntax, glossary, adoption guide, and supported checker surface
- [STATIC-ANALYZER-BLUEPRINT.md](./STATIC-ANALYZER-BLUEPRINT.md) — user-facing architecture thesis for Freerange-style analyzers
- [patterns.ts](./patterns.ts) and [import-patterns.ts](./import-patterns.ts) — positive pattern specimens
- [negative-patterns.ts](./negative-patterns.ts) and [negative-import-patterns.ts](./negative-import-patterns.ts) — intentionally bad patterns
- [negative-patterns.expected.txt](./negative-patterns.expected.txt) — stable negative report output
- [infer-snapshots.expected.txt](./infer-snapshots.expected.txt) — stable dev-only inferred-facts snapshots
- [demo-contracts.expected.txt](./demo-contracts.expected.txt), [photo-gallery-infer.expected.txt](./photo-gallery-infer.expected.txt), [eval-snapshots.expected.txt](./eval-snapshots.expected.txt), [interpreter-snapshots.expected.txt](./interpreter-snapshots.expected.txt), and [corpus-probes.expected.txt](./corpus-probes.expected.txt) — stable harness snapshots for demos, the local photo-gallery infer inventory, interpreter-adjacent facts, focused interpreter kernels, and the external corpus sweep
- [todo.md](./todo.md) — current priorities and limitations
- [research.md](./research.md) — durable direction notes

## Important Files

- [src/check-core.ts](./src/check-core.ts) — checker, contract, report, `infer`, and callsite-check orchestration around the interpreter
- [src/check-types.ts](./src/check-types.ts) — shared check/report/eval flow types
- [src/ambient-facts.ts](./src/ambient-facts.ts) — tiny type-backed facts for browser-owned DOM layout dimensions
- [src/function-contracts.ts](./src/function-contracts.ts) — function-level contract collection and type-boundary detection
- [src/function-call-contracts.ts](./src/function-call-contracts.ts) — helper-call precondition reports and checked contract summaries
- [src/function-inputs.ts](./src/function-inputs.ts) — function parameter binding, argument binding, and typed input fallback shapes
- [src/givens.ts](./src/givens.ts) — `given` validation, contradiction checks, and assumption seeding
- [src/domain-paths.ts](./src/domain-paths.ts) — reusable reads/writes for Freerange domain paths inside abstract values
- [src/shape-inspect.ts](./src/shape-inspect.ts) — dev-only shape comparison built from interpreter values and typed facts, not reparsed report strings
- [src/interpreter/](./src/interpreter) — abstract interpreter core, scope helpers, source-shape readers, branch refinement, loop effects/value transforms, `Math` primitives, value-path writes, and value-tree snapshot formatting
- [src/interpreter/audit.ts](./src/interpreter/audit.ts) — advisory pure-selector audit for redundant min/max-style choices
- [src/interpreter/forgettable-loop.ts](./src/interpreter/forgettable-loop.ts) — conservative root invalidation for read-only unsupported loop shapes
- [src/binding-patterns.ts](./src/binding-patterns.ts) — source binding-pattern traversal helpers used by interpreter inputs and local bindings
- [src/function-shape.ts](./src/function-shape.ts) — function source-shape helpers for input roots, `this`, and nested-body boundaries
- [src/interpreter-state.ts](./src/interpreter-state.ts) — checker/interpreter bridge types for evaluated state and helper-call recording
- [src/module-values.ts](./src/module-values.ts) — top-level `const` literal reader used during module loading
- [src/program-env.ts](./src/program-env.ts) — global/import environment bootstrapping for interpreter source evaluation
- [src/source-expressions.ts](./src/source-expressions.ts) — source expression root/path helpers shared by givens, mutation, and call invalidation
- [src/value-localize.ts](./src/value-localize.ts) — abstract value relabeling for parameters, imports, and wildcard element paths
- [src/source-boundary.ts](./src/source-boundary.ts) — source line and check-boundary helpers
- [src/check-specs.ts](./src/check-specs.ts) — already-parsed `@fit` spec proof and range-expression helpers
- [src/facts.ts](./src/facts.ts) — typed inferred facts used by `infer`, redundancy checks, and the internal fact layer
- [src/guarded-facts.ts](./src/guarded-facts.ts) — branch guard truth, finite case refinement, and number-case transfer helpers
- [src/indexed-facts.ts](./src/indexed-facts.ts) — finite index specialization, symbolic element-path rebasing, and local adjacent-neighbor facts
- [src/sequence-facts.ts](./src/sequence-facts.ts) — adjacent sequence relation queries and rendering
- [src/loop-source.ts](./src/loop-source.ts) — TypeScript loop source readers for pushes, guards, scalar updates, extrema, and indexed loop shape
- [src/loop-summary.ts](./src/loop-summary.ts) — internal loop append streams, scalar updates, recurrences, and derived sequence summaries
- [src/reports.ts](./src/reports.ts) — check report runners and file/source entrypoints
- [src/infer-output.ts](./src/infer-output.ts) — pretty-printer for `fr infer`
- [src/infer-report.ts](./src/infer-report.ts) — inferred-spec status, redundancy, and unsupported-result helpers
- [src/call-site-text.ts](./src/call-site-text.ts) — call-site expression text rebasing for helper summaries and call reports
- [src/domain.ts](./src/domain.ts) — abstract values, number/array domains, and value joins
- [src/linear.ts](./src/linear.ts) — linear expressions, expression normalization, and reduction helpers
- [src/proof.ts](./src/proof.ts) — range/comparison proofs, math lemmas, and assumption reduction
- [src/proof-rules.ts](./src/proof-rules.ts) — small named comparison proof rules with shared prove/report obligations
- [src/modules.ts](./src/modules.ts) — source loading, TypeScript-backed import resolution, import-to-source declaration binding, and static helper-binding indexing
- [src/shapes.ts](./src/shapes.ts) — the small shape-provider boundary over syntactic TS types and TypeScript checker types
- [src/parser.ts](./src/parser.ts) — strict `@fit` parser
- [src/bound-index.ts](./src/bound-index.ts) — same-index labels and adjacent-label spec checks backed by sequence facts
- [src/reporting.ts](./src/reporting.ts) — failure context and report formatting
- [fr.ts](./fr.ts) — main CLI entrypoint
- [shape-diff.ts](./shape-diff.ts) — dev-only TypeScript shape comparison diagnostic
- [bench.ts](./bench.ts) — dev-only coarse timing helper
- [bench-core.ts](./bench-core.ts) — shared benchmark runner used by `bench` and the budget guard
- [verify-demo-contracts.ts](./verify-demo-contracts.ts) — local sibling-demo contract runner
- [verify-photo-gallery-infer-snapshots.ts](./verify-photo-gallery-infer-snapshots.ts) — local photo-gallery `infer --all` snapshot runner
- [verify-eval-snapshots.ts](./verify-eval-snapshots.ts) — interpreter-adjacent golden snapshot runner
- [verify-interpreter-snapshots.ts](./verify-interpreter-snapshots.ts) — focused interpreter value/fact/unsupported snapshot runner
- [verify-corpus-probes.ts](./verify-corpus-probes.ts), [corpus-probes.ts](./corpus-probes.ts) — reproducible external corpus sweep runner and discovery rules
- [verify-bench-budget.ts](./verify-bench-budget.ts) — loose warmed performance budget guard for the demo verifier
- [snapshot.ts](./snapshot.ts) — tiny snapshot compare/update helper for dev-only harnesses
- [audit-demo-contracts.ts](./audit-demo-contracts.ts) — local sibling-demo annotation audit
- [demo-contract-paths.ts](./demo-contract-paths.ts) — shared sibling-demo path list
- [test.ts](./test.ts) — pattern-suite runner
- [import-pattern-helpers.ts](./import-pattern-helpers.ts), [import-pattern-alias-helpers.ts](./import-pattern-alias-helpers.ts), [import-pattern-barrel.ts](./import-pattern-barrel.ts), [import-pattern-tsx-helpers.tsx](./import-pattern-tsx-helpers.tsx), [import-pattern-declared-package](./import-pattern-declared-package), [import-pattern-declared-package-no-map](./import-pattern-declared-package-no-map), [negative-import-helpers.ts](./negative-import-helpers.ts), and [negative-import-barrel.ts](./negative-import-barrel.ts) — small imported-helper fixtures
- [research/kernels](./research/kernels) — future pressure examples, not checked as guarantees yet

## Infer Tool

`bun run fr infer path/to/file.ts` is for us and for adoption-minded agents, not public annotation generation. It prints facts the checker already knows for every function in that file. Add `--function name` for one function, or `--annotations-only` for the quieter annotated-function view:

- `return` facts from the returned value
- `locals` from locals that survive to the return
- loop-local facts for supported loops marked with `@fit`

It also separates explicit function and loop comment lines into:

- `assumptions` — valid `given` lines
- `checked` — explicit checks proven from source
- `not-inferred` — checks Freerange could not prove
- `redundant` — checked claims already covered by emitted inferred facts, with the covering fact printed

`redundant` is intentionally narrow: it means the emitted inferred facts already cover the explicit check. Treat it as a deletion or summary candidate, not an automatic cleanup command. Sometimes an explicit line is worth keeping because it is the public contract a reader should see.

The best inference examples are snapshotted in [infer-snapshots.expected.txt](./infer-snapshots.expected.txt). Add to that file when an inferred fact becomes important enough that we would notice losing it. The local photo-gallery has its own broad all-functions snapshot in [photo-gallery-infer.expected.txt](./photo-gallery-infer.expected.txt); use that one before adding gallery annotations so source-known facts and unsupported stops are visible. Unsupported snapshots should keep the first missing root and the next distinct blocker, not every property-access echo from the same root. No-arg `fr infer` asks for a file path; no-arg `fr infer --all` remains a project-wide debug inventory until we replace it with a summary view.

Use [eval-snapshots.expected.txt](./eval-snapshots.expected.txt) for interpreter facts that are too specific for the public `infer` catalog but important during source-evaluation work: summarized literal data, IIFEs, default params, callback mutation invalidation, shape fallbacks, and unsupported stops.

`infer` must stay total. Recursive helper cycles should report an unsupported recursion stop and fall back to TypeScript shape when available; TypeScript shape reading is also depth/width/node bounded.

Treat `infer`, `check --audit`, `audit:demos`, and normal reports as one
adoption loop: inspect what source proves, keep the human-important `@fit`
comments, then classify any remaining failure as missing input fact, unsupported
source shape, helper boundary, or real proof gap.

Do not grow TypeScript type logic just to make `infer` or `shape-diff` prettier. Keep `src/shapes.ts` as a small, bounded structural adapter over the TypeScript checker; do not recreate TypeScript's type system inside Freerange.

## Selector Audit

`bun run fr check --audit path/to/file.ts` is advisory and exits like normal `check`: today it reports `Math.min`, `Math.max`, and exact min/max-shaped ternaries where a guard value or branch cannot affect the result. `--annotations-only --audit` keeps the annotated-function surface. This is separate from `audit:demos`, which summarizes redundant demo annotations.

## External Corpus Probes

Keep external repo experiments outside this checkout. The current scratch space
is `/Users/chenglou/github/freerange-corpus`; use isolated branches there and
bring only general Freerange fixes back into this repo.

[corpus-probes.ts](./corpus-probes.ts) discovers every source file with an `@fit` comment under the corpus root, excluding dependency and build-output trees. It groups files by top-level project and nearest `tsconfig.json`, then [corpus-probes.expected.txt](./corpus-probes.expected.txt) snapshots the exact file list plus strict check summaries, including callsite `requires`. If the corpus checkout is missing, `bun run verify:corpus` skips instead of making normal repo work depend on local scratch state.

A good corpus iteration is one of two small loops:

- read-only: run `bun run fr infer file` or `bun run fr check file` on a likely helper file, then classify the first blocker as missing input fact, unsupported source shape, helper boundary, report wording, or real proof gap.
- annotation: add one or two `@fit` comments to a small numeric/layout-heavy helper, run `bun run fr check file`, classify the first blocker, then add a local pattern test before changing checker behavior.

Do not leave comments in corpus branches just to make a repo look covered. If a
file is mostly DOM, async, dynamic graph mutation, strings, or browser-owned
measurement, the useful result may simply be "not a Freerange seam yet."

## Shape Diff Tool

`bun run shape-diff path/to/file.ts --function name` compares object/array
structure Freerange kept with structure TypeScript can see. It answers a
narrower question than `infer`: did Freerange lose because it did not know an
object/array shape that TypeScript already knew?

It compares TypeScript shape against evaluated Freerange shape for params, locals, and returns. Raw call-return probing is opt-in with `--calls`, because calls are often consumed by a later local or return value. These facts are about shape, not proof. Seeing `shape.rows[].height: number` means the field exists as a number; it does not mean the checker knows `height: 0..40`.

Use this when a report says a property or array path is unknown. If `shape-diff` sees the structure, the blocker is likely proof logic or missing input facts. If `shape-diff` does not see it, the blocker is still shape reading. The TypeScript walk has depth/width limits on purpose, so huge parser/library types are declined instead of turning the tool into a second checker.

## Adding Support

[patterns.ts](./patterns.ts) and [import-patterns.ts](./import-patterns.ts) are the runnable catalog of good examples.

[negative-patterns.ts](./negative-patterns.ts) and [negative-import-patterns.ts](./negative-import-patterns.ts) have the bad examples. Their expected reports live in [negative-patterns.expected.txt](./negative-patterns.expected.txt).

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
