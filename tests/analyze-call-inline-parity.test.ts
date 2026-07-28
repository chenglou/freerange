import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {
  analyzedFunction,
  requirementsBesidesInputFiniteness,
} from './analyze-helpers.ts'

function assertionVerdicts(
  report: ReturnType<typeof analyzeSource>,
  name: string,
): string[] {
  return analyzedFunction(report, name).assertions?.map(assertion =>
    assertion.verdict) ?? []
}

describe('same-file calls preserve inline analysis', () => {
  test('follows one returned calculation, including nested calls and fresh records', () => {
    const report = analyzeSource('returned-calculations.ts', `
      function identity(value: number): number {
        return value
      }
      function twiceIdentity(value: number): number {
        return identity(value)
      }
      function plusOne(value: number): number {
        return value + 1
      }
      function booleanIdentity(value: boolean): boolean {
        return value
      }
      function identityWithDeadReturn(value: number): number {
        if (false) return value + 1
        return value
      }
      function span(start: number, end: number): number {
        return end - start
      }
      function pair(value: number): {left: number; right: number} {
        return {left: value, right: value}
      }
      function sameResultOnBothReturns(value: number, alternate: boolean): number {
        const result = Math.max(value, 0)
        if (alternate) return result
        return result
      }
      export function sameValue(value: number): number {
        return twiceIdentity(value) - value
      }
      export function ratio(total: number, start: number, end: number): number {
        return total / span(start, end)
      }
      export function sameFields(value: number): number {
        const result = pair(value)
        return result.left - result.right
      }
      export function repeatedIdentity(value: number): number {
        return identity(value) - identity(value)
      }
      export function deadReturn(value: number): number {
        return identityWithDeadReturn(value) - value
      }
      export function repeatedCalculation(value: number): number {
        return plusOne(value) - plusOne(value)
      }
      export function sameProducerAcrossReturns(
        value: number,
        alternate: boolean,
      ): number {
        const result = sameResultOnBothReturns(value, alternate)
        console.assert(result >= value)
        return result
      }
      export function sameBoolean(value: boolean): number {
        return booleanIdentity(value) === value ? 1 : 0
      }
    `)

    for (const name of [
      'sameValue',
      'sameFields',
      'repeatedIdentity',
      'deadReturn',
    ]) {
      expect(analyzedFunction(report, name).ensures)
        .toEqual(['return is a finite integer number from 0 through 0'])
    }
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'ratio')))
      .toHaveLength(1)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'ratio'))[0])
      .toStartWith('(end - start) is nonzero')
    expect(analyzedFunction(report, 'ratio').assumptions).toEqual([])
    expect(analyzedFunction(report, 'repeatedCalculation').ensures)
      .not.toEqual(['return is a finite integer number from 0 through 0'])
    expect(assertionVerdicts(report, 'sameProducerAcrossReturns'))
      .toEqual(['proven'])
    expect(analyzedFunction(report, 'sameBoolean').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
  })

  test('preserves clamp proofs through calls, wrappers, and returned records', () => {
    const report = analyzeSource('called-clamps.ts', `
      function clamp(minimum: number, value: number, maximum: number): number {
        return Math.min(Math.max(value, minimum), maximum)
      }
      function wrappedClamp(minimum: number, value: number, maximum: number): number {
        return clamp(minimum, value, maximum)
      }
      function bounded(
        minimum: number,
        value: number,
        requestedMaximum: number,
      ): {value: number; maximum: number} {
        const maximum = Math.max(minimum, requestedMaximum)
        return {value: clamp(minimum, value, maximum), maximum}
      }
      export function calledUnit(value: number): number {
        const result = clamp(0, value, 1)
        console.assert(result >= 0)
        console.assert(result <= 1)
        return result
      }
      export function inlineUnit(value: number): number {
        const result = Math.min(Math.max(value, 0), 1)
        console.assert(result >= 0)
        console.assert(result <= 1)
        return result
      }
      export function calledDependent(
        requestedWidth: number,
        requestedLeft: number,
      ): number {
        const width = wrappedClamp(0.08, requestedWidth, 1)
        const maximumLeft = Math.max(0, 1 - width)
        const left = clamp(0, requestedLeft, maximumLeft)
        console.assert(width >= 0.08)
        console.assert(width <= 1)
        console.assert(left >= 0)
        console.assert(left <= maximumLeft)
        return left
      }
      export function inlineDependent(
        requestedWidth: number,
        requestedLeft: number,
      ): number {
        const width = Math.min(Math.max(requestedWidth, 0.08), 1)
        const maximumLeft = Math.max(0, 1 - width)
        const left = Math.min(Math.max(requestedLeft, 0), maximumLeft)
        console.assert(width >= 0.08)
        console.assert(width <= 1)
        console.assert(left >= 0)
        console.assert(left <= maximumLeft)
        return left
      }
      export function returnedRecord(
        minimum: number,
        value: number,
        requestedMaximum: number,
      ): number {
        const result = bounded(minimum, value, requestedMaximum)
        console.assert(result.value >= minimum)
        console.assert(result.value <= result.maximum)
        return result.value
      }
      export function reversedCalled(value: number): number {
        const result = clamp(10, value, 0)
        console.assert(result >= 10)
        console.assert(result <= 0)
        return result
      }
      export function reversedInline(value: number): number {
        const result = Math.min(Math.max(value, 10), 0)
        console.assert(result >= 10)
        console.assert(result <= 0)
        return result
      }
    `)

    for (const [called, inline] of [
      ['calledUnit', 'inlineUnit'],
      ['calledDependent', 'inlineDependent'],
      ['reversedCalled', 'reversedInline'],
    ] as const) {
      expect(assertionVerdicts(report, called))
        .toEqual(assertionVerdicts(report, inline))
    }
    expect(assertionVerdicts(report, 'calledUnit')).toEqual(['proven', 'proven'])
    expect(assertionVerdicts(report, 'calledDependent'))
      .toEqual(['proven', 'proven', 'proven', 'proven'])
    expect(assertionVerdicts(report, 'returnedRecord'))
      .toEqual(['proven', 'proven'])
    expect(assertionVerdicts(report, 'reversedCalled'))
      .toEqual(['refuted', 'proven'])
  })

  test('projects guards and directly returned predicates onto caller arguments', () => {
    const report = analyzeSource('called-conditions.ts', `
      function requirePositive(value: number): void {
        if (value <= 0) throw new Error('not positive')
      }
      function isSmallPositive(value: number): boolean {
        return value > 0 && value < 10
      }
      function wrapped(value: number): boolean {
        return isSmallPositive(value)
      }
      function isValidIndex(values: number[], index: number): boolean {
        return Number.isInteger(index) && index >= 0 && index < values.length
      }
      export function guarded(total: number, divisor: number): number {
        requirePositive(divisor)
        return total / divisor
      }
      export function positive(value: number): number {
        if (!wrapped(value)) return 0
        return 1 / value
      }
      export function negative(value: number): number {
        if (wrapped(value)) return 0
        return 1 / value
      }
      export function element(values: number[], index: number): number {
        if (!isValidIndex(values, index)) return 0
        return values[index]!
      }
    `)

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'guarded')))
      .toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'positive')))
      .toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'negative')))
      .toHaveLength(1)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'element')))
      .toEqual([])
    expect(analyzedFunction(report, 'element').assumptions.some(assumption =>
      assumption.includes('is in bounds'))).toBe(false)
  })

  test('projects branches on returned numeric values onto caller arguments', () => {
    const report = analyzeSource('called-numeric-conditions.ts', `
      function identity(value: number): number {
        return value
      }
      function box(value: number): {value: number} {
        return {value}
      }
      export function calledZero(value: number): number {
        if (identity(value) === 0) return 1 / value
        return 0
      }
      export function calledRecordZero(value: number): number {
        if (box(value).value === 0) return 1 / value
        return 0
      }
      export function inlineZero(value: number): number {
        if (value === 0) return 1 / value
        return 0
      }
      export function calledPositive(value: number): number {
        if (identity(value) <= 0) return 0
        console.assert(value > 0)
        return 1 / value
      }
    `)

    for (const name of ['calledZero', 'calledRecordZero', 'inlineZero']) {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn?.kind !== 'partial') throw new Error(`Expected ${name} to be partial`)
      expect(fn.partialReasons[0]).toContain('divisor that is definitely zero')
    }
    expect(assertionVerdicts(report, 'calledPositive')).toEqual(['proven'])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'calledPositive')))
      .toEqual([])
  })

  test('keeps the same limits at stored booleans and joined returns', () => {
    const report = analyzeSource('call-limits.ts', `
      function storedPredicate(value: number): boolean {
        const valid = value > 0 && value < 10
        return valid
      }
      function choose(value: number, alternate: boolean): number {
        if (alternate) return value + 8
        return value + 16
      }
      export function calledStored(value: number): number {
        if (!storedPredicate(value)) return 0
        return 1 / value
      }
      export function inlineStored(value: number): number {
        const valid = value > 0 && value < 10
        if (!valid) return 0
        return 1 / value
      }
      export function calledJoin(value: number, alternate: boolean): number {
        const result = choose(value, alternate)
        console.assert(result >= value)
        return result
      }
      export function inlineJoin(value: number, alternate: boolean): number {
        const result = alternate ? value + 8 : value + 16
        console.assert(result >= value)
        return result
      }
    `)

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'calledStored')).map(line =>
      line.split(' (')[0])).toEqual(
      requirementsBesidesInputFiniteness(analyzedFunction(report, 'inlineStored')).map(line =>
        line.split(' (')[0]),
    )
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'calledStored')))
      .toHaveLength(1)
    expect(assertionVerdicts(report, 'calledJoin'))
      .toEqual(assertionVerdicts(report, 'inlineJoin'))
    expect(assertionVerdicts(report, 'calledJoin')).toEqual(['unproven'])
  })

  test('does not weaken ordinary nullish narrowing', () => {
    const report = analyzeSource('ordinary-nullish.ts', `
      export function fallback(
        value: string | null,
        replacement: string,
      ): string {
        return value ?? replacement
      }
      export function guarded(
        value: string | undefined,
        replacement: string,
      ): string {
        return value != null && value !== '' ? value : replacement
      }
    `)

    for (const name of ['fallback', 'guarded']) {
      expect(analyzedFunction(report, name).ensures).toEqual([])
    }
  })

  test('projects only narrowing shared by every normal return', () => {
    const report = analyzeSource('called-guards.ts', `
      function maybeGuard(value: number, enabled: boolean): void {
        if (enabled && value < 0) throw new Error('negative')
      }
      function alwaysGuard(value: number, first: boolean): void {
        if (first) {
          if (value < 0) throw new Error('negative')
        } else {
          if (value < 0) throw new Error('negative')
        }
      }
      function constrainBoth(lower: number, upper: number): void {
        if (lower < 0) throw new Error('below')
        if (upper > 10) throw new Error('above')
      }
      function overwrite(value: number): void {
        value = 1
      }
      export function maybe(value: number, enabled: boolean): number {
        maybeGuard(value, enabled)
        console.assert(value >= 0)
        return value
      }
      export function always(value: number, first: boolean): number {
        alwaysGuard(value, first)
        console.assert(value >= 0)
        return value
      }
      export function duplicateArgument(value: number): number {
        constrainBoth(value, value)
        console.assert(value >= 0)
        console.assert(value <= 10)
        return value
      }
      export function reassigned(value: number): number {
        overwrite(value)
        console.assert(value === 1)
        return value
      }
    `)

    expect(assertionVerdicts(report, 'maybe')).toEqual(['unproven'])
    expect(assertionVerdicts(report, 'always')).toEqual(['proven'])
    expect(assertionVerdicts(report, 'duplicateArgument'))
      .toEqual(['proven', 'proven'])
    expect(assertionVerdicts(report, 'reassigned')).toEqual(['unproven'])
  })

  test('prunes contradictory projections and follows identity and record arguments', () => {
    const report = analyzeSource('projected-values.ts', `
      function both(left: number, right: number): boolean {
        return left < 0 && right > 0
      }
      function bothFields(box: {left: number; right: number}): boolean {
        return box.left < 0 && box.right > 0
      }
      function identity(value: number): number {
        return value
      }
      function requirePositive(value: number): void {
        if (value <= 0) throw new Error('not positive')
      }
      function requirePositiveBox(box: {value: number}): void {
        if (box.value <= 0) throw new Error('not positive')
      }
      export function impossible(value: number): number {
        return both(value, value) ? 1 : 0
      }
      export function inlineImpossible(value: number): number {
        return value < 0 && value > 0 ? 1 : 0
      }
      export function impossibleFields(value: number): number {
        return bothFields({left: value, right: value}) ? 1 : 0
      }
      export function throughIdentity(value: number): number {
        requirePositive(identity(value))
        console.assert(value > 0)
        return value
      }
      export function throughRecord(value: number): number {
        requirePositiveBox({value})
        console.assert(value > 0)
        return value
      }
      export function laterCallerGuard(value: number): number {
        const result = identity(value)
        if (value <= 0) return 0
        console.assert(result > 0)
        return result
      }
    `)

    expect(analyzedFunction(report, 'impossible').ensures)
      .toEqual(analyzedFunction(report, 'inlineImpossible').ensures)
    expect(analyzedFunction(report, 'impossible').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'impossibleFields').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    expect(assertionVerdicts(report, 'throughIdentity')).toEqual(['proven'])
    expect(assertionVerdicts(report, 'throughRecord')).toEqual(['proven'])
    expect(assertionVerdicts(report, 'laterCallerGuard')).toEqual(['proven'])
  })

  test('keeps duplicate arguments identical across every predicate path', () => {
    const report = analyzeSource('duplicate-condition-arguments.ts', `
      function oppositeSigns(
        left: number,
        right: number,
        alternate: boolean,
      ): boolean {
        return alternate
          ? left < 0 && right > 0
          : left > 0 && right < 0
      }
      function oneMissing(
        left: number | undefined,
        right: number | undefined,
        alternate: boolean,
      ): boolean {
        return alternate
          ? left === undefined && right !== undefined
          : left !== undefined && right === undefined
      }
      export function calledNumbers(value: number, alternate: boolean): number {
        return oppositeSigns(value, value, alternate) ? 1 : 0
      }
      export function inlineNumbers(value: number, alternate: boolean): number {
        return alternate
          ? value < 0 && value > 0 ? 1 : 0
          : value > 0 && value < 0 ? 1 : 0
      }
      export function calledUnknown(value: number | undefined, alternate: boolean): number {
        return oneMissing(value, value, alternate) ? 1 : 0
      }
      export function inlineUnknown(value: number | undefined, alternate: boolean): number {
        return alternate
          ? value === undefined && value !== undefined ? 1 : 0
          : value !== undefined && value === undefined ? 1 : 0
      }
    `)

    for (const [called, inline] of [
      ['calledNumbers', 'inlineNumbers'],
      ['calledUnknown', 'inlineUnknown'],
    ] as const) {
      expect(analyzedFunction(report, called).ensures)
        .toEqual(analyzedFunction(report, inline).ensures)
      expect(analyzedFunction(report, called).ensures)
        .toEqual(['return is a finite integer number from 0 through 0'])
    }
  })

  test('follows a predicate returned in a fresh record', () => {
    const report = analyzeSource('returned-record-condition.ts', `
      function verdict(value: number): {ok: boolean} {
        return {ok: value > 0}
      }
      function wrappedVerdict(value: number): {ok: boolean} {
        return verdict(value)
      }
      export function called(value: number): number {
        if (!wrappedVerdict(value).ok) return 0
        return 1 / value
      }
      export function inline(value: number): number {
        if (!(value > 0)) return 0
        return 1 / value
      }
    `)

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'called')))
      .toEqual(requirementsBesidesInputFiniteness(analyzedFunction(report, 'inline')))
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'called')))
      .toEqual([])
  })

  test('does not carry branch-specific module state through a returned condition', () => {
    const report = analyzeSource('condition-module-state.ts', `
      let state = 0
      function setState(): boolean {
        state = 1
        return true
      }
      function changed(flag: boolean): boolean {
        return flag && setState()
      }
      export function called(flag: boolean): number {
        if (changed(flag)) {
          console.assert(state === 1)
        }
        return state
      }
      export function storedThenChanged(flag: boolean): number {
        const result = changed(flag)
        state = 2
        if (result) {
          console.assert(state === 2)
        }
        return state
      }
    `)

    expect(assertionVerdicts(report, 'called')).toEqual(['unproven'])
    expect(assertionVerdicts(report, 'storedThenChanged')).toEqual(['proven'])
  })

  test('keeps separate module reads and loop evaluations separate', () => {
    const report = analyzeSource('repeated-calls.ts', `
      let current = 1
      function identity(value: number): number {
        return value
      }
      function readCurrent(): number {
        return current
      }
      function writeCurrent(value: number): void {
        current = value
      }
      export function capturedRead(): number {
        const value = readCurrent()
        return identity(value) - value
      }
      export function changedRead(next: number): number {
        const before = readCurrent()
        writeCurrent(next)
        return before - readCurrent()
      }
      export function loop(start: number, steps: number): number {
        let value = start
        for (let index = 0; index < steps; index++) {
          const copy = identity(value)
          console.assert(copy === value)
          value = copy + 1
        }
        console.assert(value === start)
        return value
      }
    `)

    expect(analyzedFunction(report, 'capturedRead').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'changedRead').ensures)
      .not.toEqual(['return is a finite integer number from 0 through 0'])
    expect(assertionVerdicts(report, 'loop')).toEqual(['proven', 'unproven'])
  })

  test('does not use a short-circuit operand from a path that stopped', () => {
    const report = analyzeSource('stopped-condition-arm.ts', `
      function unavailable(value: number): boolean {
        return Boolean(value)
      }
      export function predicate(value: number): boolean {
        return value <= 0 || unavailable(value)
      }
    `)

    const predicate = report.functions.find(fn => fn.name === 'predicate')
    expect(predicate?.kind).toBe('partial')
  })

  test('keeps the finite-parameter difference explicit', () => {
    const report = analyzeSource('overflow-call.ts', `
      function clamp(minimum: number, value: number, maximum: number): number {
        return Math.min(Math.max(value, minimum), maximum)
      }
      export function called(value: number): number {
        const doubled = value * 2
        const result = clamp(0, doubled, 1)
        console.assert(result >= 0)
        console.assert(result <= 1)
        return result
      }
      export function inline(value: number): number {
        const doubled = value * 2
        const result = Math.min(Math.max(doubled, 0), 1)
        console.assert(result >= 0)
        console.assert(result <= 1)
        return result
      }
    `)

    expect(assertionVerdicts(report, 'called')).toEqual(assertionVerdicts(report, 'inline'))
    expect(analyzedFunction(report, 'called').requires.some(requirement =>
      requirement.startsWith('Number.isFinite((value * 2)) (input at '))).toBe(true)
    expect(analyzedFunction(report, 'inline').requires.some(requirement =>
      requirement.startsWith('Number.isFinite((value * 2)) (input at '))).toBe(false)
  })

  test('handles long direct and nested predicates without repeated expansion', () => {
    const termCount = 300
    const helperCount = 64
    const direct = Array.from(
      {length: termCount},
      (_, index) => `value > ${-index}`,
    ).join(' && ')
    const helpers = Array.from(
      {length: helperCount},
      (_, index) => index === 0
        ? 'function check0(value: number): boolean { return value > 0 }'
        : `function check${index}(value: number): boolean {
            return check${index - 1}(value) && value > ${-index}
          }`,
    ).join('\n')
    const report = analyzeSource('long-predicates.ts', `
      function direct(value: number): boolean {
        return ${direct}
      }
      ${helpers}
      export function useDirect(value: number): number {
        return direct(value) ? 1 : 0
      }
      export function useNested(value: number): number {
        return check${helperCount - 1}(value) ? 1 : 0
      }
    `)

    expect(report.functions.find(fn => fn.name === 'useDirect')?.kind).toBe('analyzed')
    expect(report.functions.find(fn => fn.name === 'useNested')?.kind).toBe('analyzed')
  })
})
