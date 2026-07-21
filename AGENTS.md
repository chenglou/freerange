# AGENTS.md

Read and ackowledge our `engineering.md`, and `goal-prompt.md`. Use the latter for extensive clearly-defined tasks.

Do NOT preserve legacy compatibility or interoperability when refactoring.

**Important:** do NOT monkey-patch. If you found yourself solving the symptom instead of the root cause, reconsider and do a proper fix.

Do `bun install` if you're in a fresh checkout/worktree.

For commit messages, include the important nuances of the discussion that amounted to that decision.

## Conversation Tone

You're free to think internally in whatever terms you're comfortable with, but when communicating responses, comments and docs, here are the guidelines:

- Do NOT try to be concise or over-compress words. Be generally brief and clear.
- Avoid using common words in uncommon situations, as pseudo-jargons. Established technical terms in their field (e.g. compiler terms) are fine.
  - Bad: `earn`, `win`, `teach`, `road signs`, `seam`, `source-backed`, `source-shaped`, `browser-owned`
  - Good/fine: `call site`, `control flow`, `type narrowing`, `invariant`
  - Bad: `input facts`, `source calls`, `loop facts`
  - Good: `input contracts`, `function calls`, `loops`
  - Bad doc: "An inclusive infinity endpoint overrides the finite default."
  - Good doc: "An explicitly written range, e.g. 0..Infinity, replaces the default."
  - Bad: "Finite-default parameters publish an implicit finite precondition."
  - Good: "A function's number param is assumed to be finite."
  - Bad: "The table lists the supported checks and their effects on each branch. This supports validation at the boundary"
  - Good: "The table shows what each check proves in its true and false branches. E.g. after `const parsed = Number.parseFloat(text)`, the true branch of `if (Number.isFinite(parsed))` knows that `parsed` is finite."
- Don’t state the obvious just to sound thorough
- Preserve the author's tone. Remove generic filler, but don't shorten an explanation so much that it loses context.
- Use descriptive variable names that make the example understandable on its own.
  - Bad: `ptAt`
  - Good: `pointerDownTime`
- A great trick we use is to document a general point along with an example
  - Bad: "An explicitly written range replaces the default."
  - Good: "An explicitly written range, e.g. 0..Infinity, replaces the default."
- When giving examples, you have a bad habit of using variable names that only make sense within the current conversation, not in a general doc.
  - Bad: “Model nullability explicitly. E.g. `hullSpace: HullID | null`”. The name `hullSpace` might make sense in the conversation where I asked you to modify some docs, but it makes no sense on its own
  - Good: replace with `userID: ID | null`. Everyone's familiar with `userID` and its frequent appearances in app dev
- A general point accompanied by long examples is fine/desirable when the general point's too abstract for most people:
  - Bad: "Later arithmetic does not restore finiteness."
  - Good: "Later arithmetic doesn't necessarily make the value finite again. For example, if `value * 2` may be `Infinity`, dividing it by 2 may still return `Infinity` (`Infinity / 2 === Infinity`). You can make it finite again with e.g. `Math.max(-100, -Infinity)`". Notice the pattern "e.g."/"for example"/"like" + a trailing example; those are nice turns of sentence that point to the general idea of what users can write.
- Avoid unclear pronouns like `this` `it` and others when they can refer to multiple things
  - Bad: "If an operation may produce `NaN`, we report its result as unknown unless an earlier check rules that out"
  - Good: "If an operation may produce `NaN`, we report its result as unknown unless an earlier check proves that the operation cannot produce `NaN`". See how we swapped out "that" with "the operation" and rephrased accordingly. Alternatively, attach a noun: write "these checks" instead of bare "these"
- For markdown files, don't do hard line breaks
