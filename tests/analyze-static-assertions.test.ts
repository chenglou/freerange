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
    const detailed = analyzeCheckedSource({sourceFile, program})
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
      export function equalityRequirement(left: number, right: number): number {
        console.assert(left === right)
        return left
      }
      export function inequalityRequirement(left: number, right: number): number {
        console.assert(left !== right)
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
      'inequalityRequirement',
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
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'relationalRequirement'))[0])
      .toContain('left <= right')
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'equalityRequirement'))[0])
      .toContain('left === right')
    expect(unsupported('inequalityRequirement')).toContain('!== needs one fixed finite number')
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
    const scales = [
      Number.NEGATIVE_INFINITY,
      -Number.MAX_VALUE,
      -1,
      -Number.MIN_VALUE,
      -0,
      ...nonnegative,
    ]

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
        if (left < right) {
          expect(0 < right - left).toBe(true)
          expect(left - right < 0).toBe(true)
        }
        for (const factor of scales) {
          const leftProduct = left * factor
          const rightProduct = right * factor
          if (!Number.isNaN(leftProduct) && !Number.isNaN(rightProduct)) {
            if (factor >= 0) expect(leftProduct <= rightProduct).toBe(true)
            if (factor <= 0) expect(rightProduct <= leftProduct).toBe(true)
          }
          if (factor !== 0) {
            const leftQuotient = left / factor
            const rightQuotient = right / factor
            if (!Number.isNaN(leftQuotient) && !Number.isNaN(rightQuotient)) {
              if (factor > 0) expect(leftQuotient <= rightQuotient).toBe(true)
              if (factor < 0) expect(rightQuotient <= leftQuotient).toBe(true)
            }
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
    expect(9_007_199_254_740_991 + 1).toBe(9_007_199_254_740_992 + 1)
  })

  test('direct order survives joins and completed helpers without becoming transitive', () => {
    const report = analyzeSource('direct-order.ts', `
      export function joinedOrder(left: number, right: number, strictPath: boolean): void {
        if (strictPath) {
          if (left >= right) return
        } else {
          if (left > right) return
        }
        console.assert(left <= right)
        console.assert(left < right)
      }

      function ensureOrder(left: number, right: number): void {
        if (left > right) throw new Error('out of order')
      }

      export function helperOrder(left: number, right: number, offset: number): void {
        ensureOrder(left, right)
        const shiftedLeft = left + offset
        const shiftedRight = right + offset
        console.assert(shiftedLeft <= shiftedRight)
      }

      function ensureStrictOrder(left: number, right: number): void {
        if (left >= right) throw new Error('not strictly ordered')
      }

      export function strictHelperOrder(left: number, right: number): void {
        ensureStrictOrder(left, right)
        console.assert(left < right)
      }

      function maybeEnsureOrder(left: number, right: number, enabled: boolean): void {
        if (!enabled) return
        if (left > right) throw new Error('out of order')
      }

      export function incompleteHelperOrder(left: number, right: number, enabled: boolean): void {
        maybeEnsureOrder(left, right, enabled)
        console.assert(left <= right)
      }

      export function nanFalseBranch(text: string, right: number): void {
        const left = Number.parseFloat(text)
        if (left > right) return
        console.assert(left <= right)
      }

      export function finiteParsed(text: string, right: number): void {
        const left = Number.parseFloat(text)
        if (!Number.isFinite(left)) return
        if (left > right) return
        console.assert(left <= right)
      }

      export function nanTrueBranch(text: string, right: number): void {
        const left = Number.parseFloat(text)
        if (left <= right) console.assert(left <= right)
      }
    `)

    expect(analyzedFunction(report, 'joinedOrder').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'unproven'])
    expect(analyzedFunction(report, 'helperOrder').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
    expect(analyzedFunction(report, 'strictHelperOrder').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
    expect(analyzedFunction(report, 'incompleteHelperOrder').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'nanFalseBranch').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'finiteParsed').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
    expect(analyzedFunction(report, 'nanTrueBranch').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven'])
  })

  test('direct order composes through aligned arithmetic', () => {
    const report = analyzeSource('aligned-order.ts', `
      export function shifted(left: number, right: number, first: number, second: number): void {
        if (left > right) return
        const shiftedLeft = left + first
        const shiftedRight = right + first
        const twiceShiftedLeft = shiftedLeft + second
        const twiceShiftedRight = shiftedRight + second
        console.assert(shiftedLeft <= shiftedRight)
        console.assert(twiceShiftedLeft <= twiceShiftedRight)
      }

      export function unequalOffsets(
        left: number,
        right: number,
        lowerOffset: number,
        upperOffset: number,
      ): void {
        if (left > right) return
        if (lowerOffset > upperOffset) return
        const orderedLeft = left - upperOffset
        const orderedRight = right - lowerOffset
        const reversedLeft = left - lowerOffset
        const reversedRight = right - upperOffset
        console.assert(orderedLeft <= orderedRight)
        console.assert(reversedLeft <= reversedRight)
      }

      export function nonnegativeDifference(left: number, right: number): void {
        if (left > right) return
        const difference = right - left
        const reverseDifference = left - right
        console.assert(0 <= difference)
        console.assert(reverseDifference <= 0)
      }

      export function strictDifference(left: number, right: number): void {
        if (left >= right) return
        const difference = right - left
        const reverseDifference = left - right
        console.assert(0 < difference)
        console.assert(reverseDifference < 0)
      }

      export function noLoopReplacement(left: number, right: number, iterations: number): void {
        let current = left
        if (current > right) return
        for (let index = 0; index < iterations; index += 1) current = right + 1
        console.assert(current <= right)
      }

      export function noFloatingCancellation(left: number, width: number): void {
        const maximumLeft = 1 - width
        if (left > maximumLeft) return
        const right = left + width
        console.assert(right <= 1)
      }

      export function noStrictArithmetic(left: number, right: number, offset: number): void {
        if (left >= right) return
        const shiftedLeft = left + offset
        const shiftedRight = right + offset
        console.assert(shiftedLeft < shiftedRight)
      }

      export function positiveDivision(left: number, right: number, divisor: number): void {
        if (left > right) return
        if (divisor <= 0) return
        const dividedLeft = left / divisor
        const dividedRight = right / divisor
        const dividedTwiceLeft = dividedLeft / divisor
        const dividedTwiceRight = dividedRight / divisor
        console.assert(dividedLeft <= dividedRight)
        console.assert(dividedTwiceLeft <= dividedTwiceRight)
      }

      export function negativeDivision(left: number, right: number, divisor: number): void {
        if (left > right) return
        if (divisor >= 0) return
        const dividedLeft = left / divisor
        const dividedRight = right / divisor
        const dividedTwiceLeft = dividedLeft / divisor
        const dividedTwiceRight = dividedRight / divisor
        console.assert(dividedRight <= dividedLeft)
        console.assert(dividedTwiceLeft <= dividedTwiceRight)
      }

      export function negativeMultiplication(left: number, right: number, factor: number): void {
        const boundedLeft = Math.max(-100, Math.min(100, left))
        const boundedRight = Math.max(-100, Math.min(100, right))
        const negativeFactor = Math.max(-10, Math.min(-1, factor))
        if (boundedLeft > boundedRight) return
        const multipliedLeft = boundedLeft * negativeFactor
        const multipliedRight = boundedRight * negativeFactor
        const multipliedTwiceLeft = multipliedLeft * negativeFactor
        const multipliedTwiceRight = multipliedRight * negativeFactor
        console.assert(multipliedRight <= multipliedLeft)
        console.assert(multipliedTwiceLeft <= multipliedTwiceRight)
      }

      export function nanScaling(): void {
        const zero = 0
        const infinity = Infinity
        const firstProduct = zero * infinity
        const secondProduct = zero * infinity
        const firstQuotient = infinity / infinity
        const secondQuotient = infinity / infinity
        console.assert(firstProduct <= secondProduct)
        console.assert(firstQuotient <= secondQuotient)
      }

      export function unknownDivisionSign(left: number, right: number, divisor: number): void {
        if (left > right) return
        const dividedLeft = left / divisor
        const dividedRight = right / divisor
        console.assert(dividedLeft <= dividedRight)
      }

      export function differentDivisors(
        left: number,
        right: number,
        firstDivisor: number,
        secondDivisor: number,
      ): void {
        if (left > right) return
        if (firstDivisor <= 0 || secondDivisor <= 0) return
        const dividedLeft = left / firstDivisor
        const dividedRight = right / secondDivisor
        console.assert(dividedLeft <= dividedRight)
      }

      export function noStrictDivision(left: number, right: number, divisor: number): void {
        if (left >= right) return
        if (divisor <= 0) return
        const dividedLeft = left / divisor
        const dividedRight = right / divisor
        console.assert(dividedLeft < dividedRight)
      }
    `)

    expect(analyzedFunction(report, 'shifted').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(analyzedFunction(report, 'unequalOffsets').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'unproven'])
    expect(analyzedFunction(report, 'nonnegativeDifference').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(analyzedFunction(report, 'strictDifference').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(analyzedFunction(report, 'noLoopReplacement').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'noFloatingCancellation').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'noStrictArithmetic').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'positiveDivision').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(analyzedFunction(report, 'negativeDivision').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(analyzedFunction(report, 'negativeMultiplication').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(analyzedFunction(report, 'nanScaling').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven', 'unproven'])
    expect(analyzedFunction(report, 'unknownDivisionSign').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'differentDivisors').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'noStrictDivision').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
  })

  test('ordered and equality requirements use direct facts for scalar and record inputs', () => {
    const report = analyzeSource('ordered-requirements.ts', `
      function requireStrict(left: number, right: number): void {
        console.assert(left < right)
      }

      function requireEqual(left: number, right: number, offset: number): void {
        console.assert(left === right)
        const difference = left - right
        const shiftedLeft = left + offset
        const shiftedRight = right + offset
        console.assert(difference === 0)
        console.assert(shiftedLeft === shiftedRight)
      }

      function ensureEqual(left: number, right: number): void {
        if (left !== right) throw new Error('different')
      }

      function requireRecordOrder(bounds: {minimum: number; maximum: number}): void {
        console.assert(bounds.minimum <= bounds.maximum)
      }

      export function guardedStrict(left: number, right: number): void {
        if (left >= right) return
        requireStrict(left, right)
      }

      export function nonstrictIsNotStrict(left: number, right: number): void {
        if (left > right) return
        requireStrict(left, right)
      }

      export function refutedStrict(left: number, right: number): void {
        if (left < right) return
        requireStrict(left, right)
      }

      export function guardedRecord(bounds: {minimum: number; maximum: number}): void {
        if (bounds.minimum > bounds.maximum) return
        requireRecordOrder(bounds)
      }

      export function refutedRecord(): void {
        requireRecordOrder({minimum: 1, maximum: 0})
      }

      export function knownEqual(): void {
        requireEqual(5, 5, 10)
      }

      export function propagatedEqual(left: number, right: number): void {
        requireEqual(left, right, 10)
      }

      export function guardedEqual(left: number, right: number): void {
        if (left !== right) return
        requireEqual(left, right, 10)
      }

      export function refutedEqual(): void {
        requireEqual(5, 6, 10)
      }

      export function helperEqual(left: number, right: number): void {
        ensureEqual(left, right)
        const difference = left - right
        console.assert(difference === 0)
      }

      export function joinedEqual(left: number, right: number, firstPath: boolean): void {
        if (firstPath) {
          if (left !== right) return
        } else if (left !== right) return
        const difference = left - right
        console.assert(difference === 0)
      }

      export function maybeNaNEqual(leftInput: number, rightInput: number): void {
        const left = Math.sqrt(leftInput)
        const right = Math.sqrt(rightInput)
        if (left !== right) return
        const difference = left - right
        console.assert(left === right)
        console.assert(difference === 0)
      }

      export function equalityBoundary(left: number, right: number): void {
        console.assert(left === right)
        const comparedLeft = left
        const squaredLeft = left * left
        const squaredRight = right * right
        console.assert(comparedLeft < right)
        console.assert(comparedLeft !== right)
        console.assert(squaredLeft === squaredRight)
      }
    `)

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'requireStrict'))[0])
      .toContain('left < right')
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'requireRecordOrder'))[0])
      .toContain('bounds.minimum <= bounds.maximum')
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'requireEqual'))[0])
      .toContain('left === right')
    expect(analyzedFunction(report, 'requireEqual').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'guardedStrict'))).toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'nonstrictIsNotStrict'))[0])
      .toContain('left < right')
    for (const name of ['refutedStrict', 'refutedRecord', 'refutedEqual']) {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn?.kind !== 'partial') throw new Error(`Expected ${name} to be partial`)
      expect(fn.partialReasons[0]).toContain('declared requirement definitely false')
    }
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'guardedRecord'))).toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'knownEqual'))).toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'propagatedEqual'))[0])
      .toContain('left === right')
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'guardedEqual'))).toEqual([])
    for (const name of ['helperEqual', 'joinedEqual']) {
      expect(analyzedFunction(report, name).assertions?.map(assertion => assertion.verdict)).toEqual(['proven'])
    }
    expect(analyzedFunction(report, 'maybeNaNEqual').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(analyzedFunction(report, 'equalityBoundary').assertions?.map(assertion => assertion.verdict))
      .toEqual(['refuted', 'refuted', 'unproven'])
  })

  test('a leading two-parameter order requirement proves a min/max clamp and reaches callers', () => {
    const report = analyzeSource('ordered-clamp.ts', `
      function clamp(minimum: number, value: number, maximum: number): number {
        console.assert(maximum >= minimum)
        const result = Math.min(maximum, Math.max(minimum, value))
        console.assert(minimum <= result)
        console.assert(result <= maximum)
        return result
      }

      export function knownBounds(value: number): number {
        return clamp(0, value, 1)
      }

      export function propagatedBounds(minimum: number, value: number, maximum: number): number {
        return clamp(minimum, value, maximum)
      }

      export function guardedBounds(minimum: number, value: number, maximum: number): number {
        if (maximum < minimum) return minimum
        return clamp(minimum, value, maximum)
      }

      export function reversedBounds(value: number): number {
        return clamp(1, value, 0)
      }

      export function noReturnRelationship(
        minimum: number,
        value: number,
        maximum: number,
      ): number {
        if (maximum < minimum) return minimum
        const result = clamp(minimum, value, maximum)
        console.assert(minimum <= result)
        return result
      }

      export function branchClamp(minimum: number, value: number, maximum: number): number {
        console.assert(maximum >= minimum)
        const result = value > maximum ? maximum : value < minimum ? minimum : value
        console.assert(minimum <= result)
        console.assert(result <= maximum)
        return result
      }
    `)

    expect(analyzedFunction(report, 'clamp').assertions?.map(assertion => assertion.verdict))
      .toEqual(['proven', 'proven'])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'knownBounds'))).toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'propagatedBounds'))[0])
      .toContain('maximum >= minimum')
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'guardedBounds'))).toEqual([])
    const reversed = report.functions.find(fn => fn.name === 'reversedBounds')
    if (reversed?.kind !== 'partial') throw new Error('Expected reversedBounds to be partial')
    expect(reversed.partialReasons[0]).toContain('declared requirement definitely false')
    expect(analyzedFunction(report, 'noReturnRelationship').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven'])
    expect(analyzedFunction(report, 'branchClamp').assertions?.map(assertion => assertion.verdict))
      .toEqual(['unproven', 'unproven'])
  })
})

function analyzeWithAssertForms(file: string, source: string): ReturnType<typeof analyzeSource> {
  const previous = process.env['FREERANGE_ASSERT_FORMS']
  process.env['FREERANGE_ASSERT_FORMS'] = '1'
  try {
    return analyzeSource(file, source)
  } finally {
    if (previous === undefined) delete process.env['FREERANGE_ASSERT_FORMS']
    else process.env['FREERANGE_ASSERT_FORMS'] = previous
  }
}

function verdictsOf(report: ReturnType<typeof analyzeSource>, name: string): string[] | undefined {
  return analyzedFunction(report, name).assertions?.map(assertion => assertion.verdict)
}

function unsupportedReasonOf(report: ReturnType<typeof analyzeSource>, name: string): string {
  const fn = report.functions.find(candidate => candidate.name === name)
  if (fn?.kind !== 'unsupported') throw new Error(`Expected ${name} to be unsupported`)
  return fn.unsupported
}

describe('the wider console.assert reading behind FREERANGE_ASSERT_FORMS', () => {
  test('the switch changes only the reading of console.assert', () => {
    const source = `
      export function compound(value: number): number {
        const result = value
        console.assert(result >= 0 && result <= 10)
        return result
      }
    `
    expect(unsupportedReasonOf(analyzeSource('switch-off.ts', source), 'compound'))
      .toContain('one direct numeric comparison')
    expect(verdictsOf(analyzeWithAssertForms('switch-on.ts', source), 'compound'))
      .toEqual(['unproven'])
  })

  test('&& lowers as parts of one assertion and as consecutive requirements', () => {
    const report = analyzeWithAssertForms('conjunctions.ts', `
      export function oneUnconstrained(x: number, y: number): number {
        console.assert(x > 0)
        const result = x
        console.assert(x > 0 && y > 0)
        return result
      }
      export function definitelyZero(y: number): number {
        const x = 0
        console.assert(x > 0 && y > 0)
        return y
      }
      export function bothRequired(x: number, y: number): number {
        console.assert(x > 0 && y > 0)
        const result = x
        console.assert(x > 0 && y > 0)
        return result
      }
      export function callsWithZero(): number {
        return bothRequired(1, 0)
      }
      export function propagates(x: number, y: number): number {
        return bothRequired(x, y)
      }
      export function leadingDisjunction(x: number, y: number): number {
        console.assert(x > 0 || y > 0)
        return x
      }
      export function leadingArithmetic(x: number, y: number): number {
        console.assert(x > 0 && x + 1 < y)
        return x
      }
    `)
    expect(verdictsOf(report, 'oneUnconstrained')).toEqual(['unproven'])
    expect(verdictsOf(report, 'definitelyZero')).toEqual(['refuted'])
    expect(verdictsOf(report, 'bothRequired')).toEqual(['proven'])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'bothRequired')).map(line => line.split(' (declared')[0]))
      .toEqual(['x > 0', 'y > 0'])
    const zero = report.functions.find(fn => fn.name === 'callsWithZero')
    if (zero?.kind !== 'partial') throw new Error('Expected callsWithZero to be partial')
    expect(zero.partialReasons[0]).toContain('declared requirement definitely false')
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'propagates')).map(line => line.split(' (declared')[0]))
      .toEqual(['x > 0', 'y > 0'])
    expect(unsupportedReasonOf(report, 'leadingDisjunction')).toContain('a leading console.assert describes what callers must provide')
    expect(unsupportedReasonOf(report, 'leadingArithmetic')).toContain('calculate or read the value before console.assert')
  })

  test('boolean-valued conditions answer from the held boolean', () => {
    const report = analyzeWithAssertForms('boolean-conditions.ts', `
      export function establishedFlag(value: number): number {
        const flag = true
        const result = value
        console.assert(flag)
        console.assert(!flag)
        return result
      }
      export function branchDoesNotNarrowStoredBoolean(flag: boolean): number {
        if (!flag) return 0
        console.assert(flag)
        console.assert(!flag)
        return 1
      }
      export function unknownFlag(flag: boolean): number {
        const result = 1
        console.assert(flag)
        console.assert(!flag)
        return result
      }
      export function storedOrder(left: number, right: number): number {
        if (left > right) return 0
        const ordered = left <= right
        console.assert(ordered)
        return 1
      }
      export function stringEquality(mode: string): number {
        const result = 1
        console.assert(mode === 'compact')
        return result
      }
    `)
    expect(verdictsOf(report, 'establishedFlag')).toEqual(['proven', 'refuted'])
    expect(verdictsOf(report, 'branchDoesNotNarrowStoredBoolean')).toEqual(['unproven', 'unproven'])
    expect(verdictsOf(report, 'unknownFlag')).toEqual(['unproven', 'unproven'])
    expect(verdictsOf(report, 'storedOrder')).toEqual(['proven'])
    expect(verdictsOf(report, 'stringEquality')).toEqual(['unproven'])
  })

  test('interior || checks the right side under the left side\'s false branch', () => {
    const report = analyzeWithAssertForms('disjunctions.ts', `
      export function neitherSide(x: number, y: number): number {
        const result = x
        console.assert(x > 0 || y > 0)
        return result
      }
      export function leftAlwaysTrue(y: number): number {
        const one = 1
        console.assert(one > 0 || y > 0)
        return y
      }
      export function rightEstablished(x: number, y: number): number {
        if (y <= 0) return 0
        console.assert(x > 0 || y > 0)
        return 1
      }
      export function leftRefinesRight(x: number): number {
        const result = x
        console.assert(x <= 0 || x > 0)
        return result
      }
      export function storedBooleanLeft(x: number): number {
        const pushed = x > 5
        const result = x
        console.assert(pushed || x > 0)
        return result
      }
      export function nanFailsBothSides(text: string): number {
        const parsed = Number.parseFloat(text)
        const result = 1
        console.assert(parsed >= 0 || parsed < 0)
        return result
      }
      export function finiteSatisfiesOneSide(text: string): number {
        const parsed = Number.parseFloat(text)
        if (!Number.isFinite(parsed)) return 0
        console.assert(parsed >= 0 || parsed < 0)
        return 1
      }
      export function negatedLeftOnNaN(text: string, x: number): number {
        const parsed = Number.parseFloat(text)
        const result = x
        console.assert(!(parsed < 0) || x > 0)
        return result
      }
      export function groupInsideConjunction(x: number, y: number, z: number): number {
        if (z <= 0) return 0
        if (x <= 0) return 0
        console.assert((x > 0 || y > 0) && z > 0)
        return 1
      }
      export function threeAlternatives(x: number): number {
        if (x > 2 || x < 2) return 0
        console.assert(x === 0 || x === 1 || x === 2)
        return 1
      }
    `)
    expect(verdictsOf(report, 'neitherSide')).toEqual(['unproven'])
    expect(verdictsOf(report, 'leftAlwaysTrue')).toEqual(['proven'])
    expect(verdictsOf(report, 'rightEstablished')).toEqual(['proven'])
    expect(verdictsOf(report, 'leftRefinesRight')).toEqual(['proven'])
    expect(verdictsOf(report, 'storedBooleanLeft')).toEqual(['unproven'])
    expect(verdictsOf(report, 'nanFailsBothSides')).toEqual(['unproven'])
    expect(verdictsOf(report, 'finiteSatisfiesOneSide')).toEqual(['proven'])
    expect(verdictsOf(report, 'negatedLeftOnNaN')).toEqual(['unproven'])
    expect(verdictsOf(report, 'groupInsideConjunction')).toEqual(['proven'])
    expect(verdictsOf(report, 'threeAlternatives')).toEqual(['proven'])
  })

  test('pure + - * and Math operands read in assertions, while division, remainder and element reads reject', () => {
    const report = analyzeWithAssertForms('assertion-operands.ts', `
      export function tolerance(a: number, b: number): number {
        if (a > b) return 0
        console.assert(a <= b + 1e-9)
        return 1
      }
      export function possiblyNegativeOffset(a: number, b: number, c: number): number {
        if (a > b) return 0
        console.assert(a <= b + c)
        return 1
      }
      export function mathOperands(raw: number): number {
        const width = Math.max(0, Math.min(100, raw))
        console.assert(Math.min(width, 10) <= 10 && Math.abs(-width) >= 0 && width * 2 - 1 >= -1)
        return width
      }
      export function inlineDivision(a: number, d: number): number {
        const result = a
        console.assert(a / d > 0)
        return result
      }
      export function inlineRemainder(a: number, d: number): number {
        const result = a
        console.assert(a % d === 0 || a > 0)
        return result
      }
      export function inlineIndex(values: number[], index: number): number {
        const result = index
        console.assert(index >= 0 && values[index]! > 0)
        return result
      }
      function isPositive(value: number): boolean { return value > 0 }
      export function projectCall(value: number): number {
        const result = value
        console.assert(value > 1 || isPositive(value))
        return result
      }
      export function looseEquality(value: number): number {
        const result = value
        console.assert(value == 0 || value > 0)
        return result
      }
    `)
    expect(verdictsOf(report, 'possiblyNegativeOffset')).toEqual(['unproven'])
    expect(verdictsOf(report, 'mathOperands')).toEqual(['proven'])
    expect(unsupportedReasonOf(report, 'inlineDivision')).toContain('calculate or read the value before console.assert')
    expect(unsupportedReasonOf(report, 'inlineRemainder')).toContain('calculate or read the value before console.assert')
    expect(unsupportedReasonOf(report, 'inlineIndex')).toContain('calculate or read the value before console.assert')
    expect(unsupportedReasonOf(report, 'projectCall')).toContain('cannot call a function')
    expect(unsupportedReasonOf(report, 'looseEquality')).toContain('using ===, !==, <, <=, >, or >=')
    expect(verdictsOf(report, 'tolerance')).toEqual(['proven'])
  })

  test('a function\'s contracts are identical with and without its interior assertions', () => {
    const forms = [
      'console.assert(left >= 0 && right >= left)',
      'console.assert(flag)',
      'console.assert(!flag || left <= 100)',
      'console.assert(left > 50 || right >= left)',
      'console.assert(left <= right + 1e-9 && Math.min(left, 10) <= 10 && left * 2 >= left)',
      'console.assert(near(left, right) || left < right)',
      'console.assert((left > 10 || left < 5) && (right > 20 || near(right, left)))',
    ]
    const source = (assertion: string) => `
      export function contracts(rawLeft: number, rawRight: number, flag: boolean): number {
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9
        const left = Math.max(0, Math.min(100, rawLeft))
        const right = left + Math.max(0, Math.min(100, rawRight))
        ${assertion}
        const width = right - left
        if (flag) return width
        return left / Math.max(1, width)
      }
    `
    const without = analyzedFunction(analyzeWithAssertForms('contracts.ts', source('')), 'contracts')
    expect(without.ensures.length).toBeGreaterThan(0)
    for (const assertion of forms) {
      const report = analyzeWithAssertForms('contracts.ts', source(assertion))
      const fn = analyzedFunction(report, 'contracts')
      expect(fn.assertions).toHaveLength(1)
      expect({requires: fn.requires, ensures: fn.ensures, assumptions: fn.assumptions})
        .toEqual({requires: without.requires, ensures: without.ensures, assumptions: without.assumptions})
    }
  })

  test('local predicate helpers inline at value level only where every reference is a whole assertion check', () => {
    const report = analyzeWithAssertForms('predicate-helpers.ts', `
      export function withHelper(rawLeft: number, width: number, viewportWidth: number): number {
        console.assert(width > 0 && viewportWidth > 0)
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9
        const margin = 8
        const left = Math.max(margin, Math.min(rawLeft, viewportWidth - margin - width))
        console.assert(near(left, margin) || left > margin)
        console.assert(near(left, left))
        console.assert(left >= margin && (near(left, margin) || near(left + width, viewportWidth - margin) || left > margin))
        return left
      }
      export function handInlined(rawLeft: number, width: number, viewportWidth: number): number {
        console.assert(width > 0 && viewportWidth > 0)
        const margin = 8
        const left = Math.max(margin, Math.min(rawLeft, viewportWidth - margin - width))
        console.assert(Math.abs(left - margin) <= 1e-9 || left > margin)
        console.assert(Math.abs(left - left) <= 1e-9)
        console.assert(left >= margin && (Math.abs(left - margin) <= 1e-9 || Math.abs(left + width - (viewportWidth - margin)) <= 1e-9 || left > margin))
        return left
      }
      export function argumentEvaluatedOnce(raw: number): number {
        const same = (value: number) => value === value
        const result = raw
        console.assert(same(Math.abs(raw)))
        console.assert(Math.abs(raw) === Math.abs(raw))
        return result
      }
      function scale(value: number): number { return value * 2 }
      export function callArgument(raw: number): number {
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9
        const result = raw
        console.assert(near(scale(raw), 1))
        return result
      }
      export function escapingReference(raw: number): number {
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9
        const alias = near
        const result = raw
        console.assert(alias(raw, 1))
        return result
      }
      export function ordinaryReference(raw: number): number {
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9
        const pushed = near(raw, 0)
        console.assert(pushed || raw > 0)
        return raw
      }
      export function nonMathBody(raw: number): number {
        const scaled = (value: number) => scale(value) > 0
        const result = raw
        console.assert(scaled(raw))
        return result
      }
      export function negatedHelper(raw: number): number {
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9
        const result = raw
        console.assert(!near(raw, 0))
        return result
      }
    `)
    expect(verdictsOf(report, 'withHelper')).toEqual(verdictsOf(report, 'handInlined'))
    expect(verdictsOf(report, 'withHelper')).toEqual(['unproven', 'proven', 'unproven'])
    // The helper's parameter names one lowered value, so comparing it with itself proves; the
    // hand-written condition lowers Math.abs twice, and no producer rule identifies the two.
    expect(verdictsOf(report, 'argumentEvaluatedOnce')).toEqual(['proven', 'unproven'])
    expect(unsupportedReasonOf(report, 'callArgument')).toContain('cannot call a function')
    for (const name of ['escapingReference', 'ordinaryReference', 'nonMathBody', 'negatedHelper']) {
      expect(unsupportedReasonOf(report, name)).toContain('expression (ArrowFunction)')
    }
  })

  test('the syntax boundary under the switch', () => {
    const report = analyzeWithAssertForms('static-boundary-switched.ts', `
      export function message(value: number): number {
        console.assert(value >= 0, 'nonnegative')
        return value
      }
      export function constant(value: number): number {
        const result = value
        console.assert(true)
        return result
      }
      export function optional(value: number): number {
        console.assert?.(value >= 0)
        return value
      }
      export function inequalityRequirement(left: number, right: number): number {
        console.assert(left !== right && left > 0)
        return left
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
      export function optionalChain(bounds: {width: number} | undefined): number {
        const result = 1
        console.assert(bounds?.width === 1)
        return result
      }
      export function groupComparedWithFlag(a: number, b: number, flag: boolean): number {
        const result = a
        console.assert((a > 0 || b > 0) === flag)
        return result
      }
      export function negatedGroupAsLastAlternative(a: number, b: number): number {
        const result = a
        console.assert(a > 5 || !(a > 0 || b > 0))
        return result
      }
    `)
    for (const name of ['message', 'optional']) {
      expect(unsupportedReasonOf(report, name)).toContain('console.assert')
    }
    expect(unsupportedReasonOf(report, 'inequalityRequirement')).toContain('!== needs one fixed finite number')
    expect(unsupportedReasonOf(report, 'optionalChain')).toContain('one direct numeric comparison')
    // A || group lowered as a value joins in a block parameter, which the removability gate rejects.
    for (const name of ['groupComparedWithFlag', 'negatedGroupAsLastAlternative']) {
      expect(unsupportedReasonOf(report, name)).toContain('calculate or read the value before console.assert')
    }
    expect(verdictsOf(report, 'constant')).toEqual(['proven'])
    expect(verdictsOf(report, 'directMath')).toEqual(['proven'])
    expect(verdictsOf(report, 'booleanEquality')).toEqual(['proven'])
    expect(verdictsOf(report, 'negated')).toEqual(['unproven'])
  })

  test('a false assertion is never reported proven', () => {
    // Each condition is false for the input beside it; `holds` is the same condition in
    // TypeScript, run on that input.
    type Scope = {value: number; flag: boolean; parsed: number; near: (a: number, b: number) => boolean}
    const conditions: Array<{condition: string; holds: (scope: Scope) => boolean; input: {raw: number; flag: boolean; text: string}}> = [
      {condition: 'value > 0 && value < 10', holds: ({value}) => value > 0 && value < 10, input: {raw: 0, flag: false, text: '1'}},
      {condition: 'value < 5 || value > 6', holds: ({value}) => value < 5 || value > 6, input: {raw: 5, flag: false, text: '1'}},
      {condition: 'value <= 10 - 1', holds: ({value}) => value <= 10 - 1, input: {raw: 10, flag: false, text: '1'}},
      {condition: 'value * 2 < 20', holds: ({value}) => value * 2 < 20, input: {raw: 10, flag: false, text: '1'}},
      {condition: 'flag', holds: ({flag}) => flag, input: {raw: 1, flag: false, text: '1'}},
      {condition: '!flag || value < 10', holds: ({flag, value}) => !flag || value < 10, input: {raw: 10, flag: true, text: '1'}},
      {condition: 'near(value, 4) || value !== 3', holds: ({near, value}) => near(value, 4) || value !== 3, input: {raw: 3, flag: false, text: '1'}},
      {condition: 'parsed >= 0 || parsed < 0', holds: ({parsed}) => parsed >= 0 || parsed < 0, input: {raw: 1, flag: false, text: 'x'}},
      {condition: 'Math.min(value, 5) < 5', holds: ({value}) => Math.min(value, 5) < 5, input: {raw: 7, flag: false, text: '1'}},
      {condition: '(value > 2 || value < 1) && value !== 1.5', holds: ({value}) => (value > 2 || value < 1) && value !== 1.5, input: {raw: 1.5, flag: false, text: '1'}},
      {condition: 'near(value + 1e-10, value) && value > 0', holds: ({near, value}) => near(value + 1e-10, value) && value > 0, input: {raw: 0, flag: false, text: '1'}},
    ]
    for (const {holds, input} of conditions) {
      expect(holds({
        value: Math.max(0, Math.min(10, input.raw)),
        flag: input.flag,
        parsed: Number.parseFloat(input.text),
        near: (a, b) => Math.abs(a - b) <= 1e-9,
      })).toBe(false)
    }
    const report = analyzeWithAssertForms('false-assertions.ts', `
      export function falseForms(raw: number, flag: boolean, text: string): number {
        const value = Math.max(0, Math.min(10, raw))
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9
        const parsed = Number.parseFloat(text)
        ${conditions.map(({condition}) => `console.assert(${condition})`).join('\n')}
        return value
      }
    `)
    const verdicts = verdictsOf(report, 'falseForms')
    expect(verdicts).toHaveLength(conditions.length)
    expect(verdicts?.filter(verdict => verdict === 'proven')).toEqual([])
  })

  test('each limit of the wider reading rejects the function with its own reason', () => {
    const nested = (groups: number): string => {
      let condition = 'value > 0 && value > 1'
      for (let index = 1; index < groups; index++) {
        condition = `value > ${index + 1} ${index % 2 === 1 ? '||' : '&&'} (${condition})`
      }
      return condition
    }
    const chain = (count: number, operator: string): string =>
      Array.from({length: count}, (_, index) => `value > ${index}`).join(` ${operator} `)
    const largeBody = `value > 0 && value${' + 1'.repeat(200)} > 0`
    const report = analyzeWithAssertForms('assertion-limits.ts', `
      export function deepestAccepted(value: number): number {
        const result = value
        console.assert(${nested(32)})
        return result
      }
      export function tooDeep(value: number): number {
        const result = value
        console.assert(${nested(33)})
        return result
      }
      export function mostChecksAccepted(value: number): number {
        const result = value
        console.assert(${chain(64, '&&')})
        return result
      }
      export function tooManyChecks(value: number): number {
        const result = value
        console.assert(${chain(65, '&&')})
        return result
      }
      export function tooManyChecksAcrossGroups(value: number): number {
        const result = value
        console.assert((${chain(40, '&&')}) || (${chain(25, '&&')}))
        return result
      }
      export function mostDisjunctsAccepted(value: number): number {
        const result = value
        console.assert(${chain(16, '||')})
        return result
      }
      export function tooManyDisjuncts(value: number): number {
        const result = value
        console.assert(${chain(17, '||')})
        return result
      }
      export function helperCallsHelper(raw: number): number {
        const positive = (value: number) => value > 0
        const bounded = (value: number) => positive(value) && value < 10
        const result = raw
        console.assert(bounded(raw))
        return result
      }
      export function outerHelperDeclaredFirst(raw: number): number {
        const bounded = (value: number) => positive(value) && value < 10
        const positive = (value: number) => value > 0
        const result = raw
        console.assert(bounded(raw))
        return result
      }
      export function largeHelper(raw: number): number {
        const large = (value: number) => ${largeBody}
        const result = raw
        console.assert(large(raw))
        return result
      }
      export function largeOrdinaryArrow(raw: number): number {
        const large = (value: number) => ${largeBody}
        return large(raw) ? 1 : 0
      }
      export function nestedOrdinaryArrows(raw: number): number {
        const positive = (value: number) => value > 0
        const bounded = (value: number) => positive(value) && value < 10
        return bounded(raw) ? 1 : 0
      }
    `)
    expect(verdictsOf(report, 'deepestAccepted')).toHaveLength(1)
    expect(unsupportedReasonOf(report, 'tooDeep')).toContain('more than 32 levels deep')
    expect(verdictsOf(report, 'mostChecksAccepted')).toHaveLength(1)
    expect(unsupportedReasonOf(report, 'tooManyChecks')).toContain('more than 64 checks')
    expect(unsupportedReasonOf(report, 'tooManyChecksAcrossGroups')).toContain('more than 64 checks')
    expect(verdictsOf(report, 'mostDisjunctsAccepted')).toHaveLength(1)
    expect(unsupportedReasonOf(report, 'tooManyDisjuncts')).toContain('more than 16 alternatives')
    expect(unsupportedReasonOf(report, 'helperCallsHelper')).toContain('calls another local helper')
    expect(unsupportedReasonOf(report, 'outerHelperDeclaredFirst')).toContain('calls another local helper')
    expect(unsupportedReasonOf(report, 'largeHelper')).toContain('more than 256 syntax nodes')
    // Arrows that no console.assert calls keep today's rejection instead of a helper limit.
    expect(unsupportedReasonOf(report, 'largeOrdinaryArrow')).toContain('expression (ArrowFunction)')
    expect(unsupportedReasonOf(report, 'nestedOrdinaryArrows')).toContain('expression (ArrowFunction)')
  })

  test('the blocks that console.assert conditions create in one function are capped', () => {
    // A 16-alternative || chain creates 31 blocks: a true and a false block per left side,
    // and one continuation. 8 chains create 248 blocks and 9 create 279.
    const assertions = (count: number): string => Array.from({length: count}, (_, assertion) =>
      `console.assert(${Array.from({length: 16}, (_, index) => `value === ${assertion * 17 + index}`).join(' || ')})`).join('\n')
    const report = analyzeWithAssertForms('function-block-limit.ts', `
      export function mostBlocksAccepted(value: number): number {
        const result = value
        ${assertions(8)}
        return result
      }
      export function tooManyBlocks(value: number): number {
        const result = value
        ${assertions(9)}
        return result
      }
    `)
    expect(verdictsOf(report, 'mostBlocksAccepted')).toHaveLength(8)
    expect(unsupportedReasonOf(report, 'tooManyBlocks')).toContain('more than 256 blocks')
  })

  test('a || assertion is refuted only where every left side is definitely false', () => {
    const report = analyzeWithAssertForms('disjunction-refutations.ts', `
      export function producerProofOnLeftSide(a: number, b: number): number {
        if (a > b) return 0
        const d = b - a
        console.assert(d >= 0)
        console.assert(d >= 0 || b < a)
        console.assert(b < a || d >= 0)
        return d
      }
      export function minimumOnLeftSide(x: number, y: number): number {
        const lo = Math.min(x, y)
        const result = lo
        console.assert(lo <= x || lo > x + 1)
        return result
      }
      export function requirementsProveLeftGroup(a: number, b: number): number {
        console.assert(a >= 0 && a <= b)
        console.assert(b <= 10)
        const width = b - a
        console.assert(width >= 0 && width <= 10 || a < 0)
        return width
      }
      export function leftSideTrueButUnproven(raw: number): number {
        const x = Math.max(0, Math.min(10, raw))
        const result = x
        console.assert(x * 10 >= x || x === 0)
        return result
      }
      export function earlyReturnInLoop(n: number, stop: number): number {
        let total = 0
        for (let i = 0; i < n; i++) {
          if (i === stop) return total
          console.assert(i !== stop || total > 1000)
          total = total + i
        }
        return total
      }
      export function counterexampleNotShown(raw: number): number {
        const x = Math.max(0, Math.min(10, raw))
        const result = x
        console.assert(x < 5 || x > 100)
        return result
      }
      export function definitelyFalse(raw: number): number {
        const x = 5
        const result = raw
        console.assert(x < 5 || x > 6)
        console.assert((raw > 0 || raw <= 0) && x > 6)
        return result
      }
      export function nestedDisjunction(raw: number): number {
        const x = 5
        const result = raw
        console.assert(raw > 0 || (x > 6 || x < 5))
        return result
      }
    `)
    expect(verdictsOf(report, 'producerProofOnLeftSide')).toEqual(['proven', 'proven', 'proven'])
    expect(verdictsOf(report, 'minimumOnLeftSide')).toEqual(['proven'])
    expect(verdictsOf(report, 'requirementsProveLeftGroup')).toEqual(['proven'])
    // x * 10 >= x holds for every x in 0..10, but no rule proves it. The false branch of the
    // left side is then reachable for the analysis though no input takes it, and x === 0 is
    // definitely false there.
    expect(verdictsOf(report, 'leftSideTrueButUnproven')).toEqual(['unproven'])
    // The first loop visit holds total === 0, where total > 1000 is definitely false on the
    // false branch of i !== stop, a branch no input reaches.
    expect(verdictsOf(report, 'earlyReturnInLoop')).toEqual(['unproven'])
    // x === 7 makes this assertion false, but the analysis can't tell such an x from the
    // unreachable false branches above, so the verdict stays unproven.
    expect(verdictsOf(report, 'counterexampleNotShown')).toEqual(['unproven'])
    expect(verdictsOf(report, 'definitelyFalse')).toEqual(['refuted', 'refuted'])
    // x < 5 is definitely false after both left sides, and x > 6 is never true, but raw > 0 can
    // be true, so a false branch of the outer group is not shown to be taken.
    expect(verdictsOf(report, 'nestedDisjunction')).toEqual(['unproven'])
  })
})
