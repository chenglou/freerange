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

## Running it

- `bun fr.ts` from a repo root audits every file that repo's tsconfig describes. Results land in `./freerange-report/`: one `.txt` per source file, `LEGEND.txt` (what requires/ensures/assumes mean — read once), `SUMMARY.txt` (function totals, the requires index, tallies of what got rejected and why), and `__rows.json` (the same per-function rows, machine-readable).
- `bun fr.ts src/some/file.ts` prints that one file's report to stdout.
- Start with `SUMMARY.txt`. The requires index lists every function that puts an obligation on its callers — those are the actionable lines. The rejection tallies tell you which patterns to rewrite for more coverage.

## Recommendations from converting a production app

Rough notes from converting mj-gallery's layout code; unpolished, final pass pre-launch.

- Declare floors as enforced code, not comments or config. One `Math.max(320, windowSizeY)` unlocked derived guarantees across three layers of layout arithmetic — the best value per line of anything we did. Below a reasonable floor, treat rendering as undefined behavior; the analysis just has to prove nothing reaches Infinity or NaN.
- Clamp where the value is born, not where it's used. `Math.max(1, imageWidth)` at the one place image dimensions enter discharged every downstream division at once; patching each use site would have taken a dozen edits.
- Guard the divisor, not the result. `jobWidth > 0 ? (width * jobHeight) / jobWidth : width` reports clean; computing first and patching up NaN afterward doesn't.
- To compare two ratios, cross-multiply instead of dividing: `a / b < c / d` rewritten as `a * d < c * b` needs no divisor guard at all.
- Keep numeric math out of JSX. Move it into a plain `.ts` function that returns numbers and let the component consume the results. Every successful conversion was this one move, and it's also what makes the math nameable, reusable, and diffable.
- Treat rejections as rewrite prompts, not failures. Array-method rejections come with the for-of rewrite; unknown-call rejections usually mean the numeric math should be extracted away from the call. The subset is prescriptive on purpose — agents reshape code cheaply.
- Fix requires before polishing ensures. A requires line is an obligation on every caller; an ensures line is free information. Clear the requires index first, then chase nicer bounds.
- Some requires are genuine caller contracts (e.g. a remap function that needs a nonzero input range). Leave those in place — the index is where callers go to learn them.
- Deduplicate semi-copied math into one function with a contract. Three masonry variants shared most of their card-height arithmetic; one extracted function gave all three the same proof.
- Watch the report diff after refactors. If a derived bound (like "at least 54") weakens or disappears, the refactor broke an invariant nobody wrote down. Checking in `SUMMARY.txt` and gitignoring the rest of the report folder is enough for the diff to show it.
- An `assumes` line on a division is a todo item. The analyzer assumes an unproven divisor is nonzero and says so; add the guard and the line disappears.
- A file mentioning `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `eval` is rejected wholesale. The analysis is built on the checker's word, and those turn the checker off.
