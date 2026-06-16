// Pure-function classification. Each case is source -> pure | impure | unknown,
// with no interpreter run or proof needed.
import {readTopLevelGlobal} from '../../src/check-core.ts'
import {functionImplementationReference} from '../../src/function-shape.ts'
import {functionPurity, type Purity} from '../../src/interpreter/function-effects.ts'
import {buildFitSourceFile, loadFitProject} from '../../src/modules.ts'
import {verifyFitFiles} from '../../src/reports.ts'
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
  importedNamedCallbackKeepsSourceProgram,
  importedPrimitivePure,
  importedWrapperMutationImpure,
  importedWrapperReplacementPure,
} from './imported-caller.ts'
import {testSuite} from '../test-suite.ts'

testSuite('purity suite', async suite => {
void contractRejectsImportedAlias
void contractUsesImportedCallbackAfterMap
void contractUsesImportedAlias
void importedAliasImpure
void importedAliasPure
void importedDefaultAliasPure
void importedNamespaceImpure
void importedNamespacePrimitivePure
void importedNamespacePure
void importedNamedCallbackKeepsSourceProgram
void importedPrimitivePure
void importedWrapperMutationImpure
void importedWrapperReplacementPure

function purityOf(name: string, source: string): Purity {
  const program = buildFitSourceFile('purity.ts', source, readTopLevelGlobal)
  const fn = program.functions.get(name)
  if (fn == null) throw new Error(`no function ${name} in source`)
  return functionPurity(functionImplementationReference(program, fn.node))
}

const cases: {label: string; source: string; kind: Purity['kind']; reasonIncludes?: string}[] = [
  // --- pure ---
  {label: 'arithmetic on params', kind: 'pure', source: `function f(x: number) { return x * 2 + 1 }`},
  {label: 'local array build with push', kind: 'pure', source: `function f(x: number) { const ys: number[] = []; ys.push(x); return ys.length }`},
  {label: 'local Array constructor build with push', kind: 'pure', source: `function f(x: number) { const ys = new Array<number>(); ys.push(x); return ys.length }`},
  {label: 'Array constructor element replacement stays local', kind: 'pure', source: `function f(box: {n: number}) { const ys = new Array(box); ys[0] = {n: 1}; return ys.length }`},
  {label: 'typed array numeric construction stays local', kind: 'pure', source: `function f() { return new Uint8Array(10).length }`},
  {label: 'local let mutation', kind: 'pure', source: `function f(x: number) { let t = 0; t += x; return t }`},
  {label: 'Math (non-random)', kind: 'pure', source: `function f(x: number) { return Math.min(Math.abs(x), 10) }`},
  {label: 'reads module const primitive', kind: 'pure', source: `const MAX = 100\nfunction f(x: number) { return Math.min(x, MAX) }`},
  {label: 'map with pure inline callback', kind: 'pure', source: `function f(xs: number[]) { return xs.map(y => y * 2)[0] ?? 0 }`},
  {label: 'calls a pure helper', kind: 'pure', source: `function dbl(n: number) { return n * 2 }\nfunction f(x: number) { return dbl(x) }`},
  {label: 'calls a top-level arrow helper', kind: 'pure', source: `const dbl = (n: number) => n * 2\nfunction f(x: number) { return dbl(x) }`},
  {label: 'calls a top-level helper alias', kind: 'pure', source: `function dbl(n: number) { return n * 2 }\nconst twice = dbl\nfunction f(x: number) { return twice(x) }`},
  {label: 'pure overload implementation', kind: 'pure', source: `function helper(value: number): number\nfunction helper(value: number, extra: number): number\nfunction helper(value: number, extra?: number) { return value + (extra ?? 0) }\nfunction f() { return helper(1) }`},
  {label: 'allocates and returns a fresh object', kind: 'pure', source: `function f(x: number) { return {v: x} }`},
  {label: 'shorthand property reads a callback parameter', kind: 'pure', source: `function f(xs: number[]) { return xs.map(value => ({value})) }`},
  {label: 'shorthand property reads module const primitive', kind: 'pure', source: `const value = 1\nfunction f() { return {value} }`},
  {label: 'shorthand property keeps local object mutation local', kind: 'pure', source: `function f() { const box = {value: 0}; const holder = {box}; holder.box.value = 1; return 1 }`},
  {label: 'map result container is fresh', kind: 'pure', source: `function f(xs: number[]) { const holders = xs.map(value => ({value})); holders.push({value: 1}); return holders.length }`},
  {label: 'immediate slice result container is fresh', kind: 'pure', source: `function f(xs: number[]) { return xs.slice().push(1) }`},
  {label: 'helper result container is fresh', kind: 'pure', source: `function wrap(box: {n: number}) { return {box, marker: 0} }\nfunction f(box: {n: number}) { wrap(box).marker = 1; return 1 }`},
  {label: 'assignment result preserves a fresh wrapper', kind: 'pure', source: `function wrap(box: {n: number}) { let holder = {box: {n: 0}}; return holder = {box} }\nfunction f(box: {n: number}) { wrap(box).box = {n: 1}; return 1 }`},
  {label: 'helper nested wrapper field replacement stays local', kind: 'pure', source: `function wrap(box: {n: number}) { return [{box}] }\nfunction f(box: {n: number}) { wrap(box)[0]!.box = {n: 1}; return 1 }`},
  {label: 'helper chain preserves nested fresh containers', kind: 'pure', source: `function wrap(box: {n: number}) { return [{box}] }\nfunction relay(box: {n: number}) { return wrap(box) }\nfunction f(box: {n: number}) { relay(box)[0]!.box = {n: 1}; return 1 }`},
  {label: 'named map callback uses its return summary', kind: 'pure', source: `function wrap(value: {n: number}) { return [{value}] }\nfunction f(xs: {n: number}[]) { xs.map(wrap)[0]![0]!.value = {n: 1}; return 1 }`},
  {label: 'helper slice result container is fresh', kind: 'pure', source: `function copy(xs: {n: number}[]) { return xs.slice() }\nfunction f(xs: {n: number}[]) { copy(xs).push({n: 1}); return 1 }`},
  {label: 'rest parameter array mutation stays local', kind: 'pure', source: `function f(...boxes: {n: number}[]) { boxes.push({n: 1}); return boxes.length }`},
  {label: 'rest parameter array is fresh', kind: 'pure', source: `function collect(...boxes: {n: number}[]) { return boxes }\nfunction f(first: {n: number}, second: {n: number}) { collect(first, second)[1] = {n: 1}; return 1 }`},
  {label: 'rest parameter array stays fresh through a spread call', kind: 'pure', source: `function collect(...boxes: {n: number}[]) { return boxes }\nfunction f(boxes: {n: number}[]) { collect(...boxes).push({n: 1}); return 1 }`},
  {label: 'omitted parameter contributes no outside reference', kind: 'pure', source: `function make(box = {n: 0}) { return box }\nfunction f() { make().n += 1; return 1 }`},
  {label: 'argument before a spread keeps its exact returned reference', kind: 'pure', source: `function chooseFirst(first: {n: number}, second: {n: number}) { return first }\nfunction f(boxes: [{n: number}]) { const local = {n: 0}; chooseFirst(local, ...boxes).n += 1; return 1 }`},
  {label: 'callback rest parameter array is fresh', kind: 'pure', source: `function collect(...args: [{n: number}, number, {n: number}[]]) { return args }\nfunction f(xs: {n: number}[]) { xs.map(collect)[0]![0] = {n: 1}; return 1 }`},
  {label: 'callback rest parameter array mutation stays local', kind: 'pure', source: `function collect(...args: [{n: number}, number, {n: number}[]]) { args.pop(); return 1 }\nfunction f(xs: {n: number}[]) { return xs.map(collect)[0] ?? 0 }`},
  {label: 'recursive identity without fresh growth settles', kind: 'pure', source: `function identity(box: {n: number}, stop: boolean): {n: number} { return stop ? box : identity(box, true) }\nfunction f(box: {n: number}) { identity(box, false); return 1 }`},
  {label: 'nested destructuring of ordinary data is supported', kind: 'pure', source: `function f({outer: {value}}: {outer: {value: number}}) { return value }`},
  {label: 'object destructuring nested in an array is supported for ordinary data', kind: 'pure', source: `function f(items: [{value: number}]) { const [{value}] = items; return value }`},
  {label: 'destructuring assignment target is not a read', kind: 'pure', source: `function f(box: {n: number}, source: {box: {n: number}}) { ({box} = source); return box.n }`},
  {label: 'object rest assignment creates a fresh object', kind: 'pure', source: `function f(source: {n: number}) { let rest = {n: 0}; ({...rest} = source); rest.n += 1; return rest.n }`},
  {label: 'for-of over an array uses the built-in iterator', kind: 'pure', source: `function f(xs: number[]) { let total = 0; for (const value of xs) total += value; return total }`},
  {label: 'class property name is not an outside read', kind: 'pure', source: `function f() { class Box { value = 1 }; return 1 }`},
  {label: 'unused impure closure does not execute', kind: 'pure', source: `function f() { const noisy = () => Math.random(); return 1 }`},
  {label: 'block local shadows parameter by binding', kind: 'pure', source: `function f(box: {value: number}) { { const box = {value: 0}; box.value = 1 } return 1 }`},
  {label: 'callback mutation of captured local stays local', kind: 'pure', source: `function f(values: number[]) { let count = 0; values.forEach(() => count++); return count }`},
  {label: 'callback read of captured local stays local', kind: 'pure', source: `function f(values: number[]) { let offset = 1; return values.map(value => value + offset)[0] ?? 0 }`},
  {label: 'callback index reassignment stays local', kind: 'pure', source: `function f(values: number[]) { return values.map((value, index) => { index = 20; return value })[0] ?? 0 }`},
  {label: 'local Map retention stays local', kind: 'pure', source: `function f(value: {n: number}) { const map = new Map<string, {n: number}>(); map.set('value', value); return 1 }`},
  {label: 'local Set retention stays local', kind: 'pure', source: `function f(value: {n: number}) { const set = new Set<{n: number}>(); set.add(value); return 1 }`},

  // --- impure ---
  {label: 'mutates a parameter', kind: 'impure', source: `function f(o: {v: number}) { o.v = 9; return 1 }`},
  {label: 'Array constructor retains object arguments', kind: 'impure', source: `function f(box: {n: number}) { const ys = new Array(box); ys[0]!.n += 1; return 1 }`},
  {label: 'shorthand property retains a mutated parameter', kind: 'impure', source: `function f(box: {value: number}) { const holder = {box}; holder.box.value = 1; return 1 }`},
  {label: 'map result retains a callback return', kind: 'impure', source: `function f(box: {n: number}, xs: number[]) { const holders = xs.map(() => ({box})); holders[0]!.box.n += 1; return 1 }`},
  {label: 'map result retains a callback local return', kind: 'impure', source: `function f(xs: {n: number}[]) { const holders = xs.map(value => { const holder = {value}; return holder }); holders[0]!.value.n += 1; return 1 }`},
  {label: 'helper nested wrapper still exposes its input', kind: 'impure', source: `function wrap(box: {n: number}) { return [{box}] }\nfunction f(box: {n: number}) { wrap(box)[0]!.box.n += 1; return 1 }`},
  {label: 'helper chain still exposes its input', kind: 'impure', source: `function wrap(box: {n: number}) { return [{box}] }\nfunction relay(box: {n: number}) { return wrap(box) }\nfunction f(box: {n: number}) { relay(box)[0]!.box.n += 1; return 1 }`},
  {label: 'named map callback still exposes source elements', kind: 'impure', source: `function wrap(value: {n: number}) { return [{value}] }\nfunction f(xs: {n: number}[]) { xs.map(wrap)[0]![0]!.value.n += 1; return 1 }`},
  {label: 'helper slice result still exposes source elements', kind: 'impure', source: `function copy(xs: {n: number}[]) { return xs.slice() }\nfunction f(xs: {n: number}[]) { copy(xs)[0]!.n += 1; return 1 }`},
  {label: 'rest parameter elements still expose arguments', kind: 'impure', source: `function f(...boxes: {n: number}[]) { boxes[0]!.n += 1; return 1 }`},
  {label: 'rest parameter result still exposes every argument', kind: 'impure', source: `function collect(...boxes: {n: number}[]) { return boxes }\nfunction f(first: {n: number}, second: {n: number}) { collect(first, second)[1]!.n += 1; return 1 }`},
  {label: 'rest parameter result still exposes spread elements', kind: 'impure', source: `function collect(...boxes: {n: number}[]) { return boxes }\nfunction f(boxes: {n: number}[]) { collect(...boxes)[0]!.n += 1; return 1 }`},
  {label: 'ordinary parameter result conservatively maps spread elements', kind: 'impure', source: `function identity(box: {n: number}) { return box }\nfunction f(boxes: [{n: number}]) { identity(...boxes).n += 1; return 1 }`},
  {label: 'selected rest parameter element still exposes every possible argument', kind: 'impure', source: `function pickSecond(...boxes: {n: number}[]) { return boxes[1]! }\nfunction f(first: {n: number}, second: {n: number}) { pickSecond(first, second).n += 1; return 1 }`},
  {label: 'direct helper result aliases only its selected argument', kind: 'impure', reasonIncludes: 'mutates parameter `first`', source: `function chooseFirst(first: {n: number}, second: {n: number}) { return first }\nfunction f(first: {n: number}, second: {n: number}) { chooseFirst(first, second).n += 1; return second.n }`},
  {label: 'nullish result choice preserves both possible references', kind: 'impure', source: `function choose(first: {n: number} | null, second: {n: number}) { return first ?? second }\nfunction f(first: {n: number} | null, second: {n: number}) { choose(first, second).n += 1; return 1 }`},
  {label: 'logical result choice preserves its possible reference', kind: 'impure', source: `function choose(first: {n: number} | false, second: {n: number}) { return first || second }\nfunction f(first: {n: number} | false, second: {n: number}) { choose(first, second).n += 1; return 1 }`},
  {label: 'mutual recursive identity settles', kind: 'impure', source: `function first(box: {n: number}, stop: boolean): {n: number} { return stop ? box : second(box, true) }\nfunction second(box: {n: number}, stop: boolean): {n: number} { return stop ? box : first(box, true) }\nfunction f(box: {n: number}) { first(box, false).n += 1; return 1 }`},
  {label: 'zero-argument helper return reaches module state', kind: 'impure', reasonIncludes: 'writes outside state `box`', source: `const box = {n: 0}\nfunction current() { return box }\nfunction f() { current().n += 1; return 1 }`},
  {label: 'nested destructuring mutation reaches its parameter', kind: 'impure', source: `function f({outer: {box}}: {outer: {box: {n: number}}}) { box.n += 1; return 1 }`},
  {label: 'slice result retains its elements', kind: 'impure', source: `function f(xs: {n: number}[]) { xs.slice()[0]!.n += 1; return 1 }`},
  {label: 'Array values iterator retains its elements', kind: 'impure', source: `function f(xs: {n: number}[]) { const values = [...xs.values()]; values[0]!.n += 1; return 1 }`},
  {label: 'toSpliced result retains later inserted arguments', kind: 'impure', source: `function f(xs: {n: number}[], first: {n: number}, second: {n: number}) { xs.toSpliced(0, 0, first, second)[1]!.n += 1; return 1 }`},
  {label: 'fill result retains its argument', kind: 'impure', source: `function f(xs: {n: number}[], box: {n: number}) { xs.slice().fill(box)[0]!.n += 1; return 1 }`},
  {label: 'destructuring selects a retained local property', kind: 'impure', source: `function f(box: {n: number}) { const source = {selected: box}; let target = {n: 0}; ({selected: target} = source); target.n += 1; return 1 }`},
  {label: 'object rest retains nested values', kind: 'impure', source: `function f(box: {n: number}) { const source = {box}; let rest = {box: {n: 0}}; ({...rest} = source); rest.box.n += 1; return 1 }`},
  {label: 'array destructuring assignment carries the source', kind: 'impure', source: `function f(target: {n: number}, source: {n: number}[]) { [target] = source; target.n += 1; return 1 }`},
  {label: 'defaulted destructuring assignment carries the source', kind: 'impure', source: `function f(target: {n: number}, source: {box?: {n: number}}) { ({box: target = {n: 0}} = source); target.n += 1; return 1 }`},
  {label: 'deeper alias is not hidden by a whole-object alias', kind: 'impure', source: `type LinkedNode = {n: number; child?: LinkedNode}\nfunction f(box: LinkedNode) { const holder: LinkedNode = {n: 0, child: box}; let target = holder; target = holder.child!; target.n += 1; return 1 }`},
  {label: 'nullish assignment carries the source', kind: 'impure', source: `function f(source: {n: number}) { let target: {n: number} | null = null; target ??= source; target.n += 1; return 1 }`},
  {label: 'pushes onto a parameter', kind: 'impure', source: `function f(xs: number[]) { xs.push(9); return xs.length }`},
  {label: 'writes a module variable', kind: 'impure', source: `let total = 0\nfunction f(x: number) { total = total + x; return total }`},
  {label: 'reads a module let', kind: 'impure', source: `let counter = 0\nfunction f() { return counter }`},
  {label: 'shorthand property reads a module let', kind: 'impure', source: `let value = 0\nfunction f(xs: number[]) { return xs.map(() => ({value})) }`},
  {label: 'reads a module const object field', kind: 'impure', source: `const config = {n: 5}\nfunction f() { return config.n }`},
  {label: 'reads a mutable static primitive', kind: 'impure', source: `class State { static count = 0 }\nfunction f() { return State.count }`},
  {label: 'reads a mutable static primitive with bracket access', kind: 'impure', source: `class State { static count = 0 }\nfunction f() { return State['count'] }`},
  {label: 'reads a readonly static object field', kind: 'impure', source: `class State { static readonly config = {count: 0} }\nfunction f() { return State.config.count }`},
  {label: 'returns a mutable class object', kind: 'impure', source: `class State {}\nfunction f() { return State }`},
  {label: 'console.log is I/O', kind: 'impure', source: `function f(x: number) { console.log(x); return x }`},
  {label: 'any console method is I/O', kind: 'impure', source: `function f(x: number) { console.countReset(); return x }`},
  {label: 'Math.random is nondeterministic', kind: 'impure', source: `function f() { return Math.random() }`},
  {label: 'Date.now is nondeterministic', kind: 'impure', source: `function f() { return Date.now() }`},
  {label: 'new Date reads the clock', kind: 'impure', source: `function f() { return new Date() }`},
  {label: 'Object.freeze mutates its argument', kind: 'impure', source: `function f(box: {value: number}) { Object.freeze(box); return box.value }`},
  {label: 'calls an impure helper (transitive)', kind: 'impure', source: `function noisy() { return Math.random() }\nfunction f() { return noisy() }`},
  {label: 'calls an impure top-level arrow helper', kind: 'impure', source: `const noisy = () => Math.random()\nfunction f() { return noisy() }`},
  {label: 'impure overload implementation', kind: 'impure', source: `function helper(value: number): number\nfunction helper(value: number, extra: number): number\nfunction helper(value: number, extra?: number) { return Math.random() + value + (extra ?? 0) }\nfunction f() { return helper(1) }`},
  {label: 'map with impure inline callback', kind: 'impure', source: `function f(xs: number[]) { return xs.map(() => Math.random())[0] ?? 0 }`},
  {label: 'map with a resolvable impure callback', kind: 'impure', source: `function bump(n: number) { return Math.random() + n }\nfunction f(xs: number[]) { return xs.map(bump)[0] ?? 0 }`},
  {label: 'sort with an impure comparator', kind: 'impure', source: `function f(xs: number[]) { xs.sort(() => Math.random()); return xs.length }`},
  {label: 'toSorted with an impure comparator', kind: 'impure', source: `function f(xs: number[]) { return xs.toSorted(() => Math.random())[0] ?? 0 }`},
  {label: 'callback this mutation reaches the this argument', kind: 'impure', source: `function f(xs: number[], box: {n: number}) { xs.map(function (this: {n: number}, value) { this.n = value; return value }, box); return 1 }`},
  {label: 'arrow callback mutation reaches lexical this', kind: 'impure', source: `function f(this: {n: number}, xs: number[]) { const local = {n: 0}; xs.map(() => { this.n += 1; return 0 }, local); return 1 }`},
  {label: 'block local does not hide module read', kind: 'impure', source: `let state = 1\nfunction f(flag: boolean) { const before = state; if (flag) { const state = 2; return state } return before }`},
  {label: 'reads readonly static primitive', kind: 'impure', source: `class Limits { static readonly max = 100 }\nfunction f(x: number) { return Math.min(x, Limits.max) }`},

  // --- unknown ---
  {label: 'shadowed Math is not the platform global', kind: 'unknown', source: `function f(Math: {min(): number}) { return Math.min() }`},
  {label: 'user map method is not Array map', kind: 'unknown', source: `function f(service: {map(): number}) { return service.map() }`},
  {label: 'calls a source static method', kind: 'unknown', source: `class Limits { static clamp(x: number) { return Math.min(x, 100) } }\nfunction f(x: number) { return Limits.clamp(x) }`},
  {label: 'constructs a source class with no effects', kind: 'unknown', source: `class Box {}\nfunction f() { return new Box() }`},
  {label: 'source constructor effects stay unknown at the call boundary', kind: 'unknown', source: `let total = 0\nclass Counter { constructor() { total++ } }\nfunction f() { return new Counter() }`},
  {label: 'calls a source instance method', kind: 'unknown', source: `class Counter { value() { return 1 } }\nfunction f(counter: Counter) { return counter.value() }`},
  {label: 'runtime override keeps a source method unknown', kind: 'unknown', source: `class Base { value() { return 1 } }\nclass Child extends Base { override value() { return Math.random() } }\nfunction f(counter: Base) { return counter.value() }`},
  {label: 'same-named source method stays unknown', kind: 'unknown', source: `class Pure { value() { return 1 } }\nclass Impure { value() { return Math.random() } }\nfunction f(counter: Pure) { return counter.value() }`},
  {label: 'source getter effects stay unknown at the call boundary', kind: 'unknown', source: `let total = 0\nclass Counter { get value() { return total++ } }\nfunction f(counter: Counter) { return counter.value }`},
  {label: 'source setter effects stay unknown at the call boundary', kind: 'unknown', source: `let total = 0\nclass Counter { set value(next: number) { total = next } }\nfunction f(counter: Counter) { counter.value = 1; return 1 }`},
  {label: 'empty source setter stays unknown', kind: 'unknown', source: `class Counter { set value(next: number) {} }\nfunction f(counter: Counter) { counter.value = 1; return 1 }`},
  {label: 'computed source getter stays unknown', kind: 'unknown', source: `class Counter { get value() { return 1 } }\nfunction f(counter: Counter) { return counter['value'] }`},
  {label: 'Array.from iterator behavior stays unknown', kind: 'unknown', reasonIncludes: 'Array.from is unsupported because it can call an iterator or mapper supplied by user code', source: `function f(xs: number[]) { return Array.from(xs).length }`},
  {label: 'platform rejection reason propagates through helpers', kind: 'unknown', reasonIncludes: 'Array.from is unsupported because it can call an iterator or mapper supplied by user code', source: `function copy(xs: number[]) { return Array.from(xs) }\nfunction f(xs: number[]) { return copy(xs).length }`},
  {label: 'JSON parse behavior stays unknown', kind: 'unknown', reasonIncludes: 'JSON.parse is unsupported because its result values are not modeled and its optional callback can run user code', source: `function f(value: string) { return JSON.parse(value) }`},
  {label: 'JSON getter behavior stays unknown', kind: 'unknown', reasonIncludes: 'JSON.stringify is unsupported because it can run getters or toJSON methods', source: `function f(value: {x: number}) { return JSON.stringify(value).length }`},
  {label: 'Object.entries getter behavior stays unknown', kind: 'unknown', reasonIncludes: 'Object.entries is unsupported because reading property values can run getters', source: `function f(value: {x: number}) { return Object.entries(value).length }`},
  {label: 'Object.values getter behavior stays unknown', kind: 'unknown', reasonIncludes: 'Object.values is unsupported because reading property values can run getters', source: `function f(value: {x: number}) { return Object.values(value).length }`},
  {label: 'Date.parse environment behavior stays unknown', kind: 'unknown', reasonIncludes: "Date.parse is unsupported because some date strings depend on the machine's time zone or accepted formats", source: `function f(value: string) { return Date.parse(value) }`},
  {label: 'sort without a comparator stays unknown', kind: 'unknown', reasonIncludes: 'Array.sort without a comparator is unsupported because default sorting converts elements to strings and can run user code', source: `function f(xs: number[]) { return xs.sort()[0] ?? 0 }`},
  {label: 'toSorted without a comparator stays unknown', kind: 'unknown', reasonIncludes: 'Array.toSorted without a comparator is unsupported because default sorting converts elements to strings and can run user code', source: `function f(xs: number[]) { return xs.toSorted()[0] ?? 0 }`},
  {label: 'reduce recurrence stays unknown', kind: 'unknown', reasonIncludes: 'Array.reduce is unsupported because each callback result becomes the next callback input', source: `function f(xs: number[]) { return xs.reduce((total, value) => total + value, 0) }`},
  {label: 'flat stays unknown', kind: 'unknown', reasonIncludes: 'Array.flat is unsupported because it conditionally removes nested array containers', source: `function f(xs: number[][]) { return xs.flat()[0] ?? 0 }`},
  {label: 'flatMap stays unknown', kind: 'unknown', reasonIncludes: 'Array.flatMap is unsupported because it conditionally removes an array returned by its callback', source: `function f(xs: number[][]) { return xs.flatMap(value => value)[0] ?? 0 }`},
  {label: 'collection entries pair stays unknown', kind: 'unknown', reasonIncludes: 'Collection.entries is unsupported because each result is wrapped in a new pair', source: `function f(xs: number[]) { return [...xs.entries()].length }`},
  {label: 'arbitrary iterable spread stays unknown', kind: 'unknown', reasonIncludes: 'spread is unsupported because its iterator can run user code', source: `function f(values: Iterable<number>) { return [...values].length }`},
  {label: 'destructuring getter stays unknown', kind: 'unknown', reasonIncludes: 'object destructuring is unsupported because reading a property can call a getter', source: `class Source { get selected() { return Math.random() } }\nfunction f(source: Source) { const {selected} = source; return selected }`},
  {label: 'object spread getter stays unknown', kind: 'unknown', reasonIncludes: 'object spread is unsupported because reading a property can call a getter', source: `function f() { const source = {get selected() { return Math.random() }}; const copy = {...source}; return Object.keys(copy).length }`},
  {label: 'nested array destructuring arbitrary iterable stays unknown', kind: 'unknown', reasonIncludes: 'array destructuring is unsupported because its iterator can run user code', source: `function f({items: [value]}: {items: Iterable<number>}) { return value }`},
  {label: 'nested destructuring getter stays unknown', kind: 'unknown', reasonIncludes: 'object destructuring is unsupported because reading a property can call a getter', source: `class Inner { get value() { return Math.random() } }\nfunction f({outer: {value}}: {outer: Inner}) { return value }`},
  {label: 'getter in an object pattern nested in an array stays unknown', kind: 'unknown', reasonIncludes: 'object destructuring is unsupported because reading a property can call a getter', source: `class Item { get value() { return Math.random() } }\nfunction f(items: [Item]) { const [{value}] = items; return value }`},
  {label: 'unknown helper result mutation stays unknown', kind: 'unknown', reasonIncludes: 'calls a function whose body cannot be analyzed', source: `declare function externalCall(box: {n: number}): {n: number}\nfunction f(box: {n: number}) { externalCall(box).n += 1; return 1 }`},
  {label: 'recursive fresh return growth stays unknown', kind: 'unknown', reasonIncludes: 'recursive returned references keep adding container layers', source: `type Link = {box: {n: number}, next?: Link}\nfunction wrap(box: {n: number}, stop: boolean): Link { return stop ? {box} : {box, next: wrap(box, true)} }\nfunction f(box: {n: number}) { wrap(box, false).next!.box.n += 1; return 1 }`},
  {label: 'typed array mutable source construction stays unknown', kind: 'unknown', reasonIncludes: 'typed array construction from mutable input is unsupported', source: `function f(buffer: ArrayBuffer) { return new Uint8Array(buffer).length }`},
  {label: 'unavailable constructor is unknown', kind: 'unknown', source: `declare class Counter {}\nfunction f() { return new Counter() }`},
  {label: 'calls an unresolved function', kind: 'unknown', source: `declare function ext(n: number): number\nfunction f(x: number) { return ext(x) }`},
  {label: 'map with an unresolvable callback parameter', kind: 'unknown', source: `function f(xs: number[], cb: (n: number) => number) { return xs.map(cb)[0] ?? 0 }`},
  {label: 'forEach with an unresolvable callback parameter', kind: 'unknown', source: `function f(xs: number[], cb: (n: number) => void) { xs.forEach(cb); return xs.length }`},
  {label: 'local arrow shadows top-level pure helper', kind: 'unknown', source: `function helper() { return 1 }\nfunction f() { const helper = () => Math.random(); return helper() }`},
  {label: 'local arrow shadows top-level impure helper', kind: 'unknown', source: `function helper() { return Math.random() }\nfunction f() { const helper = () => 1; return helper() }`},
  {label: 'callback parameter shadows top-level helper', kind: 'unknown', source: `function helper() { return 1 }\nfunction f(helper: () => number) { return helper() }`},
  {label: 'nested declaration shadows top-level helper', kind: 'unknown', source: `function helper() { return 1 }\nfunction f() { function helper() { return Math.random() } return helper() }`},
]

let failures = 0
for (const {label, source, kind, reasonIncludes} of cases) {
  const actual = purityOf('f', source)
  if (
    actual.kind !== kind
    || (reasonIncludes != null && (!('reason' in actual) || !actual.reason.includes(reasonIncludes)))
  ) {
    console.error(`purity: expected ${kind}${reasonIncludes == null ? '' : ` with "${reasonIncludes}"`} but got ${JSON.stringify(actual)} for "${label}"`)
    failures += 1
  }
}
if (failures > 0) {
  suite.fail()
} else {
  console.log(`purity: ${cases.length} classifications`)
}

const cacheOrderSource = `
function wrap(value: {n: number}) { return [{value}] }
function f(value: {n: number}) { wrap(value)[0]!.value.n += 1 }
`
const calleeFirstProgram = buildFitSourceFile('callee-first.ts', cacheOrderSource, readTopLevelGlobal)
const calleeFirstWrap = calleeFirstProgram.functions.get('wrap')
const calleeFirstCaller = calleeFirstProgram.functions.get('f')
if (calleeFirstWrap == null || calleeFirstCaller == null) throw new Error('expected cache-order functions')
functionPurity(functionImplementationReference(calleeFirstProgram, calleeFirstWrap.node))
const calleeFirstResult = functionPurity(
  functionImplementationReference(calleeFirstProgram, calleeFirstCaller.node),
)
const callerFirstProgram = buildFitSourceFile('caller-first.ts', cacheOrderSource, readTopLevelGlobal)
const callerFirstCaller = callerFirstProgram.functions.get('f')
if (callerFirstCaller == null) throw new Error('expected caller-first function')
const callerFirstResult = functionPurity(
  functionImplementationReference(callerFirstProgram, callerFirstCaller.node),
)
if (
  calleeFirstResult.kind !== 'impure'
  || callerFirstResult.kind !== 'impure'
  || calleeFirstResult.reason !== callerFirstResult.reason
) {
  console.error('purity: expected function summary cache order not to change returned-reference effects')
  console.error(JSON.stringify({calleeFirstResult, callerFirstResult}, null, 2))
  suite.fail()
} else {
  console.log('purity: returned-reference summaries are independent of cache order')
}

const identityProject = loadFitProject(['tests/purity/imported-caller.ts'], readTopLevelGlobal)
const identityCaller = identityProject.entries[0]!
const callbackBinding = identityCaller.imports.get('importedPureCallback')
if (callbackBinding == null || callbackBinding.kind !== 'resolved') {
  throw new Error('expected importedPureCallback to resolve')
}
const identityHelper = callbackBinding.file
const importedCallback = identityHelper.functions.get('importedPureCallback')
if (importedCallback == null) throw new Error('expected importedPureCallback implementation')
let mismatchedReferenceReason: string | null = null
try {
  functionPurity({program: identityCaller, node: importedCallback.node})
} catch (error) {
  mismatchedReferenceReason = error instanceof Error ? error.message : String(error)
}
const purityAfterRejectedMismatch = functionPurity(
  functionImplementationReference(identityHelper, importedCallback.node),
)
if (
  mismatchedReferenceReason?.includes('does not belong') !== true
  || purityAfterRejectedMismatch.kind !== 'pure'
) {
  console.error('purity: expected mismatched source programs to fail before caching')
  console.error(JSON.stringify({mismatchedReferenceReason, purityAfterRejectedMismatch}, null, 2))
  suite.fail()
} else {
  console.log('purity: implementation and source program stay one cache identity')
}

const importedPurity = await verifyFitFiles(['tests/purity/imported-caller.ts'])
const pureClaim = importedPurity.checks.find(check => check.functionName === 'importedAliasPure' && check.text === 'pure')
const impureClaim = importedPurity.checks.find(check => check.functionName === 'importedAliasImpure' && check.text === 'pure')
const namespaceClaim = importedPurity.checks.find(check => check.functionName === 'importedNamespacePure' && check.text === 'pure')
const impureNamespaceClaim = importedPurity.checks.find(check => check.functionName === 'importedNamespaceImpure' && check.text === 'pure')
const defaultClaim = importedPurity.checks.find(check => check.functionName === 'importedDefaultAliasPure' && check.text === 'pure')
const primitiveClaim = importedPurity.checks.find(check => check.functionName === 'importedPrimitivePure' && check.text === 'pure')
const namespacePrimitiveClaim = importedPurity.checks.find(check => check.functionName === 'importedNamespacePrimitivePure' && check.text === 'pure')
const pureContract = importedPurity.checks.find(check => check.functionName === 'contractUsesImportedAlias' && check.text === 'return <= identity()')
const impureContract = importedPurity.checks.find(check => check.functionName === 'contractRejectsImportedAlias' && check.text === 'return <= noisy()')
const callbackContract = importedPurity.checks.find(check => check.functionName === 'contractUsesImportedCallbackAfterMap' && check.text === 'return <= importedPureCallback(0)')
const importedWrapperReplacement = importedPurity.checks.find(check =>
  check.functionName === 'importedWrapperReplacementPure' && check.text === 'pure')
const importedWrapperMutation = importedPurity.checks.find(check =>
  check.functionName === 'importedWrapperMutationImpure' && check.text === 'pure')
if (
  pureClaim?.status !== 'pass'
  || impureClaim?.status !== 'fail'
  || namespaceClaim?.status !== 'pass'
  || impureNamespaceClaim?.status !== 'fail'
  || defaultClaim?.status !== 'pass'
  || primitiveClaim?.status !== 'pass'
  || namespacePrimitiveClaim?.status !== 'pass'
  || pureContract?.status !== 'pass'
  || impureContract?.status !== 'unknown'
  || callbackContract?.status !== 'pass'
  || importedWrapperReplacement?.status !== 'pass'
  || importedWrapperMutation?.status !== 'fail'
  || importedWrapperMutation.reason?.includes('mutates parameter `value`') !== true
  || impureClaim.reason?.includes('observes the environment') !== true
  || impureNamespaceClaim.reason?.includes('observes the environment') !== true
  || impureContract.reason?.includes('helper importedImpure is not pure: observes the environment') !== true
) {
  console.error('purity: expected imports, aliases, callbacks, and re-exports to keep source identity')
  console.error(JSON.stringify(importedPurity.checks, null, 2))
  suite.fail()
} else {
  console.log('purity: imported aliases, callbacks, and contract helpers share source identity')
}

})
