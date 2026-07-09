import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {analyzeFile, analyzeSource, formatReport} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

const fixture = new URL('./fixtures/grid-metrics.ts', import.meta.url).pathname
const showcaseFixture = new URL('./fixtures/showcase.ts', import.meta.url).pathname
const showcaseReportPath = 'tests/fixtures/showcase.ts'
const mutationFixture = new URL('./fixtures/object-mutation.ts', import.meta.url).pathname
const preconditionsFixture = new URL('./fixtures/preconditions.ts', import.meta.url).pathname
const preconditionsReportPath = 'tests/fixtures/preconditions.ts'

describe('control flow and contracts', () => {
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
      .toEqual([`grid.columnCount is nonzero (division at ${showcaseReportPath}:78:10)`])
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
    expect(fn.requires).toEqual([`containerWidth is nonzero (division at ${'unsafe-grid-metrics.ts'}:18:5)`])
    // Math.max(1, ...) keeps its lower bound through the possibly overflowed quotient —
    // min/max are exact on infinities — and the quotient under the nonzero requirement is
    // never NaN, so only overflow remains possible.
    // The blame suffix points at the division that introduced the overflow possibility.
    expect(fn.ensures).toContain(`return.maximumBoxWidth is a possibly non-finite number from 1 through Infinity (can overflow at ${'unsafe-grid-metrics.ts'}:18:5)`)
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
        skipped: [`expression (ArrowFunction) at ${'shadowed-math.ts'}:2:26`],
        observed: [],
      },
      {
        kind: 'unsupported',
        name: 'chooseWidth',
        unsupported: `function call Math.max at ${'shadowed-math.ts'}:4:16`,
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
    const file = 'unsupported-callee.ts'
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
    const file = 'default-parameter.ts'
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
    const file = 'two-hop.ts'
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
    const file = 'recursion.ts'
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
    const file = 'chain.ts'
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
    const file = 'property-write.ts'
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
    const file = 'mixed-shape.ts'
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
    const file = 'property-divisor.ts'
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
    const file = 'caller-specific.ts'
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

  test('an unnameable divisor records one nonzero assumption instead of stopping', () => {
    // The divisor is a loop-carried block parameter, outside the requirement language, so
    // no caller requirement exists. This used to stop the path with divisorUnknown and
    // lose everything downstream; it now records the assumption through the same channel
    // asserted element reads use, and the quotient computes over the divisor's range with
    // zero cut out — an integer nonzero divisor has magnitude at least 1, so the return
    // is genuinely finite GIVEN the assumes line. (At runtime step does reach 0 for
    // count >= 2; the violated assumption makes the claims vacuous, like any assumes.)
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
    const file = 'revisited-division.ts'
    const drain = analyzedFunction(report, 'drain')
    expect(drain.assumptions).toEqual([
      'count is finite and not NaN',
      `the divisor at ${file}:6:19 is nonzero`,
    ])
    expect(drain.ensures).toEqual(['return is a finite number'])
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
    const file = 'no-leak.ts'
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
    const file = 'gates.ts'
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
    const file = 'mixed-local.ts'
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
    const file = 'no-contract.ts'
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
    const divisionLocation = `(division at ${preconditionsReportPath}:6:10)`
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

})
