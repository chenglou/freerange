We expect many more userland static analyzers in the future in the style of Freerange, thanks to AI having an easy time with verifiable tasks. Freerange will be the first of many attempts to make more domains, such as UI, verifiable. Due to the no free lunch theorem, we can't and won't bake everything into Freerange. Instead, future compilers should expose better APIs to allow, in the extreme case, just-in-time proof writing per commit

# STATIC ANALYZER BLUEPRINT

This document records the architecture lessons from building Freerange.

It is not a guide to building a theorem prover, and it is not an argument for putting every analyzer inside TypeScript. The pattern is smaller:

1. stay inside normal TypeScript code
2. add a tiny fact language where normal types run out
3. let the compiler own names, files, packages, and locations
4. let the analyzer own the extra meaning
5. keep tests and snapshots for behavior that should not change

## START CONSERVATIVE

Freerange started with small numeric facts:

```ts
given width: 0..1000
return <= max
rows[].height: 0..40
```

That was the right constraint. The first goal was not to understand all UI code. It was to catch small, real mistakes in layout math without asking people to rewrite their app around the checker.

The rule that survived is:

> Prove facts only from supported source, checked contracts, and explicit assumptions. Report unsupported source as `unknown`.

`unknown` is important. It lets the checker be useful before it is complete. It also prevents unsupported code from being treated as proven.

## USE TYPESCRIPT FOR WHAT TYPESCRIPT ALREADY KNOWS

Freerange piggybacks on TypeScript anywhere the answer is already compiler-owned:

1. read `tsconfig.json`
2. parse source and stop on TypeScript syntax errors
3. resolve path aliases and packages
4. follow default imports, renamed imports, namespace imports, and `export *` barrels
5. use symbol identity so a helper imported through a barrel is still the same helper
6. recover local source from declaration maps when a built package points back to source
7. use TypeScript shape when it only says shape: this is an array, this object has `.rows`, this tuple has fixed slots

This took a few tries. Early Freerange had its own small import/export graph. That worked for the first examples, then got awkward around barrels and namespace imports. The better version asks TypeScript for the final source declaration and lets Freerange attach contracts to that.

The lesson is not to trust TypeScript for Freerange facts. The lesson is to use TypeScript for compiler facts instead of rebuilding them.

## DO NOT ASK TYPESCRIPT TO KNOW YOUR EXTRA MEANING

TypeScript can tell us that `clamp` is the function imported here:

```ts
import {clamp} from "./layout-math"
```

It cannot tell us that `clamp(width, 0, max)` returns `0..max`, or that row tops are spaced by a gap, or that a hit target index stays in bounds.

Freerange owns those meanings:

1. ranges
2. comparisons
3. helper contracts
4. type-field contracts
5. array item facts
6. loop-produced row facts
7. report wording

TypeScript identifies the source entities. Freerange defines and checks the extra facts.

## WE TRIED FORKING TYPESCRIPT

The TypeScript-native experiments were useful, but not because they replaced Freerange. They were better as a compiler base layer and worse as the whole checker. They showed that compiler-owned pieces really do belong near the compiler:

1. syntax diagnostics
2. project file context
3. module identity
4. aliases and re-exports
5. source locations
6. comment attachment

But they did not make the Freerange part disappear. Numeric ranges, helper preconditions, array summaries, loop facts, where imported facts came from, and human reports stayed Freerange-owned.

The practical outcome was a smaller one:

> Move compiler-adjacent work toward TypeScript APIs. Keep the checker's meaning in Freerange.

A real fork only starts looking worthwhile when public APIs cannot expose something essential: first-class comment attachment, `.d.ts` contract emit, or editor-service integration. Until then, a fork mostly moves complexity into a harder place to maintain.

## LET REAL REPORTS SHAPE THE TOOL

Freerange's CLI changed shape because reports were too noisy.

At one point, `check` and `doctor` were separate ideas. That split did not hold up. Users mostly want the checker to tell them what matters, and an escape hatch for quieter annotation-only passes. So the model became:

```sh
fr check file.ts
fr check --annotations-only file.ts
fr infer file.ts --function layout
```

The report shape that stayed useful was caller-first:

```txt
FAIL: clamp(value, max): requires max >= value
  caller passed: max: 0..10, value: 20
  missing: max >= value
```

This is a product rule, not a formatting preference. A static analyzer should make the next action clear.

## BUILD ONE SOURCE EVALUATOR ON PURPOSE

Freerange did not begin with a grand interpreter design. It began with small support for functions, `Math.min`, object fields, arrays, loops, helper calls, branches, defaults, and so on.

Eventually those recognizers had become an interpreter. The rewrite made it explicit and deleted the old evaluator once snapshots, demo checks, negative messages, corpus probes, and benchmarks gave enough confidence.

That is the general lesson:

> If many features need to know what source code means, build one engine for source meaning.

Keep the layers simple:

1. parse comments
2. bind inputs
3. evaluate supported source into facts
4. check claims against those facts
5. print reports

Do not let every new check grow its own private source reader.

## SUMMARIZE COLLECTIONS

One early mistake was unrolling too much. It feels precise to evaluate every array element. It quickly explodes and gives the checker the wrong default behavior.

The durable split is:

1. ordinary arrays are summaries
2. tuples and fixed product shapes can keep slots
3. `map` preserves length and item facts when the callback is simple
4. `filter` gives a subset, not equal length
5. loops emit summaries like row spacing, nondecreasing tops, or running totals

This is one of the places where TypeScript helps but does not finish the job. TypeScript can tell us a value is a tuple or an array. Freerange decides whether to keep slots or summarize items.

## KEEP COMMENTS SMALL

Freerange comments work best when they say the missing fact, not the whole proof:

```ts
width: number // @fit 320..2000
count: number // @fit > 0
// @fit bottom >= top
```

We added inline comments for parameters, locals, object fields, and returns because real code wanted the red line near the value. We also restricted inline facts to line comments after block comments became ambiguous in too many positions.

That is another general rule:

> Small syntax is acceptable only when placement and error handling stay simple.

Do not add lambdas, folds, public aliases, prose, browser runs, screenshots, or sampled cases just to make one example pass.

## USE INFER TO ADOPT, NOT TO HIDE CONTRACTS

Freerange added `infer` so humans and agents can ask, "What does the checker already know?"

That made annotation work much better. It also exposed a tempting idea: automatically export inferred helper summaries and delete lots of comments.

We tried that direction. It was conceptually neat and practically heavy: summary caching, return-expression filtering, rebasing, tracking where facts came from, and assumptions. Worse, many "removable" comments were the public contracts people should still read.

So the better rule is:

> `infer` is an adoption tool. Checked contracts are still the public guarantees.

Generated or inferred contracts may be useful later, but they have to prove they delete noise rather than deleting documentation.

## USE REAL CODE AS PRESSURE, THEN GENERALIZE

The useful features came from real files:

1. photo-gallery made grid sizing, row spacing, line hit boxes, and prompt sizing concrete
2. xyflow pushed tuple geometry returns, destructuring, and helper summaries
3. react-grid-layout pushed clamp preconditions and grid math
4. d3-scale justified `Math.sign`
5. tldraw and fabric-like geometry kept class methods and getters honest
6. DOM layout facts came from the need to know `clientWidth >= 0` without pretending every app field named `clientWidth` is special

The rule is not "add whatever a corpus wants." The rule is:

1. annotate a small real helper
2. run `fr infer` or `fr check`
3. classify the first blocker
4. fix the root only if it is general
5. add a positive and negative kernel

That loop beats designing a large language up front.

## RECORD EVERYTHING YOU MIGHT REGRET

The interpreter rewrite only worked because Freerange had recordings:

1. positive patterns
2. negative messages
3. inferred-fact snapshots
4. photo-gallery snapshots
5. demo contract snapshots
6. external corpus probes
7. interpreter snapshots
8. a loose performance budget

These recordings make large changes reviewable. They show whether behavior changed intentionally.

## DESIGN FOR AGENTS

Agents are better when the target has a fast check. Freerange's bet is that this changes the economics of verification.

Instead of forcing all code through a narrow human-designed API, an agent can write natural code and then add the guarantees it needs checked. If the checker fails, the agent gets a concrete missing fact. If the same missing fact repeats across projects, it can become a general checker feature.

That is the "just-in-time proof writing per commit" shape:

1. a change needs a guarantee
2. an agent writes the smallest check or checker support for that guarantee
3. CI runs it
4. repeated patterns graduate into reusable analyzer features
5. one-off checks stay local or disappear

## WHAT FUTURE COMPILERS SHOULD EXPOSE

Freerange had to build too much glue around TypeScript. Future compilers should make userland analyzers easier by exposing:

1. exact comment-to-node attachment
2. stable symbol identity across imports, re-exports, generated files, and source maps
3. project loading identical to the user's normal build
4. source ranges that are good enough for product reports
5. simple shape and control-flow facts without asking analyzers to reimplement the typechecker
6. editor hooks that show analyzer facts next to type facts

The goal is not one universal checker. The goal is many small checkers that can share the compiler's understanding of the program while owning their own meanings.
