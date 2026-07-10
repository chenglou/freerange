import {expect, test} from 'bun:test'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as ts from 'typescript'
import {runProject} from '../src/project.ts'
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

test('project reports group caller contracts by their originating operation', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-report-'))
  try {
    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {strict: true, target: 'ESNext', module: 'ESNext'},
      include: ['contracts.ts'],
    }))
    writeFileSync(join(projectDirectory, 'contracts.ts'), `export function divide(width: number, columnCount: number): number {
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
`)

    const outputDirectory = join(projectDirectory, 'report')
    runProject(projectDirectory, outputDirectory)

    expect(readFileSync(join(outputDirectory, 'LINT.txt'), 'utf8')).toBe(`freerange lint: actionable failures and caller obligations from analyzed functions.
error   = provably wrong on some reachable path.
warning = an analyzed path may fail to terminate.
note    = a contract outside callers must uphold; unverifiable from this repo alone.
The full value analysis (every function, every range) lives in the per-file reports.

contracts.ts:2:10  note  this division requires 7 caller conditions  [caller-contract]
  divide: columnCount is nonzero
  direct: columnCount is nonzero
  wrapper: columnCount is nonzero
  adapted: (width - gap) is nonzero
  twoCalls: first is nonzero
  twoCalls: second is nonzero
  duplicateCall: divisor is nonzero
contracts.ts:22:10  note  callers of twoDivisions must keep first is nonzero (division at contracts.ts:22:10)  [caller-contract]
contracts.ts:22:10  note  callers of twoDivisions must keep second is nonzero (division at contracts.ts:22:10)  [caller-contract]
contracts.ts:26:10  note  callers of remainder must keep modulus is nonzero (remainder at contracts.ts:26:10)  [caller-contract]
contracts.ts:34:10  note  2 divisions require 1 caller condition  [caller-contract]
  also at contracts.ts:34:28
  repeatedOperations: divisor is nonzero
contracts.ts:43:10  error  asserted element read (arr[i]!) is provably out of bounds in outOfBounds  [out-of-bounds-read]
`)

    const summary = readFileSync(join(outputDirectory, 'SUMMARY.txt'), 'utf8')
    expect(summary).toContain(`requires (12):
  contracts.ts divide: columnCount is nonzero (division at contracts.ts:2:10)
  contracts.ts direct: columnCount is nonzero (division at contracts.ts:2:10)
  contracts.ts wrapper: columnCount is nonzero (division at contracts.ts:2:10)
  contracts.ts adapted: (width - gap) is nonzero (division at contracts.ts:2:10)
  contracts.ts twoDivisions: first is nonzero (division at contracts.ts:22:10)
  contracts.ts twoDivisions: second is nonzero (division at contracts.ts:22:10)
  contracts.ts remainder: modulus is nonzero (remainder at contracts.ts:26:10)
  contracts.ts twoCalls: first is nonzero (division at contracts.ts:2:10)
  contracts.ts twoCalls: second is nonzero (division at contracts.ts:2:10)
  contracts.ts repeatedOperations: divisor is nonzero (division at contracts.ts:34:10)
  contracts.ts repeatedOperations: divisor is nonzero (division at contracts.ts:34:28)
  contracts.ts duplicateCall: divisor is nonzero (division at contracts.ts:2:10)
`)

    const fileReport = readFileSync(join(outputDirectory, 'contracts.ts.txt'), 'utf8')
    expect(fileReport).toContain(`wrapper
  requires: columnCount is nonzero (division at contracts.ts:2:10)`)
    expect(fileReport).toContain(`adapted
  requires: (width - gap) is nonzero (division at contracts.ts:2:10)`)
    expect(fileReport).not.toContain('guarded\n  requires:')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('project mode requires strict null checks but respects other project options', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-options-'))
  try {
    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: false,
        strictNullChecks: true,
        noImplicitAny: false,
        noUncheckedIndexedAccess: false,
        exactOptionalPropertyTypes: false,
        target: 'ESNext',
        module: 'ESNext',
      },
      include: ['optional-and-index.ts'],
    }))
    writeFileSync(join(projectDirectory, 'optional-and-index.ts'), `type Config = {width?: number}
const config: Config = {width: undefined}
export function width(): number { return config.width ?? 0 }
export function indexed(values: number[], index: number): number | undefined { return values[index] }
export function ignoresImplicitAny(value): number { return 1 }
`)

    const outputDirectory = join(projectDirectory, 'report')
    runProject(projectDirectory, outputDirectory)

    const analyzed = readFileSync(join(outputDirectory, 'optional-and-index.ts.txt'), 'utf8')
    expect(analyzed).not.toContain('TYPE ERRORS')
    expect(analyzed).toContain('return is undefined or a finite number')
    expect(analyzed).toContain(`ignoresImplicitAny
  ensures: return is a finite integer number from 1 through 1`)
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('project mode rejects a config without strict null checks', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-null-checks-'))
  try {
    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {strict: false},
      include: ['file.ts'],
    }))
    writeFileSync(join(projectDirectory, 'file.ts'), 'export const width = 1\n')

    expect(() => runProject(projectDirectory, join(projectDirectory, 'report')))
      .toThrow('freerange requires strictNullChecks')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('bare fr searches upward and writes the complete report at the project root', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-upward-config-'))
  try {
    const nestedDirectory = join(projectDirectory, 'src', 'nested')
    mkdirSync(nestedDirectory, {recursive: true})
    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {strict: true, target: 'ESNext', module: 'ESNext'},
      include: ['src/**/*.ts'],
    }))
    writeFileSync(join(projectDirectory, 'src', 'width.ts'),
      'export function width(): number { return 24 }\n')

    const result = runCli(nestedDirectory)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"files":1')
    expect(existsSync(join(projectDirectory, 'freerange-report', 'src__width.ts.txt'))).toBe(true)
    expect(existsSync(join(nestedDirectory, 'freerange-report'))).toBe(false)
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('a solution config analyzes its declared project references', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-project-references-'))
  try {
    const packageDirectory = join(projectDirectory, 'packages', 'geometry')
    mkdirSync(join(packageDirectory, 'src'), {recursive: true})
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
      'export function answer(): number { return 42 }\n')

    const outputDirectory = join(projectDirectory, 'report')
    const result = runProject(projectDirectory, outputDirectory)

    expect(result.hasTypeScriptErrors).toBe(false)
    expect(readFileSync(join(outputDirectory, 'packages__geometry__src__answer.ts.txt'), 'utf8'))
      .toContain('return is a finite integer number from 42 through 42')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('targeted fr uses the project config and prints only that file diagnostics and report', () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'freerange-targeted-config-'))
  try {
    mkdirSync(join(projectDirectory, 'src'))
    writeFileSync(join(projectDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: {'@constants': ['./src/constants.ts']},
      },
      include: ['src/**/*.ts'],
    }))
    writeFileSync(join(projectDirectory, 'src', 'constants.ts'), 'export const GAP = 24\n')
    writeFileSync(join(projectDirectory, 'src', 'target.ts'), `import {GAP} from '@constants'
export function gap(): number { return GAP }
`)
    writeFileSync(join(projectDirectory, 'src', 'broken.ts'), "export const broken: number = 'bad'\n")

    const full = runCli(projectDirectory)
    expect(full.exitCode).toBe(1)
    expect(full.stderr).toContain("src/broken.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.")
    const fullFileReport = readFileSync(
      join(projectDirectory, 'freerange-report', 'src__target.ts.txt'),
      'utf8',
    ).trim()

    const targeted = runCli(join(projectDirectory, 'src'), 'target.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stderr).not.toContain('broken.ts')
    expect(targeted.stdout).toContain(fullFileReport)
    expect(targeted.stdout).toContain('return is a finite integer number from 24 through 24')
  } finally {
    rmSync(projectDirectory, {recursive: true, force: true})
  }
})

test('targeted fr falls back without a config while bare fr requires a project', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-no-config-'))
  try {
    writeFileSync(join(directory, 'width.ts'), 'export function width(): number { return 24 }\n')

    const targeted = runCli(directory, 'width.ts')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stdout).toContain('return is a finite integer number from 24 through 24')

    const bare = runCli(directory)
    expect(bare.exitCode).toBe(1)
    expect(bare.stderr).toContain('No tsconfig.json found')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
