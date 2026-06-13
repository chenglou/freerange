// Pure-function classification: `bun tests/purity/purity-tests.ts` (run via test.ts).
// isFunctionPure is a pure function of the source, so each case is just
// source -> pure | impure, no interpreter run or proof needed.
import {readTopLevelGlobal} from '../../src/check-core.ts'
import {functionPurity} from '../../src/interpreter/function-effects.ts'
import {buildFitSourceFile} from '../../src/modules.ts'

function purityOf(name: string, source: string): boolean {
  const program = buildFitSourceFile('purity.ts', source, readTopLevelGlobal)
  const fn = program.functions.get(name)
  if (fn == null) throw new Error(`no function ${name} in source`)
  return functionPurity(fn.node, program).pure
}

const cases: {label: string; source: string; pure: boolean}[] = [
  // --- pure ---
  {label: 'arithmetic on params', pure: true, source: `function f(x: number) { return x * 2 + 1 }`},
  {label: 'local array build with push', pure: true, source: `function f(x: number) { const ys: number[] = []; ys.push(x); return ys.length }`},
  {label: 'local let mutation', pure: true, source: `function f(x: number) { let t = 0; t += x; return t }`},
  {label: 'Math (non-random)', pure: true, source: `function f(x: number) { return Math.min(Math.abs(x), 10) }`},
  {label: 'reads module const primitive', pure: true, source: `const MAX = 100\nfunction f(x: number) { return Math.min(x, MAX) }`},
  {label: 'map with pure inline callback', pure: true, source: `function f(xs: number[]) { return xs.map(y => y * 2)[0] ?? 0 }`},
  {label: 'calls a pure helper', pure: true, source: `function dbl(n: number) { return n * 2 }\nfunction f(x: number) { return dbl(x) }`},
  {label: 'allocates and returns a fresh object', pure: true, source: `function f(x: number) { return {v: x} }`},

  // --- impure ---
  {label: 'mutates a parameter', pure: false, source: `function f(o: {v: number}) { o.v = 9; return 1 }`},
  {label: 'pushes onto a parameter', pure: false, source: `function f(xs: number[]) { xs.push(9); return xs.length }`},
  {label: 'writes a module variable', pure: false, source: `let total = 0\nfunction f(x: number) { total = total + x; return total }`},
  {label: 'reads a module let', pure: false, source: `let counter = 0\nfunction f() { return counter }`},
  {label: 'reads a module const object field', pure: false, source: `const config = {n: 5}\nfunction f() { return config.n }`},
  {label: 'console.log is I/O', pure: false, source: `function f(x: number) { console.log(x); return x }`},
  {label: 'any console method is I/O', pure: false, source: `function f(x: number) { console.countReset(); return x }`},
  {label: 'Math.random is nondeterministic', pure: false, source: `function f() { return Math.random() }`},
  {label: 'Date.now is nondeterministic', pure: false, source: `function f() { return Date.now() }`},
  {label: 'calls an unresolved function', pure: false, source: `declare function ext(n: number): number\nfunction f(x: number) { return ext(x) }`},
  {label: 'calls an impure helper (transitive)', pure: false, source: `function noisy() { return Math.random() }\nfunction f() { return noisy() }`},
  {label: 'map with impure inline callback', pure: false, source: `function f(xs: number[]) { return xs.map(() => Math.random())[0] ?? 0 }`},
  {label: 'map with a resolvable impure callback', pure: false, source: `function bump(n: number) { return Math.random() + n }\nfunction f(xs: number[]) { return xs.map(bump)[0] ?? 0 }`},
  {label: 'map with an unresolvable callback parameter', pure: false, source: `function f(xs: number[], cb: (n: number) => number) { return xs.map(cb)[0] ?? 0 }`},
  {label: 'forEach with an unresolvable callback parameter', pure: false, source: `function f(xs: number[], cb: (n: number) => void) { xs.forEach(cb); return xs.length }`},
]

let failures = 0
for (const {label, source, pure} of cases) {
  const actual = purityOf('f', source)
  if (actual !== pure) {
    console.error(`purity: expected ${pure ? 'pure' : 'impure'} but got ${actual ? 'pure' : 'impure'} for "${label}"`)
    failures += 1
  }
}
if (failures > 0) {
  process.exitCode = 1
} else {
  console.log(`purity: ${cases.length} classifications`)
}
