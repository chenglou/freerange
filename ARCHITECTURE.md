# Architecture

Freerange analyzes ordinary TypeScript without source annotations.

The first vertical slice is intentionally small:

```text
TypeScript source → TypeScript type checking → control-flow graph with SSA values → forward numeric analysis → report
```

`src/typescript.ts` creates a TypeScript program and rejects type errors. `src/ir.ts` owns the lowered representation. `src/lower.ts` uses TypeScript's type checker while converting supported expressions into that representation. `src/domain.ts` owns abstract values and arithmetic. `src/analyze.ts` evaluates the graph and generates operation obligations. `src/report.ts` exposes the stable report shape and formatting. `src/index.ts` orchestrates the pipeline.

Every function number parameter is assumed to be finite and not `NaN`. Explicit infinity support will be added separately rather than weakening the default.

The current lowering supports numeric constants, parameters, local constants, arithmetic, comparisons, conditional returns, local function calls, `Math.floor`, `Math.min`, `Math.max`, and simple object literals. Returned objects are summarized property by property. Property reads, mutation, general heap behavior, loops, modules, and inferred preconditions are intentionally unsupported in this stage.
