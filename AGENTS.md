# AGENTS.md

Use [DOCUMENTATION.md](./DOCUMENTATION.md) as the user-facing source of truth. See [DEVELOPMENT.md](./DEVELOPMENT.md) for commands and the repo map. Use [research.md](./research.md) for durable direction notes.
Mandatory read: `engineering.md`.

- This project is private. Do NOT consider legacy and interop when refactoring.
- Add positive and negative tests.

**Important:** when a small general family is visible, implement the family. If supporting `total += row.height` naturally includes `total = total + row.height` and guarded additions, define that invariant and reject the unsafe cases. Say what belongs in the family and what stays out.

**Important:** do NOT monkey-patch. If you found yourself solving the symptom instead of the root cause, reconsider and do a proper fix.

Do `bun install` if you're in a fresh checkout/worktree.

Avoid invented compound word jargons like: -shaped, -owned. Don't use jargons unless they're known, established terms in the domains. Do NOT try to be concise or over-compress words.
For commit messages, include the important nuances of the discussion that amounted to that decision.

## Docs Tone

- Preserve the author's tone in docs and drafts. Prefer concise, slightly personal phrasing over generic explanatory filler.
- Ground abstract explanations in examples (and shorten explanations length this way). Make sure the examples can be understood without excessive context and that the naming aren't abstract either:
  - write docs guidelines like this: "Colocate lifetimes. Instead of a `personAge: number | null` and a `personName: string | null`, put them into a `type Person = { age: number, name: string } | null`"
  - don't write like this: "Colocate lifetimes. Instead of `a: T1 | null` and `b: T2 | null`, put them into a `type P = { a: T1, b: T2 } | null`". Also don't use weirdly contextful names like `hullShape: HullID | null`
- Prefer examples that are concrete and archetypal, not repo-local jargon or vague shell nouns. Good: `available text width`, `line breaks`, `visible row range`, `scroll position`, `selected item`. Avoid: names that only make sense if you've seen one particular demo, or words like `panel` that don't name the underlying data.
- When a doc lesson comes from one specific bug/refactor, strip out the incident. Keep the reusable rule, one common example, and the boundary where the rule stops being true.
- Use established names when they make the rule easier to hold onto, but don't let the name replace the explanation. Good: `views over copied text: keep the source plus { start, end }`. Bad: `use string views` with no shape or example.
- When bringing in a technical distinction from elsewhere, translate it into the local action first. Good: `Put a guarantee in the data shape only when it stays true wherever the value goes.` Bad: `Use canonical representations for stable noun facts.`
- Use ordinary documentation verbs. Prefer `prove`, `check`, `report`, `reject`, `keep`, `delete`, and `support` over slogan-ish verbs like `earn`, `win`, `teach`, or metaphor phrases like `road signs`. If a sentence sounds memorable but not operational, rewrite it as: what the code/doc should do, what input it applies to, and what happens when it cannot.
- When a rule is broad, phrase it as the general rule plus one concrete category, e.g. `If behavior genuinely differs by some dimension, say, browser, feature flag, or mode, model that difference explicitly in one place.` Use "e.g.", "say", "such as", or some other clean turn of phrase
- The above applies to generating doc comments for functions too
- Leverage descriptive variable names that represent a whole category. If you come across a context-less example like "store events in state, e.g. pointerDownTime = ..." you still know that `pointerDownTime` is examplary among many other use-cases. Whereas a doc that says "e.g. ptAt = ..." is the _same_ variable but bakes in way less explanatory power
- don't turn local lessons into universal rules, and vice-versa

Example:
- Preferred: `The image's position should be relative to the scroll view container's.`
- Avoid: `A more robust architectural approach is to define the image position relative to the parent scrolling container so that scrolling does not interfere with the animation system.`
- Preferred: `Properties are only selectively animated. E.g. on window resize, an image's x/y/scale do NOT animate if it stays in the same place/column.`
- Avoid: `Layout changes and transitions are treated separately. On resize, x/y/scale don't animate if an image stays in the same place; when changing modes, the image keeps its current visual position and glides to the new layout.`
- Preferred: `If you want a lightweight, hand-rolled router, do it this way.`
- Avoid: `A pattern for building routing that's fully typed, handles browser history correctly, and avoids the traps of routing libraries.`

For markdown files, don't do hard line breaks yourself
