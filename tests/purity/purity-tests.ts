// Pure-function classification: `bun tests/purity/purity-tests.ts` (run via test.ts).
// isFunctionPure is a pure function of the source, so each case is just
// source -> pure | impure | unknown, no interpreter run or proof needed.
import {readTopLevelGlobal} from '../../src/check-core.ts'
import {functionPurity, type Purity} from '../../src/interpreter/function-effects.ts'
import {buildFitSourceFile} from '../../src/modules.ts'

function purityOf(name: string, source: string): Purity['kind'] {
  const program = buildFitSourceFile('purity.ts', source, readTopLevelGlobal)
  const fn = program.functions.get(name)
  if (fn == null) throw new Error(`no function ${name} in source`)
  return functionPurity(fn.node, program).kind
}

const cases: {label: string; source: string; kind: Purity['kind']}[] = [
  // --- pure ---
  {label: 'arithmetic on params', kind: 'pure', source: `function f(x: number) { return x * 2 + 1 }`},
  {label: 'local array build with push', kind: 'pure', source: `function f(x: number) { const ys: number[] = []; ys.push(x); return ys.length }`},
  {label: 'local let mutation', kind: 'pure', source: `function f(x: number) { let t = 0; t += x; return t }`},
  {label: 'Math (non-random)', kind: 'pure', source: `function f(x: number) { return Math.min(Math.abs(x), 10) }`},
  {label: 'reads module const primitive', kind: 'pure', source: `const MAX = 100\nfunction f(x: number) { return Math.min(x, MAX) }`},
  {label: 'map with pure inline callback', kind: 'pure', source: `function f(xs: number[]) { return xs.map(y => y * 2)[0] ?? 0 }`},
  {label: 'calls a pure helper', kind: 'pure', source: `function dbl(n: number) { return n * 2 }\nfunction f(x: number) { return dbl(x) }`},
  {label: 'allocates and returns a fresh object', kind: 'pure', source: `function f(x: number) { return {v: x} }`},
  {label: 'unused impure closure does not execute', kind: 'pure', source: `function f() { const noisy = () => Math.random(); return 1 }`},
  {label: 'calls a pure source method', kind: 'pure', source: `class Counter { value() { return 1 } }\nfunction f(counter: Counter) { return counter.value() }`},
  {label: 'calls a pure setter', kind: 'pure', source: `class Counter { set value(next: number) {} }\nfunction f(counter: Counter) { counter.value = 1; return 1 }`},

  // --- impure ---
  {label: 'mutates a parameter', kind: 'impure', source: `function f(o: {v: number}) { o.v = 9; return 1 }`},
  {label: 'pushes onto a parameter', kind: 'impure', source: `function f(xs: number[]) { xs.push(9); return xs.length }`},
  {label: 'writes a module variable', kind: 'impure', source: `let total = 0\nfunction f(x: number) { total = total + x; return total }`},
  {label: 'reads a module let', kind: 'impure', source: `let counter = 0\nfunction f() { return counter }`},
  {label: 'reads a module const object field', kind: 'impure', source: `const config = {n: 5}\nfunction f() { return config.n }`},
  {label: 'console.log is I/O', kind: 'impure', source: `function f(x: number) { console.log(x); return x }`},
  {label: 'any console method is I/O', kind: 'impure', source: `function f(x: number) { console.countReset(); return x }`},
  {label: 'Math.random is nondeterministic', kind: 'impure', source: `function f() { return Math.random() }`},
  {label: 'Date.now is nondeterministic', kind: 'impure', source: `function f() { return Date.now() }`},
  {label: 'new Date reads the clock', kind: 'impure', source: `function f() { return new Date() }`},
  {label: 'Object.freeze mutates its argument', kind: 'impure', source: `function f(box: {value: number}) { Object.freeze(box); return box.value }`},
  {label: 'source constructor writes outside state', kind: 'impure', source: `let total = 0\nclass Counter { constructor() { total++ } }\nfunction f() { return new Counter() }`},
  {label: 'source getter writes outside state', kind: 'impure', source: `let total = 0\nclass Counter { get value() { return total++ } }\nfunction f(counter: Counter) { return counter.value }`},
  {label: 'source setter writes outside state', kind: 'impure', source: `let total = 0\nclass Counter { set value(next: number) { total = next } }\nfunction f(counter: Counter) { counter.value = 1; return 1 }`},
  {label: 'calls an impure helper (transitive)', kind: 'impure', source: `function noisy() { return Math.random() }\nfunction f() { return noisy() }`},
  {label: 'map with impure inline callback', kind: 'impure', source: `function f(xs: number[]) { return xs.map(() => Math.random())[0] ?? 0 }`},
  {label: 'map with a resolvable impure callback', kind: 'impure', source: `function bump(n: number) { return Math.random() + n }\nfunction f(xs: number[]) { return xs.map(bump)[0] ?? 0 }`},

  // --- unknown ---
  {label: 'shadowed Math is not the platform global', kind: 'unknown', source: `function f(Math: {min(): number}) { return Math.min() }`},
  {label: 'user map method is not Array map', kind: 'unknown', source: `function f(service: {map(): number}) { return service.map() }`},
  {label: 'unavailable constructor is unknown', kind: 'unknown', source: `declare class Counter {}\nfunction f() { return new Counter() }`},
  {label: 'calls an unresolved function', kind: 'unknown', source: `declare function ext(n: number): number\nfunction f(x: number) { return ext(x) }`},
  {label: 'map with an unresolvable callback parameter', kind: 'unknown', source: `function f(xs: number[], cb: (n: number) => number) { return xs.map(cb)[0] ?? 0 }`},
  {label: 'forEach with an unresolvable callback parameter', kind: 'unknown', source: `function f(xs: number[], cb: (n: number) => void) { xs.forEach(cb); return xs.length }`},
]

let failures = 0
for (const {label, source, kind} of cases) {
  const actual = purityOf('f', source)
  if (actual !== kind) {
    console.error(`purity: expected ${kind} but got ${actual} for "${label}"`)
    failures += 1
  }
}
if (failures > 0) {
  process.exitCode = 1
} else {
  console.log(`purity: ${cases.length} classifications`)
}
