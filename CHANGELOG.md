# Changelog

## Unreleased

## 0.0.3 - 2026-07-28

- Analyze arrow functions and function expressions assigned directly to top-level `const` names.
- Preserve type narrowing through `&&` and `||` expressions.
- Analyze each `Math.random()` call as a fresh number from zero up to, but not including, one.
- Avoid quadratic work when tracking values through deep chains of same-file function calls.
- Consolidate analysis limits and practical refactoring examples in the README.

## 0.0.2 - 2026-07-21

- Add node support (#2)

## 0.0.1 - 2026-07-20

Initial public release of `@chenglou/freerange`.

### Added

- `fr` reports numeric errors such as definitely invalid function arguments, failed static assertions, division by zero, possible `NaN` or `Infinity`, and out-of-bounds array reads.
- `fr --audit` prints function requirements, return guarantees, assumptions, successful static assertions, analysis coverage, and concrete refactoring suggestions.
- Static analysis for a deliberately restricted TypeScript subset, including control flow, loops, same-file function calls, plain records, tagged unions, dense arrays, fixed tuples, and common `Math` and `Number` operations.
- Statically checked `console.assert` calls for declaring caller requirements and verifying numeric relationships inside functions.
- TypeScript project integration that respects the project's `tsconfig`, reports TypeScript errors in the familiar format, and supports project-wide or single-file output.
