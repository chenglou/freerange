import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {analyzeFile, analyzeSource, formatReport, type AnalysisReport} from '../src/index.ts'

const fixture = new URL('./fixtures/grid-metrics.ts', import.meta.url).pathname
const mutationFixture = new URL('./fixtures/object-mutation.ts', import.meta.url).pathname
const preconditionsFixture = new URL('./fixtures/preconditions.ts', import.meta.url).pathname

function analyzedFunction(report: AnalysisReport, name: string) {
  const fn = report.functions.find(candidate => candidate.name === name)
  if (fn == null || fn.kind !== 'analyzed') throw new Error(`Expected ${name} to be analyzed`)
  return fn
}

describe('analyzeFile', () => {
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
        return width % 2
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
        unsupported: `binary operator % at ${file}:6:16`,
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
        unsupported: `call to scaled with fewer arguments than parameters at ${file}:6:16`,
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
        return width % 2
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
        unsupported: `binary operator % at ${file}:9:16`,
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

  test('converges when a loop rebinds a fresh object each iteration', () => {
    const report = analyzeSource('loop-allocation.ts', `
      export function totalHeight(rowCount: number): number {
        let metrics = {height: 0}
        for (let row = 0; row < rowCount; row += 1) {
          metrics = {height: metrics.height + 1}
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

  test('joins a write into every target of a branch-merged reference', () => {
    const report = analyzeSource('weak-write.ts', `
      export function pick(flag: number): number {
        const box = flag > 0 ? {value: 1} : {value: 2}
        box.value = 5
        return box.value
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures)
      .toEqual(['return is a finite integer number from 1 through 5'])
  })

  test('keeps objects from different call sites distinct', () => {
    const report = analyzeSource('double-call.ts', `
      function makeBox(): {value: number} {
        return {value: 1}
      }
      export function distinct(): number {
        const first = makeBox()
        const second = makeBox()
        second.value = 7
        return first.value
      }
    `)
    expect(analyzedFunction(report, 'distinct').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
  })

  test('keeps per-iteration precision on the freshest object', () => {
    // Recency: within one iteration the fresh object takes strong updates, so the loop body
    // reproduces an exact state each round and the header converges without widening `last`.
    const report = analyzeSource('recency.ts', `
      export function lastHeight(count: number): number {
        let last = 0
        for (let index = 0; index < count; index += 1) {
          const point = {x: 1}
          point.x = point.x + 1
          last = point.x
        }
        return last
      }
    `)
    expect(analyzedFunction(report, 'lastHeight').ensures)
      .toEqual(['return is a finite integer number from 0 through 2'])
  })

  test('repairs a caller reference when a callee displaces its object', () => {
    // The loop re-executes makeBox from one call site; each round displaces the previous
    // object into the site's summary, and the caller's `first` reference — created at a
    // different call site — must stay exactly 1 throughout.
    const report = analyzeSource('adoption.ts', `
      function makeBox(): {value: number} {
        return {value: 1}
      }
      export function loopBoxes(count: number): number {
        const first = makeBox()
        let last = 0
        for (let index = 0; index < count; index += 1) {
          const box = makeBox()
          box.value = box.value + 1
          last = box.value
        }
        return first.value + last
      }
    `)
    expect(analyzedFunction(report, 'loopBoxes').ensures)
      .toEqual(['return is a finite integer number from 1 through 3'])
  })

  test('merges branch results whose branches allocate different objects', () => {
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

  test('records optional-property access as unsupported but keeps shared-property reads', () => {
    const gated = analyzeSource('optional-read.ts', `
      type Box = {x: number; y?: number}
      export function pick(flag: number): number {
        let box: Box = {x: 1}
        if (flag > 0) { box = {x: 2, y: 3} }
        const maybe = box.y
        return box.x
      }
    `)
    const file = resolve('optional-read.ts')
    expect(gated.functions).toEqual([{
      kind: 'unsupported',
      name: 'pick',
      unsupported: `value of type number | undefined at ${file}:6:23`,
    }])

    const benign = analyzeSource('optional-benign.ts', `
      type Box = {x: number; y?: number}
      export function shared(flag: number): number {
        let box: Box = {x: 1}
        if (flag > 0) { box = {x: 2, y: 3} }
        return box.x
      }
    `)
    expect(analyzedFunction(benign, 'shared').ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
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
      unsupported: `value of type { x: number; y?: undefined; } | { x: number; y: number; } at ${file}:2:7`,
    }])
  })

  test('stops a division whose requirement cannot name a property read', () => {
    const report = analyzeSource('property-divisor.ts', `
      export function widthPerColumn(grid: {columnCount: number}, width: number): number {
        return width / grid.columnCount
      }
    `)
    const file = resolve('property-divisor.ts')
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'widthPerColumn',
      assumptions: ['grid.columnCount is finite and not NaN', 'width is finite and not NaN'],
      stopped: [`cannot infer a nonzero requirement for the division at ${file}:3:16`],
      observed: [],
    }])
  })

  test('reports a callee that stops only under this caller’s arguments', () => {
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
    const caller = report.functions.find(fn => fn.name === 'divideByGridColumns')
    expect(caller).toEqual({
      kind: 'partial',
      name: 'divideByGridColumns',
      assumptions: ['grid.columnCount is finite and not NaN', 'width is finite and not NaN'],
      stopped: [`calls divideWidth, whose analysis stopped for this specific call (call at ${file}:6:16)`],
      observed: [],
    })
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

  test('does not analyze caller statements past a stopped call or leak callee mutations', () => {
    const report = analyzeSource('no-leak.ts', `
      function poison(box: {value: number}): void {
        box.value = 0
        oops(box.value)
      }
      function oops(value: number): number {
        return value % 2
      }
      export function readAfterCall(box: {value: number}): number {
        poison(box)
        return box.value
      }
    `)
    const file = resolve('no-leak.ts')
    const caller = report.functions.find(fn => fn.name === 'readAfterCall')
    // If evaluation continued past the stopped call, observed would show the mutated
    // return value 0 through 0. It must show nothing: the path stopped at the call.
    expect(caller).toEqual({
      kind: 'partial',
      name: 'readAfterCall',
      assumptions: ['box.value is finite and not NaN'],
      stopped: [`calls poison, whose analysis stopped (call at ${file}:10:9)`],
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
      {kind: 'unsupported', name: 'truthy', unsupported: `condition of type number at ${file}:3:13`},
      {kind: 'unsupported', name: 'mixedTernary', unsupported: `value of type number | boolean at ${file}:7:22`},
      {kind: 'unsupported', name: 'mixedReturns', unsupported: `value of type number | boolean at ${file}:10:7`},
    ])
  })

  test('records mixed-kind local declarations as unsupported, keeping single-kind unions analyzable', () => {
    // Before the declarator gate, unknownLocal crashed the engine at the block join
    // ('Cannot join boolean and number'): the declaration lowered without checking that the
    // declared type holds a single value kind, so the branch rebinding u to a boolean met
    // the number initializer at the join.
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
    expect(report.functions.filter(fn => fn.kind === 'unsupported')).toEqual([
      {kind: 'unsupported', name: 'unknownLocal', unsupported: `value of type unknown at ${file}:3:16`},
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
        return value % 2
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
    expect(formatted).not.toContain('ensures:')
    expect(formatted).not.toContain('requires:')
  })

  test('carries a property write through an alias and local function call', () => {
    const report = analyzeFile(mutationFixture)
    const fn = analyzedFunction(report, 'destinationAfterUpdate')
    expect(fn.assumptions).toEqual(['containerWidth is finite and not NaN'])
    expect(fn.ensures).toEqual(['return is a finite number at least 1'])

    const unrelated = analyzedFunction(report, 'unrelatedDestinationStaysUnchanged')
    expect(unrelated.ensures).toEqual(['return is a finite integer number from 0 through 0'])
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
        return 1 % 2
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
      unsupported: `a type assertion to number at ${file}:5:19`,
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
        unsupported: `a value typed any at ${file}:3:15`,
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
        unsupported: `a value typed any at ${file}:11:15`,
      },
      {
        kind: 'unsupported',
        name: 'laundersReturn',
        unsupported: `a value typed any at ${file}:15:15`,
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

  test('prints writes to object parameters as ensures lines', () => {
    // A void function's whole contract is its writes; properties still holding the entry
    // assumption stay silent, so only the reset shows.
    const report = analyzeSource('param-writes.ts', `
      type Spring = {pos: number; dest: number; v: number}
      export function goToEnd(config: Spring): void {
        config.pos = config.dest
        config.v = 0
      }
    `)
    expect(analyzedFunction(report, 'goToEnd').ensures)
      .toEqual(['config.v is a finite integer number from 0 through 0'])
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
        `value of type string at ${file}:6:7`,
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
    // The havoc at the skip point makes later statements compute from covering values.
    const report = analyzeSource('module-launder.ts', `
      let scale = 1
      scale = Math.sqrt(9)
      const doubled = scale * 2
      export function getDoubled(): number { return doubled }
    `)
    expect(analyzedFunction(report, 'getDoubled').ensures)
      .toEqual([`return is a possibly non-finite number from -Infinity through Infinity (can overflow at ${resolve('module-launder.ts')}:4:23)`])
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
    expect(analyzedFunction(report, 'narrowed').ensures)
      .toEqual(['return is a finite number from 0 through 100'])
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
      function increment(state: {value: number}): void {
        state.value = state.value + 1
      }

      export function iterationsBeforeLimit(limit: number): number {
        let iteration = 0
        for (; iteration < limit; iteration += 1) {}
        return iteration
      }

      export function updatesBeforeLimit(limit: number): number {
        const state = {value: 0}
        for (let iteration = 0; iteration < limit; iteration++) increment(state)
        return state.value
      }
    `)
    expect(analyzedFunction(report, 'iterationsBeforeLimit').ensures)
      .toEqual(['return is a finite integer number at least 0'])
    expect(analyzedFunction(report, 'updatesBeforeLimit').ensures)
      .toEqual(['return is a finite integer number at least 0'])
  })
})
