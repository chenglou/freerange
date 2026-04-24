# Freerange Limitations Hit While Expressing mj-gallery Layout

Running log of rough edges encountered while annotating the /imagine page layout with `@fit`. Each entry describes the limitation, a concrete example from mj-gallery, and what shape freerange should grow to accept. We want to shape freerange to match our real layout code, not bend the layout to satisfy the checker.

Format: **limitation** → **mj-gallery example** → **what we want**

---

## 1. No booleans as facts

`isSidebarOpen: boolean` can't be used in `@fit` givens or result facts. We had to pass `int 0..1` and write `isOpen === 1 ? ... : 0` at every branch.

**mj-gallery example:** `GlobalContext.sidebarOpenState` is `'images' | 'settings' | 'filter' | null`. Callers collapse this to a boolean then have to collapse it again to a number before calling any checked helper.

**What we want:** `given isOpen: boolean`, `given isOpen === true`, and ternaries / `if` guards on booleans should narrow result facts the same way they narrow `isOpen === 1`.

---

## 2. Per-branch result facts are erased at call boundaries

`rightSidebarFootprint(isOpen, sideBarWidth)` returns `0` when closed and `sideBarWidth + 32` when open. The `@fit` can only state the union range `result: 0..sideBarWidth + 32`. A caller that passes `1` gets `0..sideBarWidth + 32` back, not the exact `sideBarWidth + 32`.

**mj-gallery example:** `imaginePageFrame` needed to know footprint exactly `== sideBarWidth + 32` to chain the next proof step. We had to inline the constant in the caller, losing the helper abstraction.

**What we want:** Overloaded contracts, or refinement contracts, or `@fit` "when" clauses: "when isOpen === 1, result == sideBarWidth + 32; when isOpen === 0, result == 0". Alternatively, infer from source body when the helper is small enough.

---

## 3. No discriminated-union / state-dependent contract

A single function that returns different shapes based on a state flag can't express different invariants per branch. We had to split `imaginePageFrame` into `imaginePageFrameOpen` + `imaginePageFrameClosed`.

**mj-gallery example:** On /imagine, when the right sidebar is open we want `content.right <= sidebar.left`; when closed there is no sidebar panel and that invariant is vacuous. One function returning `{state: 'open', ...} | {state: 'closed', ...}` would be the natural shape.

**What we want:** `@fit` blocks that discriminate on the returned `state` field. Something like `if result.state == 'open' then result.content.right <= result.sidebar.left`.

---

## 4. No named geometric atoms (`rectInside`, `nonOverlapX`)

Everything is spelled out as `a.right <= b.left`. For 4 rects in 2 axes, we write ~8 numeric comparisons when one atom would do it.

**mj-gallery example:** On /imagine the user's mental model is "nav | content | sidebar horizontally, input above content". Each relation required 2 comparisons (left/right or top/bottom).

**What we want:** Named atoms like `nonOverlapX(a, b)`, `horizontalOrder(nav, content, sidebar)`, `rectInside(child, parent)`. Each unfolds to the numeric comparisons but reads far better in the spec.

---

## 5. No cross-function facts / cross-module spans

Facts about relationships are only checkable inside a single function that produces all the relevant values. The mj-gallery code is deliberately split across `Layout.ts` (produces `sideBarX`), `SidebarShell.tsx` (consumes it), `InputDesktop.tsx` (consumes `sideBarX` plus local math), etc.

**mj-gallery example:** `InputDesktop.tsx` computes its own right edge as `sideBarX + sideBarSizeX - containerInnerX - inputInsetY`. We can't assert `input.right <= sidebar.left` across module boundaries without gathering everything into one function.

**What we want:** Either a cross-module "layout contract" that a site can publish and another site can consume, or a way to say "this rect is the same rect as that one from module Y" so facts compose.

---

## 6. Weak linear reasoner forces verbose contracts

Helpers' contracts had to sprout parametric bounds (`result <= containerSizeX - naturalInnerX - footprint`, `result >= innerRightX`) just so that callers could chain proofs. Simple range bounds weren't enough.

**mj-gallery example:** `innerWidthAfterSidebar` initially had `result <= naturalInnerSizeX`. The caller needed `result <= containerSizeX - naturalInnerX - footprint` too (which is trivially true of `Math.min`) to prove that `containerInnerX + result <= containerSizeX - footprint`.

**What we want:** Either auto-emit both bounds for `Math.min` / `Math.max`, or a richer linear solver that can combine `result <= A` with `result <= B` when the caller needs a specific B.

---

## 7. Preconditions cascade awkwardly into callers

`innerWidthAfterSidebar` has `given containerSizeX >= naturalInnerX + footprint`. Every caller now has to prove that precondition, which cascades through each intermediate helper. Writing the contract feels defensive rather than declarative.

**mj-gallery example:** Adding `given containerSizeX >= naturalInnerX + footprint` broke the prototype's call to `innerWidthAfterSidebar` until we added a matching given at the page-frame level. Now every new caller has to thread this.

**What we want:** Default preconditions inferred from return-type assertions ("if you want `result >= 0`, you need containerSizeX >= naturalInnerX + footprint"), and diagnostics that say "you asked for X, so you now owe Y at every call site".

---

## 8. Numeric-only comparisons, no string/enum discrimination

Can't write `given loute.type == 'archive'` or have the checker narrow behavior based on string discriminants.

**mj-gallery example:** `archiveSidebarOffset` returns `12` for archive routes, `0` otherwise. The per-route behavior is invisible to the checker — we just give `archiveOffset: int 0..12` and the checker can't distinguish between /imagine (always 0) and /archive (always 12).

**What we want:** String discriminants in givens (`given loute.type == 'imagine'`) and in return narrowing. This matches how real code branches.

---

## 9. No way to share a geometric "shape" across many functions

`Rect = {left, right, top, bottom}` is just an object type. Every spec that talks about "rectangles" re-spells the fields. There's no primitive meaning attached.

**mj-gallery example:** `ImaginePageFrame` has 4 rects; each rect has 4 fields; no way to say "these 4 numbers are a rectangle, and rectangles compose into layouts".

**What we want:** First-class `Rect` primitive (or at least a tagged type) that layout atoms (`rectInside`, `nonOverlapX`) recognize, so the spec becomes geometric rather than arithmetic.

---

## 10. Can't reason about `boolean` narrowing from string equality

A common pattern in mj-gallery: `const isArchive = loute.type === 'archive'`. Freerange doesn't narrow facts from this either, so even the numeric form `const archiveOffset = isArchive ? 12 : 0` loses the route-specific guarantee when passed down.

**What we want:** Source inference that follows equality checks on discriminated unions and narrows downstream values the same way TypeScript does.

---

## 11. Helpers with a "mostly safe, sometimes tighter" contract need two variants

`rightSidebarLeftX` is `Math.min(naturalX, clampedX) - archiveOffset`. The natural branch is tighter (result = innerRightX + 16) when enough room; the clamped branch kicks in otherwise. Callers that want to prove `result >= innerRightX` (the natural case) need to know the precondition holds. Callers that just want universal upper bounds don't.

We couldn't put both in one `@fit` — a precondition on one claim applies to all. End result: we moved the lower-bound proof out of the helper into the open-frame function, where we inline the natural branch. This duplicates math between the frame and the helper.

**mj-gallery example:** `imaginePageFrameOpen` inlines `sideBarLocalX = innerRight + SIDEBAR_GAP` instead of calling `rightSidebarLeftX`, precisely because freerange couldn't prove the stronger invariant through the helper.

**What we want:** per-claim preconditions in `@fit`, or ergonomic way to express "this claim holds when X, that claim is universal". Alternatively, good conditional narrowing at the call site so one helper produces both claims naturally.

---

## 12. No per-call-site "instantiate this contract with reserve=0" narrowing

The frame needs `rightStripReserve=0` and `archiveOffset=0` to prove the stronger invariants. The live Layout.ts calls with possibly-nonzero reserve/offset (for /archive etc.). We had to write `rightSidebarHorizontalPlacement` that branches: if zero, call the frame (proven); else, call the atomic helpers (weaker guarantees). The same code path exists in two shapes.

**mj-gallery example:** The /imagine page gets frame-level verification; /archive gets only atom-level. One dispatcher `rightSidebarHorizontalPlacement` picks. The code has two paths for what's semantically one operation.

**What we want:** Contracts parameterized on call-site constants — when the call is `helper(0, 0)`, freerange should specialize the contract and prove the stricter invariants; when it's `helper(12, 78)`, only the weaker ones.

---

## 13. `@fit` can't refer to result shape that depends on parameter values

We wanted a single `imaginePageFrame(isSidebarOpen, ...)` whose returned `sidebar` field is only asserted to be non-overlapping with `content` when `isSidebarOpen === true`. No way to write that in `@fit`. We split into two functions and wrote a runtime dispatcher — the dispatcher itself has no proof.

**mj-gallery example:** `imaginePageFrame` (the dispatcher in `ImaginePageFrame.ts`) is unchecked glue between two checked leaves. Callers reading through the dispatcher get fewer guarantees than if they call a leaf directly.

**What we want:** Discriminated-union-aware `@fit` blocks, something like:
```
result.state == 'open' -> result.content.right <= result.sidebar.left
result.state == 'closed' -> result.content.bottom <= result.sidebar.top
```
So the single entry point is verified end-to-end.

---

## 14. Composite layouts want `rectInside` / `nonOverlap` atoms

Every 2-rect relationship expands to 2 numeric comparisons (left/right or top/bottom). A full page-frame spec on /imagine is 9+ numeric lines that together mean "these 4 rects are in the expected `[nav | content | sidebar] + input-above-content` arrangement".

**mj-gallery example:** `imaginePageFrameOpen`'s `@fit` has ~10 comparisons spelling out a mental model that is 2 sentences.

**What we want:** Named atoms. A spec that reads `horizontalOrder(nav, content, sidebar)` and `verticalOrder(input, content)` and `rectInside(content, viewport)` instead of the current wall of inequalities.

---

## 15. Helper boundaries erase branch facts; inlining `Math.min` proves more

The clearest demonstration: we had a helper `rightSidebarLeftX = Math.min(A, B) - offset`. The caller couldn't prove `innerRight - result <= reserve + offset - 16` through the helper boundary — the @fit contract only carried universal upper bounds on `result`, not the two per-branch lower bounds that `Math.min`'s source-branch facts would have given us.

**mj-gallery example:** `imaginePageFrameOpen` used to call the helper; the universal invariant `content.right <= sidebar.left + reserve + offset` was `unknown`. Inlining `Math.min` directly in the frame made it `pass` immediately — same arithmetic, same result, just removed the helper boundary.

**What we want:** Helpers should carry their per-branch facts through the contract, or freerange should trace into short helper bodies when the caller needs a fact the contract doesn't spell out. Otherwise every caller with nontrivial proof goals will inline, defeating reuse.

---

## 16. "Trivial" helpers that only do a + or min don't earn their keep

We built a handful of small helpers (`rightSidebarShellTop = gapTop + inputHeight + 8`, `fallbackRightSidebarWidth = Math.min(x, 350)`, `imagesSidebarHeight = y - a - b - 8`) so each call site could call a checked function. They're all arithmetic. Inlining at the call site is just as clear and removes five exports.

**mj-gallery example:** After first pass, these four-line helpers all got inlined; only the meaty `Math.min`-cap and the frame function remain checked.

**What we want:** Guidance in freerange docs about when a helper is worth carving out: it should hold a non-obvious branch fact, parameterize a named layout atom, or be called from many sites. Pure arithmetic inline is fine and often clearer.

---

## 17. Multi-ternary fan-out within a single function

Two independent ternaries on the same discriminator aren't recognized as correlated. Freerange treats each ternary's cases independently and then cross-multiplies them, checking combinations that can't actually happen.

**mj-gallery example (prod /imagine frame):**

```ts
const navContainerGap = collapsedNav === 1 ? 22 : 32
const navInnerWidth   = collapsedNav === 1 ? 38 : 160
const navSizeX = WINDOW_GAP_LEFT + navInnerWidth + navContainerGap
```

Freerange produced four cases for `navSizeX` — one of which mixed `(navInnerWidth=38, navContainerGap=32)`, arithmetic that can never run. Downstream `result.nav.right <= result.inputRow.left` failed against that fake case even though the real code paths satisfy it.

Worked around by collapsing to a single ternary that picks the whole `navSizeX` as a literal:

```ts
const navSizeX =
  collapsedNav === 1
    ? WINDOW_GAP_LEFT + COLLAPSED_NAV_INNER + COLLAPSED_NAV_GAP
    : WINDOW_GAP_LEFT + EXPANDED_NAV_INNER + EXPANDED_NAV_GAP
```

**Distinct from #3/#13** — those are about expressing *per-branch contracts*. This is about the checker inventing cases that don't exist when the source has multiple uses of the same discriminator.

**What we want:** Either correlate ternaries that branch on the same identifier (treat them as one joint case split) or narrow downstream expressions by re-reading the discriminator at each ternary and proving the mixed combinations are unreachable.

---

## 18. Non-exported module consts with arithmetic initializers don't resolve

A module-scope `const` whose initializer is any arithmetic over other constants silently becomes a non-numeric value inside the function body. Every downstream comparison that touches it fails with "Binary arithmetic expected numbers" and the locals it influences don't appear in `infer` output at all.

**mj-gallery example:**

```ts
export const WINDOW_GAP_LEFT = 22
export const WINDOW_GAP_RIGHT_EXTRA = 16
const WINDOW_GAP_RIGHT = WINDOW_GAP_LEFT + WINDOW_GAP_RIGHT_EXTRA  // 38

function imagineFrame(windowSizeX: number, navSizeX: number, ...) {
  const availableInner = windowSizeX - navSizeX - WINDOW_GAP_RIGHT
  ...
}
```

10+ rect contracts flipped from `unknown` to `pass` the moment `WINDOW_GAP_RIGHT` was changed from the arithmetic expression to the literal `38`. No warning or hint points at this as the cause; the error messages only show the downstream comparisons failing.

**Workarounds today:** Inline literals at module scope, or mark the const `export` (unverified whether export alone is enough — this example used a non-exported const and switching to a literal fixed it; worth testing if the export bit is the real trigger).

**What we want:** Constant-fold top-level arithmetic-initialized `const`s the same way literal consts are resolved, regardless of export status. Or emit a diagnostic when such a const is referenced inside an `@fit`-checked function body so the author knows to inline.

---

## 19. `joinValues` used to drop per-branch cases for two plain-literal branches — fixed 2026-04-20

**Was a limitation; now fixed.** Documenting here so the workaround pattern doesn't re-emerge.

Before the fix, `joinValues` in `src/domain.ts` short-circuited to a plain range whenever neither branch had pre-existing cases — even when the two branches' values disagreed on linear form. A ternary like `flag ? 108 : 68` joined to `{min: 68, max: 108, linear: null}` with no cases. Downstream `Math.min(width, inset)` lost the per-branch fact that `inset` was literally 108 or 68, so `width - Math.min(width, inset) >= 0` went `unknown`.

**Fix:** `joinValues` now preserves cases when the two branches disagree on linear form. `patterns.ts::pathSensitiveMinOverflowTernaryInset` is the regression test.

Keeping this entry because a future regression would re-surface as "`given` ranges don't flow through `Math.min` when the input is ternary-assigned", and a search of this doc should turn up the fix rather than a re-diagnosis.

---

## 20. Literal-union types as `given` domains — fixed 2026-04-24

**Was a limitation; now fixed.** Documenting here so the workaround pattern doesn't re-emerge.

Before the fix, writing `given navSizeX: 82..214` bought no call-site enforcement — freerange assumed it held. A refactor introducing a third nav variant (`navSizeX: 96`) passed the contract but silently placed rects 14px off. There was no way to narrow the given to a discrete set.

**Fix:** `given` (in `@fit` blocks and inline `// @fit` param comments) now accepts literal-union numeric types such as `0 | 40 | 200 | 213`. The domain is the exact set of values; downstream per-branch cases flow through Math.min / subtraction exactly like the source-proved ternary cases in #19. Call sites that pass a literal not in the set now fail with `missing: x in {0, 40, 200, 213}` instead of range-widening.

Parser: `src/parser.ts::parseUnionText`. Checker: `src/check.ts::proveUnionSpec`. `patterns.ts::literalUnionGivenPassesThrough` and `patterns.ts::literalUnionGivenOnParam` are the positive regression tests. `negative-patterns.ts::negativeUnionReturnOutsideSet` is the negative regression test.

If the parameter's TypeScript type is already a literal union like `searchSlot: 0 | 40 | 200 | 213`, the checker picks it up via its shape oracle the same way it reads structural shape today; the explicit `given` is confirmation or documentation for the spec block.

---

## 21. Error messages expose internal constant names, making cross-branch fakes hard to parse

When multi-ternary fan-out (#17) or joined-range pessimism kicks in, the failure message reads like:

```
int 92..92 as ((WINDOW_GAP_LEFT + COLLAPSED_NAV_INNER_WIDTH) + EXPANDED_NAV_CONTAINER_GAP) <= int 90..90 as ((((WINDOW_GAP_LEFT + COLLAPSED_NAV_INNER_WIDTH) + COLLAPSED_NAV_CONTAINER_GAP) + 0) + INPUT_INSET_X) is false
```

The author has to mentally constant-fold and notice that the LHS came from one branch of a ternary while the RHS came from the *other* branch — i.e. that the checker is comparing a combination that can't actually run. Until you've trained yourself to spot this, the message reads like a real bug.

Not a functional limitation — but it's a sharp edge that costs real minutes per occurrence.

**What we want:** When a failure traces to a cross-branch combination, name it as such: "fake combination from discriminator `collapsedNav` (LHS assumes === 1, RHS assumes === 0)". Same information, but framed so the author recognizes the fix (#17) rather than chasing a phantom bug.
