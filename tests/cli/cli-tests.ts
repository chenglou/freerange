import {verifyFitFiles} from '../../src/reports.ts'

const repoDir = new URL('../..', import.meta.url).pathname

await runCliRegressionTests()

async function runCliRegressionTests() {
  const explicitCheck = runFr(['check', 'tests/patterns/patterns.ts', 'tests/imports/import-patterns.ts'])
  expectCli(explicitCheck.exitCode === 0, 'expected fr check <files> to pass', explicitCheck.output)
  expectCli(explicitCheck.output.includes('fr check: 2 files,'), 'expected explicit fr check summary to include file count', explicitCheck.output)
  expectCli(explicitCheck.output.includes('0 fail, 0 requires, 0 unknown'), 'expected explicit fr check summary to include clean counts', explicitCheck.output)

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['check'], dir)
    expectCli(check.exitCode === 0, 'expected no-arg fr check to pass from tsconfig project', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown'), 'expected no-arg fr check summary from tsconfig project', check.output)
  })

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}

function plain() {
  return 1
}
`,
  }, dir => {
    const infer = runFr(['infer', '--all'], dir)
    expectCli(infer.exitCode === 0, 'expected no-arg fr infer --all to summarize a tsconfig project', infer.output)
    expectCli(infer.output.includes('fr infer --all: 1 files, 2 functions'), 'expected project infer summary count', infer.output)
    expectCli(infer.output.includes('facts:'), 'expected project infer summary facts', infer.output)
    expectCli(!infer.output.includes('layout.ts:plain'), 'expected project infer summary to avoid per-function dump', infer.output)
  })

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'project-types.ts': `type ProjectBox = {
  value: number // @fit 0..10
}
`,
    'project-consumer.ts': `export function makeBox(): ProjectBox {
  return {value: 5}
}
`,
  }, dir => {
    const check = runFr(['check', 'project-consumer.ts'], dir)
    expectCli(check.exitCode === 0, 'expected explicit file check to use tsconfig type roots', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown'), 'expected project type contract to pass', check.output)
  })

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'project-types.ts': `type ProjectBox = {
  value: number // @fit 0..10
}
`,
    'project-consumer.ts': `export function makeBox(): ProjectBox {
  return {value: 20}
}
`,
  }, dir => {
    const check = runFr(['check', 'project-consumer.ts'], dir)
    expectCli(check.exitCode === 1, 'expected project type roots to enforce imported type-field facts', check.output)
    expectCli(check.output.includes('FAIL return.value: 0..10'), 'expected project type root failure output', check.output)
    expectCli(check.output.includes('fr check: 1 files, 0 pass, 1 fail, 0 requires, 0 unknown'), 'expected project type root failure summary', check.output)
  })

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'project-types.ts': `export type RangeBox<T> = {
  value: T
}

export type TileBase = {
  width: number
}
`,
    'project-consumer.ts': `import type {RangeBox, TileBase} from './project-types'

/** @fit
 * return: RangeBox<TileBase & {width: 10..20}>
 */
export function makeBox() {
  return {value: {width: 15}}
}
`,
  }, dir => {
    const check = runFr(['check', 'project-consumer.ts'], dir)
    expectCli(check.exitCode === 0, 'expected whole-value specs to resolve imported type syntax', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown'), 'expected imported whole-value type spec to pass', check.output)
  })

  await withCliFixture({
    'helper.ts': `/** @fit
 * given value: 0..10
 * return: 0..10
 */
export function cap(value: number) {
  return value
}
`,
    'barrel.ts': `export * from './helper'
`,
    'layout.ts': `import {cap} from './barrel'

/** @fit
 * given value: 0..10
 * return: 0..10
 */
function use(value: number) {
  return cap(value)
}
`,
  }, dir => {
    const check = runFr(['check', 'layout.ts'], dir)
    expectCli(check.exitCode === 0, 'expected star-barrel helper import to pass', check.output)
    expectCli(check.output.includes('0 fail, 0 requires, 0 unknown'), 'expected star-barrel helper import summary', check.output)
  })

  await withCliFixture({
    'helper.ts': `/** @fit
 * given value: 0..100
 * return: 0..100
 */
export function wide(value: number) {
  return value
}
`,
    'barrel.ts': `export * from './helper'
`,
    'layout.ts': `import {wide} from './barrel'

/** @fit
 * given value: 0..100
 * return: 0..10
 */
function use(value: number) {
  return wide(value)
}
`,
  }, dir => {
    const check = runFr(['check', 'layout.ts'], dir)
    expectCli(check.exitCode === 1, 'expected star-barrel helper import to preserve callee range', check.output)
    expectCli(check.output.includes('FAIL return: 0..10'), 'expected star-barrel helper failure output', check.output)
    expectCli(!check.output.includes('Unsupported call wide'), 'expected star-barrel helper call to resolve', check.output)
  })

  await withCliFixture({
    'bad.ts': `/** @fit
 * return: 0..1
 */
function bad() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['check', 'bad.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to exit 1 on a failed claim', check.output)
    expectCli(check.output.includes('bad.ts:2:bad'), 'expected fr check failure output to include the spec line and function scope', check.output)
    expectCli(check.output.includes('FAIL return: 0..1'), 'expected fr check failure output', check.output)
    expectCli(check.output.includes('next: run fr infer --function bad bad.ts'), 'expected fr check to point at infer next', check.output)
    expectCli(check.output.includes('fr check: 1 files, 0 pass, 1 fail, 0 requires, 0 unknown'), 'expected fr check failure summary', check.output)
  })

  await withCliFixture({
    'calls.ts': `function h(
  value: number, // @fit 0..10
) {
  return value
}

function f() {
  return h(20)
}
`,
  }, dir => {
    const check = runFr(['check', 'calls.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to exit 1 on a definite bad literal call', check.output)
    expectCli(check.output.includes('calls.ts:8:f'), 'expected fr check failure output to include the call line', check.output)
    expectCli(check.output.includes('FAIL: h(20): requires value: 0..10'), 'expected fr check literal-call failure output', check.output)
    expectCli(check.output.includes('missing: 20 <= 10'), 'expected fr check to print the caller-side missing obligation', check.output)
    expectCli(check.output.includes('fr check: 1 files,'), 'expected fr check summary', check.output)
    expectCli(check.output.includes('1 fail'), 'expected fr check summary to include one fail', check.output)
  })

  await withCliFixture({
    'calls.ts': `function h(
  value: number, // @fit 0..10
) {
  return value
}

function f(value: number) {
  return h(value)
}
`,
  }, dir => {
    const check = runFr(['check', 'calls.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to exit 1 on caller requirements', check.output)
    expectCli(check.output.includes('REQUIRES: h(value): requires value: 0..10'), 'expected fr check caller-requirement output', check.output)
    expectCli(check.output.includes('next: add a caller given, validate before this call, or run fr infer --function f calls.ts to see caller facts'), 'expected fr check to point at caller infer next', check.output)
    expectCli(check.output.includes('fr check: 1 files,'), 'expected fr check summary', check.output)
    expectCli(check.output.includes('0 fail, 1 requires, 0 unknown'), 'expected fr check summary to classify requires separately from fail', check.output)

    const annotationsOnly = runFr(['check', '--annotations-only', 'calls.ts'], dir)
    expectCli(annotationsOnly.exitCode === 0, 'expected fr check --annotations-only to skip broad callsite requirements', annotationsOnly.output)
    expectCli(!annotationsOnly.output.includes('REQUIRES: h(value)'), 'expected fr check --annotations-only to suppress broad callsite requirements', annotationsOnly.output)
    expectCli(annotationsOnly.output.includes('fr check --annotations-only: 1 files,'), 'expected fr check --annotations-only summary', annotationsOnly.output)
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given width: 1..99
 * return: 1..100
 */
function size(width: number) {
  const lower = Math.max(1, width)
  const upper = Math.min(width, 100)
  return width < 100 ? width : 100
}
`,
  }, async dir => {
    const normal = runFr(['check', 'audit.ts'], dir)
    expectCli(normal.exitCode === 0, 'expected normal check to ignore selector audit findings', normal.output)
    expectCli(!normal.output.includes('AUDIT'), 'expected normal check not to print audits', normal.output)

    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected selector audit to stay advisory', audit.output)
    expectCli(audit.output.includes('AUDIT Math.max(1, width): 1 does not affect the result'), 'expected redundant Math.max guard audit', audit.output)
    expectCli(audit.output.includes('AUDIT Math.min(width, 100): 100 does not affect the result'), 'expected redundant Math.min guard audit', audit.output)
    expectCli(audit.output.includes('AUDIT width < 100 ? width : 100: 100 does not affect the result'), 'expected redundant selector ternary branch audit', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 3 audit'), 'expected audit summary count', audit.output)
    const report = await verifyFitFiles([pathJoin(dir, 'audit.ts')], {audit: true})
    const firstAudit = report.audits[0]
    expectCli(firstAudit?.obligation?.boundary === 'audit', 'expected audit to carry an audit obligation', JSON.stringify(report.audits, null, 2))
    expectCli(firstAudit?.trace?.steps[0]?.domain === 'audit', 'expected audit to carry a proof trace', JSON.stringify(report.audits, null, 2))
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given width: 10..99
 * given fallback: 0..100
 * return >= 0
 */
function size(width: number, fallback: number) {
  let value = width
  if (value < 1) value = 1
  const resolved = value ?? fallback
  return resolved
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected branch/nullish audit fixture to pass', audit.output)
    expectCli(audit.output.includes('AUDIT if (value < 1): condition is always false'), 'expected impossible branch audit', audit.output)
    expectCli(audit.output.includes('AUDIT value ?? fallback: fallback does not affect the result'), 'expected redundant nullish fallback audit', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 2 audit'), 'expected branch/nullish audit summary count', audit.output)
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given min <= mid
 * given mid <= width
 * return >= width
 */
function size(min: number, mid: number, width: number) {
  return Math.max(min, width)
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected selector audit to use composed comparison facts', audit.output)
    expectCli(audit.output.includes('AUDIT Math.max(min, width): min does not affect the result'), 'expected transitive Math.max guard audit', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 1 audit'), 'expected transitive audit summary count', audit.output)
  })

  await withCliFixture({
    'audit.ts': `/** @fit
 * given width: 0..99
 * return: 1..99
 */
function size(width: number) {
  return Math.max(1, width)
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected uncertain selector audit fixture to pass', audit.output)
    expectCli(!audit.output.includes('does not affect the result'), 'expected uncertain Math.max guard to stay quiet', audit.output)
    expectCli(audit.output.includes('fr check --audit: 1 files, 1 pass, 0 fail, 0 requires, 0 unknown, 0 audit'), 'expected zero audit summary count', audit.output)
  })

  await withCliFixture({
    'audit.ts': `function plain() {
  return Math.max(1, 2)
}
`,
  }, dir => {
    const audit = runFr(['check', '--audit', 'audit.ts'], dir)
    expectCli(audit.exitCode === 0, 'expected broad audit to visit plain functions', audit.output)
    expectCli(audit.output.includes('AUDIT Math.max(1, 2): 1 does not affect the result'), 'expected broad audit finding', audit.output)

    const annotationsOnly = runFr(['check', '--annotations-only', '--audit', 'audit.ts'], dir)
    expectCli(annotationsOnly.exitCode === 0, 'expected annotations-only audit to pass', annotationsOnly.output)
    expectCli(!annotationsOnly.output.includes('AUDIT Math.max(1, 2)'), 'expected annotations-only audit to skip plain functions', annotationsOnly.output)
    expectCli(annotationsOnly.output.includes('fr check --annotations-only --audit: 1 files, 0 pass, 0 fail, 0 requires, 0 unknown, 0 audit'), 'expected annotations-only audit summary', annotationsOnly.output)
  })

  await withCliFixture({
    'calls.ts': `/** @fit
 * given max >= min
 * return > 0
 */
function h(min: number, value: number, max: number) {
  return 1
}

h(10, 0, 1)

function f() {
  h(20, 0, 2)
}

if (true) {
  h(30, 0, 3)
}

export default h(40, 0, 4)
`,
  }, dir => {
    const check = runFr(['check', 'calls.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to visit broad bare callsites', check.output)
    expectCli(check.output.includes('calls.ts:9:<top-level>'), 'expected top-level bare call line', check.output)
    expectCli(check.output.includes('FAIL: h(10, 0, 1): requires max >= min'), 'expected top-level bare call failure', check.output)
    expectCli(check.output.includes('calls.ts:12:f'), 'expected function bare call line', check.output)
    expectCli(check.output.includes('FAIL: h(20, 0, 2): requires max >= min'), 'expected function bare call failure', check.output)
    expectCli(check.output.includes('calls.ts:16:<top-level>'), 'expected top-level branch call line', check.output)
    expectCli(check.output.includes('FAIL: h(30, 0, 3): requires max >= min'), 'expected top-level branch call failure', check.output)
    expectCli(check.output.includes('calls.ts:19:<top-level>'), 'expected export assignment call line', check.output)
    expectCli(check.output.includes('FAIL: h(40, 0, 4): requires max >= min'), 'expected export assignment call failure', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 4 fail, 0 requires, 0 unknown'), 'expected broad bare callsite summary', check.output)
  })

  await withCliFixture({
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['infer', 'layout.ts', '--function', 'ok'], dir)
    expectCli(check.exitCode === 0, 'expected fr infer to run from the main CLI', check.output)
    expectCli(check.output.includes('layout.ts:ok'), 'expected fr infer to print the function header', check.output)
    expectCli(check.output.includes('checked:'), 'expected fr infer to print checked claims', check.output)
    expectCli(check.output.includes('return: 2'), 'expected fr infer to print the checked return fact', check.output)
  })

  await withCliFixture({
    'infer-filter.ts': `/** @fit
 * return: 2
 */
function annotated() {
  return 2
}

function plain() {
  return 1
}
`,
  }, dir => {
    const infer = runFr(['infer', 'infer-filter.ts'], dir)
    expectCli(infer.exitCode === 0, 'expected file-scoped infer to include every function', infer.output)
    expectCli(infer.output.includes('infer-filter.ts:annotated'), 'expected infer to include annotated function', infer.output)
    expectCli(infer.output.includes('infer-filter.ts:plain'), 'expected infer to include plain function', infer.output)

    const filtered = runFr(['infer', '--annotations-only', 'infer-filter.ts'], dir)
    expectCli(filtered.exitCode === 0, 'expected infer --annotations-only to keep the old filter', filtered.output)
    expectCli(filtered.output.includes('infer-filter.ts:annotated'), 'expected annotations-only infer to include annotated function', filtered.output)
    expectCli(!filtered.output.includes('infer-filter.ts:plain'), 'expected annotations-only infer to skip plain function', filtered.output)
  })

  await withCliFixture({
    'infer-contract.ts': `function randomLimit() {
  return Math.random() * 10
}

/** @fit
 * return <= randomLimit()
 */
function bad() {
  return 0
}
`,
  }, dir => {
    const infer = runFr(['infer', 'infer-contract.ts', '--function', 'bad'], dir)
    expectCli(infer.exitCode === 1, 'expected fr infer to fail when a written contract expression is unsupported', infer.output)
    expectCli(infer.output.includes('Unsupported @fit contract expression: randomLimit()'), 'expected infer output to name the unsupported contract expression', infer.output)
    expectCli(infer.output.includes('Unsupported Math.random call'), 'expected infer output to include the interpreter blocker', infer.output)
  })

  {
    const infer = runFr(['infer'])
    expectCli(infer.exitCode === 2, 'expected no-arg infer to require a file path', infer.output)
    expectCli(infer.output.includes('fr infer: pass a file path'), 'expected no-arg infer guidance', infer.output)
    expectCli(infer.output.includes('fr check [--annotations-only] [--audit] [file.ts ...]'), 'expected usage to include audit flag', infer.output)
    expectCli(infer.output.includes('fr infer [--function name] [--annotations-only] [--all] file.ts ...'), 'expected no-arg infer to print help', infer.output)
  }

  await withCliFixture({
    'helper.ts': `export function clamp(
  value: number,
  min: number, // @fit <= max
  max: number,
): number {
  // @fit >= min
  return Math.min(Math.max(value, min), max) // @fit <= max
}

const opacity = clamp(1.2, 0, 1) // @fit 0..1
`,
  }, dir => {
    const check = runFr(['check', 'helper.ts'], dir)
    expectCli(check.exitCode === 0, 'expected standalone helper call check to pass', check.output)
    expectCli(check.output.includes('fr check: 1 files, 6 pass, 0 fail, 0 requires, 0 unknown'), 'expected standalone helper call check summary', check.output)
  })

  await withCliFixture({
    'helper.ts': `/** @fit
 * given min <= max
 * return >= min
 * return <= max
 */
export function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Freerange catches this: the result can be 2.
const opacity = clamp(0, 10, 2) // @fit 0..1
`,
  }, dir => {
    const check = runFr(['check', 'helper.ts'], dir)
    expectCli(check.exitCode === 1, 'expected de-inlined clamp example to fail without crashing', check.output)
    expectCli(check.output.includes('FAIL opacity: 0..1'), 'expected de-inlined clamp example failure output', check.output)
    expectCli(check.output.includes('fr check: 1 files, 3 pass, 1 fail, 0 requires, 0 unknown'), 'expected de-inlined clamp example summary', check.output)
  })

  await withCliFixture({
    'recursive-infer.ts': `function walk(value: number): number {
  const next = value > 0 ? walk(value - 1) : 0
  return next
}
`,
  }, dir => {
    const infer = runFr(['infer', 'recursive-infer.ts', '--function', 'walk'], dir)
    expectCli(infer.exitCode === 0, 'expected recursive infer to stop at the helper cycle instead of overflowing', infer.output)
    expectCli(infer.output.includes('Recursive helper inlining is unsupported at walk'), 'expected recursive infer to report the helper cycle', infer.output)
  })

  {
    const infer = runFr(['infer', 'src/bound-index.ts', '--function', 'proveBoundIndexComparisonSpec'])
    expectCli(infer.exitCode === 0, 'expected self-hosted bound-index infer to stay bounded', infer.output)
    expectCli(infer.output.includes('src/bound-index.ts:proveBoundIndexComparisonSpec'), 'expected bound-index infer header', infer.output)
  }

  {
    const infer = runFr(['infer', 'src/interpreter/evaluate.ts', '--function', 'evaluateExpression'])
    expectCli(infer.exitCode === 0, 'expected self-hosted evaluateExpression infer to stay bounded', infer.output)
    expectCli(infer.output.includes('Unsupported branch condition: ts.isParenthesizedExpression(expression)'), 'expected evaluateExpression infer to report the first unsupported branch condition', infer.output)
    expectCli(infer.output.split('\n').length < 30, 'expected evaluateExpression infer to avoid cascading through every branch body', infer.output)
  }

  await withCliFixture({
    'block-inline.ts': `function invalid(
  value: number /* @fit 0..10 */,
) {
  return value
}
`,
  }, dir => {
    const check = runFr(['check', 'block-inline.ts'], dir)
    expectCli(check.exitCode === 2, 'expected inline block @fit to be rejected', check.output)
    expectCli(check.output.includes('Block @fit comments are only supported for function, loop, and type contract blocks; use // @fit for attached facts'), 'expected inline block @fit guidance', check.output)
  })

  await withCliFixture({
    'syntax.ts': `function invalid(value: number.) {
  return value
}
const =
`,
  }, dir => {
    const check = runFr(['check', 'syntax.ts'], dir)
    expectCli(check.exitCode === 2, 'expected syntax errors to stop fr check', check.output)
    expectCli(check.output.includes('fr: Syntax errors in syntax.ts:'), 'expected syntax error header', check.output)
    expectCli(check.output.includes('Syntax error in syntax.ts:1:32 TS1003: Identifier expected.'), 'expected first TypeScript syntax diagnostic', check.output)
    expectCli(check.output.includes('Syntax error in syntax.ts:4:7 TS1134: Variable declaration expected.'), 'expected second TypeScript syntax diagnostic', check.output)
  })

  console.log('cli: 29 expected behaviors')
}

function runFr(args: string[], cwd = repoDir) {
  return runProcess([process.execPath, pathJoin(repoDir, 'fr.ts'), ...args], cwd)
}

function runProcess(cmd: string[], cwd = repoDir) {
  const decoder = new TextDecoder()
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  }
}

async function withCliFixture(files: Record<string, string>, run: (dir: string) => void | Promise<void>) {
  const dir = pathJoin('/tmp', `freerange-cli-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`)
  const mkdir = runProcess(['mkdir', '-p', dir])
  expectCli(mkdir.exitCode === 0, `expected to create ${dir}`, mkdir.output)
  try {
    for (const [file, text] of Object.entries(files)) {
      await Bun.write(pathJoin(dir, file), text)
    }
    await run(dir)
  } finally {
    const cleanup = runProcess(['rm', '-rf', dir])
    expectCli(cleanup.exitCode === 0, `expected to remove ${dir}`, cleanup.output)
  }
}

function expectCli(condition: boolean, message: string, output: string) {
  if (condition) return
  console.error(message)
  console.error(output.trimEnd())
  process.exitCode = 1
}

function pathJoin(first: string, ...rest: string[]) {
  let path = first.endsWith('/') ? first.slice(0, -1) : first
  for (const part of rest) path += '/' + part.replace(/^\/+/, '')
  return path
}
