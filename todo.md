## Features Under Consideration

- **Arbitrary-pair non-overlap** for freely-positioned 2D boxes (the predictive-keyframes case). Outside the linear-plus-adjacent vocabulary. Either accept as outside, or add a small targeted decision procedure (small-array exhaustive, transitive closure, or SMT).
- **`reduce` recognition** for summing arbitrary numbers. The 0|1 counting case is covered by `filter(p).length`; `reduce` would cover summing widths, weights, totals.
- **Open-ended range spellings** (`int 1..`, `0..`). Hold off until the noise from spelling `Infinity` becomes annoying. If added, exclusion markers attach only to a written bound (`5<..` is strictly above 5); a bare `<..10` collides with the inline `< expr` comparison shorthand and stays out.
- **A `-Infinity<..Infinity` lint.** Strict at one infinity, inclusive at the other is almost always a misread of `-Infinity<..<Infinity` (the inclusive end still admits Infinity). Worth a warning when a range mixes an exclusive infinite endpoint with an inclusive one.

## Engine Work

- **Resurrect the division proof rules with value resolution**: `ceil(total / count) * count >= total` and `floor(p / cell) < count` are real-valid but the quotient can round across the integer boundary (in-domain witness: cell 4.044367056305642, count 13, p 52.57677173197334). Sound versions need the operands' integrality and a magnitude window, which the expression-text proof rules cannot resolve to values; give ProofRulesContext a value resolver.
- **Transcendental and `**` policy**: ECMA leaves them implementation-approximated, so their endpoint hulls rest on a host-libm monotonicity assumption (and the checker runs JSC while checked code may run V8). Decide whether to keep the assumption documented, widen hulls by an ulp, or drop the hulls.
- **Nested array paths** for `nondecreasing` / `noOverlap` claims. `nondecreasing(return[].rowRect.top)` isn't supported by the current syntax; would help nicer-hacker-news. Either extend the call-argument parser to accept indexed paths, or require users to map first.
- Continue widening source inference so the same semantic claim works across more code spellings. Two pushes of `{top, height}` vs `{top, bottom}` should converge to the same relations. The Phase B refactor partially closed this; finish when a real divergence surfaces.
- Exhaustive integer sweeps for fully-bounded small comparisons (useful for any future cross-index bounded case).
- `ts.createScanner`-based `@fit` lowering. Replaces bespoke char-walkers in `src/parser.ts`. Marginal cost-benefit today; revisit when the parser needs touching anyway.

## Maintenance

- Report lines name where each fact came from. Missing pieces name the smaller relation when possible (`scale >= 0`, `count > 0`) instead of the whole failed comparison.
