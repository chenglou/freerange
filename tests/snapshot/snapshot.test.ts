import {expect, test} from 'bun:test'
import {formatSnapshotDiff, verifySnapshot} from './snapshot.ts'
import {changedSnapshotObservation, formatTestDiagnostics, requiredCheck} from '../test-diagnostics.ts'

test('snapshot differences show one focused hunk', () => {
  const expected = [
    '@@ expected 2-2, actual 2-2 @@',
    '  one',
    '- two',
    '+ changed',
    '  three',
  ].join('\n')
  expect(formatSnapshotDiff('one\ntwo\nthree\n', 'one\nchanged\nthree\n')).toBe(expected)
})

test('large snapshot differences are bounded', () => {
  const expected = Array.from({length: 30}, (_, index) => `old ${index}`).join('\n')
  const actual = Array.from({length: 30}, (_, index) => `new ${index}`).join('\n')
  const diff = formatSnapshotDiff(expected, actual)
  expect(diff).toContain('- ... 14 more lines')
  expect(diff).toContain('+ ... 14 more lines')
  expect(diff).not.toContain('old 29')
  expect(diff).not.toContain('new 29')
})

test('snapshot updates write the normalized result', async () => {
  const path = `/tmp/freerange-snapshot-${crypto.randomUUID()}.txt`
  const previous = Bun.env['FREERANGE_UPDATE_SNAPSHOTS']
  try {
    Bun.env['FREERANGE_UPDATE_SNAPSHOTS'] = '1'
    expect(await verifySnapshot(path, 'updated', 'temporary snapshot')).toBe(true)
    expect(await Bun.file(path).text()).toBe('updated\n')
  } finally {
    if (previous == null) delete Bun.env['FREERANGE_UPDATE_SNAPSHOTS']
    else Bun.env['FREERANGE_UPDATE_SNAPSHOTS'] = previous
    Bun.spawnSync({cmd: ['rm', '-f', path]})
  }
})

test('test diagnostics keep outcomes and omit proof machinery', () => {
  const output = formatTestDiagnostics({
    file: 'example.ts',
    functionName: 'layout',
    status: 'fail',
    reason: 'width exceeded',
    obligation: {id: 'large internal identity'},
    trace: {steps: ['large internal trace']},
    detail: {missing: ['large internal detail']},
  })
  expect(output).toContain('"status": "fail"')
  expect(output).toContain('"reason": "width exceeded"')
  expect(output).not.toContain('large internal')
})

test('large test diagnostics are bounded', () => {
  const output = formatTestDiagnostics({
    checks: Array.from({length: 100}, (_, index) => `check ${index}`),
  })
  expect(output).toContain('... 24 more lines')
  expect(output).not.toContain('check 99')
})

test('test diagnostics bound text and show collections', () => {
  const text = Array.from({length: 100}, (_, index) => `line ${index}`).join('\n')
  const boundedText = formatTestDiagnostics(text)
  expect(boundedText).toContain('... 20 more lines')
  expect(boundedText).not.toContain('line 99')
  expect(formatTestDiagnostics(new Set(['missing height']))).toContain('missing height')
  expect(formatTestDiagnostics(new Map([['height', 'missing']]))).toContain('height')
})

test('required checks reject missing and duplicate identities', () => {
  const matching = {
    file: 'layout.ts',
    line: 3,
    functionName: 'layout',
    text: 'return.width > 0',
    status: 'pass' as const,
  }
  const identity = {functionName: 'layout', text: 'return.width > 0', file: 'layout.ts', line: 3}
  expect(requiredCheck([
    matching,
    {...matching, text: 'return.height > 0'},
    {...matching, file: 'other.ts'},
    {...matching, line: 4},
  ], identity)).toBe(matching)
  expect(() => requiredCheck([matching], {functionName: 'missing', text: 'return.width > 0'}))
    .toThrow('expected exactly one check matching {"functionName":"missing","text":"return.width > 0"}; found 0')
  expect(() => requiredCheck([matching, {...matching}], identity)).toThrow('found 2')
  const failing = {...matching, status: 'fail' as const}
  expect(() => requiredCheck([failing, {...failing}], identity)).toThrow('found 2')
  expect(() => requiredCheck([
    matching,
    failing,
  ], identity))
    .toThrow(/found 2[\s\S]*"status": "pass"[\s\S]*"status": "fail"/)

  const observation = {file: 'layout.ts', functionName: 'layout', facts: ['new fact']}
  const changed = changedSnapshotObservation(
    '@ "layout.ts"\n# ["layout"]\nf "old fact"',
    '@ "layout.ts"\n# ["layout"]\nf "new fact"',
    [observation],
  )
  expect(changed.observation).toBe(observation)
  expect(changed.line).toBe(3)

  const firstFile = {file: 'first.ts', functionName: 'layout'}
  const secondFile = {file: 'second.ts', functionName: 'layout'}
  const duplicateNameChange = changedSnapshotObservation(
    '@ "first.ts"\n# ["layout"]\nf "same"\n@ "second.ts"\n# ["layout"]\nf "old"',
    '@ "first.ts"\n# ["layout"]\nf "same"\n@ "second.ts"\n# ["layout"]\nf "new"',
    [firstFile, secondFile],
  )
  expect(duplicateNameChange.observation).toBe(secondFile)
})
