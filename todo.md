## Features Under Consideration

- **Arbitrary-pair non-overlap** for freely-positioned 2D boxes (the predictive-keyframes case). Outside the linear-plus-adjacent vocabulary. Either accept as outside, or add a small targeted decision procedure (small-array exhaustive, transitive closure, or SMT).
- **`reduce` recognition** for summing arbitrary numbers. The 0|1 counting case is covered by `filter(p).length`; `reduce` would cover summing widths, weights, totals.
- **Views via pure code**: users transform their field names with `arr.map(item => ({start, size}))` before calling catalog items. Confirm this works for the layouts that currently can't use `top/height/bottom` directly. Segmented-stack still hardcodes those names; revisit when a real case demands it.
- **Open-ended range spellings** (`int 1..`, `0..`). Hold off until the noise from spelling `Infinity` becomes annoying. If added, exclusion markers attach only to a written bound (`5<..` is strictly above 5); a bare `<..10` collides with the inline `< expr` comparison shorthand and stays out.
- **A `-Infinity<..Infinity` lint.** Strict at one infinity, inclusive at the other is almost always a misread of `-Infinity<..<Infinity` (the inclusive end still admits Infinity). Worth a warning when a range mixes an exclusive infinite endpoint with an inclusive one.

## Engine Work

- **Conditional flush loops under rounding**: the segmented-stack family (push on `i % 3 === 2` or last-index, reset accumulator) rebinds its cursor through a rounded computation the loop analysis cannot classify as an additive step, so spaced/noOverlap/bottom sequence facts stay underived (see negativeSegmentedFlushSequenceFactsUnderived and the trimmed photo-gallery grid-loop claims). The fix is value-level computation forms instead of expression-text atoms: a result remembers its operand values, so reclassification stops depending on time-sensitive text resolution.
- **Resurrect the division proof rules with value resolution**: `ceil(total / count) * count >= total` and `floor(p / cell) < count` are real-valid but the quotient can round across the integer boundary (in-domain witness: cell 4.044367056305642, count 13, p 52.57677173197334). Sound versions need the operands' integrality and a magnitude window, which the expression-text proof rules cannot resolve to values; give ProofRulesContext a value resolver.
- **Transcendental and `**` policy**: ECMA leaves them implementation-approximated, so their endpoint hulls rest on a host-libm monotonicity assumption (and the checker runs JSC while checked code may run V8). Decide whether to keep the assumption documented, widen hulls by an ulp, or drop the hulls.
- **Object aliased through an array element isn't forgotten when mutated through the array** (a real false-PROVE). `const box = {v: 1}; const arr = [box]; arr.forEach(o => { o.v = 999 }); return box.v` keeps `box.v` proved, because forgetting `arr` (and its elements) does not reach the separate `box` binding that aliases the same element — the array-literal localize-clone gives `box` and `arr[0]` distinct Value identities. Needs element-alias tracking, or havocing every binding reachable to a mutated element. The reverse order, `const first = arr[0]` then mutating `first`, is already sound.

- **Function-scoped callbacks lose receiver facts.** A callback passed by name to `map`/`filter`/`every`/`some` (or as `Array.from`'s mapper) has its effects applied like an inline one when it resolves to a top-level function or import, but a function-scoped `const double = ...` cannot be materialized yet (same limit as a direct `double(5)` call), so the receiver is forgotten conservatively even when the callback is pure. Resolving local function values fixes both the direct call and the callback case.
- **Scalar-push loops** don't emit nondecreasing relations today. `result.push(top); top += rowSize` with non-negative `rowSize` should give `nondecreasing(result)`; loop-source/loop-summary need the scalar-cursor case. Surfaced from draggable-cards `stackLayout` validation.
- **Nested array paths** for `nondecreasing` / `noOverlap` claims. `nondecreasing(return[].rowRect.top)` isn't supported by the current syntax; would help nicer-hacker-news. Either extend the call-argument parser to accept indexed paths, or require users to map first.
- Continue widening source inference so the same semantic claim works across more code spellings. Two pushes of `{top, height}` vs `{top, bottom}` should converge to the same relations. The Phase B refactor partially closed this; finish when a real divergence surfaces.
- Exhaustive integer sweeps for fully-bounded small comparisons (useful for any future cross-index bounded case).
- `ts.createScanner`-based `@fit` lowering. Replaces bespoke char-walkers in `src/parser.ts`. Marginal cost-benefit today; revisit when the parser needs touching anyway.

## Maintenance

- Reject obvious bad `given` lines early (empty ranges, direct contradictions) before proof runs.
- Report lines name where each fact came from. Missing pieces name the smaller relation when possible (`scale >= 0`, `count > 0`) instead of the whole failed comparison.
- Vacuity warnings for inconsistent assumptions.
