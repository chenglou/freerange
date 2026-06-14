// Pure-function classification: `bun tests/purity/purity-tests.ts` (run via test.ts).
// isFunctionPure is a pure function of the source, so each case is just
// source -> pure | impure | unknown, no interpreter run or proof needed.
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
  importedNamespacePure,
  importedNamedCallbackKeepsSourceProgram,
} from './imported-caller.ts'

void contractRejectsImportedAlias
void contractUsesImportedCallbackAfterMap
void contractUsesImportedAlias
void importedAliasImpure
void importedAliasPure
void importedDefaultAliasPure
void importedNamespaceImpure
void importedNamespacePure
void importedNamedCallbackKeepsSourceProgram

function purityOf(name: string, source: string): Purity['kind'] {
  const program = buildFitSourceFile('purity.ts', source, readTopLevelGlobal)
  const fn = program.functions.get(name)
  if (fn == null) throw new Error(`no function ${name} in source`)
  return functionPurity(functionImplementationReference(program, fn.node)).kind
}

const cases: {label: string; source: string; kind: Purity['kind']}[] = [
  // --- pure ---
  {label: 'arithmetic on params', kind: 'pure', source: `function f(x: number) { return x * 2 + 1 }`},
  {label: 'local array build with push', kind: 'pure', source: `function f(x: number) { const ys: number[] = []; ys.push(x); return ys.length }`},
  {label: 'local let mutation', kind: 'pure', source: `function f(x: number) { let t = 0; t += x; return t }`},
  {label: 'Math (non-random)', kind: 'pure', source: `function f(x: number) { return Math.min(Math.abs(x), 10) }`},
  {label: 'reads module const primitive', kind: 'pure', source: `const MAX = 100\nfunction f(x: number) { return Math.min(x, MAX) }`},
  {label: 'reads readonly static primitive', kind: 'pure', source: `class Limits { static readonly max = 100 }\nfunction f(x: number) { return Math.min(x, Limits.max) }`},
  {label: 'calls a pure static source method', kind: 'pure', source: `class Limits { static clamp(x: number) { return Math.min(x, 100) } }\nfunction f(x: number) { return Limits.clamp(x) }`},
  {label: 'constructs a source class with no effects', kind: 'pure', source: `class Box {}\nfunction f() { return new Box() }`},
  {label: 'map with pure inline callback', kind: 'pure', source: `function f(xs: number[]) { return xs.map(y => y * 2)[0] ?? 0 }`},
  {label: 'calls a pure helper', kind: 'pure', source: `function dbl(n: number) { return n * 2 }\nfunction f(x: number) { return dbl(x) }`},
  {label: 'calls a top-level arrow helper', kind: 'pure', source: `const dbl = (n: number) => n * 2\nfunction f(x: number) { return dbl(x) }`},
  {label: 'calls a top-level helper alias', kind: 'pure', source: `function dbl(n: number) { return n * 2 }\nconst twice = dbl\nfunction f(x: number) { return twice(x) }`},
  {label: 'pure overload implementation', kind: 'pure', source: `function helper(value: number): number\nfunction helper(value: number, extra: number): number\nfunction helper(value: number, extra?: number) { return value + (extra ?? 0) }\nfunction f() { return helper(1) }`},
  {label: 'allocates and returns a fresh object', kind: 'pure', source: `function f(x: number) { return {v: x} }`},
  {label: 'unused impure closure does not execute', kind: 'pure', source: `function f() { const noisy = () => Math.random(); return 1 }`},
  {label: 'calls a pure source method', kind: 'pure', source: `class Counter { value() { return 1 } }\nfunction f(counter: Counter) { return counter.value() }`},
  {label: 'same-named pure method keeps its class identity', kind: 'pure', source: `class Pure { value() { return 1 } }\nclass Impure { value() { return Math.random() } }\nfunction f(counter: Pure) { return counter.value() }`},
  {label: 'calls a pure setter', kind: 'pure', source: `class Counter { set value(next: number) {} }\nfunction f(counter: Counter) { counter.value = 1; return 1 }`},
  {label: 'block local shadows parameter by binding', kind: 'pure', source: `function f(box: {value: number}) { { const box = {value: 0}; box.value = 1 } return 1 }`},
  {label: 'callback mutation of captured local stays local', kind: 'pure', source: `function f(values: number[]) { let count = 0; values.forEach(() => count++); return count }`},
  {label: 'callback read of captured local stays local', kind: 'pure', source: `function f(values: number[]) { let offset = 1; return values.map(value => value + offset)[0] ?? 0 }`},

  // --- impure ---
  {label: 'mutates a parameter', kind: 'impure', source: `function f(o: {v: number}) { o.v = 9; return 1 }`},
  {label: 'pushes onto a parameter', kind: 'impure', source: `function f(xs: number[]) { xs.push(9); return xs.length }`},
  {label: 'writes a module variable', kind: 'impure', source: `let total = 0\nfunction f(x: number) { total = total + x; return total }`},
  {label: 'reads a module let', kind: 'impure', source: `let counter = 0\nfunction f() { return counter }`},
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
  {label: 'source constructor writes outside state', kind: 'impure', source: `let total = 0\nclass Counter { constructor() { total++ } }\nfunction f() { return new Counter() }`},
  {label: 'source getter writes outside state', kind: 'impure', source: `let total = 0\nclass Counter { get value() { return total++ } }\nfunction f(counter: Counter) { return counter.value }`},
  {label: 'source setter writes outside state', kind: 'impure', source: `let total = 0\nclass Counter { set value(next: number) { total = next } }\nfunction f(counter: Counter) { counter.value = 1; return 1 }`},
  {label: 'calls an impure helper (transitive)', kind: 'impure', source: `function noisy() { return Math.random() }\nfunction f() { return noisy() }`},
  {label: 'calls an impure top-level arrow helper', kind: 'impure', source: `const noisy = () => Math.random()\nfunction f() { return noisy() }`},
  {label: 'impure overload implementation', kind: 'impure', source: `function helper(value: number): number\nfunction helper(value: number, extra: number): number\nfunction helper(value: number, extra?: number) { return Math.random() + value + (extra ?? 0) }\nfunction f() { return helper(1) }`},
  {label: 'map with impure inline callback', kind: 'impure', source: `function f(xs: number[]) { return xs.map(() => Math.random())[0] ?? 0 }`},
  {label: 'map with a resolvable impure callback', kind: 'impure', source: `function bump(n: number) { return Math.random() + n }\nfunction f(xs: number[]) { return xs.map(bump)[0] ?? 0 }`},
  {label: 'same-named impure method keeps its class identity', kind: 'impure', source: `class Pure { value() { return 1 } }\nclass Impure { value() { return Math.random() } }\nfunction f(counter: Impure) { return counter.value() }`},
  {label: 'block local does not hide module read', kind: 'impure', source: `let state = 1\nfunction f(flag: boolean) { const before = state; if (flag) { const state = 2; return state } return before }`},

  // --- unknown ---
  {label: 'shadowed Math is not the platform global', kind: 'unknown', source: `function f(Math: {min(): number}) { return Math.min() }`},
  {label: 'user map method is not Array map', kind: 'unknown', source: `function f(service: {map(): number}) { return service.map() }`},
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
  process.exitCode = 1
} else {
  console.log('purity: implementation and source program stay one cache identity')
}

const importedPurity = await verifyFitFiles(['tests/purity/imported-caller.ts'])
const pureClaim = importedPurity.checks.find(check => check.functionName === 'importedAliasPure' && check.text === 'pure')
const impureClaim = importedPurity.checks.find(check => check.functionName === 'importedAliasImpure' && check.text === 'pure')
const namespaceClaim = importedPurity.checks.find(check => check.functionName === 'importedNamespacePure' && check.text === 'pure')
const impureNamespaceClaim = importedPurity.checks.find(check => check.functionName === 'importedNamespaceImpure' && check.text === 'pure')
const defaultClaim = importedPurity.checks.find(check => check.functionName === 'importedDefaultAliasPure' && check.text === 'pure')
const pureContract = importedPurity.checks.find(check => check.functionName === 'contractUsesImportedAlias' && check.text === 'return <= identity()')
const impureContract = importedPurity.checks.find(check => check.functionName === 'contractRejectsImportedAlias' && check.text === 'return <= noisy()')
const callbackContract = importedPurity.checks.find(check => check.functionName === 'contractUsesImportedCallbackAfterMap' && check.text === 'return <= importedPureCallback(0)')
if (
  pureClaim?.status !== 'pass'
  || impureClaim?.status !== 'fail'
  || namespaceClaim?.status !== 'pass'
  || impureNamespaceClaim?.status !== 'fail'
  || defaultClaim?.status !== 'pass'
  || pureContract?.status !== 'pass'
  || impureContract?.status !== 'unknown'
  || callbackContract?.status !== 'pass'
  || impureClaim.reason?.includes('observes the environment') !== true
  || impureNamespaceClaim.reason?.includes('observes the environment') !== true
  || impureContract.reason?.includes('helper importedImpure is not pure: observes the environment') !== true
) {
  console.error('purity: expected imports, aliases, callbacks, and re-exports to keep source identity')
  console.error(JSON.stringify(importedPurity.checks, null, 2))
  process.exitCode = 1
} else {
  console.log('purity: imported aliases, callbacks, and contract helpers share source identity')
}
