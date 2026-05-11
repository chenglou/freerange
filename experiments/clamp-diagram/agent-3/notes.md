# Clamp Diagram Experiment - Agent 3

## Output Summary

- `geometry.ts` defines the checked pure-geometry layer and an SVG renderer that consumes it.
- `diagram.svg` is the standalone SVG output generated from `geometry.ts`.
- The fixed viewBox is `0 0 1120 760`.
- The ordered panel shows `y` to the left of `-x-y` and splits `z` into three regions.
- The inverted panel shows `-x-y` to the left of `y`, marks the empty ordered interval, and describes the term as clamp-shaped and degenerate rather than as an honest clamp.

## Geometry Checks Covered

The Freerange contracts in `createDiagramGeometry` check relationships over the computed geometry, including:

- formula and panel boxes stay inside the viewBox
- ordered and inverted panels do not overlap
- panel titles, plots, label boxes, and notes stay inside their intended panels
- ordered thresholds satisfy `y < -x-y`
- inverted thresholds satisfy `-x-y < y`
- ordered region widths are nonnegative and exactly span the plot between thresholds
- inverted degenerate and inverted-gap regions are nonnegative and tied to their thresholds
- key ordered labels do not overlap each other
- threshold labels do not overlap
- axis anchors stay inside their plot/panel area

## Freerange Intervention Log

No `fr *` command caused an implementation change in this run. The checked geometry passed on the first run. The one concrete implementation bug found afterward was an SVG XML escaping issue from raw `<` text; that was found by `xmllint`, not by Freerange.

## Freerange Non-Interventions

### Command

`bun run fr check experiments/clamp-diagram/agent-3/geometry.ts`

### Relevant Output

`fr check: 1 files, 209 pass, 0 fail, 0 requires, 0 unknown`

### What It Revealed

The initial geometry contracts were all provable: panel containment, panel separation, ordered/inverted threshold ordering, region spans, label containment, label separation, and axis bounds.

### Change Made

None from Freerange.

### Outcome

Passed.

### Classification

non-intervention

### Command

`bun run fr check experiments/clamp-diagram/agent-3/geometry.ts`

### Relevant Output

`fr check: 1 files, 209 pass, 0 fail, 0 requires, 0 unknown`

### What It Revealed

After fixing SVG text escaping, the checked geometry layer still passed unchanged.

### Change Made

None from Freerange.

### Outcome

Passed.

### Classification

non-intervention

### Command

`bun run fr check experiments/clamp-diagram/agent-3/geometry.ts`

### Relevant Output

`fr check: 1 files, 209 pass, 0 fail, 0 requires, 0 unknown`

### What It Revealed

The final verifier pass still accepted the checked geometry after all required artifacts existed.

### Change Made

None from Freerange.

### Outcome

Passed.

### Classification

non-intervention

## Other Verification

### Command

`xmllint --noout experiments/clamp-diagram/agent-3/diagram.svg`

### Relevant Output

No output; exit code 0.

### What It Revealed

The regenerated SVG is well-formed XML.

### Change Made

Before the final pass, the renderer was changed to escape text content so math labels containing `<`, `<=`, and `>` become valid XML text.

### Outcome

Passed.

### Result

The renderer had a real SVG escaping bug before the final pass.

### Command

`rsvg-convert experiments/clamp-diagram/agent-3/diagram.svg > /dev/null`

### Relevant Output

No output; exit code 0.

### What It Revealed

The standalone SVG can be rendered by a normal SVG renderer.

### Change Made

None.

### Outcome

Passed.

### Result

Render smoke test passed.
