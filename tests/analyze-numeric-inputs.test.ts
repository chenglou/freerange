import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

describe('numeric input requirements', () => {
  const expectOnlyRequirement = (
    report: ReturnType<typeof analyzeSource>,
    functionName: string,
    text: string,
  ): void => {
    const requirements = analyzedFunction(report, functionName).requires
    expect(requirements).toHaveLength(1)
    expect(requirements[0]).toContain(text)
  }

  test('operations require only the exceptional inputs that break them', () => {
    const report = analyzeSource('numeric-operations.ts', `
      export function passThrough(value: number): number { return value }
      export function increment(value: number): number { return value + 1 }
      export function double(value: number): number { return value * 2 }
      export function zero(value: number): number { return value * 0 }
      export function reciprocal(value: number): number { return 2 / value }
      export function modulo(value: number): number { return value % 2 }
      export function remainderBy(value: number): number { return 2 % value }
      export function clamp(value: number): number {
        return Math.max(0, Math.min(value, 100))
      }
      export function add(left: number, right: number): number { return left + right }
      export function subtractSelf(value: number): number { return value - value }
      export function divideInfinity(value: number): number {
        if (Number.isNaN(value)) return 0
        return Infinity / value
      }
    `)

    expect(analyzedFunction(report, 'passThrough').requires).toEqual([])
    expect(analyzedFunction(report, 'passThrough').ensures[0]).toContain('possibly NaN')
    for (const name of ['increment', 'double', 'clamp']) {
      expectOnlyRequirement(report, name, '!Number.isNaN(value)')
    }
    for (const name of ['zero', 'modulo', 'subtractSelf']) {
      expectOnlyRequirement(report, name, 'Number.isFinite(value)')
    }
    expect(analyzedFunction(report, 'zero').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    for (const name of ['reciprocal', 'remainderBy']) {
      const requirements = analyzedFunction(report, name).requires
      expect(requirements).toHaveLength(2)
      expect(requirements[0]).toContain('!Number.isNaN(value)')
      expect(requirements[1]).toContain('value is nonzero')
    }
    const add = analyzedFunction(report, 'add')
    expect(add.requires).toHaveLength(2)
    expect(add.requires[0]).toContain('!Number.isNaN(left)')
    expect(add.requires[1]).toContain('!Number.isNaN(right)')
    expect(add.requires.join('\n')).not.toContain('Number.isFinite')
    const divideInfinity = analyzedFunction(report, 'divideInfinity')
    expect(divideInfinity.requires[0])
      .toContain('Number.isFinite(value) || Number.isNaN(value)')
    expect(divideInfinity.requires[1]).toContain('value is nonzero')
  })

  test('guards handle exceptional values instead of creating requirements', () => {
    const report = analyzeSource('numeric-guards.ts', `
      export function normalize(value: number): number {
        if (!Number.isFinite(value)) return 0
        return value * 2
      }
      export function normalizeNaN(value: number): number {
        if (Number.isNaN(value)) return 0
        return value + 1
      }
      export function declared(value: number): number {
        console.assert(Number.isFinite(value))
        return value * 0
      }
      export function automatic(value: number): number { return value * 0 }
      export function literal(value: 1 | 2): number {
        console.assert(Number.isFinite(value))
        return value * 40
      }
    `)

    expect(analyzedFunction(report, 'normalize').requires).toEqual([])
    expect(analyzedFunction(report, 'normalizeNaN').requires).toEqual([])
    const declared = analyzedFunction(report, 'declared')
    expect(declared.requires).toHaveLength(1)
    expect(declared.requires[0]).toContain('Number.isFinite(value)')
    expect(declared.requires[0]).toContain('declared at')
    expect(analyzedFunction(report, 'automatic').ensures).toEqual(declared.ensures)
    const literal = analyzedFunction(report, 'literal')
    expect(literal.requires).toEqual([])
    expect(literal.assumptions).toEqual([
      'value is a finite integer number from 1 through 2',
    ])
    expect(literal.ensures).toEqual([
      'return is a finite integer number from 40 through 80',
    ])
  })

  test('a weaker later use does not take credit for a stronger requirement', () => {
    const report = analyzeSource('numeric-requirement-order.ts', `
      export function choose(value: number, first: boolean): number {
        if (first) return value * 0
        return value + 1
      }
    `)

    expect(analyzedFunction(report, 'choose').requires).toEqual([
      'Number.isFinite(value) (used at numeric-requirement-order.ts:3:27)',
    ])
  })

  test('requirements replace exceptional-value trust, not the runtime number boundary', () => {
    const report = analyzeSource('numeric-boundary.ts', `
      export function increment(value: number): number { return value + 1 }
      export function zero(value: number): number { return value * 0 }
      export function sum(config: {left: number; right: number; offset: number}): number {
        return config.left + config.right + config.offset
      }
      const smuggled: any = undefined
      increment(smuggled)
    `)

    expect(analyzedFunction(report, 'increment').assumptions).toEqual(['value is a number'])
    // Number.isFinite itself rejects every non-number, so the requirement already covers
    // the runtime kind that an explicit `any` could otherwise violate.
    expect(analyzedFunction(report, 'zero').assumptions).toEqual([])
    expect(analyzedFunction(report, 'sum').assumptions).toEqual([
      'every property declared as a number in config holds a number',
    ])
  })

  test('same-file calls prove, propagate, or reject a requirement', () => {
    const report = analyzeSource('numeric-calls.ts', `
      function zero(value: number): number { return value * 0 }
      function increment(value: number): number { return value + 1 }
      export function forwarded(input: number): number { return zero(input) }
      export function selected(flag: boolean, first: number, second: number): number {
        const value = flag ? second : first
        return zero(value)
      }
      export function derived(input: number): number {
        const doubled = input * 2
        return zero(doubled)
      }
      export function known(): number { return zero(5) }
      export function bad(): number { return zero(Infinity) }
      export function safeInfinity(): number { return increment(Infinity) }
      export function badNaN(value: number): number {
        if (Number.isNaN(value)) return increment(value)
        return 0
      }
    `)

    expectOnlyRequirement(report, 'forwarded', 'Number.isFinite(input)')
    const selected = analyzedFunction(report, 'selected')
    expect(selected.requires).toHaveLength(2)
    expect(selected.requires.some(requirement => requirement.includes('Number.isFinite(first)'))).toBe(true)
    expect(selected.requires.some(requirement => requirement.includes('Number.isFinite(second)'))).toBe(true)
    const derived = analyzedFunction(report, 'derived')
    expect(derived.requires.some(requirement =>
      requirement.includes('Number.isFinite((input * 2))'))).toBe(true)
    expect(derived.ensures).toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'known').requires).toEqual([])
    const bad = report.functions.find(candidate => candidate.name === 'bad')
    if (bad?.kind !== 'partial') throw new Error('Expected bad to be partially supported')
    expect(bad.partialReasons[0]).toContain('passes a numeric input that is definitely Infinity')
    expect(analyzedFunction(report, 'safeInfinity').ensures)
      .toEqual(['return is a possibly non-finite number from Infinity through Infinity'])
    const badNaN = report.functions.find(candidate => candidate.name === 'badNaN')
    if (badNaN?.kind !== 'partial') throw new Error('Expected badNaN to be partially supported')
    expect(badNaN.partialReasons[0]).toContain('passes a numeric input that is definitely NaN')
  })

  test('completed helpers preserve the numeric conditions they establish', () => {
    const report = analyzeSource('numeric-helper-conditions.ts', `
      function increment(value: number): number { return value + 1 }
      function zero(value: number): number { return value * 0 }
      function requireFinite(value: number): void {
        if (!Number.isFinite(value)) throw new Error('Expected a finite number')
      }
      function maybeRequireFinite(value: number): void {
        if (!Number.isFinite(value)) return
      }
      export function notNaNAfterCall(value: number): number {
        increment(value)
        if (Number.isNaN(value)) return 1
        return 0
      }
      export function finiteAfterCall(value: number): number {
        zero(value)
        return value * 0
      }
      export function finiteAfterValidation(value: number): number {
        requireFinite(value)
        return value * 0
      }
      export function ordinaryReturnDoesNotValidate(value: number): number {
        maybeRequireFinite(value)
        return value * 0
      }
    `)

    const notNaN = analyzedFunction(report, 'notNaNAfterCall')
    expectOnlyRequirement(report, 'notNaNAfterCall', '!Number.isNaN(value)')
    expect(notNaN.ensures).toEqual(['return is a finite integer number from 0 through 0'])
    expectOnlyRequirement(report, 'finiteAfterCall', 'Number.isFinite(value)')
    expect(analyzedFunction(report, 'finiteAfterValidation').requires).toEqual([])
    expectOnlyRequirement(report, 'ordinaryReturnDoesNotValidate', 'Number.isFinite(value)')
  })

  test('equivalent numeric conditions survive branch joins', () => {
    const report = analyzeSource('numeric-condition-joins.ts', `
      function requireFinite(value: number): void {
        console.assert(Number.isFinite(value))
      }
      export function joined(value: number, useHelper: boolean): number {
        if (useHelper) requireFinite(value)
        else if (!Number.isFinite(value)) return 0
        console.assert(Number.isFinite(value))
        return value
      }
    `)

    const joined = analyzedFunction(report, 'joined')
    expect(joined.requires).toHaveLength(1)
    expect(joined.requires[0]).toContain('Number.isFinite(value)')
    expect(joined.assertions?.map(assertion => assertion.verdict)).toEqual(['proven'])
  })

  test('a proven array index is finite', () => {
    const report = analyzeSource('numeric-index.ts', `
      export function checkedIndex(values: number[], index: number): number {
        const value = values[index]!
        console.assert(Number.isFinite(index))
        return value
      }
    `)

    const checked = analyzedFunction(report, 'checkedIndex')
    expect(checked.requires).toHaveLength(1)
    expect(checked.requires[0]).toContain('index is a valid values index')
    expect(checked.assertions?.map(assertion => assertion.verdict)).toEqual(['proven'])
  })

  test('requirements never erase exceptional values created inside the function', () => {
    const report = analyzeSource('numeric-local-causes.ts', `
      export function overflowThenZero(value: number): number {
        const overflowed = value * 2
        return overflowed * 0
      }
      export function joinedWithInfinity(value: number, useValue: boolean): number {
        const selected = useValue ? value : Infinity
        return selected * 0
      }
      function passThrough(value: number): number { return value }
      export function wrappedInfinity(useFinite: boolean): number {
        return passThrough(useFinite ? 5 : Infinity)
      }
    `)

    const overflow = analyzedFunction(report, 'overflowThenZero')
    expectOnlyRequirement(report, 'overflowThenZero', '!Number.isNaN(value)')
    expect(overflow.ensures[0]).toContain('possibly NaN')
    const joined = analyzedFunction(report, 'joinedWithInfinity')
    expectOnlyRequirement(report, 'joinedWithInfinity', '!Number.isNaN(value)')
    expect(joined.ensures[0]).toContain('possibly NaN')
    const wrapped = analyzedFunction(report, 'wrappedInfinity')
    expect(wrapped.requires).toEqual([])
    expect(wrapped.ensures[0]).toContain('possibly non-finite')
  })

  test('arithmetic does not carry the wrong exceptional-input condition forward', () => {
    const report = analyzeSource('numeric-condition-carry.ts', `
      export function oppositeInfinity(value: number): number {
        const shifted = value + -Infinity
        return shifted + 1
      }
      export function negativeSquareRoot(value: number): number {
        const root = Math.sqrt(value)
        return root + 1
      }
      export function roundedIndex(value: number): number {
        const index = Math.max(0, Math.floor(value))
        return index % 2
      }
    `)

    const shifted = analyzedFunction(report, 'oppositeInfinity')
    expectOnlyRequirement(report, 'oppositeInfinity', '!Number.isNaN(value)')
    expect(shifted.ensures[0]).toContain('possibly NaN')
    const root = analyzedFunction(report, 'negativeSquareRoot')
    expectOnlyRequirement(report, 'negativeSquareRoot', '!Number.isNaN(value)')
    expect(root.ensures[0]).toContain('possibly NaN')
    expectOnlyRequirement(report, 'roundedIndex', 'Number.isFinite(value)')
    expect(analyzedFunction(report, 'roundedIndex').ensures)
      .toEqual(['return is a finite integer number from 0 through 1'])
  })

  test('loop widening keeps invariant input identity and drops changing identity', () => {
    const parameters = Array.from({length: 24}, (_, index) => `value${index}: number`)
    const slots = Array.from({length: 24}, (_, index) => `let slot${index} = value${index}`)
      .join('\n')
    const shifts = Array.from({length: 23}, (_, index) => `slot${index} = slot${index + 1}`)
      .join('\n')
    const report = analyzeSource('numeric-input-loop.ts', `
      export function shifting(${parameters.join(', ')}, steps: number): number {
        ${slots}
        for (let index = 0; index < steps; index += 1) {
          ${shifts}
        }
        return slot0
      }
      export function stable(value: number, steps: number): number {
        let rounded = value
        for (let index = 0; index < steps; index += 1) rounded = Math.floor(rounded)
        return rounded % 2
      }
    `)

    expect(analyzedFunction(report, 'shifting').ensures[0]).toContain('possibly NaN')
    expectOnlyRequirement(report, 'stable', 'Number.isFinite(value)')
  })

  test('records and fixed tuples are nameable; arrays and nullable numbers keep assumptions', () => {
    const report = analyzeSource('numeric-shapes.ts', `
      export function zeroWidth(config: {width: number; height: number}): number {
        return config.width * 0
      }
      export function zeroFirst(pair: [number, number]): number {
        return pair[0] * 0
      }
      export function first(values: number[]): number { return values[0] ?? 0 }
      export function optional(value: number | undefined): number {
        return value === undefined ? 0 : value
      }
    `)

    const width = analyzedFunction(report, 'zeroWidth')
    expectOnlyRequirement(report, 'zeroWidth', 'Number.isFinite(config.width)')
    expect(width.assumptions).toEqual([])
    const tuple = analyzedFunction(report, 'zeroFirst')
    expectOnlyRequirement(report, 'zeroFirst', 'Number.isFinite(pair[0])')
    expect(tuple.assumptions).toEqual([
      'pair is a plain array of exactly 2 elements — its length counts its elements, and every index below the length holds an element',
      'pair[1] is a number',
    ])
    expect(analyzedFunction(report, 'first').assumptions).toEqual([
      'values is a plain array — its length counts its elements, and every index below the length holds an element',
      'every values element is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'optional').assumptions).toEqual([
      'value is undefined or a finite non-NaN number',
    ])
  })
})
