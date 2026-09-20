# Current decisions

This file records how the implementation behaves, which alternatives were rejected and why, measurements, and deferred work. `README.md` covers the commands, the supported TypeScript, the report terms, and the refactoring advice. Do not repeat it here.

## Working agreement

Warn the project owner before:

- a decision that can cause path explosion or state explosion, where the number of paths, states or calculations grows too fast to analyze. These involve branches, loops, numeric expressions, fixed points, or widening.
- a major change to the architecture or the file structure.
- a data-structure decision becomes difficult to reverse.

When a rule must hold in many places, shape the code so that one place enforces it and no other place can forget it. Examples: every numeric operation records which operation caused a possible NaN or overflow; every form of write to a module binding is found, so no function uses an outdated value; every place that builds an interval keeps the interval's invariant, e.g. that a possibly infinite value has that infinity as a bound (`src/domain/number.ts`). Reviews are a second check.

Soundness reviews target code that people actually write. Tell reviewers so, or the review goes to syntax that ordinary code does not contain.

- A bug that ordinary code can trigger gets a real fix, e.g. a value that can become NaN, or a function that sees an outdated module binding after an ordinary reassignment.
- A bug that needs contrived code, e.g. an `eval` string that reassigns a module binding, is still worth reporting. Respond by rejecting the construct or by treating the value as opaque (defined in the next section), as type assertions are, not by adding special handling.

Reject a data shape that makes programs harder to reason about and is not cheap to support: sparse array construction, because missing elements would complicate every element read; optional and rest tuple positions, so that no tuple has variable length. Accepting more code later is cheaper than maintaining support nobody has needed yet.

A condition about outside data that Freerange cannot inspect is printed as an `assumes:` line, not assumed without saying so.

## How is the accepted subset enforced?

`README.md` describes the accepted subset. In the code:

- Every supported construct has an explicit check; no default case accepts unknown syntax.
- `assertAccepted` (`src/lower/accept.ts`) rejects property writes and `var` before lowering. Everything else is checked during lowering, where the TypeScript information it needs is available.
- An unsupported construct rejects only its function.
- An unsupported top-level statement is skipped. For every module binding it could write, functions then see only the declared kind: what the declared type says, not the value (see "How should module initialization be modeled?").
- `UnsupportedReason` (`src/ir/program.ts`) lists every rejection and `formatUnsupportedReason` (`src/report/index.ts`) prints them. Together they define exactly where the subset ends.

An opaque value is a value that Freerange carries without knowing anything about it, not even whether it is a number, a boolean or an object. A path stops when Freerange cannot continue analyzing it; the function is then reported as `partially supported`. An operation that needs the kind of an opaque value stops the path that reaches it. In report lines, `<site>` is the source location of the operation, e.g. `layout.ts:12:18`.

### Where the checker's types may not match runtime values

Freerange's guarantees depend on the types the TypeScript checker reports, so the subset excludes code where those types may not match the runtime values.

- `any`-typed values are opaque, like `unknown` values.
  - `payload + 1` stops only its own path. Operations that do not depend on the kind still work: `===` between two opaque values gives a boolean that may be true or false.
  - A declared type recovers nothing: after `const hidden: any = true; const forced: number = hidden`, `forced` is opaque.
  - TypeScript lets `any` into every write position, module bindings included, so a result that depends on a module binding's declared type prints it, e.g. `assumes: debug is a boolean`.
  - `any` is carried, not rejected, so that surrounding numeric code stays analyzable, e.g. a function that only compares an `any`-typed `payload` with `===` is fully analyzed.
- Type assertions (`as` or angle brackets) produce an opaque value; only the paths that use it stop. No rule that compares the asserted type with the original is sound. Three were tried; each counterexample type-checked and crashed the engine with `Cannot join`:
  - Treating only `as unknown` and `as any` as opaque fails for `true as {} as number`.
  - Requiring the same top-level kind fails one level deeper: `flags as unknown[] as number[]`.
  - A recursive comparison failed where it skipped optional properties and on unions whose members have different kinds.

  The exception is `as const`: TypeScript permits it only on literals and it narrows a literal to its own literal type, so the kind cannot change.
- The non-null assertion `x!` is accepted where it keeps the value's kind, e.g. on a `number`, and rejected on a `number | null`. One kind-changing form is allowed: `array[index]!`, called an asserted read, which tells Freerange to treat the read as in bounds (a bare read is `array[index]` without `!`). On a provably empty array it stops the path. See "How are arrays represented?" and, for its `requires:` or `assumes:` line, "How are requirements derived and discharged?".
- `var` is rejected: a nested redeclaration writes a binding declared elsewhere (`var x = 1; { var x = 2 }` is one variable), and `let` and `const` express the same programs. A `var` name never becomes a module binding, so a function that reads one is rejected with `unknown identifier <name>`.
- Any mention of the identifier `eval` rejects the whole file: every function is unsupported and the analysis of module initialization stops. An `eval` string can rewrite bindings that every function's report depends on, so rejecting only the calling function is not enough. The scan is deliberately broad: every call form that reaches module scope, e.g. `(eval)(...)`, contains the identifier, so no call forms need recognizing. Known cost: a property named `eval`, e.g. `position.eval` in a chess engine, also rejects the file.
- The suppression directives `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck` are the other file-wide rejection: a directive can put a boolean in `let width: number` with no `any` involved, so the checker's types support no guarantee anywhere in the file. Detection follows the comment forms TypeScript itself recognizes, so a directive inside a string, or commented out as in `// // @ts-ignore`, does not count.
- Assignments used as values are rejected, e.g. `cond ? (x = 1) : 2` or `a = b = 5`; they are lowered only as their own statement or as a `for` incrementor. They are rare, and without them the branches of `?:`, `&&` and `||` cannot assign, so the join after such an expression carries one value and merges no bindings. Assigning a `let` in the branches of an `if`/`else` statement is fully supported: that is ordinary code, and loops need the same merging anyway.
- Type predicate and `asserts` signatures add no information, because TypeScript does not verify them. After `if (isBox(value))`, Freerange knows only what the body of `isBox` returned.
- The `in` operator is rejected. Width subtyping lets a value carry properties its union member does not declare, so `'title' in section` cannot soundly prove which member `section` is.

### Objects and records

Objects and arrays are immutable after construction; local and module `let` bindings may be reassigned. A callee therefore affects its caller only through its return value and reassignments of module `let` bindings. See "How are objects represented?" and "How are arrays represented?".

An optional property, e.g. `session?: boolean`, is possibly undefined. An object literal that omits it gets an explicit undefined, which keeps a join with a branch that sets it correct. A missing property and one set to `undefined` are deliberately not distinguished, because an ordinary read returns `undefined` for both; operations that distinguish them, e.g. `in`, are rejected. The model stays sound when the project disables `exactOptionalPropertyTypes`.

For objects from outside the analyzed code, Freerange assumes:

- no code modifies prototypes, no object defines custom coercion, and platform globals are unmodified.
- a property read has no side effects, runs no callback (e.g. a Proxy trap), and returns the same value each time during one analyzed synchronous call. Getter-backed properties fall under this.
- after a module finishes initializing, other modules do not modify a module-level object or array whose exact value functions see. The report prints this condition, and the array assumptions ("The plain-array line"), as `assumes:` lines.

`README.md` ("Objects, Arrays, and Changing State") gives the rules for records, including which number fields become `requires:` lines and which `assumes:` lines. The details:

- A record is classified by its resolved TypeScript type, not by how the type is written.
- A field is selected when some code in the file reads it, code in unsupported top-level functions included. Each type has one set of selected fields per file.
- When a value of one type flows into a position of another type, fields selected on the target type are also selected on the source type. Flows are followed through typed declarations, assignments, arguments and return values of same-file functions, arrays, tuples, and conditional expressions.
- A property read on a conditional or `??` expression selects the field on the type of the whole expression, not of each operand. In `(useFallback ? fallback : measured).x` with `fallback: {x: number; extra: number}` and `measured: {x: number}`, `x` is not selected on the type of `fallback`, and the read stops the path. This is why `README.md` says to name the chosen value first.
- Parentheses, `satisfies`, `as const`, and a non-null assertion that keeps the kind are looked through.
- Opaque: a selected field that cannot be classified; a record with no selected fields; a field nested past eight levels; a utility type that a declaration file defines as a mapped type, e.g. `Readonly<{gap: number}>`; a field whose type refers back to an enclosing type, e.g. `children` in `type Tree = {value: number; children: Tree[]}`.
- Rejected as parameter types: project types with index signatures or dynamic keys; callable or constructable objects that also have data fields; arrays nested past eight levels; untagged unions of object types, even when separately declared members have identical fields, e.g. `A | B` with `type A = {x: number}` and `type B = {x: number}`. Comparing members recursively would take about 100 lines for a case the subset can reject.

Numeric intersections are classified separately. A resolved intersection is numeric when exactly one member is number-like (TypeScript's `TypeFlags.NumberLike`, e.g. `number` or a numeric literal) and every other member is an object type; an additional primitive member keeps it outside the subset. The numeric member supplies the range and the other members add nothing: with `type Marker = {readonly __unit: 'px'}`, `(1 | 2) & Marker` is the integer range 1 through 2. Freerange trusts the type: it does not try to prove that the other members are phantom types, and does not compensate for casts or incorrect declarations. The value is carried as a number, so a property read, destructuring, call, index or construction through an ignored member is rejected or stops the path, e.g. `unsupported: property read from number & Marker`.

### The engine is total over accepted functions

Evaluation of an accepted function ends in a return value or a recorded stop, never in a thrown error. A `throw` inside the engine states an invariant that the acceptance check guarantees; reaching one is a bug in the check.

The check cannot guarantee one thing: TypeScript narrows types in more ways than Freerange models, and an opaque value has no known runtime kind, so an operation can receive a value whose kind Freerange cannot establish. The engine does not throw there; it stops the current path with `uses a value whose runtime kind the analysis cannot establish`, in two places: where `evaluateInstruction` evaluates an instruction and where `branchConditionOutcome` reads a branch condition. A bare array read that is still possibly undefined when an operation needs the element gets its own reason (see "Element reads") and its own audit suggestion, `[handle-missing-element]`.

## What does the analyzer know about the browser platform?

`src/lower/platform.ts` is the one catalog of what Freerange knows about the numbers that browser globals return. Freerange trusts the entries without checking them, as TypeScript trusts `lib.dom.d.ts`, and never runs a browser to measure values. A wrong range makes every result computed from it wrong, so each entry is a deliberate, written decision that records how browsers actually behave: no scroll-position entry is nonnegative, because Safari's elastic overscroll (rubber-banding) reports negative values at the edges. The current entries:

- `document.documentElement.clientWidth` and `clientHeight` are nonnegative integers.
- `window.innerWidth` and `window.innerHeight` are nonnegative and can be fractional under browser zoom.
- `window.scrollX`, `window.scrollY`, `document.body.scrollTop` and `document.body.scrollLeft` are finite, with no guarantee about the sign.
- `performance.now()` is nonnegative and fractional.
- `Date.now()` is an integer from `-8.64e15` through `8.64e15`.
- `Math.random()` is at least zero and less than one.

How entries apply:

- The same properties on any other element, e.g. `element.clientHeight` on an `HTMLElement` parameter, have no entry. They print an assumption like any `.d.ts` number field.
- Every evaluation of a matching read produces a new value within the recorded range. Platform state is mutable, so two reads of `clientWidth` are never assumed equal.
- An entry matches only when the root symbol has a declaration from TypeScript's standard libraries. A local variable with the same name, or a name declared only in a project `.d.ts` file, does not match. An entry still matches when other declarations augment the built-in, as Bun's types do for `performance`.
- Every current entry is number-valued. `T | null` APIs can be represented, but none has been added yet.
- Platform ranges combine with the rest of the analysis: a function that clamps `document.documentElement.clientWidth` gets a fully proven range such as 1 through 7.

## What is kept when only part of a function is supported?

Keep what was established before an unsupported operation, and mark the function partially supported. Partial information describes only completely analyzed paths and is never a postcondition of the whole function: given `let width = 100; unsupportedOperation(); width = 200`, the report may say `width` was `100` before the operation, never that the function ends with `width` equal to `100` or `200`.

Reports currently keep less than that: the return values of the paths that completed, and the requirements found along every evaluated path, including paths that later stopped. Both print under `on analyzed paths:`. The record of a stop holds only a location and a tagged reason, so printing the values known there (`width` being 100 above) is not implemented (see Deferred).

- Partial results use a separate type with no requires or ensures fields, so they cannot be printed or passed on as guarantees by accident.
- A partially supported function gives its caller nothing on a path that did not complete. The caller's path stops at the call with `calls <name>, which is only partially supported`. What the callee established before its stop appears only in its own `on analyzed paths:` lines.
- An unsupported construct found while lowering an ordinary function discards the partly lowered body: the function is `unsupported`, with no partial information.
- Module initialization is the exception: lowering skips an unsupported top-level statement and continues, because real top-level code mixes browser calls with the initialization of state. The report prints only the first skipped statement; the structured audit data keeps every location.
- Known limit of the report: each of two mutually recursive functions reports the other as a partially supported callee, without saying that the cause is mutual recursion.

When a number may be non-finite, the report distinguishes a possible NaN from a possible overflow without NaN, and records which operation caused each (`nanSite` and `nonFiniteSite` on the number value). Source locations, these two included, are annotations only: the engine never branches on one, and they are not compared when a loop checks for a fixed point.

## How should non-finite numbers be modeled?

`README.md` describes the rule for number inputs. In the code:

- The automatic finite requirement on a number parameter is lowered to the same numeric check and static requirement as a leading `console.assert(Number.isFinite(value))`, with no second inference pass. Writing that assertion therefore adds no second requirement, and a stronger one such as `Number.isInteger(value)` replaces the finite one.
- After a call completes, ordinary refinement knows that the argument value is finite.
- The input check is part of every lowered function. A partial report prints no `requires:` or `ensures:` lines, so it prints the input condition as `assumes: value is finite and not NaN`.

Numeric operations may still produce Infinity or NaN from finite inputs. The analysis carries that possibility forward instead of stopping, so that it can pass requirements to callers.

### Division and remainder

Both require a nonzero divisor. A value is nameable when it can be written as an expression over the function's parameters, constants, arithmetic, `Math.floor` and property paths.

- A nameable divisor prints a requirement, e.g. `requires: Math.floor(cols) is nonzero` for `width / Math.floor(cols)`.
- A divisor that is not nameable, e.g. a value joined from two branches, a module read, an element read, or a call result, prints `assumes: the divisor at <site> is nonzero`, and the analysis continues. If the assumption is false, the `ensures` lines that depend on it are not guaranteed.
- In both cases the operation is evaluated with zero removed from the divisor's range: `ensures` lines assume the `requires` lines. The project owner decided this. Ask the project owner before changing it.
- With zero removed, an integer divisor has magnitude at least 1, so the quotient is finite. A non-integer divisor can be arbitrarily close to zero, so the quotient may overflow but cannot be NaN. A remainder is bounded by its operands and cannot be NaN when the dividend is finite.
- Later operations on that path that use the same divisor value keep the nonzero information: `const ratio = a / b; return ratio + a / b` prints one `requires: b is nonzero`. Writing the divisor expression again, or assigning the divisor a new value, creates a new value and a new requirement: `a / (b + 1) + a / (b + 1)` prints `b is not -1` twice.
- Every division or remainder not otherwise proven creates a requirement, whether or not the bad result can reach the function's final result (see Deferred).

### Operands that may be infinite or NaN

- Addition and subtraction stay exact over operands that may be infinite but cannot be NaN, because the only NaN case is adding infinities of opposite sign. `(a + b) + c` with finite inputs is reported as possibly non-finite, never as NaN. `(a + b) - (a + b)` keeps the NaN possibility, because both sides can overflow to the same infinity.
- Multiplication and division lose all precision on possibly infinite operands, because more operand combinations produce NaN, e.g. `0 * Infinity` and `Infinity / Infinity`.
- `Math.min`, `Math.max`, `Math.abs`, `Math.floor`, `Math.ceil`, `Math.round` and `Math.trunc` keep their bounds over possibly infinite inputs: they have no rounding error, cannot overflow, and cannot create a NaN. `Math.max(0, Math.min(v * 2, 100))` ensures 0 through 100 even though the doubling can overflow.
- A clamp does not remove a possible NaN, because `Math.min(NaN, 100)` is NaN: the number's `mayBeNaN` flag stays set after `Math.min` or `Math.max`.

### Floats, not reals

Tests cover the IEEE double behavior that limits how far a requirement can be simplified. `tests/analyze-requirements.test.ts` asserts that `1e-300 / 1e300 === 0`, so a ratio of two positive numbers can underflow to zero, and that `1e-200 * 1e-200 === 0`, so a small constant factor cannot in general be removed from a requirement. `tests/audit.test.ts` shows the same underflow in a refactoring example: with `Number.MIN_VALUE` as the image width, `imageWidth / imageHeight` rounds to zero and the following division returns Infinity. Do not rearrange code that deliberately controls rounding.

## How are missing values modeled?

`null` and `undefined` share one model. A value is present (a number, a boolean, a record and so on), or missing (`{kind: 'nullish'}`), or possibly either (the `maybeNullish` wrapper). Every missing or possibly missing value records which it can be: `null`, `undefined`, or both. So:

- A report line names only the missing value that is possible: `animatedUntilTime is null or a finite non-NaN number`.
- Narrowing follows JavaScript. `x !== null` on a `number | undefined` value proves nothing about `undefined`, and its else branch is pruned as unreachable. `x == null` removes both missing values.
- `??` computes both outcomes exactly: `animatedUntilTime ?? now` is the number, or `now` when the left side is missing.

The purpose is to keep number ranges through code that uses a missing value for "no value yet". Prefer `number | null` to a sentinel number: `-1` for "unset" becomes part of the range and nothing checks that code treats it specially; `null` stays out of the range and TypeScript enforces every check.

Rejected: `??` whose sides have different kinds, e.g. a `number | null` left side with a boolean right side, and a union with more than one non-missing kind, e.g. `number | boolean`.

## How are arrays represented?

As TypeScript types them: as tuples or as arrays.

### Tuples and arrays

A tuple type (`[4, 8, 24] as const`, or `[number, number]`) has one abstract value per written position. A read at a constant index returns that position's value exactly and is in bounds.

Every position must be required. An optional position (`[number, number?]`) or a rest position (`[number, ...number[]]`) makes the runtime length a range, and Freerange rejects the type instead of modeling a range of lengths. The project owner decided this, because accepting more later is cheap. TypeScript records such positions in the tuple type's element flags; the type arguments do not show them. The effect depends on where the type appears:

- Parameter: the function is `unsupported`. The message names the rewrite: `number[]`, or a fixed tuple like `[number, number]`.
- Record property: opaque. The rest of the record is still analyzed.
- Module binding: not tracked. Reading it stops the path.

An array type keeps one abstract value for all elements (their join) and an interval for the length. Nothing is known about one particular index. A tuple joined with a tuple of a different length or with an array becomes an array and never turns back into a tuple.

### Element reads

A bare read (`arr[i]`) is possibly `undefined`, whatever the project's `noUncheckedIndexedAccess` setting is. `arr[i] ?? 0` prints no `requires:` or `assumes:` line about bounds; only the plain-array line and the lines about elements (both below) print. A possibly missing element that reaches an operation needing a present value, e.g. arithmetic or a property access, stops the path with `uses a possibly missing array element without handling undefined`, even in projects where TypeScript types the element as present.

An asserted read (`arr[i]!`) treats the element as present. A read not proven in bounds prints a `requires:` or `assumes:` line (see "Asserted element reads"), recorded where the engine evaluates the read and copied to the caller like any other requirement. `for...of` desugars to a counter loop whose element read is always in bounds. The loop body over an empty array is pruned as unreachable.

### The plain-array line

Freerange assumes two things, unchecked, about an array that a caller controls:

1. Each `length` read is the real element count. The length starts as an integer from 0 through 2^32 - 1.
2. A read that is in range (a bare read with a proven bound, or an asserted read) finds an element of the declared element type, so that read is never `undefined`.

The lines about elements, e.g. `every grid[each] element is finite and not NaN`, state neither: they describe only the elements the array actually holds (opaque elements, e.g. of a `string[][]`, print no such line). A Proxy that reports length 10 while holding 3 rows breaks none of them, and neither do `[1, , 3]` or `new Array(5)`, valid `number[]` values with missing elements. With only those lines, a type-correct caller could make a printed `ensures` line false.

So each array prints both assumptions, one line per nesting level, e.g. `assumes: values is a plain array — its length counts its elements, and every index below the length holds an element`. A wrong length breaks the first clause. A hole breaks the second, as does an inner row that is missing because the outer length was wrong (it breaks the outer level's second clause). The printed line is what permits assumption 2.

Variants of the line:

- Combined, in one case only: when a non-nullable record has three or more selected array fields that are direct properties and themselves non-nullable, those fields print as one line: `every array field of prepared used in this file holds a plain array — ...`. Only those fields' own lines are replaced, because the combined line must state exactly what they stated: nested element levels, arrays behind a nullable record, nullable roots, tuples, and nullable array fields still print one line per level.
- Nullable array field. The line names the one missing value the field declares: `overrides is null or overrides is a plain array — ...` for `overrides: number[] | null`, and `is undefined or` for `overrides?: number[]`. The engine starts the field with only that missing value and prunes a branch that tests for the other, so a line that allowed both would let a caller falsify a printed `ensures` line while every `assumes` line held. Ordinary data does this: a value from JSON can hold `null` in an optional field.
- Declared tuple. A count sentence replaces the plain-array line: `pair is a plain array of exactly 2 elements — ...` for `[number, number]`, followed by the same two clauses. The count matters because strict TypeScript allows `pair.push(3)` on such a value. Tuples never join the combined line, which cannot state a different count for each field. Tuple positions keep their own number lines (`pair[0] is finite and not NaN`), or fall under the combined number line ("What functions see for every other binding").

## How should module initialization be modeled?

Lower each file's top-level runtime code into a synthetic initializer function, and evaluate it with the evaluator that ordinary functions use. With runtime cycles and asynchronous initialization excluded, top-level code is ordinary calls, branches, loops, and handling of unsupported code, so this avoids a separate module interpreter and a second copy of the semantics.

- Function declarations run only when top-level code calls them.
- A function assigned directly to a top-level `const` becomes callable when execution reaches its declaration. Creating it does not run its body.
- A slot holds the engine's current value for one module binding. It is uninitialized or holds a value, so a read before the binding's declaration stops the path.

Freerange does not build or execute a runtime module-dependency graph. Runtime import cycles and top-level `await` are not modeled, and no check rejects cycles across the project: every imported module is assumed to finish initializing before analyzed code reads its runtime values. Type-only import cycles do not matter.

### Which bindings give functions their exact value

One rule covers `const` and `let`: use a binding's value only when no write can happen between initialization and the function's call.

The file's own functions can run during initialization, e.g. through a top-level call, a callback that a skipped statement runs (`[0].forEach(render)`), a getter or setter, or object spread. So a binding qualifies only when its declaration is its only write:

- Every `const`. Values are immutable after construction, so analyzed code cannot change a `const` record's property values either.
- Every `let` that nothing else assigns, in function bodies or in top-level code.

A read before the declaration throws (the temporal dead zone) and the value never changes afterward, so every successful read, including one during initialization, sees the same value. A bundler that rewrites a top-level `let` to `var` removes the temporal dead zone and is outside this model.

`scanModuleBindings` in `src/lower/module.ts` checks the rule. It scans the entire file, top-level code and the bodies of rejected functions included, for assignments, `++` and `--`, and the targets of `for...of` and `for...in`. Every identifier inside an assignment target counts as written, destructuring patterns included, because a missed write would give functions an outdated value. Reassignments of globals are not scanned: global objects like `Math` are assumed unmodified.

For a qualifying binding, functions see the exact value, nested records included (`publishedModuleValues` in `src/engine/analyze.ts`): `const gridSize = {cols: 8, rows: 6}` reads as exactly that record in every function. A binding that holds an object or array qualifies only in a file with no function that could not be lowered and no skipped top-level statement; otherwise functions see only its declared kind, nullable bindings such as `number[] | null` included. The reason: unanalyzed code can modify an object or array through an alias that the scan for writes cannot see, e.g. `Object.assign(config, ...)` has the binding as an argument, and `queue?.push(x)` has it as the receiver. Whether a binding holds an object or array is decided from the value that initialization built, not from the declared type: a binding typed through a declaration-file mapped type, e.g. `Readonly<{gap: number}>`, is classified as opaque but holds a record.

Another module that holds a reference can still modify such an object or array after initialization, e.g. an importer that runs `gridSize.cols = 100`. So every function that reads one, directly or through a same-file call, prints `assumes: other modules do not modify gridSize or any object or array inside it`.

- The line prints whether or not the binding is exported: references also leave through export specifiers, returned values, and records that contain the object, and values have no identity by which to track them.
- `readonly` and `as const` do not remove the line (`README.md`, "Objects, Arrays, and Changing State", says why).
- The rejected alternative is never to give functions the exact value of an object or array. That needs no `assumes` line, but plain records like `gridSize` would lose their exact values. On [Pretext](https://github.com/chenglou/pretext), a public text layout library, the report was the same under both choices. Pretext results in this file are observations and cannot be reproduced from this repository.

### What functions see for every other binding

Only its declared kind: some finite number, some boolean, or a record with its selected fields. A finite numeric literal type keeps its interval: `1 | 2` is an integer from 1 through 2, and `1 | 10` is conservatively the integer interval 1 through 10, not an exact set.

A declared type is classified the same recursive way as a parameter type: numbers, booleans, records, tuples, arrays, nullable wrappers, tagged unions, optional properties as possibly `undefined`, and opaque for the rest. Only a binding whose whole type cannot be classified stays uninitialized. So does an imported binding, because Freerange does not analyze the other module. The exception: an import that resolves to `export const NAME = <numeric literal>` in a project file reads as that exact constant.

The declared kind is an assumption, not a guarantee: a type-checked write of an `any`-typed value can put a non-boolean in a boolean binding. The report therefore prints a line for every read that relies on a declared kind: `assumes: scaleFactor is finite and not NaN`, `assumes: debug is a boolean`, and one line per selected leaf of a record, e.g. `assumes: pointer.x is finite and not NaN`. A leaf is a number, boolean or other non-record value at the end of a property path. The line appears on every function whose result depends on it, callers included.

A value with three or more selected plain number leaves prints one combined line, e.g. `assumes: every number field of camera used in this file is finite and not NaN` for a reassigned `camera` record whose `x`, `y` and `zoom` are used. The number elements of an array count as one leaf, so the combined line can also replace a line such as `every prepared.widths element is finite and not NaN`. It requires every field it names to hold a finite number, so a non-number or a missing property written through an `any`-typed value still breaks it. Never combined:

- A record with a literal-interval leaf keeps all its separate lines, so the general sentence does not hide the narrower condition.
- Nullable, tagged-union and boolean leaves keep their own exact lines.
- A value with one or two number leaves keeps its own lines.

A `let` that top-level code assigns again also gives functions only its declared kind, because a call during initialization can see an earlier value than the final one (`README.md`, "Functions see a reassigned module `let` only as its declared type", has the example). Known cost: the rule is conservative for a binding whose every assignment happens before any call, e.g. `let gutter = 8; gutter = gutter * 2`. Two finer rules were rejected: using the values written before the first call, and joining the values that each call sees. Both need the complete list of places where initialization runs the file's functions: the ways listed under "Which bindings give functions their exact value", plus records that store the function. Pretext has no binding that the simpler rule makes less precise.

`eval` needs no handling here: a file that mentions it is rejected as a whole.

### Skipped top-level statements

A skipped statement is a top-level statement that cannot be lowered. A qualifying scalar binding keeps its exact value even when statements were skipped (a binding that holds an object or array does not; see above)(a binding that holds an object or array does not; see above and the last reset rule below). The project owner decided this. Ask the project owner before changing it. Two things make it sound.

The first is how writes are handled. For every binding a skipped statement could write, functions see only the declared kind: `demoteModuleWritesInNode` finds the statement's own declarators and assignment targets, and the whole-file scan finds every other write. Changing what functions see is not enough: the initializer's own evaluation would still hold the value from before the skip, and a later analyzed `const doubled = scale * 2` would give functions a wrong `doubled`. So each skip also resets slots. A reset replaces the slot's value with the widest value of the declared kind (`coveringKindValue`), NaN and Infinity included, and prints no `assumes` line. A scalar binding holds a value that is not a record, tuple or array, e.g. a number, a boolean or a `number | null`.

- Every binding that the skipped statement writes directly is reset.
- A skipped statement that can run unknown code (it contains a call, a constructor, an iterator, a computed class or method name, or a similar form) also resets every scalar binding that has a write besides its declaration, because unknown code can reach the file's functions and their writes. This is conservative for a scalar that only top-level code assigns again.
- Creating an arrow function, a function expression or an ordinary object method does not run its body, so it resets no unrelated scalar.
- Every slot whose value holds a record, tuple or array is reset after every skip, to an opaque value, for the alias reason above. The check looks at the value: a record typed through `Readonly<T>` is reset too, while a string constant keeps its content. A later top-level read of a field of a reset record stops the initializer, so later declarations give functions only their declared kind.

The second is control flow. If a skipped statement throws or never returns at runtime, the module never finishes loading, no exported function can be called, and everything the report states about them is vacuously true. Nothing else about a skipped statement's control flow matters, because the rules above already cover everything it can write.

The initializer can also stop during analysis, e.g. at a top-level call into a function that reaches unsupported code. A stop is a path end that records the slots as they are. Writes after a stop need no rule, because a qualifying binding has no write besides its declaration.

The analysis runs in this order:

1. The initializer runs. Every slot starts uninitialized, except imported numeric-literal constants.
2. `joinModuleSlots` joins the slots at all path ends, stops included. A binding that is uninitialized at any path end, e.g. because the analysis never reached its declaration, gives functions only its declared kind.
3. `seedModuleSlots` starts each function's slots as the exact value, as the declared kind (with the `assumes:` lines above), or as uninitialized (the imports and unclassifiable bindings above). Reading an uninitialized slot stops the path, and the report says whether the binding is imported, not tracked, or not yet initialized.

A loop whose exit is never taken on any analyzed path, e.g. `for (let index = 0; true; index += 1) {}`, ends the initializer with a stop on the loop instead of a crash. Functions still see the exact values of bindings written before the loop.

## How should callback ordering be modeled?

Do not model it for now. A named top-level handler is analyzed as an ordinary function, from its explicit parameters and the module-binding assumptions above. Same-file calls inside it are evaluated again at each call site. Freerange has no function summaries and no model of callback sequences: registering a callback neither chooses an execution order nor executes the callback later.

Module initialization can be analyzed because its runtime order is defined. A handler or an exported function runs at arbitrary times afterward, so it must not assume that a module binding still has its initial value.

This keeps general functions such as `render(state)` useful without knowing which events created `state`, and avoids exploring many callback sequences. A bounded, user-chosen sequence of callbacks is under Deferred; reconsider it if a concrete report needs to show that a state is reachable.

## How should the scope of purity analysis be chosen?

No purity analysis exists in `src/` today. An earlier version of Freerange, from before 0.0.1 and not in this repository, had one.

- Its rules are an upper bound, not a feature list: do not add a purity feature it lacked, and treat one it had only as a candidate. The analysis has changed a lot since, so possibly none applies.
- The project owner has those rules. Ask for them, and ask before adding any purity feature.
- The project owner accepts a smaller subset than the earlier one. Prefer the smallest subset the current analysis needs.
- Do not port the earlier purity code before purity becomes the active task.

## How are omitted arguments modeled?

A same-file call may omit an optional parameter, or a parameter with a supported literal default.

- An omitted optional parameter receives exactly `undefined`.
- A literal default is used when the argument is omitted or may be `undefined`. `null` is an ordinary argument and does not select the default.
- The check at the parameter declaration and the lowering of the call parse the default with the same function (`parameterDefaultLiteral` in `src/lower/literals.ts`). It reads the literal's runtime value, so a cast cannot make a boolean pass as a numeric default.
- Defaults that are objects, calculated values, or non-finite numbers are rejected.

This reuses the ordinary control flow for missing values and needs nothing new in the evaluator.

## How are requirements derived and discharged?

A requirement is created at the operation that needs it, simplified only where the simpler condition is exactly equivalent for floats, and discharged (proven) only by the ordinary forward analysis, never by a solver. A discharged requirement is not printed and not passed to the caller.

A division, a remainder, or an asserted element read (`arr[i]!`) first checks its condition. A definitely false condition is an error at the operation, including through a same-file call, e.g. passing `width = 4` to a function that divides by `width - 4`. Otherwise the operation records a requirement, which can be written only for a nameable value (defined under "How should non-finite numbers be modeled?"). Nothing works backward through the surrounding arithmetic.

### Simplifying a nonzero requirement

`peelNonzero` in `src/requirements/infer.ts` has three rules, each equivalent for every float, not approximately equal (`c` is a finite constant):

- `X - c is nonzero` becomes `X is not c`: `total / (width - 4)` requires `width is not 4`. Because of gradual underflow, IEEE subtraction gives zero exactly when the operands are equal.
- `X + c is nonzero` becomes `X is not -c`, for the same reason.
- `c * X is nonzero` becomes `X is nonzero` when the magnitude of `c` is at least 1, because such a factor cannot underflow a nonzero product to zero: `total / (scale * 2)` requires `scale is nonzero`. Simplification continues on `X`.

Two forms are not simplified, because a small factor can underflow (`1e-200 * 1e-200 === 0`):

- `total / (x * 1e-300)` requires `(x * 1e-300) is nonzero`.
- A division is never removed: `total / (x / 2)` requires `(x / 2) is nonzero`.

Tests check these equivalences over subnormals, boundary values, and random bit patterns (`tests/analyze-requirements.test.ts`). Every step shrinks the expression, so simplification needs no limit.

A condition over two unknowns prints as written: `total / (a + b)` requires `(a + b) is nonzero`, never "a is not -b". The project owner confirmed this limit: solving such conditions made an earlier version of Freerange, from before 0.0.1 and not in this repository, too expensive.

### What discharges a requirement

There is no general implication checking. A proof has four possible sources:

- evaluation, e.g. a constant argument makes a divisor provably nonzero,
- interval narrowing from a guard,
- the one excluded value that an interval cannot express,
- a direct order recorded by a guard or an earlier requirement: a recorded comparison between two specific immutable runtime values, e.g. `minimum <= maximum`. Given a `clamp` that starts with `console.assert(minimum <= maximum)` (see "How does console.assert work?"), `if (minimum > maximum) return; clamp(minimum, value, maximum)` discharges that requirement without transitivity or algebraic solving.

A direct order is kept at a join only when every incoming path has it, and across a completed same-file call. It is not transferred onto a value chosen by a branch or replaced by a loop.

Excluded values:

- `count > 0` moves the float bound to the next representable double.
- `count !== 0`, `width !== 4`, or the matching `===` early exit excludes one value strictly inside the bounds.
- A number remembers at most one excluded value, and a second one inside the bounds replaces the first. This loses precision but never makes a result stronger (`README.md` has an example).
- Division uses an excluded zero. It is also stored separately, as the nonzero condition (the first kind of condition under "Additional decisions"), so a later exclusion does not lose it.
- Every refinement normalizes the representation: when later bounds move the excluded value to an endpoint, the endpoint moves past it. Guard order therefore does not change the result.
- Joins and widening keep an excluded value only when every incoming path excludes it, like the conditions under "Additional decisions".
- The three simplification rules also run forward, for the same float reasons, so that the guard named by a simplified `requires` line discharges it, e.g. `width !== 4` makes `width - 4` exclude zero.
- A value that may be NaN takes the not-equal branch, because `NaN !== c` is true. The not-equal refinement never clears `mayBeNaN` and never prunes a branch a NaN value can reach.

### Asserted element reads

`data[i]!` creates `requires: i is a valid data index`, meaning an integer from 0 through `data.length - 1`, when the array and the index are both nameable. Otherwise it prints `assumes: the element read at <site> is in bounds`. Three proofs discharge it:

- a `for...of` counter,
- an index interval that fits the array's length, e.g. a constant index into a tuple,
- the recorded relation `i < arr.length` for that exact array value, plus an index interval that proves an integer of at least 0.

The relation `i < arr.length` has no transitivity and no arithmetic. Until a read records its requirement or assumption, the integer and at-least-0 proofs come from the index's own interval. `Number.isInteger(index) && index >= 0 && index < values.length` proves the whole condition. A range check alone on an index not known to be an integer, e.g. `if (i < data.length)`, keeps the requirement.

After an unproven read records its requirement or assumption, later reads of the same array value at the same index value reuse the complete condition, on that path and through a completed same-file call. Separately written index expressions, e.g. the literal `0` twice, are separate values and each records its own requirement.

An index range with no valid index is rejected as provably outside the array, e.g. exactly `1.5`, `Infinity`, or `5.5..6.5` for a six-element tuple.

Separate reads of a module binding are separate values, so a relation recorded for one does not apply to the next. Copy a module array to a local first: `const t = table`, then check and read `t`.

### Path-insensitivity and the expansion limit

Requirements are path-insensitive by design. The project owner confirmed this. `if (flag) return a / b` requires `b is nonzero` unconditionally. Requiring more than necessary is sound: a caller that satisfies every `requires` line makes every `ensures` line hold. Conditional requirements would multiply the number of alternatives, which this project avoids.

Writing a divisor as an expression follows the instructions that computed it. They form a tree, and a value used twice can duplicate a subtree, so the walk makes at most as many instruction expansions as the function has instructions. At the limit the operation prints its `assumes:` line, as if the value were not nameable, so a printed requirement cannot grow without bound.

## How does console.assert work?

A call is an assertion only when TypeScript resolves `console` to the global `console` of the configured environment, not to a local or imported value of that name. The runtime call stays ordinary JavaScript. Freerange adds only a static meaning.

### Leading assertions

Leading assertions are the `console.assert` calls at the start of a function, before any other statement. They lower into the same requirements that division and array reads use.

- `===`, `<`, `<=`, `>`, and `>=` may compare two parameters or fixed-record properties. A fixed record is an object type with a fixed set of named properties, e.g. `{width: number; height: number}`, and not an array, a tuple, a tagged union or a nullable type.
- `!==` needs one fixed number, because the state keeps no general "these two values differ" relation.
- `Number.isInteger` and `Number.isFinite` may be required of a parameter or a fixed-record property.
- A fixed number is a literal, or an immutable constant from the same project whose initializer chain ends in a numeric literal. Arithmetic (`2 + 3`) and reassigned bindings are rejected.
- A requirement between constants, e.g. `console.assert(6 > 5)`, is decided immediately: true adds nothing, false is an error.

### Later assertions

Every assertion after the leading ones is a later assertion. It only reports a result: `proves:`, `assertion can fail:`, `assertion unproven:`, or `unreachable assertion:`. It never narrows later statements and never stops evaluation, so one failed assertion cannot hide later results.

A function that contains an assertion must finish analysis on every path and must not need an `assumes:` line about one operation (`assumes: the element read at <site> is in bounds` or `assumes: the divisor at <site> is nonzero`). Otherwise an assertion that would have been proven or unreachable is reported as `assertion blocked: the function did not finish analysis without site-specific assumptions`, even when it comes before the stop or the assumption. A condition already known to fail or to be unproven keeps that more specific result. The rule is deliberately simple ("Assertions in partially analyzed functions" under Maybe Reconsider describes the finer rule that was tried).

### Accepted conditions

A syntax check on the condition runs before ordinary expression lowering. An accepted condition is then lowered like any other expression, so it follows JavaScript's evaluation order. During lowering, `removableStaticConditionInstruction` allows only constants, module reads, property and length reads, platform values, comparisons, and numeric checks. The set is small for two reasons:

- The condition cannot contain an operation that creates a requirement. `console.assert(total / count > 0)` is rejected: the division would add `requires: count is nonzero`, and the assertion would then be proven with the help of a requirement that the assertion itself created.
- Removing the assertion from a production build cannot change the program's behavior.

### Proofs

An assertion comparison may use a proof that looks at how each compared value was computed. Ordinary branches, and the requirements from divisions and element reads, do not. A requirement from a leading assertion uses the proof when a call is checked. That check runs inside the callee: it sees the direct orders recorded on the caller's argument values, but not how the caller computed them. After `if (a > b) return`, `clamp(a, value, b)` proves `minimum <= maximum`. `clamp(a + c, value, b + c)` does not, and the caller gets `requires: (a + c) <= (b + c)`.

Ordinary analysis and assertion proofs share one definition of "the same value" (`canonicalValueIdentity`): aliases; repeated reads of the same property, and element reads of the same array value at the same index value; fields read back from a record literal built in the function; lengths; one argument passed twice through a supported same-file call. Separate evaluations are different values, e.g. two reads of a reassigned module binding or two `performance.now()` calls.

Guards and leading assertions may also record direct orders between such values. Numeric equality between two inputs is stored as both non-strict orders (`a <= b` and `b <= a`). It proves equality only where the order rules prove both directions, and does not substitute one input for the other: from `a === b`, `a - c === b - c` is proven and `a * a === b * b` is not.

The proof rules, none of which applies when a value may be NaN:

- Two direct orders apply to corresponding operands of an addition or subtraction: from `left <= right` and `lowerOffset <= upperOffset`, `left - upperOffset <= right - lowerOffset`.
- The same addition or subtraction on both sides weakens a strict order to a non-strict one, because rounding can make distinct inputs equal: from `a < b`, `a + c <= b + c` is proven and `a + c < b + c` is not.
- Subtracting two strictly ordered representable values gives a strictly signed result: from `a < b`, `b - a > 0`.
- `Math.min` and `Math.max` results are ordered against their operands and against each other. Two `Math.min` results with the same number of operands are also compared operand by operand, in written order: from `a <= c` and `b <= d`, `Math.min(a, b) <= Math.min(c, d)`.
- Adding or subtracting a nonnegative number moves a value in the known direction: with `w >= 0`, `a + w >= a` and `a - w <= a`.
- Multiplying both sides by the same nonnegative value keeps the order, and by a nonpositive value reverses it. Dividing by the same positive value keeps it, and by a negative value reverses it.
- A remainder is below its positive divisor.

The rules apply through intermediate `const` values, e.g. `const low = Math.min(a, b); console.assert(low <= a)`. They need no proof-depth limit: the graph of instructions that computed the values is finite and fixed, each rule moves from a value to its operands, which are earlier values, and each pair of values is memoized before its operands are expanded.

Floating-point boundary tests cover infinities, subnormals, signed zero, the 2^53 rounding boundary, overflow multiplied by zero, signed multiplication and division, and positive remainder (`tests/analyze-static-assertions.test.ts`).

### Deliberately left out

- General transitivity: `left <= middle` and `middle <= right` do not prove `left <= right`.
- Expanding `Math.min` and `Math.max` operands on both sides of a comparison. `Math.max(...left) <= Math.min(...right)` would need every pairing of the two operand lists, which is unbounded, so it stays unproven.
- Narrowing after a proven assertion, and summarizing boolean helper functions (both under Maybe Reconsider).
- Reporting relationships between a return value and its arguments.
- Bitwise support and callback modeling.

Results that follow from using one value twice, e.g. `x - x` is exactly 0 and `x <= x` is true, come from the ordinary analysis, so they also hold outside assertions.

## How are objects represented?

An object is a plain structural value: a record that holds its property values directly and nothing else. Values are immutable after construction, so a record keeps exactly the property values it was built with across any control flow: a loop that rebuilds state each iteration, a helper called again, or a join. Immutability makes object identity unobservable, so there is no abstract heap, no allocation identity, and no aliasing question.

Records join property by property, by name, keeping only the names present on both sides. Width subtyping lets records with different properties reach the same join: given `const wide = {x: 2, y: 3}` and a binding `box` of type `{x: number}`, reassigning `box = wide` on one branch joins a two-property record with a one-property record. Keeping the union of names would let the report state something about a property that is sometimes absent. `flag ? {x: 1} : {x: 2, y: 3}` does not reach this join: TypeScript infers an untagged structural union for it, which is rejected.

Widening recurses into record properties, because the numbers inside a record are what can grow without bound. A loop that carries `metrics = {height: metrics.height + 1}` widens `height` at the loop header exactly like a scalar.

Known cost: two separately constructed records with equal property values cannot be told apart, so "definitely different objects" cannot be stated. Nothing observes object identity today, because `===` on objects is rejected. If object comparison enters the subset, revisit the representation.

## How should analysis work scale?

Freerange does not promise the running time of one JavaScript execution, which sees concrete inputs and takes one branch at a time: it analyzes every supported top-level function, follows both sides of an unknown branch, and summarizes loops, and type classification and proof checking have no runtime counterpart.

Graph-based analysis should not visit the same graph node repeatedly during one traversal:

- A block runs again only when its incoming abstract state changes.
- Requirement expansion makes at most as many instruction expansions as the function has instructions.
- Assertion proofs memoize each pair of immutable values.
- Recursive type classification stores one answer per input in four memo tables: `declaredKind` and `valueKind` (interned type plus depth), `nonMissingUnionMembers` (interned union type), `taggedUnionProperty` (stable member array plus depth). Types are first seen while lowering expressions, so each table is the only place its result is computed, not a copy of another result.

These tables use cheap stable keys: value IDs and TypeScript's interned type objects. They are bounded by the source or the TypeScript type graph they traverse. `engineering.md` allows this kind of cache: checker types are immutable for the life of the program, each table holds at most one entry per distinct input, and no invalidation is needed.

Ordinary same-file calls use the evaluator's call stack and are not cached, so a call tree that branches exponentially can take exponential time in both JavaScript and Freerange. Making the application's algorithm faster is not a requirement on the analysis. If code repeats one expensive pure call with the same arguments, storing the result in a local improves both the runtime and the analysis. A future call cache must meet four conditions (see "Same-file call-result caching" under Maybe Reconsider):

- Real code needs it and cannot be fixed by storing the result in a local.
- The cache key is cheaper than the evaluation it skips.
- The cache stays bounded when lookups miss.
- It keeps every diagnostic and caller requirement.

## How should loops be analyzed?

Loops use fixed-point analysis with widening, not unrolling, recurrence analysis, or collection summaries.

The convergence limit counts updates to the abstract state of one loop header, not runtime iterations. Widening makes an ordinary counting loop converge in two or three updates, however many times it runs. Ordinary loop-carried records widen property by property. The 16-update limit (`maximumLoopHeaderUpdates`) guarantees termination when the structure grows on every update, e.g. when each iteration stores the previous record inside an `unknown` field. The report then prints `the loop at <site> did not converge after 16 updates`. Known limitation: a chain of more than 16 loop-carried variables, each copied from the previous one, also reaches the limit although it would eventually stabilize, and Freerange stops there.

When a path inside a loop stops at a place from which execution could have continued to the next iteration, the loop header cannot reach its fixed point. A stop on a path that leaves the loop, e.g. `return payload + 1` inside the body with an `any`-typed `payload`, does not have this effect. A stop can also first appear on a late widening round, after earlier rounds have already passed return values downstream. Returns reachable from such a header are therefore not reported, not even under `on analyzed paths:`. Returns before the loop, or on paths that bypass it, are still reported. This deliberately also drops the result of the path where the loop body runs zero times, even when the stop existed from the first round.

## How are results reported?

Choosing a file only filters the final report. It is never an input to the analysis, so `fr [file]` prints the same lines for that file as a project run. `fr` and `fr --audit` stop on TypeScript errors before any analysis: a project run checks the whole project, a file run checks that file. `fr` exits with a failure on error-level findings, so CI can run it. `fr --audit` is informational and fails only on TypeScript errors.

### Which `assumes` and `requires` lines print

The `assumes` block lists only the inputs the function actually uses. A property path the body never reads produces no value, so no `ensures` line depends on it and nothing is printed for it. A function that only switches on `section.type` prints nothing about the arrays and numbers of the union members.

Only lines that no result depends on are left out: a function that reads `values[index]` still prints the plain-array line, which a sparse array breaks. If unused lines were printed, a caller that passed a sparse array in an unread position would break a printed line for no reason, and the contract would no longer apply to that caller.

- A combined line, e.g. `every number field of <path> used in this file is finite and not NaN`, prints only when the function reads every position the sentence covers. Otherwise it would state an assumption about unread positions, so the read positions print one line per property instead.
- Only property reads are followed this way. An element read or a `length` read counts as reading the whole array or tuple, so its lines about elements and the combined line still print.
- Module bindings are filtered as a whole, after the fields of their records are selected across the file. A function that reads the binding keeps every selected line. A binding the function does not read contributes nothing.

`requires:` lines deliberately differ:

- The automatic `requires: Number.isFinite(<param>)` line applies to a plain numeric parameter whether it is read or not (`README.md`, "Caller Requirements").
- A numeric field of a fixed-record type gets the requirement only when the field is selected (see "How is the accepted subset enforced?"). A field read only after the object has passed through a call, a return or an assignment is still selected on the original type. Passing an object along without reading its fields selects nothing.
- The `requires:` form of the combined line, `every number field of <param> used in this file is finite`, does not depend on what the function reads: it covers every field selected anywhere in the file.

### Audit suggestions

Audit suggestions are chosen from structured requirements, assumptions, stops, and lowering reasons. When syntax alone cannot determine a rewrite that keeps the program's behavior, the audit gives no recommendation. Every snippet shown in a suggestion (`refactorGuides` in `src/audit.ts`) is analyzed in the test suite. Examples that may change behavior also have runtime tests for the stated difference (`tests/audit.test.ts`).

## Additional decisions

- Four kinds of condition can stay attached to a value (`ValueFact` in `src/engine/state.ts`): the value is nonzero; a direct order between two values, e.g. `minimum <= maximum`; an index is below one array's length; an index is a valid index of one array. A join keeps only the conditions present on every incoming path. A completed same-file call keeps them. There is no implication search and no transitivity.
- Each CFG block keeps one merged abstract state, not one state per path. Block parameters carry values across branches and loops.
- Branch narrowing handles only these condition forms and goes no deeper:
  - A single comparison narrows its two direct operands and may record their direct order.
  - A single null check narrows the checked value. On a property read, e.g. `if (box.width !== null)`, it narrows the property inside the record, which is sound because values are immutable.
  - Nothing works backward through arithmetic: `x * 2 > 4` does not narrow `x`.
  - Compound conditions need nothing deeper, because lowering splits them. In statement position, `&&`, `||` and `!` become short-circuit control flow, so `if (x !== null && x > 0)` is the same CFG as two nested `if` statements. The condition of `?:` is split the same way: `a > 0 && b > 0 ? a / b : 0` narrows `a` and `b`.
  - A single comparison stored in a boolean narrows. In `const ok = count > 0; if (ok)`, the branch condition resolves to the comparison instruction that computed `ok`, so the guard discharges a divisor requirement as `if (count > 0)` does.
  - A stored compound condition does not narrow: in `const ok = a > 0 && b > 0; ok ? a / b : 0`, `ok` is a join of two branches, not a comparison.
  - The project owner is wary of anything deeper. Ask the project owner before adding it. Both soundness bugs found so far in branch narrowing were here: a branch was pruned, and a false branch was narrowed, although an operand could be NaN.
- Reaching a limit must make a result less precise or stop the path, never make a result stronger.
  - A loop header that runs out of updates records a stop (see "How should loops be analyzed?"). A state that is not a fixed point is never reported as one.
  - Type walks stop at depth 8. Stopping there makes a nested property opaque or rejects a root type. Without the limit, a deeply nested declared type could print an unbounded number of `assumes:` lines.
  - Requirement expansion and the single excluded value have their limits under "How are requirements derived and discharged?". The `console.assert` proofs need none.
- An `unsupported:` line may include a short hint that says when a rewrite may suit, e.g. `a for loop may suit simple dense-array aggregation`. Full examples and warnings about behavior changes stay in `refactorGuides` in `src/audit.ts`, so the report text does not imply that rewriting the syntax is always safe.
- Stable numeric IDs identify functions, blocks, values, lowered operations with their source locations (`SiteID`), and module bindings (`src/ir/ids.ts`). Effects are not modeled, so they have no IDs.
- Values with different lifetimes are stored separately, not in one generic map: local values by `ValueID`, module bindings by `ModuleBindingID` (`ExecutionState` in `src/engine/state.ts`). Platform values are not stored, because each read produces a fresh value.
- Freerange has one lowering pipeline and one evaluator, shared by functions and module initialization. Callbacks should use them too if they are ever supported.

## Maybe Reconsider

Each entry was tried or proposed and did not show enough value on its own to ship. No trial implementation was merged into `main`; sizes and measurements are recorded only as reasons for the decision. Reopen an entry when the evidence it asks for appears.

Observed usage is evidence, not the feature specification. Do not add rules for the exact expressions one code base contains, and do not reject a small, general rule only because one call site needs it. Prefer a small written subset whose behavior is complete and predictable. Use analyzed code to find missing categories, and describe the edge of the supported subset without referring to that code.

- Narrowing after a proven assertion. Today there is none: `if (a >= b) return 0; const d = b - a; console.assert(d > 0); return 1 / d` prints `proves: d > 0` and still prints `requires: (b - a) is nonzero`. A trial of about 33 net lines worked but changed no Pretext result. Reconsider when real code would otherwise repeat a guard after an assertion, or lose a useful guarantee after it.
- Named boolean helpers in assertions. Today `console.assert(isValidLayout(frame))` is rejected: an assertion condition may call only `Number.isInteger`, `Number.isFinite` and `Number.isNaN`. A trial that worked out what a `true` result of a supported same-file helper proves about its arguments took about 183 net production lines and changed no Pretext report. Reconsider when a real property is much clearer as a helper call than as direct comparisons. That case must justify the cost of explaining what a `true` result proves.
- Assertions in partially analyzed functions. Today a stop on some path, or an `assumes:` line about one operation, blocks the function's proven assertions (see "Later assertions"). A trial tracked which paths each assertion's proof covered, distinguishing assertions before and after unsupported code, beside a branch that returns, and in later loop iterations. Reconsider when an important property naturally sits before an unsupported operation that cannot be avoided.
- Object spread. Today: `unsupported: object spread (list every field explicitly, e.g. {gain: config.gain})`. A trial accepted spread only from a record it could trace to a local object literal, which is known to have own properties. It rejected records from outside the analyzed code, whose declared properties may live on a prototype that spread does not copy. The tracing rules changed no contract in the demo (`demo/`) or in Pretext. Reconsider when listing every field is clearly awkward in real analyzed code. Do not extend the rule to records from outside the analyzed code without a different model of those objects.
- Direct inline collection callbacks. Today `.map` and the other array methods are rejected. [Toward Programming Languages for Reasoning: Humans, Symbolic Systems, and AI Agents](https://arxiv.org/abs/2407.06356) avoids primitive loops in its core language and provides fixed collection operations instead. If this feature returns, follow its restriction and add no general callback execution:
  - Accept only a small named set of built-in operations.
  - Require the callback inline as the argument, never stored or returned, supported, with no mutable captures and no writes.
  - Give each operation fixed rules, e.g. `map` keeps the input length, and `filter` returns a length from zero through the input length.

  A trial `map` of roughly 216 lines made two Pretext functions fully analyzed and one partially supported, and only one gained a clearly useful numeric contract. Reconsider when analyzed code has a numeric mapping whose useful result cannot be written cleanly as an extracted helper or an explicit loop.
- JavaScript's 32-bit bitwise operators and `Math.imul`. Today they are rejected, e.g. `unsupported: binary operator |`. A trial modeled their signed and unsigned results consistently, shifts included. Reconsider when a real hash, mask, color or index calculation needs a checked property. Do not add them only to accept more syntax.
- One bounded relation that says two exact values differ. Today `if (a === b) return 0; return 1 / (a - b)` still prints `requires: (a - b) is nonzero`. The relation would prove a subtraction nonzero after a check that its two operands differ, and the design can stay small. Today, name the difference and check it: `const d = a - b; if (d === 0) return 0; return 1 / d` needs no requirement. Reconsider when that form is clearly worse code.
- Function contracts (also called procedure specifications) for imported functions. Today a call to an imported function makes the caller `unsupported`. A separate file, similar to a `.d.ts` file, could state `requires` and `ensures` for an imported function in the condition language of `console.assert`, compiled into function summaries. The author of the imported module should verify the implementation against the contract when the source is available; otherwise the report must show consumers that the contract is assumed, not proven. Pretext's text-measurement functions are a concrete candidate, because layout code that calls them cannot be analyzed. Build a trial only when imported numeric helpers block a specific proof. Decide representation, validation and bounded caching together.
- Same-file call-result caching. Today calls are not cached. A trial kept one cache entry per callee. It sped up the case where the same call is reached again through different callers, which is also exponential in JavaScript, but did not bound calls whose arguments change. Its deep comparison of arguments made 1,000 trivial calls that pass an ignored 500-field record grow from about 1ms to 162ms. Reconsider only under the four conditions in "How should analysis work scale?", shown by a test where most lookups miss the cache and that does not get slower.

## Deferred

- Searching for a concrete counterexample and replaying it.
- Deriving requirements from whether the final result is affected (see "Division and remainder").
- Printing values at a stop, e.g. that `width` was 100. Also recovering the returns that are not reported when a stop happens inside a loop (see "How should loops be analyzed?").
- Callback ordering and the execution of callback sequences, including a bounded, user-chosen sequence.
- A relational numeric domain beyond the four kinds of condition listed under "Additional decisions", and recurrence analysis for loops. Loops currently use widening only.
- Modeling caught exceptions. `throw` ends a path, and a path that throws contributes nothing to the result, which is exact as long as the subset has no `catch`, so a guard clause such as `if (bad) throw new Error(...)` discharges requirements. A function annotated `: never` that throws on every path is analyzed, and callers treat a call to it like an inline `throw`. `try`/`catch` is rejected, because supporting it means modeling how exceptions flow.
- Reporting every unsupported construct in a function. Today only the first is reported.
- Naming a tuple position in a requirement. The requirement language has property paths but no form for an element, so for a `[number, number]` parameter `pair[0] / pair[1]` prints `assumes: the divisor at <site> is nonzero`, which a caller cannot satisfy the way it satisfies a `requires:` line. Each written `pair[1]` is a separate read: it prints its own line, and a guard on one does not cover another. Only the same element value reuses the assumption, e.g. an element kept in a local, or `pair[i]` read twice through one `const i = 1`. Workaround, as for module bindings ("Asserted element reads"): `const divisor = pair[1]; if (divisor !== 0) { ... / divisor }`.
- Representing a value that is definitely NaN. The number domain always holds a numeric interval plus `mayBeNaN`, so `0 * Infinity` is any number or NaN, not NaN alone. As a result, an asserted read that can never be in bounds, e.g. `values[0 * Infinity]!`, prints a requirement when it should be rejected. Reconsider only with a real example, because a NaN-only value affects every numeric operation, not only indexes.
- Naming a value defaulted with `??` in a requirement. `const actual = divisor ?? 4; total / actual` prints `assumes: the divisor at <site> is nonzero`. The result of `??` is a join of two branches, held in a block parameter, and the requirement language has no form for a fallback and cannot refer to block parameters. Guarding and then dividing, `if (divisor !== null) total / divisor`, does create `requires: divisor is nonzero`.
- Narrowing a copy that was built earlier. After `const copy = {columns: grid.columns}`, the guard `if (grid.columns >= 1)` does not narrow `copy.columns`. That needs an index of every place a value was copied, which branch narrowing does not have. The reverse works, because `copy.columns` is the exact read that was stored when `copy` was built. Guard before copying.
- `.map`, `.push` and array spread. `README.md` shows the loop rewrite for a simple aggregation. A loop is not always an exact replacement, e.g. `.map` skips the holes of a sparse array, and passes the index and the array to its callback. Sparse arrays are not deferred: they are rejected on purpose (see "Working agreement").
- Narrowing through a stored compound condition (see branch narrowing under "Additional decisions").
- Record and tuple parameter types beyond the ones that classification accepts today (see "How is the accepted subset enforced?" and "How are arrays represented?").
- Properties whose declared type mixes kinds, e.g. `{x: number | boolean}` written with a number on one path and a boolean on another. The join drops such a property, and reading it is rejected anyway. What the report states about the rest of the record still holds.
- In-place object mutation. It was supported once: property writes on locals and parameters, with a strong update when the target was a single known object and a weak (joining) update when it came from a join or stood for several objects. A write to a parameter printed as an `ensures:` line. Restoring it means rebuilding the abstract heap and allocation identities, which were deleted when records became plain immutable values. The project owner approved this trade-off. A cheaper partial option, if only building a local object step by step is missed: mutation of a local that provably has no alias and does not escape can be lowered to rebinding each field, with about 80 lines of escape checking and no heap.
- Exact values of module-level objects and arrays in partially analyzed files (see "Which bindings give functions their exact value"). A binding typed through a mapped type such as `Readonly<T>` becomes opaque there, so reading one of its fields stops the path. A more precise rule is possible: apply this only to bindings whose identifier or alias reaches unanalyzed code.
- Runtime import cycles and top-level `await` (see "How should module initialization be modeled?").
- Termination proofs and `decreases` clauses.
- A general method for discovering loop invariants.
- The representation of symbolic arithmetic, of branch conditions, and of requirements with alternatives, and the limits on their growth.
- Recursion and more precise widening. A recursive call stops the path, and the function reports `partially supported: recursive call to <name>`. Widening moves a growing bound directly to the largest finite number, or to infinity when the value may already be non-finite.
- Purity features beyond the small subset that the current version turns out to need (see "How should the scope of purity analysis be chosen?").
