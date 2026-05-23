## Features Under Consideration

- **Pairwise non-overlap**: `for all i ≠ j, rects don't overlap`. The defining proof for "agents don't need a browser" — forces the cross-index quantifier primitive.
- **At most N visible boxes pass the `if`**: counting bound on the render loop's visible set. Smaller than pairwise non-overlap, demonstrates a "CSS can't do this" claim.
- **"3 items don't fit vertically"** in the general form. Different from the simple-N case that works today; needs a cross-subset claim.
- **Visibility predicate equivalence**: prove an inline overlap check equals the canonical `rectsIntersect` — would let the analyzer trust user-written predicates.
- **Existentials**: `there exists i such that ...`.
- **Cross-collection indices**: comparing items across two arrays.
- **Views**: `view rows as spans(start: .top, size: .height)`. Postponed pending more thought on the syntax.
- **Annotate the actual photo gallery** with the contracts the project goal demands.

## Smaller Adds

- Open-ended range spellings like `int 1..` and `0..`. Hold off until inline annotations are common enough that the `Infinity` noise hurts.
- `sameLength` as a built-in. Append and running-sum inference often prove length directly already.
- Conditional helper contracts — useful only if it's more than nicer comment placement.
- Finish remaining `Math.*` built-ins except `Math.random`: interval-aware `Math.sin/cos/tan/cosh/atan2`, `Math.hypot`, `Math.sumPrecise`. Write the range rule once, not per call.

## Engine Work

- Continue improving source inference for totals, guarded counts, min/max accumulators, and cursor updates when those feed later comparisons or reports more cleanly. Source inference, not public folds.
- Exhaustive integer sweeps for the small fully-bounded comparison cases (probably useful for the cross-index quantifier later).
- `ts.createScanner`-based `@fit` lowering. Would replace the bespoke char-walkers in `src/parser.ts` with TS's scanner. Marginal cost-benefit today; revisit when something else makes us touch the parser.
- Segmented stack field-name generalization beyond `top`/`height`/`bottom`. Likely waits for views.

## Maintenance

- Reject the obvious bad `given` lines early (empty ranges, direct contradictions, short linear chains) before proof gets to run on an empty input set. Widen only when the failure can plainly name the bad input.
- Keep report lines naming where each fact came from: input assumption, loop `@fit`, source inference, branch inference, checked helper, checked imported. Missing pieces should name the smaller relation when possible (`scale >= 0`, `count > 0`), not the whole failed comparison.
