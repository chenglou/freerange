import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {analyzeFile, analyzeSource, formatReport} from '../src/index.ts'

const fixture = new URL('./fixtures/columns.ts', import.meta.url).pathname

describe('analyzeFile', () => {
  test('reports the inferred column range', () => {
    const report = analyzeFile(fixture)
    const fn = report.functions.find(candidate => candidate.name === 'columnsForWidth')
    expect(fn?.name).toBe('columnsForWidth')
    expect(fn?.assumptions).toEqual(['containerWidth is finite and not NaN'])
    expect(fn?.ensures).toEqual(['return is a finite integer number from 1 through 7'])
    expect(fn?.obligations.every(obligation => obligation.status === 'proved')).toBe(true)
    expect(formatReport(report)).toContain('ensures: return is a finite integer number from 1 through 7')
  })

  test('keeps an unsafe divisor unresolved through the same lowering path', () => {
    const source = readFileSync(fixture, 'utf8').replace('/ 244', '/ containerWidth')
    const report = analyzeSource('unsafe-columns.ts', source)
    const obligations = report.functions.find(candidate => candidate.name === 'columnsForWidth')?.obligations ?? []
    expect(obligations.some(obligation => obligation.kind === 'nonzero-divisor' && obligation.status === 'unknown')).toBe(true)
    expect(obligations.some(obligation => obligation.kind === 'finite-result' && obligation.status === 'unknown')).toBe(true)
  })
})
