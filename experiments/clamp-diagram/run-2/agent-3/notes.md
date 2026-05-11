# Clamp Diagram Notes

## Contract-Driven Design Log

### Entry 1
- Decision: Use a fixed `viewBox` with two named side-by-side panels.
- Layout relationship or contract it protects: Panels stay inside the viewBox, and the ordered panel stays left of the inverted panel with a positive gap.
- Resulting geometry/code choice: `buildClampGeometry()` returns `viewBox`, `orderedPanel`, `invertedPanel`, and `panelGap`; contracts check panel containment and `orderedPanel.right + panelGap <= invertedPanel.x`.

### Entry 2
- Decision: Represent thresholds as explicit x-coordinates on each panel's z-axis.
- Layout relationship or contract it protects: Ordered bounds have `y` before `-x-y`; inverted bounds record the opposite ordering, with `-x-y` below `y`.
- Resulting geometry/code choice: Ordered names are `orderedLowerThresholdX` and `orderedUpperThresholdX`; inverted names are `invertedUpperThresholdX` and `invertedLowerThresholdX`; contracts check `orderedLowerThresholdX < orderedUpperThresholdX` and `invertedUpperThresholdX < invertedLowerThresholdX`.

### Entry 3
- Decision: Compute region boxes from plot bounds and threshold positions instead of hand-placing every band independently.
- Layout relationship or contract it protects: Region widths are nonnegative, and ordered regions exactly meet at the two thresholds.
- Resulting geometry/code choice: `orderedLeftRegion`, `orderedMiddleRegion`, `orderedRightRegion`, and `invertedInvalidGap` are built from threshold differences; contracts check their widths and threshold-aligned edges.

### Entry 4
- Decision: Give important text conservative label boxes before rendering.
- Layout relationship or contract it protects: Region labels stay inside their intended bands, threshold labels remain ordered, and formula boxes stay below the plot labels and inside panels.
- Resulting geometry/code choice: Named boxes such as `orderedLeftLabel`, `invertedDegenerateLabel`, `orderedPiecewise`, and `invertedPiecewise` are returned from the checked layer; contracts check containment and key non-overlap relations.

### Entry 5
- Decision: Use hatches, dots, stripes, direct labels, and threshold separators rather than relying only on color.
- Layout relationship or contract it protects: The visual distinction between regions remains visible even if color alone is ambiguous.
- Resulting geometry/code choice: SVG patterns are assigned to region rectangles, while the checked geometry keeps the separator and label placements stable.

## Freerange Intervention Log

No `fr *` command affected the implementation. The geometry was designed against explicit contracts first, and the required `fr check` passed on the first run.

## Freerange Non-Interventions

### Command
`bun run fr check experiments/clamp-diagram/run-2/agent-3/geometry.ts`

### Relevant Output
`fr check: 1 files, 137 pass, 0 fail, 0 requires, 0 unknown`

### What It Revealed
The written geometry contracts were within Freerange's supported proof surface and all proved.

### Change Made
No implementation change was made because of this command.

### Outcome
Passed.

### Classification
non-intervention

`fr infer` and `fr doctor` were not needed.

## Text Measurement

Text measurement was not needed. Conservative manual label boxes were used, and `~/github/pretext` was not used.
