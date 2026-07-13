import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

describe('requirements and numeric checks', () => {
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
    expect(analyzedFunction(report, 'narrows').requires).toEqual([])
    expect(analyzedFunction(report, 'narrows').ensures).toEqual(['return is a finite number from 0 through 25'])
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
      expect(fn.requires).toEqual([])
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
    expect(analyzedFunction(report, 'accumulate').requires).toEqual([])
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
    expect(analyzedFunction(report, 'pad').requires)
      .toEqual([`width is not 4 (division at ${file}:3:16)`])
    // The multiply peels (|2| >= 1 cannot underflow the product to zero), then the add.
    expect(analyzedFunction(report, 'doubled').requires)
      .toEqual([`scale is not -10 (division at ${file}:6:16)`])
    // A small constant CAN underflow the product to zero (1e-200 * 1e-200 === 0), so the
    // obligation stays as written.
    expect(analyzedFunction(report, 'tinyFactor').requires)
      .toEqual([`(x * 1e-300) is nonzero (division at ${file}:9:16)`])
    expect(analyzedFunction(report, 'property').requires)
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
    expect(analyzedFunction(report, 'layout').requires)
      .toEqual([`(gutter + 1) is not 2 (division at ${file}:3:16)`])
    // A constant argument discharges by plain evaluation: 10 - 2 is provably nonzero.
    expect(analyzedFunction(report, 'fixed').requires).toEqual([])
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
          total = total + (values[index] ?? 0)
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
    expect(analyzedFunction(report, 'at').requires).toEqual([])
    expect(analyzedFunction(report, 'manualLoop').requires).toEqual([])
    // Without integrality the guard is not enough — sizes[1.5] misses — so the obligation
    // honestly survives as the caller-actionable requirement.
    expect(analyzedFunction(report, 'floatIndex').requires)
      .toEqual([`slot is a valid sizes index (element read at ${file}:16:56)`])
    // The relation is paired per array: guarding a's length says nothing about b.
    expect(analyzedFunction(report, 'wrongArray').requires)
      .toEqual([`i is a valid b index (element read at ${file}:20:69)`])
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
    expect(analyzedFunction(report, 'fromParameter').requires)
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
      export function widthEarlyExit(width: number, total: number): number {
        if (width === 4) { return 0 }
        return total / (width - 4)
      }
      export function scaleGuarded(scale: number): number {
        if (scale !== 0) { return 100 / (scale * 2) }
        return 0
      }
    `)
    for (const name of ['widthGuard', 'widthEarlyExit', 'scaleGuarded']) {
      expect(analyzedFunction(report, name).requires).toEqual([])
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
    expect(analyzedFunction(report, 'propertyGuard').requires).toEqual([])
    expect(analyzedFunction(report, 'guardedCall').requires).toEqual([])
    // The helper itself still carries the honest requirement for unguarded callers.
    expect(analyzedFunction(report, 'sizeAt').requires)
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
    expect(analyzedFunction(report, 'unrelated').assumptions).toEqual(['x is finite and not NaN'])
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
    expect(analyzedFunction(report, 'snap').requires).toEqual([])
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
