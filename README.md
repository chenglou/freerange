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

Under the hood, Freerange abstract-interprets a small, boring TypeScript subset. Source, checked helper/type contracts, and explicit `given` facts can earn proofs; unsupported source becomes `unknown`, not a guessed pass.

## Run A File

The command-line binary is `fr`:

```sh
fr check path/to/file.ts
```

Run `fr --help` for the command shapes.
Run `fr check` without file args to read the nearest `tsconfig.json`, like `tsc`.
Use `fr check --annotations-only` when you want the quieter local pass that only
proves the annotations where they are written.
Use `fr check --audit` when you want advisory cleanup for redundant selector
guards like `Math.min`, `Math.max`, and exact min/max ternaries.
Use `fr infer path/to/file.ts` when you want inferred facts for every function in
that file: what Freerange found, which explicit checks they cover, and where
proof stopped. Add `--annotations-only` for the quieter annotated-function view,
or `--function name` for one function.

See [DOCUMENTATION.md](./DOCUMENTATION.md) for the language guide, glossary, and adoption playbook.

See [STATIC-ANALYZER-BLUEPRINT.md](./STATIC-ANALYZER-BLUEPRINT.md) for the broader thesis behind Freerange-style analyzers.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, tests, demo checks, and repo notes.
