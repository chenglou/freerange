import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

describe('finite number input contracts', () => {
  test('plain numbers use one uniform caller rule', () => {
    const report = analyzeSource('finite-input-shapes.ts', `
      type Layout = {width: number; height: number; gap: number; label: string}

      function ignored(value: number, layout: Layout): number {
        return 0
      }
      function rejectedUnusedInput(): number {
        return ignored(Infinity, {width: 1, height: 2, gap: 3, label: 'x'})
      }
      function literals(value: 1 | 2, layout: {columns: 2 | 3}): number {
        return value + layout.columns
      }
      function nullable(value: number | null, config: {width: number | null}): number {
        if (value === null || config.width === null) return 0
        return value + config.width
      }
      function firstOr(values: number[], fallback: number): number {
        return values[0] ?? fallback
      }
      function defaulted(value: number = 4): number {
        return value
      }
      function omitted(): number {
        return defaulted()
      }
    `)

    const ignored = analyzedFunction(report, 'ignored')
    expect(ignored.assumptions).toEqual([])
    expect(ignored.requires).toEqual([
      'Number.isFinite(value) (input at finite-input-shapes.ts:4:24)',
      'every number field in layout is finite (input at finite-input-shapes.ts:4:39)',
    ])
    const rejectedUnused = report.functions.find(fn => fn.name === 'rejectedUnusedInput')
    if (rejectedUnused?.kind !== 'partial') throw new Error('Expected rejectedUnusedInput to be partial')
    expect(rejectedUnused.partialReasons[0]).toContain('passes a number that is definitely not finite')

    expect(analyzedFunction(report, 'literals').requires).toEqual([])
    expect(analyzedFunction(report, 'nullable').requires).toEqual([])
    expect(analyzedFunction(report, 'nullable').assumptions).toEqual([
      'value is null or a finite non-NaN number',
      'config.width is null or a finite non-NaN number',
    ])

    const firstOr = analyzedFunction(report, 'firstOr')
    expect(firstOr.requires[0]).toContain('Number.isFinite(fallback)')
    expect(firstOr.assumptions).toContain('every values element is finite and not NaN')
    expect(analyzedFunction(report, 'defaulted').requires[0]).toContain('Number.isFinite(value)')
    expect(analyzedFunction(report, 'omitted').requires).toEqual([])
  })

  test('same-file calls prove, propagate, or reject the same requirement', () => {
    const report = analyzeSource('finite-input-calls.ts', `
      function identity(value: number): number {
        return value
      }
      function safe(): number {
        return identity(4)
      }
      function derived(value: number): number {
        return identity(value * 2)
      }
      function bad(): number {
        return identity(Infinity)
      }
      function overflowing(): number {
        return derived(1.7976931348623157e308)
      }
      function afterCall(value: number): number {
        const product = value * 2
        identity(product)
        console.assert(Number.isFinite(product))
        return product - product
      }
      function definiteNaN(): number {
        return identity(Infinity - Infinity)
      }
      function repeated(value: number): number {
        const product = value * 2
        identity(product)
        identity(product)
        return product - product
      }
      function oneSided(value: number, flag: boolean): number {
        const product = value * 2
        if (flag) identity(product)
        return product - product
      }
      function reassigned(value: number): number {
        let product = value * 2
        identity(product)
        product = value * 2
        return product - product
      }
      function looped(value: number, count: number): number {
        let product = value
        for (let index = 0; index < count; index++) {
          product = product * 2
          identity(product)
        }
        return product - product
      }
    `)

    expect(analyzedFunction(report, 'safe').requires).toEqual([])
    expect(analyzedFunction(report, 'derived').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(value)',
      'Number.isFinite((value * 2))',
    ])
    expect(analyzedFunction(report, 'derived').requires[1])
      .toContain('(input at finite-input-calls.ts:2:25)')
    const afterCall = analyzedFunction(report, 'afterCall')
    expect(afterCall.assertions?.map(assertion => assertion.verdict)).toEqual(['proven'])
    expect(afterCall.ensures).toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'repeated').requires).toHaveLength(2)
    expect(analyzedFunction(report, 'repeated').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'oneSided').ensures[0]).toContain('possibly NaN')
    expect(analyzedFunction(report, 'reassigned').ensures[0]).toContain('possibly NaN')

    const looped = report.functions.find(fn => fn.name === 'looped')
    if (looped?.kind !== 'partial') throw new Error('Expected looped to be partial')
    expect(looped.partialReasons[0]).toContain("could not verify identity's number input")

    for (const name of ['bad', 'overflowing', 'definiteNaN']) {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn?.kind !== 'partial') throw new Error(`Expected ${name} to be partial`)
      expect(fn.partialReasons[0]).toContain('passes a number that is definitely not finite')
    }
  })

  test('record calls stay simple when fields are already known finite', () => {
    const report = analyzeSource('finite-record-calls.ts', `
      type Bounds = {minimum: number; maximum: number}

      function width(bounds: Bounds): number {
        return bounds.maximum - bounds.minimum
      }
      function forwarded(bounds: Bounds): number {
        return width(bounds)
      }
      function fromLiterals(): number {
        return width({minimum: 1, maximum: 4})
      }
      function fromCalculation(value: number): number {
        return width({minimum: value, maximum: value * 2})
      }
      function guardedCalculation(value: number): number {
        const maximum = value * 2
        if (!Number.isFinite(maximum)) return 0
        return width({minimum: value, maximum})
      }
      type BoundsChoice =
        | {kind: 'small'; minimum: 1; maximum: 4}
        | {kind: 'large'; minimum: 10; maximum: 20}
      function fromUnion(bounds: BoundsChoice): number {
        return width(bounds)
      }
      type NestedBounds = {horizontal: {minimum: number; maximum: number}; label: string}
      function nestedWidth(bounds: NestedBounds): number {
        return bounds.horizontal.maximum - bounds.horizontal.minimum
      }
      function reorderedNestedWidth(bounds: NestedBounds): number {
        return nestedWidth({
          label: bounds.label,
          horizontal: {
            maximum: bounds.horizontal.maximum,
            minimum: bounds.horizontal.minimum,
          },
        })
      }
    `)

    expect(analyzedFunction(report, 'forwarded').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(bounds.minimum)',
      'Number.isFinite(bounds.maximum)',
    ])
    expect(analyzedFunction(report, 'fromLiterals').requires).toEqual([])
    expect(analyzedFunction(report, 'fromUnion').requires).toEqual([])
    expect(analyzedFunction(report, 'guardedCalculation').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(value)',
    ])
    for (const name of ['nestedWidth', 'reorderedNestedWidth']) {
      expect(analyzedFunction(report, name).requires.map(line => line.split(' (input at')[0])).toEqual([
        'Number.isFinite(bounds.horizontal.minimum)',
        'Number.isFinite(bounds.horizontal.maximum)',
      ])
    }

    const unnameable = report.functions.find(fn => fn.name === 'fromCalculation')
    if (unnameable?.kind !== 'partial') throw new Error('Expected fromCalculation to be partial')
    expect(unnameable.partialReasons[0]).toContain("could not verify width's number input")
  })

  test('written checks deduplicate with the automatic contract', () => {
    const report = analyzeSource('written-finite-inputs.ts', `
      function explicitFinite(value: number): number {
        console.assert(Number.isFinite(value))
        return value
      }
      function explicitInteger(value: number): number {
        console.assert(Number.isInteger(value))
        return value
      }
      function recordField(config: {width: number; height: number}): number {
        console.assert(Number.isFinite(config.width))
        return config.width + config.height
      }
      function destructured({width: availableWidth}: {width: number}): number {
        return 1 / availableWidth
      }
      function destructuredWithRemainder(
        {width: availableWidth}: {width: number; height: number},
      ): number {
        return availableWidth
      }
      type Result =
        | {kind: 'ok'; value: number}
        | {kind: 'error'; value: number}
      function checkedResult(result: Result): number {
        console.assert(Number.isFinite(result.value))
        return result.value
      }
      function badCheckedResult(): number {
        return checkedResult({kind: 'ok', value: Infinity})
      }
      function integerField(config: {value: number}): number {
        console.assert(Number.isInteger(config.value))
        return config.value
      }
      function integerDestructured({value}: {value: number}): number {
        console.assert(Number.isInteger(value))
        return value
      }
      function nonnegativeField(config: {value: number}): number {
        console.assert(config.value >= 0)
        return config.value
      }
      function boundedWrapper(value: number): number {
        const bounded = Math.min(value, 100)
        return explicitFinite(bounded)
      }
    `)

    expect(analyzedFunction(report, 'explicitFinite').requires).toHaveLength(1)
    expect(analyzedFunction(report, 'explicitFinite').requires[0]).toContain('Number.isFinite(value)')
    expect(analyzedFunction(report, 'explicitInteger').requires).toHaveLength(1)
    expect(analyzedFunction(report, 'explicitInteger').requires[0]).toContain('Number.isInteger(value)')
    expect(analyzedFunction(report, 'recordField').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(config.width)',
      'Number.isFinite(config.height)',
    ])
    expect(analyzedFunction(report, 'destructured').requires.some(line =>
      line.startsWith('availableWidth is nonzero'))).toBe(true)
    expect(analyzedFunction(report, 'destructuredWithRemainder').requires[0])
      .toContain('availableWidth and height are finite')
    const checkedResult = analyzedFunction(report, 'checkedResult')
    expect(checkedResult.requires).toHaveLength(1)
    expect(checkedResult.requires[0]).toContain('Number.isFinite(result.value)')
    expect(checkedResult.assumptions).toEqual([])
    const badCheckedResult = report.functions.find(fn => fn.name === 'badCheckedResult')
    if (badCheckedResult?.kind !== 'partial') throw new Error('Expected badCheckedResult to be partial')
    expect(badCheckedResult.partialReasons[0]).toContain('declared requirement definitely false')
    for (const [name, expression] of [
      ['integerField', 'config.value'],
      ['integerDestructured', 'value'],
    ] as const) {
      const integer = analyzedFunction(report, name)
      expect(integer.requires).toHaveLength(1)
      expect(integer.requires[0]).toContain(`Number.isInteger(${expression})`)
    }
    const nonnegativeField = analyzedFunction(report, 'nonnegativeField')
    expect(nonnegativeField.requires).toHaveLength(2)
    expect(nonnegativeField.requires.some(line => line.startsWith('config.value >= 0'))).toBe(true)
    expect(analyzedFunction(report, 'boundedWrapper').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(value)',
    ])
  })

  test('partially supported functions do not publish the automatic contract', () => {
    const report = analyzeSource('partial-finite-input.ts', `
      function unsupported(value: number): number {
        return value ** 2
      }
      function partial(value: number): number {
        return unsupported(value)
      }
      function invalidPartialCall(): number {
        return partial(Infinity)
      }
    `)

    const partial = report.functions.find(fn => fn.name === 'partial')
    if (partial?.kind !== 'partial') throw new Error('Expected partial to be partially supported')
    expect(partial.assumptions).toEqual(['value is finite and not NaN'])
    expect('requires' in partial).toBe(false)

    const invalidCall = report.functions.find(fn => fn.name === 'invalidPartialCall')
    if (invalidCall?.kind !== 'partial') throw new Error('Expected invalidPartialCall to be partially supported')
    expect(invalidCall.partialReasons[0]).toContain('passes a number that is definitely not finite')
  })
})
