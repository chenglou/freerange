## Todo Ideas

-. Tighten input honesty where reports stay obvious. `given` contradiction checks already catch empty ranges, direct range contradictions, opposing linear comparison bounds, short chained contradictions, and obvious range/comparison chains. Widen this only when the failure can name the bad input fact plainly.
- Keep helper/import report lines precise. Reports should say where a fact came from: input assumption, loop `@fit`, source inference, branch inference, checked helper contract, or checked imported contract. Missing facts should name the smaller obligation when possible, e.g. `scale >= 0` or `count > 0`, not only the whole failed comparison.
- Turn scalar accumulators into reusable internal measures. Keep improving source inference for totals, guarded counts, extrema, and cursor updates when they feed later comparisons and reports cleanly. Do this as source inference, not public folds.
- Open-ended range spelling such as `int 1..` or `0..`. Keep `Infinity` until inline annotations are common enough that the visual noise matters.
- Public views: e.g. `view rows as spans(start: .top, size: .height)`
- Conditional helper contracts. Useful, but not just nicer comment placement.
- `sameLength` as a primitive. Append and running-sum inference often prove length directly.
- Exhaustive integer sweeps.
- public aggregate syntax, public callback contracts, or conditional postconditions.
- atoms: nondecreasing, partitions, sourceOrder, sameSource
