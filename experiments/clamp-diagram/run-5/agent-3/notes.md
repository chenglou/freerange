# Freerange Notes

- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 236 pass, 25 fail, 3 unknown`.
  - Revealed missing/incorrect conditions:
    - A shared `makeColumnGeometry(..., ordered: boolean)` helper left the ordered/inverted branch ambiguous to Freerange. This made threshold-order checks use the wrong branch facts and exposed false label-containment failures.
    - `trustedContainedBox` and `trustedContainedPoint` had `panel.x`/`panel.y` upper bounds of `2000`; generic helper analysis could reach `2020`/`2134`, so the helper preconditions were too narrow.
  - Implementation changed:
    - Split the branchy helper into `makeOrderedColumnGeometry` and `makeInvertedColumnGeometry`.
    - Widened trusted containment helper input ranges from `0..2000` to `0..3000`.
- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 334 pass, 0 fail, 3 unknown`.
  - Revealed missing condition:
    - The per-column helper allowed `panelWidth: 400..700`, but the reserved labels need a wider column to prove containment for the ordered upper-branch label and inverted empty/collapse labels.
  - Implementation changed:
    - Tightened both column-helper input domains to `panelWidth: 500..700`, matching the generated equal-width columns.
- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 337 pass, 0 fail, 0 unknown`.
  - Revealed missing condition: none.
  - Implementation changed: none.
- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 337 pass, 0 fail, 0 unknown`.
  - Revealed missing condition: none.
  - Implementation changed: none.
- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 337 pass, 0 fail, 0 unknown`.
  - Revealed missing condition: none.
  - Implementation changed: none.

## Text Measurement

- No lazy text estimates remain.
- The SVG renderer uses fixed reserved boxes and named font/line-height/baseline parameters only.
- It does not use string-length estimates, glyph estimates, browser/DOM/canvas/Pretext measurement, screenshots, or raster sampling.
- The renderer loops over text lines only to emit tspans; line count is not used to derive box geometry.

## Candid Guideline Assessment

- The guidelines were a good fit for this experiment. Moving text content into `TextBlock` data made the SVG renderer more obviously a projection of checked geometry instead of a second place that knows what each side means.
- The biggest improvement was single source of truth: title, subtitle, column notes, formula text, graph labels, and the key point are now modeled before rendering, alongside their reserved boxes.
- Interpreting the ordered/inverted cases at the layout scope stayed useful. The `ColumnKind` switch is now only a rendering projection; the actual assumptions, labels, and formulas are already built in the ordered or inverted column geometry.
- Earlier versions still had Freerange proof scaffolding such as `reserveContainedBox` and `reserveContainedPoint`; a later cleanup removed those adapters after the top-level contracts could prove containment directly.
- There is still some conflict between the most natural branch-local code and current Freerange ergonomics. A `switch` with `break` is too natural for TypeScript but not yet supported by this checker path, so the column case layout uses a finite ternary object instead.
- At the time of that refactor, the duplicated ordered/inverted column constructors still reflected a checker limitation: one boolean/config-driven helper was harder for Freerange to reason about than two explicit cases.

## Finite Literal Refactor

- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 262 pass, 0 fail, 3 unknown`.
  - Revealed blocker:
    - A single `makeColumnGeometry(spec)` helper with `spec.kind: 'ordered' | 'inverted'` worked for most shared structure, but wrapping branch-specific `makeBox(...)` values inside one `reserveContainedBox(...)` call hid label containment facts.
  - Implementation changed:
    - Moved `reserveContainedBox(...)` inside each finite ternary branch for the middle and collapse labels.
- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 278 pass, 0 fail, 3 unknown`.
  - Revealed blocker:
    - Branch-local containment calls still used union-valued `yThresholdX` / `uThresholdX` locals, so Freerange could not prove the exact label edges generically.
  - Implementation changed:
    - Added explicit ordered/inverted threshold locals, then selected final returned thresholds from those exact per-case values.
- `bun run fr check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: `fr check: 1 files, 281 pass, 0 fail, 0 unknown`.
  - Freerange helped delete duplication:
    - Replaced `makeOrderedColumnGeometry` and `makeInvertedColumnGeometry` with one `makeColumnGeometry(spec: ColumnSpec)` using the finite `spec.kind` discriminant.
    - Kept ordered/inverted call sites as object literals: `{kind: 'ordered', ...}` and `{kind: 'inverted', ...}`.
- `bun run fr infer --function makeColumnGeometry experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: command passed.
  - Useful signal:
    - The shared helper infers the common panel/title/note/plot/formula facts, plus finite unions for label dimensions and branch-specific text metrics.
    - Generic `makeColumnGeometry` still cannot prove ordered-only or inverted-only threshold order as one unconditional fact, which is correct.
- `bun run fr infer --function createDiagramGeometry experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result: command passed.
  - Useful signal:
    - The literal call sites specialize correctly: ordered left column gets `LEFT_Y_THRESHOLD_OFFSET` / `LEFT_U_THRESHOLD_OFFSET`, inverted right column gets `RIGHT_Y_THRESHOLD_OFFSET` / `RIGHT_U_THRESHOLD_OFFSET`.
    - The top-level layout contract still checks equal columns, non-overlap, plot containment, label containment, ordered threshold order, and inverted empty-interval collapse.

## Cleanup Pass

- Removed:
  - `reserveContainedBox` and `reserveContainedPoint`; label, key text, and graph points are now direct `makeBox` / `makePoint` data.
  - The old proof-witness field `collapseValueY`; collapse is now checked directly with `return.right.diagonalStart.y == return.right.yBranchY` and `return.right.diagonalEnd.y == return.right.yBranchY`.
  - The old `emptyIntervalWidth` name; `middleIntervalWidth` now names the actual middle interval width in both cases.
  - Named per-case threshold locals such as `orderedYThresholdX` / `invertedYThresholdX`; case-specific plot data is grouped in one `ColumnPlotCase` object.
- `bun fr.ts check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result after removing reserve helpers and proof-witness fields: `fr check: 1 files, 81 pass, 0 fail, 0 unknown`.
  - Confirmed the top-level contracts still prove containment, non-overlap, ordered threshold order, and inverted collapse without the old adapters.
- `bun fr.ts check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Result during an attempted cleanup: `fr check: 1 files, 20 pass, 0 fail, 61 unknown`.
  - Caught blocker: Freerange reported `Unsupported statement in makeColumnGeometry: break` for a natural `switch` that built `ColumnPlotCase`.
  - Implementation changed: replaced that `switch`/`break` case layout with a finite ternary object.
- `bun fr.ts check experiments/clamp-diagram/run-5/agent-3/geometry.ts`
  - Final result: `fr check: 1 files, 81 pass, 0 fail, 0 unknown`.
  - Remaining Freerange-shaped code: `ColumnPlotCase` is built with a ternary object instead of a branch-local `switch` with `break`; otherwise no numeric tags, old ordered/inverted constructors, reserve helpers, or collapse-only proof witness fields remain.
