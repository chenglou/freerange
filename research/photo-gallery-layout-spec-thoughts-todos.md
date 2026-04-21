# Photo Gallery Layout Spec Thoughts And Todos

This is the stuff that should not bloat the main red-line spec: checker gaps,
possible syntax, and implementation questions that fell out of photo-gallery.

## Main Spec Cleanup

- Keep the main spec as a layout artifact, not a Freerange research memo.
- Prefer ASCII plus equations over explanatory paragraphs.
- Avoid helper sugar for facts that are already one or two comparisons.
- Keep browser-owned behavior out of scope. Freerange sees pure numbers and
  data, never the DOM.
- The older one-line snug prompt behavior is intentionally removed from the
  target spec. Prompt width should match image width in 2D and 1D.

## Current Core Can Mostly Handle

- Imported constants.
- Scalar ranges.
- Basic prompt sizing arithmetic.
- `layoutBox`, `imageBox`, and `prompt.box` field equalities.
- Image sizing safety rails.
- Hit-area rectangles.
- Z-index branch facts, if extracted into small functions.
- Expanded viewport construction.
- Positive visibility predicates, if split into simple comparisons.
- Transition destination and residual arithmetic, if extracted into small
  functions.

## Still Awkward In Current Freerange

### Same-Index Labels

Current `[]` means one collection side against scalars. It cannot say “the same
item” inside a repeated path or across two arrays.

```ts
items[$i].imageBox.sizeX <= layoutSources[$i].naturalSizeX
items[$i].prompt.box.x == items[$i].imageBox.x
items[$i].prompt.lines[$j].width <= items[$i].imageBox.sizeX - promptPaddingX * 2
```

`$i` is a spec index label, not a TypeScript variable. Reusing it means the same
index.

### Symbolic Focus And Neighbors

Current specs cannot index arrays by a symbolic focused item or talk about
neighbor existence.

```ts
items[focused].layoutBox.x == (windowSizeX - items[focused].layoutBox.sizeX) / 2
items[focused - 1].layoutBox.x + items[focused - 1].layoutBox.sizeX == hitArea1DSizeX
items[focused + 1].layoutBox.x == windowSizeX - hitArea1DSizeX
```

This likely needs bounds-aware symbolic indexing plus conditional facts for the
first and last item.

### Conditional Specs

Current Freerange can use branch facts from source, but the annotation language
cannot state conditional postconditions directly.

```ts
if focused == 0:
  leftHitArea == null
else:
  leftHitArea.box.x == 0

if visibleLineCount == 1:
  prompt.lines.length == 1
else:
  prompt.lines.length >= 2
```

### Nullable Field Refinement

Current specs do not have a clean “if non-null, then check these fields” shape.

```ts
if leftHitArea != null:
  leftHitArea.box.x == 0
  leftHitArea.box.sizeX == hitArea1DSizeX
```

### Pairwise Non-Overlap

Final 2D grid layout should not overlap. Current one-sided wildcard comparisons
cannot express pairwise relationships between distinct items.

```ts
for distinct items $a, $b:
  $a.layoutBox.x + $a.layoutBox.sizeX <= $b.layoutBox.x
    || $b.layoutBox.x + $b.layoutBox.sizeX <= $a.layoutBox.x
    || $a.layoutBox.y + $a.layoutBox.sizeY <= $b.layoutBox.y
    || $b.layoutBox.y + $b.layoutBox.sizeY <= $a.layoutBox.y
```

This probably wants a named pairwise atom with a clear report, not general
boolean logic sprayed everywhere.

### Adjacent Gaps In A Derived Order

Grid adjacency is derived from item index and `cols`: same row, adjacent columns.

```ts
same row and adjacent column:
  right.layoutBox.x >= left.layoutBox.x + left.layoutBox.sizeX + boxesGapX

adjacent rows:
  nextRow.top == row.bottom + boxesGapY
```

This may be better solved by returning row metadata from source before adding
syntax.

### Exact Render Set

The overlap predicate is current-core arithmetic. Exact filtering is not.

```ts
rendered == items.filter(item passes expanded viewport predicate)
```

This probably wants source-recognized filter summaries before it wants public
aggregate syntax.

### Relational Resize Anchoring

Anchoring compares old layout, new layout, old scroll, new scroll, and an anchor
index. Current Freerange can check arithmetic inside an extracted function, but
it cannot express the product-level relation cleanly yet.

```ts
oldAnchor: int 0..oldLayout.items.length - 1
newLayout.items.length == oldLayout.items.length
newAnchor: int 0..newLayout.items.length - 1

// target:
// keep the anchor item visible after resize
// keep the old anchor when it remains a good anchor
// preserve the anchor item's viewport-relative y as closely as the clamped
// scroll range allows
```

## Possible Source Changes

- Return full row metadata instead of only `rowsTop` if row red lines keep
  mattering:
  ```ts
  rows[].top
  rows[].height
  rows[].bottom
  ```
- Extract z-order into a small pure function if we want the focused-above-all
  relation to be checked directly.
- Extract transition-preservation arithmetic if we want residual setup checked
  directly.
- Keep prompt width simple now: `prompt.box.sizeX == imageBox.sizeX`.
- `gapTopPeek` belongs with scroll anchoring / dismissal positioning. Keep it
  out of the main layout spec until we decide to spec anchoring.

## Possible Checker Work

- Statement-level/local `@fit` would help annotate red-line variables close to
  their computation.
- Same-index labels look useful enough to keep thinking about.
- Nullable refinement and conditional postconditions matter for edge hit areas.
- Exact render-set checking matters for virtualization, but should probably
  come from source-recognized filter summaries before public aggregate syntax.
- Resize anchoring is probably its own design note. It is logical UI state, not
  just rectangle arithmetic.
