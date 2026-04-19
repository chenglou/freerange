# Development Setup

Install once:

```sh
bun install
```

## Day-To-Day

- `bun run test` — positive patterns, stable negative messages, and curated inference snapshots
- `bun run verify path/to/file.ts` — inspect one or more files and print the JSON report
- `bun run infer path/to/file.ts --function name` — dev-only x-ray of source-proved result/local facts and loop-local facts
- `bun run shape-diff path/to/file.ts --function name` — dev-only comparison of Freerange's structural shape and TypeScript-only shape
- `bun run verify:demos` — verify the current checked Vibescript/Pretext demo contracts from sibling checkouts
- `bun run check` — pattern tests, demo contracts, typecheck, and lint

## Current Sources Of Truth

- [README.md](./README.md) — short project front door
- [DOCUMENTATION.md](./DOCUMENTATION.md) — user-facing syntax, glossary, adoption guide, and supported checker surface
- [patterns.ts](./patterns.ts) and [import-patterns.ts](./import-patterns.ts) — positive pattern specimens
- [negative-patterns.ts](./negative-patterns.ts) and [negative-import-patterns.ts](./negative-import-patterns.ts) — intentionally bad patterns
- [negative-patterns.expected.txt](./negative-patterns.expected.txt) — stable negative report output
- [infer-snapshots.expected.txt](./infer-snapshots.expected.txt) — stable dev-only inferred-facts snapshots
- [todo.md](./todo.md) — current priorities and limitations
- [research.md](./research.md) — durable direction notes

## Important Files

- [src/check.ts](./src/check.ts) — source evaluator and contract orchestration
- [src/domain.ts](./src/domain.ts) — abstract values, number/array domains, and value joins
- [src/linear.ts](./src/linear.ts) — linear expressions, expression normalization, and reduction helpers
- [src/proof.ts](./src/proof.ts) — range/comparison proofs, math lemmas, and assumption reduction
- [src/proof-rules.ts](./src/proof-rules.ts) — small named comparison proof rules with shared prove/report obligations
- [src/modules.ts](./src/modules.ts) — source loading, TypeScript-backed import resolution, and export/import indexing
- [src/shapes.ts](./src/shapes.ts) — the small shape-provider boundary over syntactic TS types and TypeScript checker types
- [src/parser.ts](./src/parser.ts) — strict `@fit` parser
- [src/reporting.ts](./src/reporting.ts) — failure context and report formatting
- [verify.ts](./verify.ts) — ad hoc JSON-report CLI
- [infer.ts](./infer.ts) — dev-only inferred-facts CLI
- [shape-diff.ts](./shape-diff.ts) — dev-only TypeScript shape piggyback diagnostic
- [verify-demo-contracts.ts](./verify-demo-contracts.ts) — local sibling-demo contract runner
- [test.ts](./test.ts) — pattern-suite runner
- [import-pattern-helpers.ts](./import-pattern-helpers.ts), [import-pattern-barrel.ts](./import-pattern-barrel.ts), [import-pattern-tsx-helpers.tsx](./import-pattern-tsx-helpers.tsx), [negative-import-helpers.ts](./negative-import-helpers.ts), and [negative-import-barrel.ts](./negative-import-barrel.ts) — small imported-helper fixtures
- [research/kernels](./research/kernels) — future pressure examples, not checked as guarantees yet

## Infer Tool

`bun run infer path/to/file.ts --function name` is for us, not public annotation generation. It prints curated facts the checker already knows:

- `result` facts from the returned value
- `locals` from locals that survive to the return
- loop-local facts for supported loops marked with `@fit`

Loop output separates explicit loop comment lines into:

- `trusted` — valid loop `given` lines
- `source-proved` — local loop checks proven from source
- `not-inferred` — checks Freerange could not prove
- `redundant` — source-proved loop checks that can be omitted if the author only wanted a local checkpoint

The best inference examples are snapshotted in [infer-snapshots.expected.txt](./infer-snapshots.expected.txt). Add to that file when an inferred fact becomes important enough that we would notice losing it.

Do not grow TypeScript type logic just to make `infer` or `shape-diff` prettier. Keep `src/shapes.ts` as a small structural adapter over the TypeScript checker; do not recreate TypeScript's type system inside Freerange.

## Shape Diff Tool

`bun run shape-diff path/to/file.ts --function name` is the TS piggyback x-ray. It answers a narrower question than `infer`: did Freerange lose because it did not know an object/array shape that TypeScript already knew?

It prints TypeScript-only structural facts for params, locals, return shapes, and call returns. These facts are about shape, not proof. Seeing `shape.rows[].height: number` means the field exists as a number; it does not mean the checker knows `height: 0..40`.

Use this when a report says a property or array path is unknown. If `shape-diff` sees the structure, the blocker is likely proof logic or missing input facts. If `shape-diff` does not see it, the blocker is still shape reading.

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
