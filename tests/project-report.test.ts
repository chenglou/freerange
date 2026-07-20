import {expect, test} from 'bun:test'
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import * as ts from 'typescript'
import {formatTypeScriptDiagnostics} from '../src/typescript/diagnostics.ts'

const freerangeCli = new URL('../fr.ts', import.meta.url).pathname

function runCli(cwd: string, ...arguments_: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, freerangeCli, ...arguments_],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function writeProject(
  directory: string,
  files: Record<string, string>,
  compilerOptions: Record<string, unknown> = {},
): void {
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ESNext',
      module: 'ESNext',
      ...compilerOptions,
    },
    include: ['**/*.ts'],
  }))
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
}

test('TypeScript diagnostics use its plain and colored formats', () => {
  const diagnostic: ts.Diagnostic = {
    category: ts.DiagnosticCategory.Error,
    code: 9999,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText: 'example error',
  }
  expect(formatTypeScriptDiagnostics([diagnostic], {pretty: false}, process.cwd()))
    .toBe('error TS9999: example error\n')
  expect(formatTypeScriptDiagnostics([diagnostic], {pretty: true}, process.cwd()))
    .toContain('\u001B[91merror\u001B[0m')
})

test('bare fr prints known problems while audit retains caller requirements', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-lint-'))
  try {
    writeProject(projectDirectory, {'contracts.ts': `export function divide(width: number, columnCount: number): number {
  return width / columnCount
}

export function outOfBounds(): number {
  const values = [1]
  return values[2]!
}
`})

    const result = runCli(projectDirectory)

    // Findings are the CI gate: the out-of-bounds error must fail the run.
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.stdout).toStartWith('contracts.ts(7,10): error [out-of-bounds-read]')
    expect(result.stdout).not.toContain('\u001B[')
    expect(result.stdout).not.toContain('caller-contract')
    expect(result.stdout).toContain('error [out-of-bounds-read]: asserted element read (arr[i]!) is provably out of bounds')
    expect(result.stdout).toContain('1 finding (1 error, 0 warnings).')
    expect(result.stdout).toContain('coverage: 1/2 named top-level function declarations fully analyzed; 1 partially supported; 0 unsupported.')
    expect(result.stdout).toContain('Run `fr --audit [file]` for every function\'s contracts and refactoring suggestions.')
    expect(existsSync(join(projectDirectory, 'freerange-report'))).toBe(false)

    const colored = Bun.spawnSync({
      cmd: [process.execPath, freerangeCli],
      cwd: projectDirectory,
      env: {...process.env, NO_COLOR: '', FORCE_COLOR: '1'},
      stdout: 'pipe',
      stderr: 'pipe',
    }).stdout.toString()
    expect(colored).toContain('\u001B[96mcontracts.ts\u001B[0m:\u001B[93m7\u001B[0m:\u001B[93m10\u001B[0m - \u001B[91merror\u001B[0m')
    expect(colored).toContain('\u001B[90m [out-of-bounds-read]: \u001B[0m')

    const coloredAudit = Bun.spawnSync({
      cmd: [process.execPath, freerangeCli, '--audit'],
      cwd: projectDirectory,
      env: {...process.env, NO_COLOR: '', FORCE_COLOR: '1'},
      stdout: 'pipe',
      stderr: 'pipe',
    }).stdout.toString()
    expect(coloredAudit).toContain('# \u001B[96mcontracts.ts\u001B[0m (')
    expect(coloredAudit).toContain('division at \u001B[96mcontracts.ts\u001B[0m:\u001B[93m2\u001B[0m:\u001B[93m10\u001B[0m')

    // `fr <file>` is the project findings narrowed to that file: the finding lines are
    // identical, only the coverage counts are the file's own.
    const targeted = runCli(projectDirectory, 'contracts.ts')
    expect(targeted.exitCode).toBe(1)
    const findingLines = (output: string) => output.split('\n\n')[0]
    expect(findingLines(targeted.stdout)).toBe(findingLines(result.stdout))
    expect(targeted.stdout).toContain('coverage: 1/2 named top-level function declarations fully analyzed; 1 partially supported; 0 unsupported.')
    expect(targeted.stdout).not.toContain('requires:')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('module initialization failures are findings in project and file mode alike', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-initializer-'))
  try {
    // Both loops provably never exit, so loading either module never finishes — a
    // definite problem TypeScript accepts without complaint. Contracts moved behind
    // `fr --audit`, so the findings mode must carry these itself at both granularities.
    writeProject(projectDirectory, {
      'module-loop.ts': `while (true) {}
export function answer(): number { return 42 }
`,
      'stuck-counter.ts': `let ticks = 0
while (ticks < 10) {
  // ticks never advances
}
export function count(): number { return ticks }
`,
    })

    const result = runCli(projectDirectory)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const loopWarning = 'module-loop.ts(1,1): warning [non-exiting-loop]: loop in module initialization has no analyzable exit; it may never terminate'
    const counterWarning = 'stuck-counter.ts(2,1): warning [non-exiting-loop]: loop in module initialization has no analyzable exit; it may never terminate'
    expect(result.stdout).toContain(loopWarning)
    expect(result.stdout).toContain(counterWarning)
    expect(result.stdout).not.toContain('No lint findings.')
    expect(result.stdout).toContain('2 findings (0 errors, 2 warnings).')

    // The file mode prints the same finding line; a warning informs but does not gate.
    const targeted = runCli(projectDirectory, 'stuck-counter.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stdout).toContain(counterWarning)
    expect(targeted.stdout).not.toContain('module-loop.ts')
    expect(targeted.stdout).toContain('1 finding (0 errors, 1 warning).')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('ordinary initializer stops and skips do not mint findings', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-initializer-negative-'))
  try {
    writeProject(projectDirectory, {
      // The top-level new Date() call is outside the analyzed subset, so the module
      // analysis skips the statement — ordinary unsupported code, not a proven defect.
      'skipped-statement.ts': `const startedAt = new Date().toISOString()
export function label(): string { return startedAt }
`,
      // The top-level call stops because the callee reads a binding that is not yet
      // initialized — a real crash at load, but the initializer only records the cascade
      // (calls readLater, which could not be fully analyzed for this specific call), which
      // in general proves nothing, so
      // no finding prints. The stop still surfaces through the audit's contracts.
      'partial-call.ts': `export function readLater(): number { return gap * 2 }
const early = readLater()
const gap = 24
export function answer(): number { return early }
`,
    })

    const result = runCli(projectDirectory)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('No lint findings.')
    const audited = runCli(projectDirectory, '--audit', 'partial-call.ts')
    expect(audited.stdout).toContain('partially supported: calls readLater, which could not be fully analyzed for this specific call')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('project audit prints one unit per file and the file audit is a literal slice', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-audit-'))
  try {
    writeProject(projectDirectory, {'advice.ts': `export function divide(width: number, columnCount: number): number {
  return width / columnCount
}

export function divideAgain(width: number, columnCount: number): number {
  return divide(width, columnCount)
}

export function defaultWidth(width: number): number {
  return width || 1
}

export function clean(): number {
  return 24
}
`})

    const projectAudit = runCli(projectDirectory, '--audit')

    expect(projectAudit.exitCode).toBe(0)
    expect(projectAudit.stderr).toBe('')
    expect(projectAudit.stdout).toStartWith('# advice.ts (3/4 functions fully analyzed; 1 unsupported)')
    expect(projectAudit.stdout.trimEnd()).toEndWith('coverage: 3/4 named top-level function declarations fully analyzed; 0 partially supported; 1 unsupported.')
    // Analysis entries come before suggestions within the unit.
    expect(projectAudit.stdout.indexOf('## Contracts')).toBeLessThan(projectAudit.stdout.indexOf('## Refactoring suggestions'))
    expect(projectAudit.stdout).toContain('requires: columnCount is nonzero (division at advice.ts:2:10)')
    expect(projectAudit.stdout).toContain('advice.ts(2,10): suggestion [guard-derived-value]: Check the exact divisor.')
    expect(projectAudit.stdout).toContain('advice.ts(2,10): suggestion [encode-input-rule]: Encode a real input rule where the calculation begins.')
    expect(projectAudit.stdout.split('suggestion [guard-derived-value]')).toHaveLength(2)
    expect(projectAudit.stdout).not.toContain('Example rewrite:')

    // The file audit is character-for-character a slice of the project output.
    const fileAudit = runCli(projectDirectory, '--audit', 'advice.ts')
    expect(fileAudit.exitCode).toBe(0)
    expect(fileAudit.stdout).toStartWith('# advice.ts (')
    const unit = fileAudit.stdout.trim()
    expect(projectAudit.stdout).toContain(unit)

    const extraPath = runCli(projectDirectory, '--audit', 'advice.ts', 'other.ts')
    expect(extraPath.exitCode).toBe(1)
    expect(extraPath.stderr).toContain('Usage: fr --audit [file]')

    const extraReportPath = runCli(projectDirectory, 'advice.ts', 'other.ts')
    expect(extraReportPath.exitCode).toBe(1)
    expect(extraReportPath.stderr).toContain('Usage: fr [file]')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('console.assert failures gate lint while the audit also shows successful checks', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-console-assert-'))
  try {
    writeProject(projectDirectory, {'assertions.ts': `function unsupported(value: number): number {
  return [value].reduce((total, item) => total + item, 0)
}

function requiresNonnegative(value: number): number {
  console.assert(value >= 0)
  return value
}

export function badCall(): number {
  return requiresNonnegative(-1)
}

export function proven(value: number): number {
  const bounded = Math.max(0, value)
  console.assert(bounded >= 0)
  return bounded
}

export function unproven(value: number): number {
  const result = value
  console.assert(result >= 0)
  return result
}

export function refuted(value: number): number {
  const positive = Math.max(1, value)
  console.assert(positive < 0)
  return positive
}

export function blocked(value: number): number {
  const result = unsupported(value)
  console.assert(result >= 0)
  return result
}

export function blockedRequirement(value: number): number {
  console.assert(value >= 0)
  return unsupported(value)
}

export function dead(value: number): number {
  const positive = Math.max(1, value)
  if (positive < 0) console.assert(value >= 0)
  return value
}

export function invalid(value: number): number {
  console.assert(value >= 0, 'nonnegative')
  return value
}

export function invalidNegation(value: number): number {
  const result = value
  console.assert(!(result < 0))
  return result
}

console.assert(true)
`})

    const lint = runCli(projectDirectory)
    expect(lint.exitCode).toBe(1)
    expect(lint.stderr).toBe('')
    expect(lint.stdout).toContain('error [declared-requirement]: call to requiresNonnegative makes its declared requirement definitely false')
    expect(lint.stdout).toContain('error [console-assert]: could not prove console.assert condition in unproven: result >= 0')
    expect(lint.stdout).toContain('error [console-assert]: console.assert condition can be false in refuted: positive < 0')
    expect(lint.stdout).toContain('error [console-assert]: could not check console.assert condition in blocked; the function did not finish analysis without site-specific assumptions: result >= 0')
    expect(lint.stdout).toContain('error [console-assert]: console.assert requirements in blockedRequirement were not checked because the function did not finish analysis without site-specific assumptions')
    expect(lint.stdout).toContain('error [console-assert]: console.assert is unreachable in dead: value >= 0')
    expect(lint.stdout).toContain('console.assert must have exactly one condition argument in invalid')
    expect(lint.stdout).toContain('console.assert must contain one direct numeric comparison using ===, !==, <, <=, >, or >=, or a supported Number check in invalidNegation')
    expect(lint.stdout).toContain('console.assert is only supported inside a named top-level function declaration')
    expect(lint.stdout).not.toContain('bounded >= 0')

    const audit = runCli(projectDirectory, '--audit')
    expect(audit.exitCode).toBe(0)
    expect(audit.stderr).toBe('')
    expect(audit.stdout).toContain('proves: bounded >= 0')
    expect(audit.stdout).toContain('assertion unproven: could not prove result >= 0')
    expect(audit.stdout).toContain('assertion can fail: positive < 0')
    expect(audit.stdout).toContain('assertion blocked: the function did not finish analysis without site-specific assumptions: result >= 0')
    expect(audit.stdout).toContain('unreachable assertion: value >= 0')
    expect(audit.stdout).toContain('console.assert must contain one direct numeric comparison using ===, !==, <, <=, >, or >=, or a supported Number check')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('definitely false inferred requirements gate lint at visible call sites', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-inferred-requirement-'))
  try {
    writeProject(projectDirectory, {
      'bounds.ts': `function at(values: number[], index: number): number {
  return values[index]!
}

function wrappedAt(values: number[], index: number): number {
  return at(values, index)
}

export function badBounds(): number {
  return at([1], 2)
}

export function badWrappedBounds(): number {
  return wrappedAt([1], 2)
}

export function safeBounds(): number {
  return at([1], 0)
}
`,
      'requirements.ts': `function aspectRatio(width: number, height: number): number {
  return width / height
}

function wrappedAspectRatio(width: number, height: number): number {
  return aspectRatio(width, height)
}

function remainder(value: number, divisor: number): number {
  return value % divisor
}

export function impossible(): number {
  return 1 / 0
}

export function badDirect(): number {
  return aspectRatio(10, 0)
}

export function badWrapped(): number {
  return wrappedAspectRatio(10, 0)
}

export function badRemainder(): number {
  return remainder(10, 0)
}

export function safe(): number {
  return aspectRatio(10, 2)
}
`,
      'skipped.ts': `function aspectRatio(width: number, height: number): number {
  return width / height
}

console.log(aspectRatio(10, 0))
export {}
`,
      'safe-skips.ts': `function aspectRatio(width: number, height: number): number {
  return width / height
}

function logger(): Console {
  return console
}

console.log(aspectRatio(10, 2))
console.log(Math.hypot(3, 4), aspectRatio(10, 0))
logger().log(aspectRatio(10, 0))
export {}
`,
      'skipped-bounds.ts': `function at(values: number[], index: number): number {
  return values[index]!
}

console.log(at([1], 2))
export {}
`,
      'finite.ts': `function identity(value: number): number {
  return value
}

export function badFiniteInput(): number {
  return identity(Infinity)
}
`,
    })

    const lint = runCli(projectDirectory)
    expect(lint.exitCode).toBe(1)
    expect(lint.stderr).toBe('')
    expect(lint.stdout).toContain('bounds.ts(10,10): error [inferred-requirement]: call to at makes an asserted element read definitely out of bounds (element read at bounds.ts(2,10))')
    expect(lint.stdout).toContain('bounds.ts(14,10): error [inferred-requirement]: call to wrappedAt makes an asserted element read definitely out of bounds (element read at bounds.ts(2,10))')
    expect(lint.stdout).not.toContain('bounds.ts(18,10): error')
    expect(lint.stdout).toContain('skipped-bounds.ts(5,13): error [inferred-requirement]: call to at makes an asserted element read definitely out of bounds')
    expect(lint.stdout).toContain('requirements.ts(14,10): error [inferred-requirement]: division has a divisor that is definitely zero in impossible')
    expect(lint.stdout).toContain('requirements.ts(18,10): error [inferred-requirement]: call to aspectRatio violates its nonzero divisor requirement')
    expect(lint.stdout).toContain('requirements.ts(22,10): error [inferred-requirement]: call to wrappedAspectRatio violates its nonzero divisor requirement')
    expect(lint.stdout).toContain('requirements.ts(26,10): error [inferred-requirement]: call to remainder violates its nonzero divisor requirement')
    expect(lint.stdout).toContain('skipped.ts(5,13): error [inferred-requirement]: call to aspectRatio violates its nonzero divisor requirement')
    expect(lint.stdout).toContain('finite.ts(6,10): error [inferred-requirement]: call to identity passes a number that is definitely not finite (input declared at finite.ts(1,19))')
    expect(lint.stdout).not.toContain('finite.ts(6,10): error [declared-requirement]')
    expect(lint.stdout).not.toContain('requirements.ts(30,10): error')
    expect(lint.stdout).not.toContain('safe-skips.ts(9')
    expect(lint.stdout).not.toContain('safe-skips.ts(10')
    expect(lint.stdout).not.toContain('safe-skips.ts(11')
    expect(lint.stdout).not.toContain('caller-contract')

    const audit = runCli(projectDirectory, '--audit')
    expect(audit.exitCode).toBe(0)
    expect(audit.stderr).toBe('')
    expect(audit.stdout).toContain('call to aspectRatio violates its nonzero divisor requirement')
    expect(audit.stdout).toContain('call to at makes an asserted element read definitely out of bounds')
    expect(audit.stdout).toContain('function call console.log at skipped.ts:5:1')
    expect(audit.stdout).toContain('function call console.log at skipped-bounds.ts:5:1')
    expect(audit.stdout).toContain('function call console.log at safe-skips.ts:9:1')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('project mode requires strict null checks but respects other project options', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-options-'))
  try {
    writeProject(projectDirectory, {'optional-and-index.ts': `type Config = {width?: number}
const config: Config = {width: undefined}
export function width(): number { return config.width ?? 0 }
export function indexed(values: number[], index: number): number | undefined { return values[index] }
export function increment(values: number[], index: number): number { return values[index] + 1 }
export function guardedIncrement(values: number[], index: number): number {
  const value = values[index]
  if (value === undefined) return 1
  return value + 1
}
export function ignoresImplicitAny(value): number { return 1 }
`}, {
      strict: false,
      strictNullChecks: true,
      noImplicitAny: false,
      noUncheckedIndexedAccess: false,
      exactOptionalPropertyTypes: false,
    })

    const targeted = runCli(projectDirectory, '--audit', 'optional-and-index.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stderr).toBe('')
    expect(targeted.stdout).toContain('return is undefined or a finite number')
    expect(targeted.stdout).toContain('uses a possibly missing array element without handling undefined')
    expect(targeted.stdout).toContain(`ignoresImplicitAny
  ensures: return is a finite integer number from 1 through 1`)

    const projectAudit = runCli(projectDirectory, '--audit')
    expect(projectAudit.exitCode).toBe(0)
    expect(projectAudit.stdout).toContain('optional-and-index.ts(5,77): suggestion [handle-missing-element]: Handle a possibly missing array element.')

    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {strict: false},
      include: ['optional-and-index.ts'],
    }))
    const withoutNullChecks = runCli(projectDirectory)
    expect(withoutNullChecks.exitCode).toBe(1)
    expect(withoutNullChecks.stderr).toContain('freerange requires strictNullChecks')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('solution configs include references and govern targeted formatting', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-upward-config-'))
  try {
    const packageDirectory = join(projectDirectory, 'packages', 'geometry')
    const nestedDirectory = join(packageDirectory, 'src', 'nested')
    mkdirSync(nestedDirectory, {recursive: true})
    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {pretty: false},
      files: [],
      references: [{path: './packages/geometry'}],
    }))
    writeFileSync(join(packageDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        composite: true,
        target: 'ESNext',
        module: 'ESNext',
        rootDir: 'src',
        outDir: 'dist',
        pretty: true,
      },
      include: ['src/**/*.ts'],
    }))
    writeFileSync(join(packageDirectory, 'src', 'answer.ts'),
      'export function answer(value: number, divisor: number): number { return value / divisor }\nanswer(1, 0)\n')

    const result = runCli(projectDirectory)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toStartWith('packages/geometry/src/answer.ts(')
    expect(result.stdout).toContain('coverage: 1/1 named top-level function declarations fully analyzed')
    const targeted = runCli(projectDirectory, 'packages/geometry/src/answer.ts')
    expect(targeted.exitCode).toBe(1)
    expect(targeted.stdout.split('\n')[0]).toBe(result.stdout.split('\n')[0])
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('targeted fr uses only the requested file while bare fr checks the whole project', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-targeted-config-'))
  try {
    writeProject(projectDirectory, {
      'src/constants.ts': 'export const GAP = 24\n',
      'src/target.ts': `import {GAP} from '@constants'
export function gap(): number { return GAP }
`,
      'src/broken.ts': "export const broken: number = 'bad'\n",
    }, {
      moduleResolution: 'Bundler',
      paths: {'@constants': ['./src/constants.ts']},
    })

    const full = runCli(projectDirectory)
    expect(full.exitCode).toBe(1)
    expect(full.stderr).toContain("src/broken.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(full.stdout).toBe('')

    const fullAudit = runCli(projectDirectory, '--audit')
    expect(fullAudit.exitCode).toBe(1)
    expect(fullAudit.stderr).toBe(full.stderr)
    expect(fullAudit.stdout).toBe('')

    const targeted = runCli(join(projectDirectory, 'src'), 'target.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stderr).not.toContain('broken.ts')
    expect(targeted.stdout).toContain('No lint findings.')
    expect(targeted.stdout).toContain('coverage: 1/1 named top-level function declarations fully analyzed; 0 partially supported; 0 unsupported.')

    const targetedAudit = runCli(join(projectDirectory, 'src'), '--audit', 'target.ts')
    expect(targetedAudit.exitCode).toBe(0)
    expect(targetedAudit.stderr).not.toContain('broken.ts')
    expect(targetedAudit.stdout).toStartWith('# target.ts (')
    expect(targetedAudit.stdout).not.toContain('src/target.ts')
    expect(targetedAudit.stdout).toContain('return is a finite integer number from 24 through 24')

    const missing = runCli(join(projectDirectory, 'src'), 'missing.ts')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('File not found:')
    expect(missing.stderr).toContain('missing.ts')

    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: {'@constants': ['./src/constants.ts']},
        types: ['missing-types-package'],
      },
      include: ['src/**/*.ts'],
    }))
    const globalTypeError = runCli(projectDirectory)
    expect(globalTypeError.exitCode).toBe(1)
    expect(globalTypeError.stderr).toContain("Cannot find type definition file for 'missing-types-package'.")
    expect(globalTypeError.stdout).toBe('')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

// The two nested-tsconfig tests below pin the configuration rule: both modes resolve the
// tsconfig from the current directory, so the file argument narrows the output, never the
// configuration. A tsconfig sitting next to the file must not change which compiler
// options govern it, in either layout direction.
const nestedTsconfigSource = `export function scale(amount) {
  return amount * 3
}

export function divide(numerator: number, denominator: number): number {
  return numerator / denominator
}
`
const laxOptions = {strict: false, strictNullChecks: true}

test('a nested lax tsconfig cannot hide the root project errors from the file run', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-nested-lax-'))
  try {
    writeProject(projectDirectory, {
      'main.ts': 'export function double(value: number): number { return value * 2 }\n',
      'sub/loose.ts': nestedTsconfigSource,
      'sub/tsconfig.json': JSON.stringify({compilerOptions: laxOptions, include: ['*.ts']}),
    })

    // The strict root config governs sub/loose.ts, so its implicit any stops both the
    // project run and the file run before Freerange output.
    const project = runCli(projectDirectory)
    expect(project.exitCode).toBe(1)
    expect(project.stderr).toContain("sub/loose.ts(1,23): error TS7006: Parameter 'amount' implicitly has an 'any' type.")
    expect(project.stdout).toBe('')

    const targeted = runCli(projectDirectory, 'sub/loose.ts')
    expect(targeted.exitCode).toBe(1)
    expect(targeted.stderr).toContain("sub/loose.ts(1,23): error TS7006: Parameter 'amount' implicitly has an 'any' type.")
    expect(targeted.stdout).toBe('')

    // Audit mode uses the same TypeScript-only failure path.
    const projectAudit = runCli(projectDirectory, '--audit')
    expect(projectAudit.exitCode).toBe(1)
    expect(projectAudit.stderr).toBe(project.stderr)
    expect(projectAudit.stdout).toBe('')
    const fileAudit = runCli(projectDirectory, '--audit', 'sub/loose.ts')
    expect(fileAudit.exitCode).toBe(1)
    expect(fileAudit.stdout).toBe('')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('a nested strict tsconfig cannot fail a file the project run accepts', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-nested-strict-'))
  try {
    writeProject(projectDirectory, {
      'main.ts': 'export function double(value: number): number { return value * 2 }\n',
      'sub/loose.ts': nestedTsconfigSource,
      'sub/tsconfig.json': JSON.stringify({compilerOptions: {strict: true}, include: ['*.ts']}),
    }, laxOptions)

    // The lax root config governs sub/loose.ts, so both runs accept it. Its caller
    // requirement belongs to the audit rather than the findings output.
    const project = runCli(projectDirectory)
    expect(project.exitCode).toBe(0)
    expect(project.stderr).toBe('')
    expect(project.stdout).toContain('No lint findings.')

    const targeted = runCli(projectDirectory, 'sub/loose.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stderr).toBe('')
    for (const line of targeted.stdout.split('\n\n')[0]!.split('\n')) {
      expect(project.stdout).toContain(line)
    }
    expect(targeted.stdout).toContain('0 findings (0 errors, 0 warnings).')

    const audit = runCli(projectDirectory, '--audit', 'sub/loose.ts')
    expect(audit.stdout).toContain('requires: denominator is nonzero')

  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('a file outside the project is rejected in both file modes', () => {
  // File mode is a subset of project mode. A file omitted by the cwd-resolved tsconfig
  // has no project result to select, so it cannot silently become a separate program.
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-outside-project-'))
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'freerange-outside-fixture-'))
  try {
    writeProject(projectDirectory, {'main.ts': 'export function ok(): number { return 1 }\n'})
    const fixture = join(fixtureDirectory, 'fixture.ts')
    writeFileSync(fixture, nestedTsconfigSource)
    const alias = join(fixtureDirectory, 'main-alias.ts')
    symlinkSync(join(projectDirectory, 'main.ts'), alias)

    const throughAlias = runCli(projectDirectory, alias)
    expect(throughAlias.exitCode).toBe(0)
    expect(throughAlias.stdout).toContain('No lint findings.')

    for (const args of [[fixture], ['--audit', fixture]]) {
      const result = runCli(projectDirectory, ...args)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('File is not part of the project resolved from')
    }
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
    rmSync(fixtureDirectory, {recursive: true, force: true})
  }
})

test('targeted fr has fallback options while project commands require a tsconfig', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-no-config-'))
  try {
    writeFileSync(join(directory, 'width.ts'), 'export function width(): number { return 24 }\n')

    const targeted = runCli(directory, 'width.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stdout).toContain('No lint findings.')

    const targetedAudit = runCli(directory, '--audit', 'width.ts')
    expect(targetedAudit.exitCode).toBe(0)
    expect(targetedAudit.stdout).toContain('return is a finite integer number from 24 through 24')

    for (const arguments_ of [[], ['--audit']]) {
      const projectCommand = runCli(directory, ...arguments_)
      expect(projectCommand.exitCode).toBe(1)
      expect(projectCommand.stderr).toContain('No tsconfig.json found')
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
