WIP rewrite

## The pitch, in one example

Our production app has layout code that positions an input bar, a tray under it, and a content area, all computed from the window size. We added one line to it:

```ts
windowSizeY = Math.max(320, windowSizeY) // treat every window as at least 320px tall
```

That line barely does anything at runtime — no real window is smaller than that. But freerange read the layout math with that one fact in hand, and its report on the same functions changed from "these positions could be anything, including broken values like Infinity" to plain statements such as:

```
ensures: return.inputTray.top is a finite number at least 54
ensures: return.nav.bottom is a finite number at least 320
```

Nobody wrote those numbers anywhere. "The tray starts at least 54 pixels down" is something the tool worked out by pushing the one declared fact through three layers of arithmetic — the window floor, plus the gap math, plus the input row height. And it holds for every window size that can exist, not just the ones somebody tested.

The part that makes this durable rather than a one-time audit: the report regenerates from the code. Next month someone — a teammate, or an AI agent doing a refactor — changes the padding math. If the tray can now overlap the input bar, that `at least 54` line changes or disappears, and the diff shows it before any user sees it. TypeScript can tell you a value is a number; this tells you *which* numbers it can be, and keeps that promise up to date as the code changes.

Same mechanism, defensive direction: the report on our lightbox pointed out that its image-fitting math would produce NaN (an unrenderable "not a number") for a 0×0 image record — dividing by zero width, then multiplying zero by the Infinity that came out. One more one-liner made that state impossible, and the report now proves it can't come back.
