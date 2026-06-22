# Purity

`pure` is a checked guarantee about what a function reads and changes.

```ts
/** @fit
 * pure
 */
function widthWithPadding(width: number, padding: number) {
  return width + padding * 2
}
```

Writing `pure` is optional. Freerange still checks an unannotated helper before using that helper in a contract. The annotation is useful when purity itself should be preserved as the function changes.

`pure` belongs in the function's `@fit` block. It does not apply to a loop, type, parameter, or local value.

## What Pure Means

A pure function:

- does not mutate its parameters or `this`
- does not mutate values declared outside the function
- does not read outside values that other code can change
- does not perform I/O or read the clock or randomness
- calls only functions and built-ins whose behavior Freerange can check

The function may create and mutate local values:

```ts
/** @fit
 * pure
 */
function makeRow(height: number) {
  const rows: {height: number}[] = []
  rows.push({height})
  return rows
}
```

Creating objects and arrays is allowed. Throwing a parameter, local value, or literal is also allowed. `throw new Error(...)` currently fails the purity check because Freerange treats the global `Error` binding as mutable outside state. Purity does not mean that the function always returns, or that its return value is immutable.

Changing a value that existed before the call is not allowed:

```ts
/** @fit
 * pure
 */
function clearRow(row: {height: number}) {
  row.height = 0
}
```

The `pure` check fails because `clearRow` mutates its `row` parameter.

## Copies And References

Freerange follows references through objects, arrays, assignments, destructuring, function arguments, and return values. A new container may still contain an existing object.

For example, `slice()` creates a new array but keeps the same row objects:

```ts
/** @fit
 * pure
 */
function addEmptyRow(rows: {height: number}[]) {
  const copy = rows.slice()
  copy.push({height: 0})
  return copy
}
```

Pushing onto `copy` changes only the new array. Changing a row inside `copy` changes the caller's row:

```ts
/** @fit
 * pure
 */
function clearFirstCopiedRow(rows: {height: number}[]) {
  const copy = rows.slice()
  copy[0]!.height = 0
  return copy
}
```

The `pure` check fails because `copy[0]` still refers to an object from `rows`.

Returning an existing value is pure by itself:

```ts
function firstRow(rows: {height: number}[]) {
  return rows[0]!
}
```

The returned row still refers to the caller's row. Mutating it makes the calling function impure:

```ts
/** @fit
 * pure
 */
function clearReturnedRow(rows: {height: number}[]) {
  firstRow(rows).height = 0
}
```

The `pure` check fails because `firstRow(rows)` returns an object from `rows`.

The same distinction applies to a new object that contains a parameter. Replacing a field on the new object is local; changing the parameter through that field is not.

## Values Outside The Function

A top-level `const` primitive is stable enough to read:

```ts
const maxHeight = 100

/** @fit
 * pure
 */
function clampHeight(height: number) {
  return Math.min(height, maxHeight)
}
```

An object can change even when its binding uses `const`, so reading through a top-level object is impure:

```ts
const limits = {maxHeight: 100}

/** @fit
 * pure
 */
function clampHeight(height: number) {
  return Math.min(height, limits.maxHeight)
}
```

The `pure` check fails because another function can change `limits.maxHeight` between calls.

Top-level `let` and `var` values are also mutable outside state. Freerange treats static class properties as mutable outside state too, including `static readonly` properties. Imported `const` primitives are allowed, including primitives declared without implementation source.

## Calls And Callbacks

Purity is transitive. A function is impure when one of its calls is definitely impure:

```ts
function randomHeight() {
  return Math.random() * 100
}

/** @fit
 * pure
 */
function makeRow() {
  return {height: randomHeight()}
}
```

The `pure` check fails because `randomHeight` reads randomness.

Freerange follows function declarations, top-level arrow functions, aliases, and imports whose TypeScript source is available. The called functions do not need their own `pure` annotation.

Callbacks use the same rules. Mutating a local captured by a callback is allowed; mutating an argument is not:

```ts
/** @fit
 * pure
 */
function countVisibleRows(rows: {visible: boolean}[]) {
  let count = 0
  rows.forEach(row => {
    if (row.visible) count++
  })
  return count
}
```

```ts
/** @fit
 * pure
 */
function clearRows(rows: {height: number}[]) {
  rows.forEach(row => {
    row.height = 0
  })
}
```

The `pure` check fails because the callback mutates objects from `rows`.

Callback checks include the callback's parameters, captured values, and `this`. An impure comparator makes `sort` or `toSorted` impure. `sort` also mutates the array it is called on.

## Pure, Impure, Or Unknown

Freerange reports three results for a `pure` annotation:

- `PASS`: the function is pure
- `FAIL`: the function definitely mutates an existing value, reads mutable outside state, performs I/O, reads the clock or randomness, or calls something definitely impure
- `UNKNOWN`: Freerange cannot determine what a call or operation may do

An unavailable function body is unknown rather than impure:

```ts
declare function externalHeight(): number

/** @fit
 * pure
 */
function readHeight() {
  return externalHeight()
}
```

The `pure` check is `UNKNOWN` because Freerange cannot analyze `externalHeight`'s body.

Calls through function parameters are also unknown. Freerange does not yet analyze user-defined class constructors, instance or static methods, getters, or setters for purity. Constructors also run base constructors and field initializers, while instance methods and property access can use implementations that are not known from the call alone.

Some built-ins stay unknown because they can run user code in ways Freerange does not yet describe. Examples include `JSON.stringify` calling a getter or `toJSON`, `Array.from` calling an iterator or mapper, and `sort()` without a comparator converting values to strings.

Freerange keeps the explanation when an unknown or impure call appears inside another helper, so the final report names the original operation.

## Purity And Interpretation

Purity only checks what a function reads and changes. It does not mean that Freerange can interpret the function's result.

For example, `includes` does not mutate its array or observe outside state, so `contains` is pure:

```ts
function contains(values: number[], selected: number) {
  return values.includes(selected)
}
```

Freerange does not currently interpret `includes`. A contract that calls `contains` is therefore unknown even though the purity check passes:

```ts
/** @fit
 * return == contains(values, selected)
 */
function checkedContains(values: number[], selected: number) {
  return contains(values, selected)
}
```

A function called from a contract must pass both checks: the function must be pure, and Freerange must be able to interpret the call well enough to check the contract.
