# Oracle arm on the development split

The oracle arm asks one question per dataset entry: given a check of the defect, written as a `console.assert` at its code site, does Freerange's verdict at that assert separate the defect from its fix? The assert is not Freerange's to find here; only the verdict is measured. It is exposed development data, so results are calibration, not a held-out score.

It has two tiers, counted and scored separately and never added:
- **Tier 1:** checks that caught or evaluated the defect (status `used`).
- **Tier 2:** curator-written checks, not run against the defect (status `proposed`). A tier-2 score is an upper bound on what an assert could catch.

This directory holds only code. The dataset (`entries.jsonl`), the curated readings of its checks, the worktrees and every run live outside the repository: the readings and runs in the directory passed as `--dev-eval`, and the entries' code in the clones named by `--repo <name>=<clone>`.

## Layout

- `oracle.ts`: the command line, with the commands `eligibility`, `prepare`, `run` and `score`.
- `lib/entries.ts`: reads `entries.jsonl` and the readings file at every command, so entries added later are picked up.
- `lib/eligibility.ts`: the eligibility criteria and their counts.
- `lib/placement.ts`: inserts the condition at its site and checks that its names are in scope.
- `lib/trees.ts`: worktrees, dependencies and insertion on disk.
- `lib/score.ts`: the score.
- `lib/census.ts`: where Freerange stops on each eligible entry, grouped by the first unsupported construct it names.
- `tests/`: unit tests of the placement and the census grouping, run by `bun test eval/dev-oracle`.

It reuses `../lib`: `asserts.ts` finds the inserted site, `findings.ts` turns `fr <file>` output into its verdict, `process.ts` runs Freerange with a timeout and peak RSS, and `sweep.ts` reads the `FREERANGE_SWEEP` sidecar.

## Eligibility

Each tier is evaluated over every entry on its own. Criteria, in order. An entry is counted under the first criterion it fails, and a later criterion is evaluated only for entries that pass the earlier ones:

0. The entry is on the development split: `split` isn't `heldout`.
1. `reach` is `static` or `sweep`.
2. A check of the tier gives a console.assert condition. The check has kind `console-assert`, `sweep` or `differential`, and its curated reading gives a condition. The other kinds leave no condition text. Tier 1 takes status `used` with role `caught-live`, `post-fix-contract` or `post-hoc-check`; tier 2 takes status `proposed`. A check the readings file doesn't cover, or covers for a different statement text (by sha1), is counted as unread.
3. The condition's site exists in JS or TS at both trees:
   - the entry has a fix commit, and the reading places the condition
   - the file has a JS or TS extension, and exists at the fix's first parent (the snapshot tree) and at the fix
   - the anchor statement is found exactly once in the named function on both trees (on the fix tree, the reading's `fixAnchor` when it has one)
   - the condition's names resolve there on both trees

   Candidates are tried in role order (caught-live, post-fix-contract, post-hoc-check), then in `checks[]` order. The first that passes is the entry's catching check.

A reading is `{index, statementSha1, condition, bindings, placement, why}`:
- `condition` is quoted from the check's statement, or null when the statement names no condition.
- `bindings` are named values the statement itself defines. Each is bound with `const` before the assert, because Freerange reads an assert over values calculated before it.
- `placement` is `{repo, path, function, anchor, fixAnchor, position}`: the assert goes `before` or `after` the one statement in `function` whose text starts with `anchor`. `fixAnchor` replaces `anchor` on the fix tree when the fix rewrote that statement, and is null otherwise.

## Insertion

`prepare` creates a detached worktree per eligible entry, tier and tree: tier 1 at `<worktrees>/<entry>/snapshot` (the fix's first parent) and `<worktrees>/<entry>/fix`, tier 2 under `<worktrees>/<entry>/tier2/`. It installs dependencies with `bun install --frozen-lockfile` only when Freerange needs them: the tree's tsconfig names `types`, or the file imports a package. Then it writes the insertion. The assert keeps the check's condition text, on new lines indented like the anchor statement. The diff of each tree against its commit goes to `<dev-eval>/insertions/<entry>/<tree>.diff` (tier 2: `insertions/<entry>/tier2/<tree>.diff`), and `insertions.json` records each entry's tier and each tree's commit, assert line and file sha1s. A tree holding anything but its commit's file or the recorded insertion is refused.

## Runner and verdicts

`run` recomputes eligibility, then runs `bun <freerange>/fr.ts <file>` from each tree's root, under `/usr/bin/time -l` and the per-file timeout. `--env` passes `FREERANGE_*` flags such as `FREERANGE_ASSERT_FORMS=1`, `FREERANGE_STATIC_RELATIONS=1` or `FREERANGE_SWEEP=1`. With a sweep flag, the sidecar goes to `raw/<entry>/<tree>.sweep.json`. The verdict at the inserted assert follows `../lib/findings.ts`:
- `proved`: an interior assert in a lowered function with no finding at its line, or an `unreachable` finding
- `could-not-prove`
- `can-be-false`: the finding is kept verbatim
- `not-analyzed`: the function wasn't lowered (the finding names why), the assert is outside a named top-level function, the file holds something other than the recorded insertion, or the run timed out, crashed or stopped on TypeScript errors
- `requirement`: a leading assert with no finding

With a sweep, a row also carries the sweep outcome: a verified counterexample with its input, or `held` with N inputs.

A run directory holds:
- `run.json`: Freerange and harness revisions with their dirty-file counts, bun version, flags, timeout, the entries and readings sha1s, eligible ids per tier, and any eligible entry not prepared
- `eligibility.json` and `eligibility.md`
- `verdicts.jsonl`: one row per entry, tier and tree, with every finding line of the file
- `raw/tier<N>/`, `score.json` and `score.md`
- `census.json` and `census.md`: where Freerange stops

## Score

Counting rule: one row per eligible entry per tier run on both trees, split by tier and then `reach`. The tiers are never added.
- **Refuted on a tree:** verdict `can-be-false` at the inserted assert, or a verified sweep counterexample there.
- **Points at the defect:** refuted on the snapshot tree and not refuted on the fix tree.
- **Also counted:** refuted on the snapshot tree, refuted on the fix tree, proved on the fix tree, and not analyzed on the snapshot tree, the fix tree or either.

## Census

Counting rule `dev-oracle-census@v1`: one row per eligible entry per tier run on both trees, grouped by the snapshot tree's stop. A tree's stop is one of:
- the verdict at the inserted assert, when Freerange reached one (`reached-verdict`)
- the run's failure (`run-failed`)
- the finding that left the assert `not-analyzed`, which names the first unsupported construct of the assert's function, or says the assert sits outside a named top-level function

That finding's text gives the group, checked in order: `closure`, `assert-form`, `object-write`, `array-method`, `import`, `dom-or-platform`, `other`. `lib/census.ts` gives each group's rule. `census.md` lists each entry's group, the source line of the construct and Freerange's message, and the fix tree's stop when it differs.

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
