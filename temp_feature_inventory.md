# Recent feature decisions

This is a temporary decision ledger for the experiments that led to the current `main`. It is not a roadmap or user documentation. `README.md` describes how to use Freerange, and `current-decisions.md` defines the accepted subset.

## Landed on main

### Static `console.assert`

Freerange recognizes a one-argument call to the standard `console.assert` in a named top-level function declaration. The assertion is static: Freerange must prove the condition, and the call does not give the analyzer a new fact.

- Consecutive assertions at the start of a function declare caller requirements.
- Later assertions are proof checkpoints and do not narrow later code.
- Every path through an asserted function must finish analysis without a local assumption.
- Assertions use ordinary JavaScript evaluation order and TypeScript's standard `console` declaration. Freerange adds no runtime package or runtime behavior.
- Successful assertions print only in `fr --audit`; unproven, false, blocked, and unreachable assertions are `fr` errors.

The accepted assertion language is deliberately small. A leading requirement is `Number.isInteger(parameter)` or one comparison between a parameter and a finite number. An interior assertion is one numeric comparison or one `Number.isInteger`, `Number.isFinite`, or `Number.isNaN` call. Operands are names, numeric literals, property paths, or array lengths. Calculations must be bound before the assertion.

Relative to the parent of `8c07747`, the current worktree adds about 1,208 net lines under `src` and 727 net lines under `tests`. The size includes lowering, caller requirements, diagnostics, reporting, CLI behavior, and adversarial tests, not only the assertion instruction.

MJ Gallery maintains 39 checks, including four caller requirements. Pretext maintains 21 checks, including two requirements. These are explicit maintained properties, not newly inferred contracts.

### Assertion-only comparison proofs

While checking an assertion, Freerange can follow immutable producers through:

- the same value and fields of a fresh record
- one-sided `Math.min` or `Math.max` selection
- corresponding `Math.min` operands written in the same order
- adding or subtracting a proven nonnegative value
- multiplying both sides by the same proven nonnegative value
- positive-divisor remainder bounds

The walk traverses a finite producer graph and memoizes value pairs before recursion. It has no arbitrary depth limit. It does not store relationships for ordinary branches, inferred return contracts, or later assertions. General transitivity and the cross-product between every `Math.max` and `Math.min` operand remain unsupported.

Of the 54 interior app assertions, 37 prove from ordinary ranges and integer facts. The remaining MJ checks use fresh-record fields, min/max selection, nonnegative addition or subtraction, matching multiplication, or one remainder bound. Two Pretext checks use min/max selection. Counts overlap when one assertion composes several rules.

### Ordinary call completion

Same-file calls now model omitted optional arguments and supported literal defaults. Passing `undefined` selects a default; passing `null` does not. Unsupported object and computed defaults remain outside the subset. A call that supplies more arguments than the implementation declares leaves the subset; modeling that TypeScript overload corner showed no product value.

Leading requirements may compare a parameter with an immutable same-project numeric constant whose initializer ultimately resolves to a finite literal. Computed and mutable constants remain unsupported.

These rules changed almost no corpus coverage. They stay because they complete common JavaScript call semantics with small, shared logic rather than as corpus-specific features.

### Earlier FR1 cleanup that remains important

- Every object spread rejects. List fields explicitly so runtime property reads match the analyzer's model.
- Sparse local arrays reject. Incoming arrays print the dense plain-array assumption.
- Fixed tuples print exact arity. Optional and rest tuple parameter positions reject.
- Assumptions print only for input paths the function actually reads.
- Module reads are fresh. Snapshot a module value into a local before checking and using it.
- Project and file commands have the same output shape; a file argument only filters the resolved project.
- The real `demo/index.ts` spring contracts are covered by tests.

## Reconsider only with new evidence

These prototypes worked but did not justify production support.

- **Narrow after a proven assertion:** about 33 net lines and no MJ Gallery or Pretext report change. Reconsider when a real checkpoint must feed later analysis and an ordinary guard is materially worse.
- **Named boolean predicates in assertions:** about 183 net production lines and no corpus report change. Reconsider when a real property is substantially clearer as `console.assert(isValidLayout(frame))` and needs a documented predicate contract.
- **Assertions in partially analyzed functions:** the prototype handled several control-flow positions, but all 60 selected app checks live in fully analyzed functions. Reconsider when an important property naturally occurs before unavoidable unsupported code.
- **Inline array `map` callbacks:** about 216 production lines made two Pretext functions complete and one partial; only one gained a useful numeric contract. MJ Gallery gained none. Reconsider after independent numeric callback use that is awkward to extract or write as a loop.
- **32-bit bitwise operations and `Math.imul`:** coherent, but no selected UI property used them. Reconsider for a real hash, mask, color, or index property.
- **One bounded disequality relation:** would prove a subtraction nonzero after comparing its operands, but only copied remap helpers used it. Bind and check the subtraction itself.

## Rejected directions

Do not revive these without a materially different design and independent product evidence.

- Persistent order pairs, loop-carried relationships, symbolic solvers, affine recurrences, or transitive closure. The relational prototype cost roughly 450–500 production lines for the core and improved one untouched Pretext contract and no MJ contract.
- General function summaries. Same-file calls are reanalyzed under caller values; summary prototypes changed no ordinary corpus reports.
- Cross-module function contracts. A prototype added roughly 650 production lines, gained about one complete function, and changed no lint findings.
- Append-only arrays, fresh-local mutation, or broad alias analysis. The array experiment added roughly 440 production lines and still missed the motivating packing loops.
- JSX/style snapshots and const following. The feature found some real style problems but added substantial framework-specific reporting and noise, then was deeply reverted.
- Optional/rest tuple arity ranges. A correct prototype cost about 135 production lines; neither corpus had a numeric tuple input requiring the feature. Rejecting the shapes is simpler.
- Array callback modeling from the current evidence. Callback order, captures, holes, allocation, and effects become part of the accepted model for little numeric gain.
- Runtime invariants added for Freerange. Checked functions should fail statically; application runtime validation remains ordinary application code.
- Division-result relevance and downstream-clamp suppression. Requirements are created where the risky operation occurs, and deleting them based on later uses was either unsound or too pattern-specific.
- Purity systems, broad effect tracking, and general alias analysis. Pre-pivot versions grew large without proportionate product value.

## Current limits

Every limit fails conservatively rather than strengthening a result.

- Loops get 16 abstract-state updates per header. Widening makes ordinary loops stabilize in a few updates; the backstop handles structurally growing states.
- Recursive type classification follows at most eight nested levels. Removing the boundary made several MJ files produce tens of thousands of assumption lines without completing more functions.
- A nullable recursive property becomes opaque as soon as its inner type reaches an ancestor. This preserves the existing result while avoiding repeated expansion through every member of a recursive union.
- Requirement expansion visits each instruction at most once and falls back to a local assumption when no caller-readable requirement can be formed.
- An abstract number retains at most one excluded constant. A later exclusion can lose precision but cannot produce a false guarantee.
- Assertion producer proofs have no depth cap because the finite graph and visited value pairs guarantee termination.

## Features still worth watching

- The seven audit refactoring guides produce no MJ suggestions and suggestions in eight clean Pretext files. They remain because agent-directed rewrites are a product goal and every suggestion is conditional and behavior-tested. Reconsider if real agents do not use them.
- Full audits remain large: roughly 0.89 MB for MJ Gallery and 167 KB for clean Pretext before the assertion integration. Per-file audit is the practical authoring tool; future reporting work should improve selection rather than weaken facts.
- `valueKind` and `declaredKind` contain similar recursive TypeScript classification. They answer different questions on the acceptance boundary; unify them only through a measured prototype, not by appearance.

## Corpus evidence recorded during the experiments

- Demo: 10 of 14 named functions fully analyze. Unsupported functions are framework or mutation-heavy rather than lost numeric helpers.
- MJ Gallery before the assertion adaptation: 151 of 1,605 named top-level functions complete, 40 partial, 1,414 unsupported, and no lint findings.
- Clean Pretext before the assertion adaptation: 84 of 619 complete, 48 partial, 487 unsupported, and 11 caller-contract notes.

Freerange remains a verifier for extracted synchronous numeric helpers, not a repository-wide proof or lint pass. Real repositories determine whether a small rule is useful; they do not define the rule.

## Durable references

- Static assertions began at `8c07747` and were completed through `b356310`.
- The FR1 cleanup and experiment judgments are recorded in commits `f942f01` through `87b66ff`.
- User-facing behavior lives in `README.md`; design boundaries and caps live in `current-decisions.md`.
