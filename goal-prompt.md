# Goal Loop Template

Empirically, this prompt template has proven very effective at finding various correctness issues when we need to achieve a goal. The subagents with differing perspectives help a lot, as well as the other model's independent verification.

```text
Accomplish this task in a principled way.

Before working, read `AGENTS.md` and `engineering.md` in full. Require every subagent you spawn to read them too.

Before editing, turn every explicit requirement into one small concrete example with its exact observable result. Trace the relevant information through every place that creates, carries, combines, invalidates, or consumes it, and test each handoff that can change the result; a nearby example or a test that repeats the implementation's assumption does not count. Pair every required `unknown` or rejection with a positive control through the same path.

Treat performance requirements as behavior. Name whether the target is worst-case latency, throughput, or memory, choose a concrete workload before editing, and compare cold and warm runs separately. Do not accept a shortcut that makes inputs which avoid the work faster while leaving the expensive operation unchanged; improve the shared operation or narrow the requirement explicitly.

When two requirements use the same representation or consumer, test them together. When an operation is supported, repeat it at least twice to verify that support survives composition.

Before committing, give one fresh reviewer only the original task and frozen diff. Have it reconstruct the requirements, vary an assumption behind each example, and run counterexamples. Do not commit if a required result fails, disappears, gains unrelated diagnostics, or cannot be represented by the chosen design; fix it, narrow or reject the task, or revert.

Use fresh subagents before editing to independently explore important scope, representation, and verification risks. Then implement the smallest coherent behavior required by the task, with focused positive and negative tests. Prefer a clear rejection or `unknown` over ad-hoc support. Narrow, pivot, or revert if implementation shows that the task is worse than expected.

After implementation, freeze the diff and use fresh subagents to review correctness, architecture, consequences, and test gaps. Ask them to run concrete counterexamples. Fix required problems, but do not expand product scope merely because reviewers find nearby opportunities. Have one fresh reviewer inspect substantial review fixes.

Run the full verification suite and remove temporary or redundant code. Reread `engineering.md` against the finished diff and judge in hindsight whether the result is worthwhile; revert it if not. If it is worthwhile, commit it. Report deviations from the request, remaining gaps, and exact `DOCUMENTATION.md` changes without editing it.
```
