We expect many more userland static analyzers in the future in the style of Freerange, thanks to AI having an easy time with verifiable tasks. Freerange will be the first of many attempts to make more domains, such as UI, verifiable. Due to the no free lunch theorem, we can't and won't bake everything into Freerange. Instead, future compilers should expose better APIs to allow, in the extreme case, just-in-time proof writing per commit

# STATIC ANALYZER BLUEPRINT

Freerange is one example, not the final checker. The useful lesson is how much we got by riding on TypeScript instead of replacing it.

## COPY THE TYPECHECKER'S HOMEWORK

Freerange writes comments in normal TypeScript files:

```ts
function clamp(
  value: number, // @fit 0..100
  max: number, // @fit >= value
) {
  return Math.min(value, max) // @fit <= max
}
```

That choice matters. We did not invent files, imports, package lookup, path aliases, parse errors, or editor positions. TypeScript already has those.

The first move for a Freerange-style analyzer should be:

1. Read the user's `tsconfig.json` the same way `tsc` does.
2. Let TypeScript parse the files and report syntax errors with TypeScript error codes.
3. Ask TypeScript what an import means, including default imports, renamed imports, namespace imports, `export *` barrels, path aliases, and declaration maps.
4. Ask TypeScript for symbol identity, so `import {clamp} from "./barrel"` and `import {clamp} from "./helper"` can point at the same source function.
5. Ask TypeScript for source locations, so reports point at the line the user actually wrote.
6. Ask TypeScript for plain shape when it helps: this value has `.rows`, this field is an array, this imported type reference points at that source declaration.

That is the compiler doing compiler work.

## DO NOT ASK TYPESCRIPT TO KNOW YOUR APP RULES

TypeScript can tell Freerange that `clamp` is the function imported through a barrel. It cannot tell Freerange that `return <= max` is true.

Freerange still has to own:

1. What `0..100`, `> 0`, `rows[].height`, and `spaced(rows, gap)` mean.
2. How `Math.min`, `Math.max`, `+`, `-`, `*`, `/`, branches, defaults, object literals, arrays, loops, and helper calls affect those facts.
3. When source code is clear enough to trust.
4. When source code is too dynamic and should become `unknown`.
5. How to explain a failure in human terms:

```txt
FAIL: clamp(value, max): requires max >= value
  caller passed: max: 0..10, value: 20
  missing: max >= value
```

This split is the important part. TypeScript tells you where the code is and what names mean. The userland analyzer tells you what your extra checks mean.

## KEEP THE USER LANGUAGE SMALL

Freerange tries hard to use comments, not a new language:

```ts
width: number // @fit 320..2000
// @fit bottom >= top
return width / cols // @fit > 0
```

The comment should say the fact the source cannot say cleanly. Everything else should come from ordinary TypeScript code.

Good comments are boring:

1. input ranges, like `width: 320..2000`
2. positivity, like `count > 0`
3. sibling relations, like `bottom >= top`
4. array item facts, like `rows[].height: 0..40`
5. helper promises, like `return <= max`

Bad comments try to become a program. If users need loops, lambdas, custom search, sampled cases, or prose inside the checker, the analyzer has probably stopped being small.

## EVALUATE SOURCE ON PURPOSE

Freerange started with small recognizers. That does not last. A checker that understands branches, helper calls, object fields, arrays, defaults, and loops is already evaluating source code in a limited way.

So make that explicit:

1. Track numbers as ranges.
2. Track objects and arrays by fields and item facts.
3. Track helper calls by checked contracts, not by hope.
4. Track ordinary branches when they narrow the facts.
5. Treat normal arrays as summaries, not as hundreds of separate items.
6. Treat tuples as fixed slots when TypeScript promises fixed slots.
7. Return `unknown` when code is outside the supported shape.

`unknown` is not failure. It means "this analyzer refused to guess."

## MAKE REPORTS FOR CALLERS

The report should start where the user can act.

For a bad helper call, say:

1. which call failed
2. what the callee required
3. what the caller passed
4. what fact is missing

For a bad return or local claim, say:

1. what was claimed
2. what range or relation source code proved
3. which input facts or helper contracts were used
4. which bound or relation is still missing

Reports are not decoration. They are the product.

## RECORD THE CHECKER'S BEHAVIOR

A userland analyzer needs recordings, because it is easy to accidentally make it more optimistic, more pessimistic, or noisier.

Freerange keeps:

1. positive examples that should pass
2. negative examples with stable messages
3. inferred-fact snapshots
4. corpus sweeps over real code
5. a loose performance guard

If a feature has no bad example, it is not finished.

## DESIGN FOR AGENTS

AI works better when the task has a fast, concrete checker. That suggests a new workflow:

1. A change introduces a new guarantee.
2. An agent writes the smallest checker support for that guarantee.
3. CI runs it.
4. If the idea repeats, it becomes a reusable analyzer feature.
5. If it was only useful once, it can stay local or be deleted.

This is what "just-in-time proof writing per commit" can mean in practice.

## THE COMPILER API WISHLIST

Future compilers should make this easier. A Freerange-style analyzer wants APIs for:

1. comments attached to the exact source node a user meant
2. stable symbol identity across imports, re-exports, aliases, generated declaration files, and source maps
3. project loading that matches the user's normal build
4. exact source ranges for reports
5. safe access to simple control-flow and narrowing facts
6. a way for editor tools to show analyzer facts next to type facts

The goal is not one universal checker. The goal is a compiler that makes many small, honest checkers easy to build for many different kinds of code.
