import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

describe('requirements and numeric checks', () => {
  test('one evaluated number stays identical through arithmetic, stable reads, and calls', () => {
    const report = analyzeSource('same-value.ts', `
      function identity(value: number): number { return value }
      function ratio(total: number, left: number, right: number): number {
        return total / (left - right)
      }
      function forwardedRatio(total: number, left: number, right: number): number {
        return ratio(total, left, right)
      }
      export function difference(value: number): number { return value - value }
      export function doubled(value: number): number { return value + value }
      export function square(value: number): number { return value * value }
      export function quotient(value: number): number { return value / value }
      export function remainder(value: number): number { return value % value }
      export function lengths(values: number[], text: string): number {
        return (values.length - values.length) + (text.length - text.length)
      }
      export function sameArgument(total: number, value: number): number {
        return ratio(total, value, value)
      }
      export function sameStoredResult(total: number, value: number): number {
        const result = identity(value)
        return ratio(total, result, result)
      }
      export function sameProperty(total: number, box: {value: number}): number {
        return ratio(total, box.value, box.value)
      }
      export function nestedLocalRecords(value: number): number {
        const inner = {value}
        const outer = {inner}
        return outer.inner.value - value
      }
      export function nestedRecordRequirement(total: number, divisor: number): number {
        const inner = {divisor}
        const outer = {inner}
        return total / outer.inner.divisor
      }
      export function sameThroughWrapper(total: number, value: number): number {
        return forwardedRatio(total, value, value)
      }
      export function separateCalls(total: number, value: number): number {
        return ratio(total, identity(value), identity(value))
      }
    `)

    expect(analyzedFunction(report, 'difference').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'doubled').ensures[0]).not.toContain('NaN')
    expect(analyzedFunction(report, 'square').ensures[0]).toContain('from 0 through Infinity')
    expect(analyzedFunction(report, 'quotient').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
    expect(analyzedFunction(report, 'remainder').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'lengths').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'nestedLocalRecords').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    const nestedRequirement = analyzedFunction(report, 'nestedRecordRequirement')
    expect(requirementsBesidesInputFiniteness(nestedRequirement)).toHaveLength(1)
    expect(nestedRequirement.assumptions.filter(line => line.includes('divisor at'))).toHaveLength(0)

    for (const name of ['sameArgument', 'sameStoredResult', 'sameProperty', 'sameThroughWrapper']) {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn?.kind !== 'partial') throw new Error(`expected ${name} to reject the impossible call`)
      expect(fn.partialReasons[0]).toContain('violates its nonzero divisor requirement')
    }
    // Matching source text is not identity: these calls are evaluated separately.
    expect(analyzedFunction(report, 'separateCalls').assumptions)
      .toContain('the divisor at same-value.ts:4:16 is nonzero')
  })

  test('same-value comparisons preserve JavaScript NaN behavior', () => {
    const report = analyzeSource('same-value-comparisons.ts', `
      export function selfLess(text: string): number {
        const parsed = Number.parseFloat(text)
        return parsed < parsed ? 1 : 2
      }
      export function selfEqual(text: string): number {
        const parsed = Number.parseFloat(text)
        return parsed === parsed ? 1 : 2
      }
      export function finiteSelf(value: number): number {
        if (value !== value) return 1
        if (value >= value) return 2
        return 3
      }
      export function booleanSelf(flag: boolean): number {
        return flag === flag ? 1 : 2
      }
    `)

    expect(analyzedFunction(report, 'selfLess').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])
    expect(analyzedFunction(report, 'selfEqual').ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
    expect(analyzedFunction(report, 'finiteSelf').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])
    expect(analyzedFunction(report, 'booleanSelf').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
  })

  test('a requirement applies to later uses of the same stored value on that path', () => {
    const report = analyzeSource('requirement-reuse.ts', `
      function divideOnce(total: number, divisor: number): number {
        return total / divisor
      }
      function requireNonzero(divisor: number): number {
        console.assert(divisor !== 0)
        return 0
      }
      function dividePair(left: number, right: number): number {
        return 1 / left + 2 / right
      }
      function readPair(values: number[], first: number, second: number): number {
        return values[first]! + values[second]!
      }
      export function storedDivisor(left: number, right: number, base: number, offset: number): number {
        const divisor = base - offset
        return left / divisor + right / divisor
      }
      export function recomputedDivisor(left: number, right: number, base: number, offset: number): number {
        return left / (base - offset) + right / (base - offset)
      }
      export function repeatedRead(values: number[], index: number): number {
        return values[index]! - values[index]!
      }
      export function savedProperty(box: {value: number}): number {
        const saved = box.value
        return 1 / box.value + 2 / saved
      }
      export function afterCompletedCall(left: number, right: number, divisor: number): number {
        const first = divideOnce(left, divisor)
        return first + right / divisor
      }
      export function afterDeclaredRequirement(total: number, divisor: number): number {
        const checked = requireNonzero(divisor)
        return checked + total / divisor
      }
      export function duplicateArguments(value: number): number {
        return dividePair(value, value)
      }
      export function duplicateIndexes(values: number[], index: number): number {
        return readPair(values, index, index)
      }
      export function repeatedElementDivisor(values: number[], index: number): number {
        return 1 / values[index]! + 2 / values[index]!
      }
      export function guardedRepeatedElement(values: number[], index: number): number {
        if (values[index]! !== 0) return 1 / values[index]!
        return 0
      }
      export function replacedDivisor(total: number, divisor: number): number {
        const first = total / divisor
        divisor = 0
        return first + total / divisor
      }
      export function replacedIndex(values: number[], index: number): number {
        const first = values[index]!
        index = -1
        return first + values[index]!
      }
      export function separateBranches(flag: boolean, total: number, divisor: number): number {
        if (flag) return total / divisor
        return (total + 1) / divisor
      }
      export function branchThenUse(flag: boolean, left: number, right: number, divisor: number): number {
        let result = 0
        if (flag) result = left / divisor
        return result + right / divisor
      }
      export function loopThenUse(count: number, left: number, right: number, divisor: number): number {
        let result = 0
        for (let index = 0; index < count; index += 1) result = result + left / divisor
        return result + right / divisor
      }
      export function requirementBeforeLoop(count: number, left: number, right: number, divisor: number): number {
        let result = left / divisor
        for (let index = 0; index < count; index += 1) result = result + right / divisor
        return result
      }
      export function separateArrays(left: number[], right: number[], index: number): number {
        return left[index]! + right[index]!
      }
      export function fractionalIndex(values: number[]): number {
        return values[0.5]!
      }
      export function infiniteIndex(values: number[]): number {
        return values[Infinity]!
      }
      export function tuplePastEnd(
        values: [number, number, number, number, number, number],
        index: number,
      ): number {
        if (index >= 5.5 && index <= 6.5) return values[index]!
        return 0
      }
      export function freshReads(): number {
        return performance.now() - performance.now()
      }
    `)

    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'storedDivisor'))).toHaveLength(1)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'recomputedDivisor'))).toHaveLength(2)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'repeatedRead'))).toHaveLength(1)
    expect(analyzedFunction(report, 'repeatedRead').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    for (const name of [
      'savedProperty',
      'afterCompletedCall',
      'afterDeclaredRequirement',
      'duplicateArguments',
    ]) {
      expect(requirementsBesidesInputFiniteness(analyzedFunction(report, name))).toHaveLength(1)
    }
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'duplicateIndexes'))).toHaveLength(1)
    const repeatedElement = analyzedFunction(report, 'repeatedElementDivisor')
    expect(requirementsBesidesInputFiniteness(repeatedElement)).toHaveLength(1)
    expect(repeatedElement.assumptions.filter(line => line.includes('divisor at'))).toHaveLength(1)
    const guardedElement = analyzedFunction(report, 'guardedRepeatedElement')
    expect(requirementsBesidesInputFiniteness(guardedElement)).toHaveLength(1)
    expect(guardedElement.assumptions.filter(line => line.includes('divisor at'))).toHaveLength(0)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'separateBranches'))).toHaveLength(2)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'branchThenUse'))).toHaveLength(2)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'loopThenUse'))).toHaveLength(2)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'requirementBeforeLoop'))).toHaveLength(1)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'separateArrays'))).toHaveLength(2)
    expect(analyzedFunction(report, 'freshReads').ensures[0]).not.toContain('from 0 through 0')

    for (const name of [
      'replacedDivisor',
      'replacedIndex',
      'fractionalIndex',
      'infiniteIndex',
      'tuplePastEnd',
    ]) {
      const fn = report.functions.find(candidate => candidate.name === name)
      if (fn?.kind !== 'partial') throw new Error(`expected ${name} to reject the impossible operation`)
    }
    const fractional = report.functions.find(candidate => candidate.name === 'fractionalIndex')
    if (fractional?.kind !== 'partial') throw new Error('expected fractionalIndex to be partial')
    expect(fractional.partialReasons[0]).toContain('reads an element provably outside the array')
  })

  test('switch dispatch and rejection boundaries', () => {
    // Owner decision: every non-empty case body ends in break or return, stacked empty
    // labels share the next body, default comes last. Under that rule a switch is exactly
    // an if/else chain on ===: string subjects analyze both branches, number subjects get
    // the comparison narrowing, and break paths merge after the switch.
    const report = analyzeSource('switch-dispatch.ts', `
      export function dispatch(mode: string, a: number, b: number): number {
        switch (mode) {
          case 'a':
          case 'b':
            return a
          default:
            return b
        }
      }
      export function gapFor(size: number): number {
        let gap = 0
        switch (size) {
          case 4: gap = 1; break
          case 8: gap = 2; break
          default: gap = 3; break
        }
        return gap
      }
      export function narrows(step: number): number {
        switch (step) {
          case 4: return 100 / step
          default: return 0
        }
      }
      export function falls(mode: string, a: number): number {
        switch (mode) {
          case 'a': a = a + 1
          case 'b': return a
        }
        return 0
      }
      export function defaultFirst(mode: string, a: number, b: number): number {
        switch (mode) {
          default: return b
          case 'a': return a
        }
      }
      export function boolSubject(flag: boolean, a: number): number {
        switch (flag) {
          case true: return a
          default: return 0
        }
      }
    `)
    expect(analyzedFunction(report, 'dispatch').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'gapFor').ensures).toEqual(['return is a finite integer number from 1 through 3'])
    // Inside case 4 the subject is exactly 4, so the division discharges with no
    // requirement — the same narrowing an if (step === 4) gets.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'narrows'))).toEqual([])
    expect(analyzedFunction(report, 'narrows').ensures).toEqual(['return is a finite integer number from 0 through 25'])
    const entries = new Map(report.functions.map(fn => [fn.name, fn]))
    const falls = entries.get('falls')!
    if (falls.kind !== 'unsupported') throw new Error(`expected falls to be unsupported, got ${falls.kind}`)
    expect(falls.unsupported).toContain('falls through to the next case')
    const defaultFirst = entries.get('defaultFirst')!
    if (defaultFirst.kind !== 'unsupported') throw new Error(`expected defaultFirst unsupported, got ${defaultFirst.kind}`)
    expect(defaultFirst.unsupported).toContain('default clause before other cases')
    const boolSubject = entries.get('boolSubject')!
    if (boolSubject.kind !== 'unsupported') throw new Error(`expected boolSubject unsupported, got ${boolSubject.kind}`)
    expect(boolSubject.unsupported).toContain('only numbers and strings dispatch')
  })

  test('guards discharge nonzero obligations in all three everyday spellings', () => {
    const report = analyzeSource('guard-discharge.ts', `
      export function notEqualGuard(total: number, count: number): number {
        if (count !== 0) { return total / count }
        return 0
      }
      export function earlyReturn(total: number, count: number): number {
        if (count === 0) { return 0 }
        return total / count
      }
      export function positiveGuard(total: number, count: number): number {
        if (count > 0) { return total / count }
        return 0
      }
    `)
    for (const name of ['notEqualGuard', 'earlyReturn', 'positiveGuard']) {
      const fn = analyzedFunction(report, name)
      expect(requirementsBesidesInputFiniteness(fn)).toEqual([])
      // A float divisor can sit arbitrarily close to zero, so the quotient can overflow;
      // the honest ensures is possibly non-finite, never NaN (zero is cut, so no 0/0).
      expect(fn.ensures[0]).toContain('possibly non-finite')
      expect(fn.ensures[0]).not.toContain('NaN')
    }
  })

  test('the not-equal branch keeps NaN: a NaN operand passes !== and lands on the not-equal side', () => {
    // multiply can produce NaN (0 * Infinity); NaN !== 0 is true at runtime, so the
    // guarded branch must NOT claim NaN-freedom — the ensures stays possibly NaN.
    const report = analyzeSource('notequal-nan.ts', `
      export function scaled(a: number, b: number): number {
        const product = a * b
        if (product !== 0) { return 100 / product }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'scaled').ensures[0]).toContain('possibly NaN')
  })

  test('the zero exclusion survives loop widening', () => {
    const report = analyzeSource('loop-flag.ts', `
      export function accumulate(count: number, step: number): number {
        let total = 0
        for (let index = 0; index < count; index += 1) {
          if (step !== 0) { total = total + 100 / step }
        }
        return total
      }
    `)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'accumulate'))).toEqual([])
  })

  test('nonzero obligations peel to caller-readable conditions through float-exact layers only', () => {
    const report = analyzeSource('peeling.ts', `
      export function pad(total: number, width: number): number {
        return total / (width - 4)
      }
      export function doubled(total: number, scale: number): number {
        return total / ((scale + 10) * 2)
      }
      export function tinyFactor(total: number, x: number): number {
        return total / (x * 1e-300)
      }
      export function property(total: number, grid: {cols: number}): number {
        return total / (grid.cols - 1)
      }
    `)
    const file = 'peeling.ts'
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'pad')))
      .toEqual([`width is not 4 (division at ${file}:3:16)`])
    // The multiply peels (|2| >= 1 cannot underflow the product to zero), then the add.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'doubled')))
      .toEqual([`scale is not -10 (division at ${file}:6:16)`])
    // A small constant CAN underflow the product to zero (1e-200 * 1e-200 === 0), so the
    // obligation stays as written.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'tinyFactor')))
      .toEqual([`(x * 1e-300) is nonzero (division at ${file}:9:16)`])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'property')))
      .toEqual([`grid.cols is not 1 (division at ${file}:12:16)`])
  })

  test('peeled requirements propagate through calls with the caller arguments substituted', () => {
    const report = analyzeSource('peel-propagation.ts', `
      function stepFor(width: number, gap: number): number {
        return width / (gap - 2)
      }
      export function layout(totalWidth: number, gutter: number): number {
        return stepFor(totalWidth, gutter + 1)
      }
      export function fixed(totalWidth: number): number {
        return stepFor(totalWidth, 10)
      }
    `)
    const file = 'peel-propagation.ts'
    // The peel stops at the substituted argument: (gutter + 1) is not 2 is float-exact,
    // while peeling further to 'gutter is not 1' would trust rounding.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'layout')))
      .toEqual([`(gutter + 1) is not 2 (division at ${file}:3:16)`])
    // A constant argument discharges by plain evaluation: 10 - 2 is provably nonzero.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'fixed'))).toEqual([])
  })

  test('the bounds-check idiom discharges asserted reads: relation, integrality, manual loops', () => {
    const report = analyzeSource('bounds-idiom.ts', `
      export function at(sizes: number[], slot: number): number {
        if (Number.isInteger(slot) && slot >= 0 && slot < sizes.length) {
          return sizes[slot]!
        }
        return 0
      }
      export function manualLoop(values: number[]): number {
        let total = 0
        for (let index = 0; index < values.length; index += 1) {
          total = total + values[index]!
        }
        return total
      }
      export function floatIndex(sizes: number[], slot: number): number {
        if (slot >= 0 && slot < sizes.length) { return sizes[slot]! }
        return 0
      }
      export function wrongArray(a: number[], b: number[], i: number): number {
        if (Number.isInteger(i) && i >= 0 && i < a.length) { return b[i]! }
        return 0
      }
    `)
    const file = 'bounds-idiom.ts'
    // The full defensive guard proves the read: no requires line at all.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'at'))).toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'manualLoop'))).toEqual([])
    // Without integrality the guard is not enough — sizes[1.5] misses — so the obligation
    // honestly survives as the caller-actionable requirement.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'floatIndex')))
      .toEqual([`slot is a valid sizes index (element read at ${file}:16:56)`])
    // The relation is paired per array: guarding a's length says nothing about b.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'wrongArray')))
      .toEqual([`i is a valid b index (element read at ${file}:20:69)`])
  })

  test('branch joins keep the shared part of two index checks', () => {
    const report = analyzeSource('joined-index-facts.ts', `
      export function guardedFirst(values: number[], index: number, guarded: boolean): number {
        if (!Number.isInteger(index) || index < 0) return 0
        if (guarded) {
          if (index >= values.length) return 0
        } else if (values[index]! === Infinity) return Infinity
        return values[index]!
      }
      export function readFirst(values: number[], index: number, guarded: boolean): number {
        if (!Number.isInteger(index) || index < 0) return 0
        if (guarded) {
          if (values[index]! === Infinity) return Infinity
        } else {
          if (index >= values.length) return 0
        }
        return values[index]!
      }
      export function differentArrays(values: number[], other: number[], index: number, guarded: boolean): number {
        if (!Number.isInteger(index) || index < 0) return 0
        if (guarded) {
          if (index >= values.length) return 0
        } else if (other[index]! === Infinity) return Infinity
        return values[index]!
      }
    `)

    for (const name of ['guardedFirst', 'readFirst']) {
      expect(requirementsBesidesInputFiniteness(analyzedFunction(report, name))).toHaveLength(1)
      expect(requirementsBesidesInputFiniteness(analyzedFunction(report, name))[0]).toContain('index is a valid values index')
    }
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'differentArrays'))).toHaveLength(2)
  })

  test('unproven asserted reads mint a requires when nameable, an assumes otherwise', () => {
    const report = analyzeSource('bounds-mint.ts', `
      const gapSizes = [4, 8, 24]
      export function fromModule(slot: number): number {
        return gapSizes[slot]!
      }
      export function fromParameter(sizes: number[], slot: number): number {
        return sizes[slot + 1]!
      }
    `)
    const file = 'bounds-mint.ts'
    // A module array is not caller-visible, so the obligation stays an assumes line.
    expect(analyzedFunction(report, 'fromModule').assumptions)
      .toContain(`the element read at ${file}:4:16 is in bounds`)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'fromParameter')))
      .toEqual([`(slot + 1) is a valid sizes index (element read at ${file}:7:16)`])
  })

  test('the expression walk budget falls back to the honest divisor assumption', () => {
    // Each squaring doubles the expression tree (the defining DAG is linear, the tree is
    // exponential); the walk charges instruction expansions against the function's own
    // instruction count, so the requirement can never be more complex than the function.
    // Exhaustion lands in the same fallback an unnameable divisor gets: one assumes line,
    // and the function keeps its contract.
    const chain = Array.from({length: 20}, () => '  a = a * a').join('\n')
    const report = analyzeSource('walk-budget.ts', `
      export function monster(total: number, x: number): number {
        let a = x + 1
${chain}
        return total / a
      }
    `)
    const monster = analyzedFunction(report, 'monster')
    expect(monster.assumptions).toContain(`the divisor at walk-budget.ts:24:16 is nonzero`)
  })

  test('Number.isFinite narrows: the passing branch is finite, the failing branch prunes when provably finite', () => {
    const report = analyzeSource('isfinite-narrow.ts', `
      export function recovered(a: number, b: number): number {
        const product = a * b
        if (Number.isFinite(product)) { return product }
        return 0
      }
    `)
    // a * b can overflow and turn NaN, but the passing branch proves finiteness — and the
    // 0 fallback keeps the whole return finite.
    expect(analyzedFunction(report, 'recovered').ensures).toEqual(['return is a finite number'])
  })

  test('the printed guard for a peeled requirement discharges it', () => {
    // The report says 'requires: width is not 4'; an agent writes exactly that guard and
    // the requirement must go away — the excluded-point cut flows through width - 4 into
    // a zero exclusion on the divisor (an IEEE sum is zero only on exact negation), and
    // through scale * 2 (a factor of magnitude at least 1 cannot underflow a nonzero
    // product to zero). Both spellings of the guard work.
    const report = analyzeSource('peel-discharge.ts', `
      export function widthGuard(width: number, total: number): number {
        if (width !== 4) { return total / (width - 4) }
        return 0
      }
      export function scaleGuarded(scale: number): number {
        if (scale !== 0) { return 100 / (scale * 2) }
        return 0
      }
    `)
    for (const name of ['widthGuard', 'scaleGuarded']) {
      expect(requirementsBesidesInputFiniteness(analyzedFunction(report, name))).toEqual([])
    }
  })

  test('bounds guards work on record properties and across calls', () => {
    // Valid-index pairs key on canonical value names, so two property reads of the same
    // immutable record match — and a guarded call site seeds the relation onto the
    // callee's parameters, so the caller discharges what the callee alone must require.
    const report = analyzeSource('bounds-composition.ts', `
      type Config = {sizes: number[]; cursor: number}
      export function propertyGuard(config: Config): number {
        if (Number.isInteger(config.cursor) && config.cursor >= 0 && config.cursor < config.sizes.length) {
          return config.sizes[config.cursor]!
        }
        return 0
      }
      function sizeAt(sizes: number[], slot: number): number {
        return sizes[slot]!
      }
      export function guardedCall(sizes: number[], slot: number): number {
        if (Number.isInteger(slot) && slot >= 0 && slot < sizes.length) {
          return sizeAt(sizes, slot)
        }
        return 0
      }
    `)
    const file = 'bounds-composition.ts'
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'propertyGuard'))).toEqual([])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'guardedCall'))).toEqual([])
    // The helper itself still carries the honest requirement for unguarded callers.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'sizeAt')))
      .toEqual([`slot is a valid sizes index (element read at ${file}:10:16)`])
  })

  test('Number.isNaN removes NaN while exact constants keep exact prose', () => {
    const report = analyzeSource('isnan-and-constants.ts', `
      export function laundered(a: number, b: number): number {
        const product = a * b
        if (Number.isNaN(product)) { return 0 }
        return Math.min(Math.max(product, 0), 100)
      }
      export function exactConstant(): number {
        return 0.1 + 0.2
      }
    `)
    // a * b can be NaN (0 * Infinity); the early return launders it, and the clamp does
    // the rest.
    expect(analyzedFunction(report, 'laundered').ensures)
      .toEqual(['return is a finite number from 0 through 100'])
    // A point interval is an exact value; the strict-bound rewrite must not turn it into
    // an absurd range like 'more than 0.3 and at most 0.30000000000000004'.
    expect(analyzedFunction(report, 'exactConstant').ensures)
      .toEqual(['return is a finite number from 0.30000000000000004 through 0.30000000000000004'])
  })

  test('bounds checks over module values require a local snapshot', () => {
    // Separate reads of a module binding are not assumed to be the same value. A local
    // snapshot gives the check and read one immutable identity, even if the binding is
    // rebound between them.
    const report = analyzeSource('module-rebind-bounds.ts', `
      let data = [10, 20, 30, 40]
      export function direct(i: number): number {
        if (Number.isInteger(i) && i >= 0 && i < data.length) {
          return data[i]!
        }
        return 0
      }
      export function snapshot(i: number): number {
        const current = data
        data = [7]
        if (Number.isInteger(i) && i >= 0 && i < current.length) {
          return current[i]!
        }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'direct').assumptions.join(' ')).toContain('is in bounds')
    expect(analyzedFunction(report, 'snapshot').assumptions.join(' ')).not.toContain('is in bounds')
  })

  test('initializer bounds assumptions travel to module readers', () => {
    // A top-level breakpoints[idx]! with a platform-derived index conditions everything
    // the initializer published; the assumption line lands on every function that reads a
    // module binding (currentBreakpoint would return undefined at a wide viewport, so its
    // ensures must not publish unconditionally), and functions touching no module state
    // stay clean.
    const report = analyzeSource('init-bounds.ts', `
      const breakpoints = [480, 768, 1024]
      const idx = Math.min(Math.floor(window.innerWidth / 400), 5)
      const activeBreakpoint = breakpoints[idx]!
      export function currentBreakpoint(): number {
        return activeBreakpoint
      }
      export function checkedBreakpoint(): number {
        const result = activeBreakpoint
        console.assert(Number.isFinite(result))
        return result
      }
      export function unrelated(x: number): number {
        return x * 2
      }
    `)
    const file = 'init-bounds.ts'
    expect(analyzedFunction(report, 'currentBreakpoint').assumptions)
      .toEqual([`the element read at ${file}:4:32 is in bounds`])
    const checked = analyzedFunction(report, 'checkedBreakpoint')
    expect(checked.assumptions).toEqual([`the element read at ${file}:4:32 is in bounds`])
    expect(checked.assertions?.map(assertion => assertion.verdict)).toEqual(['blocked'])
    expect(analyzedFunction(report, 'unrelated').assumptions).toEqual([])
    expect(analyzedFunction(report, 'unrelated').requires[0]).toContain('Number.isFinite(x)')
  })

  test('the float biconditionals behind requirement simplification hold mechanically', () => {
    // Requirement simplification and its forward mirror in the domain arithmetic rest on
    // two IEEE-754 facts: gradual underflow makes a subtraction exact when its result is
    // tiny, so x - c is zero exactly when x equals c; and a factor of magnitude at least
    // 1 cannot shrink a nonzero value below the round-to-zero threshold. Checked here
    // over subnormals, boundary values, and deterministic random bit patterns rather
    // than trusted from memory of the standard.
    const battery = [
      0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** -1073, 2 ** -1022,
      (2 ** -1022) * (1 - 2 ** -52), Number.MAX_VALUE, -Number.MAX_VALUE,
      1, -1, 1 + 2 ** -52, 0.1, 0.3, 1e-200, 1e-300, 1e300, 4, 2 ** 53, 2 ** 53 + 2,
    ]
    let seed = 0x9e3779b97f4a7c15n
    const scratch = new Float64Array(1)
    const scratchBits = new BigUint64Array(scratch.buffer)
    const values = [...battery]
    while (values.length < 700) {
      seed = (seed ^ (seed << 13n)) & 0xffffffffffffffffn
      seed ^= seed >> 7n
      seed = (seed ^ (seed << 17n)) & 0xffffffffffffffffn
      scratchBits[0] = seed
      const candidate = scratch[0]!
      if (Number.isFinite(candidate)) values.push(candidate)
    }
    const failures: string[] = []
    for (const x of values) {
      for (const c of values) {
        if ((x - c === 0) !== (x === c)) failures.push(`subtract: x=${x} c=${c}`)
        if ((x + c === 0) !== (x === -c)) failures.push(`add: x=${x} c=${c}`)
        if (Math.abs(c) >= 1 && Number.isFinite(c) && (c * x === 0) !== (x === 0)) {
          failures.push(`multiply: x=${x} c=${c}`)
        }
      }
    }
    expect(failures).toEqual([])
    // The counterexamples that keep small factors and division out of the rule — the
    // lint is right that these are constant zero; constant zero from nonzero operands is
    // the whole point being pinned.
    // oxlint-disable-next-line erasing-op
    expect(1e-200 * 1e-200).toBe(0)
    // oxlint-disable-next-line erasing-op
    expect(1e-300 / 1e300).toBe(0)
  })

  test('Math.round, ceil, trunc, sqrt, and the square identity', () => {
    // The rounding family is monotone and exact on infinities like floor; sqrt clips a
    // possibly-negative operand to the non-negative part and turns the NaN flag on; and
    // x * x with the SAME value on both sides cannot be negative, which together with a
    // Number.isFinite guard proves the classic vector length finite.
    const report = analyzeSource('math-family.ts', `
      export function snap(target: number, step: number): number {
        if (step > 0) { return Math.round(target / step) * step }
        return target
      }
      export function cells(width: number): number {
        return Math.max(1, Math.ceil(width / 240))
      }
      export function truncated(value: number): number {
        return Math.trunc(value)
      }
      export function bareLength(dx: number, dy: number): number {
        return Math.sqrt(dx * dx + dy * dy)
      }
      export function safeLength(dx: number, dy: number): number {
        const sum = dx * dx + dy * dy
        if (Number.isFinite(sum)) { return Math.sqrt(sum) }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'cells').ensures)
      .toEqual(['return is a finite integer number from 1 through 7.490388061926316e+305'])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'snap'))).toEqual([])
    expect(analyzedFunction(report, 'snap').ensures[0]).toContain('possibly NaN')
    expect(analyzedFunction(report, 'truncated').ensures).toEqual(['return is a finite integer number'])
    // Squares cannot be negative, so the sum has no opposite-infinity corner and never
    // turns NaN — the unguarded length can only overflow, and sqrt carries the honest
    // possibly-non-finite through.
    expect(analyzedFunction(report, 'bareLength').ensures[0])
      .toContain('possibly non-finite number from 0 through Infinity')
    expect(analyzedFunction(report, 'safeLength').ensures)
      .toEqual(['return is a finite number from 0 through 1.3407807929942596e+154'])
  })

  test('sqrt of a provably negative operand answers claim-free, not with NaN bounds', () => {
    // Math.sqrt of a negative number is always NaN at runtime, and the domain has no
    // NaN-only value. The old arm returned literal NaN interval bounds, which poisoned
    // every Math.min/Math.max over them: branch refinement then printed the nonsense
    // `from NaN through NaN` while clearing the NaN flag, and the function below
    // actually returns 0 at runtime (NaN > 0 is false). The honest answer is the
    // claim-free full range with the NaN possibility kept.
    const report = analyzeSource('sqrt-negative.ts', `
      export function refinedNaNBounds(): number {
        const root = Math.sqrt(-4)
        if (root > 0) return root
        return 0
      }
      export function joinedWithClean(flag: boolean): number {
        const root = Math.sqrt(-4)
        const chosen = flag ? root : 5
        if (chosen > 1) return chosen
        return 1
      }
    `)
    // The true branch of `root > 0` proves root is not NaN (a true ordered comparison
    // has no NaN operand), so the joined result is honestly NaN-free; the runtime value
    // 0 sits inside the printed range.
    const refined = analyzedFunction(report, 'refinedNaNBounds').ensures[0]!
    expect(refined).toContain('possibly non-finite number from 0 through Infinity')
    const joined = analyzedFunction(report, 'joinedWithClean').ensures[0]!
    expect(joined).toContain('possibly non-finite number from 1 through Infinity')
  })

})
