# Evaluation corpus scorer

A scorer that measures one Freerange revision on a corpus of `console.assert` sites with ground truth, and a small synthetic example corpus to run it on.

## Layout

- `score.ts`: the scorer. `lib/`: its parts. `tests/`: unit tests, run by `bun test`.
- `examples/`: a hand-written example corpus: `manifest.json` and one unit under `synthetic/`.

Corpora other than the example are built outside this repository and are never committed here (`eval/corpus/` is ignored). A corpus directory holds:

- `manifest.json`: the version, counting rules, slice statuses, skipped units and the unit list.
- `node-modules.json` (optional): the local node_modules directory for each label a unit names; the scorer's defaults, overridden by `--node-modules`.
- `<slice>/<unit>/unit.json`: the files to analyze, whether the unit has its own `tsconfig.json`, the node_modules label it needs, provenance (every source path and sha1), the Freerange findings its source run recorded, and one ground truth record per site.
- `<slice>/<unit>/tree/`: the sources, plus the unit's `tsconfig.json` when it has one.

A ground truth record joins by key and can carry these kinds of evidence, each null when the unit's source doesn't provide it:

- `examples`: stored inputs that make the assert fire on the unmutated code, as an entry function and a JavaScript array literal of its arguments.
- `lattice`, `witness` and `kills`: firing counts from a mutation run's generated inputs and caller-shaped witness sets, and the mutants whose killing lines include the site.
- `replay`: a replay oracle's firing evidence at one stage of a recorded fix.
- `labels`: a reader's classification of the assert.

## The synthetic example

`examples/synthetic/synthetic-widths` is one file of three width helpers, written for this example:

- `splitWidth`: two leading asserts and an interior assert that follows from them.
- `insetWidth`: an interior assert that doesn't hold when the inset is more than half the width. Its ground truth stores the input `insetWidth(10, 8)`, which makes the assert fail with the leading assert held; the runtime check runs it whatever the verdict says.
- `sumWidths`: an assert after an array callback, which is outside Freerange's supported subset.

## Counting rules

- **site**: a `console.assert` call the TypeScript AST finds in a unit's analyzed file. The scorer classifies it like Freerange's lowering: the maximal consecutive prefix of asserts in a named top-level function's body is `requirement`, a later assert is `assertion`, and an assert whose nearest function isn't a named top-level function is `outside`.
- **key**: `<path>|<owner>|<condition with whitespace collapsed>|<occurrence>`, where the occurrence counts asserts with the same path, owner and text in source order. Ground truth joins by key; `unmatchedGroundTruth` lists records no site matched.
- **verdicts** from `fr <file>` findings mode:
  - `proved`: an interior assert in a lowered function with no finding at its line. An `unreachable` finding also counts as proved, and the reason says so.
  - `could-not-prove`: `could not prove`, `could not check`, an unrecognized console-assert finding at the site, or a requirement whose function's requirements weren't checked.
  - `can-be-false`: `console.assert condition can be false`, or a declared requirement reported false.
  - `not-analyzed`: the function wasn't lowered (its one finding names the first unsupported construct), the assert is outside a named top-level function, or the run failed: timeout, TypeScript errors, or node_modules not provided.
  - `requirement`: a leading assert of a lowered function with no finding. Freerange assumes it inside the function and checks it at same-file calls.
- **catching**: the record's `catching` flag: kills ≥ 1 in the unit's mutation run, or a contract a replay oracle credits.
- **fires on corpus inputs**: lattice firing under noise@none > 0, or witness firings without a domain line > 0, or for replay units a firing at that stage.
- **confirmed in-domain**: a stored example input, re-run on an instrumented copy of the unit (`lib/runtime.ts`), makes the assert fail inside a call of its function whose leading asserts held and whose numeric inputs were all finite.
- **soundness violation**: a `proved` site with a confirmed in-domain firing.

## Running

```sh
bun eval/score.ts --freerange <Freerange checkout with node_modules> --corpus <corpus directory> --out <new directory> \
  [--node-modules <label>=<directory>] [--slice <name>] [--unit <id>] [--timeout-seconds 300]
bun eval/score.ts --freerange . --corpus eval/examples --out <new directory>
```

The scorer copies each unit tree to `<out>/work/<unit>` and runs `bun <freerange>/fr.ts <file>` there under `/usr/bin/time -l` with the per-file timeout, so the peak RSS of every file is recorded. Units without their own `tsconfig.json` run as single-file programs; the scorer refuses to run them when a `tsconfig.json` sits above the work directory. It writes `run.json`, `verdicts.jsonl` (one row per site), `files.tsv`, `summary.json`, `summary.md`, the raw output under `raw/`, and the work trees. The summary also says which files reproduce the findings their source run recorded, which checks that a unit's copy analyzes like the original.

A prototype branch that prints a concrete counterexample doesn't need a new parser to be scored: the runtime check runs the corpus's stored examples, whatever the finding says.

## Limits

- The runtime check trusts the example's entry function to reach the site. A firing through a callee whose own leading asserts failed isn't in-domain, even when the entry's leading asserts held.
- Caps: 20,000 finding lines per file, 16 MB of output per stream, 200,000 runtime events and 10,000 checked numbers per example, 3 examples per site, 3,000 example runs per score, 2,000 units per manifest.
