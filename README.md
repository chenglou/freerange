# Freerange

Static `@fit` checks for ordinary TypeScript.

Freerange reads your function source and nearby `@fit` comments. It proves the requested facts from the code, or tells you where it cannot. No browser, screenshots, traces, sampled cases, fixtures, or app-code execution. Just source in, facts out.

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
 * result.capped: 0..320
 * result.overflow >= 0
 */
function cappedOverflow(
  width: number, // @fit 0..1000
) {
  const capped = Math.min(width, 320)
  return {capped, overflow: width - capped}
}
```

Param `// @fit` comments are input facts, the same as `given width: 0..1000` in the function block. Bare lines and `result` lines are facts Freerange must prove from source.

For one local value, use the small inline form:

```ts
// @fit int 0..count
const index = Math.floor(pointer / cellSize)
const next = index + 1 // @fit int 1..count
const exact = clamp(4, 2, 3) // @fit 2
return {
  width: container - padding * 2, // @fit 0..1200
}
```

## Run A File

```sh
fr check path/to/file.ts
```

Run `fr check` without file args to read the nearest `tsconfig.json`, like `tsc`.
Use `fr doctor` when adopting Freerange into existing code and you want a broad
call-precondition scan instead of only claimed specs.

Read [DOCUMENTATION.md](./DOCUMENTATION.md) for the language guide, glossary, and adoption playbook.

Read [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, tests, demo checks, and repo notes.
