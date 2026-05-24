## Features Under Consideration

- **Arbitrary-pair non-overlap** for freely-positioned 2D boxes (the predictive-keyframes case). Outside the linear-plus-adjacent vocabulary. Either accept as outside, or add a small targeted decision procedure (small-array exhaustive, transitive closure, or SMT).
- **`reduce` recognition** for summing arbitrary numbers. The 0|1 counting case is covered by `filter(p).length`; `reduce` would cover summing widths, weights, totals.
- **Views via pure code**: users transform their field names with `arr.map(item => ({start, size}))` before calling catalog items. Confirm this works for the layouts that currently can't use `top/height/bottom` directly. Segmented-stack still hardcodes those names; revisit when a real case demands it.
- **Open-ended range spellings** (`int 1..`, `0..`). Hold off until the noise from spelling `Infinity` becomes annoying.

## Engine Work

- **Scalar-push loops** don't emit nondecreasing relations today. `result.push(top); top += rowSize` with non-negative `rowSize` should give `nondecreasing(result)`; loop-source/loop-summary need the scalar-cursor case. Surfaced from draggable-cards `stackLayout` validation.
- **Nested array paths** for `nondecreasing` / `noOverlap` claims. `nondecreasing(return[].rowRect.top)` isn't supported by the current syntax; would help nicer-hacker-news. Either extend the call-argument parser to accept indexed paths, or require users to map first.
- Continue widening source inference so the same semantic claim works across more code spellings. Two pushes of `{top, height}` vs `{top, bottom}` should converge to the same relations. The Phase B refactor partially closed this; finish when a real divergence surfaces.
- Exhaustive integer sweeps for fully-bounded small comparisons (useful for any future cross-index bounded case).
- `ts.createScanner`-based `@fit` lowering. Replaces bespoke char-walkers in `src/parser.ts`. Marginal cost-benefit today; revisit when the parser needs touching anyway.

## Maintenance

- Reject obvious bad `given` lines early (empty ranges, direct contradictions) before proof runs.
- Report lines name where each fact came from. Missing pieces name the smaller relation when possible (`scale >= 0`, `count > 0`) instead of the whole failed comparison.
- Vacuity warnings for inconsistent assumptions.
