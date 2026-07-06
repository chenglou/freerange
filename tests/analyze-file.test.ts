import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {analyzeFile, analyzeSource, formatReport, type AnalysisReport} from '../src/index.ts'

const fixture = new URL('./fixtures/grid-metrics.ts', import.meta.url).pathname
const showcaseFixture = new URL('./fixtures/showcase.ts', import.meta.url).pathname
const mutationFixture = new URL('./fixtures/object-mutation.ts', import.meta.url).pathname
const preconditionsFixture = new URL('./fixtures/preconditions.ts', import.meta.url).pathname

function analyzedFunction(report: AnalysisReport, name: string) {
  const fn = report.functions.find(candidate => candidate.name === name)
  if (fn == null || fn.kind !== 'analyzed') throw new Error(`Expected ${name} to be analyzed`)
  return fn
}

describe('analyzeFile', () => {
  test('the showcase module analyzes completely, every function contracted', () => {
    // A subset-conformant miniature of the demo's world (fixtures/showcase.ts): module
    // state trees, spring physics, nullable frame timing, tuple config tables, array
    // processing. Every function gets a full contract — no stops, no rejections — and
    // this pin is the living record of what the analyzer proves on the code shape agents
    // are asked to write.
    const report = analyzeFile(showcaseFixture)
    expect(report.functions.map(fn => `${fn.name}:${fn.kind}`)).toEqual([
      'springStep:analyzed',
      'springDone:analyzed',
      'frameSteps:analyzed',
      'advanceClock:analyzed',
      'moveCursor:analyzed',
      'cursorDistance:analyzed',
      'middleGap:analyzed',
      'totalClamped:analyzed',
      'firstPositive:analyzed',
      'headOr:analyzed',
      'widthPerColumn:analyzed',
    ])
    // The flagship contracts: frame timing proves its exact clamp through the nullish
    // default and a division whose dividend can overflow (division by a finite nonzero
    // constant never makes NaN); the tuple config table reads exactly; array totals stay
    // finite; the record-property division carries its full conditional contract.
    expect(analyzedFunction(report, 'frameSteps').ensures)
      .toEqual(['return is a finite integer number from 0 through 100'])
    expect(analyzedFunction(report, 'middleGap').ensures)
      .toEqual(['return is a finite integer number from 24 through 24'])
    expect(analyzedFunction(report, 'totalClamped').ensures)
      .toEqual(['return is a finite number at least 0'])
    expect(analyzedFunction(report, 'headOr').assumptions)
      .toEqual(['every values element is finite and not NaN', 'fallback is finite and not NaN'])
    expect(analyzedFunction(report, 'widthPerColumn').requires)
      .toEqual([`grid.columnCount is nonzero (division at ${showcaseFixture}:78:10)`])
  })

  test('reports inferred properties of a returned object', () => {
    const report = analyzeFile(fixture)
    const fn = analyzedFunction(report, 'calculateGridMetrics')
    expect(fn.assumptions).toEqual(['containerWidth is finite and not NaN'])
    expect(fn.ensures).toEqual([
      'return.columnCount is a finite integer number from 1 through 7',
      'return.maximumBoxWidth is a finite number at least 1',
    ])
    expect(formatReport(report)).toContain('ensures: return.maximumBoxWidth is a finite number at least 1')

    const consumer = analyzedFunction(report, 'maximumBoxWidthForContainer')
    expect(consumer.ensures).toEqual(['return is a finite number at least 1'])
  })

  test('degrades the inferred result when a divisor may be zero', () => {
    const source = readFileSync(fixture, 'utf8').replace('/ columnCount', '/ containerWidth')
    const report = analyzeSource('unsafe-grid-metrics.ts', source)
    const fn = analyzedFunction(report, 'calculateGridMetrics')
    expect(fn.requires).toEqual([`containerWidth is nonzero (division at ${resolve('unsafe-grid-metrics.ts')}:18:5)`])
    // Math.max(1, ...) keeps its lower bound through the possibly overflowed quotient —
    // min/max are exact on infinities — and the quotient under the nonzero requirement is
    // never NaN, so only overflow remains possible.
    // The blame suffix points at the division that introduced the overflow possibility.
    expect(fn.ensures).toContain(`return.maximumBoxWidth is a possibly non-finite number from 1 through Infinity (can overflow at ${resolve('unsafe-grid-metrics.ts')}:18:5)`)
  })

  test('rejects TypeScript type errors before lowering', () => {
    expect(() => analyzeSource('invalid.ts', `
      export function invalidWidth(containerWidth: string): number {
        return containerWidth
      }
    `)).toThrow('TypeScript: Type \'string\' is not assignable to type \'number\'.')
  })

  test('records a shadowed Math object as unsupported instead of treating it as the standard library', () => {
    const report = analyzeSource('shadowed-math.ts', `
      const Math = {max: (left: number, _right: number): number => left}
      export function chooseWidth(containerWidth: number): number {
        return Math.max(1, containerWidth)
      }
    `)
    expect(report.functions).toEqual([
      // The shadowing declaration itself is top-level code: its arrow function cannot
      // lower, so the initializer skips the statement and keeps going.
      {
        kind: 'partial',
        name: 'module initialization',
        assumptions: [],
        stopped: [],
        skipped: [`expression (ArrowFunction) at ${resolve('shadowed-math.ts')}:2:26`],
        observed: [],
      },
      {
        kind: 'unsupported',
        name: 'chooseWidth',
        unsupported: `function call Math.max at ${resolve('shadowed-math.ts')}:4:16`,
      },
    ])
    expect(formatReport(report)).toContain('  unsupported: function call Math.max at ')
  })

  test('stops one function at unsupported code, records its callers as partial, and keeps analyzing the rest', () => {
    // scaledRemainder is declared before its failing callee: declaration order does not
    // matter because the caller stops at the call during its own evaluation.
    const report = analyzeSource('unsupported-callee.ts', `
      export function scaledRemainder(width: number): number {
        return remainderWidth(width) + 1
      }
      export function remainderWidth(width: number): number {
        return width ** 2
      }
      export function nonnegativeWidth(width: number): number {
        if (width < 0) return 0
        return width
      }
    `)
    const file = resolve('unsupported-callee.ts')
    expect(report.functions).toEqual([
      {
        kind: 'partial',
        name: 'scaledRemainder',
        assumptions: ['width is finite and not NaN'],
        stopped: [`calls remainderWidth, which hit unsupported code (call at ${file}:3:16)`],
        observed: [],
      },
      {
        kind: 'unsupported',
        name: 'remainderWidth',
        unsupported: `binary operator ** (supported: + - * / %, comparisons, and boolean && || !) at ${file}:6:16`,
      },
      {
        kind: 'analyzed',
        name: 'nonnegativeWidth',
        assumptions: ['width is finite and not NaN'],
        requires: [],
        ensures: ['return is a finite number at least 0'],
      },
    ])
  })

  test('records a call omitting defaulted arguments as unsupported instead of crashing', () => {
    // TypeScript accepts scaled() because width has a default value, but lowering never
    // reads parameter initializers, so scaled would receive zero abstract values for one
    // parameter and crash the engine's arity check. The function itself and calls passing
    // every argument analyze normally; only the shorter call stops.
    const report = analyzeSource('default-parameter.ts', `
      function scaled(width: number = 5): number {
        return width * 2
      }
      export function callNoArg(): number {
        return scaled()
      }
      export function callWithArg(): number {
        return scaled(3)
      }
    `)
    const file = resolve('default-parameter.ts')
    expect(report.functions).toEqual([
      {
        kind: 'analyzed',
        name: 'scaled',
        assumptions: ['width is finite and not NaN'],
        requires: [],
        ensures: [`return is a possibly non-finite number from -Infinity through Infinity (can overflow at ${file}:3:16)`],
      },
      {
        kind: 'unsupported',
        name: 'callNoArg',
        unsupported: `call to scaled with fewer arguments than parameters (pass every argument explicitly) at ${file}:6:16`,
      },
      {
        kind: 'analyzed',
        name: 'callWithArg',
        assumptions: [],
        requires: [],
        ensures: ['return is a finite integer number from 6 through 6'],
      },
    ])
  })

  test('names a merely stopped callee accurately in a transitive chain', () => {
    const report = analyzeSource('two-hop.ts', `
      export function outerWidth(width: number): number {
        return middleWidth(width) + 1
      }
      export function middleWidth(width: number): number {
        return remainderWidth(width) + 1
      }
      export function remainderWidth(width: number): number {
        return width ** 2
      }
    `)
    const file = resolve('two-hop.ts')
    expect(report.functions).toEqual([
      {
        kind: 'partial',
        name: 'outerWidth',
        assumptions: ['width is finite and not NaN'],
        stopped: [`calls middleWidth, whose analysis stopped (call at ${file}:3:16)`],
        observed: [],
      },
      {
        kind: 'partial',
        name: 'middleWidth',
        assumptions: ['width is finite and not NaN'],
        stopped: [`calls remainderWidth, which hit unsupported code (call at ${file}:6:16)`],
        observed: [],
      },
      {
        kind: 'unsupported',
        name: 'remainderWidth',
        unsupported: `binary operator ** (supported: + - * / %, comparisons, and boolean && || !) at ${file}:9:16`,
      },
    ])
  })

  test('keeps evidence from completed paths next to a recursion stop', () => {
    const report = analyzeSource('recursion.ts', `
      export function countdown(steps: number): number {
        if (steps <= 0) return 0
        return countdown(steps - 1)
      }
    `)
    const file = resolve('recursion.ts')
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'countdown',
      assumptions: ['steps is finite and not NaN'],
      stopped: [`recursive call to countdown (call at ${file}:4:16)`],
      observed: ['return is a finite integer number from 0 through 0'],
    }])
  })

  test('converges when a loop rebinds fresh records each iteration', () => {
    // Two chained record constructions per iteration: the loop-carried binding widens at
    // the header while records built fresh inside the round stay exact, so the loop
    // converges without losing the cross-read between them.
    const report = analyzeSource('loop-allocation.ts', `
      export function totalHeight(rowCount: number): number {
        let metrics = {height: 0}
        for (let row = 0; row < rowCount; row += 1) {
          const grown = {height: metrics.height + 1}
          metrics = {height: grown.height}
        }
        return metrics.height
      }
    `)
    expect(report.functions).toEqual([{
      kind: 'analyzed',
      name: 'totalHeight',
      assumptions: ['rowCount is finite and not NaN'],
      requires: [],
      ensures: ['return is a finite integer number at least 0'],
    }])
  })

  test('keeps the convergence limit reachable through a long loop-carried chain', () => {
    const report = analyzeSource('chain.ts', `
      export function slowChain(count: number): number {
        let a1 = 0; let a2 = 0; let a3 = 0; let a4 = 0; let a5 = 0; let a6 = 0
        let a7 = 0; let a8 = 0; let a9 = 0; let a10 = 0; let a11 = 0; let a12 = 0
        let a13 = 0; let a14 = 0; let a15 = 0; let a16 = 0; let a17 = 0; let a18 = 0
        for (let index = 0; index < count; index += 1) {
          a18 = a17; a17 = a16; a16 = a15; a15 = a14; a14 = a13; a13 = a12
          a12 = a11; a11 = a10; a10 = a9; a9 = a8; a8 = a7; a7 = a6
          a6 = a5; a5 = a4; a4 = a3; a3 = a2; a2 = a1; a1 = a1 + 1
        }
        return a18
      }
    `)
    const file = resolve('chain.ts')
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'slowChain',
      assumptions: ['count is finite and not NaN'],
      stopped: [`the loop at ${file}:6:9 did not converge after 16 updates`],
      observed: [],
    }])
  })

  test('reads through a branch-merged record join the possible values', () => {
    const report = analyzeSource('merged-read.ts', `
      export function pick(flag: number): number {
        const box = flag > 0 ? {value: 1} : {value: 2}
        return box.value
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
  })

  test('rejects writes into objects with rebinding as the rewrite', () => {
    // Values are immutable after construction; state updates rebind a variable instead.
    const report = analyzeSource('property-write.ts', `
      export function step(config: {pos: number}): void {
        config.pos = 1
      }
    `)
    const file = resolve('property-write.ts')
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'step',
      unsupported: `a write into an object (values are immutable; rebind a variable to a fresh object instead) at ${file}:3:9`,
    }])
  })

  test('keeps a held record exact while a loop rebuilds new ones from the same callee', () => {
    // The loop re-runs makeBox; `first` holds the record from an earlier call of the same
    // function and must stay exactly 1 throughout — a plain value cannot be disturbed by
    // later constructions, however many times the same literal executes.
    const report = analyzeSource('adoption.ts', `
      function makeBox(): {value: number} {
        return {value: 1}
      }
      export function loopBoxes(count: number): number {
        const first = makeBox()
        let last = 0
        for (let index = 0; index < count; index += 1) {
          const box = makeBox()
          const grown = {value: box.value + 1}
          last = grown.value
        }
        return first.value + last
      }
    `)
    expect(analyzedFunction(report, 'loopBoxes').ensures)
      .toEqual(['return is a finite integer number from 1 through 3'])
  })

  test('merges branch results whose branches build different records', () => {
    const report = analyzeSource('skew.ts', `
      export function skewed(flag: number): number {
        if (flag > 0) {
          const extra = {pad: 9}
          const box = {value: 1}
          return box.value + extra.pad - 9
        }
        const box = {value: 2}
        return box.value
      }
    `)
    expect(analyzedFunction(report, 'skewed').ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
  })

  test('optional properties survive branch joins between setting and omitting literals', () => {
    // One branch's literal omits y, the other sets it: the omitted side fills an explicit
    // undefined, so the join keeps the property as its maybe-undefined value instead of
    // dropping it, and the read stays honest.
    const report = analyzeSource('optional-read.ts', `
      type Box = {x: number; y?: number}
      export function pick(flag: number): number {
        let box: Box = {x: 1}
        if (flag > 0) { box = {x: 2, y: 3} }
        return (box.y ?? 0) + box.x
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures)
      .toEqual(['return is a finite integer number from 1 through 5'])
  })

  test('records mixed object shapes as unsupported', () => {
    const report = analyzeSource('mixed-shape.ts', `
      export function pickShape(flag: number) {
        if (flag > 0) return {x: 1}
        return {x: 1, y: 2}
      }
    `)
    const file = resolve('mixed-shape.ts')
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'pickShape',
      unsupported: `value of type { x: number; y?: never; } | { x: number; y: number; } at ${file}:2:7`,
    }])
  })

  test('a division by a record property mints a property-path requirement', () => {
    // Sound to name because values are immutable: grid.columnCount cannot change between
    // function entry and the division. This used to stop with divisorUnknown.
    const report = analyzeSource('property-divisor.ts', `
      export function widthPerColumn(grid: {columnCount: number}, width: number): number {
        return width / grid.columnCount
      }
    `)
    const file = resolve('property-divisor.ts')
    const fn = analyzedFunction(report, 'widthPerColumn')
    expect(fn.requires).toEqual([`grid.columnCount is nonzero (division at ${file}:3:16)`])
  })

  test('propagates an unproven property-path requirement to the caller', () => {
    const report = analyzeSource('caller-specific.ts', `
      export function divideWidth(width: number, columnCount: number): number {
        return width / columnCount
      }
      export function divideByGridColumns(grid: {columnCount: number}, width: number): number {
        return divideWidth(width, grid.columnCount)
      }
    `)
    const file = resolve('caller-specific.ts')
    expect(analyzedFunction(report, 'divideWidth').requires)
      .toEqual([`columnCount is nonzero (division at ${file}:3:16)`])
    // The unproven part propagates with the caller's argument substituted in: the caller's
    // requirement names its own grid.columnCount while pointing at the callee's division.
    const caller = analyzedFunction(report, 'divideByGridColumns')
    expect(caller.requires).toEqual([`grid.columnCount is nonzero (division at ${file}:3:16)`])
  })

  test('converges when a called helper allocates inside a loop', () => {
    const report = analyzeSource('loop-limit.ts', `
      function allocateTemporary(): number {
        const box = {value: 1}
        return box.value
      }
      export function guarded(limit: number): number {
        if (limit < 1) return -1
        let total = 0
        for (let step = 0; step < limit; step += 1) {
          total = total + allocateTemporary()
        }
        return total
      }
    `)
    expect(analyzedFunction(report, 'guarded').ensures)
      .toEqual(['return is a finite integer number at least -1'])
    expect(analyzedFunction(report, 'allocateTemporary').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
  })

  test('records one stop when a loop revisits the same division', () => {
    const report = analyzeSource('revisited-division.ts', `
      export function drain(count: number): number {
        let total = 100
        let step = 1
        for (let index = 0; index < count; index += 1) {
          total = total / step
          step = step - 1
        }
        return total
      }
    `)
    const file = resolve('revisited-division.ts')
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'drain',
      assumptions: ['count is finite and not NaN'],
      stopped: [`cannot infer a nonzero requirement for the division at ${file}:6:19`],
      observed: [],
    }])
  })

  test('does not analyze caller statements past a stopped call or leak callee state changes', () => {
    // poison rebinds the module slot to exactly 0 and then hits unsupported code; the
    // caller must stop at the call and discard the partial callee's slot change.
    const report = analyzeSource('no-leak.ts', `
      let width = 10
      function poison(): void {
        width = 0
        oops(width)
      }
      function oops(value: number): number {
        return value ** 2
      }
      export function readAfterCall(): number {
        poison()
        return width
      }
    `)
    const file = resolve('no-leak.ts')
    const caller = report.functions.find(fn => fn.name === 'readAfterCall')
    // If evaluation continued past the stopped call, observed would show the poisoned
    // 0 through 0. It must show nothing: the path stopped at the call.
    expect(caller).toEqual({
      kind: 'partial',
      name: 'readAfterCall',
      assumptions: ['width is finite and not NaN'],
      stopped: [`calls poison, whose analysis stopped (call at ${file}:11:9)`],
      observed: [],
    })
  })

  test('records truthiness conditions and mixed-kind values as unsupported', () => {
    const report = analyzeSource('gates.ts', `
      export function truthy(width: number): number {
        if (width) return 1
        return 0
      }
      export function mixedTernary(flag: number): number {
        const wide = flag > 0 ? flag : flag > -1
        return 2
      }
      export function mixedReturns(flag: number) {
        if (flag > 0) return flag
        return flag > -1
      }
    `)
    const file = resolve('gates.ts')
    expect(report.functions).toEqual([
      {kind: 'unsupported', name: 'truthy', unsupported: `condition of type number (compare explicitly, e.g. width > 0 or mode !== undefined) at ${file}:3:13`},
      {kind: 'unsupported', name: 'mixedTernary', unsupported: `value of type number | boolean at ${file}:7:22`},
      {kind: 'unsupported', name: 'mixedReturns', unsupported: `value of type number | boolean at ${file}:10:7`},
    ])
  })

  test('records mixed-kind local declarations as unsupported, keeping single-kind unions analyzable', () => {
    // An unknown-declared binding carries opaquely: its stored value erases at every
    // write, so a number on one branch and a boolean on another meet as opaque ⊔ opaque
    // (the join crash the old wholesale rejection guarded against). A genuinely
    // mixed-kind union stays out — its values are readable, so erasure would lose claims
    // the type invites.
    const report = analyzeSource('mixed-local.ts', `
      export function unknownLocal(flag: number): number {
        let u: unknown = 5
        if (flag > 2) { u = flag > 3 }
        return 1
      }
      export function mixedUnionLocal(flag: number): number {
        let wide: number | boolean = 5
        if (flag > 0) { wide = flag > 1 }
        return 2
      }
      export function steppedLocal(flag: number): number {
        let stepped: 1 | 2 = 1
        if (flag > 0) { stepped = 2 }
        return stepped
      }
    `)
    const file = resolve('mixed-local.ts')
    expect(analyzedFunction(report, 'unknownLocal').ensures).toEqual(['return is a finite integer number from 1 through 1'])
    expect(report.functions.filter(fn => fn.kind === 'unsupported')).toEqual([
      {kind: 'unsupported', name: 'mixedUnionLocal', unsupported: `value of type number | boolean at ${file}:8:19`},
    ])
    expect(analyzedFunction(report, 'steppedLocal').ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
  })

  test('partial reports never contain contract lines', () => {
    const report = analyzeSource('no-contract.ts', `
      export function example(flag: number): number {
        if (flag > 0) return 10
        return unsupportedThing(flag)
      }
      export function unsupportedThing(value: number): number {
        return value ** 2
      }
    `)
    const file = resolve('no-contract.ts')
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'example',
      assumptions: ['flag is finite and not NaN'],
      stopped: [`calls unsupportedThing, which hit unsupported code (call at ${file}:4:16)`],
      observed: ['return is a finite integer number from 10 through 10'],
    })
    const formatted = formatReport(report)
    expect(formatted).toContain('  stopped: ')
    expect(formatted).toContain('  on analyzed paths: return is a finite integer number from 10 through 10')
    // The legend mentions the line names, so check for actual entry lines.
    expect(formatted).not.toContain('\n  ensures: ')
    expect(formatted).not.toContain('\n  requires: ')
  })

  test('carries a record through rebinding and a local function call', () => {
    const report = analyzeFile(mutationFixture)
    const fn = analyzedFunction(report, 'destinationAfterUpdate')
    expect(fn.assumptions).toEqual(['containerWidth is finite and not NaN'])
    expect(fn.ensures).toEqual(['return is a finite number at least 1'])

    const unrelated = analyzedFunction(report, 'unrelatedDestinationStaysUnchanged')
    // Math.min mixes an integer with a non-integer operand, so no integer flag survives.
    expect(unrelated.ensures).toEqual(['return is a finite number from 0 through 0'])
  })

  test('infers, propagates, and discharges nonzero preconditions', () => {
    const report = analyzeFile(preconditionsFixture)
    // The division lives inside divideWidth at 6:10. Callers that inherit the requirement
    // keep that site, so their reports point at the actual division, not at their call.
    const divisionLocation = `(division at ${preconditionsFixture}:6:10)`
    expect(analyzedFunction(report, 'divideWidth').requires)
      .toEqual([`columnCount is nonzero ${divisionLocation}`])
    expect(analyzedFunction(report, 'divideThroughCaller').requires)
      .toEqual([`columnCount is nonzero ${divisionLocation}`])
    expect(analyzedFunction(report, 'divideThroughTwoCallers').requires)
      .toEqual([`columnCount is nonzero ${divisionLocation}`])
    expect(analyzedFunction(report, 'divideAfterGap').requires)
      .toEqual([`(width - gap) is nonzero ${divisionLocation}`])

    const provedCall = analyzedFunction(report, 'divideByClampedColumnCount')
    expect(provedCall.requires).toEqual([])
    expect(provedCall.ensures).toEqual(['return is a finite number'])
  })

  test('merges a conditional value before later arithmetic', () => {
    const report = analyzeSource('conditional-value.ts', `
      export function paddedWidth(width: number): number {
        const nonnegativeWidth = width >= 0 ? width : 0
        return nonnegativeWidth + 24
      }
    `)
    expect(analyzedFunction(report, 'paddedWidth').ensures).toEqual(['return is a finite number at least 24'])
  })

  test('merges reassigned locals after an if statement', () => {
    const report = analyzeSource('if-assignment.ts', `
      export function minimumWidth(width: number): number {
        let result = 10
        if (width > 10) result = width
        return result
      }

      export function nonnegativeWidth(width: number): number {
        if (width < 0) return 0
        return width
      }
    `)
    expect(analyzedFunction(report, 'minimumWidth').ensures)
      .toEqual(['return is a finite number at least 10'])
    expect(analyzedFunction(report, 'nonnegativeWidth').ensures)
      .toEqual(['return is a finite number at least 0'])
  })

  test('flows exact module constants into functions', () => {
    const report = analyzeSource('module-constants.ts', `
      const boxesGapX = 24
      const debugMode = false
      export function paddedWidth(width: number): number {
        return Math.max(0, width) + boxesGapX
      }
      export function debugOffset(): number {
        if (debugMode) return 1
        return 0
      }
    `)
    // "at least 24" proves the exact 24 flowed in: a declared-kind-only read would have
    // contributed an arbitrary finite number and destroyed the lower bound.
    const padded = analyzedFunction(report, 'paddedWidth')
    expect(padded.assumptions).toEqual(['width is finite and not NaN'])
    expect(padded.ensures).toEqual(['return is a finite number at least 24'])
    // The exact `false` prunes the true branch entirely.
    expect(analyzedFunction(report, 'debugOffset').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    // A fully analyzed initializer gets no report entry.
    expect(report.functions.map(fn => fn.name)).toEqual(['paddedWidth', 'debugOffset'])
  })

  test('keeps only the declared kind of a module binding that a function writes', () => {
    const report = analyzeSource('module-written.ts', `
      let scaleFactor = 2
      export function doubleScale(): void {
        scaleFactor = scaleFactor * 2
      }
      export function currentScale(): number {
        return scaleFactor
      }
    `)
    const reader = analyzedFunction(report, 'currentScale')
    expect(reader.assumptions).toEqual(['scaleFactor is finite and not NaN'])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('publishes an exact module record into functions', () => {
    const report = analyzeSource('module-record.ts', `
      const gridSize = {cols: 8, rows: 6}
      export function cellCount(): number {
        return gridSize.cols * gridSize.rows
      }
    `)
    // The exact 48 proves the record's property values flowed in, not just its shape; and
    // a trusted exact value needs no assumption line.
    expect(report.functions).toEqual([{
      kind: 'analyzed',
      name: 'cellCount',
      assumptions: [],
      requires: [],
      ensures: ['return is a finite integer number from 48 through 48'],
    }])
  })

  test('publishes nested module records exactly', () => {
    // Module state is a tree of records hanging off roots; publishing must reach the leaves.
    const report = analyzeSource('module-record-nested.ts', `
      const config = {margins: {left: 4, right: 12}, snap: true}
      export function leftEdge(): number {
        return config.margins.left
      }
    `)
    expect(analyzedFunction(report, 'leftEdge').ensures)
      .toEqual(['return is a finite integer number from 4 through 4'])
  })

  test('keeps only the declared shape of a module record that a function rebinds', () => {
    const report = analyzeSource('module-record-written.ts', `
      let pointer = {x: 0, y: 0}
      export function movePointer(newX: number): void {
        pointer = {x: newX, y: pointer.y}
      }
      export function pointerX(): number {
        return pointer.x
      }
    `)
    // The record analog of the scalar declared-kind hedge: per-property assumption lines,
    // and the read gives some finite number instead of the initializer's exact 0.
    const reader = analyzedFunction(report, 'pointerX')
    expect(reader.assumptions).toEqual([
      'pointer.x is finite and not NaN',
      'pointer.y is finite and not NaN',
    ])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('a module record rebound by a skipped statement keeps only its declared shape', () => {
    // The rebind's right-hand side does not lower, so the statement is skipped — and the
    // binding must stop publishing its initializer's exact value, or the skip would launder
    // a stale 2 into every reader.
    const report = analyzeSource('module-record-skip.ts', `
      let scale = {factor: 2}
      scale = {factor: window.devicePixelRatio}
      export function scaledBy(width: number): number {
        return Math.min(width, scale.factor)
      }
    `)
    const reader = analyzedFunction(report, 'scaledBy')
    expect(reader.assumptions).toEqual([
      'width is finite and not NaN',
      'scale.factor is finite and not NaN',
    ])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('module arrays publish exactly in fully analyzed files, hedge otherwise', () => {
    const report = analyzeSource('module-array.ts', `
      const items = [3, 5]
      export function itemCount(): number {
        return items.length
      }
    `)
    expect(analyzedFunction(report, 'itemCount').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])
    // With unanalyzed code in the file, the array — alias-mutable at runtime like any
    // record — falls back to its declared shape.
    const hedged = analyzeSource('module-array-hedged.ts', `
      const items = [3, 5]
      export function mutateSomehow(): void {
        items.push(7)
      }
      export function itemCount(): number {
        return items.length
      }
    `)
    const reader = hedged.functions.find(fn => fn.name === 'itemCount')
    expect(reader?.kind).toBe('analyzed')
    expect(reader?.kind === 'analyzed' ? reader.assumptions : []).toEqual(['every items element is finite and not NaN'])
  })

  test('exact record publishing requires a fully analyzed file', () => {
    // Analyzed code cannot write into an object, but rejected function bodies run at
    // runtime too and can mutate a record through an alias the write scan cannot see,
    // e.g. Object.assign(gridSize, ...) — the binding sits in argument position, not
    // write position. With any unanalyzed code in the file, records fall back to the
    // declared-shape hedge. Scalars are copied on read, so gap keeps its exact value.
    const report = analyzeSource('module-record-gate.ts', `
      const gridSize = {cols: 8, rows: 6}
      const gap = 24
      export function mutateSomehow(): void {
        Object.assign(gridSize, {cols: 1})
      }
      export function cellCount(): number {
        return gridSize.cols * gridSize.rows
      }
      export function readGap(): number {
        return gap
      }
    `)
    const reader = analyzedFunction(report, 'cellCount')
    expect(reader.assumptions).toEqual([
      'gridSize.cols is finite and not NaN',
      'gridSize.rows is finite and not NaN',
    ])
    expect(reader.ensures).toEqual([`return is a possibly non-finite number from -Infinity through Infinity (can overflow at ${resolve('module-record-gate.ts')}:8:16)`])
    expect(analyzedFunction(report, 'readGap').ensures)
      .toEqual(['return is a finite integer number from 24 through 24'])
  })

  test('rejects unions whose same-named property mixes kinds', () => {
    // The union shape gate compares property kinds, not just names: admitting
    // {value: number} | {value: boolean} would let a spread or a narrowed read reach the
    // property the record join has to drop.
    const report = analyzeSource('mixed-kind-property.ts', `
      export function mix(steps: number): number {
        const toggle = steps > 0 ? {value: 1} : {value: true}
        return steps
      }
    `)
    const file = resolve('mixed-kind-property.ts')
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'mix',
      unsupported: `value of type { value: number; } | { value: boolean; } at ${file}:3:24`,
    }])
  })

  test('joins of wide return values drop a kind-mismatched extra property instead of crashing', () => {
    // Width subtyping lets both wide literals return where {x: number} is declared; the
    // two records meet at the return join with y carrying different kinds. The declared
    // return type never exposes y, so the join drops it and every readable property
    // survives.
    const report = analyzeSource('wide-return-join.ts', `
      export function pick(flag: number): {x: number} {
        const wideA = {x: 1, y: 2}
        const wideB = {x: 3, y: true}
        if (flag > 0) return wideA
        return wideB
      }
    `)
    const picked = analyzedFunction(report, 'pick')
    expect(picked.ensures).toEqual(['return.x is a finite integer number from 1 through 3'])
  })

  test('optional properties read, fill, and spread as maybe-undefined values', () => {
    // session?: boolean reads as boolean | undefined — exactly what the missing-value
    // machinery models. Object literals fill omitted optionals with an explicit undefined
    // (so `omitted` proves exactly 5 through the ?? fallback), spreads copy them as their
    // maybe-undefined values, and the assumes prose carries the honest condition. Sound
    // under exactOptionalPropertyTypes, which the analyzer forces: a well-typed optional
    // is either absent or a T, never an explicit undefined, so absence and the undefined
    // sentinel provably coincide.
    const report = analyzeSource('optional-properties.ts', `
      type Config = {gain: number; volume?: number}
      export function effectiveVolume(): number {
        const overrides: Config = {gain: 2, volume: 7}
        const merged = {...overrides, gain: 1}
        return merged.gain
      }
      export function readOptional(config: Config): number {
        return config.volume ?? 10
      }
      export function omitted(): number {
        const config: Config = {gain: 2}
        return config.volume ?? 5
      }
    `)
    expect(analyzedFunction(report, 'effectiveVolume').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
    expect(analyzedFunction(report, 'readOptional').assumptions).toEqual([
      'config.gain is finite and not NaN',
      'config.volume is undefined or a finite non-NaN number',
    ])
    expect(analyzedFunction(report, 'readOptional').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'omitted').ensures).toEqual(['return is a finite integer number from 5 through 5'])
  })

  test('optional properties inside tagged-union variants classify too', () => {
    const report = analyzeSource('optional-variant.ts', `
      type Route = {type: 'style-creator'; sref?: string} | {type: 'home'; scroll: number}
      export function scrollOf(route: Route): number {
        if (route.type === 'home') { return route.scroll }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'scrollOf').assumptions)
      .toEqual(["route.scroll is finite and not NaN (when route.type is 'home')"])
    expect(analyzedFunction(report, 'scrollOf').ensures).toEqual(['return is a finite number'])
  })

  test('a recursive generic module type stays opaque instead of crashing the shape walk', () => {
    // Every level of Nested<T> is a fresh instantiation, so a seen-set alone cannot
    // recognize the recursion; the depth cap stops the walk (and the checker's
    // instantiation chain) and the binding stays opaque.
    const report = analyzeSource('recursive-generic.ts', `
      type Nested<T> = {value: number; inner: Nested<{deeper: T}>}
      let chain: Nested<number> | null = null
      export function probe(): number {
        return 1
      }
    `)
    expect(analyzedFunction(report, 'probe').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
  })

  test('a skip havocs every record binding, closing argument-position mutation', () => {
    // Object.assign(config, ...) holds the binding in argument position — no write-position
    // mention anywhere, and an alias variant mentions the binding nowhere at all — so no
    // mention scan is sound for records. Every record binding resets to covering values at
    // the skip; the derived scalar honestly reports the NaN the skipped call could produce.
    const report = analyzeSource('module-record-argument-write.ts', `
      type Config = {zoom: number}
      let config: Config = {zoom: 1}
      Object.assign(config, {zoom: Number.NaN})
      const doubled = config.zoom * 2
      export function readDoubled(): number {
        return doubled
      }
    `)
    expect(analyzedFunction(report, 'readDoubled').ensures)
      .toEqual(['return is a possibly NaN number from -Infinity through Infinity'])
  })

  test('union record shapes compare recursively, and admitted unions read directly', () => {
    // Shapes are fingerprinted to every depth: payloads diverging two levels down reject at
    // the declarator (a narrowed read could otherwise reach a property the join dropped),
    // while a union of one recursive shape joins losslessly — its discriminant reads
    // directly and computes like any number, literal union included.
    const report = analyzeSource('union-shapes.ts', `
      type Loaded = {ok: true; data: {metrics: {width: number}}}
      type Failed = {ok: false; data: {metrics: {code: number}}}
      export function measure(loadedCount: number): number {
        const state: Loaded | Failed = loadedCount > 0
          ? {ok: true, data: {metrics: {width: 640}}}
          : {ok: false, data: {metrics: {code: 404}}}
        const {ok} = state
        return ok ? 1 : 0
      }
      type Speed = {mode: 1} | {mode: 2}
      export function speedMode(fast: number): number {
        const speed: Speed = fast > 0 ? {mode: 1} : {mode: 2}
        return speed.mode + 1
      }
    `)
    const measureFn = report.functions.find(candidate => candidate.name === 'measure')
    expect(measureFn?.kind).toBe('unsupported')
    expect(analyzedFunction(report, 'speedMode').ensures)
      .toEqual(['return is a finite integer number from 2 through 3'])
  })

  test('rejects reads of inherited prototype members', () => {
    // toString type-checks on every object literal, but the record value carries only its
    // own properties; the callable type fails the value-kind gate.
    const report = analyzeSource('prototype-member.ts', `
      export function labelledX(x: number): number {
        const point = {x}
        const stringify = point.toString
        return point.x
      }
    `)
    const file = resolve('prototype-member.ts')
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'labelledX',
      unsupported: `read of the inherited prototype member toString (records carry only their own data properties) at ${file}:4:27`,
    }])
  })

  test('an anonymous default export function is a recorded skip, not invisible code', () => {
    // Named function declarations become report entries; an anonymous export default has
    // no name to collect under, so it must fall through to a recorded initializer skip —
    // otherwise its body would be runtime code no publish gate accounts for, and appZoom
    // would publish its exact initial value while the body mutates it.
    const report = analyzeSource('anonymous-default.ts', `
      const appZoom = {level: 5}
      export function currentZoom(): number {
        return appZoom.level
      }
      export default function () {
        Object.assign(appZoom, {level: 999})
      }
    `)
    const reader = analyzedFunction(report, 'currentZoom')
    expect(reader.assumptions).toEqual(['appZoom.level is finite and not NaN'])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('rejects the constructs whose checker word the analysis cannot confirm', () => {
    // Four gates from one review round: a type predicate is the checker taking the
    // author's word (a lying one exposes properties the value never carries); an async
    // body's runtime result is a Promise, not its return value; `{}` is inhabited by
    // every non-null value, numbers included, so it is not a record shape; and __proto__
    // in a literal sets the prototype rather than creating a property.
    const report = analyzeSource('checker-word.ts', `
      type Circle = {kind: number; radius: number}
      export function isCircle(shape: {kind: number}): shape is Circle {
        return shape.kind > 0
      }
      export async function fetchDelay(): Promise<number> {
        return 16
      }
      export function chooseMarker(flag: number): number {
        const marker: {} = 5
        return flag
      }
      export function protoDepth(): number {
        const carrier = {__proto__: {depth: 7}}
        return 0
      }
    `)
    const formatted = formatReport(report)
    expect(formatted).toContain('a type predicate (the checker takes the predicate on faith; return a plain boolean and check properties where they are read)')
    expect(formatted).toContain("an async or generator function (the runtime result is a Promise or iterator, not the body's return value)")
    expect(formatted).toContain('value of type {}')
    expect(formatted).toContain('a property named __proto__ (prototype-setting syntax at runtime, not a data property)')
  })

  test('the parameter gate classifies through valueKind', () => {
    // One definition of every kind across gates: a 1 | 2 discriminant property is a
    // number in a parameter exactly as at the declarator, and an index-signature
    // parameter type rejects instead of seeding a record the type licenses more reads
    // against than it carries (the destructured read of `latency` would crash the engine).
    const report = analyzeSource('parameter-kinds.ts', `
      export function modeOf(zoom: {mode: 1 | 2}): number {
        return zoom.mode
      }
      export function readGauge(board: {base: number; [gauge: string]: number}): number {
        return board.base
      }
    `)
    expect(analyzedFunction(report, 'modeOf').ensures).toEqual(['return is a finite number'])
    const gauge = report.functions.find(candidate => candidate.name === 'readGauge')
    expect(gauge?.kind).toBe('unsupported')
  })

  test('the false branch of a comparison with a possibly-NaN operand refines nothing', () => {
    // NaN fails every comparison, so the false branch is also where a NaN operand lands —
    // with the OTHER operand unconstrained. clampedTarget keeps mayBeNaN through the clamp
    // (scale * scale * dt can be Infinity * 0), so narrowing pointerX to "at least 10" in
    // the else branch would be contradicted by follow(-5, 1e308, 0) === -5 at runtime.
    const report = analyzeSource('nan-false-branch.ts', `
      export function follow(pointerX: number, scale: number, dt: number): number {
        const clampedTarget = Math.max(10, Math.min(scale * scale * dt, 20))
        if (pointerX < clampedTarget) return 10
        return pointerX
      }
    `)
    expect(analyzedFunction(report, 'follow').ensures).toEqual(['return is a finite number'])
  })

  test('a shape fingerprint cut short by the depth cap never compares equal', () => {
    // Two members diverging below the cap would otherwise be admitted as one shape, and
    // discriminant narrowing could read the deep property the join dropped.
    const report = analyzeSource('deep-union.ts', `
      type DeepA = {tag: 1; l1: {l2: {l3: {l4: {l5: {l6: {l7: {l8: {value: number}}}}}}}}}
      type DeepB = {tag: 2; l1: {l2: {l3: {l4: {l5: {l6: {l7: {l8: {value: boolean}}}}}}}}}
      export function read(flag: number): number {
        const a: DeepA = {tag: 1, l1: {l2: {l3: {l4: {l5: {l6: {l7: {l8: {value: 42}}}}}}}}}
        const b: DeepB = {tag: 2, l1: {l2: {l3: {l4: {l5: {l6: {l7: {l8: {value: true}}}}}}}}}
        const chosen: DeepA | DeepB = flag > 0 ? a : b
        if (chosen.tag === 1) {
          return chosen.l1.l2.l3.l4.l5.l6.l7.l8.value
        }
        return 0
      }
    `)
    expect(report.functions[0]?.kind).toBe('unsupported')
  })

  test('null checks narrow, and compound guards narrow through the short-circuit', () => {
    // `maybe !== null && maybe > 3` lowers as two chained branches sharing the false
    // target, so each check refines on its own — the inline guard narrows exactly like
    // the nested-if spelling.
    const report = analyzeSource('nullish-guard.ts', `
      export function doubled(maybe: number | null): number {
        if (maybe !== null && maybe > 3) {
          return maybe * 2
        }
        return 0
      }
    `)
    const fn = analyzedFunction(report, 'doubled')
    expect(fn.assumptions).toEqual(['maybe is null or a finite non-NaN number'])
    expect(fn.ensures).toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${resolve('nullish-guard.ts')}:4:18)`])
  })

  test('narrowing a property read sticks across re-reads of the same property', () => {
    // The refinement writes the narrowed value back through the producer chain into the
    // record — sound because values are immutable, so the property cannot differ between
    // the checked read and the next one.
    const report = analyzeSource('nullish-property.ts', `
      export function pick(seed: number): number {
        const point = {x: seed > 0 ? null : 5}
        if (point.x !== null) {
          return point.x + 1
        }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures)
      .toEqual(['return is a finite integer number from 0 through 6'])
  })

  test('strict null checks consult the possible sentinels', () => {
    // `values !== null` on number | undefined can never be false at runtime (undefined
    // !== null is true), so the else branch is pruned and the result is exactly 0.
    const report = analyzeSource('nullish-matrix.ts', `
      export function fromIndex(values: number | undefined): number {
        if (values !== null) {
          return 0
        }
        return 1
      }
      export function looseClears(value: number | undefined): number {
        return value == null ? 16 : value * 1
      }
    `)
    expect(analyzedFunction(report, 'fromIndex').assumptions)
      .toEqual(['values is undefined or a finite non-NaN number'])
    expect(analyzedFunction(report, 'fromIndex').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    // Loose == null tests both sentinels, so the false arm is a plain number.
    expect(analyzedFunction(report, 'looseClears').ensures)
      .toEqual(['return is a finite number'])
  })

  test('?? takes the value or the fallback, exactly', () => {
    const report = analyzeSource('nullish-coalesce.ts', `
      export function clampedStart(animatedUntilTime: number | null): number {
        const start = animatedUntilTime ?? 16
        return Math.max(0, Math.min(start, 100))
      }
      export function mixedArms(seed: number): number {
        const grid = seed > 0 ? null : {cols: 3}
        const chosen = grid ?? 0
        return 1
      }
    `)
    expect(analyzedFunction(report, 'clampedStart').ensures)
      .toEqual(['return is a finite number from 0 through 100'])
    // ?? whose arms mix kinds (record vs number) rejects at the type gate.
    const mixed = report.functions.find(fn => fn.name === 'mixedArms')
    expect(mixed?.kind).toBe('unsupported')
  })

  test('a narrowing shape the analysis does not model stops the path honestly', () => {
    // Value-position compound conditions do not short-circuit (only statement conditions
    // do), so the ternary's guard reaches the multiplication unnarrowed — the backstop
    // records a stop instead of crashing the run, and the sibling function still reports.
    const report = analyzeSource('nullish-backstop.ts', `
      export function ternaryGuard(maybe: number | null): number {
        return maybe !== null && maybe > 3 ? maybe * 2 : 0
      }
      export function healthy(x: number): number {
        return x + 1
      }
    `)
    const file = resolve('nullish-backstop.ts')
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'ternaryGuard',
      assumptions: ['maybe is null or a finite non-NaN number'],
      stopped: [`narrows a value in a way the analysis does not model (at ${file}:3:46)`],
      observed: ['return is a finite integer number from 0 through 0'],
    })
    expect(analyzedFunction(report, 'healthy').ensures).toEqual(['return is a finite number'])
  })

  test('nullish module bindings seed their declared kind with sentinel prose', () => {
    const report = analyzeSource('nullish-module.ts', `
      let animatedUntilTime: number | null = null
      export function frame(now: number): void {
        animatedUntilTime = now
      }
      export function readIt(): number {
        return animatedUntilTime ?? 16
      }
    `)
    const reader = analyzedFunction(report, 'readIt')
    expect(reader.assumptions).toEqual(['animatedUntilTime is null or a finite non-NaN number'])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('tuples stay exact per position; arrays are homogeneous', () => {
    // The type system's own split, mirrored: `as const` makes a tuple (sizes[1]! is
    // exactly 8, and the constant read is PROVEN in bounds — no assumption line), a plain
    // literal is an array (any element read covers 4..24).
    const report = analyzeSource('tuple-array.ts', `
      export function gaps(): number {
        const sizes = [4, 8, 24] as const
        return sizes[1]! * sizes.length
      }
      export function hulled(): number {
        const sizes = [4, 8, 24]
        return sizes[1]! * sizes.length
      }
    `)
    const gapsFn = analyzedFunction(report, 'gaps')
    expect(gapsFn.assumptions).toEqual([])
    expect(gapsFn.ensures).toEqual(['return is a finite integer number from 24 through 24'])
    expect(analyzedFunction(report, 'hulled').ensures)
      .toEqual(['return is a finite integer number from 12 through 72'])
  })

  test('for-of desugars to a counter loop: in bounds by construction, empty arrays prune', () => {
    const report = analyzeSource('for-of.ts', `
      export function total(values: number[]): number {
        let sum = 0
        for (const value of values) {
          sum = sum + Math.min(Math.max(value, 0), 10)
        }
        return sum
      }
      export function sumEmpty(): number {
        const values: number[] = []
        let sum = 0
        for (const value of values) {
          sum = sum + value
        }
        return sum
      }
    `)
    // No in-bounds assumption line: the counter read is proven by construction. The sum
    // stays finite because widening saturates at MAX_VALUE and adding a clamped step
    // cannot leave it.
    const fn = analyzedFunction(report, 'total')
    expect(fn.assumptions).toEqual(['every values element is finite and not NaN'])
    expect(fn.ensures).toEqual(['return is a finite number at least 0'])
    // The empty array's length is exactly 0, so the header comparison prunes the body.
    expect(analyzedFunction(report, 'sumEmpty').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
  })

  test('element reads: bare arr[i] carries undefined honestly, arr[i]! requires in bounds', () => {
    const report = analyzeSource('element-reads.ts', `
      export function bareRead(values: number[], index: number): number {
        const value = values[index]
        return value ?? 0
      }
      export function assertedRead(values: number[], index: number): number {
        return values[index]!
      }
    `)
    const file = resolve('element-reads.ts')
    // The bare read's ?? handles the miss, so no assumption is needed.
    const bare = analyzedFunction(report, 'bareRead')
    expect(bare.assumptions).toEqual([
      'every values element is finite and not NaN',
      'index is finite and not NaN',
    ])
    expect(bare.ensures).toEqual(['return is a finite number'])
    // The asserted read's index and array are both nameable over the parameters, so the
    // obligation surfaces as a requires line the caller can satisfy, not an assumes line
    // the entry merely rests on.
    const asserted = analyzedFunction(report, 'assertedRead')
    expect(asserted.assumptions).toEqual([
      'every values element is finite and not NaN',
      'index is finite and not NaN',
    ])
    expect(asserted.requires).toEqual([`index is a valid values index (element read at ${file}:7:16)`])
  })

  test('top-level destructuring publishes each name as its own binding', () => {
    const report = analyzeSource('toplevel-destructure.ts', `
      const gridSize = {cols: 8, rows: 6}
      const {cols} = gridSize
      export function scaled(x: number): number {
        return Math.min(x, cols)
      }
    `)
    expect(analyzedFunction(report, 'scaled').ensures)
      .toEqual(['return is a finite number at most 8'])
  })

  test('ensures lines cover only what the declared return type exposes', () => {
    // The wider literal's h is a true fact, but no type-checked caller can read it.
    const report = analyzeSource('wide-return.ts', `
      type Size = {w: number}
      function wideBox(): {w: number; h: number} {
        return {w: 3, h: 4}
      }
      export function measure(): Size {
        return wideBox()
      }
    `)
    expect(analyzedFunction(report, 'measure').ensures)
      .toEqual(['return.w is a finite integer number from 3 through 3'])
  })

  test('review fixes: void checks reject, undefined narrows, mixed elements reject, guards prove bounds', () => {
    const report = analyzeSource('review-fixes.ts', `
      function announce(): void { return }
      export function checkVoidLoose(): number {
        if (announce() == null) { return 1 }
        return 0
      }
      export function narrowUndefined(x: number | undefined): number {
        if (x !== undefined) { return x }
        return -1
      }
      export function mixedLiteral(): number {
        const pair = [1, true]
        return pair.length
      }
      export function firstOrZero(values: number[]): number {
        if (values.length > 0) { return values[0]! }
        return 0
      }
      export function outOfBounds(): number {
        const sizes = [4, 8, 24]
        return sizes[5]! * 3
      }
    `)
    const file = resolve('review-fixes.ts')
    // A void call's runtime value is undefined, which the void abstract kind cannot carry;
    // admitting the check would prune the wrong branch.
    const voidCheck = report.functions.find(fn => fn.name === 'checkVoidLoose')
    expect(voidCheck?.kind).toBe('unsupported')
    expect(analyzedFunction(report, 'narrowUndefined').ensures).toEqual(['return is a finite number'])
    // (number | boolean)[] has an element hull no read gate could describe.
    const mixed = report.functions.find(fn => fn.name === 'mixedLiteral')
    expect(mixed?.kind).toBe('unsupported')
    // The length guard narrows through the arrayLength producer into the array value, so
    // the asserted read is proven — no assumption line.
    expect(analyzedFunction(report, 'firstOrZero').assumptions)
      .toEqual(['every values element is finite and not NaN'])
    const oob = report.functions.find(fn => fn.name === 'outOfBounds')
    expect(oob?.kind).toBe('partial')
    expect(formatReport(report)).toContain(`reads an element provably outside the array (at ${file}:21:16)`)
  })

  test('review fixes: nullish params and spread copies stay nameable in requirements', () => {
    const report = analyzeSource('nameable.ts', `
      export function rate(total: number, interval: number | null): number {
        if (interval !== null) { return total / interval }
        return 0
      }
      export function throughSpread(grid: {columns: number}, width: number): number {
        const copy = {...grid}
        return width / copy.columns
      }
    `)
    const file = resolve('nameable.ts')
    expect(analyzedFunction(report, 'rate').requires)
      .toEqual([`interval is nonzero (division at ${file}:3:41)`])
    // The record is immutable, so {...grid}.columns IS grid.columns.
    expect(analyzedFunction(report, 'throughSpread').requires)
      .toEqual([`grid.columns is nonzero (division at ${file}:8:16)`])
  })

  test('round-2 fixes: element-aware shapes, meet-on-write, copies narrow originals, sentinel chains', () => {
    const report = analyzeSource('round2-fixes.ts', `
      export function itemCount(mode: number): number {
        const box: {items: (number | boolean)[]} = mode > 0 ? {items: [1, 2, 3]} : {items: [true]}
        return box.items.length
      }
      export function lostNarrowing(grid: {columns: number}): number {
        const width = grid.columns
        if (grid.columns >= 1) {
          if (width <= 10) {
            return 100 / grid.columns
          }
        }
        return 0
      }
      export function throughCopy(grid: {columns: number}): number {
        const copy = {...grid}
        if (copy.columns >= 1) {
          return 100 / grid.columns
        }
        return 0
      }
      export function distinguish(setting: number | null | undefined): number {
        if (setting == null) {
          if (setting === undefined) return 1
          return 2
        }
        return 3
      }
      export function readSize(size: number | undefined): number {
        if (typeof size !== 'undefined') { return size }
        return 0
      }
    `)
    // Array-property shapes fingerprint by element: {items: number[]} | {items: boolean[]}
    // rejects instead of joining into an unreadable drop.
    expect(report.functions.find(fn => fn.name === 'itemCount')?.kind).toBe('unsupported')
    // A refinement of a stale saved read meets the record's current property value instead
    // of clobbering the fresher guard.
    const lost = analyzedFunction(report, 'lostNarrowing')
    expect(lost.requires).toEqual([])
    expect(lost.ensures).toEqual(['return is a finite number from 0 through 100'])
    // Narrowing {...grid}.columns narrows grid.columns — the copy's property IS the
    // original's.
    const copied = analyzedFunction(report, 'throughCopy')
    expect(copied.requires).toEqual([])
    expect(copied.ensures).toEqual(['return is a finite number from 0 through 100'])
    // A pure-sentinel operand (null | undefined after the outer narrow) still checks, and
    // typeof x !== 'undefined' is the classic spelling of the undefined sentinel check.
    expect(analyzedFunction(report, 'distinguish').ensures)
      .toEqual(['return is a finite integer number from 1 through 3'])
    expect(analyzedFunction(report, 'readSize').ensures).toEqual(['return is a finite number'])
  })

  test('round-3 fixes: recursive unions reject, literals gate everywhere, meets recurse, aliases read', () => {
    const report = analyzeSource('round3-fixes.ts', `
      type Group = (Group | null)[]
      export function groupCount(group: Group): number {
        return group.length
      }
      export function makeBox(): number {
        const box = {count: 5, data: [1, true]}
        return box.count
      }
      export function freshThenStale(values: number[]): number {
        const count = values.length
        if (values.length >= 1) {
          if (count <= 100) {
            return values[0]!
          }
        }
        return -1
      }
      type Loaded = {samples: {value: number}[]}
      type Cached = {samples: {value: number}[]}
      export function sameShape(mode: number): number {
        const state: Loaded | Cached = mode > 0 ? {samples: [{value: 20}]} : {samples: [{value: 10}]}
        const first = state.samples[0]
        return first === undefined ? 0 : first.value
      }
      export function sizeAtConst(index: number): number {
        const sizes = [4, 8, 24] as const
        const size = sizes[index]
        if (size !== undefined) return size
        return 0
      }
      export function typeofNumber(x: number | undefined): number {
        if (typeof x === 'number') return x
        return 0
      }
    `)
    // A recursive type reaching itself through a union rejects (the depth guard survives
    // union arms); a mixed-element literal rejects in EVERY position, property values
    // included; a stale saved length meets instead of clobbering the fresher narrowing;
    // identically-shaped record aliases (which TypeScript keeps as a union at the read
    // position) read their array properties; an as-const table's bare dynamic read is
    // nullable like number | undefined; typeof x === 'number' is the not-missing check.
    expect(report.functions.find(fn => fn.name === 'groupCount')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'makeBox')?.kind).toBe('unsupported')
    expect(analyzedFunction(report, 'freshThenStale').assumptions)
      .toEqual(['every values element is finite and not NaN'])
    expect(analyzedFunction(report, 'sameShape').ensures)
      .toEqual(['return is a finite integer number from 10 through 20'])
    expect(analyzedFunction(report, 'sizeAtConst').ensures)
      .toEqual(['return is a finite integer number from 0 through 24'])
    expect(analyzedFunction(report, 'typeofNumber').ensures).toEqual(['return is a finite number'])
  })

  test('round-4 fixes: rest params reject, bare return is return undefined, typeof stays honest', () => {
    const report = analyzeSource('round4-fixes.ts', `
      function total(...values: number[]): number {
        return values.length
      }
      export const combined = total(1, 2)
      export function pick(count: number): number | undefined {
        if (count > 0) {
          return 1
        }
        return
      }
      export function readBox(count: number): number {
        const box = count > 0 ? {value: 5} : null
        if (typeof box === 'number') { return 0 }
        if (box === null) { return 1 }
        return box.value
      }
      type Size = {a: number}
      function wide(count: number): {a: number; b: number} { return {a: count, b: count * 2} }
      export function findPoint(count: number): Size | null {
        if (count > 0) { return wide(count) }
        return null
      }
    `)
    // A rest parameter is one declaration for any number of arguments — rejected, so the
    // two-argument call cannot crash the arity check.
    expect(report.functions.find(fn => fn.name === 'total')?.kind).toBe('unsupported')
    // Bare return IS return undefined in a value-returning function.
    expect(analyzedFunction(report, 'pick').ensures)
      .toEqual(['return is undefined or a finite integer number from 1 through 1'])
    // typeof box === 'number' on {value: number} | null is NOT the not-missing check
    // (typeof a present record is 'object'); it answers an unknown boolean, so both
    // branches analyze — the dead branch's 0 rides along soundly in the range.
    expect(analyzedFunction(report, 'readBox').ensures)
      .toEqual(['return is a finite integer number from 0 through 5'])
    // The declared Size | null return filters the wide record's extra property through
    // the nullable wrapper.
    const found = analyzedFunction(report, 'findPoint')
    expect(found.ensures).toEqual([
      'return may be null; when present:',
      'return.a is a finite number more than 0',
    ])
  })

  test('strings and booleans are carried, not rejected; parameters take any declared kind', () => {
    // The old behavior was wild: one id: string property rejected the whole function.
    // Opaque values carry non-numeric content without claims, and parameters share the
    // module bindings' recursive declared-kind classification.
    const report = analyzeSource('opaque-values.ts', `
      type Box = {id: string; width: number; visible: boolean}
      export function scaledWidth(box: Box, factor: number): number {
        return Math.min(box.width * factor, 1000)
      }
      export function labelled(width: number): number {
        const label = \`\${width}px\`
        return width * 2
      }
      export function pick(mode: string, compact: number, wide: number): number {
        if (mode === 'compact') { return compact }
        return wide
      }
      export function flagged(enabled: boolean, value: number): number {
        if (enabled) { return value }
        return 0
      }
    `)
    const scaled = analyzedFunction(report, 'scaledWidth')
    // The string property makes no assumption line — there is nothing to claim about it.
    expect(scaled.assumptions).toEqual([
      'box.width is finite and not NaN',
      'box.visible is a boolean',
      'factor is finite and not NaN',
    ])
    // A template literal is carried; the numeric contract survives.
    expect(analyzedFunction(report, 'labelled').assumptions).toEqual(['width is finite and not NaN'])
    // String dispatch: the comparison is an unknown boolean, both branches analyzed.
    expect(analyzedFunction(report, 'pick').ensures).toEqual(['return is a finite number'])
    // Boolean parameters are new too (the flat-numbers gate rejected them).
    expect(analyzedFunction(report, 'flagged').assumptions)
      .toEqual(['enabled is a boolean', 'value is finite and not NaN'])
  })

  test('review round: nullish-wrapped module arrays hedge like bare ones when the file is not fully analyzed', () => {
    // The fully-analyzed demotion recurses through nullish wrappers: `number[] | null` is
    // nullish at the top level yet the array inside is exactly as alias-mutable, e.g. by
    // `queue?.push(x)` in a rejected function (receiver position, invisible to the write
    // scan). Publishing the exact initializer value would be falsified at runtime.
    const report = analyzeSource('nullable-module-array.ts', `
      let queue: number[] | null = [3, 5]
      export function enqueue(x: number): void {
        queue?.push(x)
      }
      export function hasQueue(): boolean {
        return queue !== null
      }
    `)
    const reader = analyzedFunction(report, 'hasQueue')
    // No exact claims about the initializer value survive; the read rests on the
    // declared-kind hedge, printed with its inner leaf condition.
    expect(reader.assumptions).toEqual(['queue is null or every queue element is finite and not NaN'])
  })

  test('review round: string dispatch on a possibly-missing string analyzes', () => {
    // `mode?: string` is the everyday optional-config spelling; the missing value simply
    // compares unequal, so the unknown-boolean comparison needs no null guard first.
    const report = analyzeSource('optional-string-dispatch.ts', `
      export function pickWidth(mode: string | undefined, compact: number, wide: number): number {
        if (mode === 'compact') { return compact }
        return wide
      }
    `)
    expect(analyzedFunction(report, 'pickWidth').ensures).toEqual(['return is a finite number'])
  })

  test('review round: string concatenation with + and += is carried, not rejected', () => {
    const report = analyzeSource('string-concat.ts', `
      export function label(width: number): number {
        let message = 'w: '
        message += width + 'px'
        return width
      }
    `)
    expect(analyzedFunction(report, 'label').ensures).toEqual(['return is a finite number'])
  })

  test('review round: nullable structural parameters print their inner leaf assumptions', () => {
    // The seeded finiteness of every inner leaf must reach the report — the ensures lines
    // rest on it. Before the fix, `values: number[] | null` printed only 'null or a record
    // of its declared shape', so firstOr([Infinity], 0) satisfied every printed line while
    // the ensures was false. Nested arrays also stuttered ('every every grid element
    // element'); the [each] path keeps them readable.
    const report = analyzeSource('nullable-structural-parameters.ts', `
      export function firstOr(values: number[] | null, fallback: number): number {
        if (values === null) return fallback
        return values[0] ?? fallback
      }
      export function gridSum(grid: number[][], config: {width: number; label: string} | null): number {
        if (config === null) return 0
        return config.width
      }
    `)
    expect(analyzedFunction(report, 'firstOr').assumptions).toEqual([
      'values is null or every values element is finite and not NaN',
      'fallback is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'gridSum').assumptions).toEqual([
      'every grid[each] element is finite and not NaN',
      'config is null or config.width is finite and not NaN',
    ])
  })

  test('review round: a non-literal parameter default rejects; a literal one is covered by the assumes line', () => {
    // The analysis never evaluates a default initializer. `= 5` provably satisfies the
    // assumed-finite seeding, so ignoring the expression is sound; `= Number.POSITIVE_INFINITY`
    // would falsify the ensures on a zero-argument call, so the function rejects.
    const report = analyzeSource('bad-default.ts', `
      export function scaled(zoom: number = Number.POSITIVE_INFINITY): number {
        return zoom
      }
    `)
    const scaled = report.functions.find(fn => fn.name === 'scaled')!
    if (scaled.kind !== 'unsupported') throw new Error(`expected scaled to be unsupported, got ${scaled.kind}`)
    expect(scaled.unsupported).toContain('default value for parameter zoom')
  })

  test('review round 2: sentinel and inner-kind literal defaults on nullable parameters analyze', () => {
    // `deadline: number | null = null` is the standard optional-parameter spelling: the
    // null literal is one of the declared sentinels, as provably inside the kind as = 5
    // is for number. Both defaults satisfy the printed disjunction, so ignoring the
    // initializer stays sound.
    const report = analyzeSource('nullable-defaults.ts', `
      export function remaining(deadline: number | null = null): number {
        return deadline === null ? 0 : deadline
      }
      export function zoomOr(zoom: number | null = 5): number {
        return zoom === null ? 1 : zoom
      }
    `)
    expect(analyzedFunction(report, 'remaining').assumptions).toEqual(['deadline is null or a finite non-NaN number'])
    expect(analyzedFunction(report, 'zoomOr').ensures).toEqual(['return is a finite number'])
  })

  test('review round 2: optional literal-union parameters collapse to one scalar kind', () => {
    // `mode: 'compact' | 'wide' | undefined` has several non-missing union members; they
    // classify as one scalar kind (opaque here, number for 4 | 8 | undefined), the same
    // rule the bare union already gets. Two record shapes under a wrapper stay rejected.
    const report = analyzeSource('optional-literal-unions.ts', `
      export function pick(mode: 'compact' | 'wide' | undefined, a: number, b: number): number {
        if (mode === 'compact') return a
        return b
      }
      export function gapFor(size: 4 | 8 | undefined): number {
        return size === undefined ? 4 : size
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'gapFor').assumptions).toEqual(['size is undefined or a finite non-NaN number'])
  })

  test('review round 2: arrays of nullish records keep the [each] prose instead of a half-rewritten every-line', () => {
    // The `every X element is` sugar only reads right when the element path appears once;
    // a nullish element's disjunction mentions it twice, so the line stays in [each] form.
    const report = analyzeSource('array-of-nullable.ts', `
      export function slotSum(slots: ({x: number} | null)[]): number {
        const first = slots[0]
        if (first == null) return 0
        return first.x
      }
    `)
    expect(analyzedFunction(report, 'slotSum').assumptions)
      .toEqual(['slots[each] is null or slots[each].x is finite and not NaN'])
  })

  test('switch dispatches without fallthrough: strings, numbers with narrowing, break merges', () => {
    // Owner decision: every non-empty case body ends in break or return, stacked empty
    // labels share the next body, default comes last. Under that rule a switch is exactly
    // an if/else chain on ===: string subjects analyze both branches, number subjects get
    // the comparison narrowing, and break paths merge after the switch.
    const report = analyzeSource('switch-dispatch.ts', `
      export function dispatch(mode: string, a: number, b: number): number {
        switch (mode) {
          case 'a':
          case 'b':
            return a
          default:
            return b
        }
      }
      export function gapFor(size: number): number {
        let gap = 0
        switch (size) {
          case 4: gap = 1; break
          case 8: gap = 2; break
          default: gap = 3; break
        }
        return gap
      }
      export function narrows(step: number): number {
        switch (step) {
          case 4: return 100 / step
          default: return 0
        }
      }
    `)
    expect(analyzedFunction(report, 'dispatch').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'gapFor').ensures).toEqual(['return is a finite integer number from 1 through 3'])
    // Inside case 4 the subject is exactly 4, so the division discharges with no
    // requirement — the same narrowing an if (step === 4) gets.
    expect(analyzedFunction(report, 'narrows').requires).toEqual([])
    expect(analyzedFunction(report, 'narrows').ensures).toEqual(['return is a finite number from 0 through 25'])
  })

  test('switch rejections: fallthrough, default not last, unsupported subjects', () => {
    const report = analyzeSource('switch-rejects.ts', `
      export function falls(mode: string, a: number): number {
        switch (mode) {
          case 'a': a = a + 1
          case 'b': return a
        }
        return 0
      }
      export function defaultFirst(mode: string, a: number, b: number): number {
        switch (mode) {
          default: return b
          case 'a': return a
        }
      }
      export function boolSubject(flag: boolean, a: number): number {
        switch (flag) {
          case true: return a
          default: return 0
        }
      }
    `)
    const entries = new Map(report.functions.map(fn => [fn.name, fn]))
    const falls = entries.get('falls')!
    if (falls.kind !== 'unsupported') throw new Error(`expected falls to be unsupported, got ${falls.kind}`)
    expect(falls.unsupported).toContain('falls through to the next case')
    const defaultFirst = entries.get('defaultFirst')!
    if (defaultFirst.kind !== 'unsupported') throw new Error(`expected defaultFirst unsupported, got ${defaultFirst.kind}`)
    expect(defaultFirst.unsupported).toContain('default clause before other cases')
    const boolSubject = entries.get('boolSubject')!
    if (boolSubject.kind !== 'unsupported') throw new Error(`expected boolSubject unsupported, got ${boolSubject.kind}`)
    expect(boolSubject.unsupported).toContain('only numbers and strings dispatch')
  })

  test('guards discharge nonzero obligations in all three everyday spellings', () => {
    const report = analyzeSource('guard-discharge.ts', `
      export function notEqualGuard(total: number, count: number): number {
        if (count !== 0) { return total / count }
        return 0
      }
      export function earlyReturn(total: number, count: number): number {
        if (count === 0) { return 0 }
        return total / count
      }
      export function positiveGuard(total: number, count: number): number {
        if (count > 0) { return total / count }
        return 0
      }
    `)
    for (const name of ['notEqualGuard', 'earlyReturn', 'positiveGuard']) {
      const fn = analyzedFunction(report, name)
      expect(fn.requires).toEqual([])
      // A float divisor can sit arbitrarily close to zero, so the quotient can overflow;
      // the honest ensures is possibly non-finite, never NaN (zero is cut, so no 0/0).
      expect(fn.ensures[0]).toContain('possibly non-finite')
      expect(fn.ensures[0]).not.toContain('NaN')
    }
  })

  test('the not-equal branch keeps NaN: a NaN operand passes !== and lands on the not-equal side', () => {
    // multiply can produce NaN (0 * Infinity); NaN !== 0 is true at runtime, so the
    // guarded branch must NOT claim NaN-freedom — the ensures stays possibly NaN.
    const report = analyzeSource('notequal-nan.ts', `
      export function scaled(a: number, b: number): number {
        const product = a * b
        if (product !== 0) { return 100 / product }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'scaled').ensures[0]).toContain('possibly NaN')
  })

  test('the zero exclusion survives loop widening', () => {
    const report = analyzeSource('loop-flag.ts', `
      export function accumulate(count: number, step: number): number {
        let total = 0
        for (let index = 0; index < count; index += 1) {
          if (step !== 0) { total = total + 100 / step }
        }
        return total
      }
    `)
    expect(analyzedFunction(report, 'accumulate').requires).toEqual([])
  })

  test('nonzero obligations peel to caller-readable conditions through float-exact layers only', () => {
    const report = analyzeSource('peeling.ts', `
      export function pad(total: number, width: number): number {
        return total / (width - 4)
      }
      export function doubled(total: number, scale: number): number {
        return total / ((scale + 10) * 2)
      }
      export function tinyFactor(total: number, x: number): number {
        return total / (x * 1e-300)
      }
      export function property(total: number, grid: {cols: number}): number {
        return total / (grid.cols - 1)
      }
    `)
    const file = resolve('peeling.ts')
    expect(analyzedFunction(report, 'pad').requires)
      .toEqual([`width is not 4 (division at ${file}:3:16)`])
    // The multiply peels (|2| >= 1 cannot underflow the product to zero), then the add.
    expect(analyzedFunction(report, 'doubled').requires)
      .toEqual([`scale is not -10 (division at ${file}:6:16)`])
    // A small constant CAN underflow the product to zero (1e-200 * 1e-200 === 0), so the
    // obligation stays as written.
    expect(analyzedFunction(report, 'tinyFactor').requires)
      .toEqual([`(x * 1e-300) is nonzero (division at ${file}:9:16)`])
    expect(analyzedFunction(report, 'property').requires)
      .toEqual([`grid.cols is not 1 (division at ${file}:12:16)`])
  })

  test('peeled requirements propagate through calls with the caller arguments substituted', () => {
    const report = analyzeSource('peel-propagation.ts', `
      function stepFor(width: number, gap: number): number {
        return width / (gap - 2)
      }
      export function layout(totalWidth: number, gutter: number): number {
        return stepFor(totalWidth, gutter + 1)
      }
      export function fixed(totalWidth: number): number {
        return stepFor(totalWidth, 10)
      }
    `)
    const file = resolve('peel-propagation.ts')
    // The peel stops at the substituted argument: (gutter + 1) is not 2 is float-exact,
    // while peeling further to 'gutter is not 1' would trust rounding.
    expect(analyzedFunction(report, 'layout').requires)
      .toEqual([`(gutter + 1) is not 2 (division at ${file}:3:16)`])
    // A constant argument discharges by plain evaluation: 10 - 2 is provably nonzero.
    expect(analyzedFunction(report, 'fixed').requires).toEqual([])
  })

  test('the bounds-check idiom discharges asserted reads: relation, integrality, manual loops', () => {
    const report = analyzeSource('bounds-idiom.ts', `
      export function at(sizes: number[], slot: number): number {
        if (Number.isInteger(slot) && slot >= 0 && slot < sizes.length) {
          return sizes[slot]!
        }
        return 0
      }
      export function manualLoop(values: number[]): number {
        let total = 0
        for (let index = 0; index < values.length; index += 1) {
          total = total + (values[index] ?? 0)
        }
        return total
      }
      export function floatIndex(sizes: number[], slot: number): number {
        if (slot >= 0 && slot < sizes.length) { return sizes[slot]! }
        return 0
      }
      export function wrongArray(a: number[], b: number[], i: number): number {
        if (Number.isInteger(i) && i >= 0 && i < a.length) { return b[i]! }
        return 0
      }
    `)
    const file = resolve('bounds-idiom.ts')
    // The full defensive guard proves the read: no requires line at all.
    expect(analyzedFunction(report, 'at').requires).toEqual([])
    expect(analyzedFunction(report, 'manualLoop').requires).toEqual([])
    // Without integrality the guard is not enough — sizes[1.5] misses — so the obligation
    // honestly survives as the caller-actionable requirement.
    expect(analyzedFunction(report, 'floatIndex').requires)
      .toEqual([`slot is a valid sizes index (element read at ${file}:16:56)`])
    // The relation is paired per array: guarding a's length says nothing about b.
    expect(analyzedFunction(report, 'wrongArray').requires)
      .toEqual([`i is a valid b index (element read at ${file}:20:69)`])
  })

  test('unproven asserted reads mint a requires when nameable, an assumes otherwise', () => {
    const report = analyzeSource('bounds-mint.ts', `
      const gapSizes = [4, 8, 24]
      export function fromModule(slot: number): number {
        return gapSizes[slot]!
      }
      export function fromParameter(sizes: number[], slot: number): number {
        return sizes[slot + 1]!
      }
    `)
    const file = resolve('bounds-mint.ts')
    // A module array is not caller-visible, so the obligation stays an assumes line.
    expect(analyzedFunction(report, 'fromModule').assumptions)
      .toContain(`the element read at ${file}:4:16 is in bounds`)
    expect(analyzedFunction(report, 'fromParameter').requires)
      .toEqual([`(slot + 1) is a valid sizes index (element read at ${file}:7:16)`])
  })

  test('the expression walk budget stops re-expansion blowup with the honest divisorUnknown', () => {
    // Each squaring doubles the expression tree (the defining DAG is linear, the tree is
    // exponential); the walk charges instruction expansions against the function's own
    // instruction count, so the requirement can never be more complex than the function.
    const chain = Array.from({length: 20}, () => '  a = a * a').join('\n')
    const report = analyzeSource('walk-budget.ts', `
      export function monster(total: number, x: number): number {
        let a = x + 1
${chain}
        return total / a
      }
    `)
    const monster = report.functions.find(fn => fn.name === 'monster')!
    if (monster.kind !== 'partial') throw new Error(`expected monster to be partial, got ${monster.kind}`)
    expect(monster.stopped[0]).toContain('cannot infer a nonzero requirement')
  })

  test('Number.isFinite narrows: the passing branch is finite, the failing branch prunes when provably finite', () => {
    const report = analyzeSource('isfinite-narrow.ts', `
      export function recovered(a: number, b: number): number {
        const product = a * b
        if (Number.isFinite(product)) { return product }
        return 0
      }
    `)
    // a * b can overflow and turn NaN, but the passing branch proves finiteness — and the
    // 0 fallback keeps the whole return finite.
    expect(analyzedFunction(report, 'recovered').ensures).toEqual(['return is a finite number'])
  })

  test('review round: the guard a peeled requires line names actually discharges it', () => {
    // The report says 'requires: width is not 4'; an agent writes exactly that guard and
    // the requirement must go away — the excluded-point cut flows through width - 4 into
    // a zero exclusion on the divisor (an IEEE sum is zero only on exact negation), and
    // through scale * 2 (a factor of magnitude at least 1 cannot underflow a nonzero
    // product to zero). Both spellings of the guard work.
    const report = analyzeSource('peel-discharge.ts', `
      export function widthGuard(width: number, total: number): number {
        if (width !== 4) { return total / (width - 4) }
        return 0
      }
      export function widthEarlyExit(width: number, total: number): number {
        if (width === 4) { return 0 }
        return total / (width - 4)
      }
      export function scaleGuarded(scale: number): number {
        if (scale !== 0) { return 100 / (scale * 2) }
        return 0
      }
    `)
    for (const name of ['widthGuard', 'widthEarlyExit', 'scaleGuarded']) {
      expect(analyzedFunction(report, name).requires).toEqual([])
    }
  })

  test('review round: the bounds-check guard works on record properties and across calls', () => {
    // Valid-index pairs key on canonical value names, so two property reads of the same
    // immutable record match — and a guarded call site seeds the relation onto the
    // callee's parameters, so the caller discharges what the callee alone must require.
    const report = analyzeSource('bounds-composition.ts', `
      type Config = {sizes: number[]; cursor: number}
      export function propertyGuard(config: Config): number {
        if (Number.isInteger(config.cursor) && config.cursor >= 0 && config.cursor < config.sizes.length) {
          return config.sizes[config.cursor]!
        }
        return 0
      }
      function sizeAt(sizes: number[], slot: number): number {
        return sizes[slot]!
      }
      export function guardedCall(sizes: number[], slot: number): number {
        if (Number.isInteger(slot) && slot >= 0 && slot < sizes.length) {
          return sizeAt(sizes, slot)
        }
        return 0
      }
    `)
    const file = resolve('bounds-composition.ts')
    expect(analyzedFunction(report, 'propertyGuard').requires).toEqual([])
    expect(analyzedFunction(report, 'guardedCall').requires).toEqual([])
    // The helper itself still carries the honest requirement for unguarded callers.
    expect(analyzedFunction(report, 'sizeAt').requires)
      .toEqual([`slot is a valid sizes index (element read at ${file}:10:16)`])
  })

  test('review round: Number.isNaN launders, and exact constants keep exact prose', () => {
    const report = analyzeSource('isnan-and-constants.ts', `
      export function laundered(a: number, b: number): number {
        const product = a * b
        if (Number.isNaN(product)) { return 0 }
        return Math.min(Math.max(product, 0), 100)
      }
      export function exactConstant(): number {
        return 0.1 + 0.2
      }
    `)
    // a * b can be NaN (0 * Infinity); the early return launders it, and the clamp does
    // the rest.
    expect(analyzedFunction(report, 'laundered').ensures)
      .toEqual(['return is a finite number from 0 through 100'])
    // A point interval is an exact value; the strict-bound rewrite must not turn it into
    // an absurd range like 'more than 0.3 and at most 0.30000000000000004'.
    expect(analyzedFunction(report, 'exactConstant').ensures)
      .toEqual(['return is a finite number from 0.30000000000000004 through 0.30000000000000004'])
  })

  test('review round 2: module-rooted bounds checks do not survive rebinding', () => {
    // Rebinding the module root is the subset's one blessed update idiom, so a bounds
    // check proven against the old array must not survive `data = [7]` — the guarded read
    // after the rebind honestly falls back to the in-bounds assumption, while the same
    // guard with no intervening write still discharges. The callee-write case is covered
    // by dropping module-rooted pairs at completed calls.
    const report = analyzeSource('module-rebind-bounds.ts', `
      let data = [10, 20, 30, 40]
      export function pick(i: number): number {
        if (Number.isInteger(i) && i >= 0 && i < data.length) {
          data = [7]
          return data[i]!
        }
        return 0
      }
      export function pickClean(i: number): number {
        if (Number.isInteger(i) && i >= 0 && i < data.length) {
          return data[i]!
        }
        return 0
      }
      function shrink(): void {
        data = [7]
      }
      export function pickThroughCall(i: number): number {
        if (Number.isInteger(i) && i >= 0 && i < data.length) {
          shrink()
          return data[i]!
        }
        return 0
      }
    `)
    const file = resolve('module-rebind-bounds.ts')
    expect(analyzedFunction(report, 'pick').assumptions)
      .toContain(`the element read at ${file}:6:18 is in bounds`)
    expect(analyzedFunction(report, 'pickClean').assumptions.join(' ')).not.toContain('is in bounds')
    expect(analyzedFunction(report, 'pickThroughCall').assumptions)
      .toContain(`the element read at ${file}:22:18 is in bounds`)
  })

  test('review round 3: initializer bounds assumptions travel to module readers', () => {
    // A top-level breakpoints[idx]! with a platform-derived index conditions everything
    // the initializer published; the assumption line lands on every function that reads a
    // module binding (currentBreakpoint would return undefined at a wide viewport, so its
    // ensures must not publish unconditionally), and functions touching no module state
    // stay clean.
    const report = analyzeSource('init-bounds.ts', `
      const breakpoints = [480, 768, 1024]
      const idx = Math.min(Math.floor(window.innerWidth / 400), 5)
      const activeBreakpoint = breakpoints[idx]!
      export function currentBreakpoint(): number {
        return activeBreakpoint
      }
      export function unrelated(x: number): number {
        return x * 2
      }
    `)
    const file = resolve('init-bounds.ts')
    expect(analyzedFunction(report, 'currentBreakpoint').assumptions)
      .toEqual([`the element read at ${file}:4:32 is in bounds`])
    expect(analyzedFunction(report, 'unrelated').assumptions).toEqual(['x is finite and not NaN'])
  })

  test('the float biconditionals behind requirement simplification hold mechanically', () => {
    // Requirement simplification and its forward mirror in the domain arithmetic rest on
    // two IEEE-754 facts: gradual underflow makes a subtraction exact when its result is
    // tiny, so x - c is zero exactly when x equals c; and a factor of magnitude at least
    // 1 cannot shrink a nonzero value below the round-to-zero threshold. Checked here
    // over subnormals, boundary values, and deterministic random bit patterns rather
    // than trusted from memory of the standard.
    const battery = [
      0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** -1073, 2 ** -1022,
      (2 ** -1022) * (1 - 2 ** -52), Number.MAX_VALUE, -Number.MAX_VALUE,
      1, -1, 1 + 2 ** -52, 0.1, 0.3, 1e-200, 1e-300, 1e300, 4, 2 ** 53, 2 ** 53 + 2,
    ]
    let seed = 0x9e3779b97f4a7c15n
    const scratch = new Float64Array(1)
    const scratchBits = new BigUint64Array(scratch.buffer)
    const values = [...battery]
    while (values.length < 700) {
      seed = (seed ^ (seed << 13n)) & 0xffffffffffffffffn
      seed ^= seed >> 7n
      seed = (seed ^ (seed << 17n)) & 0xffffffffffffffffn
      scratchBits[0] = seed
      const candidate = scratch[0]!
      if (Number.isFinite(candidate)) values.push(candidate)
    }
    const failures: string[] = []
    for (const x of values) {
      for (const c of values) {
        if ((x - c === 0) !== (x === c)) failures.push(`subtract: x=${x} c=${c}`)
        if ((x + c === 0) !== (x === -c)) failures.push(`add: x=${x} c=${c}`)
        if (Math.abs(c) >= 1 && Number.isFinite(c) && (c * x === 0) !== (x === 0)) {
          failures.push(`multiply: x=${x} c=${c}`)
        }
      }
    }
    expect(failures).toEqual([])
    // The counterexamples that keep small factors and division out of the rule — the
    // lint is right that these are constant zero; constant zero from nonzero operands is
    // the whole point being pinned.
    // oxlint-disable-next-line erasing-op
    expect(1e-200 * 1e-200).toBe(0)
    // oxlint-disable-next-line erasing-op
    expect(1e-300 / 1e300).toBe(0)
  })

  test('Math.round, ceil, trunc, sqrt, and the square identity', () => {
    // The rounding family is monotone and exact on infinities like floor; sqrt clips a
    // possibly-negative operand to the non-negative part and turns the NaN flag on; and
    // x * x with the SAME value on both sides cannot be negative, which together with a
    // Number.isFinite guard proves the classic vector length finite.
    const report = analyzeSource('math-family.ts', `
      export function snap(target: number, step: number): number {
        if (step > 0) { return Math.round(target / step) * step }
        return target
      }
      export function cells(width: number): number {
        return Math.max(1, Math.ceil(width / 240))
      }
      export function bareLength(dx: number, dy: number): number {
        return Math.sqrt(dx * dx + dy * dy)
      }
      export function safeLength(dx: number, dy: number): number {
        const sum = dx * dx + dy * dy
        if (Number.isFinite(sum)) { return Math.sqrt(sum) }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'cells').ensures)
      .toEqual(['return is a finite integer number from 1 through 7.490388061926316e+305'])
    // Squares cannot be negative, so the sum has no opposite-infinity corner and never
    // turns NaN — the unguarded length can only overflow, and sqrt carries the honest
    // possibly-non-finite through.
    expect(analyzedFunction(report, 'bareLength').ensures[0])
      .toContain('possibly non-finite number from 0 through Infinity')
    expect(analyzedFunction(report, 'safeLength').ensures)
      .toEqual(['return is a finite number from 0 through 1.3407807929942596e+154'])
  })

  test('tagged unions: checks narrow, else-if chains prune, switch dispatches, literals build variants', () => {
    // A union of record shapes told apart by route.type carries one record per variant.
    // Tag checks keep matching variants per branch; a single-variant union stays a union,
    // so later checks against other tags are definitely false and dead branches prune —
    // by the third arm of the chain, route is provably the lightbox shape and its index
    // reads. Literals remember which variant they build, so branches building different
    // variants join per tag and callers narrow them back apart.
    const report = analyzeSource('tagged-unions.ts', `
      type Route =
        | {type: 'explore'; filter: string}
        | {type: 'lightbox'; id: string; index: number}
        | {type: 'archive'; page: number}
      export function elseIfChain(route: Route): number {
        if (route.type === 'explore') { return 1 }
        if (route.type === 'archive') { return route.page }
        return route.index
      }
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      function pick(wide: boolean): Frame {
        if (wide) { return {type: 'sidebar', width: 240} }
        return {type: 'mobile', scale: 0.5}
      }
      export function useIt(wide: boolean): number {
        const frame = pick(wide)
        if (frame.type === 'sidebar') { return frame.width }
        return frame.scale * 100
      }
      export function switchOnTag(frame: Frame): number {
        switch (frame.type) {
          case 'sidebar': return frame.width
          default: return frame.scale
        }
      }
    `)
    expect(analyzedFunction(report, 'elseIfChain').assumptions).toEqual([
      "route.index is finite and not NaN (when route.type is 'lightbox')",
      "route.page is finite and not NaN (when route.type is 'archive')",
    ])
    expect(analyzedFunction(report, 'elseIfChain').ensures).toEqual(['return is a finite number'])
    // The two variants' exact constants survive the join and re-split at the caller.
    expect(analyzedFunction(report, 'useIt').ensures).toEqual(['return is a finite number from 50 through 240'])
    expect(analyzedFunction(report, 'switchOnTag').ensures).toEqual(['return is a finite number'])
  })

  test('tagged unions: duplicate tag values keep both variants, and in-checks tell them apart', () => {
    // UpdatesRoute-style: two variants share the tag 'updates' and differ by which
    // property exists — exactly what TypeScript's own narrowing needs an in-check for.
    const report = analyzeSource('duplicate-tags.ts', `
      type Route = {type: 'updates'; tab: number} | {type: 'updates'; article: string} | {type: 'home'; scroll: number}
      export function tabOf(route: Route): number {
        if (route.type === 'updates' && 'tab' in route) { return route.tab }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'tabOf').ensures).toEqual(['return is a finite number'])
  })

  test('tagged unions: nullable wrappers carry them, and nesting mirrors the type tree', () => {
    const report = analyzeSource('nullable-tagged.ts', `
      type Owner = {type: 'explore'; page: number} | {type: 'imagine'; count: number}
      type Lightbox = {type: 'lightbox'; index: number; owner: null | Owner}
      export function ownerPage(box: Lightbox): number {
        const owner = box.owner
        if (owner === null) { return 0 }
        if (owner.type === 'explore') { return owner.page }
        return owner.count
      }
    `)
    expect(analyzedFunction(report, 'ownerPage').assumptions).toEqual([
      'box.index is finite and not NaN',
      "box.owner is null or box.owner.page is finite and not NaN (when box.owner.type is 'explore')",
      "box.owner is null or box.owner.count is finite and not NaN (when box.owner.type is 'imagine')",
    ])
    expect(analyzedFunction(report, 'ownerPage').ensures).toEqual(['return is a finite number'])
  })

  test('tagged unions: per-variant return facts, and loops over unions converge', () => {
    const report = analyzeSource('tagged-returns.ts', `
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      export function pick(wide: boolean): Frame {
        if (wide) { return {type: 'sidebar', width: 240} }
        return {type: 'mobile', scale: 0.5}
      }
      export function total(frames: Frame[]): number {
        let sum = 0
        for (const frame of frames) {
          if (frame.type === 'sidebar') { sum = sum + frame.width }
        }
        return sum
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures).toEqual([
      "return.type is 'sidebar' or 'mobile'",
      "return.width is a finite integer number from 240 through 240 (when return.type is 'sidebar')",
      "return.scale is a finite number from 0.5 through 0.5 (when return.type is 'mobile')",
    ])
    expect(analyzedFunction(report, 'total').assumptions).toEqual([
      "frames[each].width is finite and not NaN (when frames[each].type is 'sidebar')",
      "frames[each].scale is finite and not NaN (when frames[each].type is 'mobile')",
    ])
  })

  test('review round: duplicate-tag variants survive self-joins, rebuilds and presets never crash', () => {
    // Round-1 findings: (1) joining a state with itself paired same-tag variants by tag
    // alone and intersected away the property an in-check needs — variants now pair by
    // tag AND property-name shape, so the article branch stays reachable; (2) the rebuild
    // idiom {...frame, width: ...} and a preset annotated as one member shape used to
    // throw at the join — the literal's own checked type now names the variant, and a
    // record meeting a union degrades to the shared hull instead of crashing.
    const report = analyzeSource('union-round1.ts', `
      type Updates = {type: 'updates'; tab: number} | {type: 'updates'; article: number}
      export function badgeJoined(route: Updates, verbose: boolean): number {
        let base = 0
        if (verbose) { base = 1 }
        if ('article' in route) { return route.article + base }
        return base
      }
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      export function widen(frame: Frame): Frame {
        if (frame.type === 'sidebar') { return {...frame, width: frame.width + 40} }
        return frame
      }
      const sidebarPreset: {type: 'sidebar'; width: number} = {type: 'sidebar', width: 200}
      export function pick(compact: boolean): Frame {
        return compact ? {type: 'mobile', scale: 0.5} : sidebarPreset
      }
    `)
    // The article branch is reachable: the ensures must cover route.article + base.
    expect(analyzedFunction(report, 'badgeJoined').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'widen').ensures).toContain("return.type is 'sidebar' or 'mobile'")
    // The preset's variant is unknown to the analysis, so the join degrades to the shared
    // hull — an honest near-empty contract, never a crash.
    expect(analyzedFunction(report, 'pick').ensures).toEqual([])
  })

  test('review round: exhaustive switch without default analyzes; narrowing writes back through unions', () => {
    // The fall-off-the-end of a non-void function is a per-path stop now, not a
    // whole-function rejection — and an exhaustive switch over the variants makes that
    // path provably unreachable, so the function analyzes clean, matching TypeScript's
    // own exhaustiveness acceptance. Property refinements also write back through union
    // parents, so a range check inside a variant sticks.
    const report = analyzeSource('union-round1b.ts', `
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      export function widthOf(frame: Frame): number {
        switch (frame.type) {
          case 'sidebar': return frame.width
          case 'mobile': return frame.scale * 320
        }
      }
      type Overlay = {mode: 'zoom'; level: number} | {mode: 'pan'; dx: number}
      export function levelOf(panel: {overlay: Overlay}): number {
        if (panel.overlay.mode === 'zoom') { return panel.overlay.level }
        return panel.overlay.dx
      }
    `)
    const widthOf = analyzedFunction(report, 'widthOf')
    expect(widthOf.ensures[0]).toContain('number')
    expect(analyzedFunction(report, 'levelOf').ensures).toEqual(['return is a finite number'])
  })

  test('unclassifiable properties become opaque leaves; intersections classify; hull reads stop honestly', () => {
    // A recursive or mixed-literal property no longer vetoes its record: it is carried
    // without claims, numeric use of it rejects at the read position, and the record's
    // numeric contract survives its weird neighbors. Route variants written as
    // intersections (Base & {...}) classify like the merged record they are. And a read
    // past a degraded hull (a union that met a plain record) stops honestly instead of
    // crashing the run.
    const report = analyzeSource('opaque-leaves.ts', `
      type Filter = {kind: 'all'} | {kind: 'top'}
      type Base = {type: 'explore'; scroll: number}
      type ExploreRoute = Base & {filter: Filter | null; recursive: ExploreRoute | null}
      type Route = ExploreRoute | {type: 'home'; depth: number}
      export function scrollOf(route: Route): number {
        if (route.type === 'explore') { return route.scroll }
        return route.depth
      }
    `)
    expect(analyzedFunction(report, 'scrollOf').assumptions).toEqual([
      "route.scroll is finite and not NaN (when route.type is 'explore')",
      "route.depth is finite and not NaN (when route.type is 'home')",
    ])
    expect(analyzedFunction(report, 'scrollOf').ensures).toEqual(['return is a finite number'])
  })

  test('variant literals fill their optionals, so reads after joins never miss', () => {
    const report = analyzeSource('variant-fill.ts', `
      type Route = {type: 'archive'; folder?: string; page: number} | {type: 'home'; scroll: number}
      export function build(deep: boolean): Route {
        if (deep) { return {type: 'archive', folder: 'x', page: 2} }
        return {type: 'archive', page: 1}
      }
      export function pageOf(deep: boolean): number {
        const route = build(deep)
        if (route.type === 'archive') { return route.page }
        return 0
      }
    `)
    // 1 through 2, not 0 through 2: build only ever returns archive variants, so the
    // home arm is provably dead and prunes.
    expect(analyzedFunction(report, 'pageOf').ensures).toEqual(['return is a finite integer number from 1 through 2'])
  })

  test('tag checks on plain-record operands dispatch blind; inherited lib properties stay boundary leaves', () => {
    // A builder whose declared return is a single variant produces a plain record; the
    // caller's union-typed binding then tag-checks it. The record's tag was never
    // learned, so the check is honestly unknown and both branches analyze — the round-2
    // regression (a kind-mismatch stop) healed. And a project interface extending a lib
    // interface contracts only the properties the project wrote.
    const report = analyzeSource('record-dispatch.ts', `
      type Route = {kind: 'home'; scroll: number} | {kind: 'about'; scroll: number}
      function openHome(): {kind: 'home'; scroll: number} { return {kind: 'home', scroll: 3} }
      function openAbout(): {kind: 'about'; scroll: number} { return {kind: 'about', scroll: 14} }
      export function currentScroll(flag: boolean): number {
        const route: Route = flag ? openHome() : openAbout()
        if (route.kind === 'home') { return route.scroll }
        return route.scroll
      }
    `)
    expect(analyzedFunction(report, 'currentScroll').ensures)
      .toEqual(['return is a finite integer number from 3 through 14'])
  })

  test('in-checks on joined records never prune the absent side', () => {
    // The join of {kind, scroll} and {kind, tab} keeps only 'kind' — the missing 'tab' is
    // a join casualty, not proof of runtime absence, so the in-check's true branch stays
    // reachable (probe(false) returns 999 at runtime). Only the present direction
    // decides: a join never invents a property.
    const report = analyzeSource('in-joined-record.ts', `
      type Route = {kind: 'home'; scroll: number} | {kind: 'about'; tab: number}
      function openHome(): {kind: 'home'; scroll: number} { return {kind: 'home', scroll: 3} }
      function openAbout(): {kind: 'about'; tab: number} { return {kind: 'about', tab: 5} }
      export function probe(flag: boolean): number {
        const route: Route = flag ? openHome() : openAbout()
        if ('tab' in route) { return 999 }
        return 1
      }
    `)
    expect(analyzedFunction(report, 'probe').ensures)
      .toEqual(['return is a finite integer number from 1 through 999'])
  })

  test('throw guards discharge obligations; always-throwing functions never return', () => {
    // A thrown path simply ends — no exception modeling needed, because the subset has no
    // catch: nothing analyzed can observe anything after a throw. The guard clause's
    // branch refinement then discharges the division, a function that throws on every
    // path is analyzed with no ensures (it never returns normally), and its callers stop
    // with the honest reason.
    const report = analyzeSource('throw-guards.ts', `
      export function divideWidth(width: number, columns: number): number {
        if (columns === 0) { throw new Error('bad grid') }
        return width / columns
      }
      export function fail(code: number): number {
        throw new Error('nope ' + code)
      }
      export function caller(x: number): number {
        if (x < 0) { return fail(x) }
        return x
      }
    `)
    expect(analyzedFunction(report, 'divideWidth').requires).toEqual([])
    expect(analyzedFunction(report, 'fail').ensures).toEqual([])
    // A guarded call to an always-throwing helper behaves exactly like an inline throw:
    // the path ends silently and the returning path carries the full contract.
    expect(analyzedFunction(report, 'caller').ensures).toEqual(['return is a finite number at least 0'])
  })

  test('pattern sweep: boolean equality, string length, typeof strings, nullable switch subjects', () => {
    const report = analyzeSource('sweep-group2.ts', `
      export function boolEq(config: {enabled: boolean}, x: number): number {
        if (config.enabled === true) { return x }
        return 0
      }
      export function nameLength(name: string): number {
        return Math.min(name.length, 40)
      }
      export function typeofString(input: string | undefined, x: number): number {
        if (typeof input === 'string') { return x }
        return 0
      }
      export function switchNullable(mode: string | undefined, a: number, b: number): number {
        switch (mode) {
          case 'wide': return a
          default: return b
        }
      }
    `)
    expect(analyzedFunction(report, 'boolEq').ensures).toEqual(['return is a finite number'])
    // .length is a fresh nonnegative integer; the clamp gives the exact range.
    expect(analyzedFunction(report, 'nameLength').ensures).toEqual(['return is a finite integer number from 0 through 40'])
    expect(analyzedFunction(report, 'typeofString').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'switchNullable').ensures).toEqual(['return is a finite number'])
  })

  test('pattern sweep: parse functions, callback and unknown parameters, instanceof', () => {
    // parseFloat is an honest NaN source and the isFinite narrowing launders it — the
    // parse-then-clamp idiom proves its bound. Callback and unknown parameters carry
    // opaquely (calls to a carried callback still reject at the call gate; unknown is the
    // safe any — the checker forces narrowing before use). instanceof on a carried value
    // answers unknown: both branches analyze, no claims.
    const report = analyzeSource('sweep-group3.ts', `
      export function parsed(text: string): number {
        const value = Number.parseFloat(text)
        if (Number.isFinite(value)) { return Math.min(value, 100) }
        return 0
      }
      export function withCallback(onDone: () => void, x: number): number {
        const kept = onDone
        return x + 1
      }
      export function carries(data: unknown, x: number): number {
        const kept = data
        return x * 2
      }
      export function domCheck(el: unknown, x: number): number {
        if (el instanceof HTMLDivElement) { return x }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'parsed').ensures).toEqual(['return is a finite number at most 100'])
    expect(analyzedFunction(report, 'withCallback').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'carries').ensures[0]).toContain('number')
    expect(analyzedFunction(report, 'domCheck').ensures).toEqual(['return is a finite number'])
  })

  test('pattern sweep: logical assignments, remainder, optional chaining, destructured parameters', () => {
    const report = analyzeSource('sweep-group4.ts', `
      export function nullishAssign(timeout: number | null): number {
        let effective = timeout
        effective ??= 250
        return effective
      }
      export function modulo(index: number, length: number): number {
        if (length === 0) { return 0 }
        return index % length
      }
      export function moduloRequires(index: number, length: number): number {
        return index % length
      }
      export function chainRead(config: {volume: number} | null): number {
        return config?.volume ?? 5
      }
      type Size = {width: number; height: number}
      export function area({width, height}: Size): number {
        return Math.min(width * height, 5000)
      }
      export function ratioReq({width, height}: Size): number {
        return width / height
      }
    `)
    const file = resolve('sweep-group4.ts')
    expect(analyzedFunction(report, 'nullishAssign').ensures).toEqual(['return is a finite number'])
    // The === 0 guard discharges the remainder's obligation like division's.
    expect(analyzedFunction(report, 'modulo').requires).toEqual([])
    expect(analyzedFunction(report, 'modulo').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'moduloRequires').requires)
      .toEqual([`length is nonzero (remainder at ${file}:12:16)`])
    expect(analyzedFunction(report, 'chainRead').assumptions)
      .toEqual(['config is null or config.volume is finite and not NaN'])
    expect(analyzedFunction(report, 'chainRead').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'area').assumptions).toEqual([
      '{width, height}.width is finite and not NaN',
      '{width, height}.height is finite and not NaN',
    ])
    // Requirements name destructured properties through the synthetic record parameter.
    expect(analyzedFunction(report, 'ratioReq').requires)
      .toEqual([`{width, height}.height is nonzero (division at ${file}:22:16)`])
  })

  test('module reads narrow their slot: re-reads keep refinements, parse-then-throw launders', () => {
    // A refinement on a module read writes into the slot, so the read-check-read spelling
    // works without the old copy-to-a-local workaround, and a top-level parse guarded by
    // an isNaN throw publishes its value NaN-free (Infinity stays possible — parseFloat
    // of '1e999' is honest overflow).
    const report = analyzeSource('module-narrow.ts', `
      const raw = Number.parseFloat('42.5')
      if (Number.isNaN(raw)) { throw new Error('bad build constant') }
      export function scaled(): number {
        return raw
      }
      const config: {scale: number | null} = {scale: 3}
      export function reader(): number {
        if (config.scale !== null) { return config.scale + 1 }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'scaled').ensures[0]).not.toContain('NaN')
    expect(analyzedFunction(report, 'reader').ensures).toEqual(['return is a finite integer number from 4 through 4'])
  })

  test('publishes values initialized before a top-level stop and distrusts writes after it', () => {
    const report = analyzeSource('module-stop.ts', `
      const boxesGapY = 12
      runsUnsupported()
      let scale = 3
      export function gapAfterStop(): number {
        return boxesGapY
      }
      export function scaleAfterStop(): number {
        return scale
      }
      function runsUnsupported(): number {
        return 1 ** 2
      }
    `)
    const file = resolve('module-stop.ts')
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      stopped: [`calls runsUnsupported, which hit unsupported code (call at ${file}:3:7)`],
      skipped: [],
      observed: [],
    })
    // boxesGapY was written before the stop, so its value holds on every analyzed path.
    expect(analyzedFunction(report, 'gapAfterStop').ensures)
      .toEqual(['return is a finite integer number from 12 through 12'])
    // scale's write sits past the stop: the analysis never confirmed it ran, so only the
    // declared kind survives.
    const scaleReader = analyzedFunction(report, 'scaleAfterStop')
    expect(scaleReader.assumptions).toEqual(['scale is finite and not NaN'])
    expect(scaleReader.ensures).toEqual(['return is a finite number'])
  })

  test('eval anywhere puts the whole file outside the subset', () => {
    // An eval string can rewrite any binding in the file at runtime, so rejecting only the
    // function containing the call would not protect the other functions' reports. The
    // detection is a plain identifier scan: every spelling that could reach module scope,
    // e.g. `(eval)(...)`, contains the identifier.
    const source = `
      const fixedHeight = 4
      export function readHeight(): number {
        return fixedHeight
      }
      function poke(): void {
        eval("somethingElse = 99")
      }
    `
    const report = analyzeSource('module-eval.ts', source)
    const file = resolve('module-eval.ts')
    const prose = `eval appears in this file; an eval string can rewrite any binding, so no function in the file is analyzed at ${file}:7:9`
    expect(report.functions).toEqual([
      {kind: 'partial', name: 'module initialization', assumptions: [], stopped: [prose], skipped: [], observed: []},
      {kind: 'unsupported', name: 'readHeight', unsupported: prose},
      {kind: 'unsupported', name: 'poke', unsupported: prose},
    ])

    const wrapped = analyzeSource('module-eval-wrapped.ts', source.replace('eval(', '(eval)('))
    expect(wrapped.functions.every(fn => fn.kind !== 'analyzed')).toBe(true)
  })

  test('finds writes hidden in shorthand destructuring assignments', () => {
    // In `({scale} = source)`, getSymbolAtLocation on the shorthand name returns the
    // contextual type's property symbol, not the module variable; the scan must resolve it
    // to the variable or the write is missed and a stale exact value is published.
    const report = analyzeSource('module-destructuring.ts', `
      let scale = 2
      export function readScale(): number {
        return scale
      }
      export function overwrite(source: {scale: number}): number {
        ;({scale} = source)
        return 1
      }
    `)
    const reader = analyzedFunction(report, 'readScale')
    expect(reader.assumptions).toEqual(['scale is finite and not NaN'])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('rejects var declarations', () => {
    // Hoisting gives one variable several declaration sites (`var x = 1; { var x = 2 }` is
    // one variable), which the binding model does not represent; let and const express the
    // same programs. In a function the whole function is rejected; at top level the
    // initializer stops at the var statement, and functions reading the name never see a
    // module binding.
    const report = analyzeSource('module-var.ts', `
      var mode = 1
      export function currentMode(): number {
        return mode
      }
      export function lastWrite(count: number): number {
        var width = 1
        for (let index = 0; index < count; index++) {
          var width = 5
        }
        return width
      }
    `)
    const file = resolve('module-var.ts')
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      stopped: [],
      skipped: [`var declarations (use let or const) at ${file}:2:7`],
      observed: [],
    })
    expect(report.functions.find(fn => fn.name === 'currentMode')).toEqual({
      kind: 'unsupported',
      name: 'currentMode',
      unsupported: `unknown identifier mode at ${file}:4:16`,
    })
    expect(report.functions.find(fn => fn.name === 'lastWrite')?.kind).toBe('unsupported')
  })

  test('records a top-level loop that never exits instead of crashing', () => {
    const report = analyzeSource('module-spin.ts', `
      const boxesGapX = 24
      for (let index = 0; true; index += 1) {}
      export function readGap(): number {
        return boxesGapX
      }
    `)
    const file = resolve('module-spin.ts')
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      stopped: [`the loop at ${file}:3:7 never exits on any analyzed path`],
      skipped: [],
      observed: [],
    })
    // boxesGapX was written before the loop and the loop writes nothing, so it publishes.
    expect(analyzedFunction(report, 'readGap').ensures)
      .toEqual(['return is a finite integer number from 24 through 24'])
  })

  test('keeps mixed-kind writes to an unknown-typed module binding from crashing the join', () => {
    const report = analyzeSource('module-opaque.ts', `
      let anything: unknown = 5
      let flag = 3
      if (readFlag() > 2) {
        anything = true
      }
      export function readFlag(): number {
        return flag
      }
    `)
    // One path leaves a number in the slot and the other a boolean; the slot must not hold
    // either (reads of unknown-typed bindings stop anyway), so the join never sees mixed
    // kinds. flag is written before the branch on both paths, so it still publishes.
    expect(analyzedFunction(report, 'readFlag').ensures)
      .toEqual(['return is a finite integer number from 3 through 3'])
  })

  test('rejects type assertions', () => {
    // An assertion changes the static type without changing the value; everything downstream
    // is keyed to static types, so `true as unknown as number` would put a boolean where
    // number invariants apply. Rejected wholesale — a same-shape assertion like
    // `{value: width} as {value: number}` is rejected too, not special-cased.
    const report = analyzeSource('module-assertion.ts', `
      let count = 1
      export function poke(flag: number): number {
        if (flag < 5) {
          count = true as unknown as number
        }
        return 0
      }
      export function currentCount(): number {
        return count
      }
      export function sameShape(width: number): number {
        const box = {value: width} as {value: number}
        return box.value
      }
    `)
    const file = resolve('module-assertion.ts')
    expect(report.functions.find(fn => fn.name === 'poke')).toEqual({
      kind: 'unsupported',
      name: 'poke',
      unsupported: `a type assertion to number (remove the assertion and declare the intended type instead) at ${file}:5:19`,
    })
    expect(report.functions.find(fn => fn.name === 'sameShape')?.kind).toBe('unsupported')
    // The scan still counts the unanalyzed write, so count keeps only its declared kind.
    const reader = analyzedFunction(report, 'currentCount')
    expect(reader.assumptions).toEqual(['count is finite and not NaN'])
  })

  test('accepts as const, the one assertion that cannot lie', () => {
    // TypeScript only permits `as const` on literals, and it narrows the literal to its own
    // literal type, so the value kind never changes; config constants written this way are
    // ordinary code. The exact 4 flowing into the result proves the value passed through.
    const report = analyzeSource('module-as-const.ts', `
      const msPerStep = 4 as const
      export function stepsFor(durationMs: number): number {
        return Math.max(0, durationMs) / msPerStep
      }
    `)
    const fn = analyzedFunction(report, 'stepsFor')
    expect(fn.assumptions).toEqual(['durationMs is finite and not NaN'])
    // Dividing by the exact 4 gives a concrete upper bound (largest finite double / 4),
    // which is the proof the const-assertion value flowed through.
    expect(fn.ensures).toEqual(['return is a finite number from 0 through 4.4942328371557893e+307'])
  })

  test('a type-check suppression comment puts the whole file outside the subset', () => {
    // A suppression directive turns off the checker for a line, and every guarantee rests
    // on the checker's word: here a boolean sits in a number binding with no `any` in
    // sight. The directive is interpolated so this test file itself does not carry one.
    const report = analyzeSource('module-suppressed.ts', `
      export function broken(): number {
        // ${'@ts-expect-error'} migration leftover
        let width: number = true
        return width + 1
      }
      export function unrelated(width: number): number {
        return width + 1
      }
    `)
    for (const fn of report.functions) {
      expect(fn.kind).toBe(fn.name === 'module initialization' ? 'partial' : 'unsupported')
    }
    expect(formatReport(report)).toContain('a @ts-ignore, @ts-expect-error, or @ts-nocheck comment turns off type checking')
  })

  test('records a kind-changing non-null assertion as unsupported', () => {
    const report = analyzeSource('non-null.ts', `
      let maybe: number | null = 5
      export function forced(): number {
        return maybe!
      }
    `)
    const file = resolve('non-null.ts')
    expect(report.functions.find(fn => fn.name === 'forced')).toEqual({
      kind: 'unsupported',
      name: 'forced',
      unsupported: `a non-null assertion turning number | null into number at ${file}:4:16`,
    })
  })

  test('rejects values typed any wherever they flow', () => {
    // TypeScript accepts an any-typed value in every position, so a type-checked function
    // can still put a boolean into a number variable; the value's own expression is
    // rejected, which covers declarations, call arguments, and returns alike. Each shape
    // below crashed the engine before the acceptance check existed.
    const report = analyzeSource('module-any.ts', `
      export function launder(): number {
        const hidden: any = true
        const forced: number = hidden
        return forced + 2
      }
      function double(width: number): number {
        return width * 2
      }
      export function laundersArgument(): number {
        const hidden: any = true
        return double(hidden)
      }
      export function laundersReturn(): number {
        const hidden: any = true
        return hidden
      }
      export function passThrough(width: number): number {
        return width + 1
      }
    `)
    const file = resolve('module-any.ts')
    expect(report.functions).toEqual([
      {
        kind: 'unsupported',
        name: 'launder',
        unsupported: `a value typed any (give it a concrete number, boolean, or object type) at ${file}:3:15`,
      },
      {
        kind: 'analyzed',
        name: 'double',
        assumptions: ['width is finite and not NaN'],
        requires: [],
        // Doubling can overflow to Infinity at the finite extremes; the suffix names it.
        ensures: [`return is a possibly non-finite number from -Infinity through Infinity (can overflow at ${file}:8:16)`],
      },
      {
        kind: 'unsupported',
        name: 'laundersArgument',
        unsupported: `a value typed any (give it a concrete number, boolean, or object type) at ${file}:11:15`,
      },
      {
        kind: 'unsupported',
        name: 'laundersReturn',
        unsupported: `a value typed any (give it a concrete number, boolean, or object type) at ${file}:15:15`,
      },
      {
        kind: 'analyzed',
        name: 'passThrough',
        assumptions: ['width is finite and not NaN'],
        requires: [],
        ensures: ['return is a finite number'],
      },
    ])
  })

  test('hedges boolean module reads whose writes the analysis never sees', () => {
    // poison is rejected (its parameter is typed any), but it still runs at runtime and
    // writes flag, so the scan demotes flag to its declared kind and "return is boolean"
    // stays conditional on the binding actually holding a boolean.
    const report = analyzeSource('module-any-boolean.ts', `
      let flag = false
      export function poison(value: any): void {
        flag = value
      }
      export function readFlag(): boolean {
        return flag
      }
    `)
    const reader = analyzedFunction(report, 'readFlag')
    expect(reader.assumptions).toEqual(['flag is a boolean'])
    expect(reader.ensures).toEqual(['return is boolean'])
  })

  test('records a never-exiting loop whose condition is a ternary', () => {
    // The ternary puts the body/exit branch in a continuation block, not on the tagged loop
    // header, so the detection must recognize the cycle rather than the header's branch.
    const report = analyzeSource('ternary-spin.ts', `
      export function spin(width: number): number {
        for (let index = 0; index < 10 ? true : index >= 0; index += 1) {}
        return 1
      }
    `)
    const file = resolve('ternary-spin.ts')
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'spin',
      assumptions: ['width is finite and not NaN'],
      stopped: [`the loop at ${file}:3:9 never exits on any analyzed path`],
      observed: [],
    }])
  })

  test('snaps integer bounds so contradictory refinements cannot strand the evaluation', () => {
    // Without snapping, the first loop's non-strict exit refinement kept index as an
    // integer-flagged [3.2, ...] interval; downstream, the bounds view and the integer view
    // disagreed, a comparison pruned both branch edges, and the analysis crashed with no
    // path end. Snapped, the exit gives index >= 4, and the second loop is correctly
    // recorded as never exiting.
    const report = analyzeSource('integer-snap.ts', `
      export function stall(width: number): number {
        let index = Math.floor(width)
        for (; index < 3.2; index += 1) {}
        for (; 3.4 < index; index -= 0) {}
        if (index < 3.9) return 1
        return 2
      }
    `)
    const file = resolve('integer-snap.ts')
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'stall',
      assumptions: ['width is finite and not NaN'],
      stopped: [`the loop at ${file}:5:9 never exits on any analyzed path`],
      observed: [],
    }])
  })

  test('lowers boolean logical operators with short-circuit shape', () => {
    const report = analyzeSource('logical.ts', `
      export function inRange(v: number): boolean {
        return 0 <= v && v <= 100
      }
      export function settled(v: number, target: number): number {
        if (Math.abs(v) < 0.01 && Math.abs(target - v) < 0.01) return 0
        return 1
      }
      export function either(v: number): boolean {
        return !(v > 0) || v > 100
      }
    `)
    expect(analyzedFunction(report, 'inRange').ensures).toEqual(['return is boolean'])
    expect(analyzedFunction(report, 'settled').ensures)
      .toEqual(['return is a finite integer number from 0 through 1'])
    expect(analyzedFunction(report, 'either').ensures).toEqual(['return is boolean'])
  })

  test('Math.abs produces a nonnegative range', () => {
    const report = analyzeSource('absolute.ts', `
      export function distance(a: number, b: number): number {
        return Math.abs(a - b)
      }
    `)
    // The difference of two unbounded finite inputs can overflow, so the honest range is
    // nonnegative but possibly non-finite — and the blame suffix names the subtraction,
    // inherited through Math.abs.
    expect(analyzedFunction(report, 'distance').ensures)
      .toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${resolve('absolute.ts')}:3:25)`])
  })

  test('lowers object destructuring declarations to property reads', () => {
    const report = analyzeSource('destructure.ts', `
      type Spring = {pos: number; dest: number}
      export function gap(config: Spring): number {
        const {pos, dest: destination} = config
        return Math.abs(destination - pos)
      }
    `)
    const fn = analyzedFunction(report, 'gap')
    expect(fn.assumptions).toEqual(['config.pos is finite and not NaN', 'config.dest is finite and not NaN'])
    expect(fn.ensures).toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${resolve('destructure.ts')}:5:25)`])
  })

  test('a returned fresh record prints its full contract', () => {
    // The immutable twin of a mutating state update: every property of the returned record
    // prints, including the exact reset, where the mutating version could only describe
    // what it wrote.
    const report = analyzeSource('fresh-record.ts', `
      type Spring = {pos: number; dest: number; v: number}
      export function goToEnd(config: Spring): Spring {
        return {pos: config.dest, dest: config.dest, v: 0}
      }
    `)
    expect(analyzedFunction(report, 'goToEnd').ensures).toEqual([
      'return.pos is a finite number',
      'return.dest is a finite number',
      'return.v is a finite integer number from 0 through 0',
    ])
  })

  test('the global Infinity is an exact constant, not an unknown identifier', () => {
    // `-Infinity` must fold to one constant at lowering: lowered as `0 - Infinity` it would
    // collapse to unknown-including-NaN (interval arithmetic gives up on non-finite
    // operands), and no clamp recovers a possibly-NaN value. With the fold, the clamp
    // recovers an exact range. A local named Infinity shadows the global, same defense as
    // the Math dispatch.
    const report = analyzeSource('infinity.ts', `
      export function clampFromBelow(): number {
        const floor = -Infinity
        return Math.max(0, Math.min(floor, 100))
      }
      export function unbounded(): number {
        return Infinity
      }
      export function shadowed(): number {
        const Infinity = 5
        return Infinity
      }
    `)
    expect(analyzedFunction(report, 'clampFromBelow').ensures).toEqual(['return is a finite number from 0 through 0'])
    expect(analyzedFunction(report, 'unbounded').ensures).toEqual(['return is a possibly non-finite number from Infinity through Infinity'])
    expect(analyzedFunction(report, 'shadowed').ensures).toEqual(['return is a finite integer number from 5 through 5'])
  })

  test('publishes module values past skipped top-level statements and demotes what they write', () => {
    const report = analyzeSource('module-skip.ts', `
      const gap = 24
      window.addEventListener('resize', () => {})
      let after = 5
      let poked = 10
      document.title = String(poked = 20)
      export function readGap(): number { return gap }
      export function readAfter(): number { return after }
      export function readPoked(): number { return poked }
    `)
    const file = resolve('module-skip.ts')
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      stopped: [],
      skipped: [
        `function call window.addEventListener at ${file}:3:7`,
        `a write into an object (values are immutable; rebind a variable to a fresh object instead) at ${file}:6:7`,
      ],
      observed: [],
    })
    // Bindings around the skipped statements still publish exactly...
    expect(analyzedFunction(report, 'readGap').ensures)
      .toEqual(['return is a finite integer number from 24 through 24'])
    expect(analyzedFunction(report, 'readAfter').ensures)
      .toEqual(['return is a finite integer number from 5 through 5'])
    // ...but a binding the skipped statement writes keeps only its declared kind.
    const poked = analyzedFunction(report, 'readPoked')
    expect(poked.assumptions).toEqual(['poked is finite and not NaN'])
    expect(poked.ensures).toEqual(['return is a finite number'])
  })

  test('does not launder stale values through statements after a skip', () => {
    // The skip demotes scale, but without a slot reset the initializer would keep
    // computing with the stale 1, publishing doubled as exactly 2 while runtime says 6.
    // The havoc at the skip point resets the slot to a truly covering value — NaN
    // included, since the skipped code could have computed anything (e.g.
    // Number.parseFloat) and `doubled` publishes with no assumes line to carry a
    // finiteness condition.
    const report = analyzeSource('module-launder.ts', `
      let scale = 1
      scale = Math.hypot(3, 4)
      const doubled = scale * 2
      export function getDoubled(): number { return doubled }
    `)
    expect(analyzedFunction(report, 'getDoubled').ensures)
      .toEqual(['return is a possibly NaN number from -Infinity through Infinity'])
  })

  test('reports exact boolean constants as true or false', () => {
    const report = analyzeSource('boolean-exact.ts', `
      const featureOn = false
      export function isOn(): boolean { return featureOn }
    `)
    expect(analyzedFunction(report, 'isOn').ensures).toEqual(['return is false'])
  })

  test('a clamp recovers a finite range from a possibly overflowed input', () => {
    // min and max are exact on infinities, so the clamp bounds survive even though v * 2
    // can overflow; NaN would not be recovered, but doubling a finite value cannot produce
    // one.
    const report = analyzeSource('clamp-recovery.ts', `
      export function opacity(v: number): number {
        return Math.max(0, Math.min(v * 2, 100))
      }
    `)
    expect(analyzedFunction(report, 'opacity').ensures)
      .toEqual(['return is a finite number from 0 through 100'])
  })

  test('divisions consumed only by comparisons need no requirement', () => {
    // A NaN or Infinity quotient just makes the comparison true or false, which the
    // boolean domain covers; the non-finiteness cannot reach a return value or a write.
    const report = analyzeSource('compare-only.ts', `
      export function threshold(a: number, b: number): number {
        return a / b > 5 ? 1 : 0
      }
      export function propertyGuard(grid: {cols: number}, w: number): number {
        if (w / grid.cols > 5) return 1
        return 0
      }
    `)
    const threshold = analyzedFunction(report, 'threshold')
    expect(threshold.requires).toEqual([])
    expect(threshold.ensures).toEqual(['return is a finite integer number from 0 through 1'])
    const guard = analyzedFunction(report, 'propertyGuard')
    expect(guard.requires).toEqual([])
    expect(guard.ensures).toEqual(['return is a finite integer number from 0 through 1'])
  })

  test('a floored divisor mints a requirement and a finite quotient', () => {
    // Math.floor is now nameable in requirements, and a floored divisor is an integer, so
    // under the nonzero requirement its magnitude is at least 1 and the quotient is finite.
    const report = analyzeSource('floor-divisor.ts', `
      export function perColumn(width: number, cols: number): number {
        return width / Math.floor(cols)
      }
    `)
    const fn = analyzedFunction(report, 'perColumn')
    expect(fn.requires).toEqual([`Math.floor(cols) is nonzero (division at ${resolve('floor-divisor.ts')}:3:16)`])
    expect(fn.ensures).toEqual(['return is a finite number'])
  })

  test('platform catalog entries give DOM reads real ranges', () => {
    const report = analyzeSource('platform.ts', `
      export function columnsForViewport(): number {
        const width = document.documentElement.clientWidth
        return Math.max(1, Math.min(7, Math.floor((width - 24) / 244)))
      }
      export function frameBudgetUsed(startMs: number): number {
        return Math.max(0, performance.now() - startMs)
      }
    `)
    // No parameters at all: the 1..7 range is proven entirely from clientWidth's catalog
    // entry (a nonnegative integer).
    expect(analyzedFunction(report, 'columnsForViewport').ensures)
      .toEqual(['return is a finite integer number from 1 through 7'])
    expect(analyzedFunction(report, 'frameBudgetUsed').ensures)
      .toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${resolve('platform.ts')}:7:28)`])
  })

  test('a possibly NaN value keeps the comparison branch NaN takes at runtime', () => {
    // v * 2 - v * 3 can be Infinity - Infinity = NaN; the clamp carries NaN through, and
    // NaN > -1 is false, so the 0 arm is reachable. Interval refinement alone would call
    // the false branch empty ([0,100] refined by <= -1) and wrongly prove the return is 1.
    const report = analyzeSource('nan-branch.ts', `
      export function clampedBranch(v: number): number {
        const x = Math.max(0, Math.min(v * 2 - v * 3, 100))
        return x > -1 ? 1 : 0
      }
    `)
    expect(analyzedFunction(report, 'clampedBranch').ensures)
      .toEqual(['return is a finite integer number from 0 through 1'])
  })

  test('a refinement that clips to finite bounds also proves finiteness', () => {
    // a * b can overflow, but Infinity fails x < 100, so inside both guards the value is
    // genuinely finite — the wording must not say "possibly non-finite from 0 through 100".
    const report = analyzeSource('finite-narrow.ts', `
      export function narrowed(a: number, b: number): number {
        const x = a * b
        if (x > 0) { if (x < 100) return x }
        return 0
      }
    `)
    // `x < 100` proves less-than: the exact upper bound is the double just below 100,
    // and the prose says so instead of over-covering with 'through 100'.
    expect(analyzedFunction(report, 'narrowed').ensures)
      .toEqual(['return is a finite number at least 0 and less than 100'])
  })

  test('rejects assignments used as values inside larger expressions', () => {
    // Assignments lower only in statement position, so ternary and logical arms are
    // provably assignment-free and their join carries exactly the result. Statement-level
    // if/else assignment stays fully supported.
    const report = analyzeSource('value-assign.ts', `
      export function golf(width: number): number {
        let x = 0
        return width > 5 ? (x = 1) : 2
      }
      export function statement(width: number): number {
        let result = 10
        if (width > 10) result = width
        return result
      }
    `)
    const file = resolve('value-assign.ts')
    expect(report.functions.find(fn => fn.name === 'golf')).toEqual({
      kind: 'unsupported',
      name: 'golf',
      unsupported: `an assignment used as a value (write it as its own statement) at ${file}:4:29`,
    })
    expect(analyzedFunction(report, 'statement').ensures)
      .toEqual(['return is a finite number at least 10'])
  })

  test('object spread reads the source shape with later entries overriding', () => {
    // The update idiom of the immutable subset: rebuild with spread, override what changed.
    const report = analyzeSource('spread.ts', `
      type Spring = {pos: number; dest: number; v: number}
      export function settle(s: Spring): Spring {
        return {...s, pos: s.dest, v: 0}
      }
      export function merged(a: {x: number}, b: {x: number; y: number}): number {
        const both = {...a, ...b}
        return Math.min(both.x, both.y)
      }
    `)
    expect(analyzedFunction(report, 'settle').ensures).toEqual([
      'return.pos is a finite number',
      'return.dest is a finite number',
      'return.v is a finite integer number from 0 through 0',
    ])
    // The second spread rejects: at runtime it also copies properties b's type never
    // names, which could override entries from a.
    const mergedFn = report.functions.find(candidate => candidate.name === 'merged')
    expect(mergedFn?.kind).toBe('unsupported')
    expect(formatReport(report)).toContain('a spread after other entries (the spread value can carry extra properties that override earlier entries at runtime; write the spread first, then override with explicit properties)')
  })

  test('carries a module read assumption to callers of the reading function', () => {
    const report = analyzeSource('module-assumption-chain.ts', `
      let scaleFactor = 2
      export function bumpScale(): void {
        scaleFactor = scaleFactor + 1
      }
      function currentScale(): number {
        return scaleFactor
      }
      export function scaledUp(): number {
        return Math.max(1, currentScale())
      }
    `)
    // scaledUp never reads scaleFactor itself, but its result rests on currentScale's
    // assumed-finite read; without the line its ensures would overclaim finiteness.
    const caller = analyzedFunction(report, 'scaledUp')
    expect(caller.assumptions).toEqual(['scaleFactor is finite and not NaN'])
    expect(caller.ensures).toEqual(['return is a finite number at least 1'])
  })

  test('stops reads of imported bindings', () => {
    const importsFixture = new URL('./fixtures/module-imports.ts', import.meta.url).pathname
    const report = analyzeFile(importsFixture)
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'paddedBy',
      assumptions: ['width is finite and not NaN'],
      stopped: [`reads importedPad, which is imported from another module (read at ${importsFixture}:4:31)`],
      observed: [],
    }])
  })

  test('converges on a numeric for loop without unrolling it', () => {
    const report = analyzeSource('numeric-loop.ts', `
      function increment(state: {value: number}): {value: number} {
        return {value: state.value + 1}
      }

      export function iterationsBeforeLimit(limit: number): number {
        let iteration = 0
        for (; iteration < limit; iteration += 1) {}
        return iteration
      }

      export function updatesBeforeLimit(limit: number): number {
        let state = {value: 0}
        for (let iteration = 0; iteration < limit; iteration++) state = increment(state)
        return state.value
      }
    `)
    expect(analyzedFunction(report, 'iterationsBeforeLimit').ensures)
      .toEqual(['return is a finite integer number at least 0'])
    expect(analyzedFunction(report, 'updatesBeforeLimit').ensures)
      .toEqual(['return is a finite integer number at least 0'])
  })
})
