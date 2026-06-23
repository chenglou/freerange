# Purity

## Boundary

### Accepted

- Reading arguments and local variables
- Reassigning parameter variables
- Creating and mutating local objects and arrays, including e.g. `copyArray(rows).push(newRow)`, where `rows` is an argument
- Reading top-level `const` primitive values
- Calling a function whose body Freerange can identify: a function declaration, a `const` function binding, an immutable alias, an import with TypeScript source, an inline callback, or a synchronous IIFE

### Fails

- Changing an object Freerange can trace to an argument, directly or through a supported helper, e.g. `identity(rows).push(newRow)`, where `rows` is an argument
- Reading or changing mutable values declared outside the checked function
- I/O, clock access, and randomness
- Calling a function known to do any of the above
- Throwing

### Unknown

- Any use of `this`
- Calls whose function body cannot be determined (e.g. third-party code with `.d.ts` but no source)
- Functions reached through mutable bindings, object or array properties, conditional expressions, or another function's return value
- Async functions, generators, and calls through `call`, `apply`, or `bind`
- Recursive and mutually recursive functions
- User constructors, methods, getters, and setters
- Changing an object inside a new object or array returned by a function, e.g. `copyArray(rows)[0]!.height = 0`, where `rows` is an argument
- Changing a value returned by a function that may return either a new value or an argument, e.g. `maybeCopy(rows, shouldCopy).push(newRow)`
- Replacing an object or array inside a local container that also contains an argument, e.g. `holder.row = {height: 0}` after `const holder = {row}`, because Freerange does not track individual object fields or array slots
- Changing a local container that also contains an argument from a nested function, because Freerange does not track which field the nested function changes
- Using an object or array after a nested function reassigns its binding, because Freerange does not track the replacement across the function call
- Calling a helper that stores an existing object or array in one of its parameter containers
- `try`/`catch`
- Labeled control flow

## Notes

`FAIL` means Freerange found behavior that violates purity. `UNKNOWN` means the function may be pure, but Freerange cannot check it. Both prevent a `pure` annotation from passing.

Freerange tracks whether a returned object or array is new or is an argument. It does not track whether objects inside the returned value came from an argument, so changing those objects is `UNKNOWN`.

Supported built-ins follow the same purity rules above. A built-in without a purity rule is `UNKNOWN`.

Freerange assumes that values with built-in types use their ordinary built-in behavior. It does not account for proxies, a subclass widened to its built-in base type, or code that replaces a built-in method.

Nested functions inside the checked function are transitively checked using the same rules, except that they're allowed to mutate closure values created inside the checked function.
