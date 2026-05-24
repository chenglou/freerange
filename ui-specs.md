# UI Specs From The Five Demos

Specs collected from `photo-gallery` (local), `photo-gallery` (vibescript, the more advanced one with pretext), `nicer-hacker-news`, `scroll-anchor`, `draggable-cards`, `life-calendar`, plus the README at chenglou.github.io. Cross-cutting — the demos repeat the same handful of patterns under different names.

Each item: what the spec says, where it shows up, whether the analyzer can express it today, and what it would require if not.

---

## 1. Sizes Stay Inside Bounds

The boring stuff. Every demo has a few of these.

- **Image width ≤ box max width, and ≤ natural width.** photo-gallery `gridImageSizeX`. Doable today.
- **Column count is clamped to [1, 7] based on container width.** photo-gallery `colsBoxMaxSizeXF`. Doable today.
- **HN container width is clamped to [375, 1200].** nicer-hacker-news `containerWidthF`. Doable today.
- **Block size in life-calendar fits the grid exactly: `countX * blockSize == gridFinalSizeX`.** Already annotated in the source. Doable today.
- **A row's height in HN is `userHeight + userGap + commentHeight + bottomGap` and never less than the empty minimum.** Doable today.
- **1D-mode line layout: `box1DMaxSizeX == windowSizeX - 2*gap - 2*hitArea`.** Already annotated. Doable today.

These are the "no negative widths, no oversized images, no off-by-one cols" guarantees. The freerange analyzer already proves most of them.

---

## 2. Non-Overlap — The Defining Family

What CSS can't statically tell you. Same shape across demos.

- **2D grid: no two boxes occupy the same screen region.** photo-gallery 2D mode. Needs **pairwise non-overlap** — the cross-index quantifier we've talked about. Not yet doable.
- **2D grid: column i's box doesn't horizontally overlap column i+1's box** (weaker; same-row only). Doable today with adjacent labels.
- **2D grid: row r ends before row r+1 starts.** Doable today (`spaced(rows, gap)`).
- **1D mode: focused image is centered; side images don't horizontally overlap each other or the focused one.** Pairwise within the visible neighbors. Doable today via "sequence facts on the 1D-laid-out items" but needs the line-layout to expose `items[$i+1].x >= items[$i].x + items[$i].sizeX + gap`.
- **Draggable cards: at rest, no two cards overlap vertically.** Stack monotonicity — `card[i+1].y >= card[i].y + card[i].sizeY`. Doable today with `nondecreasing`/`spaced`.
- **HN thread: parent comment box, child gutter line, and child user banner don't collide with the comment text.** Currently enforced by code, not statically verified. Doable in pieces with adjacent labels.

The cross-index `for all i ≠ j` is the missing primitive. Once it lands, half the demos benefit immediately.

---

## 3. Hit Areas Are Decoupled From Animated Position

The single most-quoted UI nuance — every demo does this and it should be a spec category, not just a code pattern.

- **A box's hit rectangle uses its destination position, not its currently-animating position.** photo-gallery `hitTest2DMode` reads `x.dest`/`sizeX.dest`. **Spec shape:** the hit-test function takes destinations, never the animated `pos` values. Provable today as "hit-test reads only `.dest`, never `.pos`."
- **In 1D mode, the left/right hit areas are static rectangles anchored to the viewport, not to the side images.** photo-gallery vibescript `getLineLayout` returns `leftHitArea`/`rightHitArea` as explicit rects with `{x: 0, y: scrollY, sizeX: hitArea1DSizeX, sizeY: windowSizeY}` and `{x: windowSizeX - hitArea1DSizeX, ...}`. **Spec shape:** the hit areas extend the full window height and don't move during animation. Doable today (already annotated).
- **Hit areas at the screen edges never overlap each other.** Trivially: `leftHitArea.x + leftHitArea.sizeX <= rightHitArea.x` when both exist. Doable.
- **The dragged card hit-tests against its own animated position, not the rest-position.** draggable-cards `hitTest` is the deliberate exception. **Spec shape:** for the dragged item the rule is "animated pos = pointer pos minus grab offset" so the hit area equals the drag position. The general rule still holds: hit areas use whichever-version is layout-stable.
- **HN row hit-testing ignores animating row heights** (uses `rowHeightNatural`), so a row shrinking under the cursor doesn't cause infinite cycle of cursor moving into the next row, which makes that row's neighbors expand again. nicer-hacker-news line 372ish. **Spec shape:** the hit geometry function and the visual geometry function are two separate functions, and the hit one takes `rowHeightNatural` as input.

---

## 4. Animation Is Decoupled From Layout Position

The vibescript photo-gallery makes this explicit with the `AnimatedRect` shape. Worth lifting as a general principle.

- **Each animated rect has `x, y, sizeX, sizeY` (base, unanimated) plus `xResidual, yResidual, sizeXResidual, sizeYResidual` (springs that decay to 0).** Final visual position = base + residual.
- **Resize alone doesn't touch residuals.** A box that doesn't move slot keeps `residual == 0`; it sits at its new layout position immediately. Stated explicitly in the vibescript README: "Only the right properties are animated, and only at the right times."
- **Going into 1D / dismissing 1D / changing focused-image / resizing in 1D: stash current visual position in residuals and let them decay back to 0.** Done by `setAnimatedRect(d.layoutBox, layoutBox, preservePosition, preserveSize)` — preserve flags pick which case.
- **Scroll-shift preservation:** when scrollY changes during a dismiss/reflow, shift all `yResidual.pos` by the delta so the visual position stays put while the base catches up. photo-gallery vibescript `shiftSpringPos`.

**Spec shape for the analyzer:** "if `preservePosition` is false, then after `setAnimatedRect`, `xResidual.pos == 0 && yResidual.pos == 0`." Doable today as a relation.

---

## 5. Spring At-Rest Settles Cleanly

All three spring-using demos share the convergence test.

- **A spring stops animating when `|v| < 0.01 && |dest - pos| < 0.01`.** photo-gallery + draggable-cards. **Spec shape:** "the at-rest predicate implies `pos == dest`" (because `springGoToEnd` snaps). Doable today.
- **Stiffness `k > 0` and damping `b > 0`** — already annotated. Doable today.
- **Step count per frame is bounded:** `steps = min(300, floor((now - lastTime) / 4))`. photo-gallery vibescript. Caps catch-up after the tab was backgrounded. Doable today.
- **All springs in the system tick the same number of steps per frame.** No partial spring updates. Doable as "loop reaches end of spring array."

---

## 6. Framerate-Decoupled Physics

- **Physics step is fixed at 4ms regardless of frame interval.** Comment in source explains: "could use 8ms instead, but 120fps' 8.3ms/frame means the computation might not fit in the remaining 0.3ms." Doable as a literal-value spec: `msPerAnimationStep == 4`.
- **`animatedUntilTime` advances by `steps * 4ms`, never by `(now - lastTime)` directly.** So accumulated time-rounding error stays bounded. Spec shape: "the remainder `(now - animatedUntilTime) % 4` is preserved as carry into the next frame." Doable with simple linear facts.

---

## 7. Z-Index / Depth Stays Sane

- **The focused image in 1D mode has the highest z-index.** photo-gallery: `data.length + 1`. **Spec shape:** `focused.zIndex > max(otherBoxes[].zIndex)`. Doable today.
- **The dragged card sits above all others; the just-released card sits second-highest until it lands.** draggable-cards. Same shape.
- **HN: user banner sits above its comment; canvas (gutter) sits above users; comments-scroller sits on top of canvas.** Three named layers: `userZIndex < canvasZIndex < commentsScrollerZIndex`. Doable today as constants and a chain of `<`.
- **No two unrelated boxes share the same z-index when they overlap.** Tighter; needs pairwise reasoning over visible boxes. Not yet doable for the general case, but the "focused on top" subset works.

---

## 8. Occlusion / Virtualization

The recurring CSS-can't-do-this claim.

- **The visible-box set is bounded by viewport size.** photo-gallery: a box is rendered iff its rect intersects `[browserUIMaxSizeTop above, windowSizeY + browserUIMaxSizeBottom below]` and `[0, windowSizeX]` horizontally. **Spec shape:** "at most ⌈viewportHeight / minBoxHeight⌉ × ⌈viewportWidth / minBoxWidth⌉ boxes pass the visibility predicate." This is the **counting bound** ("at most N visible") we've discussed. Not yet doable — needs the counting-quantifier primitive.
- **A weaker form that IS doable:** "the visibility predicate is a conjunction of four interval comparisons (top, bottom, left, right) against the viewport." Doable today as a static-shape claim on the predicate.
- **scroll-anchor: visible nodes are exactly those whose `[y, y + itemHeight]` intersects `[scrollTop, scrollTop + viewportH]`.** Same predicate shape.
- **nicer-hacker-news: visible rows are those with `rowRect.top <= scrollerHeight && rowBottom >= 0`.** Same shape, scoped to the inner scroller.

**Visibility-predicate-equivalence:** prove the user's inline `box.x <= W && box.x + box.sizeX >= 0 && ...` equals the canonical `rectsIntersect(box, viewport)`. Useful but not yet doable; needs the predicate-equivalence primitive.

---

## 9. Scroll Anchor — Keep What You're Looking At

The scroll-anchor demo's entire point, but echoes in photo-gallery's resize-and-dismiss code.

- **When inserting items above the current scroll position, scrollTop is adjusted by exactly the inserted height so the visible item's screen position is preserved.** anchor-layout: `adjustedScrollTop = currentScrollTop + (newY - prevY)`. Doable today as a literal equation.
- **On window resize that changes column count in 2D photo-gallery: the anchor box's `y - gapTopPeek` becomes the new scrollTop, so the box stays roughly where it was.** Doable.
- **The anchor is the first leftmost-column box whose bottom exceeds 20% of viewport height.** photo-gallery line 351. Doable as a predicate.
- **A new anchor is picked when the current one moved by more than `viewportHeight / 10`.** Doable.
- **Reading scrollTop back is required after a programmatic scrollTo, because Chrome truncates to half-pixel and Safari/Firefox to integers.** scroll-anchor explicitly stores the read-back value. **Spec shape:** "if we set `scrollTop = X` then immediately read it back, the diff is at most one pixel." Not yet doable — needs a noisy-write primitive. Worth flagging.

---

## 10. Modes And Mode Transitions

- **Two modes: 2D grid and 1D line. Mutually exclusive.** photo-gallery: `focused: number | null`. `null` = 2D, number = 1D. Doable today as a discriminated union.
- **Entering 1D from 2D: focused is set; the chosen box stays where it was visually while it animates to center.** `entered1D = focused == null && newFocused != null`. Doable.
- **Dismissing 1D back to 2D: if the focused box's grid row isn't fully visible, scroll-adjust to show it (peeking the row above).** Doable as a conditional scroll adjustment.
- **Switching focused image inside 1D: the previously-focused image and the new one both animate from their current visual positions.** `changedFocusIn1D` flag. Doable.

---

## 11. Aspect-Ratio-Aware Sizing

- **Square images (ar == 1) are shrunk by 0.85 because area matters, not width.** photo-gallery layout. Doable as a piecewise function `imgMaxSizeY` returning `box * 0.85` for ar==1, `box * 1.05` for ar<1, `box` for ar>1.
- **Image area variance across the grid is bounded.** Stronger claim, not yet doable — needs cross-image variance. Worth flagging.

---

## 12. Edge Behaviors

- **Pressing ArrowLeft on focused=0 (or ArrowRight on last) adds rubber-band velocity, doesn't change focus.** photo-gallery. **Spec shape:** "newFocused == clamp(0, focused + delta, data.length - 1)" plus "velocity injection is non-zero only when delta hits a boundary." Doable.
- **Pressing left rubber-bands the focused image, side images get the same nudge scaled down by 4.** Doable as a literal scale relation.
- **nicer-hacker-news bottom edge rubber-band: `scrollerHeightNatural -= (scrollTop - scrollTopMax) / 2`.** Doable.
- **nicer-hacker-news top edge: when `scrollTop < 0`, submission title shifts proportionally.** Doable.

---

## 13. Accumulators And Reducers

All the demos build up totals/max in a loop.

- **photo-gallery `rowsTop`: cumulative top of each row, sum of previous row heights + gaps.** Doable today (we just centralized this with `runningSumFacts`).
- **photo-gallery `rowMaxSizeY`: max of all box heights in a row.** Doable (running max).
- **HN `rowsHeightNatural`: sum of all row heights.** Doable.
- **HN `rowsScrollerTopGap`: sum of `(rowHeightNatural - row.height)` across rows.** A guarded running sum where the delta can be negative; cleaner than the simple case.
- **draggable-cards `stackLayout`: `tops[i] = paddingTop + sum(sizes[0..i-1])`.** Already annotated. Doable.

---

## 14. Input Coordination

- **Pointer state has three values: 'up' / 'firstDown' / 'down'. firstDown is consumed inside one frame, then becomes 'down' on the next.** Two demos use this. **Spec shape:** "after one render, firstDown becomes down." Doable as a finite-state-machine invariant.
- **Click coords override mousemove coords on the same frame** (because Chrome reports stale mousemove coords after context menu dismissal). photo-gallery + nicer-hacker-news comments. **Spec shape:** "if events.click != null, pointer.x = events.click.clientX." Doable.
- **Events accumulate between renders, are cleared at end of render.** `events.keydown = events.click = events.mousemove = null`. **Spec shape:** "after render returns, all event slots are null." Doable.
- **Pointer starts at -Infinity until first real input.** photo-gallery + life-calendar. Doable as an init invariant.

---

## 15. Selection / Text

- **Clicking a photo-gallery prompt selects its full text without changing focused image.** Doable as "if click target is a figcaption, newFocused == focused."
- **nicer-hacker-news: text selection is locked to one comment row at a time.** Cross-row selection is replaced with "select from start of selected row to first character of pointed-up row" or "selected row to last character of pointed-down row." **Spec shape:** `selection.row` is set once on first text-down and stays. Doable.
- **Selection range is recomputed each frame to match the underlying text after virtualization re-attaches the node.** `resolveHNCommentTextOffset` rebinds. **Spec shape:** "after re-attach, selection.{start,end}TextOffset stays equal." Doable as an equality fact.

---

## 16. Cursor

- **Cursor state is computed once per render based on the pointer's hit class.** photo-gallery: `'auto' | 'zoom-in' | 'zoom-out' | 'pointer' | 'text' | 'row-resize' | 'grab' | 'grabbing'`. **Spec shape:** "cursor is a finite enum and the assignment is exhaustive (no fallthrough cases)." Doable as discriminated-union exhaustiveness.
- **The cursor is only written once at the end of the frame.** Avoid mid-frame writes. Doable as "cursor variable assigned at most once" — though this is the kind of thing the analyzer probably can't see today and shouldn't, since branches in the source naturally assign in different places.

---

## 17. Routing / URL Hash

- **The URL hash equals the focused image's id, or empty when none focused.** photo-gallery. Doable as an equality between two strings (with the special case of empty-string for null).
- **`popstate` triggers a re-render but doesn't write back to URL.** **Spec shape:** "popstate handler reads window.location.hash; it doesn't call history.pushState." Doable as a flow restriction.

---

## 18. DOM Node Lifecycle

- **A box's DOM node exists iff its visibility predicate is true.** photo-gallery + nicer-hacker-news + scroll-anchor. Equivalence of "in DOM" with "visible." Doable today as a biconditional fact.
- **JIT creation: first visibility creates the node and stores it in a cache. First invisibility removes it from DOM (and from the cache in vibescript's version, or keeps it in cache in the local version).** Two policies, both valid. **Spec shape:** the cache size is bounded by the visible set, plus possibly a constant tail.
- **DOM reads come before any DOM writes within a single render.** Architectural rule called out in the README. **Spec shape:** "in the render function body, all `document.documentElement.clientWidth`-shaped reads happen before any `style.X = ...` writes." This is a flow ordering, not a value range — not yet doable but worth flagging.
- **At most one render is scheduled per frame.** `scheduledRaf` guard. Doable as "if scheduledRaf != null then the inner requestAnimationFrame callback isn't called again."

---

## 19. Performance Budgets

- **Blur effect applied to at most 3 boxes** (focused-1, focused, focused+1) — Safari blur perf. **Spec shape:** "of all visible boxes, at most 3 have `filter: blur(...)` set." Counting bound. Not yet doable.
- **Brightness effect applied only when 1D mode is active for non-focused.** Doable as conditional.
- **Total DOM node count is bounded by visible set + a small constant** (the dummy placeholder, search input, canvas). Doable.

---

## 20. Reduced Motion / Accessibility

- **When `prefers-reduced-motion: reduce` matches, every spring snaps to `dest` immediately.** photo-gallery: `if (animationDisabled) springForEach(springGoToEnd)`. **Spec shape:** "after that branch, every spring satisfies `pos == dest && v == 0`." Doable as a universal claim over `springs[]`.

---

## 21. Browser Differences

- **iPad Safari overflow:hidden is broken — local container needs `contain: layout; width: 100vw; height: 100vh`.** Documented in source.
- **Chrome doesn't rubber-band inside an inner scroller, only at page level — so when Safari, scroll the body; else scroll the window.** photo-gallery.
- **`scrollTop` returns integers on Safari/Firefox and a half-float on Chrome.** scroll-anchor.
- **Safari's energy consumption warning triggers above ~60% one-frame CPU.** Implicit budget.

These aren't usually statically verifiable, but they're worth a "platform-known-quirk" lookup table — like the ambient JS/DOM bounds we already have (`element.clientHeight: int 0..Infinity`).

---

## 22. Image Loading

- **The low-res 384px version is set as `background-image` on the container; the high-res `.webp` is swapped onto an `<img>` only when the box is focused and animation is at rest.** Avoids flash. **Spec shape:** "img.src is the low-res URL unless `i == newFocused && !stillAnimating`." Doable as a conditional value.

---

## 23. life-calendar-Specific

- **The grid block size satisfies `blockSize == gridFinalSizeY / countY` and `countX * blockSize == gridFinalSizeX`.** Already annotated; we've talked about this before. Doable.
- **Hit testing: a pointer at `(px, py)` lands on cell `floor(py/blockSize) * countX + floor(px/blockSize)`, valid only when both are inside the grid.** Already annotated with `given px < countX * blockSize`. Doable.
- **Inverse of hit testing: cell `i` is drawn at `(i % countX * blockSize, floor(i / countX) * blockSize)`.** "hit(draw(i)) == i" round-trip property. Doable as two annotated functions plus a consistency relation.

---

## 24. nicer-hacker-news-Specific

- **Indentation forms a tree: row[i+1].indent ∈ {row[i].indent + 1, row[i].indent, ..., 0}.** Comments can't skip-down (you can't have indent 5 then indent 3 with no intermediate). Actually wait — you CAN go from indent 5 to indent 1 (closing out two parents). So the rule is: `next.indent <= current.indent + 1` (only one step deeper at a time). Doable as an adjacent label.
- **For a row at indent k, its gutter goes from its bottom up to the bottom of the last descendant (last row with indent > k).** **Spec shape:** finds the next row at indent ≤ k and stops there. Doable today with the loop summary form, but the "find next" is a search, which is harder to express cleanly.
- **Submission shrinks as you scroll down: `submissionHeight = submissionHeightNatural - min(submissionHeightDelta, scrollTop)`.** Already a piecewise function. Doable.
- **When the submission is fully shrunk and you keep scrolling, the scroller takes the remaining viewport.** Continuity at the boundary. Doable.

---

## 25. draggable-cards-Specific

- **Swap rule going up: swap with previous if pointer.y < previous.dest.y + previous.sizeY / 2.** Already factored out as `shouldSwapUp`. Doable.
- **After swap, the swapped card's `y.dest` is recomputed from the new stack layout.** **Spec shape:** "post-swap, `data[i].y.dest == rowTops[i]`." Doable as an equality.
- **Momentum on release: terminal velocity = average pointer velocity over the last ~100ms.** Already annotated. Doable.

---

## 26. scroll-anchor-Specific

- **When a header is at the top of a new "session day," its y equals `previousSessionEnd + headerGapTop`** (first session uses gap 0, rest use 32). Doable as a piecewise relation.
- **Anchor id stays the same as long as you don't user-scroll; user-scroll picks a new anchor.** Two-mode state machine. Doable.
- **The adjustment formula `adjustedScrollTop = currentScrollTop + (newY - prevY)` literally preserves visual position of the anchor item.** Already annotated. Doable.

---

# What's Doable Today (rough percentage)

Skimming the list: maybe 75% is doable today with current freerange features (ranges, comparisons, adjacent labels, sequence facts, conditional branches, accumulator inference). The remaining 25% needs at least one of:

1. **Cross-index quantifier** (`for all i ≠ j`) — for pairwise non-overlap and "no two boxes share z-index."
2. **Counting bound** (`at most N items satisfy predicate P`) — for visibility-set bound, blur-set bound.
3. **Predicate equivalence** — for verifying inline visibility checks match the canonical form.
4. **Flow ordering** ("DOM reads before writes") — different shape; possibly out of scope (not numerical).
5. **Cross-collection same-index** (`for all i, items1[i].x == items2[i].x`) — for selection-after-virtualization, anchor-id-preservation.
6. **Round-trip property** (`f(g(x)) == x` over a range) — life-calendar hit ↔ draw.

## 27. predictive-keyframes — A Different Rendering Paradigm

This demo doesn't render per frame. It simulates ~1.2 seconds of physics forward, generates `Keyframe[]` for each box, and hands the whole animation to the browser via `Element.animate()`. JS then sleeps 300ms before the next round. This is a different architecture than the other demos — worth flagging because the spec shapes are different too.

### Architecture specs

- **Render cadence is `setTimeout(300ms) then requestAnimationFrame`, not raf-per-frame.** During the 300ms window, the JS main thread is idle while the browser interpolates between predictive keyframes. **Spec shape:** "scheduleRender is called at most once per ~300ms cycle." Doable as a rate-bound claim (not yet doable cleanly — we don't model time as a domain).
- **Each render predicts `ceil(1200 / 6) = 200 frames` of future physics, generates `Keyframe[]` per box, hands to `node.animate(...)`.** Predicted state is a *fork* of the current state, not the next state — simulation continues from the current state on the next render, not from the predicted state. **Spec shape:** the simulate function is pure (returns a new world, doesn't mutate). Doable today as a value-equality fact on inputs vs outputs (the function takes `World` and returns `World`).
- **Animation duration matches `(keyframes.length - 1) * msPerAnimationStep`, easing is `steps(N, end)`** — each keyframe is a discrete frame, not interpolated. The browser sets the style at exactly the right wall-clock time, then steps to the next. **Spec shape:** "animation total duration == frame count × step ms." Doable today as an equality.
- **Previous animations are cancelled before new ones are issued.** Otherwise the browser would queue them and play in sequence. **Spec shape:** "for every cached node, exactly one Animation is active at any time." Counting bound + lifecycle invariant. Not yet doable cleanly.

### Physics specs

- **Each box has `centerX, centerY, vx, vy` plus springs for opacity and scale.** Position is Euler-integrated; opacity/scale go through the standard spring. Two physics styles in one box.
- **Velocity is heavily damped per step: `vx *= 0.2, vy *= 0.2`.** Almost position-controlled. **Spec shape:** "after each step, `|vx_next| <= 0.2 * (|vx| + max_force)`." Doable as a bound chain.
- **Force comes only from pairwise overlap area.** `calculateRepulsion(self, other)` returns `force = remap(overlapArea, 0, selfArea, 0, 15 * enterProgress)` in the direction from other to self. Zero force when `overlap == 0`. **Spec shape:** "force == 0 ⇔ overlapArea == 0." Equivalence. Doable today as a conditional implication.
- **Forces decay as boxes finish entering.** `enterProgress` ramps from 0 to 1 over 1 second (`+= msPerAnimationStep/1000` per step, clamped to 1). The repulsion force scales by `enterProgress`. So newly-spawned boxes don't violently push others. **Spec shape:** "after 1 second of simulation, `enterProgress == 1`." A bounded counter.
- **Force is skewed by aspect ratio:** `force.x *= (containerWidth/containerHeight) * 0.8`. So wide screens get extra horizontal push, keeping the dispersion visually balanced. **Spec shape:** literal equation. Doable.
- **Scale destination depends on edge distance:** `scale.dest = 1 - max(0, 0.9 - minEdgeDistPct)^10`. Boxes near edges shrink. The exponent 10 makes the falloff sharp. **Spec shape:** `scale.dest ∈ [some_floor, 1]`. Doable as a piecewise range.
- **A box starts exiting when `minEdgeDistPct <= 0.05`** (within 5% of any edge). Once exiting, `opacity.dest = 0` and it can't un-exit. **Spec shape:** "exiting is monotone — once true, stays true." A non-decreasing boolean. Doable today as `exiting[$i+1] >= exiting[$i]` across simulation steps (where >= treats false=0, true=1).
- **A box is removed from the array when `exiting && opacity.pos == 0`.** Two-step removal: first mark exiting (opacity starts animating to 0), then on a later step when the spring lands at 0, drop from the array. **Spec shape:** "array length decreases by at most one per step." A bounded delta.

### Spawn rate specs

- **Boxes spawn from container center at a countdown-throttled rate.** `nextBoxCountdown` starts at 200ms-1.5s for normal, 2.5s-3.5s for "aesthetic" boxes, ticks down by `msPerAnimationStep` per step, spawn happens when it hits 0. **Spec shape:** "spawns per second ≤ 1 / 200ms = 5 (worst case)." Rate bound. Not yet doable cleanly.
- **Aesthetic boxes (`aesthetic_score > 0`, ~5% by hash) are bigger and stay longer.** Target area is `containerArea / 7` instead of `/ 12`. Spawn countdown is 2.5-3.5s instead of 0.2-1.5s.
- **A box's initial size satisfies `bw * (bw/ar) == targetArea`** (where `targetArea = container.x * container.y / (7 or 12)` and `ar = job.width / job.height`). So `bw = sqrt(targetArea * ar)`. **Spec shape:** image area is bounded by `[container/12, container/7]`. Doable as a range.
- **The initial position is `(container.x/2 + tiny_nudge_x, container.y/2 + tiny_nudge_y)` where the nudge is sub-pixel (hash output in [0,1]).** The nudge breaks symmetry so two boxes spawned in a row don't sit exactly on top of each other. **Spec shape:** initial `(centerX, centerY) ∈ [container/2, container/2 + 1)`. Doable.

### Image-pipeline specs

- **Image preload: 5 concurrent fetches, prefetch the next 30-batch when fewer than 20 images remain in the queue.** `scheduleFetch` is gated by `preloading` boolean. **Spec shape:** "at any time, exactly 5 or 0 outstanding fetches." Concurrency bound. Out of scope for the analyzer today (async).
- **`img.decode()` is called before pushing to `images[]`.** Forces the browser to decode the image off the main thread before it's available for rendering. **Spec shape:** "an entry in `images[]` has been decode-resolved." Lifecycle invariant. Out of scope today.

### What predictive-keyframes adds to the spec catalog

- **Pure simulation function.** `simulate(world, containerWH): World` is pure. The render loop calls it `steps` times to catch up, then `predictiveFrameCount` more times to predict the future. The fact that the *same function* is reused for "advance reality" and "predict future" is the architectural keystone. **Spec shape:** "simulate has no side effects" — purity. Doable as "no `document.X = ...`, no `window.X = ...`, no mutation of inputs." Not yet a freerange primitive but conceptually clean.
- **The predicted future is committed to the DOM as keyframes, not to state.** Predictions don't update `world`; they only update `framesMap`. **Spec shape:** the predictive loop body assigns to `framesMap` and only reads `predicted`. A read/write isolation claim. Same "which fields a function reads" shape as hit-area decoupling.
- **Monotone time accumulator:** `animatedUntilTime += steps * msPerAnimationStep` exactly, never `now - last`. Same as photo-gallery's pattern; the rounding-carry preservation. Doable today.

---

# What's Doable Today (rough percentage)

Skimming the list: maybe 75% is doable today with current freerange features (ranges, comparisons, adjacent labels, sequence facts, conditional branches, accumulator inference). The remaining 25% needs at least one of:

1. **Cross-index quantifier** (`for all i ≠ j`) — for pairwise non-overlap and "no two boxes share z-index."
2. **Counting bound** (`at most N items satisfy predicate P`) — for visibility-set bound, blur-set bound, animation-count bound.
3. **Predicate equivalence** — for verifying inline visibility checks match the canonical form.
4. **Flow ordering** ("DOM reads before writes") — different shape; possibly out of scope (not numerical).
5. **Cross-collection same-index** (`for all i, items1[i].x == items2[i].x`) — for selection-after-virtualization, anchor-id-preservation.
6. **Round-trip property** (`f(g(x)) == x` over a range) — life-calendar hit ↔ draw.
7. **Read/write isolation** — "this function only reads field X, never field Y." For hit-area decoupling, predictive-keyframes' simulate-vs-predict split, and the broader pure-function story.
8. **Time-rate bounds** ("at most N times per second", "at most one frame per 300ms cycle") — for predictive-keyframes' render cadence, photo-gallery's anti-jank guarantees.
9. **Monotone state** (once-true-stays-true / non-decreasing) — for predictive-keyframes' `exiting` flag, the firstDown→down→up state machine, photo-gallery's image-src-once-loaded.

# What I'd Push For First

If the goal is "the analyzer earns its keep on a real layout," I'd still pick three, mildly updated after predictive-keyframes:

- **Pairwise non-overlap.** Largest single payoff — every demo benefits. Forces the cross-index quantifier, which then makes the other "for all pair" specs available for free.
- **Counting bound on the visibility set.** Smaller proof, demos a "CSS can't do this" claim cleanly, would let the photo-gallery declare an upper bound on rendered DOM nodes. Predictive-keyframes' "one animation per node" is the same shape.
- **Read/write isolation** (formerly framed as "hit-area decoupling"). Spec shape: "this function reads only `.dest` fields, not `.pos`." Predictive-keyframes makes this even more interesting because the `simulate` function being pure is structurally the same claim. One primitive, two clean wins. Probably the most "small new primitive, big effect" candidate.

The third one is the surprise of this pass. Every demo encodes some version of "this function may only read this subset of fields" — it's the cleaner framing of the hit-test decoupling, the simulate vs predict split, the DOM-reads-before-writes rule, and the "events handlers only write to events.* and call scheduleRender" rule. A single read/write-effect primitive would knock out a remarkable number of demo invariants at once.
