# Development Setup

Install once:

```sh
bun install
```

## Day-To-Day

- `bun run test` — positive patterns plus stable negative messages
- `bun run verify path/to/file.ts` — inspect one or more files and print the JSON report
- `bun check` — typecheck plus lint

## Current Sources Of Truth

- [README.md](./README.md) — user-facing syntax and supported checker surface
- [patterns.ts](./patterns.ts) — positive pattern specimen
- [negative-patterns.ts](./negative-patterns.ts) — intentionally bad patterns
- [negative-patterns.expected.txt](./negative-patterns.expected.txt) — stable negative report output
- [todo.md](./todo.md) — current priorities and limitations
- [research.md](./research.md) — durable direction notes

## Important Files

- [src/check.ts](./src/check.ts) — source evaluator, abstract domains, and proof rules
- [src/parser.ts](./src/parser.ts) — strict `@fit` parser
- [src/reporting.ts](./src/reporting.ts) — failure context and report formatting
- [verify.ts](./verify.ts) — ad hoc JSON-report CLI
- [test.ts](./test.ts) — pattern-suite runner
- [research/kernels](./research/kernels) — future pressure examples, not checked as guarantees yet
