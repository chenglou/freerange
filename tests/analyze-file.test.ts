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
})
