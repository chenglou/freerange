import {expect, test} from 'bun:test'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {findConfigUpward} from '../lib/manifest.ts'
import {parseMaxRssBytes, runMeasured} from '../lib/process.ts'

test('stops a command that runs past its timeout, including the processes it started', async () => {
  const run = await runMeasured([process.execPath, '-e', 'setInterval(() => {}, 1000)'], tmpdir(), {timeoutMs: 300, maxOutputBytes: 1024}, false)
  expect(run.timedOut).toBe(true)
  expect(run.wallMs).toBeLessThan(5000)
})

test('caps captured output and keeps the tail', async () => {
  const run = await runMeasured([process.execPath, '-e', "process.stdout.write('x'.repeat(100000) + 'END')"], tmpdir(), {timeoutMs: 10_000, maxOutputBytes: 1000}, false)
  expect(run.stdoutTruncated).toBe(true)
  expect(run.stdout.endsWith('END')).toBe(true)
  expect(run.stdout.length).toBeLessThan(10_000)
})

test('records peak RSS through time -l', async () => {
  const run = await runMeasured([process.execPath, '-e', '0'], tmpdir(), {timeoutMs: 10_000, maxOutputBytes: 64_000})
  expect(run.exitCode).toBe(0)
  expect(run.maxRssBytes).toBeGreaterThan(1_000_000)
  expect(parseMaxRssBytes('  12  maximum resident set size\n  34  maximum resident set size')).toBe(34)
})

test('the tsconfig search stops at its depth cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-config-'))
  expect(findConfigUpward(join(directory, 'a', 'b'), 0)).toBeNull()
})
