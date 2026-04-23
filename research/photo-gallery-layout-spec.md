# Photo Gallery Layout Spec

This is the target red-line spec for photo-gallery layout. It is intentionally
closer to designer markup than theorem-prover prose: draw the visual fact, then
write the Freerange-ish arithmetic that should hold.

Scope: pure layout numbers, rectangles, measurements, arrays, z-order numbers,
and transition destinations. No DOM facts.

Some of these facts live in `layout.ts` today; others still live in the demo
or are target source shapes we may want later. This file names the visual red
lines first.

Coordinates are document-space unless noted. `scrollY` shifts the viewport
interval; it does not shrink viewport height.

## Constants

```ts
boxesGapX == 24
boxesGapY == 24
boxes1DGapX == 52
boxes1DGapY == 28
windowPaddingTop == 40
hitArea1DSizeX == 100

promptPaddingTop == 8
promptPaddingBottom == 8
promptPaddingX == 12
prompt2DMaxLines == 2
prompt1DMaxLines == 3

prompt2DLineHeight == prompt2DVisibleLinesHeight / prompt2DMaxLines
prompt1DLineHeight == prompt1DVisibleLinesHeight / prompt1DMaxLines
```

## 2D Card

```txt
layoutBox
+--------------------------------+
| imageBox                       |
+--------------------------------+
| promptPaddingTop               |
| quote + line 1                 |
| optional line 2                |
| promptPaddingBottom            |
+--------------------------------+

prompt box width == imageBox width
| promptPaddingX | text line(s) | promptPaddingX |
```

```ts
visibleLineCount <= prompt2DMaxLines
visibleLinesHeight == visibleLineCount * prompt2DLineHeight

prompt.box.x == imageBox.x
prompt.box.y == imageBox.y + imageBox.sizeY
prompt.box.sizeX == imageBox.sizeX
prompt.box.sizeY == promptPaddingTop + visibleLinesHeight
prompt.lines.length <= prompt2DMaxLines
prompt.lines[].width <= prompt.box.sizeX - promptPaddingX * 2

layoutBox.x == imageBox.x
layoutBox.y == imageBox.y
layoutBox.sizeX == imageBox.sizeX
layoutBox.sizeY == imageBox.sizeY + promptPaddingTop + visibleLinesHeight + promptPaddingBottom
```

## 2D Grid

```txt
windowSizeX
|<-------------------------------------------------------------->|
| gap | col 0 max | gap | col 1 max | ... | col n-1 max | gap |
```

There are `cols + 1` horizontal gaps for `cols` columns.

```ts
cols: int 1..7
boxMaxSizeX >= 0
windowSizeX == cols * boxMaxSizeX + (cols + 1) * boxesGapX
boxMaxSizeX == (windowSizeX - (cols + 1) * boxesGapX) / cols

items.length == layoutSources.length
items[].imageBox.sizeX <= boxMaxSizeX
items[].layoutBox.sizeX <= boxMaxSizeX
items[].layoutBox.x >= boxesGapX
items[].layoutBox.x + items[].layoutBox.sizeX <= windowSizeX - boxesGapX
```

2D hit testing uses `layoutBox` directly. Do not add a separate hit rectangle
unless the UX actually diverges from the card bounds.

For a card in a column:

```ts
column.left == boxesGapX + column.index * (boxMaxSizeX + boxesGapX)
item.layoutBox.x == column.left + (boxMaxSizeX - item.layoutBox.sizeX) / 2
```

Rows:

```txt
windowPaddingTop
|
v
row 0 top
+----------+   +----------+   +----------+
| item     |   | item     |   | item     |
+----------+   +----------+   +----------+

boxesGapY

row 1 top
+----------+   +----------+   +----------+
| item     |   | item     |   | item     |
+----------+   +----------+   +----------+
```

```ts
rows[0].top == windowPaddingTop
rows[].height >= 0
rows[].bottom == rows[].top + rows[].height
rows[$r + 1].top == rows[$r].bottom + boxesGapY

if rows.length == 0:
  contentHeight == windowPaddingTop

if rows.length > 0:
  // Keep the trailing vertical gap as scroll runway.
  contentHeight == lastEnd(rows) + boxesGapY

item.layoutBox.y >= row.top
item.layoutBox.y + item.layoutBox.sizeY <= row.bottom
item.layoutBox.y == row.top + (row.height - item.layoutBox.sizeY) / 2
```

Image sizing safety rails:

```ts
imageSizeX >= 0
imageSizeX <= naturalSizeX
imageSizeX <= boxMaxSizeX
imageSizeY == imageSizeX / ar
imageSizeY >= 0
```

Aspect policy:

```ts
// square
imageMaxSizeY == boxMaxSizeX * 0.85

// portrait
imageMaxSizeY == boxMaxSizeX * 1.05

// landscape
imageMaxSizeY == boxMaxSizeX
```

## 1D View

```txt
windowSizeX
|<---------------------------------------------------------------->|
| left hit | gap | focused image/prompt | gap | right hit |
|<-- hitArea1DSizeX -->|                  |<-- hitArea1DSizeX -->|

left neighbor peeks in from the left.
right neighbor peeks in from the right.
```

```ts
box1DMaxSizeX == windowSizeX - boxes1DGapX * 2 - hitArea1DSizeX * 2
box1DMaxSizeX >= 0

focusedBox.x == (windowSizeX - focusedBox.sizeX) / 2
focusedBox.x >= hitArea1DSizeX + boxes1DGapX
focusedBox.x + focusedBox.sizeX <= windowSizeX - hitArea1DSizeX - boxes1DGapX

leftNeighbor.layoutBox.x + leftNeighbor.layoutBox.sizeX == hitArea1DSizeX
leftNeighbor.layoutBox.x < 0

rightNeighbor.layoutBox.x == windowSizeX - hitArea1DSizeX
rightNeighbor.layoutBox.x + rightNeighbor.layoutBox.sizeX > windowSizeX
```

Vertical frame:

```txt
scrollY
|
v
+--------------------------------+
| windowPaddingTop               |
| focused image                  |
| focused prompt                 |
| boxes1DGapY                    |
+--------------------------------+
scrollY + windowSizeY
```

```ts
viewportTopY == scrollY
viewportBottomY == scrollY + windowSizeY
viewportSizeY == windowSizeY

box1DMaxSizeY == windowSizeY - windowPaddingTop - boxes1DGapY
box1DMaxSizeY >= 0

focusedBox.sizeY <= box1DMaxSizeY
focusedBox.y >= scrollY + windowPaddingTop
focusedBox.y + focusedBox.sizeY <= scrollY + windowSizeY - boxes1DGapY
```

Prompt:

```txt
focused image width
|<------------------------------------------------->|
prompt box width == focused image width
| promptPaddingX | up to 3 lines | promptPaddingX |
```

```ts
visibleLineCount <= prompt1DMaxLines
visibleLinesHeight == visibleLineCount * prompt1DLineHeight

prompt.box.x == imageBox.x
prompt.box.y == imageBox.y + imageBox.sizeY
prompt.box.sizeX == imageBox.sizeX
prompt.box.sizeY == promptPaddingTop + visibleLinesHeight
prompt.lines.length <= prompt1DMaxLines
prompt.lines[].width <= prompt.box.sizeX - promptPaddingX * 2

layoutBox.sizeY == imageBox.sizeY + promptPaddingTop + visibleLinesHeight + promptPaddingBottom
```

Edge hit areas:

```txt
left hit area                    right hit area
+-------------+                  +-------------+
|             |                  |             |
|             | viewport height  |             |
|             |                  |             |
+-------------+                  +-------------+
scrollY                          scrollY
```

```ts
leftHitArea.box.x == 0
leftHitArea.box.y == scrollY
leftHitArea.box.sizeX == hitArea1DSizeX
leftHitArea.box.sizeY == windowSizeY

rightHitArea.box.x == windowSizeX - hitArea1DSizeX
rightHitArea.box.y == scrollY
rightHitArea.box.sizeX == hitArea1DSizeX
rightHitArea.box.sizeY == windowSizeY
```

## Z Order

The focused item is above every non-focused item. Freerange only sees pure
z-index numbers produced by layout code.

```ts
// focused
z == count + 1

// non-focused
z == index + 1

z: int 1..1001
```

## Virtualization

```txt
expanded viewport
+-----------------------------+
| overscanTop                 |
| +-------------------------+ |
| | actual viewport         | |
| +-------------------------+ |
| overscanBottom              |
+-----------------------------+
```

```ts
expandedViewport.x == 0
expandedViewport.y == scrollY - overscanTop
expandedViewport.sizeX == windowSizeX
expandedViewport.sizeY == windowSizeY + overscanTop + overscanBottom

bounds.x < expandedViewport.x + expandedViewport.sizeX
expandedViewport.x < bounds.x + bounds.sizeX
bounds.y < expandedViewport.y + expandedViewport.sizeY
expandedViewport.y < bounds.y + bounds.sizeY
```

The exact rendered set should be exactly the items whose bounds pass the
expanded-viewport predicate.

## Transition Destinations

The spec does not try to prove animation taste. It only says that logical layout
is the destination and residuals are temporary offsets.

```ts
base.x == nextLayout.x
base.y == nextLayout.y
base.sizeX == nextLayout.sizeX
base.sizeY == nextLayout.sizeY

xResidual.dest == 0
yResidual.dest == 0
sizeXResidual.dest == 0
sizeYResidual.dest == 0

xResidual.pos == oldVisual.x - nextLayout.x
yResidual.pos == oldVisual.y - nextLayout.y
sizeXResidual.pos == oldVisual.sizeX - nextLayout.sizeX
sizeYResidual.pos == oldVisual.sizeY - nextLayout.sizeY
```
