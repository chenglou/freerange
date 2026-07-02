# Current decisions

## Working agreement

**warn:** Before making a decision that may cause path, state, or calculation explosions, including branches, loops, numeric expressions, fixed points, or widening. Also warn before major architecture or file-structure changes and before important data-structure decisions become difficult to reverse.

## What state survives when execution reaches unsupported code?

Keep information that was established before the unsupported operation, but mark the result as partial and record where and why analysis stopped. Partial information describes the analyzed prefix only. It must not be used as a complete function postcondition or as the final program state.

For example, given `let width = 100; unsupportedOperation(); width = 200`, the report may say that `width` was `100` when analysis stopped. The report must not claim that the function returns with `width` equal to `100` or `200`.

Complete and partial results must have different data shapes so code cannot accidentally treat one as the other. The report should show the source location and reason for stopping. This gives an agent enough information to understand the supported prefix and, when useful, rewrite the unsupported code.

If a called function performs supported mutations and then reaches unsupported code, retain those mutations only in the called function's partial prefix. Mark the caller partial at that call site and do not analyze later caller statements. Do not present the called function's prefix mutations as the caller's final state.

In reports, a partial function prints `stopped:` lines (where and why each path stopped) and `on analyzed paths:` lines (what the completed paths returned and required). Evidence lines deliberately read differently from `requires:`/`ensures:` lines, and the partial report shape has no fields for contract lines, so evidence cannot render as a contract.

## How should non-finite numbers be modeled?

Number parameters default to finite and non-NaN. Numeric operations must prove that they preserve that property. If an operation may produce NaN or infinity, report the requirement needed to keep the result finite. When the requirement cannot be named over the function's parameters — e.g. a division by a property read like `width / grid.columnCount` — analysis stops that path and reports the division's location instead of silently degrading the result. Revisit when requirement expressions can name property paths; doing that honestly needs to know the property is not written between function entry and the division.

The analyzer must still represent possible NaN and infinities internally. This allows it to explain where the possibility came from, propagate requirements backward, and recognize later operations that restore a finite value. Do not stop analysis merely because an intermediate result may be non-finite.

## How should module initialization be modeled?

Lower each module's top-level runtime code into a synthetic initializer function. Execute that function with the same CFG and evaluator used for ordinary functions. A small module setup phase still allocates module variables and exported bindings, initializes runtime dependencies first, ensures each module runs once, preserves side-effect-only imports, and shares live module bindings with later functions and callbacks. Function declarations do not run during initialization unless top-level code calls them.

For now, reject runtime import cycles and top-level `await`. Reject only the affected group of initialization dependencies; unrelated modules and self-contained function summaries remain analyzable. Type-only import cycles do not affect runtime initialization. Module slots must distinguish uninitialized values from initialized values so runtime cycle support can be added later without replacing the architecture.

With runtime cycles and asynchronous initialization excluded, module top-level execution consists of ordinary calls, branches, loops, heap operations, and unsupported-code handling. Reusing the normal evaluator avoids a separate module interpreter and duplicated semantics. Setting up module dependencies and live bindings is module-specific, but executing their code is not.

## How should callback ordering be modeled?

Do not model callback ordering for now. Analyze supported callback bodies independently, using ordinary function summaries and explicit assumptions about their parameters and available state. Registering a callback may still be reported as an effect, but registration does not cause Freerange to choose an execution order or execute the callback later.

Module initialization remains analyzable because it has a defined runtime dependency order. Callback summaries must not assume that mutable module state still has its initial value merely because initialization assigned that value earlier.

This keeps general functions such as `render(state)` useful without knowing which events created `state`. It also avoids exploring many possible callback sequences. A caller-selected, bounded callback scenario can be reconsidered later if a concrete report needs stronger reachability evidence.

## How should the scope of purity analysis be chosen?

Keep purity analysis much smaller than old Freerange unless the current project demonstrates a concrete need. When purity work begins, both the primary agent and the agent implementing purity must read the old `spec/purity` documentation and consult thread `019f0365-0939-7a50-a509-46c7733b455b` for the earlier semantic decisions and edge cases. Do not inspect or port that work before purity becomes the active task.

The old documentation and thread define an upper bound, not a feature list for the rewrite. If they say a purity feature was unsupported, the rewrite must not support it. If they say a feature was supported, that only makes the feature a candidate. Ask the user before including it. Prefer the smallest subset needed by the post-pivot analysis, even when old Freerange already implemented a broader rule.

## What do inferred requirements mean?

Every inferred requirement must say which guarantee it enables. A requirement does not mean that the program is otherwise invalid. For example, if a function divides `containerWidth` by `columnCount`, the report should explain what `columnCount` must satisfy to guarantee a finite, non-NaN return value.

Infer the requirement backward from the desired final guarantee. Do not report a requirement merely because an intermediate operation may produce a non-finite value; later code may restore a finite result. Restrictions needed only because Freerange does not support an operation are unsupported boundaries, not caller requirements.

Derive the full safe range rather than stopping at an obvious local condition. A nonzero divisor avoids division by zero, but finite inputs can still overflow during division. If `containerWidth` may be any finite number, `Math.abs(columnCount) >= 1` is a sufficient condition for a finite quotient. If the possible magnitude of `containerWidth` is smaller, the minimum safe divisor magnitude can also be smaller. Without a known sign, the safe values may be two ranges: `columnCount <= -minimumMagnitude` or `columnCount >= minimumMagnitude`. Earlier facts such as positivity or integrality should simplify that requirement, e.g. to `columnCount >= 1`.

The report should include the operation and source location that caused the requirement. At a call site, Freerange should prove the requirement, propagate the unmet part outward, or explain which guarantee can no longer be made.

Conditional and alternative requirements can grow quickly across branches and function calls. Before implementing them, choose a shared expression representation and explicit growth limits rather than copying expression trees.

## How should repeated allocations from one source location be represented?

Represent runtime objects with a bounded number of abstract allocations. One abstract allocation may represent either one known runtime object or several possible objects created from the same source location.

A write may replace the previous property value only when the reference points to exactly one abstract allocation and that allocation represents one known runtime object. If the reference may point to several allocations, or the selected allocation may represent several runtime objects, combine the old and new property values. Once an allocation may represent several runtime objects, later joins must not treat it as one known object again.

Two references to the same summary allocation are not necessarily equal at runtime because the allocation may represent different objects created at the same source location. Distinct abstract allocations may prove that two references differ, but sharing a summary allocation does not prove that they are equal.

The amount of call context used to distinguish allocations is an internal precision policy and must remain replaceable. Freerange may compare allocation-site-only, bounded call-context, and caller-instantiated fresh-object approaches without changing the architecture or user-facing semantics. When the chosen context budget is exceeded, merge into a summary allocation instead of creating unbounded identities.

Reports should describe understandable consequences, such as possible aliasing or a fresh returned object, rather than exposing allocation contexts.

**warn:** Call contexts, abstract allocation identities, and reference target sets can grow with functions, call sites, branches, and recursion. Their representations and limits must be decided before heap support expands.

## How should loops be analyzed?

Do not unroll loops. Analyze the loop CFG until its abstract state stabilizes, then use supported recurrence or collection summaries. For example, one unconditional push per input can prove `output.length === input.length` without examining every item.

Unrolling makes analysis depend on runtime collection length and still cannot prove iterations beyond an arbitrary cutoff. If fixed-point analysis does not stabilize and no supported summary applies, report the property as unresolved.

The convergence limit counts fixed-point rounds of one loop header's abstract state, not runtime iterations. Widening makes ordinary counting loops converge in two or three rounds regardless of how many times the loop runs at runtime; the limit exists only to guarantee termination when each round genuinely keeps changing the state. Two known ways to reach it: a chain of loop-carried variables longer than the limit (widening settles one variable per round), and a loop that allocates an object each iteration — which is really the allocation-identity gap rather than a loop problem, and disappears once allocations are keyed by their source site.

When any path inside a loop stops, the loop header cannot reach its fixed point, and a stop can first appear on a late widening round after earlier rounds already propagated returns downstream. Returns reachable from such a header are therefore not evidence and are suppressed; returns before or bypassing the loop survive. This deliberately also suppresses zero-iteration evidence when the stop existed from the first round.

**warn:** Fixed-point iteration and summary discovery need explicit limits before implementation.

## Additional decisions

- Analysis runs forward, generates requirements, propagates unmet requirements backward, checks callers, and reports inferred guarantees.
- Each CFG block keeps one merged abstract state. We do not retain every path.
- Loops are not unrolled.
- Block parameters carry values across branches and loops.
- Browser behavior comes from static models. No browser probes.
- Reports distinguish guarantees, inferred requirements, conditional evidence, unsupported code, and partial results.
- The accepted TypeScript subset should remain explicit. We are not trying to silently analyze all JavaScript.
- Module variables, heap objects, local values, and platform state have different lifetimes and should not be stored in one generic map.
- We use one lowering pipeline and one evaluator, rather than separate evaluators for module initialization, functions, and callbacks.

## Punted

- Source annotations. Analysis remains annotation-free for now. Reconsider annotations only when a report can explain that one would avoid substantial analysis growth or unlock a useful guarantee.
- Concrete counterexample search and replay.
- Callback ordering and execution of callback sequences, including caller-selected bounded callback scenarios.
- Runtime import cycles and top-level `await`.
- Termination proofs and `decreases` clauses.
- The general method for discovering loop invariants.
- The representation and growth limits for symbolic arithmetic, branch conditions, and conditional or alternative requirements.
- The exact relational numeric domain and recurrence analysis.
- The amount of call context used for allocation identity.
- Final widening, fixed-point, recursion, and function-summary caching policies.
- Purity features beyond the small subset that the post-pivot analysis eventually demonstrates a need for.
