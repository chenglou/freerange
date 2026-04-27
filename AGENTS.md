# AGENTS.md

Use [DOCUMENTATION.md](./DOCUMENTATION.md) as the user-facing source of truth. Use [README.md](./README.md) as the short project front door. See [DEVELOPMENT.md](./DEVELOPMENT.md) for commands and the repo map. Use [todo.md](./todo.md) for current priorities and [research.md](./research.md) for durable direction notes. **Every time before you commit, ensure you've synced the docs**.


Do `bun install` if you're in a fresh checkout/worktree.

- Keep the public surface small. Do not add browser runs, app-code execution, screenshots, traces, sampled cases, public lambdas, `forall`, arbitrary folds, prose-as-truth, or legacy aliases.
- Prefer source inference, intervals, helper contracts, array/object domains, and boring arithmetic before adding a new atom.
- When adding support, add the smallest positive pattern and at least one negative expected message.
- Before adding an atom, write down what it means, what it does not imply, the proof shape, the report shape, and a few non-demo uses.
- This project is private. Rename directly when the language improves.

- Docs should keep Cheng's tone: concise, concrete, slightly personal, and grounded in examples. Avoid generic theorem-prover prose. Say what the checker can actually prove today, then name the next limitation plainly.

**Important:** after you're done with a feature, and have enough holistic vision, make sure you do a pass over all the files again and see if you can simplify anything. Don't change things for the sake of, but if there are simplifications, YELL **I DID A HOLISTIC PASS AND FOUND SIMPLIFICATIONS** with a brief summary.

**Important:** do NOT monkey-patch. If you found yourself solving the symptom instead of the root cause, reconsider and do a proper fix, then YELL **I SOLVED THE ROOT CAUSE NOT THE SYMPTOM** with a brief summary.

**Important:** when a small general family is visible, implement the family. If supporting `total += row.height` naturally includes `total = total + row.height` and guarded additions, define that invariant and reject the unsafe cases. Before coding, say what belongs in the family and what stays out. Add positive and negative tests. Prefer making the implementation less ad hoc over adding public syntax.
