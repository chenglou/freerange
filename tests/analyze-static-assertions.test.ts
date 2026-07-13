import {describe, expect, test} from 'bun:test'
import * as ts from 'typescript'
import {analyzeCheckedSource} from '../src/analyze.ts'
import {analyzeFile, analyzeSource} from '../src/index.ts'
import {createReport} from '../src/report/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

const fixture = new URL('./fixtures/console-assertions.ts', import.meta.url).pathname

describe('static console.assert contracts', () => {
  test('leading requirements narrow the body and propagate through calls', () => {
    const report = analyzeFile(fixture)

    const declared = analyzedFunction(report, 'requiredNonnegative')
    expect(declared.requires).toHaveLength(1)
    expect(declared.requires[0]).toContain('value >= 0')
    expect(declared.assertions?.map(assertion => assertion.verdict)).toEqual(['proven'])
    expect(declared.ensures).toEqual(['return is a finite number at least 0'])

    const consecutive = analyzedFunction(report, 'requiredPositiveInteger')
    expect(consecutive.requires.map(requirement => requirement.split(' (declared')[0])).toEqual([
      'Number.isInteger(value)',
      'value >= 1',
    ])
    expect(consecutive.requires.some(requirement => requirement.includes('division'))).toBe(false)

    expect(analyzedFunction(report, 'propagatedRequirement').requires[0])
      .toContain('(width - 1) >= 0')
    expect(analyzedFunction(report, 'safeCaller').requires).toEqual([])

    for (const name of ['unsafeCaller', 'unsafeWrapper']) {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn == null || fn.kind !== 'partial') throw new Error(`Expected ${name} to be partial`)
      expect(fn.stopped).toHaveLength(1)
      expect(fn.stopped[0]).toContain('declared requirement definitely false')
    }
    const wrapper = report.functions.find(candidate => candidate.name === 'unsafeWrapper')
    if (wrapper?.kind !== 'partial') throw new Error('Expected unsafeWrapper to be partial')
    expect(wrapper.stopped[0]).toContain('call to unsafeCaller')
    expect(wrapper.stopped[0]).toContain('declared at tests/fixtures/console-assertions.ts:6:3')

    const unnameable = report.functions.find(candidate => candidate.name === 'unnameableCaller')
    if (unnameable == null || unnameable.kind !== 'partial') {
      throw new Error('Expected unnameableCaller to be partial')
    }
    expect(unnameable.stopped[0]).toContain('could not express or prove')
    expect(unnameable.stopped[0]).toContain('requiredNonnegative')

    expect(analyzedFunction(report, 'callsRequiredThrow').requires[0]).toContain('value >= 0')
  })

  test('the configured global console works without the DOM library', () => {
    const program = ts.createProgram({
      rootNames: [fixture],
      options: {
        strict: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ['lib.esnext.d.ts'],
        types: ['bun'],
        noEmit: true,
      },
    })
    const sourceFile = program.getSourceFile(fixture)
    if (sourceFile == null) throw new Error('TypeScript did not load the assertion fixture')
    const detailed = analyzeCheckedSource({sourceFile, checker: program.getTypeChecker()})
    const report = createReport(detailed.program, detailed.analysis)
    expect(analyzedFunction(report, 'requiredNonnegative').requires[0]).toContain('value >= 0')
  })

  test('assertions report every verdict without narrowing later code', () => {
    const report = analyzeFile(fixture)
    expect(analyzedFunction(report, 'unprovenThenProven').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven', 'proven'])
    expect(analyzedFunction(report, 'refuted').assertions?.map(assertion => assertion.verdict))
      .toEqual(['refuted'])
    expect(analyzedFunction(report, 'refutedThenProven').assertions?.map(assertion => assertion.verdict))
      .toEqual(['refuted', 'proven'])
    expect(analyzedFunction(report, 'dead').assertions?.map(assertion => assertion.verdict))
      .toEqual(['dead'])
    expect(analyzedFunction(report, 'assertionsDoNotNarrow').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven', 'unproven'])
  })

  test('asserted functions must complete without site-specific assumptions', () => {
    const report = analyzeFile(fixture)
    const verdicts = (name: string): string[] => {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn == null || fn.kind !== 'partial') throw new Error(`Expected ${name} to be partial`)
      return fn.assertions?.map(assertion => assertion.verdict) ?? []
    }

    expect(verdicts('stoppedAfterAssertion')).toEqual(['blocked'])
    expect(analyzedFunction(report, 'assumptionAfterAssertion').assertions?.map(assertion => assertion.verdict))
      .toEqual(['blocked'])
  })

  test('the static spelling has a small syntax boundary', () => {
    const report = analyzeSource('static-boundary.ts', `
      export function message(value: number): number {
        console.assert(value >= 0, 'nonnegative')
        return value
      }
      export function compound(value: number): number {
        const result = value
        console.assert(result >= 0 && result <= 10)
        return result
      }
      function isPositive(value: number): boolean { return value > 0 }
      export function called(value: number): number {
        const result = value
        console.assert(isPositive(result))
        return result
      }
      export function constant(value: number): number {
        console.assert(true)
        return value
      }
      export function optional(value: number): number {
        console.assert?.(value >= 0)
        return value
      }
      export function expressionPosition(value: number): number {
        const ignored = console.assert(value >= 0)
        void ignored
        return value
      }
      export function relationalRequirement(left: number, right: number): number {
        console.assert(left <= right)
        return left
      }
      export function finiteRequirement(value: number): number {
        console.assert(Number.isFinite(value))
        return value
      }
      export function inlineDivision(value: number, divisor: number): number {
        const result = value
        console.assert(Number.isFinite(result / divisor))
        return result
      }
      export function inlineRemainder(value: number, divisor: number): number {
        const result = value
        console.assert(result % divisor === 0)
        return result
      }
      export function inlineIndex(values: number[], index: number): number {
        const result = 1
        console.assert(Number.isFinite(values[index]!))
        return result
      }
      export function shadowed(
        console: {assert(condition: boolean): void},
        value: number,
      ): number {
        console.assert(value >= 0)
        return value
      }
    `)
    const entries = new Map(report.functions.map(fn => [fn.name, fn]))
    for (const name of [
      'message',
      'compound',
      'called',
      'constant',
      'optional',
      'expressionPosition',
      'relationalRequirement',
      'finiteRequirement',
      'inlineDivision',
      'inlineRemainder',
      'inlineIndex',
    ]) {
      const fn = entries.get(name)
      if (fn?.kind !== 'unsupported') throw new Error(`Expected ${name} to be unsupported`)
      expect(fn.unsupported).toContain('console.assert')
    }
    const shadowed = entries.get('shadowed')
    if (shadowed?.kind !== 'unsupported') throw new Error('Expected shadowed to be unsupported')
    expect(shadowed.unsupported).toContain('function parameter with type')
    expect(shadowed.unsupported).not.toContain('console.assert')
  })

  test('local producer proofs serve assertions without changing ordinary branches', () => {
    const report = analyzeSource('assertion-producers.ts', `
      export function producerProofs(
        rawBase: number,
        rawOffset: number,
        rawFactor: number,
        rawCap: number,
        rawDivisor: number,
        natural: number,
      ): number {
        const base = Math.max(0, Math.min(100, rawBase))
        const offset = Math.max(0, Math.min(100, rawOffset))
        const upper = base + offset
        console.assert(base <= upper)
        const lower = upper - offset
        console.assert(lower <= upper)

        const minimum = Math.min(base, upper)
        const maximum = Math.max(base, upper)
        console.assert(minimum <= base)
        console.assert(base <= maximum)

        const factor = Math.max(1, Math.min(10, rawFactor))
        const scaledBase = base * factor
        const scaledUpper = upper * factor
        console.assert(scaledBase <= scaledUpper)

        const cap = Math.max(0, rawCap)
        const cappedBase = Math.min(cap, base)
        const cappedUpper = Math.min(cap, upper)
        console.assert(cappedBase <= cappedUpper)

        const divisor = Math.max(1, Math.floor(rawDivisor))
        const dividend = Math.max(0, Math.floor(rawBase))
        const remainder = dividend % divisor
        console.assert(remainder < divisor)

        const frame = {left: base, right: upper, nested: {edge: upper}}
        console.assert(frame.left <= frame.right)
        console.assert(frame.nested.edge === upper)

        const width = Math.max(1, rawBase)
        const minimumHeight = width * 0.5
        const maximumHeight = width * 2
        const height = Math.min(Math.max(minimumHeight, natural), maximumHeight)
        console.assert(minimumHeight <= height)
        console.assert(height <= maximumHeight)
        return height
      }

      export function negativeControls(rawBase: number, rawOffset: number): number {
        const base = Math.max(0, rawBase)
        const negativeOffset = Math.min(-1, rawOffset)
        const lower = base + negativeOffset
        console.assert(base <= lower)

        const upper = base + Math.max(0, rawOffset)
        const negativeFactor = Math.min(-1, rawOffset)
        console.assert(base * negativeFactor <= upper * negativeFactor)

        const nan = 0 * Infinity
        console.assert(nan === nan)

        const overflow = 1.7976931348623157e308 + 1.7976931348623157e308
        const zeroTimesOverflow = 0 * overflow
        console.assert(0 <= zeroTimesOverflow)

        const invalidRemainder = Infinity % 2
        console.assert(invalidRemainder < 2)

        const nanClamp = Math.min(10, nan)
        console.assert(nanClamp <= 10)

        const rounded = 9007199254740992 + 1
        console.assert(rounded > 9007199254740992)
        return lower
      }

      export function ordinaryBranch(rawBase: number, rawOffset: number): number {
        const base = Math.max(0, rawBase)
        const upper = base + Math.max(0, rawOffset)
        if (base <= upper) return 1
        return 0
      }

      export function assertedValueDoesNotStrengthenBranch(rawBase: number, rawOffset: number): number {
        const base = Math.max(0, rawBase)
        const upper = base + Math.max(0, rawOffset)
        const ordered = base <= upper
        console.assert(ordered)
        if (ordered) return 1
        return 0
      }
    `)

    expect(analyzedFunction(report, 'producerProofs').assertions?.map(assertion => assertion.verdict))
      .toEqual(Array.from({length: 11}, () => 'proven'))
    expect(analyzedFunction(report, 'negativeControls').assertions?.map(assertion => assertion.verdict))
      .toEqual([
        'unproven',
        'unproven',
        'unproven',
        'unproven',
        'unproven',
        'unproven',
        'refuted',
      ])
    expect(analyzedFunction(report, 'ordinaryBranch').ensures)
      .toEqual(['return is a finite integer number from 0 through 1'])
    const shared = analyzedFunction(report, 'assertedValueDoesNotStrengthenBranch')
    expect(shared.assertions?.map(assertion => assertion.verdict)).toEqual(['proven'])
    expect(shared.ensures).toEqual(['return is a finite integer number from 0 through 1'])
  })

  test('producer proofs compose without a hidden expression-depth limit', () => {
    const additions = Array.from({length: 100}, (_, index) =>
      `const value${index + 1} = value${index} + step`).join('\n')
    const report = analyzeSource('deep-assertion-proof.ts', `
      export function deepProof(rawValue: number, rawStep: number): number {
        const value0 = Math.max(0, rawValue)
        const step = Math.max(0, rawStep)
        ${additions}
        console.assert(value0 <= value100)
        return value100
      }
    `)

    expect(analyzedFunction(report, 'deepProof').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
  })

  test('the assertion-only ordering rules hold at floating-point boundaries', () => {
    const bases = [
      Number.NEGATIVE_INFINITY,
      -Number.MAX_VALUE,
      -9007199254740992,
      -1,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1,
      9007199254740992,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]
    const nonnegative = [0, Number.MIN_VALUE, 1, 9007199254740992, Number.MAX_VALUE, Number.POSITIVE_INFINITY]

    for (const base of bases) {
      for (const offset of nonnegative) {
        const sum = base + offset
        if (!Number.isNaN(sum)) expect(base <= sum).toBe(true)
        const difference = base - offset
        if (!Number.isNaN(difference)) expect(difference <= base).toBe(true)
      }
    }

    for (const left of bases) {
      for (const right of bases) {
        if (!(left <= right)) continue
        for (const factor of nonnegative) {
          const leftProduct = left * factor
          const rightProduct = right * factor
          if (!Number.isNaN(leftProduct) && !Number.isNaN(rightProduct)) {
            expect(leftProduct <= rightProduct).toBe(true)
          }
        }
      }
    }

    const finiteDividends = bases.filter(Number.isFinite)
    for (const dividend of finiteDividends) {
      for (const divisor of nonnegative.filter(value => value > 0)) {
        const remainder = dividend % divisor
        if (!Number.isNaN(remainder)) expect(remainder < divisor).toBe(true)
      }
    }
  })
})
