import {test} from 'bun:test'
import {formatSnapshotDiff, verifySnapshot} from '../../snapshot.ts'
import {formatTestDiagnostics} from '../test-diagnostics.ts'

test('snapshot differences show one focused hunk', () => {
  const expected = [
    '@@ expected 2-2, actual 2-2 @@',
    '  one',
    '- two',
    '+ changed',
    '  three',
  ].join('\n')
  assert(formatSnapshotDiff('one\ntwo\nthree\n', 'one\nchanged\nthree\n') === expected, 'expected one focused snapshot hunk')
})

test('large snapshot differences are bounded', () => {
  const expected = Array.from({length: 30}, (_, index) => `old ${index}`).join('\n')
  const actual = Array.from({length: 30}, (_, index) => `new ${index}`).join('\n')
  const diff = formatSnapshotDiff(expected, actual)
  assert(diff.includes('- ... 14 more lines'), 'expected omitted old-line count')
  assert(diff.includes('+ ... 14 more lines'), 'expected omitted new-line count')
  assert(!diff.includes('old 29'), 'expected old lines to be bounded')
  assert(!diff.includes('new 29'), 'expected new lines to be bounded')
})

test('snapshot updates write the normalized result', async () => {
  const path = `/tmp/freerange-snapshot-${crypto.randomUUID()}.txt`
  const previous = Bun.env['FREERANGE_UPDATE_SNAPSHOTS']
  try {
    Bun.env['FREERANGE_UPDATE_SNAPSHOTS'] = '1'
    assert(await verifySnapshot(path, 'updated', 'temporary snapshot'), 'expected snapshot update to pass')
    assert(await Bun.file(path).text() === 'updated\n', 'expected a normalized snapshot update')
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
  assert(output.includes('"status": "fail"'), 'expected the check status')
  assert(output.includes('"reason": "width exceeded"'), 'expected the check reason')
  assert(!output.includes('large internal'), 'expected nested proof machinery to be omitted')
})

test('large test diagnostics are bounded', () => {
  const output = formatTestDiagnostics({
    checks: Array.from({length: 100}, (_, index) => `check ${index}`),
  })
  assert(output.includes('... 24 more lines'), 'expected omitted diagnostic-line count')
  assert(!output.includes('check 99'), 'expected late diagnostic lines to be omitted')
})

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
