import {describe, expect, test} from 'bun:test'
import * as ts from 'typescript'
import {analyzeCheckedSource} from '../src/analyze.ts'
import {analyzeFile, analyzeSource} from '../src/index.ts'
import {createReport} from '../src/report/index.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

const fixture = new URL('./fixtures/console-assertions.ts', import.meta.url).pathname
const importedFixture = new URL('./fixtures/console-assertions-imported.ts', import.meta.url).pathname
const fixtureReport = analyzeFile(fixture)

describe('static console.assert contracts', () => {
  test('leading requirements narrow the body and propagate through calls', () => {
    const report = fixtureReport

    const declared = analyzedFunction(report, 'requiredNonnegative')
    expect(requirementsBesidesInputFiniteness(declared)).toHaveLength(1)
    expect(requirementsBesidesInputFiniteness(declared)[0]).toContain('value >= 0')
    expect(declared.assertions?.map(assertion => assertion.verdict)).toEqual(['proven'])
    expect(declared.ensures).toEqual(['return is a finite number at least 0'])

    const consecutive = analyzedFunction(report, 'requiredPositiveInteger')
    expect(requirementsBesidesInputFiniteness(consecutive).map(requirement => requirement.split(' (declared')[0])).toEqual([
      'Number.isInteger(value)',
      'value >= 1',
    ])
    expect(requirementsBesidesInputFiniteness(consecutive).some(requirement => requirement.includes('division'))).toBe(false)

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'propagatedRequirement'))[0])
      .toContain('(width - 1) >= 0')
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'safeCaller'))).toEqual([])

    for (const name of ['unsafeCaller', 'unsafeWrapper']) {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn == null || fn.kind !== 'partial') throw new Error(`Expected ${name} to be partial`)
      expect(fn.partialReasons).toHaveLength(1)
      expect(fn.partialReasons[0]).toContain('declared requirement definitely false')
    }
    const wrapper = report.functions.find(candidate => candidate.name === 'unsafeWrapper')
    if (wrapper?.kind !== 'partial') throw new Error('Expected unsafeWrapper to be partial')
    expect(wrapper.partialReasons[0]).toContain('call to unsafeCaller')
    expect(wrapper.partialReasons[0]).toContain('declared at tests/fixtures/console-assertions.ts:6:3')

    const unnameable = report.functions.find(candidate => candidate.name === 'unnameableCaller')
    if (unnameable == null || unnameable.kind !== 'partial') {
      throw new Error('Expected unnameableCaller to be partial')
    }
    expect(unnameable.partialReasons[0]).toContain('could not express or prove')
    expect(unnameable.partialReasons[0]).toContain('requiredNonnegative')

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'callsRequiredThrow'))[0]).toContain('value >= 0')
  })

  test('leading requirements accept literal const names and see parameter defaults', () => {
    const aliases = Array.from({length: 100}, (_, index) =>
      `const MINIMUM_${index + 1} = MINIMUM_${index}`).join('\n')
    const report = analyzeSource('requirement-defaults.ts', `
      const MINIMUM_0 = +0
      ${aliases}
      const MINIMUM_WIDTH = MINIMUM_100
      const COMPUTED_MINIMUM = 0 + 0
      let MUTABLE_MINIMUM = 0

      function bounded(width: number = 5): number {
        console.assert(width >= MINIMUM_WIDTH)
        return width
      }
      function invalidDefault(width: number = -1): number {
        console.assert(width >= MINIMUM_WIDTH)
        return width
      }
      export function omittedSafe(): number {
        return bounded()
      }
      export function explicitUndefinedSafe(): number {
        return bounded(undefined)
      }
      export function omittedInvalid(): number {
        return invalidDefault()
      }
      export function computedConstant(width: number): number {
        console.assert(width >= COMPUTED_MINIMUM)
        return width
      }
      export function mutableConstant(width: number): number {
        console.assert(width >= MUTABLE_MINIMUM)
        return width
      }
    `)

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'bounded'))[0]).toContain('width >= 0')
    expect(analyzedFunction(report, 'omittedSafe').ensures).toEqual([
      'return is a finite integer number from 5 through 5',
    ])
    expect(analyzedFunction(report, 'explicitUndefinedSafe').ensures).toEqual([
      'return is a finite integer number from 5 through 5',
    ])
    const invalid = report.functions.find(fn => fn.name === 'omittedInvalid')
    if (invalid?.kind !== 'partial') throw new Error('Expected omittedInvalid to be partial')
    expect(invalid.partialReasons[0]).toContain('declared requirement definitely false')
    const computed = report.functions.find(fn => fn.name === 'computedConstant')
    if (computed?.kind !== 'unsupported') throw new Error('Expected computedConstant to be unsupported')
    expect(computed.unsupported).toContain('leading console.assert describes what callers must provide')
    const mutable = report.functions.find(fn => fn.name === 'mutableConstant')
    if (mutable?.kind !== 'unsupported') throw new Error('Expected mutableConstant to be unsupported')
    expect(mutable.unsupported).toContain('leading console.assert describes what callers must provide')
  })

  test('leading requirements accept imported numeric literal constants', () => {
    const report = analyzeFile(importedFixture)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'importedMinimum'))[0]).toContain('value >= 2')
    expect(analyzedFunction(report, 'callsImportedMinimum').ensures).toEqual([
      'return is a finite integer number from 2 through 2',
    ])
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
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'requiredNonnegative'))[0]).toContain('value >= 0')
  })

  test('assertions report every verdict without narrowing later code', () => {
    const report = fixtureReport
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

  test('leading constant comparisons stay requirements and discharge immediately', () => {
    const report = analyzeSource('constant-assertions.ts', `
      const MINIMUM = 5

      export function proven(): void {
        console.assert(6 > 5)
      }
      export function refuted(): void {
        console.assert(MINIMUM > 6)
      }
      export function stillRequires(value: number): number {
        console.assert(6 > 5)
        console.assert(value >= 0)
        return value
      }
    `)

    const proven = analyzedFunction(report, 'proven')
    expect(requirementsBesidesInputFiniteness(proven)).toEqual([])
    expect(proven.assertions).toBeUndefined()

    const refuted = report.functions.find(fn => fn.name === 'refuted')
    if (refuted?.kind !== 'partial') throw new Error('Expected refuted to be partial')
    expect(refuted.partialReasons[0]).toContain('declared requirement is false')

    const stillRequires = analyzedFunction(report, 'stillRequires')
    expect(requirementsBesidesInputFiniteness(stillRequires)[0]).toContain('value >= 0')
    expect(stillRequires.assertions).toBeUndefined()
  })

  test('asserted functions must complete without site-specific assumptions', () => {
    const report = fixtureReport
    const verdicts = (name: string): string[] => {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn == null || fn.kind !== 'partial') throw new Error(`Expected ${name} to be partial`)
      return fn.assertions?.map(assertion => assertion.verdict) ?? []
    }

    expect(verdicts('partialAfterAssertion')).toEqual(['blocked'])
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
      export function inlineArithmetic(left: number, right: number): number {
        const result = right
        console.assert(left + 1 <= right)
        return result
      }
      export function storedCondition(left: number, right: number): number {
        const ordered = left <= right
        console.assert(ordered)
        return right
      }
      export function directMath(value: number): number {
        const result = value
        console.assert(Math.min(0, value) <= value)
        return result
      }
      export function booleanEquality(flag: boolean, value: number): number {
        const result = flag
        console.assert(result === result)
        return value
      }
      export function negated(value: number): number {
        const result = value
        console.assert(!(result < 0))
        return result
      }
      export function looseEquality(value: number): number {
        const result = value
        console.assert(result == 0)
        return result
      }
      export function positiveLiteral(value: number): number {
        const bounded = Math.max(0, value)
        console.assert(bounded >= +0)
        return bounded
      }
      export function writtenNumberCheck(value: number): number {
        const result = value
        console.assert(Number.isFinite(result))
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
      'inlineDivision',
      'inlineRemainder',
      'inlineIndex',
      'inlineArithmetic',
      'storedCondition',
      'directMath',
      'booleanEquality',
      'negated',
      'looseEquality',
    ]) {
      const fn = entries.get(name)
      if (fn?.kind !== 'unsupported') throw new Error(`Expected ${name} to be unsupported`)
      expect(fn.unsupported).toContain('console.assert')
    }
    const unsupported = (name: string): string => {
      const fn = entries.get(name)
      if (fn?.kind !== 'unsupported') throw new Error(`Expected ${name} to be unsupported`)
      return fn.unsupported
    }
    expect(unsupported('compound')).toContain('one direct numeric comparison')
    expect(unsupported('called')).toContain('cannot call a function')
    expect(unsupported('constant')).toContain('one direct numeric comparison')
    expect(unsupported('relationalRequirement')).toContain('describes what callers must provide')
    expect(analyzedFunction(report, 'finiteRequirement').requires[0]).toContain('Number.isFinite(value)')
    expect(unsupported('inlineDivision')).toContain('calculate or read the value before console.assert')
    expect(unsupported('inlineIndex')).toContain('calculate or read the value before console.assert')
    expect(unsupported('storedCondition')).toContain('one direct numeric comparison')
    expect(unsupported('booleanEquality')).toContain('one direct numeric comparison')
    expect(unsupported('negated')).toContain('one direct numeric comparison')
    expect(unsupported('looseEquality')).toContain('using ===, !==, <, <=, >, or >=')
    const shadowed = entries.get('shadowed')
    if (shadowed?.kind !== 'unsupported') throw new Error('Expected shadowed to be unsupported')
    expect(shadowed.unsupported).toContain('function parameter with type')
    expect(shadowed.unsupported).not.toContain('console.assert')
    expect(analyzedFunction(report, 'writtenNumberCheck').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
    expect(analyzedFunction(report, 'positiveLiteral').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
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
        const scaledBase = base * negativeFactor
        const scaledUpper = upper * negativeFactor
        console.assert(scaledBase <= scaledUpper)

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
        console.assert(base <= upper)
        if (ordered) return 1
        return 0
      }

      function readEntry(values: number[], index: number): number {
        return values[index]!
      }

      export function calleeFactsReachProducerProofs(
        values: number[],
        index: number,
        base: number,
      ): number {
        readEntry(values, index)
        const shifted = base + index
        console.assert(base <= shifted)
        return shifted
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
    expect(analyzedFunction(report, 'calleeFactsReachProducerProofs').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
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

  test('producer composition does not become general transitivity', () => {
    const report = analyzeSource('assertion-transitivity.ts', `
      export function noStoredRelation(left: number, middle: number, right: number): number {
        if (left > middle) throw new Error('out of order')
        if (middle > right) throw new Error('out of order')
        console.assert(left <= right)
        return right
      }
    `)

    expect(analyzedFunction(report, 'noStoredRelation').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
  })

  test('aggregate selection proofs expand only one side', () => {
    const report = analyzeSource('assertion-selection-composition.ts', `
      export function selectionComposition(rawValue: number): number {
        const left0 = Math.max(0, rawValue)
        const left1 = left0 + 1
        const right0 = left1 + 1
        const right1 = right0 + 1
        const left = Math.max(left0, left1)
        const right = Math.min(right0, right1)
        const repeatedMaximum = Math.max(rawValue, rawValue)
        const repeatedMinimum = Math.min(rawValue, rawValue)
        console.assert(rawValue <= repeatedMinimum)
        console.assert(repeatedMaximum <= rawValue)
        console.assert(left <= right)
        return right
      }
    `)

    expect(analyzedFunction(report, 'selectionComposition').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven', 'unproven'])
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
