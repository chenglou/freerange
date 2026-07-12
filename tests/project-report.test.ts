import {expect, test} from 'bun:test'
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import * as ts from 'typescript'
import {auditPreamble} from '../src/audit.ts'
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

test('bare fr prints grouped lint findings and coverage without writing artifacts', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-lint-'))
  try {
    writeProject(projectDirectory, {'contracts.ts': `export function divide(width: number, columnCount: number): number {
  return width / columnCount
}

export function direct(width: number, columnCount: number): number {
  return divide(width, columnCount)
}

export function wrapper(width: number, columnCount: number): number {
  return direct(width, columnCount)
}

export function adapted(width: number, gap: number): number {
  return divide(width, width - gap)
}

export function guarded(width: number, columnCount: number): number {
  return columnCount === 0 ? 0 : divide(width, columnCount)
}

export function twoDivisions(value: number, first: number, second: number): number {
  return value / first / second
}

export function remainder(value: number, modulus: number): number {
  return value % modulus
}

export function twoCalls(value: number, first: number, second: number): number {
  return divide(value, first) + divide(value, second)
}

export function repeatedOperations(value: number, divisor: number): number {
  return value / divisor + value / divisor
}

export function duplicateCall(value: number, divisor: number): number {
  return divide(value, divisor) + divide(value, divisor)
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
    expect(result.stdout).toStartWith('contracts.ts(2,10): note [caller-contract]: this division requires 7 caller conditions')
    expect(result.stdout).not.toContain('Notes are caller conditions')
    expect(result.stdout).not.toContain('\u001B[')
    expect(result.stdout).toContain('  wrapper: columnCount is nonzero')
    expect(result.stdout).toContain('  adapted: (width - gap) is nonzero')
    expect(result.stdout).not.toContain('guarded: columnCount is nonzero')
    expect(result.stdout).toContain('2 divisions require 1 caller condition')
    expect(result.stdout).toContain('error [out-of-bounds-read]: asserted element read (arr[i]!) is provably out of bounds')
    expect(result.stdout).toContain('6 findings (1 error, 0 warnings, 5 notes).')
    expect(result.stdout).toContain('coverage: 10/11 named top-level function declarations fully analyzed; 1 partial; 0 unsupported; 0/1 project files skipped for TypeScript errors.')
    expect(result.stdout).toContain('Run `fr --audit [file]` for every function\'s contracts and refactoring suggestions.')
    expect(existsSync(join(projectDirectory, 'freerange-report'))).toBe(false)

    const colored = Bun.spawnSync({
      cmd: [process.execPath, freerangeCli],
      cwd: projectDirectory,
      env: {...process.env, NO_COLOR: '', FORCE_COLOR: '1'},
      stdout: 'pipe',
      stderr: 'pipe',
    }).stdout.toString()
    expect(colored).toContain('\u001B[96mcontracts.ts\u001B[0m:\u001B[93m2\u001B[0m:\u001B[93m10\u001B[0m - \u001B[96mnote\u001B[0m')
    expect(colored).toContain('\u001B[90m [caller-contract]: \u001B[0m')

    // `fr <file>` is the project findings narrowed to that file: the finding lines are
    // identical, only the coverage counts are the file's own.
    const targeted = runCli(projectDirectory, 'contracts.ts')
    expect(targeted.exitCode).toBe(1)
    const findingLines = (output: string) => output.split('\n\n')[0]
    expect(findingLines(targeted.stdout)).toBe(findingLines(result.stdout))
    expect(targeted.stdout).toContain('coverage: 10/11 named top-level function declarations fully analyzed; 1 partial; 0 unsupported; 0/1 project files skipped for TypeScript errors.')
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
    expect(result.stdout).toContain('2 findings (0 errors, 2 warnings, 0 notes).')

    // The file mode prints the same finding line; a warning informs but does not gate.
    const targeted = runCli(projectDirectory, 'stuck-counter.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stdout).toContain(counterWarning)
    expect(targeted.stdout).not.toContain('module-loop.ts')
    expect(targeted.stdout).toContain('1 finding (0 errors, 1 warning, 0 notes).')
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
      // (calls readLater, whose analysis stopped), which in general proves nothing, so
      // no finding prints. The stop still surfaces through the audit's contracts.
      'stopped-call.ts': `export function readLater(): number { return gap * 2 }
const early = readLater()
const gap = 24
export function answer(): number { return early }
`,
    })

    for (const arguments_ of [[], ['skipped-statement.ts'], ['stopped-call.ts']]) {
      const result = runCli(projectDirectory, ...arguments_)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('No lint findings.')
    }
    const audited = runCli(projectDirectory, '--audit', 'stopped-call.ts')
    expect(audited.stdout).toContain('stopped: calls readLater, whose analysis stopped for this specific call')
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
    // The explanatory prose prints once at the top, then one unit per file, then the
    // project coverage once at the end.
    expect(projectAudit.stdout).toStartWith(`${auditPreamble}\n\n# advice.ts (3/4 functions fully analyzed; 1 unsupported)`)
    expect(projectAudit.stdout.split('Refactoring suggestions are conditional examples')).toHaveLength(2)
    expect(projectAudit.stdout.trimEnd()).toEndWith('coverage: 3/4 named top-level function declarations fully analyzed; 0 partial; 1 unsupported; 0/1 project files skipped for TypeScript errors.')
    // Contracts come before suggestions within the unit — a planned `fr --check`
    // snapshot mode will diff the contracts portion.
    expect(projectAudit.stdout.indexOf('## Contracts')).toBeLessThan(projectAudit.stdout.indexOf('## Refactoring suggestions'))
    expect(projectAudit.stdout).toContain(`divide
  requires: columnCount is nonzero (division at advice.ts:2:10)`)
    expect(projectAudit.stdout).toContain('### Check the exact divisor')
    expect(projectAudit.stdout).toContain('**Encode a real input rule where the calculation begins.**')

    // The file audit is the project audit narrowed to the file: same preamble, and the
    // file's unit is character-for-character a slice of the project output.
    const fileAudit = runCli(projectDirectory, '--audit', 'advice.ts')
    expect(fileAudit.exitCode).toBe(0)
    expect(fileAudit.stdout).toStartWith(`${auditPreamble}\n\n# advice.ts (`)
    const unit = fileAudit.stdout.slice(auditPreamble.length).trim()
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

test('error-level findings gate the exit code while the audit stays informational', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-exit-codes-'))
  try {
    writeProject(projectDirectory, {'wrong.ts': `export function wrong(): number {
  const values = [1]
  return values[2]!
}
`})

    // Findings mode is the CI gate at both granularities.
    expect(runCli(projectDirectory).exitCode).toBe(1)
    expect(runCli(projectDirectory, 'wrong.ts').exitCode).toBe(1)
    // The audit reports the same file without gating; it fails only on TypeScript errors.
    expect(runCli(projectDirectory, '--audit').exitCode).toBe(0)
    expect(runCli(projectDirectory, '--audit', 'wrong.ts').exitCode).toBe(0)
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
    expect(projectAudit.stdout).toContain('### Handle a possibly missing array element')
    expect(projectAudit.stdout).toContain('in increment')
    expect(projectAudit.stdout).not.toContain('in guardedIncrement')

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

test('bare fr searches upward and solution configs include their project references', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-upward-config-'))
  try {
    const packageDirectory = join(projectDirectory, 'packages', 'geometry')
    const nestedDirectory = join(packageDirectory, 'src', 'nested')
    mkdirSync(nestedDirectory, {recursive: true})
    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
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
      },
      include: ['src/**/*.ts'],
    }))
    writeFileSync(join(packageDirectory, 'src', 'answer.ts'),
      'export function answer(value: number, divisor: number): number { return value / divisor }\n')

    const result = runCli(nestedDirectory)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toStartWith('../answer.ts(')
    expect(result.stdout).not.toContain('packages/geometry/src/answer.ts')
    expect(result.stdout).toContain('coverage: 1/1 named top-level function declarations fully analyzed')
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
    expect(full.stdout).toContain('coverage: 1/1 named top-level function declarations fully analyzed; 0 partial; 0 unsupported; 1/3 project files skipped for TypeScript errors.')

    const targeted = runCli(join(projectDirectory, 'src'), 'target.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stderr).not.toContain('broken.ts')
    expect(targeted.stdout).toContain('No lint findings.')
    expect(targeted.stdout).toContain('coverage: 1/1 named top-level function declarations fully analyzed; 0 partial; 0 unsupported; 0/1 project files skipped for TypeScript errors.')

    const targetedAudit = runCli(join(projectDirectory, 'src'), '--audit', 'target.ts')
    expect(targetedAudit.exitCode).toBe(0)
    expect(targetedAudit.stderr).not.toContain('broken.ts')
    expect(targetedAudit.stdout).toContain('\n# target.ts (')
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
    expect(globalTypeError.stdout).toContain('3/3 project files skipped for TypeScript errors.')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
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
