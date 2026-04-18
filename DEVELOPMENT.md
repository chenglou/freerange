# Development Setup

Install once:

```sh
bun install
```

## Day-To-Day

- `bun run test` — positive patterns plus stable negative messages
- `bun run verify path/to/file.ts` — inspect one or more files and print the JSON report
- `bun run verify:first-wave` — verify the current Vibescript/Pretext first-wave demo set from sibling checkouts
- `bun run check` — typecheck plus lint

## Current Sources Of Truth

- [README.md](./README.md) — user-facing syntax and supported checker surface
- [patterns.ts](./patterns.ts) and [import-patterns.ts](./import-patterns.ts) — positive pattern specimens
- [negative-patterns.ts](./negative-patterns.ts) and [negative-import-patterns.ts](./negative-import-patterns.ts) — intentionally bad patterns
- [negative-patterns.expected.txt](./negative-patterns.expected.txt) — stable negative report output
- [todo.md](./todo.md) — current priorities and limitations
- [research.md](./research.md) — durable direction notes

## Important Files

- [src/check.ts](./src/check.ts) — source evaluator and contract orchestration
- [src/domain.ts](./src/domain.ts) — abstract values, number/array domains, and value joins
- [src/linear.ts](./src/linear.ts) — linear expressions, expression normalization, and reduction helpers
- [src/proof.ts](./src/proof.ts) — range/comparison proofs, math lemmas, and assumption reduction
- [src/modules.ts](./src/modules.ts) — source loading, TypeScript-backed import resolution, and export/import indexing
- [src/parser.ts](./src/parser.ts) — strict `@fit` parser
- [src/reporting.ts](./src/reporting.ts) — failure context and report formatting
- [verify.ts](./verify.ts) — ad hoc JSON-report CLI
- [verify-first-wave-demos.ts](./verify-first-wave-demos.ts) — local sibling-demo verification runner
- [test.ts](./test.ts) — pattern-suite runner
- [import-pattern-helpers.ts](./import-pattern-helpers.ts), [import-pattern-barrel.ts](./import-pattern-barrel.ts), [import-pattern-tsx-helpers.tsx](./import-pattern-tsx-helpers.tsx), [negative-import-helpers.ts](./negative-import-helpers.ts), and [negative-import-barrel.ts](./negative-import-barrel.ts) — small imported-helper fixtures
- [research/kernels](./research/kernels) — future pressure examples, not checked as guarantees yet
