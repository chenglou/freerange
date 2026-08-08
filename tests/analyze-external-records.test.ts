import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

describe('declaration-file records', () => {
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
    expect(analyzedFunction(report, 'latestPointer').ensures).toEqual([
      'return.x is a finite number',
      'return.y is a finite number',
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
    `)
    expect(report.functions.find(candidate => candidate.name === 'narrowed')?.kind).toBe('partial')
    expect(report.functions.find(candidate => candidate.name === 'mapped')?.kind).toBe('partial')
    expect(report.functions.find(candidate => candidate.name === 'grandparentNodeType')?.kind).not.toBe('analyzed')
  })
})
