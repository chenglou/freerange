# Engineering

Most of the guideline below are just concrete manifestation of feeling the ebb and flow of a low-energy state (which is why this is an engineering guide, as opposed to leaving room for exploratory entropy, though exploration benefits from proper state space control for more efficient search too). Generally speaking, think in terms of state space size vs state space "evenness", the sweet spot of most type systems for entropy control, etc.

## Data Modeling

Highly value asking about & modeling data structures and access patterns first and foremost when iterating. Don't be afraid to change data structure if a new feature requires remodeling. Don't just tackle things on incrementally. AI can rewrite fast and well.

Prefer type and union over interface and enum.

Parse & validate your data as early as possible. Don't pass down half-validated data then do ad-hoc checks in downstream call sites. For example, don't half-parse a payload then re-transform & check some of its fields in call sites later.

Parse and normalize early but don't _interpret_ too early. Interpret data at a narrow useful scope that will see all interacting data and has a real reason to own the result. If e.g. a click handler only sees the click, but render also sees scroll position, hit targets and route state, store the click (or any other raw fact you'd otherwise lose) and let render decide what it means.

Two systems want different data representations. Expect data shape pressure at those boundaries. A text layout helper, canvas renderer, or search index may want data grouped, flattened, indexed, or split differently than your app does. As much as you can, own your data shapes and be very careful delegating those to a library.

Put a guarantee in the data shape only when it stays true wherever the value goes. If it only becomes true because one helper made it that way, check that helper instead.

Good data shape guarantee: `type NonEmpty<T> = [T, ...T[]]` when empty really is impossible. The guarantee belongs to the value no matter who reads it.

Bad data shape guarantee: `type SortedRows = Row[]` if any caller can still push an unsorted row. That's just a name. Either hide the constructor/mutation path, or check the helper that produces the rows.

Bad producer guarantee: forcing every downstream renderer to accept `StackedRowsFromThisOneLayoutHelper` because one helper builds spaced rows. If the type name starts sounding like a whole algorithm, the data model is probably doing too much.

DO NOT prematurily optimize data for performance at the cost of simplicity:
- Avoid caching
- Highly value single source of truth. Don't denormalize & add auxiliary fields on data that we could have just computed on the fly. The computations are quasi-free compared to memory
- Keep fewer data structures, flatter data, and collapse data with the same lifetimes together. E.g. store those same-lifetime values into object fields so that they're created & deleted together when we manipulate the obj. This is also why we avoid denormalized data, because having stuff in 2+ places falsely convey extra degrees of freedom. Think as if you need to manually allocate them; your app/component doesn't that _that_ many different lifetimes!
- Ideally, derived data should be computed and then gone, in the same scope as the inputs that produced them. Fewer lifetimes mismatches, less staleness
- Imagine: If multiple callsites need the same derived data in the same scope, we'd obviously compute it once and then use it many times below. But somehow, it feels ickier to store that derived data alongside the same object that holds the inputs that produced it. This is because a local derived value is just a computation result, but a derived field stored on the object becomes state. Its lifetime now follows the object rather than the evaluation that justified it, so you have created a second representation of the same fact, plus an invalidation problem
- Immutability is a good default, but for large collections it thrashes perf and breeds worse architectural patches to compensate — so keep the collection mutable; lesser of two evils

If behavior genuinely differs by some dimension, say, browser, feature flag, or mode, model that difference explicitly in one place. Don't weave it through a bunch of local conditionals.

DO NOT write defensive code like `foo?.bar?.baz`, or bigger defensive patterns that silence potential upstream causes of errors. Things are well-typed, and if weird type-related errors happen, that means somewhere _upstream_ is broken and needs fixing, not silenced per-callsite. Let it crash early.
Do consider defensive code in the context of provably shaky boundaries, e.g. user input, network responses. But do it only after user asks so. AI tends to overdo defensive coding.

Think twice before using overly generic data structures like Map and Set. They're fine in many cases, but in many others, it just means you haven't leveraged more properties & strong assumptions from your domain. Array's often a better bet unless your algorithm really needs `O(1)` access. Think more in C-style terms: where is a hash map more appropriate despite its higher friction?
Data structures tier:
- Record/tuple
- Array
- Map/set
(Tagged union is a bit of a special data structure that doesn't belong in this ranking. But obviously, use it)

When using homogenous collections (array, map, set), avoid special-casing specific items. Items can be tagged unions if needed. Truly heterogenous operations belong in object and tuple.

Orient your data structure to match your access pattern. If you have `folders: Map<folderName, Set<imageId>>` but your hot path asks "which folders is this image in?", build `imageToFolders: Map<imageId, Set<folderName>>` once upfront. Don't scan all folders per image — that turns an O(1) lookup into O(folders).

If you wanna refactor a data structure that's used everywhere, and can't do it one shot, make the new data structure, have it side by side with the old, and gradually migrate to the new one. Ideally, don't make the new one into a new state, since old callsites mutating the old data structure wouldn't have their changes reflected in the new one, and vice versa. So derive the new one from the old one each time through some function. Naturally, the accessors modifying the new one should, under the hood, mutate the old one (then the new one is again, automatically derived from the old one). Unidirectional data flow.

Everything flows downstream of data structure; so **do not** monkey-patch data; You're trained on data of folks who monkey patch due to an obsolete concern of time and typing amount. You should be fearless, reconsider data flow holistically, re-model things properly then just follow the types and trivially fix downstream problems in minutes.

### String

Strings are the `any` of data. If you're parsing, splitting, or regex-matching a string repeatedly, it should have been a structured type upstream. If there's already such data type and you're still forced to use the original unparsed string, then that data type was modeled too tightly and lost necessary info. Fix that instead
Careful making a composite key through string concat of parts (e.g. `` `${id}-${index}` `` as a Set key). In a hot loop this allocates a string per lookup

Prefer views over copied text when code keeps regrouping the same source. If the source is one string, store `{ start, end }`, move those views around, and slice only at print/measure/render time. If the source is already a list of chunks, don't flatten it just for this rule; carry views into those chunks. E.g. a code editor token should point at the source range for `user.name`, not store `['user', '.', 'name']` and keep rejoining it for highlighting, search, and wrapping. JS engines under the hood might treat string slice as views automatically. But this concept's still valid in userland.

### Nullability

Guideline for typing potentially nullable string:

- If the nullable string has no valid `''` state (e.g. mandatory non-empty username), model it as `string | null`
- If the nullable string has valid `''` state, it's hard to say whether to model as `string | null` or `string` where `''` represents the empty state:
  - Former is nice and linter/type system reminds us to check for `null`. But then we miss checking `''`. Any over time there's always some callsite that either over-checks or under-checks for `''`.
  - Latter is technically the correct number of states, but has no built-in language support for explicitly checking for `''`.
- One thing's for sure: don't model a non-nullable string as `string | null`.

Unnecessary `null` in a type makes it hard to remove later. Future maintainers won't know if it was semantically meaningfully, added accidentally, or just an unnecessary defensive measure.

## Control Flow

Resist future-proofing with generic helpers if you've only encountered one instance of the logic. The more abstract it gets, the bigger the risk for vagueness. The more indirection there is, the more the reader has to mentally compute the chain of generic logic to understand the callsite. This also closes off cleaner situation-specific algorithms and naming. Keep it local first. Generalize later when there's a second real use.

A good helper should create _local_, not global, "shape" pressure. Quick test: if you removed the helper tomorrow, would you only delete one adapter, or would you have to remodel your app state and control flow? If only the adapter breaks, the helper fits. If the whole app now has to carry the helper's shape around, the API is too prescriptive.

Folks try to "solve" performance by hiding them behind ever more obscure control flows, e.g. nested ifs, lazy imports, etc. Avoid these; they often just obscure the perf degradation, and add extra state checking & debugging complexity. We prefer making systems with even latency and throughput, like shaders or real-time systems: branchless, predictable, uniform-cost. Branches (and caches) lower the cost of best-case scenarios by rising the cost of worst-case scenarios; we don't want that! We don't want a 4ms frame to reduce to 1ms while, in the worst case, upping it to 10ms (which is now a frame drop). So try to first and only cater to worst-case frame latency.

Avoid excessive asyncs. If needed, at least spot the asyncs that need to go together, and wrap them in a group with Promise.all. Prefer top-down control flow. E.g. don't do one `configLoaded.then(...)`, one `dataLoaded.then(...)`, then some shared `maybeStart()` / `if (fooReady && barReady)` handshake if what you really mean is "wait for both, then start".

Aggressively prefer `switch` over `if/else`, when possible (e.g. union values). Get those exhaustiveness coverages. Write conditions like a functional langauge with pattern matching:
- Do: `switch (payload.type) { case 'image': return handleImage(payload); case 'text': return handleText(payload); }`
- Don't: `if (payload.type === 'image') { handleImage(payload); } else if (payload.type === 'text') { handleText(payload); }`
- Don't: `const dispatch = { image: handleImage, text: handleText }; dispatch[payload.type](payload)`

The latter's especially prominent (using objects as dynamic dispatch tables). It's overly cute, wrecks static analysis, and cannot varie the value (function)'s shape

Loop invariants are extremely underutilized in reasoning. Understanding what doesn't change makes each iteration easy to verify, and makes static parts easier to lift outside of the loop.

With while loops, make progress/index advancement intuitive. It's usually more general/powerful, and thus more troublesome, than regular loops. Model it as much as possible as regular loops without contorting yourself (you probably used `while` instead of `for` for a good reason).

Not all code reuse is good. Before extracting similar calls into helpers, consider whether the redundant work is actually a manifestation of a control flow that didn't properly compute the shared part before the downstream usage sites.

Avoid iterators if regular loops work. They hide extra work and allocs
A single forEach or map over data is fine. filter + map or map + filter are too. But more than that, you're not saving on conciseness; convert to regular loops.
Avoid `reduce` in most cases except for simple cases like summing up numbers. Using reduce, especially with objects, likely means the data modeling is wrong. Likewise with `flatMap` most of the time.

Usually, O(n^2) or O(nm) are fine if n and m are bounded by the domain, e.g. images per job (~4) × collections (~tens) = ~hundreds. It's not fine when one n or m are user data that grows unboundedly (10k jobs, feed items). Watch out for bounded-looking inner loops that get nested inside an unbounded outer loop and repeated across the system — each instance is cheap but 4 repetitions × 10k jobs × 18 re-renders adds up. If you encounter O(n^3), then you're either doing interesting mathy things or you're likely modeling your product data wrong.

Between monkey-patching data vs control flow, the latter is the lesser evil, but still, don't do it.

### Exceptions

Exceptions are non-local control flow. They cause invalid states. Avoid them, apart from 2 cases:
- _Do_ throw when something is unrecoverable. Use it the same way some languages use `panic`
- _Do_ throw instead of silently hiding big invariant violations, e.g. when a React context is only supposed to be used in certain paths, or when a DOM node that's guaranteed to be present is missing. Silencing those end up making you propagate e.g. a null value, making your app state look much bigger than it actually is. See the early `null` section

If the error is actually expected and recoverable, don't throw; model with regular data/control flow. When using APIs that throw, try & catch them early.

### Model The Dependency Order Directly

If two parts of your app depend on the same upstream fact, derive both from that fact. Don't make the program rediscover dependencies it already knows.

Reactive systems, event-driven systems, and DOM-driven code often do black-box theater here: one part "emits", "updates", or "writes to the DOM", and another part tries to recover meaning later. This hides order and precedence, then later someone has to reconstruct them from timing, subscription order, or DOM reads.

- don't update an animated card's DOM position, then measure the DOM somewhere else to drive a sibling effect. Compute the card position once, then feed both the DOM styles and the sibling effect from it.
- don't fire several events and let downstream listeners reconstruct which state won. Put that ordering logic in one place that sees the relevant state, then feed the result downstream.

Your app is more of a white box than these systems pretend. Keep the ordering logic in one place. If something has to be messy, let it be visibly messy in one place instead of spread across listeners, effects, and DOM reads.

## Caching

Modern computing's much cheaper than memory. Recompute instead of storing the result. Computing, being ephemeral, avoids lifetime issues. If you have to cache, consider it more as a temporary acceleration structure, like in dynamic programming. Here are some notable exceptions:
- DOM, because they're genuinely expensive.
- truly expensive computations after real measurements
- computations with stable input identity, real reuse, bounded cache size

React recommends useMemo and useCallback, but actually, try avoiding them.

## Iteration

You're trained on data that concerned itself with archaic concerns such as typing speed and visual scope of changes. In reality, there's no need for superficial, theatrical incrementalism between your refactors. Just do things holistically, as if it's the first time you write it. Do it like React: you can recompute/rewrite more than you believe.

You can, but do not use enough of, small prototypes to validate your ideas. Start with quick, cheap, exploratory ways to gain confidence and/or to cut down on hypothesis space: temporary scaffold, debug helpers, repl. Make estimates and refine them through these quick iterations. Not enough rescoping and cheap tries during the process!

Speaking of estimates: you also underestimate your ability to just directly write the final code, then come back and judge in hindsight. Sometime the devil's in the detail and you have to do the full task instead of guesstimating. Action produces information. So your way of estimating works much better if you do a few prototypes or maybe even the final code instead of doubting either way.

Real usage is evidence, not the feature specification. Do not overfit by adding a collection of rules for the exact expressions found in the current corpus. Do not underfit by rejecting a small, general rule merely because only one current call site needs it. This matters especially for tools used by agents: prefer a small written subset whose behavior is complete and predictable. Use real repositories to decide whether the subset is useful and to find missing categories, then state the boundary independently of those repositories. If only part of a familiar rule is supported, either describe the exact supported part or reject the rule until the boundary can be made clear.

When you launch long-running task, unless the task's scope and structure is certain (e.g. known tasks, repeated tasks, etc.), you should be checking back more often than you think. For example, for a training run, don't just launch and check every 30m. Check every other minute if you have to, for blowups and others, then do back offs when you're more certain that the task won't drift.

### Exploration

Exploratory work works better without overdousing subagents with context. Careful when setting overly concrete goals. Careful also not have subagents over-critique details. Ideas start fragile; prevent subagents from prematurily reducing entropy through petty critiques. But if you feel we're drifting off to the deep end and confusing ourselves, then validate the general architecture first (again, through quick prototypes).

## Project Setup

A quick iteration & verification loop is important especially for AI now. To that end, we use nuanced TypeScript + linting to essentially monkeypatch the type system into a mostly correct one, while opinionatedly dropping all the unhelpful stylistic rules that distracts AI

Big items that makes TypeScript "unsound" or dangerous:
- `any`
- `unknown` (although this one we allow, as an ok escape hatch)
- over/under-cover switch & if statements (aka non-exhaustive pattern matching, in FP theory)
- dynamism around object fields (e.g add/remove field, read key as string)

We don't use rules that:
- drastically slow down checks. We don't use hook rules for example. Even on oxlint
- are just stylistic nits. And we take an honest look at ourselves to determine what's actually semantically important vs what's just engineering theater

Concretely, for TS config (use TypeScript 7's native `tsc`. Faster):

```jsonc
"strict": true,
"noUncheckedIndexedAccess": true,
"noImplicitReturns": true,
"noImplicitOverride": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
"exactOptionalPropertyTypes": true,
"allowUnreachableCode": true, // we allow this because our editor settings' uses "source.fixAll", which fixes everything on save. But then temporarily dead code gets removed during iteration, which sucks. So we replace this with oxlint's "no-unreachable" rule, which isn't auto-fixed
"noFallthroughCasesInSwitch": true,
"noPropertyAccessFromIndexSignature": true, // life-saver
```

For linting, we prefer oxlint + tsgolint npm packages for AI verification loop perf. But the recs below work for eslint too:

```jsonc
"plugins": ["typescript", "oxc", "promise"], // only add plugins whose checks are intentional. Others might be noisy for AI
"options": {
  "denyWarnings": true, // keep diagnostics labeled as warnings, but still fail the check
},
"prefer-ts-expect-error": "error",
"no-unnecessary-type-assertion": "error",
"no-unreachable": "error", // we use this instead of typescript's "allowUnreachableCode" (see tsconfig)
"@typescript-eslint/no-explicit-any": "error",
"@typescript-eslint/no-unsafe-assignment": "error",
"@typescript-eslint/no-unsafe-argument": "error",
"@typescript-eslint/no-unsafe-call": "error",
"@typescript-eslint/no-unsafe-return": "error",
"prefer-promise-reject-errors": "error",
"promise/no-callback-in-promise": "error",
"@typescript-eslint/no-unsafe-member-access": "error",
"@typescript-eslint/prefer-nullish-coalescing": ["error", {
  "ignorePrimitives": { "boolean": true },
}],
"@typescript-eslint/strict-boolean-expressions": ["error", {
  "allowNullableBoolean": true,
  "allowString": false, // disable `!myString` and `!myNullableString`
}],
"@typescript-eslint/switch-exhaustiveness-check": ["error", {
  "allowDefaultCaseForExhaustiveSwitch": false,
  "considerDefaultExhaustiveForUnions": true,
  "requireDefaultForNonUnion": true,
}],
"@typescript-eslint/no-unnecessary-condition": ["error", {
  "allowConstantLoopConditions": true,
}],
"no-unused-expressions": ["error", {
  "allowTernary": true,
  "allowShortCircuit": true,
}],
// "@typescript-eslint/no-base-to-string": "error", // enabled by default in oxlint. Prevents showing string [object Object]. This also lets us construct IDs from strings, without letting these IDs be subject to string manipulations
```

Some of these configs for preventing extra checks (e.g. erroring on checking a value is null when it can't be) are crucial to shrink the codebase back when a feature's cleaned away. See early section for handling nulls for example.

Use the regular `typescript` package for projects that only run the compiler. A tool that still imports the TypeScript 6 compiler API, like Freerange, keeps TypeScript 6 as `typescript` and installs TypeScript 7 under an alias:

```jsonc
"devDependencies": {
  "@typescript/native": "npm:typescript@^7.0.2",
  "typescript": "^6.0.2",
},
"scripts": {
  "check": "bunx @typescript/native && oxlint --type-aware yourSourceFolder",
}
```

Use Knip to periodically find unused files, exports, types, dependencies, and binaries. The config's straightforward, with one nuance below:

```ts
// knip.config.ts
import type { KnipConfig } from 'knip'

// Test files are in `ignore` so their imports don't count as "usage", flagging exports used only by test files as unused.
// Tradeoff: dead code & exports within test files won't be detected. See: https://github.com/webpro-nl/knip/issues/1374. This is acceptable
const config: KnipConfig = {
  entry: ['src/client.ts', 'scripts/**/*.ts'],
  ignore: [
    '**/*.test.ts', // Exclude tests so their imports don't count as "usage"
  ],
  // slightly confusing config. We detect dead code just fine
  // this one's just to silence exported types and values that aren't used elsewhere but that are still used within their file
  // yelling on unnecessary exports is a bit noisy so we turn it off
  ignoreExportsUsedInFile: true,
}

export default config
```
