import {describe, expect, test} from 'bun:test'
import type {AnalysisReport} from '../src/index.ts'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

function unsupportedFunction(report: AnalysisReport, name: string) {
  const fn = report.functions.find(candidate => candidate.name === name)
  if (fn == null || fn.kind !== 'unsupported') throw new Error(`Expected ${name} to be unsupported`)
  return fn
}

describe('numeric intersections with phantom metadata', () => {
  test('analyzes direct parameters, record fields, and same-file calls as numbers', () => {
    const report = analyzeSource('number-metadata.ts', `
      declare const unit: unique symbol
      type UniqueBranded = number & {readonly [unit]?: 'pixels'}
      type StringBranded = number & {readonly _brand?: 'pixels'}
      type Gauged = number & {readonly _gauge?: unknown}

      function reciprocal(value: StringBranded): number {
        return 1 / value
      }
      function plainDirect(width: number): number {
        return width / 2
      }
      export function direct(width: UniqueBranded): number {
        return width / 2
      }
      export function field(box: {width: StringBranded}): number {
        return box.width / 2
      }
      export function propagated(value: StringBranded): number {
        return reciprocal(value)
      }
      export function gauged(value: Gauged): number {
        return value / 2
      }
    `)

    expect(analyzedFunction(report, 'direct').ensures)
      .toEqual(analyzedFunction(report, 'plainDirect').ensures)
    expect(analyzedFunction(report, 'field').ensures)
      .toEqual(analyzedFunction(report, 'plainDirect').ensures)
    expect(analyzedFunction(report, 'gauged').ensures)
      .toEqual(analyzedFunction(report, 'plainDirect').ensures)
    const propagatedRequirements = requirementsBesidesInputFiniteness(analyzedFunction(report, 'propagated'))
    expect(propagatedRequirements).toHaveLength(1)
    expect(propagatedRequirements[0]).toStartWith('value is nonzero (division at number-metadata.ts:')
  })

  test('keeps plain-number contracts unchanged and does not interpret literal metadata', () => {
    const report = analyzeSource('number-metadata-contracts.ts', `
      type Ranged = number & {
        readonly _range?: {readonly min: 0; readonly max: 1}
        readonly _clamped?: true
      }
      export function plain(value: number): number {
        return value / 2
      }
      export function branded(value: Ranged): number {
        return value / 2
      }
    `)

    const plain = analyzedFunction(report, 'plain')
    const branded = analyzedFunction(report, 'branded')
    expect(branded.assumptions).toEqual(plain.assumptions)
    expect(branded.ensures).toEqual(plain.ensures)
    expect(branded.requires).toHaveLength(plain.requires.length)
    expect(branded.requires[0]).toContain('Number.isFinite(value)')
  })

  test('rejects intersections that can add runtime operations or broad data', () => {
    const report = analyzeSource('number-runtime-intersections.ts', `
      type BroadField = number & {readonly payload: number}
      type RequiredLiteral = number & {readonly tag: 'metadata'}
      type MutableLiteral = number & {tag?: 'metadata'}
      type RequiredUnknown = number & {readonly metadata: unknown}
      type MutableUnknown = number & {metadata?: unknown}
      type AnyMetadata = number & {readonly metadata?: any}
      type Callable = number & ((input: number) => number)
      type Constructable = number & {new (): object}
      type Indexed = number & {readonly [key: string]: 'metadata'}
      type ArrayLike = number & readonly 'metadata'[]
      type TupleLike = number & readonly ['metadata']
      type Method = number & {format(): string}
      type MixedPrimitive = number & string
      class RuntimeMetadata { readonly tag = 'metadata' }
      type Classed = number & RuntimeMetadata

      export function broadField(value: BroadField): number { return value + 1 }
      export function requiredLiteral(value: RequiredLiteral): number { return value + 1 }
      export function mutableLiteral(value: MutableLiteral): number { return value + 1 }
      export function requiredUnknown(value: RequiredUnknown): number { return value + 1 }
      export function mutableUnknown(value: MutableUnknown): number { return value + 1 }
      export function anyMetadata(value: AnyMetadata): number { return value + 1 }
      export function callable(value: Callable): number { return value + 1 }
      export function constructable(value: Constructable): number { return value + 1 }
      export function indexed(value: Indexed): number { return value + 1 }
      export function arrayLike(value: ArrayLike): number { return value + 1 }
      export function tupleLike(value: TupleLike): number { return value + 1 }
      export function method(value: Method): number { return value + 1 }
      export function mixedPrimitive(value: MixedPrimitive): number { return value + 1 }
      export function classed(value: Classed): number { return value + 1 }
    `)

    for (const name of [
      'broadField',
      'requiredLiteral',
      'mutableLiteral',
      'requiredUnknown',
      'mutableUnknown',
      'anyMetadata',
      'callable',
      'constructable',
      'indexed',
      'arrayLike',
      'tupleLike',
      'method',
      'mixedPrimitive',
      'classed',
    ]) {
      expect(unsupportedFunction(report, name).unsupported).toContain('function parameter with type')
    }
  })
})