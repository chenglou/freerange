import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {analyzeFile, analyzeSource, formatReport} from '../src/index.ts'

const fixture = new URL('./fixtures/grid-metrics.ts', import.meta.url).pathname

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
    expect(fn?.obligations.every(obligation => obligation.status === 'proved')).toBe(true)
    expect(formatReport(report)).toContain('ensures: return.maximumBoxWidth is a finite number at least 1')
  })

  test('keeps an unsafe divisor unresolved through the same lowering path', () => {
    const source = readFileSync(fixture, 'utf8').replace('/ columnCount', '/ containerWidth')
    const report = analyzeSource('unsafe-grid-metrics.ts', source)
    const obligations = report.functions.find(candidate => candidate.name === 'calculateGridMetrics')?.obligations ?? []
    expect(obligations.some(obligation => obligation.kind === 'nonzero-divisor' && obligation.status === 'unknown')).toBe(true)
    expect(obligations.some(obligation => obligation.kind === 'finite-result' && obligation.status === 'unknown')).toBe(true)
  })
})
