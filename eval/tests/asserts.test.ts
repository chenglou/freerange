import {expect, test} from 'bun:test'
import {extractAssertSites, instrumentForRuntime} from '../lib/asserts.ts'

const source = `function clampWidth(width: number, max: number) {
  console.assert(width >= 0)
  console.assert(max >= 0)
  const clamped = Math.min(width, max)
  console.assert(clamped <= max)
  console.assert(clamped <= max)
  return clamped
}

export const layout = (items: number[]) => {
  const total = items.reduce((sum, item) => {
    console.assert(item >= 0)
    return sum + item
  }, 0)
  console.assert(
    total >= 0
  )
  return total
}

class Virtualizer {
  scrollOffset = 0
  getTotalSize() {
    console.assert(this.scrollOffset >= 0)
    return this.scrollOffset
  }
  scrollToOffset = (offset: number) => {
    console.assert(offset >= 0 || this.scrollOffset === 0)
  }
}
`

test('classifies leading requirements, interior assertions, callbacks and class members', () => {
  const sites = extractAssertSites('src/sample.ts', source)
  expect(sites.map(site => [site.line, site.role, site.owner])).toEqual([
    [2, 'requirement', 'clampWidth'],
    [3, 'requirement', 'clampWidth'],
    [5, 'assertion', 'clampWidth'],
    [6, 'assertion', 'clampWidth'],
    [12, 'outside', 'layout'],
    [15, 'assertion', 'layout'],
    [24, 'outside', 'Virtualizer.getTotalSize'],
    [28, 'outside', 'Virtualizer.scrollToOffset'],
  ])
  expect(sites[3]!.key).toBe('src/sample.ts|clampWidth|clamped <= max|1')
  expect(sites[5]!.text).toBe('total >= 0')
})

test('the owner walk stops at its depth cap and leaves the owner empty', () => {
  const sites = extractAssertSites('src/sample.ts', source, 0)
  expect(sites.find(site => site.line === 12)!.owner).toBe('')
  expect(sites.find(site => site.line === 5)!.owner).toBe('clampWidth')
})

test('instruments asserts and function entries, and exports functions that were not exported', () => {
  const rewritten = instrumentForRuntime('src/sample.ts', source)
  expect(rewritten).toContain('__evalAssert("src/sample.ts:5:3", clamped <= max)')
  expect(rewritten).toContain('__evalEnter("clampWidth", [width, max]);')
  expect(rewritten).toContain('export {clampWidth}')
  expect(rewritten).not.toContain('console.assert')
})
