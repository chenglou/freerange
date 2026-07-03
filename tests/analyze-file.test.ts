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
    expect(fn.ensures).toContain('return.maximumBoxWidth is a possibly non-finite number from -Infinity through Infinity')
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
      // The shadowing declaration itself is top-level code: its arrow function stops the
      // module initializer's lowering.
      {
        kind: 'partial',
        name: 'module initialization',
        assumptions: [],
        stopped: [`expression (ArrowFunction) at ${resolve('shadowed-math.ts')}:2:26`],
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

  test('a direct eval call poisons let bindings but not const', () => {
    const source = `
      let mutableWidth = 3
      const fixedHeight = 4
      export function readWidth(): number {
        return mutableWidth
      }
      export function readHeight(): number {
        return fixedHeight
      }
      function poke(): void {
        eval("mutableWidth = 99")
      }
    `
    const report = analyzeSource('module-eval.ts', source)
    const file = resolve('module-eval.ts')
    // eval can assign a value of ANY type to any let binding through a string no scanner or
    // type checker reads, so reads of poisoned bindings stop instead of trusting even the
    // declared kind. const is immune: assigning a const throws even inside eval.
    expect(report.functions.find(fn => fn.name === 'readWidth')).toEqual({
      kind: 'partial',
      name: 'readWidth',
      assumptions: [],
      stopped: [`reads mutableWidth, whose value the analysis does not track (read at ${file}:5:16)`],
      observed: [],
    })
    const height = analyzedFunction(report, 'readHeight')
    expect(height.assumptions).toEqual([])
    expect(height.ensures).toEqual(['return is a finite integer number from 4 through 4'])

    // Parenthesized and TS-wrapped spellings are still direct eval — parentheses preserve
    // the reference, and `!`/`as` erase to nothing in the emitted JavaScript.
    for (const spelling of ['(eval)("mutableWidth = 99")', 'eval!("mutableWidth = 99")', '(eval as any)("mutableWidth = 99")']) {
      const wrapped = analyzeSource('module-eval-wrapped.ts', source.replace('eval("mutableWidth = 99")', spelling))
      expect(wrapped.functions.find(fn => fn.name === 'readWidth')?.kind).toBe('partial')
    }
  })

  test('a direct eval call stops calls through function bindings', () => {
    // eval can also reassign a top-level function binding at runtime; TypeScript's static
    // no-reassignment check does not see into the eval string. The functions' own entries
    // stay, but calls resolved through the bindings stop.
    const report = analyzeSource('module-eval-call.ts', `
      export function helper(width: number): number {
        return width + 1
      }
      export function caller(width: number): number {
        return helper(width)
      }
      function poke(): void {
        eval("helper = (width) => width - 1")
      }
    `)
    const file = resolve('module-eval-call.ts')
    expect(analyzedFunction(report, 'helper').ensures).toEqual(['return is a finite number'])
    expect(report.functions.find(fn => fn.name === 'caller')).toEqual({
      kind: 'unsupported',
      name: 'caller',
      unsupported: `a direct eval call in this file can reassign function bindings, so this call target cannot be trusted at ${file}:6:16`,
    })
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

  test('routes a hoisted var write in a nested top-level block to the module slot', () => {
    // `var` hoists to module scope, so the nested redeclaration writes the same binding;
    // lowering it as a block-local would publish the stale 1. isDouble returns exactly
    // true, so the branch always runs and the published value is exactly 2.
    const report = analyzeSource('module-nested-var.ts', `
      var mode = 1
      if (isDouble()) {
        var mode = 2
      }
      export function currentMode(): number {
        return mode
      }
      function isDouble(): boolean {
        return true
      }
    `)
    expect(analyzedFunction(report, 'currentMode').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])
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

  test('does not trust a declared kind that direct eval can falsify', () => {
    // eval runs before the const initializes and can reassign pick to return anything, so
    // even "flag is some boolean" would overclaim; the binding is fully untracked.
    const report = analyzeSource('module-eval-const.ts', `
      function pick(): boolean { return true }
      eval("pick = () => 42")
      const flag = pick()
      export function readFlag(): boolean { return flag }
    `)
    const readFlag = report.functions.find(fn => fn.name === 'readFlag')
    expect(readFlag?.kind).toBe('partial')
    if (readFlag?.kind === 'partial') {
      expect(readFlag.stopped).toEqual([
        `reads flag, whose value the analysis does not track (read at ${resolve('module-eval-const.ts')}:5:52)`,
      ])
    }
  })

  test('records kind-changing type assertions as unsupported', () => {
    // `true as unknown as number` produces a boolean value in a number-typed position;
    // unchecked, the boolean lands in a number module slot and crashes the join.
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
    `)
    const file = resolve('module-assertion.ts')
    expect(report.functions.find(fn => fn.name === 'poke')).toEqual({
      kind: 'unsupported',
      name: 'poke',
      unsupported: `type assertion from unknown to number at ${file}:5:19`,
    })
    // The scan still counts the unanalyzed write, so count keeps only its declared kind.
    const reader = analyzedFunction(report, 'currentCount')
    expect(reader.assumptions).toEqual(['count is finite and not NaN'])
  })

  test('hedges boolean module reads whose writes TypeScript cannot vouch for', () => {
    // Assigning an any-typed value to a boolean binding type-checks, so "return is boolean"
    // must be conditional on the binding actually holding a boolean.
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

  test('carries a var redeclaration in a loop body across the back edge', () => {
    // The declarator writes the same function-scoped variable as the outer var; dropping it
    // from the loop-carried bindings reported exactly 1 while runtime returns 5.
    const report = analyzeSource('loop-var.ts', `
      export function lastWrite(count: number): number {
        var width = 1
        for (let index = 0; index < count; index++) {
          var width = 5
        }
        return width
      }
    `)
    expect(analyzedFunction(report, 'lastWrite').ensures)
      .toEqual(['return is a finite integer number from 1 through 5'])
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

  test('records shape-changing object assertions as unsupported', () => {
    // `{} as {missing: number}` is assignable one way, but the heap object has no such
    // property; reading or writing it crashed the engine before the shape check.
    const report = analyzeSource('shape-assertion.ts', `
      export function fake(): number {
        const box = {} as {missing: number}
        return box.missing + 1
      }
      export function pass(width: number): number {
        const sameShape = {value: width} as {value: number}
        return sameShape.value
      }
    `)
    const file = resolve('shape-assertion.ts')
    expect(report.functions).toEqual([
      {
        kind: 'unsupported',
        name: 'fake',
        unsupported: `type assertion from {} to { missing: number; } at ${file}:3:21`,
      },
      {
        kind: 'analyzed',
        name: 'pass',
        assumptions: ['width is finite and not NaN'],
        requires: [],
        ensures: ['return is a finite number'],
      },
    ])
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
