import {test} from 'bun:test'
import ts from 'typescript'
import {snapshotUpdateRequested} from '../../snapshot.ts'

const repoDir = new URL('../..', import.meta.url).pathname
const testFiles = [
  {path: 'tests/calls/calls.test.ts', registrations: 17},
  {path: 'tests/cli/cli.test.ts', registrations: 29},
  {path: 'tests/domain/domain.test.ts', registrations: 12},
  {path: 'tests/interpreter/interpreter.test.ts', registrations: 4},
  {path: 'tests/loops/loops.test.ts', registrations: 10},
  {path: 'tests/parser/parser.test.ts', registrations: 17},
  {path: 'tests/purity/purity.test.ts', registrations: 8},
  {path: 'tests/ranges/ranges.test.ts', registrations: 9},
  {path: 'tests/reports/reports.test.ts', registrations: 4},
  {path: 'tests/source-checking/source-checking.test.ts', registrations: 29},
  {path: 'tests/type-contracts/type-contracts.test.ts', registrations: 13},
  {path: 'tests/orchestration/orchestration.test.ts', registrations: 5},
  {path: 'tests/snapshot/eval.test.ts', registrations: 1},
  {path: 'tests/snapshot/interpreter-snapshots.test.ts', registrations: 1},
  {path: 'tests/snapshot/snapshot.test.ts', registrations: 6},
]
const discoveredTestPaths = testFiles.map(file => file.path).sort()

test('test inventory stays complete', async () => {
  for (const file of testFiles) {
    const source = await Bun.file(new URL(`../../${file.path}`, import.meta.url)).text()
    const registrations = countTestRegistrations(file.path, source)
    assert(registrations === file.registrations, `expected ${file.path} to register ${file.registrations} tests, got ${registrations}`)
  }
  const embeddedRegistration = "const source = `test('not registered', () => {})`\ntest('registered', () => {})"
  assert(countTestRegistrations('embedded-registration.test.ts', embeddedRegistration) === 1, 'expected embedded test text not to count as a registration')
  for (const modifier of ['test.skip', 'describe.skip']) {
    let rejection: unknown
    try {
      countTestRegistrations('disabled-registration.test.ts', `${modifier}('disabled', () => { test('nested', () => {}) })`)
    } catch (error) {
      rejection = error
    }
    assert(rejection instanceof Error && rejection.message.includes(modifier), `expected ${modifier} to be rejected`)
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

test('filtered tests skip unselected callback work', () => {
  const result = runTestFiles([
    './tests/orchestration/fixtures/failing-suite.ts',
    './tests/orchestration/fixtures/passing-suite.ts',
  ], {namePattern: 'controlled passing suite'})
  assert(result.exitCode === 0, `expected the selected test to pass\n${result.output}`)
  assert(!result.output.includes('controlled failure detail'), 'expected the unselected callback not to execute')
  assert(result.output.includes('controlled passing suite completed'), 'expected the selected callback to execute')
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

function countTestRegistrations(path: string, source: string) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let registrations = 0
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'test') {
        const name = node.arguments[0]
        assert(name != null && ts.isStringLiteralLike(name), `expected ${path} to use a static test name`)
        registrations += 1
      } else if (
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && (node.expression.expression.text === 'test' || node.expression.expression.text === 'describe')
      ) {
        throw new Error(`unsupported test modifier in ${path}: ${node.expression.getText(sourceFile)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return registrations
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
