import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {analyzeFile, analyzeSource, formatReport} from '../src/index.ts'

const fixture = new URL('./fixtures/grid-metrics.ts', import.meta.url).pathname
const mutationFixture = new URL('./fixtures/object-mutation.ts', import.meta.url).pathname
const preconditionsFixture = new URL('./fixtures/preconditions.ts', import.meta.url).pathname

describe('analyzeFile', () => {
  test('reports inferred properties of a returned object', () => {
    const report = analyzeFile(fixture)
    const fn = report.functions.find(candidate => candidate.name === 'calculateGridMetrics')
    expect(fn?.name).toBe('calculateGridMetrics')
    expect(fn?.assumptions).toEqual(['containerWidth is finite and not NaN'])
    expect(fn?.ensures).toEqual([
      'return.columnCount is a finite integer number from 1 through 7',
      'return.maximumBoxWidth is a finite number at least 1',
    ])
    expect(formatReport(report)).toContain('ensures: return.maximumBoxWidth is a finite number at least 1')

    const consumer = report.functions.find(candidate => candidate.name === 'maximumBoxWidthForContainer')
    expect(consumer?.ensures).toEqual(['return is a finite number at least 1'])
  })

  test('degrades the inferred result when a divisor may be zero', () => {
    const source = readFileSync(fixture, 'utf8').replace('/ columnCount', '/ containerWidth')
    const report = analyzeSource('unsafe-grid-metrics.ts', source)
    const fn = report.functions.find(candidate => candidate.name === 'calculateGridMetrics')
    expect(fn?.requires).toEqual(['containerWidth is nonzero'])
    expect(fn?.ensures).toContain('return.maximumBoxWidth is a possibly non-finite number from -Infinity through Infinity')
  })

  test('rejects TypeScript type errors before lowering', () => {
    expect(() => analyzeSource('invalid.ts', `
      export function invalidWidth(containerWidth: string): number {
        return containerWidth
      }
    `)).toThrow('TypeScript: Type \'string\' is not assignable to type \'number\'.')
  })

  test('does not confuse a shadowed Math object with the standard library', () => {
    expect(() => analyzeSource('shadowed-math.ts', `
      const Math = {max: (left: number, _right: number): number => left}
      export function chooseWidth(containerWidth: number): number {
        return Math.max(1, containerWidth)
      }
    `)).toThrow('Unsupported Function call Math.max')
  })

  test('carries a property write through an alias and local function call', () => {
    const report = analyzeFile(mutationFixture)
    const fn = report.functions.find(candidate => candidate.name === 'destinationAfterUpdate')
    expect(fn?.assumptions).toEqual(['containerWidth is finite and not NaN'])
    expect(fn?.ensures).toEqual(['return is a finite number at least 1'])

    const unrelated = report.functions.find(candidate => candidate.name === 'unrelatedDestinationStaysUnchanged')
    expect(unrelated?.ensures).toEqual(['return is a finite integer number from 0 through 0'])
  })

  test('infers, propagates, and discharges nonzero preconditions', () => {
    const report = analyzeFile(preconditionsFixture)
    expect(report.functions.find(fn => fn.name === 'divideWidth')?.requires)
      .toEqual(['columnCount is nonzero'])
    expect(report.functions.find(fn => fn.name === 'divideThroughCaller')?.requires)
      .toEqual(['columnCount is nonzero'])
    expect(report.functions.find(fn => fn.name === 'divideThroughTwoCallers')?.requires)
      .toEqual(['columnCount is nonzero'])
    expect(report.functions.find(fn => fn.name === 'divideAfterGap')?.requires)
      .toEqual(['(width - gap) is nonzero'])

    const provedCall = report.functions.find(fn => fn.name === 'divideByClampedColumnCount')
    expect(provedCall?.requires).toEqual([])
    expect(provedCall?.ensures).toEqual(['return is a finite number'])
  })

  test('merges a conditional value before later arithmetic', () => {
    const report = analyzeSource('conditional-value.ts', `
      export function paddedWidth(width: number): number {
        const nonnegativeWidth = width >= 0 ? width : 0
        return nonnegativeWidth + 24
      }
    `)
    expect(report.functions[0]?.ensures).toEqual(['return is a finite number at least 24'])
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
    expect(report.functions.find(fn => fn.name === 'minimumWidth')?.ensures)
      .toEqual(['return is a finite number at least 10'])
    expect(report.functions.find(fn => fn.name === 'nonnegativeWidth')?.ensures)
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
    expect(report.functions.find(fn => fn.name === 'iterationsBeforeLimit')?.ensures)
      .toEqual(['return is a finite integer number at least 0'])
    expect(report.functions.find(fn => fn.name === 'updatesBeforeLimit')?.ensures)
      .toEqual(['return is a finite integer number at least 0'])
  })
})
