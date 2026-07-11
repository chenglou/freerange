import {expect, test} from 'bun:test'
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
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

    expect(result.exitCode).toBe(0)
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

    const targeted = runCli(projectDirectory, 'contracts.ts')
    expect(targeted.stdout).toContain(`wrapper
  requires: columnCount is nonzero (division at contracts.ts:2:10)`)
    expect(targeted.stdout).toContain(`adapted
  requires: (width - gap) is nonzero (division at contracts.ts:2:10)`)
    expect(targeted.stdout).not.toContain('guarded\n  requires:')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('bare fr reports failures in module initialization', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-initializer-'))
  try {
    writeProject(projectDirectory, {'module-loop.ts': `while (true) {}
export function answer(): number { return 42 }
`})

    const result = runCli(projectDirectory)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('module-loop.ts(1,1): warning [non-exiting-loop]: loop in module initialization has no analyzable exit; it may never terminate')
    expect(result.stdout).not.toContain('No lint findings.')
    expect(result.stdout).toContain('1 finding (0 errors, 1 warning, 0 notes).')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('project audit is a concise index while file audit keeps the detailed guide', () => {
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
    expect(projectAudit.stdout).toStartWith('advice.ts (3/4 functions fully analyzed; 1 unsupported)')
    expect(projectAudit.stdout).toContain('[guard-derived-value, encode-input-rule]')
    expect(projectAudit.stdout).toContain('[write-explicit-condition]')
    expect(projectAudit.stdout).toContain('2 matched locations in 1 file.')
    expect(projectAudit.stdout).toContain('coverage: 3/4 named top-level function declarations fully analyzed; 0 partial; 1 unsupported; 0/1 project files skipped for TypeScript errors.')
    expect(projectAudit.stdout).not.toContain('export function remap')

    const fileAudit = runCli(projectDirectory, '--audit', 'advice.ts')
    expect(fileAudit.exitCode).toBe(0)
    expect(fileAudit.stdout).toContain('### Check the exact divisor')
    expect(fileAudit.stdout).toContain('**Encode a real input rule where the calculation begins.**')

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

    const targeted = runCli(projectDirectory, 'optional-and-index.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stderr).toBe('')
    expect(targeted.stdout).toContain('return is undefined or a finite number')
    expect(targeted.stdout).toContain('uses a possibly missing array element without handling undefined')
    expect(targeted.stdout).toContain(`ignoresImplicitAny
  ensures: return is a finite integer number from 1 through 1`)

    const projectAudit = runCli(projectDirectory, '--audit')
    expect(projectAudit.exitCode).toBe(0)
    expect(projectAudit.stdout).toContain('increment: Handle a possibly missing array element')
    expect(projectAudit.stdout).toContain('[handle-missing-element]')
    expect(projectAudit.stdout).not.toContain('guardedIncrement:')

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
    expect(targeted.stdout).toContain('\ntarget.ts\n\n')
    expect(targeted.stdout).not.toContain('\nsrc/target.ts\n')
    expect(targeted.stdout).toContain('return is a finite integer number from 24 through 24')

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
    expect(targeted.stdout).toContain('return is a finite integer number from 24 through 24')

    for (const arguments_ of [[], ['--audit']]) {
      const projectCommand = runCli(directory, ...arguments_)
      expect(projectCommand.exitCode).toBe(1)
      expect(projectCommand.stderr).toContain('No tsconfig.json found')
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
