# Freerange Todo

This is the living work queue after the interpreter cutover.

Current syntax and supported source live in [DOCUMENTATION.md](./DOCUMENTATION.md). Commands and repo shape live in [DEVELOPMENT.md](./DEVELOPMENT.md). Longer direction notes live in [research.md](./research.md) and [STATIC-ANALYZER-BLUEPRINT.md](./STATIC-ANALYZER-BLUEPRINT.md).

Freerange is a static checker for ordinary TypeScript layout code plus strict `@fit` comments. Keep the public DSL small: ranges, comparisons, field paths, and named layout facts. Do not add public lambdas, callbacks, `forall`, arbitrary folds, public alias syntax, prose-as-truth, browser runs, runtime traces, sampled sweeps, or screenshots.

Prefer source inference, intervals, small scalar loop effects, array/object domains, and helper contracts before adding atoms. Every new proof shape gets one positive pattern and at least one negative expected message.

The current product pivot is adoption, not a bigger DSL: make `infer`, `check --audit`, `audit:demos`, and reports the normal loop. A human or agent should ask what source already proves, keep only the important comments, and get a clear reason when proof stops.

## Active Work

1. **Keep the interpreter as the one source evaluator.**
   Function bodies, top-level inline checks, local inline checks, return checks, object-field checks, type-boundary checks, loop reports, and helper-call obligations now run through the interpreter. Keep moving report wording toward the same fact inventory, and keep collapsing recognizers into typed fact/value queries when the boundary is obvious.

2. **Make `infer`, `check --audit`, `audit:demos`, and reports the adoption loop.**
   `infer` should be the factual inventory agents use before writing comments. Normal `check` proves written annotations and scans supported callsites to annotated helpers; `check --annotations-only` keeps the quieter local pass. `check --audit` should stay advisory and source-shaped: pure choices, always-known conditions, and present-side fallbacks where current facts prove one value or branch cannot change the result. `audit:demos` should point at redundant demo noise without auto-deleting public-looking contracts. Reports should bucket failures into missing input fact, unsupported source shape, helper boundary, or real proof gap.
   No-path `fr infer --all` is now the project summary view: function counts, fact/spec counts, noisiest functions, top unsupported reasons, and a pointer to rerun a focused function. Keep file-scoped `fr infer file.ts` detailed and useful.

3. **Move checker knowledge toward typed facts and explicit obligations.**
   Keep public comments small. Internally, source readers should emit reusable range/equality/sequence facts, comments should become explicit obligations, and reports should render proof traces rather than rediscovering context from strings. The current trace shape records the boundary, goal, proof step, and facts seen by range/comparison/helper-call checks; keep moving atom and sequence reports onto the same path. `spaced`, same-index checks, adjacent row checks, and future view-ish concepts should not become one recognizer per demo.

4. **Keep TypeScript shape comparison bounded.**
   TypeScript is a structural oracle, not numeric proof. Use it for arrays, tuples, object paths, imports, aliases, and source locations. Do not let `src/shapes.ts` become a second TypeScript checker, and do not let reports treat shape as a proven range or comparison.

5. **Keep the external corpus sweep part of correctness.**
   `bun run verify:corpus` should keep discovering every `@fit` source file under `/Users/chenglou/github/freerange-corpus`, grouped by top-level project and nearest `tsconfig.json`, then snapshot the exact file list and strict check summary. Treat unexpected failures as regressions; treat stable `requires` as adoption pressure unless a real proof gap is clear.

## Next Proof Work

1. **Tighten input honesty where reports stay obvious.**
   `given` contradiction checks already catch empty ranges, direct range contradictions, opposing linear comparison bounds, short chained contradictions, and obvious range/comparison chains. Widen this only when the failure can name the bad input fact plainly.

2. **Keep helper/import report lines precise.**
   Reports should say where a fact came from: input assumption, loop `@fit`, source inference, branch inference, checked helper contract, or checked imported contract. Missing facts should name the smaller obligation when possible, e.g. `scale >= 0` or `count > 0`, not only the whole failed comparison.

3. **Turn scalar accumulators into reusable internal measures.**
   Keep improving source inference for totals, guarded counts, extrema, and cursor updates when they feed later comparisons and reports cleanly. Do this as source inference, not public folds.

4. **Use real demos and corpuses as pressure, then prune.**
   Run `fr infer` before adding proof support. If a blocker is general, add the smallest positive pattern and a negative expected message. If it is product-specific, leave it in the demo or spec instead of growing Freerange.

5. **Add realistic negative cases.**
   Keep adding small negative kernels for mistakes agents actually make: wrong gap, off-by-one target index, missing row bottom, inverted clamp bounds, unbounded prompt height, stale row spacing after a loop refactor. The report wording is part of the feature.

6. **Postpone conditional helper contracts until callers need them.**
   Branch-local inline facts cover local proof. Do not add `when` or another public syntax yet. Conditional postconditions need a separate design because they export facts only under caller-known conditions.

7. **Keep bound-index labels narrow.**
   Anonymous `[]` means one collection. Repeated labels mean same index and require proven matching lengths. Adjacent labels work only over one collection and only when a sequence relation was inferred. All-pairs, source/id matching, and numeric ghost symbols need separate specs.

8. **Delay views until field-name pressure justifies them.**
   A future view should only map fields, e.g. `view rows as spans(start: .top, size: .height)`. It must not assert layout facts. Do not add views just to make the first row loop prettier.

9. **Add text/layout facts through generic range and lineage facts first.**
   Prefer facts such as `fragments[].width <= offeredWidth`, `nondecreasing(fragments.textStart)`, `partitions(fragments, textRange)`, `sourceOrder(lines, fragments)`, and `sameSource(selectionRects, paintFragments)` before adding text-specific atoms.

## DSL Governance

Before adding a public atom, write its mini spec:

- UI-independent name, e.g. `spaced`, `inside`, `partitions`
- required shape/view, if any
- exact lowering in ordinary words
- what it does **not** imply
- positive pattern
- negative pattern
- report template
- at least three non-demo use cases

Good atoms name layout concepts. Bad atoms name apps or vague outcomes: `goodRows`, `chatLayout`, `validTextLayout`, `masonryLooksBalanced`.

Aggregates are okay only if they stay path-only:

```ts
total(rows.height)
max(lines.width)
count(visibleRows)
```

No aggregate callbacks, inline arithmetic, or folds. Source-level `.filter(...)` is separate: it is a subsequence summary with direct true-side predicate facts, not a public aggregate language.

Callback contracts stay out until real demo pressure says otherwise. Users can annotate concrete wrapper functions or claimed callback results; Freerange should not grow a public function-type spec language just because higher-order calls exist in TypeScript.

## Deferred

- Open-ended range spelling such as `int 1..` or `0..`. Keep `Infinity` until inline annotations are common enough that the visual noise matters.
- Public views. They are likely right long-term, but only after field-name pressure appears across several domains.
- Conditional helper contracts. Useful, but not just nicer comment placement.
- Numeric and geometry atoms. Existing interval math, finite numeric sets, linear reduction, ceil/floor/modulo facts, signed scale/divide facts, `Math.min` / `Math.max`, and helper contracts cover a lot.
- Clamp atoms. Userland clamp works through helper contracts plus `Math.min` / `Math.max`.
- `sameLength` as a primitive. Append and running-sum inference often prove length directly.
- Exhaustive integer sweeps. Keep them out unless a finite-domain static proof clearly justifies the cost.

## Known Big Gaps

- No public views, public aggregate syntax, public callback contracts, or conditional postconditions.
- No general loops, nonlinear solver, overload semantics, broad string operations, async, closures, declaration-only class-member contracts, general generic value reasoning, branded-value reasoning, or precise mutation inference.
- Import support stays local-source-first. Published packages, declaration-only imports without local source maps, summary files, and stale-summary policy are still out.
- Wildcards stay conservative: one anonymous collection, same-index labels only with matching lengths, adjacent labels only over one collection with inferred sequence facts. All-pairs and source/id matching are unsupported.
- TypeScript shape reading stays structural. Optional/rest tuple slots, unguarded optional/nullable values, broad strings, and huge types remain conservative unknowns.
