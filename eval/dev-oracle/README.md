# Oracle arm on the development split

The oracle arm asks one question per dataset entry: given the check that is known to catch the defect, written as a `console.assert` at its code site, does Freerange's verdict at that assert separate the defect from its fix? The assert is not Freerange's to find here; only the verdict is measured. It is exposed development data, so results are calibration, not a held-out score.

This directory holds only code. The dataset (`entries.jsonl`), the curated readings of its checks, the worktrees and every run copy code from private repositories, so they live outside the repository, in the directory passed as `--dev-eval`.

## Layout

- `oracle.ts`: the command line, with the commands `eligibility`, `prepare`, `run` and `score`.
- `lib/entries.ts`: reads `entries.jsonl` and the readings file at every command, so entries added later are picked up.
- `lib/eligibility.ts`: the eligibility criteria and their counts.
- `lib/placement.ts`: inserts the condition at its site and checks that its names are in scope.
- `lib/trees.ts`: worktrees, dependencies and insertion on disk.
- `lib/score.ts`: the score.
- `tests/`: unit tests of the placement, run by `bun test eval/dev-oracle`.

It reuses `../lib`: `asserts.ts` finds the inserted site, `findings.ts` turns `fr <file>` output into its verdict, `process.ts` runs Freerange with a timeout and peak RSS, and `sweep.ts` reads the `FREERANGE_SWEEP` sidecar.

## Eligibility

Criteria, in order. An entry is counted under the first criterion it fails, and a later criterion is evaluated only for entries that pass the earlier ones:

0. The entry is on the development split: `split` isn't `heldout`.
1. `reach` is `static` or `sweep`.
2. A recorded catching check gives a console.assert condition. The check has status `used`, role `caught-live`, `post-fix-contract` or `post-hoc-check`, and kind `console-assert`, `sweep` or `differential`, and its curated reading gives a condition. The other kinds leave no condition text. A check the readings file doesn't cover, or covers for a different statement text (by sha1), is counted as unread.
3. The condition's site exists in JS or TS at both trees:
   - the entry has a fix commit, and the reading places the condition
   - the file has a JS or TS extension, and exists at the fix's first parent (the snapshot tree) and at the fix
   - the anchor statement is found exactly once in the named function on both trees
   - the condition's names resolve there on both trees

   Candidates are tried in role order (caught-live, post-fix-contract, post-hoc-check), then in `checks[]` order. The first that passes is the entry's catching check.

A reading is `{index, statementSha1, condition, bindings, placement, why}`:
- `condition` is quoted from the check's statement, or null when the statement names no condition.
- `bindings` are named values the statement itself defines. Each is bound with `const` before the assert, because Freerange reads an assert over values calculated before it.
- `placement` is `{repo, path, function, anchor, position}`: the assert goes `before` or `after` the one statement in `function` whose text starts with `anchor`.

## Insertion

`prepare` creates a detached worktree per eligible entry and tree, at `<worktrees>/<entry>/snapshot` (the fix's first parent) and `<worktrees>/<entry>/fix`. It installs dependencies with `bun install --frozen-lockfile` only when Freerange needs them: the tree's tsconfig names `types`, or the file imports a package. Then it writes the insertion. The assert keeps the check's condition text, on new lines indented like the anchor statement. The diff of each tree against its commit goes to `<dev-eval>/insertions/<entry>/<tree>.diff`, and `insertions.json` records each tree's commit, assert line and file sha1s. A tree holding anything but its commit's file or the recorded insertion is refused.

## Runner and verdicts

`run` recomputes eligibility, then runs `bun <freerange>/fr.ts <file>` from each tree's root, under `/usr/bin/time -l` and the per-file timeout. `--env` passes `FREERANGE_*` flags such as `FREERANGE_ASSERT_FORMS=1`, `FREERANGE_STATIC_RELATIONS=1` or `FREERANGE_SWEEP=1`. With a sweep flag, the sidecar goes to `raw/<entry>/<tree>.sweep.json`. The verdict at the inserted assert follows `../lib/findings.ts`:
- `proved`: an interior assert in a lowered function with no finding at its line, or an `unreachable` finding
- `could-not-prove`
- `can-be-false`: the finding is kept verbatim
- `not-analyzed`: the function wasn't lowered (the finding names why), the assert is outside a named top-level function, the file holds something other than the recorded insertion, or the run timed out, crashed or stopped on TypeScript errors
- `requirement`: a leading assert with no finding

With a sweep, a row also carries the sweep outcome: a verified counterexample with its input, or `held` with N inputs.

A run directory holds:
- `run.json`: Freerange and harness revisions with their dirty-file counts, bun version, flags, timeout, the entries and readings sha1s, eligible ids, and any eligible entry not prepared
- `eligibility.json` and `eligibility.md`
- `verdicts.jsonl`: one row per entry and tree, with every finding line of the file
- `raw/`, `score.json` and `score.md`

## Score

Counting rule: one row per eligible entry run on both trees, split by `reach`.
- **Refuted on a tree:** verdict `can-be-false` at the inserted assert, or a verified sweep counterexample there.
- **Points at the defect:** refuted on the snapshot tree and not refuted on the fix tree.
- **Also counted:** refuted on the snapshot tree, refuted on the fix tree, proved on the fix tree, and not analyzed on the snapshot tree, the fix tree or either.

## Running

Run `prepare` and `run` through the scratchpad's heavy lock: they install packages and run Freerange over many files.

```sh
bun eval/dev-oracle/oracle.ts eligibility --entries <entries.jsonl> --readings <readings.json> --dev-eval <dir>
bun eval/dev-oracle/oracle.ts prepare --entries <entries.jsonl> --readings <readings.json> --dev-eval <dir> --worktrees <dir>
bun eval/dev-oracle/oracle.ts run --entries <entries.jsonl> --readings <readings.json> --dev-eval <dir> \
  --freerange <Freerange checkout with node_modules> --run <new directory> [--env FREERANGE_SWEEP=1]... [--timeout-seconds 300]
bun eval/dev-oracle/oracle.ts score --run <run directory>
```

## Limits

- A reading holds one condition. A check whose statement gives several asserts is read as its first, and `why` names the rest.
- The name check uses a one-file program without lib or module resolution. It accepts any value or import in scope and a fixed list of standard globals, and doesn't type-check the condition. A type error shows at run time as `not-analyzed` with TypeScript's message.
- `fr` resolves the tsconfig from the tree root upward; `verdicts.jsonl` records the path it found.
