import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

function contractWithoutSites(source: string) {
  const fn = analyzedFunction(analyzeSource('contract.ts', source), 'calculate')
  const withoutSite = (line: string): string => line.replace(/contract\.ts:\d+:\d+/g, 'site')
  return {
    requires: fn.requires.map(requirement => withoutSite(requirement).split(' (')[0]),
    assumptions: fn.assumptions.map(withoutSite),
    ensures: fn.ensures.map(withoutSite),
  }
}

describe('numeric intersections', () => {
  test('object members preserve the ordinary number contract and grant no facts', () => {
    const plain = contractWithoutSites(`
      function calculate(value: number, divisor: number): number {
        return value / divisor
      }
    `)
    const branded = contractWithoutSites(`
      declare const unit: unique symbol
      interface PixelMarker {
        readonly [unit]?: 'pixels'
      }
      type Pixels = number & PixelMarker
      type ClaimedUnitInterval = number & {readonly minimum: 0; readonly maximum: 1}
      function calculate(value: Pixels, divisor: ClaimedUnitInterval): number {
        return value / divisor
      }
    `)
    expect(branded).toEqual(plain)
  })

  test('literal numeric constituents retain their exact ranges', () => {
    const report = analyzeSource('literal-brands.ts', `
      type Small = 1 & {readonly __brand: 'small'}
      type Large = 2 & {readonly __brand: 'large'}
      type Zero = 0 & {readonly __brand: 'zero'}
      type Layout = {columns: Small | Large}

      function columns(layout: Layout): number {
        return layout.columns
      }
      function divideByZero(divisor: Zero): number {
        return 1 / divisor
      }
    `)
    const columns = analyzedFunction(report, 'columns')
    expect(columns.requires).toEqual([])
    expect(columns.ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
    const divideByZero = report.functions.find(fn => fn.name === 'divideByZero')
    expect(divideByZero?.kind).toBe('partial')
    if (divideByZero?.kind === 'partial') {
      expect(divideByZero.partialReasons[0])
        .toContain('division has a divisor that is definitely zero')
    }
  })

  test('generic and stacked brands compose through supported value shapes', () => {
    const report = analyzeSource('composed-brands.ts', `
      declare const brand: unique symbol
      type Brand<Value, Name extends string> = Value & {readonly [brand]: Name}
      type Pixels = Brand<number, 'pixels'> & {readonly __axis?: 'horizontal'}

      function maybe(value: Pixels | null): number {
        if (value === null) return 0
        return Math.max(0, value)
      }
      function first(values: Pixels[]): number {
        return values[0] ?? 0
      }
      function identity(value: Pixels): Pixels {
        return value
      }
    `)
    expect(analyzedFunction(report, 'maybe').ensures)
      .toEqual(['return is a finite number at least 0'])
    expect(analyzedFunction(report, 'first').assumptions)
      .toContain('every values element is finite and not NaN')
    expect(analyzedFunction(report, 'identity').requires[0])
      .toContain('Number.isFinite(value)')
  })

  test('object-side operations stop instead of inheriting numeric claims', () => {
    const report = analyzeSource('intersection-operations.ts', `
      type Marker = {readonly minimum: 0}
      type Claimed = number & Marker
      type Callable = number & (() => number)
      type Indexed = number & readonly number[]
      type Constructable = number & {new (): object}

      function readMinimum(input: Marker): 0 { return input.minimum }
      function direct(value: Claimed): number { return value.minimum }
      function throughHelper(value: Claimed): number { return readMinimum(value) }
      function destructure(value: Claimed): number {
        const {minimum} = value
        return minimum
      }
      function call(value: Callable): number { return value() }
      function index(value: Indexed): number { return value[0] ?? 0 }
      function construct(value: Constructable): number {
        new value()
        return 0
      }
      function calculate(value: Claimed): number { return value / 2 }
    `)
    expect(report.functions.find(fn => fn.name === 'readMinimum')?.kind).toBe('analyzed')
    expect(report.functions.find(fn => fn.name === 'direct')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'throughHelper')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'destructure')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'call')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'index')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'construct')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'calculate')?.kind).toBe('analyzed')
  })

  test('typeof treats a numeric intersection as a number', () => {
    const report = analyzeSource('branded-typeof.ts', `
      type Pixels = number & {readonly __brand: 'pixels'}
      function calculate(value: Pixels): number {
        if (typeof value === 'number') return 1
        return 1 / 0
      }
    `)
    const calculate = analyzedFunction(report, 'calculate')
    expect(calculate.requires).toHaveLength(1)
    expect(calculate.requires[0]).toContain('Number.isFinite(value)')
    expect(calculate.ensures).toEqual(['return is a finite integer number from 1 through 1'])
  })

  test('object member shapes do not change the numeric interpretation', () => {
    const report = analyzeSource('intersection-members.ts', `
      class Box {
        readonly kind: 'pixels' = 'pixels'
      }

      type BroadProperty = number & {readonly value: number}
      type Callable = number & (() => number)
      type ArrayMember = number & readonly string[]
      type ClassMember = number & Box
      type MappedMember = number & Readonly<{kind: string}>
      type MixedPrimitive = number & string

      function broadProperty(value: BroadProperty): number { return value }
      function callable(value: Callable): number { return value }
      function arrayMember(value: ArrayMember): number { return value }
      function classMember(value: ClassMember): number { return value }
      function mappedMember(value: MappedMember): number { return value }
      function mixedPrimitive(value: MixedPrimitive): number { return 0 }
    `)
    const numericNames = [
      'broadProperty',
      'callable',
      'arrayMember',
      'classMember',
      'mappedMember',
    ]
    for (const name of numericNames) {
      expect(report.functions.find(fn => fn.name === name)?.kind).toBe('analyzed')
    }
    expect(report.functions.find(fn => fn.name === 'mixedPrimitive')?.kind).toBe('unsupported')
  })
})
