import {describe, expect, test} from 'bun:test'
import {verifyFitSource} from '../../src/reports.ts'
import {requiredCheck} from '../test-diagnostics.ts'

describe('Math numeric facts', () => {
  test('keeps finite rounding bounds without publishing false infinity bounds', () => {
    const checks = verifyFitSource('rounding-infinity.ts', `/** @fit
 * given value: Infinity
 * return.rounded > value - 1
 */
function floorInfinity(value: number) {
  return {rounded: Math.floor(value)}
}

/** @fit
 * given value: -Infinity
 * return.rounded < value + 1
 */
function ceilInfinity(value: number) {
  return {rounded: Math.ceil(value)}
}

/** @fit
 * given value: Infinity
 * return.rounded > value - 0.5
 */
function roundInfinity(value: number) {
  return {rounded: Math.round(value)}
}

/** @fit
 * given value: Infinity
 * return.rounded > value - 1
 */
function truncInfinity(value: number) {
  return {rounded: Math.trunc(value)}
}

/** @fit
 * given value: -10..10
 * return.rounded >= value - 1
 */
function floorFinite(value: number) {
  return {rounded: Math.floor(value)}
}

/** @fit
 * given value: -10..10
 * return.rounded <= value + 1
 */
function ceilFinite(value: number) {
  return {rounded: Math.ceil(value)}
}

/** @fit
 * given value: -10..10
 * return.rounded >= value - 0.5
 */
function roundFinite(value: number) {
  return {rounded: Math.round(value)}
}

/** @fit
 * given value: 0..10
 * return.rounded >= value - 1
 */
function truncFinite(value: number) {
  return {rounded: Math.trunc(value)}
}
`)

    const falseBounds = [
      requiredCheck(checks, {functionName: 'floorInfinity', text: 'return.rounded > value - 1'}),
      requiredCheck(checks, {functionName: 'ceilInfinity', text: 'return.rounded < value + 1'}),
      requiredCheck(checks, {functionName: 'roundInfinity', text: 'return.rounded > value - 0.5'}),
      requiredCheck(checks, {functionName: 'truncInfinity', text: 'return.rounded > value - 1'}),
    ]
    for (const check of falseBounds) {
      expect(check.status).toBe('fail')
      expect(check.trace?.usedFacts.some(fact =>
        fact.includes('inferred from code') && (fact.includes(' > value - ') || fact.includes(' < value + '))),
      ).toBe(false)
    }

    for (const functionName of ['floorFinite', 'ceilFinite', 'roundFinite', 'truncFinite']) {
      const check = checks.find(candidate => candidate.functionName === functionName)
      expect(check?.status).toBe('pass')
    }
  })
})
