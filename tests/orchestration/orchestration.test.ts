import {test} from 'bun:test'
import {snapshotUpdateRequested} from '../../snapshot.ts'

const repoDir = new URL('../..', import.meta.url).pathname
const focusedSuitePaths = [
  'tests/calls/calls.test.ts',
  'tests/check/check.test.ts',
  'tests/cli/cli.test.ts',
  'tests/interpreter/interpreter.test.ts',
  'tests/parser/parser.test.ts',
  'tests/purity/purity.test.ts',
  'tests/ranges/ranges.test.ts',
  'tests/type-contracts/type-contracts.test.ts',
]
const infrastructureTestPaths = [
  'tests/orchestration/orchestration.test.ts',
  'tests/snapshot/eval.test.ts',
  'tests/snapshot/interpreter-snapshots.test.ts',
]
const discoveredTestPaths = [...focusedSuitePaths, ...infrastructureTestPaths].sort()

test('focused suite family stays complete', async () => {
  for (const path of focusedSuitePaths) {
    const source = await Bun.file(new URL(`../../${path}`, import.meta.url)).text()
    assert(countOccurrences(source, 'testSuite(') === 1, `expected ${path} to register one suite`)
  }
  const find = runProcess(['find', 'tests', '-name', '*.test.ts', '-type', 'f'])
  assert(find.exitCode === 0, `expected test discovery scan to pass\n${find.output}`)
  const discovered = find.output.trim().split('\n').filter(line => line.length > 0).sort()
  assert(JSON.stringify(discovered) === JSON.stringify(discoveredTestPaths), `unexpected Bun test files\n${find.output}`)
})

test('parallel runner preserves failure detail and independent success', () => {
  const result = runTestFiles([
    './tests/orchestration/fixtures/failing-suite.ts',
    './tests/orchestration/fixtures/passing-suite.ts',
  ])
  assert(result.exitCode !== 0, 'expected a failed suite to fail the runner')
  assert(result.output.includes('controlled failure detail'), 'expected original failure detail')
  assert(result.output.includes('(fail) controlled failing suite'), 'expected failed suite attribution')
  assert(result.output.includes('controlled passing suite completed'), 'expected the independent suite to complete')
  assert(result.output.includes('(pass) controlled passing suite'), 'expected independent success attribution')
})

test('filtered suites do not execute module work', () => {
  const result = runTestFiles([
    './tests/orchestration/fixtures/failing-suite.ts',
    './tests/orchestration/fixtures/passing-suite.ts',
  ], {namePattern: 'controlled passing suite'})
  assert(result.exitCode === 0, `expected the selected suite to pass\n${result.output}`)
  assert(!result.output.includes('controlled failure detail'), 'expected the filtered suite body not to execute')
  assert(result.output.includes('controlled passing suite completed'), 'expected the selected suite to execute')
})

test('parallel files and repeated commands start with fresh module state', () => {
  for (let run = 0; run < 2; run += 1) {
    const result = runTestFiles([
      './tests/orchestration/fixtures/isolation-a.ts',
      './tests/orchestration/fixtures/isolation-b.ts',
    ], {workers: 1})
    assert(result.exitCode === 0, `expected isolated run ${run + 1} to pass\n${result.output}`)
    assert(countOccurrences(result.output, 'isolation suite A completed') === 1, 'expected isolation suite A exactly once')
    assert(countOccurrences(result.output, 'isolation suite B completed') === 1, 'expected isolation suite B exactly once')
    assert(!result.output.includes('observed prior module state'), 'expected module state not to cross files')
  }
})

test('snapshot update mode is explicit', () => {
  const previous = Bun.env['FREERANGE_UPDATE_SNAPSHOTS']
  try {
    delete Bun.env['FREERANGE_UPDATE_SNAPSHOTS']
    assert(!snapshotUpdateRequested(), 'expected normal tests not to update snapshots')
    Bun.env['FREERANGE_UPDATE_SNAPSHOTS'] = '1'
    assert(snapshotUpdateRequested(), 'expected the update command to enable snapshot writes')
  } finally {
    if (previous == null) delete Bun.env['FREERANGE_UPDATE_SNAPSHOTS']
    else Bun.env['FREERANGE_UPDATE_SNAPSHOTS'] = previous
  }
})

function runTestFiles(
  paths: string[],
  options: {workers?: number; namePattern?: string} = {},
) {
  const cmd = [
    process.execPath,
    'test',
    `--parallel=${options.workers ?? 2}`,
    '--parallel-delay=0',
  ]
  if (options.namePattern != null) cmd.push('--test-name-pattern', options.namePattern)
  cmd.push(...paths)
  return runProcess(cmd)
}

function runProcess(cmd: string[]) {
  const result = Bun.spawnSync({
    cmd,
    cwd: repoDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const decoder = new TextDecoder()
  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  }
}

function countOccurrences(text: string, part: string) {
  return text.split(part).length - 1
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
