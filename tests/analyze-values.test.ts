import {describe, expect, test} from 'bun:test'
import {analyzeSource, formatReport} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

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
    expect(fn.assumptions).toEqual(['every values element is finite and not NaN'])
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
      'every values element is finite and not NaN',
      'index is finite and not NaN',
    ])
    expect(bare.ensures).toEqual(['return is a finite number'])
    // The asserted read's index and array are both nameable over the parameters, so the
    // obligation surfaces as a requires line the caller can satisfy, not an assumes line
    // the entry merely rests on.
    const asserted = analyzedFunction(report, 'assertedRead')
    expect(asserted.assumptions).toEqual([
      'every values element is finite and not NaN',
      'index is finite and not NaN',
    ])
    expect(asserted.requires).toEqual([`index is a valid values index (element read at ${file}:7:16)`])
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

  test('ensures lines cover only what the declared return type exposes', () => {
    // The wider literal's h is a true fact, but no type-checked caller can read it.
    const report = analyzeSource('wide-return.ts', `
      type Size = {w: number}
      function wideBox(): {w: number; h: number} {
        return {w: 3, h: 4}
      }
      export function measure(): Size {
        return wideBox()
      }
    `)
    expect(analyzedFunction(report, 'measure').ensures)
      .toEqual(['return.w is a finite integer number from 3 through 3'])
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
    expect(analyzedFunction(report, 'firstOrZero').assumptions)
      .toEqual(['every values element is finite and not NaN'])
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
    expect(analyzedFunction(report, 'rate').requires)
      .toEqual([`interval is nonzero (division at ${file}:3:41)`])
    // copy.columns resolves through the local literal to the grid.columns read stored at
    // construction, so the requirement names grid.columns, which the caller can satisfy.
    expect(analyzedFunction(report, 'throughCopyFields').requires)
      .toEqual([`grid.columns is nonzero (division at ${file}:8:16)`])
  })

  test('untagged array unions reject while copies and sentinel chains remain sound', () => {
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
      export function throughCopy(grid: {columns: number}): number {
        const copy = {...grid}
        if (copy.columns >= 1) {
          return 100 / grid.columns
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
      export function spreadDoubled(box: {gain: number}): number {
        const copy = {...box}
        return copy.gain + copy.gain
      }
      export function fromNestedLiteral(): number {
        const wrapper = {inner: {x: 1}}
        const copy = {...wrapper.inner}
        return copy.x + 2
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
    expect(lost.requires).toEqual([])
    expect(lost.ensures).toEqual(['return is a finite number from 0 through 100'])
    // A spread of a parameter record rejects: object spread copies only own enumerable
    // properties, and a structurally conforming caller can hold the declared property on
    // a getter or the prototype — `class NumberBox { get gain(): number { return 10 } }`
    // is strict-tsc clean with zero casts — so `{...box}` stores nothing and copy.gain is
    // undefined at runtime. spreadDoubled pins the falsification shape: off the empty
    // copy, copy.gain + copy.gain is NaN, while the spread's modeled per-property reads
    // published a non-NaN ensures. throughCopy pins the guarded spelling, rejected for
    // the same reason.
    expect(report.functions.find(fn => fn.name === 'throughCopy')?.kind).toBe('unsupported')
    expect(report.functions.find(fn => fn.name === 'spreadDoubled')?.kind).toBe('unsupported')
    expect(formatReport(report)).toContain('a spread of a record the analysis cannot trace to a record literal built in this function')
    // The explicit-fields twin is the supported spelling: the grid.columns read genuinely
    // happens and stores a real value, narrowing copy.columns narrows grid.columns (the
    // copy's property IS the stored read), and the guard discharges the division.
    const copied = analyzedFunction(report, 'throughCopyFields')
    expect(copied.requires).toEqual([])
    expect(copied.ensures).toEqual(['return is a finite number from 0 through 100'])
    // The trace chases property reads through local literals: wrapper.inner resolves to
    // the inner literal, so spreading it stays accepted. Replacing the chase with the
    // identity function used to survive the whole suite; this pin is what kills that
    // over-rejecting mutant.
    expect(analyzedFunction(report, 'fromNestedLiteral').ensures)
      .toEqual(['return is a finite integer number from 3 through 3'])
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
    expect(analyzedFunction(report, 'freshThenStale').assumptions)
      .toEqual(['every values element is finite and not NaN'])
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
      type Size = {a: number}
      function wide(count: number): {a: number; b: number} { return {a: count, b: count * 2} }
      export function findPoint(count: number): Size | null {
        if (count > 0) { return wide(count) }
        return null
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
    // The declared Size | null return filters the wide record's extra property through
    // the nullable wrapper.
    const found = analyzedFunction(report, 'findPoint')
    expect(found.ensures).toEqual([
      'return may be null; when present:',
      'return.a is a finite number more than 0',
    ])
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
    // The string property makes no assumption line — there is nothing to claim about it.
    expect(scaled.assumptions).toEqual([
      'box.width is finite and not NaN',
      'box.visible is a boolean',
      'factor is finite and not NaN',
    ])
    // A template literal is carried; the numeric contract survives.
    expect(analyzedFunction(report, 'labelled').assumptions).toEqual(['width is finite and not NaN'])
    // String dispatch: the comparison is an unknown boolean, both branches analyzed.
    expect(analyzedFunction(report, 'pick').ensures).toEqual(['return is a finite number'])
    // Boolean parameters are new too (the flat-numbers gate rejected them).
    expect(analyzedFunction(report, 'flagged').assumptions)
      .toEqual(['enabled is a boolean', 'value is finite and not NaN'])
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
    // declared-kind hedge, printed with its inner leaf condition.
    expect(reader.assumptions).toEqual(['queue is null or every queue element is finite and not NaN'])
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
        if (config === null) return 0
        return config.width
      }
    `)
    expect(analyzedFunction(report, 'firstOr').assumptions).toEqual([
      'values is null or every values element is finite and not NaN',
      'fallback is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'gridSum').assumptions).toEqual([
      'every grid[each] element is finite and not NaN',
      'config is null or config.width is finite and not NaN',
    ])
  })

  test('parameter defaults must be literals inside the declared kind', () => {
    // The analysis never evaluates a default initializer. `= 5` provably satisfies the
    // assumed-finite seeding, so ignoring the expression is sound; `= Number.POSITIVE_INFINITY`
    // would falsify the ensures on a zero-argument call, so the function rejects.
    const report = analyzeSource('bad-default.ts', `
      export function scaled(zoom: number = Number.POSITIVE_INFINITY): number {
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
    expect(analyzedFunction(report, 'remaining').assumptions).toEqual(['deadline is null or a finite non-NaN number'])
    expect(analyzedFunction(report, 'zoomOr').ensures).toEqual(['return is a finite number'])
  })

  test('optional literal-union parameters collapse to one scalar kind', () => {
    // `mode: 'compact' | 'wide' | undefined` has several non-missing union members; they
    // classify as one scalar kind (opaque here, number for 4 | 8 | undefined), the same
    // rule the bare union already gets. Two record shapes under a wrapper stay rejected.
    const report = analyzeSource('optional-literal-unions.ts', `
      export function pick(mode: 'compact' | 'wide' | undefined, a: number, b: number): number {
        if (mode === 'compact') return a
        return b
      }
      export function gapFor(size: 4 | 8 | undefined): number {
        return size === undefined ? 4 : size
      }
      export function pickWidth(mode: string | undefined, compact: number, wide: number): number {
        if (mode === 'compact') return compact
        return wide
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'gapFor').assumptions).toEqual(['size is undefined or a finite non-NaN number'])
    expect(analyzedFunction(report, 'pickWidth').ensures).toEqual(['return is a finite number'])
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
    expect(analyzedFunction(report, 'slotSum').assumptions)
      .toEqual(['slots[each] is null or slots[each].x is finite and not NaN'])
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
        return panel.width * panel.height + panel.gap
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
      'every property declared as a number in panel holds a finite non-NaN number',
      'panel.visible is a boolean',
      'panel.ratio is null or a finite non-NaN number',
      "panel.meter.slope is finite and not NaN (when panel.meter.kind is 'linear')",
      "panel.meter.base is finite and not NaN (when panel.meter.kind is 'log')",
    ])
    expect(analyzedFunction(report, 'span').assumptions).toEqual([
      'range.low is finite and not NaN',
      'range.high is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'pathTotal').assumptions).toEqual([
      'every property declared as a number in points holds a finite non-NaN number',
    ])
    expect(analyzedFunction(report, 'zoomedX').assumptions).toEqual([
      'offset is finite and not NaN',
      'every property declared as a number in camera holds a finite non-NaN number',
    ])
  })

})
