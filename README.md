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

Run `fr --help` for the command shapes.
Run `fr check` without file args to read the nearest `tsconfig.json`, like `tsc`.
Freerange stops on normal TypeScript errors before proving contracts and prints them like TypeScript. TypeScript errors inside `@fit` lines are reported on those contracts and stop proof work for that function or top-level block.
Use `fr check --annotations-only` when you want the quieter local pass that only proves the annotations where they are written.
Use `fr check --audit` when you want advisory cleanup for redundant selector guards like `Math.min`, `Math.max`, exact min/max ternaries, always-known `if` conditions, and `??` fallbacks whose left side is already present.
Use `fr infer path/to/file.ts` when you want inferred facts for every function in that file: what Freerange found, which explicit checks they cover, and where proof stopped. Add `--annotations-only` for the quieter annotated-function view, or `--function name` for one function. Use no-path `fr infer --all` when you want a project summary instead of a per-function dump.

See [DOCUMENTATION.md](./DOCUMENTATION.md) for more.
