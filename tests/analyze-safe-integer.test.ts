import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

describe('Number.isSafeInteger', () => {
  test('the safe-integer guard discharges an asserted array read, like isInteger', () => {
    const report = analyzeSource('safe-bounds.ts', `
      export function safeAt(sizes: number[], slot: number): number {
        if (Number.isSafeInteger(slot) && slot >= 0 && slot < sizes.length) {
          return sizes[slot]!
        }
        return 0
      }
    `)
    // Number.isSafeInteger implies integrality, so the true branch proves the read: no requires line.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'safeAt'))).toEqual([])
  })

  test('a leading console.assert(Number.isSafeInteger(x)) becomes a caller requirement', () => {
    const report = analyzeSource('safe-contract.ts', `
      export function explicitSafeInteger(value: number): number {
        console.assert(Number.isSafeInteger(value))
        return value
      }
    `)
    const requires = requirementsBesidesInputFiniteness(analyzedFunction(report, 'explicitSafeInteger'))
    expect(requires).toHaveLength(1)
    expect(requires[0]).toContain('Number.isSafeInteger(value)')
  })
})
