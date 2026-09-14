# Evaluation corpus and scorer

A fixed corpus of `console.assert` sites with ground truth from runs, and a scorer that measures one Freerange revision on it. It is exposed development data: every slice comes from experiments that the same sessions built and read, so results are calibration, not a held-out benchmark.

This directory holds only the builder, the scorer and their tests. The corpus copies source files and asserts from private repositories, so `build-corpus.ts` writes it to a local directory, and it is never committed here (`eval/corpus/` is ignored).

## Layout

- `build-corpus.ts`: builds a corpus directory from the scratchpad runs. It refuses to overwrite an existing directory.
- `score.ts`: the scorer. `lib/`: its parts. `tests/`: unit tests, run by `bun test`.

A built corpus directory holds:

- `manifest.json`: the version, counting rules, slice statuses, skipped units and the unit list.
- `node-modules.json`: the local node_modules directory for each label a unit names; the scorer's defaults, overridden by `--node-modules`.
- `<slice>/<unit>/unit.json`: the files to analyze, whether the unit has its own `tsconfig.json`, the node_modules label it needs, provenance (every source path and sha1, relative to the scratchpad root `S/`), the Freerange findings its source run recorded, and one ground truth record per site.
- `<slice>/<unit>/tree/`: the sources, copied verbatim, plus the unit's `tsconfig.json`.

## Slices

- **mj-gallery**: the Plan A m7 run (`S/freerange-focus/plan-a/runs/20260914T072511Z-mj-prealpha-m7`). 13 copies of mj-gallery layout files at prealpha 93b9935807 with their project-local import closure, 81 in-scope asserts, and `tooltipContentLayout`'s excluded assert without ground truth. Ground truth per site: lattice firings on the unmutated copy (domain@v1b, 100,000 inputs per entry), firings in the m7 witness run, kills from `kills.tsv`, and the contract reader's labels with the stricter reading.
- **families**: the Plan A m1d (virtualization, 449 systematic mutants), m2b (popovers `contracts`, `reshaped`, `contracts-k7t5b`), m3b (frames `inv`, `reshaped`) and m4b (packing `contracts`, `reshaped`) runs, with firings from `S/freerange-focus/plan-a/runs/w1-witness` where a witness set exists. `contracts-k7t5b` holds two asserts written after the misses they catch were seen.
- **replay**: contracts the replay oracles credit. From the mj-gallery harness, the contracts with firings inside the C1 impact states of 4e835add49 (ga-v1, gb-v1, pilot) and 676c37635b (pilot), at the snapshot (C0) and the introducing commit (C1). These units are the stage's whole `src/` tree, because the layout file's import closure passes 400 files; the stage tsconfig gets the replay checkers' wrapper options. From the external harness, the contracts listed as caught for tv-e6504e7, tv-1e3b908, tv-ace7d93 and rrp-7761b1d, as import closures. Ground truth is the oracle's evidence: firing counts per stage. mj-gallery harness examples are decoded from direct sweep states at C1; external firings come from unit tests, so those units store no examples.
- **writers**: not built. `S/freerange-focus/plan-c/score.md` did not exist when the corpus was built.

## Counting rules

- **site**: a `console.assert` call the TypeScript AST finds in a unit's analyzed file. The scorer classifies it like Freerange's lowering: the maximal consecutive prefix of asserts in a named top-level function's body is `requirement`, a later assert is `assertion`, and an assert whose nearest function isn't a named top-level function is `outside`.
- **key**: `<path>|<owner>|<condition with whitespace collapsed>|<occurrence>`, where the occurrence counts asserts with the same path, owner and text in source order. Ground truth joins by key; `unmatchedGroundTruth` lists records no site matched.
- **verdicts** from `fr <file>` findings mode:
  - `proved`: an interior assert in a lowered function with no finding at its line. An `unreachable` finding also counts as proved, and the reason says so.
  - `could-not-prove`: `could not prove`, `could not check`, an unrecognized console-assert finding at the site, or a requirement whose function's requirements weren't checked.
  - `can-be-false`: `console.assert condition can be false`, or a declared requirement reported false.
  - `not-analyzed`: the function wasn't lowered (its one finding names the first unsupported construct), the assert is outside a named top-level function, or the run failed: timeout, TypeScript errors, or node_modules not provided.
  - `requirement`: a leading assert of a lowered function with no finding. Freerange assumes it inside the function and checks it at same-file calls.
- **catching**: kills ≥ 1, i.e. a row of the run's `kills.tsv` with `kill_noise@abs1e-9` true and `behavior_diffs` > 0 whose `killing_lines` include the site. For replay units, a contract the oracle credits.
- **fires on corpus inputs**: lattice firing under noise@none > 0, or witness firing > 0, or for replay units a firing at that stage.
- **confirmed in-domain**: a stored example input, re-run on an instrumented copy of the unit (`lib/runtime.ts`), makes the assert fail inside a call of its function whose leading asserts held and whose numeric inputs were all finite.
- **soundness violation**: a `proved` site with a confirmed in-domain firing.

## Running

```sh
bun eval/build-corpus.ts --scratch <scratchpad root> --out <corpus directory>
bun eval/score.ts --freerange <Freerange checkout with node_modules> --corpus <corpus directory> --out <new directory> \
  [--node-modules <label>=<directory>] [--slice families] [--unit <id>] [--timeout-seconds 300]
```

The scorer copies each unit tree to `<out>/work/<unit>` and runs `bun <freerange>/fr.ts <file>` there under `/usr/bin/time -l` with the per-file timeout, so the peak RSS of every file is recorded. Units without their own `tsconfig.json` run as single-file programs; the scorer refuses to run them when a `tsconfig.json` sits above the work directory. It writes `run.json`, `verdicts.jsonl` (one row per site), `files.tsv`, `summary.json`, `summary.md`, the raw output under `raw/`, and the work trees. The summary also says which files reproduce the findings their source run recorded, which checks that a unit's copy analyzes like the original.

A prototype branch that prints a concrete counterexample doesn't need a new parser to be scored: the runtime check runs the corpus's stored examples, whatever the finding says.

## Limits

- The mj-gallery units copy only the in-scope files and their project-local import closure, with `types: []`. The m7 run analyzed the same files inside the full worktree, so recorded findings are listed per unit for comparison.
- External replay units get a default strict tsconfig and no packages; files that need packages stop on TypeScript errors and show as not analyzed.
- The runtime check trusts the example's entry function to reach the site. A firing through a callee whose own leading asserts failed isn't in-domain, even when the entry's leading asserts held.
- Caps: 20,000 finding lines per file, 16 MB of output per stream, 200,000 runtime events and 10,000 checked numbers per example, 3 examples per site, 3,000 example runs per score, 400 files per import closure, 2,000 units per manifest.
