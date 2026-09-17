import {expect, test} from 'bun:test'
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {allFinite, classifyEvents, maxRuntimeEvents, runExample, selectExamples, writeRuntimeTree, type RuntimeResult} from '../lib/runtime.ts'

const result = (events: RuntimeResult['events'], overflow = false): RuntimeResult => ({events, overflow, thrown: null, setupError: null})

test('a firing counts as in-domain only when the call held its leading asserts and had finite inputs', () => {
  const leading = new Set(['a.ts:2:3'])
  const target = 'a.ts:4:3'
  expect(classifyEvents(result([{kind: 'enter', name: 'f', finite: true}, {kind: 'assert', id: 'a.ts:2:3', ok: true}, {kind: 'assert', id: target, ok: false}]), target, 'f', leading).status).toBe('fires-in-domain')
  expect(classifyEvents(result([{kind: 'enter', name: 'f', finite: true}, {kind: 'assert', id: 'a.ts:2:3', ok: false}, {kind: 'assert', id: target, ok: false}]), target, 'f', leading)).toEqual({status: 'fires-out-of-domain', why: 'a leading console.assert of the function failed in the same call'})
  expect(classifyEvents(result([{kind: 'enter', name: 'f', finite: false}, {kind: 'assert', id: target, ok: false}]), target, 'f', leading).status).toBe('fires-out-of-domain')
  expect(classifyEvents(result([{kind: 'enter', name: 'f', finite: true}, {kind: 'assert', id: target, ok: true}], true), target, 'f', leading).status).toBe('not-run')
})

test('the finiteness walk stops at its budget', () => {
  expect(allFinite([1, 2, [3, {x: 4}]])).toBe(true)
  expect(allFinite([1, Number.NaN])).toBe(false)
  expect(allFinite(Array.from({length: 20}, () => 1), 10)).toBeNull()
})

test('example selection stops at the per-site and total caps', () => {
  const selection = selectExamples([{key: 'a', available: 5}, {key: 'b', available: 5}], 3, 4)
  expect(selection.selected.length).toBe(4)
  expect(selection.skipped).toBe(2)
})

test('runs an example in a child process and caps the recorded events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-runtime-'))
  mkdirSync(join(root, 'tree'))
  writeFileSync(join(root, 'tree', 'loop.ts'), `function spin(count: number) {
  console.assert(count >= 0)
  for (let index = 0; index < count; index++) {
    console.assert(index >= 0)
  }
  console.assert(count < 0)
  return count
}
`)
  const runtimeRoot = join(root, 'runtime')
  writeRuntimeTree(join(root, 'tree'), runtimeRoot, ['loop.ts'])
  const small = await runExample({runtimeRoot, entryFile: 'loop.ts', entry: 'spin', args: '[2]', workDirectory: runtimeRoot, label: 'small', timeoutMs: 20_000})
  expect(classifyEvents(small, 'loop.ts:6:3', 'spin', new Set(['loop.ts:2:3'])).status).toBe('fires-in-domain')
  const large = await runExample({runtimeRoot, entryFile: 'loop.ts', entry: 'spin', args: `[${maxRuntimeEvents + 10}]`, workDirectory: runtimeRoot, label: 'large', timeoutMs: 20_000})
  expect(large.overflow).toBe(true)
  expect(large.events.length).toBe(maxRuntimeEvents)
})
