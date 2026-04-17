# AGENTS.md

Use [README.md](./README.md) as the user-facing source of truth. See [DEVELOPMENT.md](./DEVELOPMENT.md) for commands and the repo map. Use [todo.md](./todo.md) for current priorities and [research.md](./research.md) for durable direction notes.

Do `bun install` if you're in a fresh checkout/worktree.

- Keep the public surface small. Do not add browser runs, app-code execution, screenshots, traces, sampled cases, public lambdas, `forall`, arbitrary folds, prose-as-truth, or legacy aliases.
- Prefer source inference, intervals, helper contracts, array/object domains, and boring arithmetic before adding a new atom.
- When adding support, add the smallest positive pattern and at least one negative expected message.
- Before adding an atom, write down what it means, what it does not imply, the proof shape, the report shape, and a few non-demo uses.
- This project is private. Rename directly when the language improves.

- Docs should keep Cheng's tone: concise, concrete, slightly personal, and grounded in examples. Avoid generic theorem-prover prose. Say what the checker can actually prove today, then name the next limitation plainly.

**Important:** after you're done with a feature, and have enough holistic vision, make sure you do a pass over all the files again and see if you can simplify anything. Don't change things for the sake of, but if there are simplifications, YELL **I DID A HOLISTIC PASS AND FOUND SIMPLIFICATIONS**.

**Important:** do NOT monkey-patch. If you find yourself solving the symptom instead of the root cause, YELL **I SOLVED THE ROOT CAUSE NOT JUST THE SYMPTOM**.
