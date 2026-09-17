import {expect, test} from 'bun:test'
import {extractAssertSites} from '../lib/asserts.ts'
import {classifyFinding, failedRunReason, joinVerdicts, parseFreerangeOutput} from '../lib/findings.ts'

const source = `export function unsupportedHelper(values: number[], limit: number) {
  console.assert(values.length > 0)
  for (let index = 0; index < values.length; index++) {
    console.assert(values[index]! <= limit + 1)
  }
  return limit
}

export function analyzed(width: number) {
  console.assert(width >= 0)
  const half = width / 2
  console.assert(half >= 0)
  console.assert(half <= width)
  console.assert(half === width)
  return half
}
`

const output = `src/sample.ts(4,43): error [console-assert]: calculate or read the value before console.assert, then check the variable in unsupportedHelper
src/sample.ts(13,3): error [console-assert]: could not prove console.assert condition in analyzed: half <= width
src/sample.ts(14,3): error [console-assert]: console.assert condition can be false in analyzed: half === width

2 findings (2 errors, 0 warnings).
coverage: 1/2 named top-level functions fully analyzed; 0 partially supported; 1 unsupported.
`

test('joins findings to sites: a not-lowered function covers every assert in it, and silence in a lowered function is a proof', () => {
  const sites = extractAssertSites('src/sample.ts', source)
  const verdicts = joinVerdicts(sites, {kind: 'ran', output: parseFreerangeOutput(output)})
  const byLine = new Map(sites.map(site => [site.line, verdicts.get(site.key)!.verdict]))
  expect(byLine.get(2)).toBe('not-analyzed')
  expect(byLine.get(4)).toBe('not-analyzed')
  expect(byLine.get(10)).toBe('requirement')
  expect(byLine.get(12)).toBe('proved')
  expect(byLine.get(13)).toBe('could-not-prove')
  expect(byLine.get(14)).toBe('can-be-false')
})

test('a failed run leaves every site not analyzed with the failure as the reason', () => {
  const sites = extractAssertSites('src/sample.ts', source)
  const verdicts = joinVerdicts(sites, {kind: 'failed', reason: 'timeout after 5 s'})
  expect([...verdicts.values()].every(verdict => verdict.verdict === 'not-analyzed' && verdict.reason === 'timeout after 5 s')).toBe(true)
})

test('classifies a branch-style not-checked finding that appends the condition as a site finding', () => {
  const classified = classifyFinding({file: 'a.ts', line: 3, column: 3, level: 'error', rule: 'console-assert', message: 'console.assert must contain one direct numeric comparison using ===, !==, <, <=, >, or >=, or a supported Number check in layout: a || b'})
  expect(classified).toEqual({scope: 'site', kind: 'notChecked', functionName: 'layout'})
})

test('stops parsing at the finding cap and says so', () => {
  const lines = Array.from({length: 6}, (_, index) => `a.ts(${index + 1},1): error [console-assert]: could not prove console.assert condition in f: x >= 0`)
  const parsed = parseFreerangeOutput(lines.join('\n'), 5)
  expect(parsed.findings.length).toBe(5)
  expect(parsed.truncated).toBe(true)
})

test('names TypeScript errors when a run stops before analysis', () => {
  const reason = failedRunReason({timedOut: false, timeoutMs: 1000, spawnError: null, exitCode: 1, stderr: "src/a.ts(1,20): error TS2307: Cannot find module './b'", coverageLine: null})
  expect(reason).toContain('TS2307')
})
