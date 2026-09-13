import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

describe('accessed record fields', () => {
  test('carries selected project fields through calls, returns, and assignments', () => {
    const report = analyzeSource('record-field-flow.ts', `
      type WidePoint = {x: number; y: number}
      type HorizontalPoint = {x: number}

      function readX(point: HorizontalPoint): number {
        return point.x
      }
      function throughCall(point: WidePoint): number {
        return readX(point)
      }
      function asHorizontal(point: WidePoint): HorizontalPoint {
        return point
      }
      function throughReturn(point: WidePoint): number {
        return asHorizontal(point).x
      }

      let stored: HorizontalPoint = {x: 0}
      function store(point: WidePoint): void {
        stored = point
      }
      function readStored(): number {
        return stored.x
      }

      function ignored(point: WidePoint): number {
        return 0
      }
      function unselectedInfinityIsAllowed(): number {
        return throughCall({x: 1, y: Infinity})
      }
    `)

    for (const name of [
      'throughCall',
      'asHorizontal',
      'throughReturn',
      'store',
      'readStored',
      'ignored',
      'unselectedInfinityIsAllowed',
    ]) {
      expect(report.functions.find(candidate => candidate.name === name)?.kind).toBe('analyzed')
    }
    for (const name of ['throughCall', 'asHorizontal', 'throughReturn', 'store', 'ignored']) {
      expect(analyzedFunction(report, name).requires.map(line => line.split(' (input at')[0])).toEqual([
        'Number.isFinite(point.x)',
      ])
    }
    expect(analyzedFunction(report, 'asHorizontal').ensures).toEqual([
      'return.x is a finite number',
    ])
    expect(analyzedFunction(report, 'unselectedInfinityIsAllowed').requires).toEqual([])
  })

  test('carries selections through typed arrows, arrays, tuples, and ??=', () => {
    const report = analyzeSource('record-container-flow.ts', `
      type Wide = {x: number; y: number}
      type Narrow = {x: number}

      const narrow: (value: Wide) => Narrow = value => value
      function throughArrow(value: Wide): number {
        return narrow(value).x
      }

      function readArray(values: Narrow[]): number {
        return values[0]!.x
      }
      function throughArray(values: Wide[]): number {
        return readArray(values)
      }

      function readTuple(values: [Narrow]): number {
        return values[0].x
      }
      function throughTuple(values: [Wide]): number {
        return readTuple(values)
      }

      function withFallback(initial: Narrow | null, fallback: Wide): number {
        let current: Narrow | null = initial
        current ??= fallback
        return current.x
      }

      function choose(narrowValue: Narrow, wideValue: Wide, useWide: boolean): Narrow {
        return useWide ? wideValue : narrowValue
      }
      function throughConditional(narrowValue: Narrow, wideValue: Wide, useWide: boolean): number {
        return choose(narrowValue, wideValue, useWide).x
      }
      function throughCoalesce(maybe: Narrow | null, fallback: Wide): number {
        const current = maybe ?? fallback
        return current.x
      }

      type Box = {point: Narrow}
      function readBox(box: Box): number {
        return box.point.x
      }
      function packBox(narrowValue: Narrow, wideValue: Wide, useWide: boolean): Box {
        return {point: useWide ? wideValue : narrowValue}
      }
      function throughBox(narrowValue: Narrow, wideValue: Wide, useWide: boolean): number {
        return readBox(packBox(narrowValue, wideValue, useWide))
      }

      function readNestedArray(values: Narrow[][]): number {
        return values[0]![0]!.x
      }
      function throughNestedArray(narrowValue: Narrow, wideValue: Wide, useWide: boolean): number {
        return readNestedArray([[useWide ? wideValue : narrowValue]])
      }

      function throughNonNull(narrowValue: Narrow, wideValue: Wide, useWide: boolean): Narrow {
        return (useWide ? wideValue : narrowValue)!
      }
      function throughConstObject(narrowValue: Narrow, wideValue: Wide, useWide: boolean): Box {
        return ({point: useWide ? wideValue : narrowValue} as const)
      }
    `)

    for (const name of [
      'narrow',
      'throughArrow',
      'readArray',
      'throughArray',
      'readTuple',
      'throughTuple',
      'withFallback',
      'choose',
      'throughConditional',
      'throughCoalesce',
      'readBox',
      'packBox',
      'throughBox',
      'readNestedArray',
      'throughNestedArray',
      'throughNonNull',
      'throughConstObject',
    ]) {
      expect(report.functions.find(candidate => candidate.name === name)?.kind).toBe('analyzed')
    }
    expect(analyzedFunction(report, 'throughArrow').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(value.x)',
    ])
    expect(analyzedFunction(report, 'throughArray').assumptions).toContain(
      'values[each].x is finite and not NaN',
    )
    expect(analyzedFunction(report, 'throughTuple').assumptions).toContain(
      'values[0].x is finite and not NaN',
    )
    expect(analyzedFunction(report, 'withFallback').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(fallback.x)',
    ])
    expect(analyzedFunction(report, 'withFallback').assumptions).toContain(
      'initial is null or initial.x is finite and not NaN',
    )
    expect(analyzedFunction(report, 'throughConditional').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(narrowValue.x)',
      'Number.isFinite(wideValue.x)',
    ])
    expect(analyzedFunction(report, 'throughCoalesce').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(fallback.x)',
    ])
    for (const name of [
      'packBox',
      'throughBox',
      'throughNestedArray',
      'throughNonNull',
      'throughConstObject',
    ]) {
      expect(analyzedFunction(report, name).requires.map(line => line.split(' (input at')[0])).toEqual([
        'Number.isFinite(narrowValue.x)',
        'Number.isFinite(wideValue.x)',
      ])
    }
  })

  test('carries selected fields through tagged-union calls', () => {
    const report = analyzeSource('record-union-flow.ts', `
      type WideResult =
        | {kind: 'ok'; value: number; detail: number}
        | {kind: 'error'; code: number; detail: number}
      type Result =
        | {kind: 'ok'; value: number}
        | {kind: 'error'; code: number}

      function readResult(result: Result): number {
        switch (result.kind) {
          case 'ok': return result.value
          case 'error': return result.code
        }
      }
      function throughResult(result: WideResult): number {
        return readResult(result)
      }
      function ignoredDetail(): number {
        return throughResult({kind: 'ok', value: 1, detail: Infinity})
      }
    `)

    for (const name of ['readResult', 'throughResult', 'ignoredDetail']) {
      expect(report.functions.find(candidate => candidate.name === name)?.kind).toBe('analyzed')
    }
    expect(analyzedFunction(report, 'throughResult').assumptions.some(line =>
      line.includes('detail'))).toBe(false)
  })

  test('keeps constructed return facts and executes object literal calculations', () => {
    const report = analyzeSource('record-report-filter.ts', `
      type Point = {x: number; y: number}
      function makePoint(x: number, y: number): Point {
        return {x, y}
      }

      type Hidden = {unused: number}
      function makeRisky(total: number, divisor: number): Hidden {
        return {unused: total / divisor}
      }

      type Layout = {left: number; top: number; width: number; unused: number}
      function area(layout: Layout): number {
        return layout.left + layout.top + layout.width
      }
    `)

    // Selected fields limit what Freerange must trust about typed inputs. A supported
    // object literal is concrete code, so its known return fields remain useful output.
    expect(analyzedFunction(report, 'makePoint').ensures).toEqual([
      'return.x is a finite number',
      'return.y is a finite number',
    ])
    expect(analyzedFunction(report, 'makeRisky').ensures).toHaveLength(1)
    expect(analyzedFunction(report, 'makeRisky').ensures[0]).toStartWith('return.unused is ')
    expect(analyzedFunction(report, 'makeRisky').requires.some(line =>
      line.startsWith('divisor is nonzero'))).toBe(true)
    expect(analyzedFunction(report, 'area').requires.map(line => line.split(' (input at')[0])).toEqual([
      'every number field of layout used in this file is finite',
    ])
  })

  test('a read in unsupported code still selects the field for the file', () => {
    const report = analyzeSource('record-unsupported-selection.ts', `
      type Shared = {x: number; y: number}
      function unsupported(point: Shared): number {
        return point.y ** 2
      }
      function ignored(point: Shared): number {
        return 0
      }
    `)

    expect(report.functions.find(candidate => candidate.name === 'unsupported')?.kind).toBe('unsupported')
    expect(analyzedFunction(report, 'ignored').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(point.y)',
    ])
  })

  test('analyzes accessed fields through structural types, nesting, and inheritance', () => {
    const report = analyzeSource('external-records.ts', `
      type Pointer = {x: number; y: number; timeStamp: number}
      type HorizontalSample = {clientX: number}

      function readClientX(event: HorizontalSample): number {
        return event.clientX
      }
      function readThroughWrapper(event: HorizontalSample): number {
        return readClientX(event)
      }
      function fromMouseEvent(event: MouseEvent): number {
        return readThroughWrapper(event)
      }
      function fromAssignment(event: MouseEvent): number {
        const sample: HorizontalSample = event
        return readClientX(sample)
      }
      function asSample(event: MouseEvent): HorizontalSample {
        return event
      }
      function fromReturn(event: MouseEvent): number {
        return asSample(event).clientX
      }
      function fromDestructuring({clientX}: MouseEvent): number {
        return clientX
      }

      interface LocalMouseEvent extends MouseEvent {
        localSequence: number
      }
      function fromInheritedField(event: LocalMouseEvent): number {
        return event.clientY
      }

      function viewportWidth(event: MouseEvent): number {
        return event.view?.visualViewport?.width ?? 0
      }

      function latestPointer(
        previous: Pointer,
        click: MouseEvent | null,
        mousemove: MouseEvent | null,
      ): Pointer {
        const event = click == null ? mousemove
          : mousemove == null || click.timeStamp > mousemove.timeStamp ? click
          : mousemove
        return event != null && event.timeStamp >= previous.timeStamp
          ? {x: event.clientX, y: event.clientY, timeStamp: event.timeStamp}
          : previous
      }
    `)

    for (const name of [
      'fromMouseEvent',
      'fromAssignment',
      'fromReturn',
      'fromDestructuring',
      'fromInheritedField',
      'viewportWidth',
      'latestPointer',
    ]) {
      expect(report.functions.find(candidate => candidate.name === name)?.kind).toBe('analyzed')
    }
    expect(analyzedFunction(report, 'fromMouseEvent').ensures).toEqual(['return is a finite number'])
    // Writing x and y into the returned object does not select them. Only timeStamp is
    // read elsewhere in this file, including through the return type.
    expect(analyzedFunction(report, 'latestPointer').ensures).toEqual([
      'return.timeStamp is a finite number',
    ])
  })

  test('treats external numeric fields as assumptions rather than caller requirements', () => {
    const report = analyzeSource('external-assumptions.ts', `
      function readX(event: MouseEvent): number {
        return event.clientX
      }
      function ignoreEvent(event: MouseEvent): number {
        return 0
      }
    `)
    const readX = analyzedFunction(report, 'readX')
    expect(readX.requires).toEqual([])
    expect(readX.assumptions).toContain('event.clientX is finite and not NaN')
    expect(analyzedFunction(report, 'ignoreEvent').assumptions).toEqual([])
  })

  test('keeps external numeric fields unrefined after a completed call', () => {
    // A call requires finite numbers only in project fields, so it checks nothing about
    // highWaterMark, which is declared in lib.dom.d.ts. Number.parseFloat('abc') is NaN.
    const report = analyzeSource('external-after-call.ts', `
      function ignore(strategy: QueuingStrategyInit): void {}
      function parsedHighWaterMark(text: string): number {
        const strategy: QueuingStrategyInit = {highWaterMark: Number.parseFloat(text)}
        ignore(strategy)
        return strategy.highWaterMark
      }
    `)
    expect(analyzedFunction(report, 'parsedHighWaterMark').ensures).toEqual([
      'return is a possibly NaN number from -Infinity through Infinity (NaN possible from the operation at external-after-call.ts:4:63)',
    ])
  })

  test('does not manufacture fields through predicates, mapped types, or recursion', () => {
    const report = analyzeSource('external-boundaries.ts', `
      function claimsMouseEvent(event: Event): event is MouseEvent {
        return true
      }
      function narrowed(event: Event): number {
        if (!claimsMouseEvent(event)) return 0
        return event.clientX
      }
      function mapped(event: Readonly<MouseEvent>): number {
        return event.clientX
      }
      function grandparentNodeType(node: Node): number {
        return node.parentNode?.parentNode?.nodeType ?? 0
      }

      type RecursiveTarget<T> = [RecursiveTarget<T[]>]
      type RecursiveSource<T> = [RecursiveSource<T[]>]
      function recursiveTarget(value: RecursiveTarget<number>): number {
        return 0
      }
      function recursiveSource(value: RecursiveSource<number>): number {
        return recursiveTarget(value)
      }
    `)
    expect(report.functions.find(candidate => candidate.name === 'narrowed')?.kind).toBe('partial')
    expect(report.functions.find(candidate => candidate.name === 'mapped')?.kind).toBe('partial')
    expect(report.functions.find(candidate => candidate.name === 'grandparentNodeType')?.kind).not.toBe('analyzed')
    expect(report.functions.find(candidate => candidate.name === 'recursiveTarget')?.kind).not.toBe('analyzed')
    expect(report.functions.find(candidate => candidate.name === 'recursiveSource')?.kind).not.toBe('analyzed')
  })

  test('bounds recursive generic field propagation', () => {
    const report = analyzeSource('recursive-record-flow.ts', `
      type First<T> = {next: First<T[]>}
      type Second<T> = {next: Second<T[]>}

      function readNext(value: First<number>): First<number[]> {
        return value.next
      }
      function firstFromSecond(value: Second<number>): First<number> {
        return value
      }
      function secondFromNestedFirst(value: First<number[]>): Second<number> {
        return value
      }
      function use(value: Second<number>): First<number[]> {
        return readNext(firstFromSecond(value))
      }
    `)

    for (const name of ['readNext', 'firstFromSecond', 'secondFromNestedFirst', 'use']) {
      expect(report.functions.find(candidate => candidate.name === name)?.kind).toBe('analyzed')
    }
  })

  test('conditional property receivers require a named value to select every source field', () => {
    const direct = analyzeSource('direct-record-choice.ts', `
      type Wide = {x: number; y: number}
      type Narrow = {x: number}
      function direct(wide: Wide, narrow: Narrow, useWide: boolean): number {
        return (useWide ? wide : narrow).x
      }
      function directNullish(maybe: Narrow | null, fallback: Wide): number {
        return (maybe ?? fallback).x
      }
    `)
    expect(direct.functions.find(candidate => candidate.name === 'direct')?.kind).toBe('partial')
    expect(direct.functions.find(candidate => candidate.name === 'directNullish')?.kind).toBe('partial')

    const named = analyzeSource('named-record-choice.ts', `
      type Wide = {x: number; y: number}
      type Narrow = {x: number}
      function named(wide: Wide, narrow: Narrow, useWide: boolean): number {
        const chosen = useWide ? wide : narrow
        return chosen.x
      }
      function namedNullish(maybe: Narrow | null, fallback: Wide): number {
        const chosen = maybe ?? fallback
        return chosen.x
      }
    `)
    expect(analyzedFunction(named, 'named').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(wide.x)',
      'Number.isFinite(narrow.x)',
    ])
    expect(analyzedFunction(named, 'namedNullish').requires.map(line => line.split(' (input at')[0])).toEqual([
      'Number.isFinite(fallback.x)',
    ])
  })
})
