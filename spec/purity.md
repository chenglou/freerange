# Purity

## Boundary

### Accepted

- Reading arguments and local variables
- Reassigning local and parameter variables
- Mutating data created during the current call (including a rest parameter array) when we can identify what is being changed without remembering how individual fields or entries changed over time:
  ```ts
  function incrementProcessedCount(selectedRow: {height: number}) {
    const tableState = {selectedRow, processedCount: 0}
    tableState.processedCount++ // unrelated to selectedRow, ok
    return tableState.processedCount
  }
  ```
- Reading top-level `const` primitive values
- Calling functions whose bodies we can find and check using these rules: named functions with TypeScript source, functions stored in const, immutable aliases, imports with TypeScript source, inline callbacks, or synchronous IIFEs
- Calling functions with spread arguments when the called functions don't mutate their parameters or store references received through said params
- Calling nested functions that follow the same rules. Additionally, they may mutate closure values created inside the checked function
- Unused nested functions
- Array destructuring, spread, and `for-of` over values with known built-in iterators
- `sort` and `toSorted` when the call satisfies these rules and provides an explicit comparator

### Fails

`FAIL` means the function has behavior that violates purity

- Mutating data traceable to an argument or mutable state outside the checked function, including through a supported helper or local container:
  ```ts
  function clearSelectedRow(selectedRow: {height: number}) {
    const tableState = {row: selectedRow}
    tableState.row.height = 0 // FAILS
  }
  ```
- Reading mutable values declared outside the checked function
- I/O, clock access, and randomness
- Calling a function known to do any of the above
- Throwing, e.g. `JSON.parse`

### Unknown

`UNKNOWN` means the function may be pure, but we intentionally stop before doing the more detailed analysis needed to decide

- Any use of `this`
- Calls whose function body cannot be determined (e.g. third-party code with `.d.ts` but no source)
- Functions reached through mutable bindings, object or array properties, conditional expressions, or another function's return value
- Async functions, generators, and calls through `call`, `apply`, or `bind`
- Recursive and mutually recursive functions
- User constructors, methods, getters, and setters
- Mutating data whose source we cannot determine, including when determining the source would require remembering how individual fields or entries changed over time:
  ```ts
  function replaceSelectedRow(selectedRow: {height: number}) {
    const tableState = {row: selectedRow}
    tableState.row = {height: 0} // ok
    tableState.row.height++ // UNKNOWN: supporting this generally would require remembering field replacements through branches and loops
  }
  ```
- `try`/`catch`
- Labeled control flow
- Array destructuring, spread, and `for-of` when the source may use a custom iterator
- Calls with spread arguments when Freerange cannot determine which spread element the called function mutates or stores
- Implicitly converting an object to a string, e.g. `` `${user}` `` or `"User: " + user`, because the conversion may call user code. This includes `sort` and `toSorted` without a comparator
- Built-ins whose relevant behavior Freerange does not model, including `Array.from` and `JSON.stringify`

## Notes

We track all possible origins of a function's returned object or array, but not the conditions under which each origin is returned. The returned container may be new, may be one or more of said function's arguments, or may have an unknown origin. If the returned container contains composite values, we don't track their origins. Examples:

```ts
function updateRows(rows: Row[], newRow: Row, shouldCopy: boolean) {
  copyArray(rows).push(newRow) // accepted
  maybeCopy(rows, shouldCopy).push(newRow) // FAILS when maybeCopy may return rows
  copyArray(rows)[0]!.height = 0 // UNKNOWN
}
```

We assume:
- No runtime getters or setters hidden behind ordinary property types. We reject getters and setters visible in TypeScript source or type declarations
- No proxies
- No subclasses that override built-in behavior after being passed as the built-in base type
- No runtime overrides of built-in methods
