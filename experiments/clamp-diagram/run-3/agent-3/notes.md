# Clamp Diagram Run-3 Agent-3 Notes

## 1. Parametric Text-Metrics Architecture

- `buildGeometry(metrics: TextMetricsInput)` is now the checked geometry surface.
- `TextMetricsInput` contains width/height pairs for top text, panel notes, ordered region labels, formula cards, inverted labels, and tick labels.
- Freerange `given` constraints define the supported metric envelope. Example: ordered side-region labels support text widths up to `90`, the ordered middle region label supports text widths up to `260`, formula text blocks support widths up to `110`, and panel notes support widths up to `480`.
- Label rectangles are computed as `metrics.<block>.width + 2 * paddingX` and `metrics.<block>.height + 2 * paddingY`; they are not generated browser measurements or opaque guessed boxes.
- The middle ordered region label has an explicit fallback branch: when its metric-derived box is wider than the middle plot region, it moves to a shelf below the plot and above the formula-card row. Freerange proves the returned box is contained in the panel and stays above the formula row for all bounded metrics, and the returned `fallback` flag is `0 | 1`.
- `exampleMetrics` exists only to render the standalone static SVG. It uses a simple deterministic character-count estimate, not browser measurement, and is not the proof target.

## 2. Pretext / Browser Note

- This redo intentionally used no Pretext measurement, browser, headless browser, Playwright, DOM, canvas, screenshots, render sampling, or browser-based text metrics.
- The goal of this revision is parametric layout verification: text metrics are runtime-style numeric inputs with explicit bounds, like nullable values in a type system.
- The previous browser-measurement artifacts were removed: `measure-text.ts`, `text-metrics.ts`, and `text-metrics.json`.

## 3. Freerange Intervention Log

No `fr *` command forced a reactive implementation change in this redo. Freerange shaped the design up front: metric bounds were made explicit inputs, label boxes were derived from those metrics, and contracts were written against relationships instead of static measured strings.

## 4. Freerange Non-Interventions

Current note: on the current `main` checker, `fr check --annotations-only experiments/clamp-diagram/run-3/agent-3/geometry.ts` passes with `134 pass, 0 fail, 0 requires, 0 unknown`. Plain `fr check` also scans the top-level `buildGeometry(exampleMetrics)` call and reports 42 unknown preconditions because the example metric estimator uses `Math.max(...spread)` and `lines.reduce`, which this checker path does not summarize yet. The parametric geometry contract remains the proof target for this run.

### Command
`bun run fr check experiments/clamp-diagram/run-3/agent-3/geometry.ts`

### Relevant Output
`fr check: 1 files, 128 pass, 0 fail, 0 unknown`

### What It Revealed
The first parametric metric design, including the middle-label fallback branch, was provable.

### Change Made
None because of this command.

### Outcome
Passed.

### Classification
non-intervention

### Command
`bun run fr check experiments/clamp-diagram/run-3/agent-3/geometry.ts`

### Relevant Output
`fr check: 1 files, 134 pass, 0 fail, 0 unknown`

### What It Revealed
The final version, with widened panel-note metric bounds and explicit panel-text horizontal containment contracts, was provable.

### Change Made
None because of this command.

### Outcome
Passed.

### Classification
non-intervention

## 5. Difficulties Log

- No browser or Pretext measurement was used, by design.
- Freerange could express and prove the parametric metric bounds and the fallback branch’s joined safety properties.
- One nuance remains: the contracts prove the selected middle-label box is safe for all bounded metrics and that the fallback flag is numeric, but they do not express an implication like “if `fallback == 0`, then the label is inside the middle region.” The code branch enforces that placement decision; the checked public guarantee is unconditional containment/non-overlap safety.
- `fr check` took noticeably longer than the earlier constant-metric version, but completed cleanly.

## Validation

- `bun geometry.ts` regenerated `diagram.svg`.
- `xmllint --noout diagram.svg` passed.
- No browser/render validation was run.
