import {describe, expect, test} from 'bun:test'
import {analyzeSource, formatReport} from '../src/index.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

describe('arrays and declared values', () => {
  test('tuples stay exact per position; arrays are homogeneous', () => {
    // The type system's own split, mirrored: `as const` makes a tuple (sizes[1]! is
    // exactly 8, and the constant read is PROVEN in bounds — no assumption line), a plain
    // literal is an array (any element read covers 4..24).
    const report = analyzeSource('tuple-array.ts', `
      export function gaps(): number {
        const sizes = [4, 8, 24] as const
        return sizes[1]! * sizes.length
      }
      export function hulled(): number {
        const sizes = [4, 8, 24]
        return sizes[1]! * sizes.length
      }
    `)
    const gapsFn = analyzedFunction(report, 'gaps')
    expect(gapsFn.assumptions).toEqual([])
    expect(gapsFn.ensures).toEqual(['return is a finite integer number from 24 through 24'])
    expect(analyzedFunction(report, 'hulled').ensures)
      .toEqual(['return is a finite integer number from 12 through 72'])
  })

  test('optional and rest tuple positions leave the classified subset', () => {
    // The tuple arm of the declared-kind classification used to walk
    // checker.getTypeArguments only, and an optional slot and a rest slot each contribute
    // one type argument — so [number, number?] and [number, ...number[]] both modeled as
    // fixed pairs whose .length reads as exactly 2. The LEGAL cast-free caller
    // optionalLength([5]) then falsified the printed 'ensures: return is a finite integer
    // number from 2 through 2' while every printed assumes line held. Arity lives in the
    // tuple target's elementFlags; rather than model an arity range, tuples with any
    // optional, rest, or variadic position leave the subset (owner decision — no measured
    // corpus function uses the shapes, and widening later is cheap). Each position then
    // takes the existing fallback: a parameter rejects with the rewrite hint, a record
    // property is carried without claims, and an unclassifiable module binding's reads
    // stop — so no exact-length claim survives anywhere for these shapes.
    const report = analyzeSource('tuple-arity.ts', `
      export function optionalLength(pair: [number, number?]): number {
        return pair.length
      }
      export function restLength(values: [number, ...number[]]): number {
        return values.length
      }
      export function pairLength(pair: [number, number]): number {
        return pair.length
      }
      type Box = {gap: number; pair: [number, number?]; spans: [number, ...number[]]}
      export function boxGap(box: Box): number {
        return box.gap
      }
      export function asConstPair(): number {
        const pair = [3, 5] as const
        return pair.length * pair[1]!
      }
    `)
    const hint = 'a tuple position marked optional or rest makes the runtime length a range, which is outside the analyzed subset; model the value as number[], or as a fixed tuple like [number, number]'
    const optional = report.functions.find(fn => fn.name === 'optionalLength')
    if (optional?.kind !== 'unsupported') throw new Error('expected optionalLength to reject')
    expect(optional.unsupported).toBe(`function parameter with type [number, number?] (${hint}) at tuple-arity.ts:2:38`)
    const rest = report.functions.find(fn => fn.name === 'restLength')
    if (rest?.kind !== 'unsupported') throw new Error('expected restLength to reject')
    expect(rest.unsupported).toBe(`function parameter with type [number, ...number[]] (${hint}) at tuple-arity.ts:5:34`)
    // The all-required tuple keeps the exact positional model: its length really is 2 on
    // every legal value the analysis models (push-grown callers violate the printed
    // exact-count assumes line).
    expect(analyzedFunction(report, 'pairLength').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])
    // Optional/rest tuple properties stay outside the classified subset. The plain number
    // field uses the ordinary finite-input requirement.
    const gap = analyzedFunction(report, 'boxGap')
    expect(gap.assumptions).toEqual([])
    expect(gap.requires[0]).toContain('Number.isFinite(box.gap)')
    expect(gap.ensures).toEqual(['return is a finite number'])
    // An as-const local tuple is built in this function, so its arity is exact by
    // construction, not by boundary trust — the classification change must not touch it.
    expect(analyzedFunction(report, 'asConstPair').ensures)
      .toEqual(['return is a finite integer number from 10 through 10'])

    // A module binding of an optional-position tuple type fails classification the way
    // any unrepresentable declared type does: the binding stays opaque and reads stop.
    const moduleReport = analyzeSource('tuple-arity-module.ts', `
      const fallbackPair: [number, number?] = [5]
      export function fallbackCount(): number {
        return fallbackPair.length
      }
    `)
    const reader = moduleReport.functions.find(fn => fn.name === 'fallbackCount')
    if (reader?.kind !== 'partial') throw new Error('expected fallbackCount to be partially supported')
    expect(reader.partialReasons)
      .toEqual(['reads fallbackPair, whose value the analysis does not track (read at tuple-arity-module.ts:4:16)'])
  })

  test('for-of desugars to a counter loop: in bounds by construction, empty arrays prune', () => {
    const report = analyzeSource('for-of.ts', `
      export function total(values: number[]): number {
        let sum = 0
        for (const value of values) {
          sum = sum + Math.min(Math.max(value, 0), 10)
        }
        return sum
      }
      export function sumEmpty(): number {
        const values: number[] = []
        let sum = 0
        for (const value of values) {
          sum = sum + value
        }
        return sum
      }
    `)
    // No in-bounds assumption line: the counter read is proven by construction. The sum
    // stays finite because widening saturates at MAX_VALUE and adding a clamped step
    // cannot leave it.
    const fn = analyzedFunction(report, 'total')
    expect(fn.assumptions).toEqual([
      'values is a plain array — its length counts its elements, and every index below the length holds an element',
      'every values element is finite and not NaN',
    ])
    expect(fn.ensures).toEqual(['return is a finite number at least 0'])
    // The empty array's length is exactly 0, so the header comparison prunes the body.
    expect(analyzedFunction(report, 'sumEmpty').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
  })

  test('element reads: bare arr[i] carries undefined honestly, arr[i]! requires in bounds', () => {
    const report = analyzeSource('element-reads.ts', `
      export function bareRead(values: number[], index: number): number {
        const value = values[index]
        return value ?? 0
      }
      export function assertedRead(values: number[], index: number): number {
        return values[index]!
      }
    `)
    const file = 'element-reads.ts'
    // The bare read's ?? handles the miss, so no assumption is needed.
    const bare = analyzedFunction(report, 'bareRead')
    expect(bare.assumptions).toEqual([
      'values is a plain array — its length counts its elements, and every index below the length holds an element',
      'every values element is finite and not NaN',
    ])
    expect(bare.ensures).toEqual(['return is a finite number'])
    // The asserted read's index and array are both nameable over the parameters, so the
    // obligation surfaces as a requires line the caller can satisfy, not an assumes line
    // the entry merely rests on.
    const asserted = analyzedFunction(report, 'assertedRead')
    expect(asserted.assumptions).toEqual([
      'values is a plain array — its length counts its elements, and every index below the length holds an element',
      'every values element is finite and not NaN',
    ])
    expect(requirementsBesidesInputFiniteness(asserted))
      .toEqual([`index is a valid values index (element read at ${file}:7:16)`])
  })

  test('top-level destructuring publishes each name as its own binding', () => {
    const report = analyzeSource('toplevel-destructure.ts', `
      const gridSize = {cols: 8, rows: 6}
      const {cols} = gridSize
      export function scaled(x: number): number {
        return Math.min(x, cols)
      }
    `)
    expect(analyzedFunction(report, 'scaled').ensures)
      .toEqual(['return is a finite number at most 8'])
  })

  test('return contracts stop at the declared record shape', () => {
    const report = analyzeSource('wide-return.ts', `
      function wideBox(): {width: number; height: number} { return {width: 3, height: 4} }
      export function measure(): {width: number} { return wideBox() }
    `)
    expect(analyzedFunction(report, 'measure').ensures)
      .toEqual(['return.width is a finite integer number from 3 through 3'])
  })

  test('void and mixed-element checks reject while undefined and bounds guards narrow', () => {
    const report = analyzeSource('review-fixes.ts', `
      function announce(): void { return }
      export function checkVoidLoose(): number {
        if (announce() == null) { return 1 }
        return 0
      }
      export function narrowUndefined(x: number | undefined): number {
        if (x !== undefined) { return x }
        return -1
      }
      export function mixedLiteral(): number {
        const pair = [1, true]
        return pair.length
      }
      export function firstOrZero(values: number[]): number {
        if (values.length > 0) { return values[0]! }
        return 0
      }
      export function outOfBounds(): number {
        const sizes = [4, 8, 24]
        return sizes[5]! * 3
      }
    `)
    const file = 'review-fixes.ts'
    // A void call's runtime value is undefined, which the void abstract kind cannot carry;
    // admitting the check would prune the wrong branch.
    const voidCheck = report.functions.find(fn => fn.name === 'checkVoidLoose')
    expect(voidCheck?.kind).toBe('unsupported')
    expect(analyzedFunction(report, 'narrowUndefined').ensures).toEqual(['return is a finite number'])
    // (number | boolean)[] has an element hull no read gate could describe.
    const mixed = report.functions.find(fn => fn.name === 'mixedLiteral')
    expect(mixed?.kind).toBe('unsupported')
    // The length guard narrows through the arrayLength producer into the array value, so
    // the asserted read is proven — no assumption line.
    expect(analyzedFunction(report, 'firstOrZero').assumptions).toEqual([
      'values is a plain array — its length counts its elements, and every index below the length holds an element',
      'every values element is finite and not NaN',
    ])
    const oob = report.functions.find(fn => fn.name === 'outOfBounds')
    expect(oob?.kind).toBe('partial')
    expect(formatReport(report)).toContain(`reads an element provably outside the array (at ${file}:21:16)`)
  })

  test('nullish parameters and explicit-field copies stay nameable in requirements', () => {
    const report = analyzeSource('nameable.ts', `
      export function rate(total: number, interval: number | null): number {
        if (interval !== null) { return total / interval }
        return 0
      }
      export function throughCopyFields(grid: {columns: number}, width: number): number {
        const copy = {columns: grid.columns}
        return width / copy.columns
      }
    `)
    const file = 'nameable.ts'
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'rate')))
      .toEqual([`interval is nonzero (division at ${file}:3:41)`])
    // copy.columns resolves through the local literal to the grid.columns read stored at
    // construction, so the requirement names grid.columns, which the caller can satisfy.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'throughCopyFields')))
      .toEqual([`grid.columns is nonzero (division at ${file}:8:16)`])
  })

  test('untagged array unions reject while explicit copies and sentinel chains remain sound', () => {
    const report = analyzeSource('round2-fixes.ts', `
      export function itemCount(mode: number): number {
        const box: {items: (number | boolean)[]} = mode > 0 ? {items: [1, 2, 3]} : {items: [true]}
        return box.items.length
      }
      export function lostNarrowing(grid: {columns: number}): number {
        const width = grid.columns
        if (grid.columns >= 1) {
          if (width <= 10) {
            return 100 / grid.columns
          }
        }
        return 0
      }
      export function throughCopyFields(grid: {columns: number}): number {
        const copy = {columns: grid.columns}
        if (copy.columns >= 1) {
          return 100 / grid.columns
        }
        return 0
      }
      export function distinguish(setting: number | null | undefined): number {
        if (setting == null) {
          if (setting === undefined) return 1
          return 2
        }
        return 3
      }
      export function readSize(size: number | undefined): number {
        if (typeof size !== 'undefined') { return size }
        return 0
      }
    `)
    // An untagged structural union rejects instead of relying on coincidental member
    // shapes: {items: number[]} | {items: boolean[]} cannot be joined here.
    expect(report.functions.find(fn => fn.name === 'itemCount')?.kind).toBe('unsupported')
    // A refinement of a stale saved read meets the record's current property value instead
    // of clobbering the fresher guard.
    const lost = analyzedFunction(report, 'lostNarrowing')
    expect(requirementsBesidesInputFiniteness(lost)).toEqual([])
    expect(lost.ensures).toEqual(['return is a finite number from 0 through 100'])
    // The explicit-fields twin is the supported spelling: the grid.columns read genuinely
    // happens and stores a real value, narrowing copy.columns narrows grid.columns (the
    // copy's property IS the stored read), and the guard discharges the division.
    const copied = analyzedFunction(report, 'throughCopyFields')
    expect(requirementsBesidesInputFiniteness(copied)).toEqual([])
    expect(copied.ensures).toEqual(['return is a finite number from 0 through 100'])
    // A pure-sentinel operand (null | undefined after the outer narrow) still checks, and
    // typeof x !== 'undefined' is the classic spelling of the undefined sentinel check.
    expect(analyzedFunction(report, 'distinguish').ensures)
      .toEqual(['return is a finite integer number from 1 through 3'])
    expect(analyzedFunction(report, 'readSize').ensures).toEqual(['return is a finite number'])
  })

  test('recursive unions reject while narrowing and literal unions remain sound', () => {
    const report = analyzeSource('round3-fixes.ts', `
      type Group = (Group | null)[]
      export function groupCount(group: Group): number {
        return group.length
      }
      export function nullableGroupCount(group: Group | null): number {
        return group === null ? 0 : group.length
      }
      export function makeBox(): number {
        const box = {count: 5, data: [1, true]}
        return box.count
      }
      export function freshThenStale(values: number[]): number {
        const count = values.length
        if (values.length >= 1) {
          if (count <= 100) {
            return values[0]!
          }
        }
        return -1
      }
      export function sizeAtConst(index: number): number {
        const sizes = [4, 8, 24] as const
        const size = sizes[index]
        if (size !== undefined) return size
        return 0
      }
      export function typeofNumber(x: number | undefined): number {
        if (typeof x === 'number') return x
        return 0
      }
    `)
    // A recursive type reaching itself through a union rejects (the depth guard survives
    // union arms); a mixed-element literal rejects in EVERY position, property values
    // included; a stale saved length meets instead of clobbering the fresher narrowing;
    // an as-const table's bare dynamic read is nullable like number | undefined; and
    // typeof x === 'number' is the not-missing check.
    expect(report.functions.find(fn => fn.name === 'groupCount')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'nullableGroupCount')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'makeBox')?.kind).toBe('unsupported')
    expect(analyzedFunction(report, 'freshThenStale').assumptions).toEqual([
      'values is a plain array — its length counts its elements, and every index below the length holds an element',
      'every values element is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'sizeAtConst').ensures)
      .toEqual(['return is a finite integer number from 0 through 24'])
    expect(analyzedFunction(report, 'typeofNumber').ensures).toEqual(['return is a finite number'])
  })

  test('rest parameters reject while bare returns and typeof remain honest', () => {
    const report = analyzeSource('round4-fixes.ts', `
      function total(...values: number[]): number {
        return values.length
      }
      export const combined = total(1, 2)
      export function pick(count: number): number | undefined {
        if (count > 0) {
          return 1
        }
        return
      }
      export function readBox(count: number): number {
        const box = count > 0 ? {value: 5} : null
        if (typeof box === 'number') { return 0 }
        if (box === null) { return 1 }
        return box.value
      }
    `)
    // A rest parameter is one declaration for any number of arguments — rejected, so the
    // two-argument call cannot crash the arity check.
    expect(report.functions.find(fn => fn.name === 'total')?.kind).toBe('unsupported')
    // Bare return IS return undefined in a value-returning function.
    expect(analyzedFunction(report, 'pick').ensures)
      .toEqual(['return is undefined or a finite integer number from 1 through 1'])
    // typeof box === 'number' on {value: number} | null is NOT the not-missing check
    // (typeof a present record is 'object'); it answers an unknown boolean, so both
    // branches analyze — the dead branch's 0 rides along soundly in the range.
    expect(analyzedFunction(report, 'readBox').ensures)
      .toEqual(['return is a finite integer number from 0 through 5'])
  })

  test('strings and booleans are carried, not rejected; parameters take any declared kind', () => {
    // The old behavior was wild: one id: string property rejected the whole function.
    // Opaque values carry non-numeric content without claims, and parameters share the
    // module bindings' recursive declared-kind classification.
    const report = analyzeSource('opaque-values.ts', `
      type Box = {id: string; width: number; visible: boolean}
      export function scaledWidth(box: Box, factor: number): number {
        return Math.min(box.width * factor, 1000)
      }
      export function labelled(width: number): number {
        const label = \`\${width}px\`
        return width * 2
      }
      export function pick(mode: string, compact: number, wide: number): number {
        if (mode === 'compact') { return compact }
        return wide
      }
      export function flagged(enabled: boolean, value: number): number {
        if (enabled) { return value }
        return 0
      }
      export function concatenated(width: number): number {
        let message = 'w: '
        message += width + 'px'
        return width
      }
    `)
    const scaled = analyzedFunction(report, 'scaledWidth')
    // String properties make no numeric claim. Plain numbers are caller requirements;
    // `flagged` below still prints the boolean assumption it uses.
    expect(scaled.assumptions).toEqual([])
    // A template literal is carried; the numeric contract survives.
    expect(analyzedFunction(report, 'labelled').assumptions).toEqual([])
    // String dispatch: the comparison is an unknown boolean, both branches analyzed.
    expect(analyzedFunction(report, 'pick').ensures).toEqual(['return is a finite number'])
    // Boolean parameters are new too (the flat-numbers gate rejected them).
    expect(analyzedFunction(report, 'flagged').assumptions)
      .toEqual(['enabled is a boolean'])
    expect(analyzedFunction(report, 'concatenated').ensures).toEqual(['return is a finite number'])
  })

  test('nullish-wrapped module arrays hedge when the file is not fully analyzed', () => {
    // The fully-analyzed demotion recurses through nullish wrappers: `number[] | null` is
    // nullish at the top level yet the array inside is exactly as alias-mutable, e.g. by
    // `queue?.push(x)` in a rejected function (receiver position, invisible to the write
    // scan). Publishing the exact initializer value would be falsified at runtime.
    const report = analyzeSource('nullable-module-array.ts', `
      let queue: number[] | null = [3, 5]
      export function enqueue(x: number): void {
        queue?.push(x)
      }
      export function hasQueue(): boolean {
        return queue !== null
      }
    `)
    const reader = analyzedFunction(report, 'hasQueue')
    // No exact claims about the initializer value survive; the read rests on the
    // declared-kind hedge, printed with its inner leaf conditions.
    expect(reader.assumptions).toEqual([
      'queue is null or queue is a plain array — its length counts its elements, and every index below the length holds an element',
      'queue is null or every queue element is finite and not NaN',
    ])
  })

  test('nullable structural parameters print their inner leaf assumptions', () => {
    // The seeded finiteness of every inner leaf must reach the report — the ensures lines
    // rest on it. Before the fix, `values: number[] | null` printed only 'null or a record
    // of its declared shape', so firstOr([Infinity], 0) satisfied every printed line while
    // the ensures was false. Nested arrays also stuttered ('every every grid element
    // element'); the [each] path keeps them readable.
    const report = analyzeSource('nullable-structural-parameters.ts', `
      export function firstOr(values: number[] | null, fallback: number): number {
        if (values === null) return fallback
        return values[0] ?? fallback
      }
      export function gridSum(grid: number[][], config: {width: number; label: string} | null): number {
        if (config === null) return grid.length
        return config.width
      }
    `)
    expect(analyzedFunction(report, 'firstOr').assumptions).toEqual([
      'values is null or values is a plain array — its length counts its elements, and every index below the length holds an element',
      'values is null or every values element is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'gridSum').assumptions).toEqual([
      'grid is a plain array — its length counts its elements, and every index below the length holds an element',
      'every grid element is a plain array — its length counts its elements, and every index below the length holds an element',
      'every grid[each] element is finite and not NaN',
      'config is null or config.width is finite and not NaN',
    ])
  })

  test('parameter defaults must be literals inside the declared kind', () => {
    // Literal defaults can be represented exactly. A computed Infinity or a cast that
    // lies about a boolean's runtime kind would falsify the declared numeric assumptions.
    const report = analyzeSource('bad-default.ts', `
      const undefined: undefined = 7 as any
      export function scaled(zoom: number = Number.POSITIVE_INFINITY): number {
        return zoom
      }
      export function disguisedBoolean(zoom: number = true as unknown as number): number {
        return zoom
      }
      export function shadowedUndefined(zoom: number | undefined = undefined): number {
        return zoom ?? 0
      }
      export function defaultedOptional(zoom: number | undefined = 5): number {
        return zoom
      }
      export function remaining(deadline: number | null = null): number {
        return deadline === null ? 0 : deadline
      }
      export function zoomOr(zoom: number | null = 5): number {
        return zoom === null ? 1 : zoom
      }
    `)
    const scaled = report.functions.find(fn => fn.name === 'scaled')!
    if (scaled.kind !== 'unsupported') throw new Error(`expected scaled to be unsupported, got ${scaled.kind}`)
    expect(scaled.unsupported).toContain('default value for parameter zoom')
    const disguisedBoolean = report.functions.find(fn => fn.name === 'disguisedBoolean')!
    if (disguisedBoolean.kind !== 'unsupported') {
      throw new Error(`expected disguisedBoolean to be unsupported, got ${disguisedBoolean.kind}`)
    }
    expect(disguisedBoolean.unsupported).toContain('default value for parameter zoom')
    const shadowedUndefined = report.functions.find(fn => fn.name === 'shadowedUndefined')!
    if (shadowedUndefined.kind !== 'unsupported') {
      throw new Error(`expected shadowedUndefined to be unsupported, got ${shadowedUndefined.kind}`)
    }
    expect(shadowedUndefined.unsupported).toContain('default value for parameter zoom')
    expect(analyzedFunction(report, 'defaultedOptional').assumptions)
      .toEqual([])
    expect(analyzedFunction(report, 'defaultedOptional').requires[0])
      .toContain('Number.isFinite(zoom)')
    expect(analyzedFunction(report, 'defaultedOptional').ensures)
      .toEqual(['return is a finite number'])
    const globalUndefinedReport = analyzeSource('undefined-default.ts', `
      export function defaultedUndefined(zoom: number | undefined = undefined): number | undefined {
        return zoom
      }
    `)
    expect(analyzedFunction(globalUndefinedReport, 'defaultedUndefined').assumptions)
      .toEqual(['zoom is undefined or a finite non-NaN number'])
    expect(analyzedFunction(globalUndefinedReport, 'defaultedUndefined').ensures)
      .toEqual(['return is undefined or a finite number'])
    expect(analyzedFunction(report, 'remaining').assumptions).toEqual(['deadline is null or a finite non-NaN number'])
    expect(analyzedFunction(report, 'zoomOr').ensures).toEqual(['return is a finite number'])
  })

  test('numeric literal unions retain their range through declared shapes', () => {
    // `mode: 'compact' | 'wide' | undefined` has several non-missing union members; they
    // classify as one scalar kind. Numeric members retain the interval written in the
    // type, including through nullable wrappers and array elements.
    const report = analyzeSource('optional-literal-unions.ts', `
      export function pick(mode: 'compact' | 'wide' | undefined, a: number, b: number): number {
        if (mode === 'compact') return a
        return b
      }
      export function gapFor(size: 4 | 8 | undefined): number {
        return size === undefined ? 4 : size
      }
      export function toolbarHeight(rows: 1 | 2): number {
        return rows * 40
      }
      export function fractionalScale(scale: 0.5 | 1.5): number {
        return scale
      }
      export function first(values: Array<1 | 2>): number {
        return values[0]!
      }
      export function mixedRecord(config: {rows: 1 | 2; width: number; height: number; gap: number}): number {
        return config.rows + config.width + config.height + config.gap
      }
      export function pickWidth(mode: string | undefined, compact: number, wide: number): number {
        if (mode === 'compact') return compact
        return wide
      }
      export function invalidDefault(rows: 1 | 2 = 3 as any): number {
        return rows
      }
      export function overflowedLiteral(value: 1e309): number {
        return value
      }
      enum ToolbarRows { Compact = 1, Expanded = 2 }
      export function enumRows(rows: ToolbarRows): number {
        return rows
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'gapFor').assumptions)
      .toEqual(['size is undefined or a finite integer number from 4 through 8'])
    expect(analyzedFunction(report, 'gapFor').ensures)
      .toEqual(['return is a finite integer number from 4 through 8'])
    expect(analyzedFunction(report, 'toolbarHeight').assumptions)
      .toEqual(['rows is a finite integer number from 1 through 2'])
    expect(analyzedFunction(report, 'toolbarHeight').ensures)
      .toEqual(['return is a finite integer number from 40 through 80'])
    expect(analyzedFunction(report, 'fractionalScale').assumptions)
      .toEqual(['scale is a finite number from 0.5 through 1.5'])
    expect(analyzedFunction(report, 'first').assumptions[1])
      .toEqual('every values element is a finite integer number from 1 through 2')
    expect(analyzedFunction(report, 'first').ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
    const mixedRecord = analyzedFunction(report, 'mixedRecord')
    expect(mixedRecord.assumptions)
      .toContain('config.rows is a finite integer number from 1 through 2')
    expect(mixedRecord.assumptions.some(line => line.startsWith('every property'))).toBe(false)
    expect(analyzedFunction(report, 'pickWidth').ensures).toEqual(['return is a finite number'])
    for (const name of ['invalidDefault', 'overflowedLiteral']) {
      expect(report.functions.find(fn => fn.name === name)?.kind).toBe('unsupported')
    }
    expect(analyzedFunction(report, 'enumRows').ensures).toEqual(['return is a finite number'])
  })

  test('every external array prints the plain-array trust it is analyzed under', () => {
    // The engine trusts two things about an external array that its element lines never
    // said: each length read is a genuine element count (seeded as an integer from 0
    // through 2^32 - 1), and an in-range read finds a present value of the declared
    // element type (the valid-index discharge drops the undefined arm). A review round
    // falsified three printed contracts through that silent trust with type-conforming
    // callers — a Proxy<string[][]> whose length trap answers 10 over 3 rows makes
    // groupOrMiss return 999 while the sole printed assumes line (index finite) holds; a
    // Proxy<number[][]> steers an in-range row read to undefined without violating
    // 'every grid[each] element is finite and not NaN' (an absent row contributes no
    // elements); and a length trap answering 1e18, 2.5, or NaN falsifies
    // 'return is a finite integer number from 0 through 4294967295' for a bare
    // values.length return. Legal plain-data callers can break the presence clause too:
    // [1, , 3] and new Array(5) are type-clean number[] values with truthful lengths and
    // missing elements. The plain-array line is the printed condition each of those
    // callers now violates: a lying length fails 'its length counts its elements', and a
    // hole or steered undefined fails 'every index below the length holds an element' on
    // the level above it. One line prints per nesting level, so string[][] — whose opaque
    // leaves used to print NOTHING for the whole subtree — covers both the outer array
    // and each row.
    const report = analyzeSource('plain-array-trust.ts', `
      export function groupOrMiss(groups: string[][], index: number): number {
        if (Number.isInteger(index) && index >= 0 && index < groups.length) {
          const group = groups[index]
          if (group === undefined) return 999
          return 1
        }
        return 0
      }
      export function count(values: number[]): number {
        return values.length
      }
    `)
    const grouped = analyzedFunction(report, 'groupOrMiss')
    // The proven-dead undefined arm keeps 999 out of the range; that fold now rests on
    // the printed presence claim, like every other assumes-backed fold.
    expect(grouped.ensures).toEqual(['return is a finite integer number from 0 through 1'])
    expect(grouped.assumptions).toEqual([
      'groups is a plain array — its length counts its elements, and every index below the length holds an element',
      'every groups element is a plain array — its length counts its elements, and every index below the length holds an element',
    ])
    const counted = analyzedFunction(report, 'count')
    expect(counted.ensures).toEqual(['return is a finite integer number from 0 through 4294967295'])
    expect(counted.assumptions).toEqual([
      'values is a plain array — its length counts its elements, and every index below the length holds an element',
      'every values element is finite and not NaN',
    ])
  })

  test('tuple parameters print the exact-count plain-array trust their reads rest on', () => {
    // A [number, number] parameter's length is seeded as exactly 2 and both slots as
    // present — stronger trust than the plain-array default, and previously unprinted. A
    // review round falsified printed contracts through the silent trust, every printed
    // line holding: a Proxy over a genuine [1, 2] whose length trap answers 7 makes
    // pairLength return 7 against 'return is a finite integer number from 2 through 2',
    // and steers lastOfPair's pair[pair.length - 1]! read to the absent pair[6] against
    // 'return is a finite number'; ordinary push-grown code — `const grown: [number,
    // number] = [1, 2]; grown.push(3)` type-checks under strict tsc — makes pairLength
    // return 3. The exact-count line is the printed condition each caller violates on
    // its surface reading: a lying length fails 'its length counts its elements', a
    // grown tuple fails 'exactly 2 elements', and the steered undefined fails 'every
    // index below the length holds an element'.
    const report = analyzeSource('tuple-trust.ts', `
      export function pairLength(pair: [number, number]): number {
        return pair.length
      }
      export function lastOfPair(pair: [number, number]): number {
        return pair[pair.length - 1]!
      }
    `)
    const tupleLine = 'pair is a plain array of exactly 2 elements — its length counts its elements, and every index below the length holds an element'
    const slotLines = ['pair[0] is finite and not NaN', 'pair[1] is finite and not NaN']
    const length = analyzedFunction(report, 'pairLength')
    expect(length.ensures).toEqual(['return is a finite integer number from 2 through 2'])
    expect(length.assumptions).toEqual([tupleLine, ...slotLines])
    expect(analyzedFunction(report, 'lastOfPair').assumptions).toEqual([tupleLine, ...slotLines])
  })

  test('three or more direct non-nullable array properties of a record fold into one plain-array line', () => {
    // A layout record with several array properties would repeat the plain-array line
    // once per array, the same bloat the number fold exists for. Fold membership is
    // exactly what the folded sentence states on its surface reading: the DIRECT
    // NON-NULLABLE properties of a non-nullable record root declared as arrays.
    // Nullable array members used to fold too, covered by a parenthetical '(a nullable
    // array property may hold null or undefined instead)' — but the parenthetical
    // blessed BOTH sentinels for every such member, while the engine seeds each member
    // with only its DECLARED sentinel and prunes a branch testing the other. A review
    // round ran the smuggle in both directions, strict-tsc-clean each time: undefined
    // pushed through `any` into `overrides: number[] | null`, and null into `extras?:
    // number[]` — which any JSON-derived value does, since serializers write null for
    // absent fields — satisfied every printed line while the engine proved the
    // wrong-sentinel branch dead and published a false ensures. The member's own
    // disjunct line is sentinel-precise and condemns exactly that smuggle, so nullable
    // members always print it, the fold never counts them, and the folded sentence needs
    // no parenthetical — nothing it quantifies over may be nullish. Everything else the
    // sentence does not restate keeps its own line even when the fold triggers — nested
    // element levels, arrays behind a nullable record, nullable roots — pinned by the
    // tests below.
    const report = analyzeSource('plain-array-fold.ts', `
      type Prepared = {
        widths: number[]
        gaps: number[]
        labels: string[]
        overrides: number[] | null
        extras?: number[]
      }
      export function firstWidth(prepared: Prepared): number {
        const bands = prepared.gaps.length + prepared.labels.length
        const extra = prepared.overrides === null ? 0 : prepared.overrides.length
        const spare = prepared.extras === undefined ? 0 : prepared.extras.length
        return (prepared.widths[0] ?? 0) + bands + extra + spare
      }
    `)
    expect(analyzedFunction(report, 'firstWidth').assumptions).toEqual([
      'every property declared as an array in prepared holds a plain array — its length counts its elements, and every index below the length holds an element',
      'every prepared.widths element is finite and not NaN',
      'every prepared.gaps element is finite and not NaN',
      // Each nullable member names its own declared sentinel and only that one: a legal
      // null in overrides satisfies its lines, while an undefined there — which the
      // dropped parenthetical used to permit — violates them, keeping the ensures
      // vacuous for the smuggle instead of false. The optional member reads the same
      // way with the sentinels swapped.
      'prepared.overrides is null or prepared.overrides is a plain array — its length counts its elements, and every index below the length holds an element',
      'prepared.overrides is null or every prepared.overrides element is finite and not NaN',
      'prepared.extras is undefined or prepared.extras is a plain array — its length counts its elements, and every index below the length holds an element',
      'prepared.extras is undefined or every prepared.extras element is finite and not NaN',
    ])
  })

  test('two direct array properties stay per-property, and nullable members never raise the count', () => {
    // The fold's counting boundary, pinned from below on both axes. A review round ran
    // two mutants that survived the whole suite: lowering the threshold to two members,
    // and letting nullable members raise the count to the threshold. Both changed real
    // reports (a two-array record gained the folded line; a two-plus-nullable record
    // folded and suppressed the direct arrays' own lines) with no test failing. The
    // nullable-count mutant matters beyond presentation: the folded sentence's
    // unconditional 'holds' would then cover a `number[] | null` property, and a legal
    // caller passing null violates a printed line — the quantifier-domain failure the
    // fold history exists to prevent.
    const report = analyzeSource('fold-boundary.ts', `
      type Duo = {widths: number[]; heights: number[]}
      export function duoTotal(layout: Duo): number {
        return layout.widths.length + layout.heights.length
      }
      type DuoPlusNullable = {widths: number[]; heights: number[]; overrides: number[] | null}
      export function duoPlusTotal(layout: DuoPlusNullable): number {
        const extra = layout.overrides === null ? 0 : layout.overrides.length
        return layout.widths.length + layout.heights.length + extra
      }
    `)
    expect(formatReport(report)).not.toContain('every property declared as an array in')
    const perProperty = [
      'layout.widths is a plain array — its length counts its elements, and every index below the length holds an element',
      'every layout.widths element is finite and not NaN',
      'layout.heights is a plain array — its length counts its elements, and every index below the length holds an element',
      'every layout.heights element is finite and not NaN',
    ]
    expect(analyzedFunction(report, 'duoTotal').assumptions).toEqual(perProperty)
    expect(analyzedFunction(report, 'duoPlusTotal').assumptions).toEqual([
      ...perProperty,
      'layout.overrides is null or layout.overrides is a plain array — its length counts its elements, and every index below the length holds an element',
      'layout.overrides is null or every layout.overrides element is finite and not NaN',
    ])
  })

  test('a mixed root prints the number fold and the array fold with disjoint membership', () => {
    // Three or more number leaves and three or more direct array properties on one
    // record: both folded sentences print, and each covers only what it names — the
    // number line quantifies the number-declared positions (array element leaves
    // included, as index properties), the array line the array-declared properties. No
    // per-leaf or per-array residue line remains, and nothing is double-stated.
    const report = analyzeSource('mixed-fold.ts', `
      type Panel = {
        width: number
        height: number
        gap: number
        widths: number[]
        gaps: number[]
        margins: number[]
      }
      export function panelWidth(panel: Panel): number {
        return panel.width + panel.height + panel.gap
          + (panel.widths[0] ?? 0) + (panel.gaps[0] ?? 0) + (panel.margins[0] ?? 0)
      }
    `)
    expect(analyzedFunction(report, 'panelWidth').assumptions).toEqual([
      'every property declared as an array in panel holds a plain array — its length counts its elements, and every index below the length holds an element',
      'every panel.widths element is finite and not NaN',
      'every panel.gaps element is finite and not NaN',
      'every panel.margins element is finite and not NaN',
    ])
  })

  test('a nullable root never folds: its own plain-array disjuncts print', () => {
    // `grid: number[][][] | null` has kind nullish, and a fold guard keyed on the root's
    // kind alone would let the nullable root fold — yet the folded sentence ('every
    // property declared as an array IN grid') quantifies over the root's properties,
    // saying nothing about grid itself, and the fold would suppress the root's own
    // disjunct lines. A review round ran the falsification: a Proxy whose length trap
    // answers 0.5 made a strict-tsc-clean caller get 0.5 back against 'return is a
    // finite integer number from 0 through 4294967295' with every printed line holding.
    // The root's disjunct lines must print whether or not a fold triggers elsewhere in
    // the entry (frame folds here). A nullable RECORD root with three array properties
    // stays out of the fold the same way: its per-property lines all carry the null
    // disjunct, so a legal null caller violates nothing.
    const report = analyzeSource('nullable-array-root.ts', `
      type Frame = {rows: number[]; columns: string[]; labels: string[]}
      export function rowCount(grid: number[][][] | null, frame: Frame): number {
        if (grid === null) return frame.rows.length + frame.columns.length + frame.labels.length
        return grid.length
      }
      type Bands = {widths: number[]; gaps: number[]; margins: number[]}
      export function bandCount(bands: Bands | null): number {
        if (bands === null) return 0
        return bands.widths.length
      }
    `)
    expect(analyzedFunction(report, 'rowCount').assumptions).toEqual([
      'grid is null or grid is a plain array — its length counts its elements, and every index below the length holds an element',
      'grid is null or every grid element is a plain array — its length counts its elements, and every index below the length holds an element',
      'grid is null or every grid[each] element is a plain array — its length counts its elements, and every index below the length holds an element',
      'grid is null or every grid[each][each] element is finite and not NaN',
      'every property declared as an array in frame holds a plain array — its length counts its elements, and every index below the length holds an element',
      'every frame.rows element is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'bandCount').assumptions).toEqual([
      'bands is null or bands.widths is a plain array — its length counts its elements, and every index below the length holds an element',
      'bands is null or every bands.widths element is finite and not NaN',
      'bands is null or bands.gaps is a plain array — its length counts its elements, and every index below the length holds an element',
      'bands is null or every bands.gaps element is finite and not NaN',
      'bands is null or bands.margins is a plain array — its length counts its elements, and every index below the length holds an element',
      'bands is null or every bands.margins element is finite and not NaN',
    ])
  })

  test('nested per-level lines survive an active fold', () => {
    // The folded sentence quantifies over chart's own properties, so it says nothing
    // about the rows INSIDE chart.series. A fold that suppressed the nested line would
    // let a caller through whose outer array is a genuine plain array holding one Proxy
    // row with a lying length (2.5): every printed line holds on its surface reading
    // while the row-length read returns 2.5 against 'return is a finite integer number
    // from 0 through 4294967295'. The nested line is the printed condition that caller
    // violates — the row's length does not count its elements — so it prints fold or no
    // fold.
    const report = analyzeSource('nested-under-fold.ts', `
      type Chart = {labels: string[]; legends: string[]; series: number[][]}
      export function seriesCount(chart: Chart): number {
        return chart.labels.length + chart.legends.length + chart.series.length
      }
    `)
    expect(analyzedFunction(report, 'seriesCount').assumptions).toEqual([
      'every property declared as an array in chart holds a plain array — its length counts its elements, and every index below the length holds an element',
      'every chart.series element is a plain array — its length counts its elements, and every index below the length holds an element',
      'every chart.series[each] element is finite and not NaN',
    ])
  })

  test('an array behind a nullable record keeps its null disjunct under an active fold', () => {
    // layout.config.grid is not a property IN layout, and its unfolded spelling is a
    // disjunction: 'layout.config is null or layout.config.grid is a plain array — ...'.
    // A fold that counted it as a member and suppressed the disjunct line would leave
    // the folded sentence's unconditional 'holds a plain array' as the only claim about
    // the position — under the pinned reading ('holds' demands a value), a LEGAL caller
    // passing config: null violates the printed line, vacating the whole report for
    // legitimate callers. Arrays behind a nullable record never join the fold; the
    // disjunct line survives, and a legal null violates no printed line.
    const report = analyzeSource('nullable-ancestor-fold.ts', `
      type Layout = {widths: number[]; gaps: number[]; labels: string[]; config: {grid: number[]} | null}
      export function totalBands(layout: Layout): number {
        const gridCount = layout.config === null ? 0 : layout.config.grid.length
        return layout.widths.length + layout.gaps.length + layout.labels.length + gridCount
      }
    `)
    expect(analyzedFunction(report, 'totalBands').assumptions).toEqual([
      'every property declared as an array in layout holds a plain array — its length counts its elements, and every index below the length holds an element',
      'every layout.widths element is finite and not NaN',
      'every layout.gaps element is finite and not NaN',
      'layout.config is null or layout.config.grid is a plain array — its length counts its elements, and every index below the length holds an element',
      'layout.config is null or every layout.config.grid element is finite and not NaN',
    ])
  })

  test('arrays of nullish records keep the [each] assumption wording', () => {
    // The `every X element is` sugar only reads right when the element path appears once;
    // a nullish element's disjunction mentions it twice, so the line stays in [each] form.
    const report = analyzeSource('array-of-nullable.ts', `
      export function slotSum(slots: ({x: number} | null)[]): number {
        const first = slots[0]
        if (first == null) return 0
        return first.x
      }
    `)
    expect(analyzedFunction(report, 'slotSum').assumptions).toEqual([
      'slots is a plain array — its length counts its elements, and every index below the length holds an element',
      'slots[each] is null or slots[each].x is finite and not NaN',
    ])
  })

  test('the number default folds per value at three plain leaves; nullish and tagged-union leaves stay exact', () => {
    // A record with many number leaves would repeat "is finite and not NaN" once per leaf
    // on every function that takes one. Three or more plain number leaves fold into one
    // line quantified over the DECLARED properties ("holds" demands a value, so a
    // non-number smuggled through any AND an absent property both violate the line — four
    // review rounds shaped this wording). Nullish leaves keep their null disjunct and
    // tagged-union leaves keep their variant qualifiers: one unqualified line cannot
    // carry either. Two plain leaves stay per-leaf; module bindings fold like parameters.
    const report = analyzeSource('assumes-fold.ts', `
      type Meter = {kind: 'linear'; slope: number} | {kind: 'log'; base: number}
      type Panel = {width: number; height: number; gap: number; visible: boolean; ratio: number | null; meter: Meter}
      export function panelArea(panel: Panel): number {
        if (!panel.visible) return 0
        const boost = panel.ratio === null ? 0 : panel.ratio
        const scale = panel.meter.kind === 'linear' ? panel.meter.slope : panel.meter.base
        return panel.width * panel.height + panel.gap + boost + scale
      }
      export function span(range: {low: number; high: number}): number {
        return range.high - range.low
      }
      export function pathTotal(points: {x: number; y: number; z: number}[]): number {
        let total = 0
        for (const point of points) { total = total + point.x + point.y + point.z }
        return total
      }
      let camera = {x: 0, y: 0, zoom: 1}
      export function zoomedX(offset: number): number {
        return (camera.x + offset) * camera.zoom
      }
      export function resetCamera(): number {
        camera = {x: 0, y: 0, zoom: 1}
        return camera.zoom
      }
    `)
    expect(analyzedFunction(report, 'panelArea').assumptions).toEqual([
      'panel.visible is a boolean',
      'panel.ratio is null or a finite non-NaN number',
      "panel.meter.slope is finite and not NaN (when panel.meter.kind is 'linear')",
      "panel.meter.base is finite and not NaN (when panel.meter.kind is 'log')",
    ])
    expect(analyzedFunction(report, 'span').assumptions).toEqual([])
    // Both folds coexist on one value: the number fold covers the element leaves (array
    // elements are index properties), and the array-root value still prints its own
    // plain-array line — the root is not a record property, so the array fold's sentence
    // never covers it.
    expect(analyzedFunction(report, 'pathTotal').assumptions).toEqual([
      'every property declared as a number in points holds a finite non-NaN number',
      'points is a plain array — its length counts its elements, and every index below the length holds an element',
    ])
    expect(analyzedFunction(report, 'zoomedX').assumptions).toEqual([
      'every property declared as a number in camera holds a finite non-NaN number',
    ])
  })

  test('assumes lines cover only the paths the body reads; untouched paths print nothing', () => {
    // A declared path no instruction ever touches derived no value, so no printed
    // requires or ensures can rest on its trust — dropping its line removes no
    // load-bearing condition, and stops penalizing legal callers: before the filter, a
    // caller passing a sparse array in an UNREAD position violated a printed line and
    // needlessly voided the whole contract. The filter is report-layer only; verdicts
    // and the engine's seeding are untouched.
    const report = analyzeSource('read-filter.ts', `
      type Box = {xs: number[]; ys: number[]}
      export function noArrays(box: Box, flag: boolean): boolean {
        return flag
      }
      export function onlyXs(box: Box): number {
        return box.xs.length
      }
    `)
    // box is never touched, so neither array prints a line; flag is returned, and the
    // boolean ensures rests on its trust, so its line stays.
    const untouched = analyzedFunction(report, 'noArrays')
    expect(untouched.assumptions).toEqual(['flag is a boolean'])
    expect(untouched.ensures).toEqual(['return is boolean'])
    // A read at or below box.xs keeps ALL of box.xs's lines (path-level granularity: the
    // length read keeps the element line too); the unread sibling box.ys keeps none.
    expect(analyzedFunction(report, 'onlyXs').assumptions).toEqual([
      'box.xs is a plain array — its length counts its elements, and every index below the length holds an element',
      'every box.xs element is finite and not NaN',
    ])
  })

  test('escaped values keep their lines: call arguments, returns, and module writes', () => {
    // The filter drops a line only when the path is provably untouched. A value that
    // escapes may be read anywhere the walk cannot see — a callee evaluated inline can
    // read anything under an argument, the ensures lines describe a returned value, and
    // module state outlives the call — so an escape keeps every line at and below the
    // escaping path.
    const report = analyzeSource('read-filter-escapes.ts', `
      type Box = {xs: number[]; ys: number[]}
      function ignore(box: Box): number {
        return 0
      }
      export function passesWhole(box: Box): number {
        return ignore(box)
      }
      export function returnsWhole(box: Box): Box {
        return box
      }
      let stash: Box | null = null
      export function stores(box: Box): number {
        stash = box
        return 0
      }
    `)
    const allBoxLines = [
      'box.xs is a plain array — its length counts its elements, and every index below the length holds an element',
      'every box.xs element is finite and not NaN',
      'box.ys is a plain array — its length counts its elements, and every index below the length holds an element',
      'every box.ys element is finite and not NaN',
    ]
    expect(analyzedFunction(report, 'passesWhole').assumptions).toEqual(allBoxLines)
    expect(analyzedFunction(report, 'returnsWhole').assumptions).toEqual(allBoxLines)
    expect(analyzedFunction(report, 'stores').assumptions).toEqual(allBoxLines)
  })

  test('a fold prints only when every position its sentence covers was read', () => {
    // The folded sentence quantifies over the DECLARED properties, so printing it while
    // one is unread would claim trust nothing rests on — and re-restrict a legal caller
    // at the unread position, the over-restriction the read filter removes. With one of
    // three arrays unread, the two read ones print per-property and the third stays
    // silent.
    const report = analyzeSource('read-filter-fold.ts', `
      type Bands = {widths: number[]; gaps: number[]; margins: number[]}
      export function twoOfThree(bands: Bands): number {
        return bands.widths.length + bands.gaps.length
      }
    `)
    const filtered = analyzedFunction(report, 'twoOfThree')
    expect(filtered.assumptions).toEqual([
      'bands.widths is a plain array — its length counts its elements, and every index below the length holds an element',
      'every bands.widths element is finite and not NaN',
      'bands.gaps is a plain array — its length counts its elements, and every index below the length holds an element',
      'every bands.gaps element is finite and not NaN',
    ])
  })

})
