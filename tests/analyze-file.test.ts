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

  test('stops one function at unsupported code, skips its callers, and keeps analyzing the rest', () => {
    // scaledRemainder is declared before its failing callee: the skip is computed after the
    // whole file lowers, so declaration order does not matter.
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
        kind: 'skipped',
        name: 'scaledRemainder',
        skipped: `calls remainderWidth, which hit unsupported code (call at ${file}:3:16)`,
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

  test('names a merely skipped callee accurately in a transitive chain', () => {
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
        kind: 'skipped',
        name: 'outerWidth',
        skipped: `calls middleWidth, which was itself skipped (call at ${file}:3:16)`,
      },
      {
        kind: 'skipped',
        name: 'middleWidth',
        skipped: `calls remainderWidth, which hit unsupported code (call at ${file}:6:16)`,
      },
      {
        kind: 'unsupported',
        name: 'remainderWidth',
        unsupported: `binary operator % at ${file}:9:16`,
      },
    ])
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
