# INTERNALS

Flow of program for `fr check`:

- Use TypeScript to resolve project files
- find & parse all `@fit` comments (on types, functions, function locals)
  - lightly transform a subset of `@fit` comments, such as `..` ranges, into valid TS syntax
  - make TS do the full parsing and type checking upfront
- interpret the function bodies
  - walk over abstract syntax tree (AST), analyze purity. If any function's impure, stop early and report
  - evaluate the functions with our range values
  - infer facts about returns, locals, branches, and loops
- compare the `@fit` contracts against the inferred facts
  - use range checks, numeric relationships, and proof rules to prove or reject each claim
  - report inconsistencies

## Parsing

The `@fit` specs syntax are mostly syntactically valid TypeScript (apart from the range `..`, `..<`, `a[].b`, etc.) for familiarity, and for being able to reuse more complex syntax like:

```ts
/** @fit
 * return: {left: 0, width: 100} | {left: 20, width: 80}
 * return: {x: foo(0)..100} | {x: 200..bar(300)}
 */
```

We turn `width: 100 | 200..300 | maxWidth()` into, conceptually, `width: __FRNumber<"r0"> | __FRNumber<"r1"> | __FRNumber<"r2">`, then with a lookup table on the side:

```ts
r0 = 100..100
r1 = 200..300
r2 = maxWidth()..maxWidth()
```

This is so that we piggyback on TS later to do the inference instead of making our own ad-hoc type checking. Ofc, the range-related checks _are_ our own and are done after TS's inference.

More examples:

```ts
given availableWidth: minWidth()..maxWidth()
given width > gap * 2
return.width <= Math.min(maxWidth(), availableWidth)
hasPositiveArea(return)
```

Become, conceptually:

```
assumeRange("availableWidth", "r0") // with side data `r0 = minWidth()..maxWidth()`
assume(compare(width, ">", gap * 2))
check(compare(return.width, "<=", Math.min(maxWidth(), availableWidth)))
check(hasPositiveArea(return) === true)
```

## Inference


=== EVERYHING BELOW IS DRAFT WE CAN PLUCK LATER

  - recursion analysis is bounded to 12 recursions
  - type `@fit` contracts are parsed but are inlined into usage sites differently than functions


```
project files
  ↓
use TypeScript files and parse ASTs
  ↓
find @fit comments
  ↓
attach comments to code
  functions, class methods/getters, type fields, locals, loops
  ↓
build Freerange program model
  files, functions, imports, local symbols, type contracts
  ↓
choose check boundaries
  “these are the functions/types/call sites we need to analyze”
  ↓
prepare function inputs
  params, this, defaults, type-field facts, given facts
  ↓
interpret function body
  walk TS code without running it
  produce abstract values, effects, branches, loop summaries, return cases
  ↓
extract facts
  return ranges, local ranges, array lengths, same-index facts, sequence facts
  ↓
turn @fit specs into obligations
  “prove return.width > 0”
  “prove rows.length == items.length”
  “prove this call satisfies helper preconditions”
  ↓
prove obligations
  simple range checks first
  comparison graph / transitivity
  proof backend rules: min/max, scale, division, rounding, modulo, sequence facts
  ↓
classify result
  PASS: proven
  FAIL: proven false or outside range
  UNKNOWN: not proven / unsupported / missing fact
  REQUIRES: caller failed callee precondition
  AUDIT: cleanup opportunity
  ↓
format report
  file/function/spec
  what was required
  what Freerange knew
  what was missing
```

## Parser
