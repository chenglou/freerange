# Current decisions

This file records how the implementation behaves, which alternatives were rejected and why, measurements, and deferred work. `README.md` describes the commands, the supported TypeScript, the report terms, and the refactoring advice. Do not keep a second copy of that description here.

## Working agreement

Warn the project owner before a decision that can cause path explosion or state explosion, where the number of paths, states or calculations grows too fast to analyze. Such decisions involve branches, loops, numeric expressions, fixed points, or widening. Also warn before a major change to the architecture or the file structure, and before a data-structure decision becomes difficult to reverse.

Prefer code whose structure enforces a rule over code that needs a review to catch a broken rule. Some rules must hold in many places. For example, every numeric operation must record which operation caused a possible NaN or overflow. Every form of write to a module binding must be found, so that no function uses an outdated value of the binding. Every place that builds an interval must keep the interval's invariant. When a rule is like that, reshape the code so that one place enforces the rule and no other place can forget it. Do not repeat the pattern and rely on code review to find the missed place. Reviews are a second check, not the main way a rule is enforced.

Soundness reviews target code that people actually write. A soundness bug that ordinary code can trigger deserves a real fix. Examples are a value that can become NaN, or a function that sees an outdated value of a module binding after an ordinary reassignment. A soundness bug that needs contrived code is still worth reporting. Examples are an `eval` string that reassigns a module binding, or a property named `eval`. The response to such a bug is to reject the construct (see "How is the accepted subset enforced?") or to treat the value as opaque, that is, as a value Freerange knows nothing about (defined in the next section). Type assertions are treated this way. The response is not to add special handling for the unusual case. When you ask someone to review soundness, tell them this priority. Otherwise the review spends its time on unusual syntax that ordinary code does not contain.

When a data shape makes programs harder to reason about, e.g. a sparse array, and supporting it is not cheap, reject it. Sparse array construction is rejected because missing elements would complicate every element read. Optional and rest tuple positions are rejected so that Freerange does not need to model tuples of variable length. When Freerange cannot inspect a condition about data that comes from outside the analyzed code, the report prints the condition as an `assumes:` line instead of assuming it without saying so. Accepting more code later is cheaper than maintaining support that nobody has needed yet.

## How is the accepted subset enforced?

`README.md` describes the accepted subset and the refactoring advice. In the code, every supported construct has an explicit check, and there is no default case that accepts unknown syntax. A few rules that cover a whole function run before lowering: `assertAccepted` in `src/lower/accept.ts` rejects property writes and `var`. Parameter types, expressions, statements, conditions, and calls are checked during lowering, at the place where the TypeScript information they need is available. A construct with no supported case is rejected, and the report names the first unsupported construct in the function. The other functions in the file are still analyzed. An unsupported top-level statement is skipped. For every module binding the statement could write, functions then see only the binding's declared kind: what its declared type says, not its value (see "How should module initialization be modeled?").

Two terms recur in this file. An opaque value is a value that Freerange carries without knowing anything about it, not even whether it is a number, a boolean or an object. A path stops when Freerange cannot continue analyzing it. The function is then reported as `partially supported`. An operation that needs to know the kind of an opaque value stops the path that reaches the operation.

Freerange's guarantees depend on the types the TypeScript checker reports: parameter types, declared types and return types. The subset therefore excludes the code where those types may not match the runtime values:

- `any`-typed values are opaque, like `unknown` values. The checker's types say nothing reliable about such a value, so Freerange says nothing about it either. An operation that needs a concrete kind, e.g. `payload + 1`, stops only the path that reaches the operation. Writing an `any`-typed value into a typed binding leaves the binding opaque. Freerange does not use the declared type to recover information, e.g. after `const hidden: any = true; const forced: number = hidden`, `forced` is opaque. TypeScript lets an `any`-typed value into any write position, including module bindings. For that reason, when a function's result depends on the declared type of a module binding, the report prints an `assumes:` line that states the type, e.g. `assumes: debug is a boolean`. Operations that do not depend on the kind still work, e.g. strict equality between two opaque values produces a boolean that may be true or false. Freerange carries `any`-typed values instead of rejecting them so that the surrounding numeric code stays analyzable. For example, a function that compares an `any`-typed `payload` with `===` and computes its return value from number parameters is fully analyzed.
- Type assertions written with `as` or angle brackets produce an opaque value. The function around the cast is still analyzed, and only the paths that use the cast value stop. A type assertion is the place where the checker's type and the runtime value may differ. No rule that compares the two types is sound. Three such rules were tried and each had a counterexample. Treating only `as unknown` and `as any` as opaque fails for `true as {} as number`, which type-checks through the intermediate `{}`. Requiring the two types to have the same top-level kind fails one level deeper, e.g. `flags as unknown[] as number[]`. A recursive comparison of the two types failed in two places: where the comparison skipped optional properties, and where it handled unions whose members have different kinds. Each counterexample type-checked without errors and crashed the engine with `Cannot join`. The one exception is `as const`. TypeScript permits `as const` only on literals, and `as const` narrows a literal to its own literal type, so the kind of the value cannot change.
- The non-null assertion `x!` is accepted where it does not change the kind of the value, e.g. on a value that is already a `number`. `value!` on a `number | null` value is rejected. One form that changes the kind is allowed: `array[index]!`, called an asserted read in this file. A bare read is `array[index]` without `!`. Writing `!` after an element read tells Freerange to treat the read as in bounds. If Freerange cannot prove the read is in bounds, the report prints `assumes: the element read at <site> is in bounds`, or a `requires:` line when the index can be written in terms of the parameters. `<site>` is the source location of the operation, e.g. `layout.ts:12:18`. A read that Freerange proves is in bounds adds no line, e.g. the element read inside the counter loop that `for...of` desugars to. An asserted read on an array that is provably empty stops the path. "How are arrays represented?" describes bare reads.
- `var` is rejected. Hoisting gives one variable several declaration sites, and a nested redeclaration writes a binding declared elsewhere, e.g. `var x = 1; { var x = 2 }` is one variable. `let` and `const` express the same programs without that behavior. A `var` name never becomes a module binding, so a function that reads one is rejected with `unknown identifier <name>`.
- `eval` is rejected for the whole file. An `eval` string can rewrite bindings that every function's report depends on, so rejecting only the function that contains the call would not protect the other functions. Any mention of the identifier `eval` anywhere in the file makes every function in the file unsupported and stops the analysis of module initialization. The detection is a scan for the identifier, and the scan deliberately rejects more than necessary. Every way of writing a call that can reach module scope, e.g. `(eval)(...)`, contains the identifier, so Freerange does not need to recognize particular call forms or wrappers. A known cost is that a property named `eval`, e.g. `position.eval` in a chess engine, also rejects the file.
- Assignments used as values inside larger expressions are rejected, e.g. `cond ? (x = 1) : 2` or `a = b = 5`. Assignments are lowered only in statement position: as their own statement, or as the incrementor of a `for` loop. Assignments used as values are rare in ordinary code. Rejecting them means that the branches of `?:`, `&&` and `||` cannot contain an assignment, so the join after such an expression carries exactly one value and does not need to merge bindings. Assigning a `let` in the branches of an `if`/`else` statement is fully supported. Branches with several statements that compute intermediate values are ordinary code, and loops need the same merging of bindings anyway.
- The type-check suppression directives `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck` are rejected for the whole file. This is the other file-wide rejection. A directive can put a boolean in `let width: number` with no `any`-typed value involved, so the checker's types can no longer support guarantees anywhere in the file. The detection follows the comment forms that TypeScript itself recognizes. Text that mentions a directive inside a string, or a commented-out directive such as `// // @ts-ignore`, does not reject the file.

The `UnsupportedReason` type in `src/ir/program.ts` lists every rejection, and `formatUnsupportedReason` in `src/report/index.ts` prints them. Together they define exactly where the subset ends. Objects and arrays are immutable after construction, while local and module `let` bindings may be reassigned. Because there are no writes into objects, aliasing between object parameters cannot be observed. A callee therefore affects its caller only through its return value and through reassignments of module `let` bindings. "How are objects represented?" and "How are arrays represented?" describe the resulting representations.

Type predicate and `asserts` signatures add no information. Freerange analyzes such a function through its ordinary body and return value. TypeScript does not verify a type predicate, so Freerange learns nothing from one: after `if (isBox(value))`, Freerange knows only what the body of `isBox` returned.

The `in` operator is rejected. TypeScript's width subtyping lets a value carry properties that its union member does not declare, so `'title' in section` cannot soundly prove which union member `section` is.

An optional property, e.g. `session?: boolean`, is modeled as a value that is possibly undefined. An object literal that omits an optional property gets an explicit undefined for it. When one branch sets the property and another branch omits it, the join therefore keeps a correct value: the property is possibly undefined. The representation deliberately does not distinguish a missing property from a property set to `undefined`, because an ordinary read returns `undefined` in both cases. Operations that distinguish the two, e.g. `in`, are rejected. This model stays sound when the project disables `exactOptionalPropertyTypes`.

For objects that come from outside the analyzed code, Freerange assumes that no code modifies prototypes, that no object defines custom coercion, that no callback runs when a property is read (e.g. a Proxy trap), and that platform globals are unmodified. A property read must have no side effects and must return the same value each time during one analyzed synchronous call. After a module finishes initializing, other modules must not modify a module-level object or array whose exact value functions see. The report prints that last condition, and the separate assumptions about arrays, as `assumes:` lines.

Freerange classifies a record by its resolved TypeScript type, not by how the type is written in the source. A field is selected when some code in the file reads it, including code in unsupported top-level functions. Each type has one set of selected fields for the whole file. When a value of one type flows into a position of another type, the fields selected on the target type are also selected on the source type. Freerange follows such flows through typed declarations, assignments, arguments and return values of same-file functions, arrays, tuples, and conditional expressions. A property read whose receiver is a conditional or `??` expression selects the field only on the type of the whole expression, not on the type of each operand. For example, in `(useFallback ? fallback : measured).x` where the type of `fallback` has a property that the type of `measured` lacks, e.g. `{x: number; extra: number}` and `{x: number}`, `x` is not selected on the type of `fallback`, and the read stops the path. Name the chosen value first: `const chosen = useFallback ? fallback : measured; chosen.x`. Parentheses, `satisfies`, `as const`, and a non-null assertion that keeps the kind are looked through: the inner expression is used.

Only selected fields are classified, recursively, through at most eight levels of nesting. A selected field that cannot be classified becomes opaque, and so does a record with no selected fields. An object literal is still evaluated in full and keeps every field it writes. A selected number field whose type the project declares becomes a caller requirement, e.g. `requires: Number.isFinite(box.width)`. A selected number field declared in a `.d.ts` file becomes an assumption, e.g. `assumes: rect.width is finite and not NaN` for a `DOMRect`. A utility type that a declaration file defines as a mapped type, e.g. `Readonly<{gap: number}>`, is opaque. The following project types are rejected as parameter types: types with index signatures or dynamic keys, callable or constructable objects that also have data fields, and untagged unions of object types. An untagged union is rejected even when its separately declared members have identical fields, e.g. `A | B` with `type A = {x: number}` and `type B = {x: number}`. Comparing the members recursively would take about 100 lines of code for a case the subset can reject. A field whose type refers back to an enclosing type is opaque, e.g. `children` in `type Tree = {value: number; children: Tree[]}`. A field nested past the eight levels is opaque too. A parameter whose own type nests arrays past eight levels, e.g. `number[][][][][][][][][]`, is rejected. Properties backed by a getter fall under the assumption above: the read has no side effects and returns the same value each time.

Numeric intersections are classified separately from records. A resolved intersection is numeric when it contains exactly one `NumberLike` member and every other member is an object type. An additional primitive member keeps the intersection outside the subset. The numeric member supplies the range, so `(1 | 2) & Marker` is the integer range 1 through 2. The other members add no information about the number. Freerange assumes the TypeScript type is correct. It does not try to prove that the other members are phantom types, and it does not compensate for casts or incorrect declarations. The value is carried as a number and not as an object. Reading a property, destructuring, calling, indexing, or constructing through one of the ignored members is therefore rejected or stops the path, e.g. `unsupported: property read from number & Marker`.

Once the check accepts a function, the engine must be total over it: evaluation ends in a return value or a recorded stop, never in a thrown error. A `throw` inside the engine states an invariant that the acceptance check is supposed to guarantee. Reaching such a `throw` from accepted source is a bug in the check, not a case for the engine to handle. There is one deliberate exception. TypeScript can narrow a type in more ways than Freerange models, and an opaque value has no known runtime kind. An operation can therefore receive a value whose kind Freerange cannot establish. The engine turns that case into a stop on the current path, reported as `uses a value whose runtime kind the analysis cannot establish`. The conversion happens in two places: where `evaluateInstruction` evaluates an instruction, and where `branchConditionOutcome` reads a branch condition. A bare array read that is still possibly undefined when an operation needs the element gets its own reason, `uses a possibly missing array element without handling undefined`, and its own audit suggestion, `[handle-missing-element]`.

## What does the analyzer know about the browser platform?

What Freerange knows about the numbers that browser globals return is stored in one catalog, `src/lower/platform.ts`. Freerange trusts these entries without checking them, as TypeScript trusts `lib.dom.d.ts`. Each entry is a deliberate, written decision, because a wrong range makes every result computed from it wrong. The entries record how browsers actually behave, not the most convenient assumption. For example, no scroll-position entry says the value is nonnegative, because Safari's elastic overscroll (rubber-banding) reports negative values at the edges. The current entries are:

- `document.documentElement.clientWidth` and `clientHeight` are nonnegative integers.
- `window.innerWidth` and `window.innerHeight` are nonnegative and can be fractional under browser zoom.
- `window.scrollX`, `window.scrollY`, `document.body.scrollTop` and `document.body.scrollLeft` are finite, with no guarantee about the sign.
- `performance.now()` is nonnegative and fractional.
- `Date.now()` is an integer from `-8.64e15` through `8.64e15`.
- `Math.random()` is at least zero and less than one.

The same properties on any other element, e.g. `element.clientHeight` on an `HTMLElement` parameter, have no entry. They follow the ordinary rule for number fields declared in a `.d.ts` file and print an assumption.

A read that matches an entry produces a new value within the recorded range every time it is evaluated. Platform state is mutable, so two reads of `clientWidth` may differ and are never assumed equal. An entry matches only when the root symbol has a declaration from TypeScript's standard libraries. A local variable with the same name, or a name declared only in a project `.d.ts` file, therefore does not get the built-in behavior. Additional declarations may augment a real built-in, as Bun's types do for `performance`. Every current entry is number-valued. `T | null` APIs can be represented, but none has been added yet. Platform ranges combine with the rest of the analysis. For example, a function with no parameters that reads `document.documentElement.clientWidth` and clamps the value gets a fully proven range such as 1 through 7.

## What is kept when only part of a function is supported?

Keep the information established before an unsupported operation, but mark the function as partially supported. Partial information describes only the paths that Freerange analyzed completely. Partial information must not be used as a postcondition of the whole function or as the final program state.

For example, given `let width = 100; unsupportedOperation(); width = 200`, Freerange may know that `width` was `100` before the unsupported operation. The report must not state that the function returns with `width` equal to `100` or `200`.

Reports currently keep less information than that example. They keep the return values of the paths that completed, and the requirements found along every path Freerange evaluated, including paths that later stopped. Both print under `on analyzed paths:`. The record of a stop holds only a location and a tagged reason, so printing the values known at that location (`width` being 100 above) is not implemented. It is listed under Deferred.

When lowering finds an unsupported construct in an ordinary function, the partly lowered body is discarded and no partial information remains. The function is reported as `unsupported`. Module initialization is the exception. Lowering skips an unsupported top-level statement, records a `skipped:` line, and continues, because real top-level code mixes browser calls with the initialization of state. For every binding that a skipped statement could write, functions see only the binding's declared kind, so later analysis does not rely on values that the skipped code might have changed.

A partially supported function gives its caller nothing on a path that did not complete. The caller's path stops at the call with `calls <name>, which is only partially supported`, and the caller's later statements on that path are not analyzed. What the callee established before its stop appears only in the callee's own `on analyzed paths:` lines and never becomes part of the caller's state.

Partial results use a separate type with no requires or ensures fields, so results from analyzed paths cannot be printed or passed on as guarantees by accident. The module initialization entry prints only the first skipped statement, while the structured audit data keeps the location of every skipped statement.

Known limit of the report: each of two mutually recursive functions reports the other as a partially supported callee, and the report does not say that the cause is mutual recursion.

When a number may be non-finite, the report distinguishes a possible NaN from a possible overflow without NaN, and records which operation caused each (`nanSite` and `nonFiniteSite` on the number value). Source locations, these two included, are annotations only. The engine never branches on a source location, and source locations are not compared when a loop checks for a fixed point.

## How should non-finite numbers be modeled?

`README.md` describes the rule for number inputs. In the code, the automatic finite requirement on a number parameter is lowered to the same numeric check and the same static requirement as a leading `console.assert(Number.isFinite(value))`. There is no second inference pass. After a call completes, ordinary refinement knows that the argument value is finite. An explicit `console.assert(Number.isFinite(value))` at the start of the function therefore adds no second requirement, and a stronger requirement such as `Number.isInteger(value)` replaces the finite one. The input check is part of every lowered function. A partial report still prints no `requires:` or `ensures:` lines, and prints the input condition as `assumes: value is finite and not NaN` instead.

Numeric operations may still produce Infinity or NaN from finite inputs. The analyzer carries that possibility forward instead of stopping. Division and remainder also require a nonzero divisor. A value is nameable when it can be written as an expression over the function's parameters, constants, arithmetic, `Math.floor` and property paths. When the divisor is nameable, the report prints a requirement, e.g. `requires: b is nonzero`. When the divisor is not nameable, e.g. a value joined from two branches, a module read, an element read, or a call result, the analysis continues and the report prints `assumes: the divisor at <site> is nonzero` instead. In both cases the operation is evaluated with zero removed from the divisor's range. If the assumption is false, the `ensures` lines that depend on it are not guaranteed. Because requirements can name `Math.floor(...)` over nameable operands, `width / Math.floor(cols)` creates `requires: Math.floor(cols) is nonzero`. The quotient is then finite, because a nonzero integer divisor has magnitude at least 1.

`ensures` lines assume the `requires` lines. The project owner decided this. Ask the project owner before changing it. Once a nonzero requirement is recorded, the operation is computed over the divisor's range with zero removed. Later operations along that path that use the same divisor value, e.g. the same local `b`, keep the nonzero information and create no second requirement: `const ratio = a / b; return ratio + a / b` prints one `requires: b is nonzero`. Writing the divisor expression again creates a new value and a new requirement, and so does assigning the divisor a new value, e.g. `a / (b + 1) + a / (b + 1)` prints `b is not -1` twice. For division, an integer divisor then has magnitude at least 1 and the quotient is finite. A non-integer divisor can still be arbitrarily close to zero, so the quotient may overflow but cannot be NaN. A remainder with a nonzero divisor is bounded by its operands and cannot be NaN when the dividend is finite. Freerange creates a requirement at every division or remainder that is not otherwise proven, without asking whether the bad result can affect the function's final result. That broader analysis is listed under Deferred.

The analyzer must still represent a possible NaN and possible infinities internally, so that it can explain where the possibility came from and pass requirements to callers. Addition and subtraction stay exact over operands that may be infinite but cannot be NaN, because the only NaN case is adding infinities of opposite sign. `(a + b) + c` with finite inputs is therefore reported as possibly non-finite and never as NaN. `(a + b) - (a + b)` keeps the NaN possibility, because both sides can overflow to the same infinity. Multiplication and division still lose all precision on possibly infinite operands, because more operand combinations produce NaN, e.g. `0 * Infinity` and `Infinity / Infinity`. Some operations make a value finite again, and Freerange recognizes them where the result is exact. `Math.min`, `Math.max`, `Math.abs`, `Math.floor` and the other rounding functions (`Math.ceil`, `Math.round`, `Math.trunc`) keep their bounds even over possibly infinite inputs: they have no rounding error, cannot overflow, and cannot create a NaN. `Math.max(0, Math.min(v * 2, 100))` therefore ensures 0 through 100 even though the doubling can overflow. A clamp does not remove a possible NaN, because `Math.min(NaN, 100)` is NaN: `mayBeNaN` stays set after `Math.min` or `Math.max`. Do not stop analysis merely because an intermediate result may be non-finite.

### Floats, not reals

Tests cover the IEEE double behavior that limits how far a requirement can be simplified. `tests/analyze-requirements.test.ts` asserts that `1e-300 / 1e300 === 0`, so a ratio of two positive numbers can underflow to zero, and that `1e-200 * 1e-200 === 0`, so a small constant factor cannot in general be removed from a requirement: `total / (x * 1e-300)` keeps `requires: (x * 1e-300) is nonzero`. `tests/audit.test.ts` shows the same underflow in a refactoring example: with `Number.MIN_VALUE` as the image width, `imageWidth / imageHeight` rounds to zero and the following division returns Infinity. Do not rearrange code that deliberately controls rounding.

## How are missing values modeled?

JavaScript has two missing values, `null` and `undefined`. Freerange models them the same way. A value is a number, a boolean or a record; or it is missing (`{kind: 'nullish'}`); or it may be either (the `maybeNullish` wrapper). Every missing or possibly missing value records which of the two it can be: `null`, `undefined`, or both. This has two effects:

- A report line names only the missing value that is possible: `animatedUntilTime is null or a finite non-NaN number` when only `null` is possible.
- Narrowing follows JavaScript's rules. `x !== null` on a `number | undefined` value proves nothing about `undefined`, because `null` and `undefined` are different values. The else branch of that check is unreachable, and the analysis prunes it. The loose check `x == null` removes both missing values at once.

`??` computes both outcomes exactly: `animatedUntilTime ?? now` is the number, or `now` when the left side is missing. The purpose is to keep number ranges through code that uses `null` or `undefined` for "no value yet".

Unlike mutation, which Freerange asks you to remove, `number | null` is the form Freerange recommends. A sentinel number such as `-1` for "unset" becomes part of the range, and nothing checks that code treats `-1` specially. `number | null` keeps "no value" out of the range, and TypeScript enforces every check. Two unusual cases are rejected: `??` whose two sides have different kinds, e.g. a `number | null` left side with a boolean right side, and a union with more than one non-missing kind, e.g. `number | boolean`. Optional properties are supported. They are modeled as possibly `undefined` values (see "How is the accepted subset enforced?").

## How are arrays represented?

Freerange represents arrays the way TypeScript types them: as tuples or as arrays.

A tuple type (`[4, 8, 24] as const`, or an annotation like `[number, number]`) has one abstract value per written position. A read at a constant index returns that position's value exactly and is known to be in bounds.

Only tuples whose positions are all required are supported. An optional position (`[number, number?]`) or a rest position (`[number, ...number[]]`) makes the runtime length a range instead of the written position count. TypeScript stores which positions are optional or rest in the tuple type's element flags. The type arguments alone do not show it, because an optional position and a rest position each contribute one type argument. Freerange rejects such a tuple instead of modeling a range of lengths. The project owner decided this, because accepting more later is cheap. What happens next depends on where the type appears:

- A parameter of such a type makes the function `unsupported`. The message names the rewrite: model the value as `number[]`, or as a fixed tuple like `[number, number]`.
- A record property of such a type is opaque. The rest of the record is still analyzed.
- A module binding of such a type is not tracked, and reading it stops the path.

An array type is homogeneous. Freerange keeps one abstract value that covers every element (the join of all elements) and an interval for the length. Every index follows the same rules, and nothing is known about one particular index. When a tuple is joined with a tuple of a different length or with an array, the result is the array form, and it never turns back into a tuple.

Freerange treats a bare read (`arr[i]` without `!`) as possibly `undefined`, whatever the project's `noUncheckedIndexedAccess` setting is. `arr[i] ?? 0` needs no in-bounds `requires:` or `assumes:` line. Only the plain-array line and the lines about elements, both described below, print. If a possibly missing element reaches arithmetic, a property access, or another operation that needs a present value, the path stops with `uses a possibly missing array element without handling undefined`. This also happens in projects where TypeScript itself types the element as present.

An asserted read (`arr[i]!`) tells Freerange to treat the element as present. When Freerange cannot prove that the read is in bounds, it prints a `requires:` line or an `assumes:` line ("How are requirements derived and discharged?" says which). Either line is handled the same way as other requirements: recorded where the engine evaluates the read, and copied to the caller when the callee completes. `for...of` desugars to a counter loop whose element read is always in bounds, so array loops add no such lines. The loop body of an empty array is unreachable and is pruned.

Freerange assumes two things, without checking them, about an array that a caller controls:

1. Each `length` read is the real element count. The length starts as an integer from 0 through 2^32 - 1.
2. A read that is in range finds an element of the declared element type, so the possibility of `undefined` is removed for that read. A read is in range when it is a bare read with a proven bound, or an asserted read.

The report's lines about elements, e.g. `every grid[each] element is finite and not NaN`, do not state either assumption. Such a line describes only the elements the array actually holds. A Proxy that reports length 10 while holding 3 rows adds no elements, so it breaks nothing on that line. A `string[][]` parameter has opaque elements, so it has no line about elements at all. With only the lines about elements, a type-correct caller could make a printed `ensures` line false. Ordinary data can break the two assumptions too, not only proxies: `[1, , 3]` and `new Array(5)` are valid `number[]` values with correct lengths and missing elements.

Anything Freerange assumes without proof must be printed. So the report prints these two assumptions for each array, one line per nesting level, e.g. `assumes: values is a plain array — its length counts its elements, and every index below the length holds an element`. A length that does not match the element count breaks the first clause. A hole breaks the second clause. A nested row read that finds nothing because the outer length was wrong breaks the second clause of the level above it. Because the line is printed, Freerange may treat an in-range read as never `undefined`. This applies to bare reads and asserted reads alike.

Freerange combines repeated plain-array lines into one line in exactly one case. When a non-nullable record has three or more selected array fields that are direct properties of the record and are themselves non-nullable, those fields print as one line: `every array field of prepared used in this file holds a plain array — ...`. Only those fields' own lines are replaced, because the combined line must state exactly what the replaced lines stated. Everything else prints one line per level even when the combined line appears: nested element levels, arrays behind a nullable record, nullable roots, tuples, and nullable array fields.

The line for a nullable array field names the one missing value that the field declares: `overrides is null or overrides is a plain array — ...` for `overrides: number[] | null`, and `is undefined or` for `overrides?: number[]`. The engine starts each such field with only the declared missing value and prunes a branch that tests for the other one. A combined line that allowed both `null` and `undefined` would allow values the engine treats as impossible. A caller could then pass the other missing value, e.g. `undefined` into a `| null` field or `null` into an optional field. Every printed `assumes` line would then be true while a printed `ensures` line was false at runtime. This happens with ordinary data: serializers write `null` for absent fields, so any value that comes from JSON can hold `null` in an optional field.

A declared tuple prints a count sentence in place of the plain-array line: `pair is a plain array of exactly 2 elements — ...` for `[number, number]`. The exact count matters because TypeScript in strict mode allows `pair.push(3)` on a `[number, number]` value, which builds a three-element pair without a type error. The remaining clauses state the same two assumptions as the array line: the length counts the elements, and every index below the length holds one. Tuple positions keep their own number lines (`pair[0] is finite and not NaN`), or are covered by the combined number line described under "What functions see for every other binding" when the value has three or more number leaves. The count sentence always prints separately: tuples are never included in the combined plain-array line. One combined sentence cannot state a different element count for each field, and the count is the clause that a tuple made longer by `push` breaks.

## How should module initialization be modeled?

Lower each file's top-level runtime code into a synthetic initializer function. Evaluate it with the same control-flow evaluator that ordinary functions use. Function declarations do not run during initialization unless top-level code calls them. A function assigned directly to a top-level `const` becomes callable when execution reaches its declaration. Creating the function does not run its body. A slot holds the engine's current value for one module binding. A slot is either uninitialized or holds a value, so a read before the binding's declaration stops the path.

Freerange does not build or execute a runtime module-dependency graph. Runtime import cycles and top-level `await` are not modeled, and no check rejects cycles across the project. Type-only import cycles do not matter. Imported values are normally unknown. The one exception is the numeric-literal constant case described below.

### Which bindings give functions their exact value

One rule decides what a function may assume about a module binding, and it is the same for `const` and `let`: use the binding's value only when no write can happen between initialization and the function's call.

The file's own functions can also run during initialization, e.g. through a top-level call, a callback that a skipped statement runs (`[0].forEach(render)`), a getter or setter, or object spread. So a binding qualifies only when its declaration is its only write. That covers two groups:

- Every `const`. A `const` cannot be reassigned. Values are immutable after construction, so analyzed code cannot change the property values of a `const` record either.
- Every `let` that nothing else assigns, in function bodies or in top-level code.

Under ES module semantics, a read before the declaration throws (the temporal dead zone), and afterward the value never changes. So every read that succeeds sees the same value, including a read during initialization. A bundler that rewrites a top-level `let` to `var` removes the temporal dead zone and is outside this model.

A whole-file scan checks the rule (`scanModuleBindings` in `src/lower/module.ts`). The scan visits the entire file, including top-level code and the bodies of rejected functions. It looks for assignments, `++` and `--`, and the targets of `for...of` and `for...in`. Every identifier inside an assignment target counts as written, destructuring patterns included, because missing a write would give functions an outdated value.

For a qualifying binding, functions see the exact value, records included (`publishedModuleValues` in `src/engine/analyze.ts`). `const gridSize = {cols: 8, rows: 6}` reads as exactly that record inside every function, and nested records are exact too. For a binding that holds an object or array, the file must also be fully analyzed; otherwise functions see only its declared kind (see "Exact values of module-level objects and arrays in partially analyzed files" under Deferred).

Another module that holds a reference can still modify such an object or array after initialization, e.g. an importer that runs `gridSize.cols = 100`. So every function that reads one, directly or through a same-file call, prints `assumes: other modules do not modify gridSize or any object or array inside it`. Three details:

- The line prints whether or not the binding is exported. References also leave the module through export specifiers, returned values, and records that contain the object. Records and arrays are plain values with no identity (see "How are objects represented?"), so Freerange cannot tell which reference left.
- `readonly` and `as const` do not remove the line. TypeScript lets a readonly property be assigned to a mutable property type, and `Object.assign` accepts a readonly record or tuple as its target.
- Freerange could instead never give functions the exact value of an object or array. That needs no `assumes` line, but plain records like `gridSize` would lose their exact values. On [Pretext](https://github.com/chenglou/pretext), a public text layout library, the report was the same under both choices. Pretext results in this file are observations and cannot be reproduced from this repository.

Whether a binding holds an object or array is decided from the value that initialization built, not from the declared type. A binding typed through a declaration-file mapped type, e.g. `Readonly<{gap: number}>`, is classified as opaque but holds a record. The same check on the value decides whether the exact value needs a fully analyzed file, and which slots are reset after a skipped statement.

### What functions see for every other binding

For every other binding, functions see only its declared kind. The declared kind is what the binding's declared TypeScript type says about it: some finite number, some boolean, or a record with its selected fields. A finite numeric literal type keeps its interval: `1 | 2` is an integer from 1 through 2, while `1 | 10` is conservatively the integer interval from 1 through 10, not an exact set.

A declared type is classified the same recursive way a parameter type is: numbers, booleans, records, tuples, arrays, nullable wrappers, tagged unions, optional properties as possibly `undefined`, and opaque for the rest. Only a binding whose whole type cannot be classified stays uninitialized, and a read of it stops the path. An imported binding normally stops the same way, because Freerange does not analyze the other module for it. There is one exception: an import that resolves to `export const NAME = <numeric literal>` in a project file reads as that exact constant.

The declared kind is an assumption, not a guarantee. TypeScript accepts an `any`-typed value in any write position, so a type-checked write can still put a non-boolean in a boolean binding. The report therefore prints a line for every selected read that relies on a declared kind: `assumes: scaleFactor is finite and not NaN` for a number, `assumes: debug is a boolean` for a boolean, and one line per selected leaf of a record, e.g. `assumes: pointer.x is finite and not NaN`. A leaf is a number, boolean or other non-record value at the end of a property path. The line appears on every function whose result depends on the assumption, including callers of the reading function.

A value with three or more selected plain number leaves prints one combined line. For example, a `camera` record that is reassigned elsewhere and whose `x`, `y` and `zoom` fields are used prints `assumes: every number field of camera used in this file is finite and not NaN` instead of three lines. The number elements of an array count as one number leaf, so the combined line can also replace lines about elements such as `every prepared.widths element is finite and not NaN`. The combined line requires every field it names to hold a finite number, so a non-number or a missing property written through an `any`-typed value still breaks it. Some lines are never combined:

- A record that contains a leaf with a literal interval keeps all its separate lines, so that the report does not hide the narrower condition inside the general sentence.
- Nullable leaves and tagged-union leaves keep their exact lines.
- Boolean leaves keep their own lines.
- A value with only one or two number leaves keeps its own lines.

A `let` that top-level code assigns again gives functions only its declared kind. For example, with `let pixelRatio = 1; export const border = hairlineWidth(); pixelRatio = 2`, Freerange must not prove anything about `hairlineWidth` from the final 2, because the call during initialization saw 1. The rule is also conservative for a binding whose every assignment happens before any call, e.g. `let gutter = 8; gutter = gutter * 2`. Two finer rules were rejected: using the values written before the first call, and joining the values that each call sees. Both need the complete list of places where initialization runs the file's functions. Functions can run during initialization through analyzed top-level calls, callbacks that skipped statements run, getters, setters, object spread, and records that store the function. Pretext has no binding that top-level code assigns again and that would otherwise qualify, so the simpler rule loses no precision there.

`eval` needs no handling here: a file that mentions `eval` is rejected as a whole (see "How is the accepted subset enforced?"), so the scan and the rule above never see one.

### Skipped top-level statements

A skipped statement is a top-level statement that cannot be lowered. The report prints the first skipped statement of a file under `skipped:`. A qualifying binding keeps its exact value even when top-level statements were skipped. The project owner decided this. Ask the project owner before changing it. Two things make it sound.

The first is how writes are handled. For every binding a skipped statement could write, functions see only the declared kind. A scan of the skipped statement finds its own declarators and assignment targets (`demoteModuleWritesInNode`), and the whole-file scan finds every other write. That alone is not enough. The initializer's own evaluation would still hold the value from before the skip, and a later analyzed statement like `const doubled = scale * 2` would compute from the outdated value and give functions a wrong `doubled`. So each skip also resets slots. Resetting a slot replaces its value with the widest value of the declared kind (`coveringKindValue`), NaN and Infinity included, and prints no `assumes` line. The reset rules are:

- Every binding that the skipped statement writes directly is reset.
- A skipped statement that can run unknown code also resets every scalar binding that has a write besides its declaration. A scalar binding holds a value that is not a record, tuple or array, e.g. a number, a boolean or a `number | null`. Such statements contain a call, a constructor, an iterator, a computed class or method name, or a similar form. Unknown code can reach the file's functions and their writes. A scalar that only top-level code assigns again is reset too, which is conservative.
- Creating an arrow function, a function expression or an ordinary object method does not run its body, so it resets no unrelated scalar.
- Every slot whose value holds a record, tuple or array is reset after every skip, because unsupported code can mutate an object or array through an alias without naming its binding, e.g. `Object.assign(config, overrides)`. The check looks at the slot's value. So a record typed through a declaration-file mapped type like `Readonly<T>`, which is classified as opaque, is reset too, while a string constant keeps its content. Such a record is reset to an opaque value. A later top-level read of one of its fields stops the initializer, and for declarations after that read functions see only the declared kind.

The second is control flow. If a skipped statement throws or never returns at runtime, the module never finishes loading. Then no exported function can ever be called, and everything the report states about them is vacuously true. The order of execution beyond that cannot matter, because the rules above already cover the effects of skipped statements.

The initializer can also stop during analysis, e.g. at a top-level call into a function that reaches unsupported code. For functions to see a binding's exact value, the binding must be initialized at every path end of the initializer, stops included. A stop records the slots as they are at that point. A declaration the analysis never reached leaves its slot uninitialized in the joined end state, and functions then see only the declared kind of that binding. No separate rule about writes after a stop is needed, because a qualifying binding has no write besides its declaration.

The analysis runs in this order:

1. The initializer runs first. Every slot starts uninitialized, except imported numeric-literal constants.
2. The slot states at all path ends of the initializer are joined (`joinModuleSlots`). A binding that is uninitialized at any path end gives functions no exact value.
3. Each function's slots then start as one of three things (`seedModuleSlots`): the exact value, the declared kind (an assumed finite number, a boolean, or a record of those, with the `assumes:` lines described above), or uninitialized. Uninitialized applies to imports other than numeric-literal constants and to bindings whose type cannot be classified. Reading an uninitialized slot stops that path, and the report says whether the binding is imported, not tracked, or not yet initialized.

A loop whose exit is never taken on any analyzed path, e.g. `for (let index = 0; true; index += 1) {}`, ends the initializer with a stop on the loop instead of a crash. Functions still see the exact values of bindings written before the loop.

### Related assumptions

Every imported module must finish initializing before analyzed code reads its runtime values. Runtime import cycles that break this are out of scope. Global objects like `Math` are also assumed unmodified: the whole-file scan looks at module bindings, not at reassignments of globals.

With runtime cycles and asynchronous initialization excluded, executing a module's top-level code consists of ordinary calls, branches, loops, and the handling of unsupported code. Reusing the normal evaluator avoids a separate module interpreter and a second copy of the semantics. Setting up module dependencies and live bindings is specific to modules, but executing their code is not.

## How should callback ordering be modeled?

Do not model callback ordering for now. A named top-level handler is analyzed as an ordinary function, from its explicit parameters and the assumptions about module bindings described above. Same-file calls inside the handler are evaluated again at each call site. Freerange has no function summaries and no model of callback sequences. Registering a callback does not make Freerange choose an execution order or execute the callback later.

Module initialization can be analyzed because its runtime order is defined. A handler analyzed by itself must not assume that a module binding still has its initial value just because initialization assigned that value earlier. The same holds for exported functions, which also run at arbitrary times after initialization.

This keeps general functions such as `render(state)` useful without knowing which events created `state`. It also avoids exploring many possible callback sequences. Analyzing a bounded sequence of callbacks that the user chooses is listed under Deferred. Reconsider it if a concrete report needs to show that a state is reachable.

## How should the scope of purity analysis be chosen?

No purity analysis exists in `src/` today. An earlier version of Freerange, from before 0.0.1 and not in this repository, had a purity analysis. When purity analysis is added, keep it much smaller than that one, unless the current version shows a concrete need.

The earlier version's rules are an upper bound, not a feature list. The analysis has changed a lot since then, so possibly none of those rules applies.

- A purity feature that the earlier version did not support must not be added.
- A feature that the earlier version supported is only a candidate.
- The project owner has the earlier rules. Ask the project owner for them, and ask before adding any purity feature.
- The project owner has said that a subset smaller than the earlier one is acceptable. Prefer the smallest subset the current analysis needs, even where the earlier version implemented a broader rule.
- Do not port the earlier purity code before purity becomes the active task.

## How are omitted arguments modeled?

A same-file call may omit an optional parameter, or a parameter with a supported literal default.

- An omitted optional parameter receives exactly `undefined`.
- A literal default is used when the argument is omitted and when the argument may be `undefined`. `null` is an ordinary argument and does not select the default.
- The check at the parameter declaration and the lowering of the call parse the default with the same function (`parameterDefaultLiteral` in `src/lower/literals.ts`). It reads the literal's runtime value, so a cast cannot make a boolean runtime value pass as a numeric default.
- Defaults that are objects, calculated values, or non-finite numbers are rejected.

The feature reuses the ordinary control flow for missing values and needs nothing new in the evaluator.

## How are requirements derived and discharged?

A requirement is discharged when the analysis proves it. A discharged requirement is not printed and is not passed to the caller.

The design in short: a requirement is created at the operation that needs it. It is simplified only where the simpler condition is exactly equivalent for floats. It is discharged only by the ordinary forward analysis, never by a solver.

A division, a remainder, or an asserted element read (`arr[i]!`) first checks its condition. A condition that is definitely false is an error at the operation. This includes a failure that comes from a same-file call, e.g. calling a function that divides by `width - 4` with `width` equal to `4`. Otherwise the operation records a requirement. The requirement is an expression over parameters, constants, arithmetic, `Math.floor`, and property paths, so it can be written only for a nameable value (defined under "How should non-finite numbers be modeled?"). Nothing works backward through the surrounding arithmetic.

A nonzero requirement is simplified only when the simpler condition is equivalent for every float, not approximately equal. `peelNonzero` in `src/requirements/infer.ts` has three rules, where `c` is a finite constant:

- `X - c is nonzero` becomes `X is not c`. For example, `total / (width - 4)` requires `width is not 4`. IEEE subtraction gives zero exactly when the operands are equal. This follows from gradual underflow: a subtraction whose exact result is tiny is computed exactly.
- `X + c is nonzero` becomes `X is not -c`, for the same reason.
- `c * X is nonzero` becomes `X is nonzero` when the magnitude of `c` is at least 1. For example, `total / (scale * 2)` requires `scale is nonzero`. A factor of magnitude at least 1 cannot underflow a nonzero product to zero. The factor is removed and simplification continues on `X`.

Two forms are not simplified:

- `total / (x * 1e-300)` requires `(x * 1e-300) is nonzero`. A small factor can underflow (`1e-200 * 1e-200 === 0`), so removing it would be wrong.
- A division is never removed from the requirement, for the same reason: `total / (x / 2)` requires `(x / 2) is nonzero`.

The test suite checks these equivalences over subnormals, boundary values, and random bit patterns (`tests/analyze-requirements.test.ts`). Every step makes the expression smaller, so simplification terminates and no limit is needed.

A condition over two unknowns prints as written: `total / (a + b)` requires `(a + b) is nonzero`, never "a is not -b". The project owner confirmed this limit: solving such conditions made an earlier version of Freerange, from before 0.0.1 and not in this repository, too expensive.

There is no general implication checking. The proof that discharges a requirement can come from four sources:

- Evaluation. A constant argument makes a divisor provably nonzero.
- Interval narrowing from a guard.
- The one excluded value that an interval cannot express (described below).
- A direct order recorded by a guard or an earlier requirement. A direct order is a recorded comparison between two specific values, e.g. `minimum <= maximum`.

A direct order names two immutable runtime values. At a join it is kept only when every incoming path has it. It is kept across a completed same-file call. It is not transferred onto a value chosen by a branch or replaced by a loop. This lets `if (minimum > maximum) return; clamp(minimum, value, maximum)` discharge the `minimum <= maximum` requirement of `clamp` without transitivity or algebraic solving.

Excluded values work as follows. `count > 0` moves the float bound to the next representable double. `count !== 0`, `width !== 4`, or the matching `===` early exit excludes one value strictly inside the bounds. A number remembers at most one excluded value. A second excluded value inside the bounds replaces the first. This loses precision but never makes a result stronger. For example, after `if (w === 4) return; if (w === 5) return`, dividing by `w - 4` requires `w is not 4` again. Excluding zero is also stored separately, as the condition that the value is nonzero (the first kind of condition listed under "Additional decisions"). Excluding another value later therefore does not lose it.

Every refinement normalizes the representation. When later bounds move the excluded value to an endpoint, the endpoint moves past that value. Writing two guards in the opposite order therefore gives the same result. Joins and widening keep an excluded value only when every incoming path excludes it.

Division uses an excluded zero. The three simplification rules above also run in the forward direction, for the same float reasons, so that the guard named by a simplified `requires` line discharges it. `width !== 4` makes `width - 4` exclude zero, `width !== -4` does the same for `width + 4`, and `scale !== 0` does the same for `scale * 2`.

A value that may be NaN takes the not-equal branch, because `NaN !== c` is true. The not-equal refinement never clears `mayBeNaN` and never prunes a branch that a NaN value can reach.

Asserted element reads follow the same pattern. `data[i]!` creates `requires: i is a valid data index` when both the array and the index are nameable over the caller's arguments. Otherwise it prints `assumes: the element read at <site> is in bounds`. The condition means an integer from 0 through `data.length - 1`. Three proofs discharge it:

- a `for...of` counter,
- an interval for the index that fits the array's length, e.g. a constant index into a tuple,
- the recorded relation `i < arr.length` for that exact array value, together with an index interval that proves an integer of at least 0.

The relation `i < arr.length` has no transitivity and no arithmetic, and at a join it is kept only when every incoming path has it. Until a read records its requirement or assumption, the proof that the index is an integer and the proof that it is at least 0 come from the index's own interval. A guard that proves the whole condition is `Number.isInteger(index) && index >= 0 && index < values.length`. A guard that checks only the range of an index that is not known to be an integer, e.g. `if (i < data.length)`, keeps the requirement.

Once an unproven read has recorded its requirement or assumption, later reads of the same array value at the same index value reuse the complete condition. This holds on that path and through a completed same-file call. Two separately written index expressions, e.g. the literal `0` twice, are separate values and each records its own requirement.

An index range that contains no valid index is rejected as provably outside the array, e.g. exactly `1.5`, `Infinity`, or `5.5..6.5` for a six-element tuple.

Separate reads of a module binding are separate values, so a relation recorded for one read does not apply to the next. Copy a module array to a local before checking and reading it: `const t = table`, then check and read `t`.

Requirements are path-insensitive by design. The project owner confirmed this. `if (flag) return a / b` requires `b is nonzero` unconditionally. Requiring more than necessary is sound: a caller that satisfies every `requires` line makes every `ensures` line hold. Requirements with conditions would multiply the number of alternatives, which this project avoids.

Writing a divisor as an expression follows the instructions that computed it. These form a tree, and a value used twice can duplicate a subtree. The walk therefore makes at most as many instruction expansions as the function has instructions. Reaching the limit produces the same `assumes: the divisor at <site> is nonzero` line as a divisor that is not nameable, or the in-bounds `assumes` line for an element read. The analysis stays sound, and a printed requirement cannot grow without bound.

## How does console.assert work?

Freerange treats a call as an assertion only when TypeScript resolves `console` to the global `console` of the configured environment. A local or imported value named `console` is not treated as an assertion. The runtime call stays ordinary JavaScript. Freerange adds only a static meaning.

Leading assertions are the `console.assert` calls at the start of a function, before any other statement. They lower into the same requirements that division and array reads use.

- `===`, `<`, `<=`, `>`, and `>=` may compare two parameters or fixed-record properties. A fixed record is an object type with a fixed set of named properties, e.g. `{width: number; height: number}`. It is not an array, a tuple, a tagged union or a nullable type.
- `!==` needs one fixed number, because the state does not keep a general "these two values differ" relation.
- A leading assertion may also require a parameter or a fixed-record property to be an integer or to be finite (`Number.isInteger`, `Number.isFinite`).
- A fixed number is a literal, or an immutable constant from the same project whose initializer chain ends in a numeric literal. Arithmetic (`2 + 3`) and reassigned bindings are rejected.
- A requirement between constants, e.g. `console.assert(6 > 5)`, is decided immediately. A true condition adds nothing. A false condition is an error.

Every assertion after the leading ones is a later assertion. A later assertion only reports a result: `proves:`, `assertion can fail:`, `assertion unproven:`, or `unreachable assertion:`. It never narrows later statements and never stops evaluation, so one failed assertion cannot hide later results.

A function that contains an assertion must finish analysis on every path, and must not need an `assumes:` line about one operation (`assumes: the element read at <site> is in bounds` or `assumes: the divisor at <site> is nonzero`). Otherwise an assertion that would have been reported as proven or unreachable is reported as `assertion blocked: the function did not finish analysis without site-specific assumptions`. This applies even when the assertion comes before the stop or the assumption. A condition already known to fail or to be unproven keeps that more specific result. This rule is deliberately simple. It replaced a trial implementation, never merged into `main`, that tracked which paths each assertion's proof covered. See "Assertions in partially analyzed functions" under Maybe Reconsider.

A syntax check on the condition runs before ordinary expression lowering. An accepted condition is then lowered like any other expression, so it follows JavaScript's evaluation order. The check allows only a small set of expressions in an assertion condition, for two reasons. First, the condition cannot contain an operation that creates a requirement. For example, `console.assert(total / count > 0)` is rejected, because the division would add `requires: count is nonzero`, the requirement that helps prove the assertion. Second, removing the assertion from a production build cannot change the program's behavior. During lowering, `removableStaticConditionInstruction` allows only constants, module reads, property and length reads, platform values, comparisons, and numeric checks.

An assertion comparison may use a proof that looks at how each compared value was computed. Ordinary branches, and the requirements created by divisions and element reads, do not use this proof. A requirement from a leading assertion uses the same proof when a call is checked. That check runs inside the callee. It sees the direct orders recorded on the caller's argument values, but not how the caller computed the arguments. For example, after `if (a > b) return`, the call `clamp(a, value, b)` proves `minimum <= maximum`. The call `clamp(a + c, value, b + c)` does not, and the caller gets `requires: (a + c) <= (b + c)`.

Ordinary analysis and assertion proofs share one definition of "the same value" (`canonicalValueIdentity`). These count as the same immutable value:

- aliases,
- repeated reads of the same property, and element reads of the same array value at the same index value,
- fields read back from a record literal built in the function,
- lengths,
- one argument passed twice through a supported same-file call.

Separate evaluations do not count as the same value, e.g. two reads of a reassigned module binding or two `performance.now()` calls.

Guards and leading assertions may also record direct orders between such values. Numeric equality between two inputs is stored as both non-strict orders (`a <= b` and `b <= a`). It therefore proves equality only where the order rules prove both directions. It does not substitute one input for the other through every operation: from `a === b`, `a - c === b - c` is proven and `a * a === b * b` is not.

Assertion proofs have these rules:

- Two direct orders apply to corresponding operands of an addition or subtraction. From `left <= right` and `lowerOffset <= upperOffset`, `left - upperOffset <= right - lowerOffset` is proven.
- Applying the same addition or subtraction to both sides weakens a strict order to a non-strict one, because floating-point rounding can make distinct inputs equal. From `a < b`, `a + c <= b + c` is proven and `a + c < b + c` is not.
- The sign of a difference is proven. Subtracting two strictly ordered representable values gives a strictly signed result, so from `a < b`, `b - a > 0` is proven.
- `Math.min` and `Math.max` results are ordered against their operands and against each other. Two `Math.min` results with the same number of operands are also compared operand by operand, in the written order: from `a <= c` and `b <= d`, `Math.min(a, b) <= Math.min(c, d)` is proven.
- Adding or subtracting a nonnegative number moves a value in the known direction: with `w >= 0`, `a + w >= a` and `a - w <= a`.
- Multiplying or dividing both sides by the same value of known sign keeps or reverses the order. A nonnegative multiplier keeps the order and a nonpositive multiplier reverses it. A positive divisor keeps the order and a negative divisor reverses it.
- A remainder is below its positive divisor.

These rules terminate without a proof-depth limit. The graph of instructions that computed the values is finite and never changes. Each rule moves from a value to its operands, which are always earlier values. Each pair of values is memoized before its operands are expanded.

`Math.min` and `Math.max` operands are expanded on only one side of a comparison. Proving `Math.max(...left) <= Math.min(...right)` would need every pairing of the two operand lists, which is unbounded, so that form stays unproven. The rules also apply through intermediate `const` values, e.g. `const low = Math.min(a, b); console.assert(low <= a)`, but there is no general transitivity: `left <= middle` and `middle <= right` do not prove `left <= right`.

None of these rules applies when a value may be NaN. Floating-point boundary tests cover infinities, subnormals, signed zero, the 2^53 rounding boundary, overflow multiplied by zero, signed multiplication and division, and positive remainder (`tests/analyze-static-assertions.test.ts`).

The implementation deliberately does not do the following:

- keep a proven later assertion as information for the code after it,
- summarize boolean helper functions,
- transfer an order onto a value chosen by a branch or replaced by a loop,
- report relationships between a return value and its arguments.

Results that follow from using one value twice, e.g. `x - x` is exactly 0 and `x <= x` is true, come from the ordinary analysis, so they also hold outside assertions. Bitwise support and callback modeling also stay outside this feature. Maybe Reconsider records the first two items of the list under "Narrowing after a proven assertion" and "Named boolean helpers in assertions".

## How are objects represented?

An object is a plain structural value: a record that holds its property values directly and nothing else. Values are immutable after construction (see "How is the accepted subset enforced?"). A record therefore keeps exactly the property values it was built with, across any amount of control flow: a loop that rebuilds state each iteration, a helper called again, or a join. There is no abstract heap, no allocation identity, and no aliasing question. Immutability makes object identity impossible to observe, so none of these is needed.

Records join property by property, by name. Only the names present on both sides are kept. Records with different properties can reach the same join, because of width subtyping. Given `const wide = {x: 2, y: 3}` and a binding `box` of type `{x: number}`, reassigning `box = wide` on one branch joins a two-property record with a one-property record. Keeping the union of names would let the report state something about a property that is sometimes absent. The plain conditional expression `flag ? {x: 1} : {x: 2, y: 3}` does not reach this join: TypeScript infers an untagged structural union for it, which is rejected.

Widening recurses into record properties, because the numbers inside a record are what can grow without bound. A loop that carries `metrics = {height: metrics.height + 1}` widens `height` at the loop header exactly like a scalar.

One known cost: two separately constructed records with equal property values cannot be told apart, so "definitely different objects" cannot be stated. Nothing observes object identity today, because `===` on objects is rejected. If object comparison ever enters the subset, the representation is the thing to revisit.

## How should analysis work scale?

Freerange does not promise the same running time as one JavaScript execution. One JavaScript run sees concrete inputs and takes one branch at a time. Freerange analyzes every supported top-level function, follows both sides of an unknown branch, and summarizes loops without executing every runtime iteration. Type classification and proof checking have no direct runtime counterpart.

Graph-based analysis should not visit the same graph node repeatedly during one traversal:

- A block runs again only when its incoming abstract state changes.
- Requirement expansion makes at most as many instruction expansions as the function has instructions.
- Assertion proofs memoize each pair of immutable values.
- Recursive type classification stores one answer per interned type and remaining depth.

These tables use cheap stable keys: value IDs and TypeScript's interned type objects. They are bounded by the source or the TypeScript type graph they traverse, and they need no invalidation.

Ordinary same-file calls use the evaluator's call stack and are not cached. A call tree that branches exponentially can therefore take exponential time in both JavaScript and Freerange. Making the application's algorithm faster is not a requirement on the analysis. If code repeats one expensive pure call with the same arguments, storing the result in a local improves both the runtime and the analysis. A future call cache must meet four conditions. There must be real code that needs the cache and that cannot be fixed by storing the result in a local. The cache key must be cheaper than the evaluation it skips. The cache must stay bounded when lookups miss. It must keep every diagnostic and caller requirement. See "Same-file call-result caching" under Maybe Reconsider.

## How should loops be analyzed?

Loops use fixed-point analysis with widening. They do not use unrolling, recurrence analysis, or collection summaries.

The convergence limit counts updates to the abstract state of one loop header, not runtime iterations. Widening makes an ordinary counting loop converge in two or three updates, however many times the loop runs at runtime. The 16-update limit (`maximumLoopHeaderUpdates`) guarantees termination when the structure grows on every update, e.g. when each iteration stores the previous record inside an `unknown` field. The report then prints `the loop at <site> did not converge after 16 updates`. A chain of more than 16 loop-carried variables, each copied from the previous one, can also reach the limit even though it would eventually stabilize. Freerange stops there; this is a known limitation. Ordinary loop-carried records widen property by property.

When a path inside a loop stops at a place from which execution could have continued to the next iteration, the loop header cannot reach its fixed point. A stop on a path that leaves the loop, e.g. `return payload + 1` inside the body with an `any`-typed `payload`, does not have this effect. A stop can also first appear on a late widening round, after earlier rounds have already passed return values downstream. Returns reachable from such a header are therefore not reported, not even under `on analyzed paths:`. Returns before the loop, or on paths that bypass it, are still reported. This deliberately also drops the result of the path where the loop body runs zero times, even when the stop existed from the first round.

## How are results reported?

Choosing a file only filters the final report. It is never an input to the analysis, so `fr [file]` prints the same lines for that file as a project run. `fr` and `fr --audit` stop on TypeScript errors before any analysis. A project run checks the whole project for TypeScript errors, and a file run checks that file. `fr` exits with a failure on error-level findings, so CI can run it. `fr --audit` is informational and fails only on TypeScript errors.

The `assumes` block lists only the inputs the function actually uses. A property path that the body never reads produces no value, so no `ensures` line depends on it and nothing is printed for it. For example, a function that only switches on `section.type` prints nothing about the arrays and numbers of the union members.

The automatic `requires: Number.isFinite(<param>)` line is deliberately different for a plain numeric parameter: it applies whether the parameter is read or not. A numeric field of a fixed-record type gets the requirement only when the field is selected (see "How is the accepted subset enforced?"). A field that is read only after the object has passed through a call, a return or an assignment is still selected on the original type. Passing an object along without reading its fields selects nothing.

Freerange leaves out only the `assumes` lines that no result depends on. An assumption that a printed result depends on always prints. For example, a function that reads `values[index]` still prints the plain-array line, which a sparse array breaks. If the unused lines were printed, a caller that passed a sparse array in an unread position would break a printed line for no reason, and the contract would no longer apply to that caller.

A combined line, e.g. `every number field of <path> used in this file is finite and not NaN`, prints only when the function reads every position the sentence covers. Otherwise the sentence would state an assumption about unread positions. In that case the read positions print one line per property instead.

Only property reads are followed this way. An element read or a `length` read counts as reading the whole array or tuple, so its lines about elements and the combined line still print. The `requires:` form of the combined line, `every number field of <param> used in this file is finite`, does not depend on what the function reads: it covers every field selected anywhere in the file.

Module bindings are filtered as a whole, after the fields of their records are selected across the file. A function that reads the binding keeps every selected line. A binding the function does not read contributes nothing.

Audit suggestions are chosen from structured requirements, assumptions, stops, and lowering reasons. When syntax alone cannot determine a rewrite that keeps the program's behavior, the audit gives no recommendation. Every snippet shown in a suggestion (`refactorGuides` in `src/audit.ts`) is analyzed in the test suite. Examples that may change behavior also have runtime tests for the stated difference (`tests/audit.test.ts`).

## Additional decisions

- Analysis runs forward. An operation creates a requirement at the place that needs it. A requirement the analysis cannot prove is passed to the caller. The report prints the guarantees the analysis inferred.
- Four kinds of condition can stay attached to a value as analysis continues (`ValueFact` in `src/engine/state.ts`): the value is nonzero; a direct order between two values, e.g. `minimum <= maximum`; an index is below one array's length; and an index is a valid index of one array. At a join, only the conditions present on every incoming path are kept. The conditions are also kept across a completed same-file call. There is no implication search and no transitivity.
- Each CFG block keeps one merged abstract state. Freerange does not keep a separate state for every path.
- Block parameters carry values across branches and loops.
- Branch narrowing handles only the condition forms listed here and goes no deeper.
  - A branch on a single comparison narrows the comparison's two direct operands. It may also record their direct order.
  - A branch on a single null check narrows the checked value.
  - Nothing works backward through arithmetic: `x * 2 > 4` does not narrow `x`.
  - Compound `if` conditions need no deeper narrowing, because lowering splits them. In statement position, `&&`, `||` and `!` become short-circuit control flow. So `if (x !== null && x > 0)` is two chained branches, each on a single check, which is the same CFG as two nested `if` statements. The condition of a `?:` expression is split the same way, so `a > 0 && b > 0 ? a / b : 0` narrows `a` and `b` exactly as the `if` form does.
  - A single comparison stored in a boolean does narrow. In `const ok = count > 0; if (ok)`, the branch condition resolves to the comparison instruction that computed `ok`. The guard therefore discharges a divisor requirement, as `if (count > 0)` does.
  - A stored compound condition does not narrow. In `const ok = a > 0 && b > 0; ok ? a / b : 0`, the value of `ok` is a join of two branches, not a comparison.
  - A null check on a property read, e.g. `if (box.width !== null)`, narrows the property inside the record. This is sound because values are immutable.
  - The project owner is wary of anything deeper. Ask the project owner before adding it. The two soundness bugs found so far in branch narrowing were both in this code: a branch was pruned although an operand could be NaN, and the false branch was narrowed although an operand could be NaN.
- Reaching a limit must make a result less precise or stop the path. It must never make a result stronger. Each limit below says what happens when it is reached.
  - A loop header gets 16 updates (`maximumLoopHeaderUpdates`). Reaching the limit records a stop. Freerange never reports a state as a fixed point when it is not one.
  - Type walks stop at depth 8. A cut can make a nested property opaque or reject a root type. Without this limit, a deeply nested declared type could print an unbounded number of `assumes:` lines.
  - Writing a requirement as an expression makes at most as many instruction expansions as the function has instructions. Reaching the limit falls back to an `assumes:` line for that one operation.
  - The proofs that only `console.assert` uses, which look at how each compared value was computed, need no limit. The graph of instructions that computed the values is finite and never changes, and each pair of values is memoized before recursion.
  - An abstract number keeps at most one excluded value. Excluding a second value can lose precision but cannot make a result stronger.
- Browser behavior comes from static models (`src/lower/platform.ts`). Freerange never runs a browser to measure values.
- An `unsupported:` line may include a short hint that says when a rewrite may suit, e.g. `a for loop may suit simple dense-array aggregation`. Full examples and warnings about behavior changes stay in `refactorGuides` in `src/audit.ts`. This keeps the report text from implying that rewriting the syntax is always safe.
- Recursive type classification uses four bounded memo tables. `declaredKind` and `valueKind` are keyed by the checker's interned type plus the depth. `nonMissingUnionMembers` is keyed by the interned union type. `taggedUnionProperty` is keyed by the stable member array plus the depth. This is the kind of cache `engineering.md` allows: checker types are immutable for the life of the program, each table holds at most one entry per distinct input, and no invalidation is needed. Types are first seen while lowering expressions, so each table is also the only place its result is computed, not a copy of another result.
- Stable numeric IDs identify functions, blocks, values, lowered operations with their source locations (`SiteID`), and module bindings (`src/ir/ids.ts`). Effects are not modeled, so they have no IDs.
- Values with different lifetimes are stored separately, not in one generic map. Local values are indexed by `ValueID` and module bindings by `ModuleBindingID` (`ExecutionState` in `src/engine/state.ts`). Platform values are not stored: each read produces a fresh value. There are no heap objects, because records are immutable values.
- Freerange has one lowering pipeline and one evaluator. Module initialization runs through the same evaluator as functions. If callbacks are ever supported, they should use it too.

## Maybe Reconsider

Each entry below was tried or proposed, and did not show enough value on its own to ship. The trial implementations were not merged into `main`. Their sizes and measurements are recorded only as reasons for the decision. Several entries mention results on Pretext. Those results are observations and cannot be reproduced from this repository. Reopen an entry when the evidence it asks for appears.

Observed usage is evidence, not the feature specification. Do not add rules for the exact expressions that one code base contains. Do not reject a small, general rule only because one call site needs it. Prefer a small written subset whose behavior is complete and predictable. Use analyzed code to find missing categories, and describe the edge of the supported subset without referring to that code.

- Narrowing after a proven assertion. Today a proven assertion does not narrow the statements after it (see "How does console.assert work?"). For example, `if (a >= b) return 0; const d = b - a; console.assert(d > 0); return 1 / d` prints `proves: d > 0` and still prints `requires: (b - a) is nonzero`. A trial implementation of about 33 net lines worked, but changed no Pretext result. Reconsider when real code would otherwise repeat a guard after an assertion, or lose a useful guarantee after it.
- Named boolean helpers in assertions. Today `console.assert(isValidLayout(frame))` is rejected: an assertion condition may call only `Number.isInteger`, `Number.isFinite` and `Number.isNaN`. A trial implementation worked out what a `true` result of a supported same-file helper proves about its arguments, and used that in the assertion. It took about 183 net production lines and changed no Pretext report. Reconsider when a real property is much clearer as `console.assert(isValidLayout(frame))` than as direct comparisons. That case must justify the cost of explaining what a `true` helper result proves about its arguments.
- Assertions in partially analyzed functions. Today a function that stops on some path, or that needs an `assumes:` line about one operation, blocks its proven assertions (see "How does console.assert work?"). A trial implementation tracked which paths each assertion's proof covered. It distinguished assertions before and after unsupported code, assertions beside a branch that returns, and assertions in later loop iterations. Reconsider when an important property naturally sits before an unsupported operation that cannot be avoided.
- Object spread. Today it is rejected: `unsupported: object spread (list every field explicitly, e.g. {gain: config.gain})`. A trial implementation accepted spread only from a record it could trace to a local object literal, because such a record is known to have own properties. It rejected records that come from outside the analyzed code: their declared properties may live on a prototype, and spread does not copy those. The tracing rules changed no contract in the demo (`demo/`) or in Pretext. Reconsider when listing every field is clearly awkward in real analyzed code. Do not extend the rule to records from outside the analyzed code without a different model of those objects.
- Direct inline collection callbacks. Today `.map` and the other array methods are rejected. [Toward Programming Languages for Reasoning: Humans, Symbolic Systems, and AI Agents](https://arxiv.org/abs/2407.06356) avoids primitive loops in its core language. It provides fixed collection operations that take restricted lambdas: a lambda appears directly as an argument, cannot be stored or returned, and cannot modify captured arguments. If this feature returns, Freerange should follow the same restriction and not add general callback execution. Accept only a small named set of built-in operations. Require an inline, supported callback with no mutable captures and no writes. Give each operation fixed rules, e.g. `map` keeps the input length, and `filter` returns a length from zero through the input length. A trial `map` implementation of roughly 216 lines made two Pretext functions fully analyzed and one partially supported. Only one of them gained a clearly useful numeric contract. Reconsider when analyzed code has a numeric mapping whose useful result cannot be written cleanly as an extracted helper or an explicit loop.
- JavaScript's 32-bit bitwise operators and `Math.imul`. Today they are rejected, e.g. `unsupported: binary operator |`. A trial implementation modeled their signed and unsigned results consistently, shifts included. Reconsider when a real hash, mask, color or index calculation needs a checked property. Do not add them only to accept more syntax.
- One bounded relation that says two exact values differ. Today `if (a === b) return 0; return 1 / (a - b)` still prints `requires: (a - b) is nonzero`. The relation would prove a subtraction nonzero after a check that its two operands differ, and the design can stay small. The current way to write it is to name the difference and check that value: `const d = a - b; if (d === 0) return 0; return 1 / d` needs no requirement. Reconsider when that form is clearly worse code.
- Function contracts (also called procedure specifications) for imported functions. Today a call to an imported function is rejected, so every function that calls one is reported as `unsupported`. A separate file, similar to a `.d.ts` file, could state `requires` and `ensures` for an imported function. It would use the same small condition language as `console.assert`, and Freerange would compile the declarations into function summaries. The author of the imported module should verify the implementation against the contract when the source is available. Otherwise the report must show consumers that the contract is assumed, not proven. Pretext's text-measurement functions are a concrete candidate, because layout code that calls them cannot be analyzed. Build a trial implementation only when imported numeric helpers block a specific proof. Decide representation, validation and bounded caching together.
- Same-file call-result caching. Today calls are not cached (see "How should analysis work scale?"). A trial implementation kept one cache entry per callee. It sped up the case where the same call is reached again through different callers, which is also exponential in JavaScript. It did not bound calls whose arguments change. Its cache key compared arguments deeply, and that made 1,000 trivial calls that pass an ignored 500-field record grow from about 1ms to 162ms. Reconsider only with a real workload, a key cheaper than the call it skips, and a test where most lookups miss the cache and that does not get slower.

## Deferred

- Searching for a concrete counterexample and replaying it.
- Deriving requirements from whether the final result is affected. Requirements are currently created at the operation that needs them. So a division or remainder whose bad result never reaches the return value still reports a requirement.
- Printing values at a stop, e.g. that `width` was 100. Also recovering the returns that are not reported when a stop happens inside a loop (see "How should loops be analyzed?").
- Callback ordering and the execution of callback sequences, including a bounded sequence of callbacks that the user chooses.
- A relational numeric domain beyond the four kinds of condition listed under "Additional decisions", and recurrence analysis for loops. Loops currently use widening only.
- Modeling caught exceptions. `throw` is supported as the end of a path. A path that throws contributes nothing to the result, which is exact as long as the subset has no `catch`. A guard clause such as `if (bad) throw new Error(...)` therefore discharges requirements. A function annotated `: never` that throws on every path is analyzed, and callers treat a call to it like an inline `throw`. `try`/`catch` is rejected, because supporting it means modeling how exceptions flow.
- Reporting every unsupported construct in a function. Today only the first is reported.
- Naming a tuple position in a requirement. For a `[number, number]` parameter, `pair[0] / pair[1]` prints `assumes: the divisor at <site> is nonzero`, because the requirement language has property paths but no form for an element. The caller cannot satisfy an `assumes:` line the way it can satisfy a `requires:` line. A later division by the same element value reuses the assumption, e.g. an element kept in a local, or a read through the same index value such as `const i = 1` and then `pair[i]` twice. Writing `pair[1]` a second time is a separate read: it prints a second line, and a guard on one `pair[1]` does not cover another. The workaround is a local copy: `const divisor = pair[1]; if (divisor !== 0) { ... / divisor }`. Separate reads of a module binding are separate values and need the same local copy.
- Representing a value that is definitely NaN. The number domain always holds a numeric interval plus `mayBeNaN`. An expression such as `0 * Infinity` is therefore represented conservatively as any number or NaN, not as NaN alone. As a result, an asserted read that can never be in bounds, e.g. `values[0 * Infinity]!`, prints a requirement when it should be rejected. Reconsider only with a real example, because a NaN-only value affects every numeric operation, not only indexes.
- Naming a value defaulted with `??` in a requirement. `const actual = divisor ?? 4; total / actual` prints `assumes: the divisor at <site> is nonzero`. The result of `??` is a join of two branches, held in a block parameter. The requirement language has no form for a fallback and cannot refer to block parameters. Guarding and then dividing, `if (divisor !== null) total / divisor`, does create the requirement `divisor is nonzero`.
- Narrowing a copy that was built earlier. After `const copy = {columns: grid.columns}`, the guard `if (grid.columns >= 1)` does not narrow the interval of `copy.columns`. The reverse works, because `copy.columns` is the exact read that was stored when `copy` was built. Narrowing records built earlier needs an index of every place a value was copied, which branch narrowing does not have. Guard before copying.
- `.map`, `.push` and array spread. A simple aggregation over a dense array can be rewritten as an explicit loop. A loop is not always an exact replacement, because `.map` and the other callback methods differ from a loop in ways the syntax does not show. For example, `.map` skips the holes of a sparse array, and passes the index and the array to its callback. Sparse arrays are not deferred: they are rejected on purpose (see "Working agreement").
- Narrowing through a stored compound condition, e.g. `const ok = a > 0 && b > 0; if (ok)`. See branch narrowing under "Additional decisions".
- Record and tuple parameter types beyond the ones that classification accepts today (see "How is the accepted subset enforced?" and "How are arrays represented?").
- Properties whose declared type mixes kinds, e.g. `{x: number | boolean}` written with a number on one path and a boolean on another. The join drops such a property, and reading it is rejected anyway. What the report states about the rest of the record still holds.
- In-place object mutation. It was supported once: property writes on locals and parameters, with a strong update when the target was a single known object and a weak (joining) update when the target came from a join or stood for several objects. A write to a parameter printed as an `ensures:` line. Restoring it is not a small addition. Records are now plain immutable values, and the abstract heap and allocation identities that mutation needed were deleted. Supporting mutation again means rebuilding the abstract heap and allocation identities, not adding one instruction. The project owner approved this trade-off. A cheaper partial option, if only building a local object step by step is missed: mutation of a local that provably has no alias and does not escape can be lowered to rebinding each field. That needs about 80 lines of escape checking and no heap.
- Exact values of module-level objects and arrays in partially analyzed files. Today, if a file contains a function that could not be lowered or a skipped top-level statement, functions see only the declared kind of every module binding that holds a record, tuple or array. This includes nullable ones such as `number[] | null`. A binding typed through a mapped type such as `Readonly<T>` becomes opaque, so reading it stops the path. The reason is that unanalyzed code can modify an object or array through an alias that the scan for writes cannot see. For example, `Object.assign(config, ...)` has the binding as an argument, and `queue?.push(x)` has it as the receiver. A more precise rule is possible: apply this only to bindings whose identifier or alias reaches unanalyzed code.
- Runtime import cycles and top-level `await` (see "How should module initialization be modeled?").
- Termination proofs and `decreases` clauses.
- A general method for discovering loop invariants.
- The representation of symbolic arithmetic, of branch conditions, and of requirements with alternatives, and the limits on their growth.
- Recursion and more precise widening. A recursive call stops the path, and the function reports `partially supported: recursive call to <name>`. Widening moves a growing bound directly to the largest finite number, or to infinity when the value may already be non-finite. Anything more precise is deferred.
- Purity features beyond the small subset that the current version turns out to need (see "How should the scope of purity analysis be chosen?").
