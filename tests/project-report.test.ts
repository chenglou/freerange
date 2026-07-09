import {expect, test} from 'bun:test'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runProject} from '../src/project.ts'

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
