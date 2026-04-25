# Freerange

Freerange lets you augment your regular TypeScript code with comments that state numerical properties:

```ts
/** @fit
 * given min <= max
 * return >= min
 * return <= max
 */
export function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Freerange catches this: the result can be 2.
const opacity = clamp(0, 10, 2) // @fit 0..1
```

It then **statically** checks those numbers, just like TypeScript, to ensure your codebase doesn't violate those properties!
- eliminates most of off-by-one, divide-by-zero, and runtime number checks
- your layout code can now guarantee e.g. min/max sizes, no overlap, proper occlusion (virtualization) without visual glitches. No more weird squashed mobile layouts!
- refactors get clear red lines: if someone changes the math, Freerange tells you which contract stopped being true

## Run A File

The command-line binary is `fr`:

```sh
fr check path/to/file.ts
```

Run `fr check` without file args to read the nearest `tsconfig.json`, like `tsc`.
Use `fr check --calls` when you want the normal claim gate plus the broad
call-precondition scan. `fr doctor` runs only that callsite scan during adoption.
Use `fr infer --function name path/to/file.ts` when you want the x-ray: the facts
source already proves, the explicit checks it covers, and the spots where proof
stopped.

See [DOCUMENTATION.md](./DOCUMENTATION.md) for the language guide, glossary, and adoption playbook.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, tests, demo checks, and repo notes.
