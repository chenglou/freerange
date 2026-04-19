# Freerange

Static `@fit` checks for ordinary TypeScript.

Freerange reads your function source and the `@fit` comment above it. It proves the comment from the code, or tells you where it cannot. No browser, screenshots, traces, sampled cases, fixtures, or app-code execution. Just source in, facts out.

The first useful surface is layout math:

```ts
row.top + row.height <= parent.bottom
rows.length == items.length
rows[].height: 0..40
nondecreasing(rows.top)
spaced(rows, gap)
extentEnd(rows, top) == bottom
```

But the project is not only about layout. The bigger goal is checkable specs over ordinary UI code: enough formal shape that agents can generate and edit code against real constraints instead of guessing from screenshots.

## First Check

Put `@fit` immediately above a function declaration:

```ts
/** @fit
 * given width: 0..1000
 * result.capped: 0..320
 * result.overflow >= 0
 */
function cappedOverflow(width: number) {
  const capped = Math.min(width, 320)
  return {capped, overflow: width - capped}
}
```

`given` lines describe inputs your function expects. Bare lines are facts Freerange must prove from source.

## Run A File

In this repo today:

```sh
bun run verify path/to/file.ts
```

Read [DOCUMENTATION.md](./DOCUMENTATION.md) for the language guide, glossary, and adoption playbook.

Read [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, tests, demo checks, and repo notes.
