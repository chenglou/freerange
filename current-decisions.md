# Current decisions

## Working agreement

**warn** the user before decisions that can cause path, state, or calculation explosions — branches, loops, numeric expressions, fixed points, widening — before major architecture or file-structure changes, and before important data-structure decisions become difficult to reverse.

## What state survives when execution reaches unsupported code?

Keep information that was established before the unsupported operation, but mark the result as partial and record where and why analysis stopped. Partial information describes only the code that ran before the stop. It must not be used as a complete function postcondition or as the final program state.

For example, given `let width = 100; unsupportedOperation(); width = 200`, the report may say that `width` was `100` when analysis stopped. The report must not claim that the function returns with `width` equal to `100` or `200`.

What reports keep today is smaller than that example: the returns from paths that completed, and the requirements found along every path the analysis evaluated, including paths that later stopped (the `on analyzed paths:` lines). A stop record carries only its location and a tagged reason, so printing values at the stop — `width` being 100 above — is punted. And when the unsupported construct is found during lowering rather than during evaluation, the function's whole half-built body is thrown away, keeping nothing. Whether lowering should instead keep the statements before the stop needs deciding before the module initialization work starts: real top-level code usually calls something unsupported early, and throwing away the whole initializer would leave every module binding unknown.

Complete and partial results must have different data shapes so code cannot accidentally treat one as the other. The report should show the source location and reason for stopping. This gives an agent enough information to understand what was analyzed and, when useful, rewrite the unsupported code.

If a called function performs supported mutations and then reaches unsupported code, keep those mutations only in the called function's own partial result. Mark the caller partial at that call site and do not analyze later caller statements. Do not present the called function's mutations as the caller's final state.

In reports, a partial function prints `stopped:` lines (where and why each path stopped) and `on analyzed paths:` lines (what the completed paths returned, and the requirements found along every analyzed path — evidence about the paths that ran, not a guarantee about the whole function). These evidence lines deliberately read differently from `requires:`/`ensures:` lines, and the partial report shape has no fields for those lines, so evidence cannot print as a guarantee.

Known report limits worth keeping in mind: mutually recursive functions currently blame each other — each entry says `calls <the other>, whose analysis stopped` — and neither names recursion (only direct recursion prints `recursive call to …`). An analyzed function's writes to its parameter objects are tracked by the analysis but not yet printed, so an entry with no ensures lines must not be read as having no effects. The CLI exits 0 whenever analysis ran, including reports full of unsupported and partial entries; only the whole-file TypeScript check and genuine crashes exit nonzero.

## How should non-finite numbers be modeled?

Number parameters default to finite and non-NaN (object parameter properties get the same treatment). Numeric operations must prove that they preserve that property. If an operation may produce NaN or infinity, report the requirement needed to keep the result finite (today only the division-by-zero requirement exists; overflow makes the result unknown with no requirement). When the requirement cannot be named over the function's parameters — e.g. a division by a property read like `width / grid.columnCount` — analysis stops that path and reports the division's location, instead of silently reporting the result as a possibly non-finite unknown.

Today the requirement (or the stop) is created at the division itself, without checking whether a zero divisor could actually make the function's final result non-finite. That contradicts the rule in the requirements section below, and the section's rule is the intended end state. For example, `a / b > 5 ? 1 : 0` returns a finite 0 or 1 for every input including a zero divisor — the comparison turns Infinity or NaN into plain true or false — yet today it reports `requires: b is nonzero`, and when the divisor is a property read like `grid.columnCount`, analysis stops entirely. Revisit when requirements are derived from whether the final result is affected. Naming property paths in requirements additionally needs to know the property is not written between function entry and the division.

The analyzer must still represent possible NaN and infinities internally, so it can explain where the possibility came from and pass requirements to callers. Eventually it should also recognize operations that make a value finite again — no such rule exists yet: `Math.min`/`Math.max` currently return an unknown result when an input may be non-finite, so a clamp does not recover finiteness today. Do not stop analysis merely because an intermediate result may be non-finite.

## How should module initialization be modeled?

Lower each module's top-level runtime code into a synthetic initializer function. Execute that function with the same CFG and evaluator used for ordinary functions. A small module setup phase still allocates module variables and exported bindings, initializes runtime dependencies first, ensures each module runs once, preserves side-effect-only imports, and shares live module bindings with later functions and callbacks. Function declarations do not run during initialization unless top-level code calls them.

For now, reject runtime import cycles and top-level `await`. Reject only the affected group of initialization dependencies; unrelated modules and self-contained function summaries remain analyzable. Type-only import cycles do not affect runtime initialization. Module slots must distinguish uninitialized values from initialized values so runtime cycle support can be added later without replacing the architecture.

What a function may assume about a module binding follows one rule, with no const/let special-casing: trust a value only when no write can happen between initialization and the function's call. Two kinds of bindings qualify: `const` bindings holding numbers or booleans (reassignment and mutation are impossible), and any binding — const or let — that no code outside the initializer ever assigns, which a whole-file scan can check. A `const` object's identity flows into functions, but its property values start unknown at function entry, since any earlier call may have written them. Everything else contributes only its declared type's kind, e.g. `let debug = false` reads as some boolean inside a function. A qualifying binding stays trustworthy even when the initializer is partial, as long as its assignment ran before the stop.

With runtime cycles and asynchronous initialization excluded, module top-level execution consists of ordinary calls, branches, loops, heap operations, and unsupported-code handling. Reusing the normal evaluator avoids a separate module interpreter and duplicated semantics. Setting up module dependencies and live bindings is module-specific, but executing their code is not.

## How should callback ordering be modeled?

Do not model callback ordering for now. Analyze supported callback bodies independently, using ordinary function summaries and explicit assumptions about their parameters and available state. Registering a callback may still be reported as an effect, but registration does not cause Freerange to choose an execution order or execute the callback later.

Module initialization remains analyzable because it has a defined runtime dependency order. Callback summaries must not assume that mutable module state still has its initial value merely because initialization assigned that value earlier. The same holds for exported functions, which also run at arbitrary times after initialization.

This keeps general functions such as `render(state)` useful without knowing which events created `state`. It also avoids exploring many possible callback sequences. A caller-selected, bounded callback scenario can be reconsidered later if a concrete report needs stronger evidence that a state is reachable.

## How should the scope of purity analysis be chosen?

Keep purity analysis much smaller than old Freerange unless the current project demonstrates a concrete need. When purity work begins, both the primary agent and the agent implementing purity must read the old `spec/purity` documentation and consult thread `019f0365-0939-7a50-a509-46c7733b455b` for the earlier semantic decisions and edge cases. Do not inspect or port that work before purity becomes the active task.

The old documentation and thread define an upper bound, not a feature list for the rewrite. If they say a purity feature was unsupported, the rewrite must not support it. If they say a feature was supported, that only makes the feature a candidate. Ask the user before including it. Prefer the smallest subset needed by the post-pivot analysis, even when old Freerange already implemented a broader rule.

## What do inferred requirements mean?

Every inferred requirement must say which guarantee it enables. A requirement does not mean that the program is otherwise invalid. For example, if a function divides `containerWidth` by `columnCount`, the report should explain what `columnCount` must satisfy to guarantee a finite, non-NaN return value. (Not implemented yet: today's requires line names the operation and its location but not the guarantee; only the `on analyzed paths:` lines in partial reports name one, with the wording `gives a finite result only when …`.)

Infer the requirement from the desired final guarantee, not from the operation alone. Do not report a requirement merely because an intermediate operation may produce a non-finite value; later code may make the result finite again. Restrictions needed only because Freerange does not support an operation should be reported as unsupported code, not as caller requirements.

Derive the full safe range rather than stopping at an obvious local condition. A nonzero divisor avoids division by zero, but finite inputs can still overflow during division. If `containerWidth` may be any finite number, `Math.abs(columnCount) >= 1` is a sufficient condition for a finite quotient. If the possible magnitude of `containerWidth` is smaller, the minimum safe divisor magnitude can also be smaller. Without a known sign, the safe values may be two ranges: `columnCount <= -minimumMagnitude` or `columnCount >= minimumMagnitude`. Earlier facts such as positivity or integrality should simplify that requirement, e.g. to `columnCount >= 1`. (Also not implemented: only the nonzero condition is emitted, and ensures lines are computed without assuming the requires lines, so satisfying a requirement does not improve any printed guarantee. An explicit guard like `if (columnCount === 0) return 0` does not remove the requirement either: an interval cannot represent "any number except zero", so the not-equal branch refines nothing today.)

The report should include the operation and source location that caused the requirement. At a call site, Freerange should prove the requirement, pass the unproven part on to the caller's own callers, or explain which guarantee can no longer be made.

Requirements with alternatives or conditions can grow quickly across branches and function calls. Before implementing them, choose a shared expression representation and explicit growth limits rather than copying expression trees.

## How should repeated allocations from one source location be represented?

Represent runtime objects with a bounded number of abstract allocations. One abstract allocation may represent either one known runtime object, or several possible objects created from the same source location (a summary allocation).

A write may replace the previous property value only when the reference points to exactly one abstract allocation and that allocation represents one known runtime object. If the reference may point to several allocations, or the selected allocation may represent several runtime objects, combine the old and new property values. Once an allocation may represent several runtime objects, later joins must not treat it as one known object again.

Two references to the same summary allocation are not necessarily equal at runtime because the allocation may represent different objects created at the same source location. Distinct abstract allocations may prove that two references differ, but sharing a summary allocation does not prove that they are equal.

This is now built. An allocation is identified by its source site plus the immediate call site that entered the allocating function, in one of two slots: the known slot holds the object from the site's most recent execution, and the summary slot holds every object that site has displaced. Re-executing a site joins the previous object into the summary, then repoints every reference that pointed at the previous object so the reference now points at the summary — references in the frame, in the heap, and in the fresh object's own property values — and finally installs the fresh object as a new known singleton. Only the allocation instruction may install a fresh known object, and only because the fresh object is a different, newly created runtime object; joins and widening never turn a summary back into a known object. References carry a set of possible allocations, and joining two references unions their sets. The set of possible identities is fixed by the program text, so no growth cap is needed.

The amount of call context used to distinguish allocations remains an internal precision policy and must stay replaceable. It lives in one type alias (`AllocationContext`), the call-site argument the call evaluation passes to the callee, and one comparison function; a deeper policy changes those and nothing else. Reports must never expose allocation contexts; when identity consequences become reportable, describe them plainly, e.g. possible aliasing or a fresh returned object.

**warn:** with a deeper context policy or module-level references, the identity sets are no longer fixed by the program text and can grow. Revisit the limits when either lands; if a cap ever becomes necessary, merge into a summary that stays visible through every existing reference — a summary detached from live references reports wrong values.

## How should loops be analyzed?

Do not unroll loops. Analyze the loop CFG until its abstract state stabilizes, then use supported recurrence or collection summaries. For example, one unconditional push per input can prove `output.length === input.length` without examining every item.

Unrolling makes analysis depend on runtime collection length and still cannot prove iterations beyond an arbitrary cutoff. If fixed-point analysis does not stabilize and no supported summary applies, report the property as unresolved.

The convergence limit counts fixed-point rounds of one loop header's abstract state, not runtime iterations. Widening makes ordinary counting loops converge in two or three rounds regardless of how many times the loop runs at runtime; the limit exists only to guarantee termination when each round genuinely keeps changing the state. The only known way to hit the limit is a chain of loop-carried variables longer than the limit (widening settles one variable per round). Allocations no longer prevent convergence: since allocations are keyed by their source site and call site, a loop that re-executes an allocation site displaces the previous object into that site's summary and converges.

When any path inside a loop stops, the loop header cannot reach its fixed point, and a stop can first appear on a late widening round after earlier rounds already propagated returns downstream. Returns reachable from such a header are therefore not evidence and are suppressed; returns before or bypassing the loop survive. This deliberately also suppresses evidence from the path where the loop body runs zero times, when the stop existed from the first round.

**warn:** summary discovery needs explicit limits before implementation; the fixed-point limit already exists (16 rounds per loop header).

## Additional decisions

- Analysis runs forward, creates requirements at operations, passes unproven requirements to callers, and reports inferred guarantees.
- Each CFG block keeps one merged abstract state. We do not retain every path.
- Loops are not unrolled.
- Block parameters carry values across branches and loops.
- Browser behavior comes from static models. No browser probes.
- Reports distinguish input assumptions (`assumes:`), guarantees (`ensures:`), inferred requirements (`requires:`), unsupported code (`unsupported:`), and partial results (`stopped:` plus `on analyzed paths:`).
- The accepted TypeScript subset stays explicit and deliberately narrow. Today it is enumerated by the rejection reasons and their formatting switch in `src/report`; a written positive list waits until the subset stabilizes.
- Stable numeric IDs identify functions, blocks, values, and source locations. Allocations are identified by their source site plus call site, in a known or summary slot; a root object parameter is identified by its parameter index. Module and effect IDs will follow when modules and effects exist.
- Module variables, heap objects, local values, and platform state have different lifetimes and should not be stored in one generic map.
- We use one lowering pipeline and one evaluator, rather than separate evaluators for module initialization, functions, and callbacks.

## Punted

- Source annotations. Analysis remains annotation-free for now. Reconsider annotations only when a report can explain that one would avoid substantial analysis growth or unlock a useful guarantee.
- Concrete counterexample search and replay.
- Deriving requirements from whether the final result is affected, with ensures lines that hold when the requirements are satisfied. Requirements are currently created at the causing operation, so a division whose non-finite result never reaches the return value still reports one.
- One requirement record per operation. Deduplication is currently by expression; the first causing operation's location wins.
- Printing values at a stop (`width` was 100), and recovering the loop evidence that gets suppressed when a stop happens inside a loop.
- Callback ordering and execution of callback sequences, including caller-selected bounded callback scenarios.
- The exact relational numeric domain and recurrence analysis.
- Modeling thrown exceptions. A `throw` statement is currently rejected at lowering.
- Rules for operations that make a value finite again, e.g. a `Math.max`/`Math.min` clamp recovering a finite range from a possibly non-finite input.
- Not-equal branch narrowing, e.g. an explicit `if (columnCount === 0) return 0` guard removing the nonzero requirement.
- Reporting every unsupported construct in a function instead of only the first.
- Optional object properties. Reading or writing a `y?: number` property involves nullability, which the analyzer does not model, so those accesses are unsupported; objects declared with optional-property types remain analyzable through their required properties.
- Properties whose declared type mixes kinds, e.g. `{x: number | boolean}` written with a number on one path and a boolean on another. These still crash the analysis; the shape check compares property names only.
- Runtime import cycles and top-level `await`.
- Termination proofs and `decreases` clauses.
- The general method for discovering loop invariants.
- The representation and growth limits for symbolic arithmetic, branch conditions, and requirements with alternatives.
- Final widening, fixed-point, recursion, and function-summary caching policies.
- Purity features beyond the small subset that the post-pivot analysis eventually demonstrates a need for.
