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
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'chooseWidth',
      unsupported: `function call Math.max at ${resolve('shadowed-math.ts')}:4:16`,
    }])
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

  test('records an unjoinable allocation in a loop and suppresses post-loop evidence', () => {
    const report = analyzeSource('loop-allocation.ts', `
      export function totalHeight(rowCount: number): number {
        let metrics = {height: 0}
        for (let row = 0; row < rowCount; row += 1) {
          metrics = {height: metrics.height + 1}
        }
        return metrics.height
      }
    `)
    const file = resolve('loop-allocation.ts')
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'totalHeight',
      assumptions: ['rowCount is finite and not NaN'],
      stopped: [`cannot merge the object created at ${file}:3:23 with the object created at ${file}:5:21 (loop at ${file}:4:9)`],
      observed: [],
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
      stopped: [`calls divideWidth, whose analysis stopped for these arguments (call at ${file}:6:16)`],
      observed: [],
    })
  })

  test('keeps a pre-loop return when the loop itself does not converge', () => {
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
    const file = resolve('loop-limit.ts')
    const guarded = report.functions.find(fn => fn.name === 'guarded')
    expect(guarded).toEqual({
      kind: 'partial',
      name: 'guarded',
      assumptions: ['limit is finite and not NaN'],
      stopped: [`the loop at ${file}:9:9 did not converge after 16 updates`],
      observed: ['return is a finite integer number from -1 through -1'],
    })
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
