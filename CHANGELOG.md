# Changelog

## Unreleased

- Stop trusting the initial value of a module `let` that top-level code assigns again, because the file's functions can run during module initialization and observe the earlier value.
- Print `assumes: other modules do not modify <name> or any object or array inside it` on functions whose results rest on a module-level object or array.
- Stop treating number fields declared only in a `.d.ts` file, such as those of library types, as finite after a function call, because the call never checks those fields.
- Report a later `console.assert` whose condition is outside the supported checks, e.g. `console.assert(label <= toolbarLeft - gap)`, as not checked instead of making the whole function unsupported. This applies to conditions built from variables, properties, array elements, literals, type assertions, `typeof`, ternaries, the `Number` checks, arithmetic, comparison, logical, and bitwise operators, and `instanceof` with a built-in or library class. Any other condition, e.g. one with a function call, an assignment, `++`, or `new`, still makes the function unsupported.

## 0.0.5 - 2026-09-03

- Allow leading `console.assert` calls to compare numeric inputs with `===`, `<`, `<=`, `>`, or `>=`.
- Preserve direct numeric comparisons through branches, same-file helper calls, and matching calculations, e.g. proving `left + offset <= right + offset` from `left <= right`.
- Analyze the object fields used by each file, including fields from library types such as `MouseEvent`.
- Support unary `+` and `%=`.

## 0.0.4 - 2026-07-31

- Allow `Date.now()` to represent dates before the Unix epoch.
- Support numeric phantom types (#6).
- Only recognize `Math`, `Number`, `Infinity`, parser functions, and browser globals when they resolve to TypeScript's standard libraries.

## 0.0.3 - 2026-07-28

- Analyze arrow functions and function expressions assigned directly to top-level `const` names.
- Preserve type narrowing through `&&` and `||` expressions.
- Analyze each `Math.random()` call as a fresh number from zero up to, but not including, one.
- Avoid quadratic work when tracking values through deep chains of same-file function calls (#3).
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
