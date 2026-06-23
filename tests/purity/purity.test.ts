// Pure-function classification. Each case is source -> pure | impure | unknown,
// with no interpreter run or proof needed.
import {describe, setDefaultTimeout, test} from 'bun:test'
import {readTopLevelGlobal} from '../../src/check-core.ts'
import {functionImplementationReference} from '../../src/function-shape.ts'
import {functionEffects, functionPurity, type Purity} from '../../src/interpreter/function-effects.ts'
import {buildFitSourceFile, loadFitProject} from '../../src/modules.ts'
import {verifyFitFiles, verifyFitSource} from '../../src/reports.ts'
import {
  contractRejectsImportedAlias,
  contractUsesImportedCallbackAfterMap,
  contractUsesImportedAlias,
  importedAliasImpure,
  importedAliasPure,
  importedDefaultAliasPure,
  importedNamespaceImpure,
  importedNamespacePrimitivePure,
  importedNamespacePure,
  importedNamespaceReassignedUnknown,
  importedNamedCallbackKeepsSourceProgram,
  importedPrimitivePure,
} from './imported-caller.ts'
import {requiredCheck, testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

void contractRejectsImportedAlias
void contractUsesImportedCallbackAfterMap
void contractUsesImportedAlias
void importedAliasImpure
void importedAliasPure
void importedDefaultAliasPure
void importedNamespaceImpure
void importedNamespacePrimitivePure
void importedNamespacePure
void importedNamespaceReassignedUnknown
void importedNamedCallbackKeepsSourceProgram
void importedPrimitivePure

function purityOf(name: string, source: string): Purity {
  const program = buildFitSourceFile('purity.ts', source, readTopLevelGlobal)
  const fn = program.functions.get(name)
  if (fn == null) throw new Error(`no function ${name} in source`)
  return functionPurity(functionImplementationReference(program, fn.node))
}

describe('purity', () => {
test('classifies the supported boundary', () => {
const cases: {label: string; source: string; kind: Purity['kind']; reasonIncludes?: string}[] = [
  // Accepted operations.
  {label: 'reads and reassigns parameters', kind: 'pure', source: `function f(value: number) { value += 1; return value }`},
  {label: 'creates and mutates a local array', kind: 'pure', source: `function f(value: number) { const values: number[] = []; values.push(value); return values.length }`},
  {label: 'creates and mutates a local object', kind: 'pure', source: `function f(value: number) { const box = {value: 0}; box.value = value; return box.value }`},
  {label: 'reads a top-level const primitive', kind: 'pure', source: `const limit = 10\nfunction f(value: number) { return Math.min(value, limit) }`},
  {label: 'reads a top-level const symbol', kind: 'pure', source: `const marker: symbol = Symbol('marker')\nfunction f() { return marker }`},
  {label: 'calls a function declaration', kind: 'pure', source: `function double(value: number) { return value * 2 }\nfunction f(value: number) { return double(value) }`},
  {label: 'calls a top-level const function', kind: 'pure', source: `const double = (value: number) => value * 2\nfunction f(value: number) { return double(value) }`},
  {label: 'calls an immutable alias', kind: 'pure', source: `function double(value: number) { return value * 2 }\nconst twice = double\nfunction f(value: number) { return twice(value) }`},
  {label: 'calls a local const function', kind: 'pure', source: `function f(value: number) { const double = (input: number) => input * 2; return double(value) }`},
  {label: 'calls a nested function declaration', kind: 'pure', source: `function f(value: number) { function double(input: number) { return input * 2 } return double(value) }`},
  {label: 'local function changes a local closure value', kind: 'pure', source: `function f() { let count = 0; const increment = () => count++; increment(); return count }`},
  {label: 'calls a synchronous IIFE', kind: 'pure', source: `function f(value: number) { return ((input: number) => input * 2)(value) }`},
  {label: 'uses a pure inline callback', kind: 'pure', source: `function f(values: number[]) { return values.map(value => value * 2).length }`},
  {label: 'uses a pure named callback', kind: 'pure', source: `function double(value: number) { return value * 2 }\nfunction f(values: number[]) { return values.map(double).length }`},
  {label: 'uses a top-level const callback', kind: 'pure', source: `const double = (value: number) => value * 2\nfunction f(values: number[]) { return values.map(double).length }`},
  {label: 'uses an immutable callback alias', kind: 'pure', source: `const double = (value: number) => value * 2\nconst twice = double\nfunction f(values: number[]) { return values.map(twice).length }`},
  {label: 'uses a supported built-in callback', kind: 'pure', source: `function f(values: number[]) { return values.every(Number.isFinite) }`},
  {label: 'uses an aliased supported built-in callback', kind: 'pure', source: `const finite = Number.isFinite\nfunction f(values: number[]) { return values.every(finite) }`},
  {label: 'keeps named array methods after a numeric element write', kind: 'pure', source: `function replace(values: number[], index: number) { values[index] = 1 }\nfunction f(values: number[]) { return values.includes(1) }`},
  {label: 'callback changes a local closure value', kind: 'pure', source: `function f(values: number[]) { let count = 0; values.forEach(() => count++); return count }`},
  {label: 'unused impure closure does not run', kind: 'pure', source: `function f() { const random = () => Math.random(); return 1 }`},
  {label: 'mutates the outer container returned by slice', kind: 'pure', source: `function copyArray(values: number[]) { return values.slice() }\nfunction f(values: number[]) { return copyArray(values).push(1) }`},
  {label: 'keeps a new outer container through two helpers', kind: 'pure', source: `function copyArray(values: number[]) { return values.slice() }\nfunction relay(values: number[]) { return copyArray(values) }\nfunction f(values: number[]) { return relay(values).push(1) }`},
  {label: 'mutates the outer container returned by map', kind: 'pure', source: `function f(values: number[]) { const copies = values.map(value => ({value})); copies.push({value: 1}); return copies.length }`},
  {label: 'uses a numeric comparator with toSorted', kind: 'pure', source: `function f(values: number[]) { return values.toSorted((left, right) => left - right).length }`},
  {label: 'uses a shadowed undefined comparator with toSorted', kind: 'pure', source: `function f(values: number[]) { const undefined = (left: number, right: number) => left - right; return values.toSorted(undefined).length }`},
  {label: 'for-of over an array uses the built-in iterator', kind: 'pure', source: `function f(values: number[]) { let total = 0; for (const value of values) total += value; return total }`},
  {label: 'destructures ordinary data', kind: 'pure', source: `function f({nested: {value}}: {nested: {value: number}}) { return value }`},
  {label: 'replaces a parameter before mutating it', kind: 'pure', source: `function f(row: {height: number}) { row = {height: 0}; row.height = 1 }`},
  {label: 'replaces a parameter in every branch before mutating it', kind: 'pure', source: `function f(row: {height: number}, flag: boolean) { if (flag) row = {height: 0}; else row = {height: 1}; row.height = 2 }`},
  {label: 'replaces a parameter in every switch path before mutating it', kind: 'pure', source: `function f(row: {height: number}, mode: number) { switch (mode) { case 0: row = {height: 0}; break; default: row = {height: 1} } row.height = 2 }`},
  {label: 'replaces a parameter in a do-while body before mutating it', kind: 'pure', source: `function f(row: {height: number}, flag: boolean) { do { row = {height: 0} } while (flag); row.height = 1 }`},
  {label: 'passes a replacement to a mutating helper', kind: 'pure', source: `function setHeight(row: {height: number}) { row.height = 1 }\nfunction f(row: {height: number}) { row = {height: 0}; setHeight(row) }`},
  {label: 'captures a replacement in a local function call', kind: 'pure', source: `function f(row: {height: number}) { row = {height: 0}; const setHeight = () => row.height = 1; setHeight() }`},
  {label: 'reassigns a parameter from a local function', kind: 'pure', source: `function f(row: {height: number}) { const replace = () => row = {height: 0}; replace(); return row.height }`},
  {label: 'returns a replacement from a helper', kind: 'pure', source: `function replace(row: {height: number}) { row = {height: 0}; return row }\nfunction f(row: {height: number}) { replace(row).height = 1 }`},
  {label: 'mutates a fresh object returned by a helper', kind: 'pure', source: `function copyRow(row: {height: number}) { return {height: row.height} }\nfunction f(row: {height: number}) { copyRow(row).height = 1 }`},
  {label: 'replaces a parameter in an endless loop before breaking', kind: 'pure', source: `function f(row: {height: number}) { for (;;) { row = {height: 0}; break } row.height = 1 }`},
  {label: 'stores an argument in an initially empty local holder', kind: 'pure', source: `function f(row: {height: number}) { const holder: {row: {height: number} | null} = {row: null}; holder.row = row }`},
  {label: 'keeps unrelated local allocations separate', kind: 'pure', source: `function f(row: {height: number}) { const holder = {row}; const other = {child: {height: 0}}; other.child.height = 1; return holder.row.height }`},
  {label: 'keeps a whole-container reassignment separate from its old value', kind: 'pure', source: `function f(row: {height: number}) { let holder = {row}; holder = {row: {height: 0}}; holder.row.height = 1 }`},
  {label: 'ignores unreachable effects after return', kind: 'pure', source: `function f() { return 1; Math.random() }`},
  {label: 'ignores an unreachable return when describing a helper result', kind: 'pure', source: `function fresh(row: {height: number}) { return {height: 0}; return row }\nfunction f(row: {height: number}) { fresh(row).height = 1 }`},
  {label: 'checks all case expressions before entering a default clause', kind: 'impure', source: `function f(row: {height: number}, mode: number) { switch (mode) { default: row = {height: 0}; break; case (row.height = 1): break } }`},

  // Definite violations.
  {label: 'changes an argument object', kind: 'impure', source: `function f(row: {height: number}) { row.height = 0; return 1 }`},
  {label: 'changes an argument array', kind: 'impure', source: `function f(values: number[]) { values.push(1); return values.length }`},
  {label: 'sorts an argument with a numeric comparator', kind: 'impure', source: `function f(values: number[]) { values.sort((left, right) => left - right); return values.length }`},
  {label: 'changes an argument through a local wrapper', kind: 'impure', source: `function f(row: {height: number}) { const holder = {row}; holder.row.height = 0; return 1 }`},
  {label: 'mutates an argument array selected through a local object', kind: 'impure', source: `function f(rows: number[]) { const holder = {rows}; holder.rows.push(1) }`},
  {label: 'mutates an argument array selected through a local array', kind: 'impure', source: `function f(rows: number[]) { const holder = [rows]; holder[0]!.push(1) }`},
  {label: 'mutates a selected argument array through a helper', kind: 'impure', source: `function append(holder: {rows: number[]}) { holder.rows.push(1) }\nfunction f(rows: number[]) { append({rows}) }`},
  {label: 'changes an argument nested in a helper argument', kind: 'impure', source: `function clear(holder: {row: {height: number}}) { holder.row.height = 0 }\nfunction f(row: {height: number}) { clear({row}) }`},
  {label: 'changes an argument nested in a named helper argument', kind: 'impure', source: `function clear(holder: {row: {height: number}}) { holder.row.height = 0 }\nfunction f(row: {height: number}) { const holder = {row}; clear(holder) }`},
  {label: 'local function changes an outer function argument', kind: 'impure', source: `function f(row: {height: number}) { const clear = () => row.height = 0; clear(); return 1 }`},
  {label: 'changes an argument returned by a helper', kind: 'impure', source: `function identity<T>(value: T) { return value }\nfunction f(values: number[]) { identity(values).push(1); return 1 }`},
  {label: 'changes an argument returned through a non-null assertion', kind: 'impure', source: `function identity(values: number[]) { return values! }\nfunction f(values: number[]) { identity(values).push(1) }`},
  {label: 'changes an argument returned through a type assertion', kind: 'impure', source: `function identity(values: number[]) { return values as number[] }\nfunction f(values: number[]) { identity(values).push(1) }`},
  {label: 'changes an argument returned through parentheses', kind: 'impure', source: `function identity(values: number[]) { return (values) }\nfunction f(values: number[]) { identity(values).push(1) }`},
  {label: 'keeps an argument alias through two helpers', kind: 'impure', source: `function identity<T>(value: T) { return value }\nfunction relay<T>(value: T) { return identity(value) }\nfunction f(values: number[]) { relay(values).push(1); return 1 }`},
  {label: 'changes a child of an argument returned by a helper', kind: 'impure', source: `function child(row: {child: {height: number}}) { return row.child }\nfunction f(row: {child: {height: number}}) { child(row).height = 0; return 1 }`},
  {label: 'changes an argument selected through a local wrapper in a helper', kind: 'impure', source: `function identityThroughWrapper(row: {height: number}) { return {row}.row }\nfunction f(row: {height: number}) { identityThroughWrapper(row).height = 0 }`},
  {label: 'changes an array element in an inline callback', kind: 'impure', source: `function f(rows: {height: number}[]) { rows.forEach(row => row.height = 0); return 1 }`},
  {label: 'writes a top-level variable', kind: 'impure', source: `let total = 0\nfunction f(value: number) { total += value; return total }`},
  {label: 'reads a top-level let', kind: 'impure', source: `let total = 0\nfunction f() { return total }`},
  {label: 'reads a top-level const object', kind: 'impure', source: `const settings = {limit: 10}\nfunction f() { return settings.limit }`},
  {label: 'reads a mutable namespace property on a function', kind: 'impure', source: `function helper() {}\nnamespace helper { export let count = 0 }\nfunction f() { return helper.count }`},
  {label: 'performs I/O', kind: 'impure', source: `function f(value: number) { console.log(value); return value }`},
  {label: 'reads randomness', kind: 'impure', source: `function f() { return Math.random() }`},
  {label: 'reads the clock', kind: 'impure', source: `function f() { return Date.now() }`},
  {label: 'calls an impure helper', kind: 'impure', source: `function random() { return Math.random() }\nfunction f() { return random() }`},
  {label: 'uses an impure callback', kind: 'impure', source: `function f(values: number[]) { return values.map(() => Math.random()).length }`},
  {label: 'uses an impure built-in callback', kind: 'impure', source: `function f(values: number[]) { return values.map(Math.random).length }`},
  {label: 'uses an aliased impure built-in callback', kind: 'impure', source: `const random = Math.random\nfunction f(values: number[]) { return values.map(random).length }`},
  {label: 'throws directly', kind: 'impure', reasonIncludes: 'throws', source: `function f() { throw 1 }`},
  {label: 'calls a helper that throws', kind: 'impure', reasonIncludes: 'throws', source: `function stop(): never { throw 1 }\nfunction f() { return stop() }`},
  {label: 'uses a callback that throws', kind: 'impure', reasonIncludes: 'throws', source: `function f(values: number[]) { values.forEach(() => { throw 1 }); return 1 }`},
  {label: 'uses Object.freeze', kind: 'unknown', reasonIncludes: 'Object.freeze', source: `function f(value: object) { Object.freeze(value); return 1 }`},
  {label: 'may retain the original parameter after a branch', kind: 'impure', reasonIncludes: '`row`', source: `function f(row: {height: number}, flag: boolean) { if (flag) row = {height: 0}; row.height = 1 }`},
  {label: 'may retain the original parameter after a switch without default', kind: 'impure', reasonIncludes: '`row`', source: `function f(row: {height: number}, mode: number) { switch (mode) { case 0: row = {height: 0} } row.height = 1 }`},
  {label: 'may retain the original parameter after a loop', kind: 'impure', reasonIncludes: '`row`', source: `function f(row: {height: number}, flag: boolean) { while (flag) { row = {height: 0}; flag = false } row.height = 1 }`},
  {label: 'may retain the original parameter when a do-while breaks before replacement', kind: 'impure', reasonIncludes: '`row`', source: `function f(row: {height: number}, stop: boolean) { do { if (stop) break; row = {height: 0} } while (false); row.height = 1 }`},
  {label: 'may retain the original parameter after a for-of loop', kind: 'impure', reasonIncludes: '`row`', source: `function f(row: {height: number}, values: number[]) { for (const value of values) { row = {height: value} } row.height = 1 }`},
  {label: 'maps a reassigned parameter mutation to the replacement', kind: 'impure', reasonIncludes: '`replacement`', source: `function f(row: {height: number}, replacement: {height: number}) { row = replacement; row.height = 1 }`},

  // Deliberately unsupported operations.
  {label: 'reads this', kind: 'unknown', reasonIncludes: '`this`', source: `function f(this: {value: number}) { return this.value }`},
  {label: 'changes this', kind: 'unknown', reasonIncludes: '`this`', source: `function f(this: {value: number}) { this.value = 1; return 1 }`},
  {label: 'uses try and catch', kind: 'unknown', reasonIncludes: 'try/catch', source: `function f() { try { return 1 } catch { return 2 } }`},
  {label: 'uses labeled control flow', kind: 'unknown', reasonIncludes: 'labeled', source: `function f() { outer: for (;;) { break outer } return 1 }`},
  {label: 'is async', kind: 'unknown', reasonIncludes: 'async', source: `async function f() { return 1 }`},
  {label: 'is a generator', kind: 'unknown', reasonIncludes: 'generator', source: `function* f() { yield 1 }`},
  {label: 'recurses directly', kind: 'unknown', reasonIncludes: 'recursive', source: `function f(value: number): number { return value > 0 ? f(value - 1) : 0 }`},
  {label: 'recurses mutually', kind: 'unknown', reasonIncludes: 'recursive', source: `function other(value: number): number { return value > 0 ? f(value - 1) : 0 }\nfunction f(value: number): number { return value > 0 ? other(value - 1) : 0 }`},
  {label: 'calls a local let function', kind: 'unknown', source: `function f() { let helper = () => 1; return helper() }`},
  {label: 'calls a top-level let function', kind: 'unknown', source: `let helper = () => 1\nfunction f() { return helper() }`},
  {label: 'annotates a function stored in a mutable binding', kind: 'unknown', source: `let f = () => 1`},
  {label: 'calls a function stored in an object', kind: 'unknown', source: `function f() { const helpers = {value: () => 1}; return helpers.value() }`},
  {label: 'calls a function stored in an array', kind: 'unknown', source: `function f() { const helpers = [() => 1]; return helpers[0]!() }`},
  {label: 'calls a conditional function', kind: 'unknown', source: `function f(flag: boolean) { const helper = flag ? () => 1 : () => 2; return helper() }`},
  {label: 'calls a returned function', kind: 'unknown', source: `function make() { return () => 1 }\nfunction f() { return make()() }`},
  {label: 'uses Function.call', kind: 'unknown', source: `function helper() { return 1 }\nfunction f() { return helper.call(null) }`},
  {label: 'uses Function.apply', kind: 'unknown', source: `function helper() { return 1 }\nfunction f() { return helper.apply(null, []) }`},
  {label: 'uses Function.bind', kind: 'unknown', source: `function helper() { return 1 }\nfunction f() { return helper.bind(null)() }`},
  {label: 'constructs a user class', kind: 'unknown', source: `class Box {}\nfunction f() { return new Box() }`},
  {label: 'calls a user method', kind: 'unknown', source: `class Box { value() { return 1 } }\nfunction f(box: Box) { return box.value() }`},
  {label: 'reads a user getter', kind: 'unknown', source: `class Box { get value() { return 1 } }\nfunction f(box: Box) { return box.value }`},
  {label: 'calls a declaration without source', kind: 'unknown', source: `declare function externalCall(value: number): number\nfunction f(value: number) { return externalCall(value) }`},
  {label: 'reads a getter through a computed literal key', kind: 'unknown', source: `function f() { const source = {get value() { return Math.random() }}; const key: 'value' = 'value'; return source[key] }`},
  {label: 'mutates inside a copied array', kind: 'unknown', source: `function copyArray(rows: {height: number}[]) { return rows.slice() }\nfunction f(rows: {height: number}[]) { copyArray(rows)[0]!.height = 0; return 1 }`},
  {label: 'mutates inside a fresh wrapper returned by a helper', kind: 'unknown', source: `function wrap(row: {height: number}) { return [{row}] }\nfunction f(row: {height: number}) { wrap(row)[0]!.row.height = 0; return 1 }`},
  {label: 'mutates inside a map result', kind: 'unknown', source: `function f(rows: {height: number}[]) { rows.map(row => ({row}))[0]!.row.height = 0; return 1 }`},
  {label: 'mutates a slice element through a callback', kind: 'unknown', source: `function f(rows: {height: number}[]) { rows.slice().forEach(row => row.height = 0) }`},
  {label: 'mutates a slice element through a named comparator', kind: 'unknown', source: `function clear(left: {height: number}, right: {height: number}) { left.height = 0; return left.height - right.height }\nfunction f(rows: {height: number}[]) { rows.slice().sort(clear) }`},
  {label: 'mutates a result that may be new or an argument', kind: 'unknown', source: `function maybeCopy(values: number[], copy: boolean) { return copy ? values.slice() : values }\nfunction f(values: number[], copy: boolean) { maybeCopy(values, copy).push(1); return 1 }`},
  {label: 'mutates a literal result that may be new or an argument', kind: 'unknown', source: `function maybeCopy(row: {height: number}, copy: boolean) { return copy ? {height: row.height} : row }\nfunction f(row: {height: number}, copy: boolean) { maybeCopy(row, copy).height = 1 }`},
  {label: 'replaces a field in a local wrapper that also contains an argument', kind: 'unknown', reasonIncludes: 'local container', source: `function f(row: {height: number}) { const holder = {row}; holder.row = {height: 0}; holder.row.height = 1 }`},
  {label: 'replaces an array slot in a local wrapper that also contains an argument', kind: 'unknown', reasonIncludes: 'local container', source: `function f(row: {height: number}) { const holder = [row]; holder[0] = {height: 0}; holder[0]!.height = 1 }`},
  {label: 'changes a local wrapper containing an argument through a nested function', kind: 'unknown', reasonIncludes: 'nested function', source: `function f(row: {height: number}) { const holder = {row, count: 0}; const increment = () => holder.count++; increment(); return holder.count }`},
  {label: 'stores an argument in a fresh array through a helper', kind: 'unknown', reasonIncludes: 'storing an existing', source: `type Row = {height: number}\nfunction append(values: Row[], row: Row) { values.push(row) }\nfunction f(values: Row[], row: Row) { const copy = values.slice(); append(copy, row) }`},
  {label: 'uses Array.at returned contents', kind: 'unknown', source: `function f(rows: {height: number}[]) { rows.at(0)!.height = 0; return 1 }`},
  {label: 'uses Array.find returned contents', kind: 'unknown', source: `function f(rows: {height: number}[]) { rows.find(() => true)!.height = 0; return 1 }`},
  {label: 'uses Array.from', kind: 'unknown', reasonIncludes: 'Array.from', source: `function f(values: number[]) { return Array.from(values).length }`},
  {label: 'uses JSON.parse', kind: 'unknown', reasonIncludes: 'JSON.parse', source: `function f(value: string) { return JSON.parse(value) }`},
  {label: 'sorts without a comparator', kind: 'unknown', reasonIncludes: 'without a comparator', source: `function f(values: number[]) { return values.sort().length }`},
  {label: 'sorts with explicit undefined', kind: 'unknown', reasonIncludes: 'without a comparator', source: `function f(values: number[]) { return values.sort(undefined).length }`},
  {label: 'uses toSorted with explicit undefined', kind: 'unknown', reasonIncludes: 'without a comparator', source: `function f(values: number[]) { return values.toSorted(undefined).length }`},
  {label: 'uses toSorted with an undefined alias', kind: 'unknown', reasonIncludes: 'without a comparator', source: `const comparator = undefined\nfunction f(values: number[]) { return values.toSorted(comparator).length }`},
  {label: 'uses toSorted with an optional comparator', kind: 'unknown', reasonIncludes: 'without a comparator', source: `function f(values: number[], comparator?: (left: number, right: number) => number) { return values.toSorted(comparator).length }`},
  {label: 'uses toSorted with a conditional default comparator', kind: 'unknown', reasonIncludes: 'without a comparator', source: `function f(values: number[], useComparator: boolean) { const comparator = useComparator ? (left: number, right: number) => left - right : undefined; return values.toSorted(comparator).length }`},
  {label: 'uses a comparator through a comma expression', kind: 'unknown', source: `function f(values: number[]) { let count = 0; const compare = (left: number, right: number) => left - right; values.toSorted((count++, compare)); return count }`},
  {label: 'mutates a value after a nested function reassigns its binding', kind: 'unknown', reasonIncludes: 'reassigns a value', source: `function f(row: {height: number}) { const replace = () => row = {height: 0}; replace(); row.height = 1 }`},
  {label: 'mutates a replacement argument after a nested reassignment', kind: 'unknown', reasonIncludes: 'reassigns a value', source: `function f(replacement: {height: number}) { let row = {height: 0}; const replace = () => row = replacement; replace(); row.height = 1 }`},
  {label: 'uses a throwing constructor in a parameter binding default', kind: 'unknown', reasonIncludes: 'construction can throw', source: `function f([value = new Array(-1)] = []) { return value }`},
  {label: 'reads randomness in a local binding default', kind: 'impure', source: `function f() { const [value = Math.random()] = []; return value }`},
  {label: 'reads randomness in a computed binding name', kind: 'impure', source: `function f({[Math.random()]: value}: Record<number, number>) { return value }`},
  {label: 'calls a reassigned function declaration', kind: 'unknown', reasonIncludes: 'reassigned', source: `function f() { function helper() { return 1 }; (helper satisfies typeof helper) = () => Math.random(); return helper() }`},
  {label: 'calls an alias of a reassigned function declaration', kind: 'unknown', source: `function helper() { return 1 }\n;(helper satisfies typeof helper) = () => Math.random()\nconst alias = helper\nfunction f() { return alias() }`},
  {label: 'sorts with void zero', kind: 'unknown', reasonIncludes: 'without a comparator', source: `function f(values: number[]) { return values.sort(void 0).length }`},
  {label: 'uses reduce recurrence', kind: 'unknown', reasonIncludes: 'reduce', source: `function f(values: number[]) { return values.reduce((total, value) => total + value, 0) }`},
  {label: 'uses concat', kind: 'unknown', reasonIncludes: 'concat', source: `function f(values: number[]) { return values.concat([]).length }`},
  {label: 'uses flat', kind: 'unknown', reasonIncludes: 'flat', source: `function f(values: number[][]) { return values.flat().length }`},
  {label: 'uses flatMap', kind: 'unknown', reasonIncludes: 'flatMap', source: `function f(values: number[][]) { return values.flatMap(value => value).length }`},
  {label: 'uses array entries', kind: 'unknown', reasonIncludes: 'iterator', source: `function f(values: number[]) { return [...values.entries()].length }`},
  {label: 'uses array values', kind: 'unknown', reasonIncludes: 'indexed getters', source: `function f(values: number[]) { return values.values() }`},
  {label: 'calls an inherited array method on a user class', kind: 'unknown', source: `class Rows extends Array<number> { get 0() { console.log('read'); return 1 } }\nfunction f(values: Rows) { return values.slice().length }`},
  {label: 'constructs an array with arguments', kind: 'unknown', reasonIncludes: 'construction can throw', source: `function f() { return new Array(-1) }`},
  {label: 'calls an alias from a shadowed Math object', kind: 'unknown', source: `export {}\nconst Math = {max(left: number, right: number) { console.log(left, right); return left }}\nconst max = Math.max\nfunction f() { return max(1, 2) }`},
  {label: 'calls an overwritten built-in method', kind: 'unknown', source: `function f() { const values: number[] = []; values.includes = () => { console.log('called'); return false }; return values.includes(1) }`},
  {label: 'overwrites a built-in method through object assignment', kind: 'unknown', source: `function f() { const values: number[] = []; const replacement = () => false; ({replacement: values.includes} = {replacement}); return values.includes(1) }`},
  {label: 'overwrites a built-in method through array assignment', kind: 'unknown', source: `function f() { const values: number[] = []; const replacement = () => false; [values.includes] = [replacement]; return values.includes(1) }`},
  {label: 'overwrites a built-in method through a for-of target', kind: 'unknown', source: `function f() { const values: number[] = []; const replacement = () => false; for (values.includes of [replacement]) break; return values.includes(1) }`},
  {label: 'ignores an unused built-in replacement helper', kind: 'pure', source: `function replaceFinite() { Number.isFinite = () => false }\nfunction f(value: number) { return Number.isFinite(value) }`},
  {label: 'calls a helper that replaces an array method', kind: 'unknown', source: `function replace(values: number[]) { values.includes = () => false }\nfunction f(values: number[]) { replace(values); return values.includes(1) }`},
  {label: 'stores an argument in a local holder through a helper', kind: 'unknown', reasonIncludes: 'storing an existing', source: `type Row = {height: number}\nfunction store(holder: {row: Row | null}, row: Row) { holder.row = row }\nfunction f(row: Row) { const holder = {row: null as Row | null}; store(holder, row) }`},
  {label: 'spreads an arbitrary iterable', kind: 'unknown', reasonIncludes: 'iterator', source: `function f(values: Iterable<number>) { return [...values].length }`},
  {label: 'reads through object destructuring when a getter may run', kind: 'unknown', reasonIncludes: 'getter', source: `class Source { get value() { return 1 } }\nfunction f(source: Source) { const {value} = source; return value }`},
]

const failures: {label: string; kind: Purity['kind']; reasonIncludes: string | undefined; actual: Purity}[] = []
for (const {label, source, kind, reasonIncludes} of cases) {
  const actual = purityOf('f', source)
  if (
    actual.kind !== kind
    || (reasonIncludes != null && (!('reason' in actual) || !actual.reason.includes(reasonIncludes)))
  ) failures.push({label, kind, reasonIncludes, actual})
}
if (failures.length > 0) {
  throw testDiagnosticError('expected the purity classification table to match', failures)
}
})

test('does not prove contracts through opaque platform result contents', () => {
const checks = verifyFitSource('opaque-platform-result.ts', `/** @fit
 * pure
 * return == 0
 */
function contradictorySliceResult() {
  const row = {height: 0}
  const copiedRows = [row].slice()
  copiedRows[0]!.height = 1
  return row.height
}

/** @fit
 * pure
 * return == 0
 */
function contradictoryArrayOfResult() {
  const row = {height: 0}
  const copiedRows = Array.of(row)
  copiedRows[0]!.height = 1
  return row.height
}

/** @fit
 * pure
 * return == 0
 */
function contradictoryInlineSliceResult() {
  const row = {height: 0}
  ;[row].slice()[0]!.height = 1
  return row.height
}

/** @fit
 * pure
 * return == 0
 */
function contradictoryDestructuredSliceResult() {
  const row = {height: 0}
  const [copiedRow] = [row].slice()
  copiedRow!.height = 1
  return row.height
}

function mutateTemporaryHolder(holder: {row: {height: number}}) {
  holder.row.height = 1
}

/** @fit
 * pure
 * return == 0
 */
function contradictoryTemporaryHolderResult() {
  const row = {height: 0}
  mutateTemporaryHolder({row})
  return row.height
}

/** @fit
 * pure
 * return == 0
 */
function contradictoryTemporaryCallbackResult() {
  const row = {height: 0}
  ;[row].forEach(value => value.height = 1)
  return row.height
}
`)
const purity = requiredCheck(checks, {functionName: 'contradictorySliceResult', text: 'pure'})
const returned = requiredCheck(checks, {functionName: 'contradictorySliceResult', text: 'return == 0'})
const arrayOfPurity = requiredCheck(checks, {functionName: 'contradictoryArrayOfResult', text: 'pure'})
const arrayOfReturn = requiredCheck(checks, {functionName: 'contradictoryArrayOfResult', text: 'return == 0'})
const inlineReturn = requiredCheck(checks, {functionName: 'contradictoryInlineSliceResult', text: 'return == 0'})
const destructuredReturn = requiredCheck(checks, {functionName: 'contradictoryDestructuredSliceResult', text: 'return == 0'})
const temporaryHolderReturn = requiredCheck(checks, {functionName: 'contradictoryTemporaryHolderResult', text: 'return == 0'})
const temporaryCallbackReturn = requiredCheck(checks, {functionName: 'contradictoryTemporaryCallbackResult', text: 'return == 0'})
if (
  purity.status !== 'unknown'
  || returned.status === 'pass'
  || arrayOfPurity.status !== 'unknown'
  || arrayOfReturn.status === 'pass'
  || inlineReturn.status === 'pass'
  || destructuredReturn.status === 'pass'
  || temporaryHolderReturn.status === 'pass'
  || temporaryCallbackReturn.status === 'pass'
) {
  throw testDiagnosticError('expected opaque platform contents to prevent both purity and return proofs', checks)
}
})

test('keeps facts when an opaque fresh platform result is ignored', () => {
const checks = verifyFitSource('ignored-platform-result.ts', `/** @fit
 * pure
 * return == 0
 */
function ignoredSliceResult() {
  const row = {height: 0}
  ;[row].slice()
  return row.height
}
`)
const purity = requiredCheck(checks, {functionName: 'ignoredSliceResult', text: 'pure'})
const returned = requiredCheck(checks, {functionName: 'ignoredSliceResult', text: 'return == 0'})
if (purity.status !== 'pass' || returned.status !== 'pass') {
  throw testDiagnosticError('expected an ignored fresh platform result to preserve existing facts', checks)
}
})

test('forgets a captured binding value after a nested function reassigns it', () => {
const checks = verifyFitSource('captured-reassignment.ts', `/** @fit
 * pure
 * return == 1
 */
function replaceRow(row: {height: number}) {
  const replace = () => row = {height: 1}
  replace()
  return row.height
}

/** @fit
 * pure
 * return == 0
 */
function preserveOriginalAlias() {
  let row = {height: 0}
  const original = row
  const replace = () => row = {height: 1}
  replace()
  return original.height
}
`)
const purity = requiredCheck(checks, {functionName: 'replaceRow', text: 'pure'})
const returned = requiredCheck(checks, {functionName: 'replaceRow', text: 'return == 1'})
const originalAlias = requiredCheck(checks, {functionName: 'preserveOriginalAlias', text: 'return == 0'})
if (purity.status !== 'pass' || returned.status === 'pass' || originalAlias.status !== 'pass') {
  throw testDiagnosticError('expected a nested reassignment to remain pure but invalidate the old binding value', checks)
}
})

test('rejects mismatched source programs before recording a summary', () => {
const identityProject = loadFitProject(['tests/purity/imported-caller.ts'], readTopLevelGlobal)
const identityCaller = identityProject.entries[0]!
const callbackBinding = identityCaller.imports.get('importedPureCallback')
if (callbackBinding == null || callbackBinding.kind !== 'resolved') throw new Error('expected importedPureCallback to resolve')
const identityHelper = callbackBinding.file
const importedCallback = identityHelper.functions.get('importedPureCallback')
if (importedCallback == null) throw new Error('expected importedPureCallback implementation')
let mismatchedReferenceReason: string | null = null
try {
  functionPurity({program: identityCaller, node: importedCallback.node})
} catch (error) {
  mismatchedReferenceReason = error instanceof Error ? error.message : String(error)
}
const purityAfterRejectedMismatch = functionPurity(functionImplementationReference(identityHelper, importedCallback.node))
if (mismatchedReferenceReason?.includes('does not belong') !== true || purityAfterRejectedMismatch.kind !== 'pure') {
  throw testDiagnosticError('expected mismatched source programs to fail before recording a summary', {
    mismatchedReferenceReason,
    purityAfterRejectedMismatch,
  })
}
})

test('keeps recursive mutation effects independent of analysis order', () => {
const source = `function first(box: {value: number}, stop: boolean) {
  if (stop) box.value = 1
  else second(box)
}
function second(box: {value: number}) {
  first(box, true)
}
`
const analyze = (firstName: 'first' | 'second') => {
  const program = buildFitSourceFile(`${firstName}-first.ts`, source, readTopLevelGlobal)
  const secondName = firstName === 'first' ? 'second' : 'first'
  const requestedFirst = program.functions.get(firstName)
  const requestedSecond = program.functions.get(secondName)
  const firstFn = program.functions.get('first')
  const secondFn = program.functions.get('second')
  if (requestedFirst == null || requestedSecond == null || firstFn == null || secondFn == null) {
    throw new Error('expected recursive functions')
  }
  functionEffects(functionImplementationReference(program, requestedFirst.node))
  functionEffects(functionImplementationReference(program, requestedSecond.node))
  return {
    first: functionEffects(functionImplementationReference(program, firstFn.node)),
    second: functionEffects(functionImplementationReference(program, secondFn.node)),
  }
}
const firstOrder = analyze('first')
const secondOrder = analyze('second')
const mutatesFirstParameter = (effects: ReturnType<typeof functionEffects>) =>
  effects.mutations.certain.paramIndexes.has(0) || effects.mutations.uncertain.paramIndexes.has(0)
if (
  !mutatesFirstParameter(firstOrder.first)
  || !mutatesFirstParameter(firstOrder.second)
  || !mutatesFirstParameter(secondOrder.first)
  || !mutatesFirstParameter(secondOrder.second)
) {
  throw testDiagnosticError('expected recursive mutation effects not to depend on the first requested summary', {
    firstOrder,
    secondOrder,
  })
}
})

test('keeps source identity through imports, aliases, callbacks, and re-exports', async () => {
const importedPurity = await verifyFitFiles(['tests/purity/imported-caller.ts'])
const pureClaim = requiredCheck(importedPurity.checks, {functionName: 'importedAliasPure', text: 'pure'})
const impureClaim = requiredCheck(importedPurity.checks, {functionName: 'importedAliasImpure', text: 'pure'})
const namespaceClaim = requiredCheck(importedPurity.checks, {functionName: 'importedNamespacePure', text: 'pure'})
const impureNamespaceClaim = requiredCheck(importedPurity.checks, {functionName: 'importedNamespaceImpure', text: 'pure'})
const reassignedNamespaceClaim = requiredCheck(importedPurity.checks, {functionName: 'importedNamespaceReassignedUnknown', text: 'pure'})
const defaultClaim = requiredCheck(importedPurity.checks, {functionName: 'importedDefaultAliasPure', text: 'pure'})
const primitiveClaim = requiredCheck(importedPurity.checks, {functionName: 'importedPrimitivePure', text: 'pure'})
const namespacePrimitiveClaim = requiredCheck(importedPurity.checks, {functionName: 'importedNamespacePrimitivePure', text: 'pure'})
const pureContract = requiredCheck(importedPurity.checks, {functionName: 'contractUsesImportedAlias', text: 'return <= identity()'})
const impureContract = requiredCheck(importedPurity.checks, {functionName: 'contractRejectsImportedAlias', text: 'return <= noisy()'})
const callbackContract = requiredCheck(importedPurity.checks, {
  functionName: 'contractUsesImportedCallbackAfterMap',
  text: 'return <= importedPureCallback(0)',
})
if (
  pureClaim.status !== 'pass'
  || impureClaim.status !== 'fail'
  || namespaceClaim.status !== 'pass'
  || impureNamespaceClaim.status !== 'fail'
  || reassignedNamespaceClaim.status !== 'unknown'
  || defaultClaim.status !== 'pass'
  || primitiveClaim.status !== 'pass'
  || namespacePrimitiveClaim.status !== 'pass'
  || pureContract.status !== 'pass'
  || impureContract.status !== 'unknown'
  || callbackContract.status !== 'pass'
  || impureClaim.reason?.includes('observes the environment') !== true
  || impureNamespaceClaim.reason?.includes('observes the environment') !== true
  || impureContract.reason?.includes('helper importedImpure is not pure: observes the environment') !== true
) throw testDiagnosticError('expected imports, aliases, callbacks, and re-exports to keep source identity', importedPurity.checks)
})

test('does not treat a mutable function binding as a stable contract helper', () => {
const checks = verifyFitSource('mutable-helper.ts', `let helper = () => 10
helper = () => 0

/** @fit
 * return <= helper()
 */
function returnsFive() {
  return 5
}

function declarationHelper() { return 1 }
;(declarationHelper satisfies typeof declarationHelper) = () => 2
const declarationAlias = declarationHelper

/** @fit
 * pure
 * return == 1
 */
function callsReassignedDeclarationAlias() {
  return declarationAlias()
}
`)
const check = requiredCheck(checks, {functionName: 'returnsFive', text: 'return <= helper()'})
const aliasPurity = requiredCheck(checks, {functionName: 'callsReassignedDeclarationAlias', text: 'pure'})
const aliasReturn = requiredCheck(checks, {functionName: 'callsReassignedDeclarationAlias', text: 'return == 1'})
if (
  check.status !== 'unknown'
  || check.reason?.includes('helper') !== true
  || aliasPurity.status !== 'unknown'
  || aliasReturn.status === 'pass'
) {
  throw testDiagnosticError('expected a mutable function binding to be rejected', checks)
}
})

test('allows pure unannotated helper calls in contracts', () => {
const checks = verifyFitSource('contract-purity.ts', `function safeLimit(value: number) {
  let floor = 9
  floor += 1
  return Math.max(value, floor)
}

/** @fit
 * given value: 0..10
 * return <= safeLimit(value)
 */
function bounded(value: number) {
  return value
}
`)
const check = requiredCheck(checks, {functionName: 'bounded', text: 'return <= safeLimit(value)'})
if (check.status !== 'pass') throw testDiagnosticError('expected pure unannotated helper calls to work in contracts', checks)
})

test('allows pure unannotated helpers in given comparisons and range bounds', () => {
const checks = verifyFitSource('given-contract-purity.ts', `function double(value: number) {
  return value * 2
}

/** @fit
 * given max >= double(min)
 * given width: double(min)..max
 * return.scaled <= max
 * return.width >= double(min)
 * return.width <= max
 */
function bounded(min: number, width: number, max: number) {
  return {scaled: double(min), width}
}
`)
const failures = checks.filter(check => check.status !== 'pass')
if (failures.length > 0) throw testDiagnosticError('expected pure helpers in all contract expression positions', checks)
})

test('rejects impure helper calls in contracts', () => {
const checks = verifyFitSource('contract-impure.ts', `const box = {limit: 0}

function bump() {
  box.limit += 1
  return box.limit
}

/** @fit
 * return <= bump()
 */
function bad() {
  return 0
}
`)
const check = requiredCheck(checks, {functionName: 'bad', text: 'return <= bump()'})
if (
  check.status !== 'unknown'
  || check.reason?.includes('Unsupported @fit contract expression: bump()') !== true
  || check.reason.includes('helper bump is not pure: writes outside state `box`') !== true
) throw testDiagnosticError('expected impure helper calls in contracts to be rejected loudly', checks)
})

test('rejects contract helpers that read mutable outside state', () => {
const checks = verifyFitSource('contract-mutable-read.ts', `const state = {limit: 10}

function currentLimit() {
  return state.limit
}

/** @fit
 * return <= currentLimit()
 */
function bad() {
  return 0
}
`)
const check = requiredCheck(checks, {functionName: 'bad', text: 'return <= currentLimit()'})
if (
  check.status !== 'unknown'
  || check.reason?.includes('Unsupported @fit contract expression: currentLimit()') !== true
  || check.reason.includes('helper currentLimit is not pure: reads mutable outside state') !== true
) throw testDiagnosticError('expected mutable outside reads to use the shared purity check', checks)
})
})
