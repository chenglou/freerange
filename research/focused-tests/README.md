# Focused Tests

Small pure layout examples. They are not mini apps. They are meant to be easy to read alone, with enough real geometry to keep the verifier honest.

## `generated-list-geometry.ts`

Generated lists, tables of contents, lists of figures, outline panes. The geometry depends on row level and document class, and every line carries explicit slot edges: `numberX`, `textX`, `leaderFrom`, `leaderTo`, `pageNumberX`, `pageNumberWidth`. Only the terminal wrapped line owns the leader and page-number slots. When an entry has no page number, all of those trailing slot fields report `-1`.

Why it stresses the verifier:

- the indent ladder switches on both `level` and `documentClass`
- terminal-line-only behavior needs a line-by-line check
- optional slots need facts for both present and absent page numbers

## `page-break-bundles.ts`

Paginated block flow with keep-with-next pairs, page budgets, and heading-plus-top-float bundles that promote only once the current page has too little remaining height.

Why it stresses the verifier:

- placement is sequence policy over a loop, not one formula
- promotion is a real reorder: top floats can be placed before their heading
- page summaries and block placements have to agree on the same budget

## `table-column-negotiation.ts`

Table column negotiation where single-column and spanning constraints tighten the same width vector, then total width is derived from that vector plus gaps. Spanning cells subtract their internal gaps before distributing the missing width.

Why it stresses the verifier:

- the natural code writes `widths[column] = Math.max(...)` and `widths[column] += extraPerColumn`
- later single-column cells can still dominate after a span
- range mode can take structured cell constraints and prove lower bounds on the resulting vector

When a test suggests a general proof shape, add the smallest representative to [patterns.ts](../../patterns.ts). Keep these readable.
