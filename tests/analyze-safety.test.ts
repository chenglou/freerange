import {describe, expect, test} from 'bun:test'
import {analyzeFile, analyzeSource, formatReport} from '../src/index.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

describe('acceptance and module safety', () => {
  test('publishes values initialized before a top-level stop and distrusts writes after it', () => {
    const report = analyzeSource('module-stop.ts', `
      const boxesGapY = 12
      runsUnsupported()
      let scale = 3
      export function gapAfterStop(): number {
        return boxesGapY
      }
      export function scaleAfterStop(): number {
        return scale
      }
      function runsUnsupported(): number {
        return 1 ** 2
      }
    `)
    const file = 'module-stop.ts'
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      partialReasons: [`calls runsUnsupported, which hit unsupported code (call at ${file}:3:7)`],
      skipped: [],
      observed: [],
    })
    // boxesGapY was written before the stop, so its value holds on every analyzed path.
    expect(analyzedFunction(report, 'gapAfterStop').ensures)
      .toEqual(['return is a finite integer number from 12 through 12'])
    // scale's write sits past the stop: the analysis never confirmed it ran, so only the
    // declared kind survives.
    const scaleReader = analyzedFunction(report, 'scaleAfterStop')
    expect(scaleReader.assumptions).toEqual(['scale is finite and not NaN'])
    expect(scaleReader.ensures).toEqual(['return is a finite number'])
  })

  test('eval anywhere puts the whole file outside the subset', () => {
    // An eval string can rewrite any binding in the file at runtime, so rejecting only the
    // function containing the call would not protect the other functions' reports. The
    // detection is a plain identifier scan: every spelling that could reach module scope,
    // e.g. `(eval)(...)`, contains the identifier.
    const source = `
      const fixedHeight = 4
      export function readHeight(): number {
        return fixedHeight
      }
      function poke(): void {
        eval("somethingElse = 99")
      }
    `
    const report = analyzeSource('module-eval.ts', source)
    const file = 'module-eval.ts'
    const prose = `eval appears in this file; an eval string can rewrite any binding, so no function in the file is analyzed at ${file}:7:9`
    expect(report.functions).toEqual([
      {kind: 'partial', name: 'module initialization', assumptions: [], partialReasons: [prose], skipped: [], observed: []},
      {kind: 'unsupported', name: 'readHeight', unsupported: prose},
      {kind: 'unsupported', name: 'poke', unsupported: prose},
    ])

    const wrapped = analyzeSource('module-eval-wrapped.ts', source.replace('eval(', '(eval)('))
    expect(wrapped.functions.every(fn => fn.kind !== 'analyzed')).toBe(true)
  })

  test('finds writes hidden in shorthand destructuring assignments', () => {
    // In `({scale} = source)`, getSymbolAtLocation on the shorthand name returns the
    // contextual type's property symbol, not the module variable; the scan must resolve it
    // to the variable or the write is missed and a stale exact value is published.
    const report = analyzeSource('module-destructuring.ts', `
      let scale = 2
      export function readScale(): number {
        return scale
      }
      export function overwrite(source: {scale: number}): number {
        ;({scale} = source)
        return 1
      }
    `)
    const reader = analyzedFunction(report, 'readScale')
    expect(reader.assumptions).toEqual(['scale is finite and not NaN'])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('rejects var declarations', () => {
    // Hoisting gives one variable several declaration sites (`var x = 1; { var x = 2 }` is
    // one variable), which the binding model does not represent; let and const express the
    // same programs. In a function the whole function is rejected; at top level the
    // initializer stops at the var statement, and functions reading the name never see a
    // module binding.
    const report = analyzeSource('module-var.ts', `
      var mode = 1
      export function currentMode(): number {
        return mode
      }
      export function lastWrite(count: number): number {
        var width = 1
        for (let index = 0; index < count; index++) {
          var width = 5
        }
        return width
      }
    `)
    const file = 'module-var.ts'
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      partialReasons: [],
      skipped: [`var declarations (use let or const) at ${file}:2:7`],
      observed: [],
    })
    expect(report.functions.find(fn => fn.name === 'currentMode')).toEqual({
      kind: 'unsupported',
      name: 'currentMode',
      unsupported: `unknown identifier mode at ${file}:4:16`,
    })
    expect(report.functions.find(fn => fn.name === 'lastWrite')?.kind).toBe('unsupported')
  })

  test('records a top-level loop that never exits instead of crashing', () => {
    const report = analyzeSource('module-spin.ts', `
      const boxesGapX = 24
      for (let index = 0; true; index += 1) {}
      export function readGap(): number {
        return boxesGapX
      }
    `)
    const file = 'module-spin.ts'
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      partialReasons: [`the loop at ${file}:3:7 never exits on any analyzed path`],
      skipped: [],
      observed: [],
    })
    // boxesGapX was written before the loop and the loop writes nothing, so it publishes.
    expect(analyzedFunction(report, 'readGap').ensures)
      .toEqual(['return is a finite integer number from 24 through 24'])
  })

  test('keeps mixed-kind writes to an unknown-typed module binding from crashing the join', () => {
    const report = analyzeSource('module-opaque.ts', `
      let anything: unknown = 5
      let flag = 3
      if (readFlag() > 2) {
        anything = true
      }
      export function readFlag(): number {
        return flag
      }
    `)
    // One path leaves a number in the slot and the other a boolean; the slot must not hold
    // either (reads of unknown-typed bindings stop anyway), so the join never sees mixed
    // kinds. flag is written before the branch on both paths, so it still publishes.
    expect(analyzedFunction(report, 'readFlag').ensures)
      .toEqual(['return is a finite integer number from 3 through 3'])
  })

  test('type assertions erase to claim-free opaque; only as const peels', () => {
    // An assertion is exactly where the checker's word and the runtime value may diverge,
    // so every as/angle cast erases the operand's claims — `true as unknown as number`
    // puts a claim-free value (never a trusted boolean, never a fabricated number) in the
    // slot, and the same holds for every comparability spelling (through {}, Object,
    // unknown[], optional-property collisions — three review rounds each defeated a
    // cleverer carry license before the license was removed outright). The function
    // around a cast still analyzes; what dies is only the path that USES the erased
    // value, honestly. poke analyzes; its write leaves count demoted, so readers keep the
    // declared-kind assumes line and nothing ever claims the slot holds the boolean.
    const report = analyzeSource('module-assertion.ts', `
      let count = 1
      export function poke(flag: number): number {
        if (flag < 5) {
          count = true as unknown as number
        }
        return 0
      }
      export function currentCount(): number {
        return count
      }
      export function sameShape(width: number): number {
        const box = {value: width} as {value: number}
        return box.value
      }
      const msPerStep = 4 as const
      export function stepsFor(durationMs: number): number {
        return Math.max(0, durationMs) / msPerStep
      }
    `)
    expect(analyzedFunction(report, 'poke').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    // The cast erased the record's claims; the read of the opaque stops that path.
    expect(report.functions.find(fn => fn.name === 'sameShape')?.kind).toBe('partial')
    // The scan still counts poke's write, so count keeps only its declared kind.
    const reader = analyzedFunction(report, 'currentCount')
    expect(reader.assumptions).toEqual(['count is finite and not NaN'])
    // TypeScript only permits `as const` on literals, and it narrows the literal to its own
    // literal type, so the value kind never changes; config constants written this way are
    // ordinary code. The exact 4 flowing into the result proves the value passed through.
    const fn = analyzedFunction(report, 'stepsFor')
    expect(fn.assumptions).toEqual([])
    // Dividing by the exact 4 gives a concrete upper bound (largest finite double / 4),
    // which is the proof the const-assertion value flowed through.
    expect(fn.ensures).toEqual(['return is a finite number from 0 through 4.4942328371557893e+307'])
  })

  test('a type-check suppression comment puts the whole file outside the subset', () => {
    // A suppression directive turns off the checker for a line, and every guarantee rests
    // on the checker's word: here a boolean sits in a number binding with no `any` in
    // sight. The directive is interpolated so this test file itself does not carry one.
    const report = analyzeSource('module-suppressed.ts', `
      export function broken(): number {
        // ${'@ts-expect-error'} migration leftover
        let width: number = true
        return width + 1
      }
      export function unrelated(width: number): number {
        return width + 1
      }
    `)
    for (const fn of report.functions) {
      expect(fn.kind).toBe(fn.name === 'module initialization' ? 'partial' : 'unsupported')
    }
    expect(formatReport(report)).toContain('a @ts-ignore, @ts-expect-error, or @ts-nocheck comment turns off type checking')

    const mentionedOnly = analyzeSource('suppression-text.ts', `
      const documentation = '@ts-ignore is a TypeScript directive'
      // // @ts-expect-error disabled during migration
      export function width(): number { return documentation.length }
    `)
    expect(analyzedFunction(mentionedOnly, 'width').ensures)
      .toEqual(['return is a finite integer number from 0 through 9007199254740991'])
  })

  test('records a kind-changing non-null assertion as unsupported', () => {
    const report = analyzeSource('non-null.ts', `
      let maybe: number | null = 5
      export function forced(): number {
        return maybe!
      }
    `)
    const file = 'non-null.ts'
    expect(report.functions.find(fn => fn.name === 'forced')).toEqual({
      kind: 'unsupported',
      name: 'forced',
      unsupported: `a non-null assertion turning number | null into number at ${file}:4:16`,
    })
  })

  test('values typed any carry claim-free; numeric uses stop only the paths that reach them', () => {
    // TypeScript accepts an any-typed value in every position, so a type-checked function
    // can still put a boolean into a number variable. The value carries as opaque — the
    // checker's word is void, so nothing is claimed — and each downstream use hits a
    // gate: arithmetic on it stops the path, an argument to a numeric callee stops at the
    // call, and a bare return publishes no ensures. Each shape below crashed the engine
    // before any-typed values were modeled at all, and rejected wholesale after that.
    const report = analyzeSource('module-any.ts', `
      export function launder(): number {
        const hidden: any = true
        const forced: number = hidden
        return forced + 2
      }
      function double(width: number): number {
        return width * 2
      }
      export function laundersArgument(): number {
        const hidden: any = true
        return double(hidden)
      }
      export function laundersReturn(): number {
        const hidden: any = true
        return hidden
      }
      export function passThrough(width: number): number {
        return width + 1
      }
      export function directAddition(value: any, enabled: boolean): number {
        if (enabled) return value + 1
        return 0
      }
      export function directCompound(value: any, enabled: boolean): number {
        if (enabled) {
          value += 1
          return 1
        }
        return 0
      }
      export function directComparison(value: any, enabled: boolean): number {
        if (enabled && value < 10) return 1
        return 0
      }
      export function directMath(value: any, enabled: boolean): number {
        if (enabled) return Math.abs(value)
        return 0
      }
      export function directIndex(values: number[], index: any, enabled: boolean): number {
        if (enabled) return values[index]!
        return 0
      }
      export function directEquality(left: any, right: any): number {
        return left === right ? 1 : 0
      }
    `)
    // launder's addition and laundersArgument's call both stop on the carried opaque; the
    // stop names the narrowing mismatch, and no numeric claim is published for any of them.
    const launder = report.functions.find(fn => fn.name === 'launder')
    expect(launder?.kind).toBe('partial')
    const laundersArgument = report.functions.find(fn => fn.name === 'laundersArgument')
    expect(laundersArgument?.kind).toBe('partial')
    // A bare return of the carried value completes — with an empty contract.
    expect(analyzedFunction(report, 'laundersReturn').ensures).toEqual([])
    expect(analyzedFunction(report, 'passThrough').ensures).toEqual(['return is a finite number'])
    for (const name of ['directAddition', 'directCompound', 'directComparison', 'directMath', 'directIndex']) {
      const fn = report.functions.find(candidate => candidate.name === name)
      expect(fn?.kind).toBe('partial')
      expect(fn?.kind === 'partial' ? fn.partialReasons : []).toHaveLength(1)
      expect(fn?.kind === 'partial' ? fn.observed : []).toEqual([
        'return is a finite integer number from 0 through 0',
      ])
    }
    expect(analyzedFunction(report, 'directEquality').ensures).toEqual([
      'return is a finite integer number from 0 through 1',
    ])
  })

  test('hedges boolean module reads whose writes the analysis never sees', () => {
    // poison writes a claim-free value into flag, so the scan demotes flag to its declared
    // kind and "return is boolean" stays conditional on the binding actually holding one.
    const report = analyzeSource('module-any-boolean.ts', `
      let flag = false
      export function poison(value: any): void {
        flag = value
      }
      export function readFlag(): boolean {
        return flag
      }
    `)
    const reader = analyzedFunction(report, 'readFlag')
    expect(reader.assumptions).toEqual(['flag is a boolean'])
    expect(reader.ensures).toEqual(['return is boolean'])
  })

  test('records a never-exiting loop whose condition is a ternary', () => {
    // The ternary puts the body/exit branch in a continuation block, not on the tagged loop
    // header, so the detection must recognize the cycle rather than the header's branch.
    const report = analyzeSource('ternary-spin.ts', `
      export function spin(width: number): number {
        for (let index = 0; index < 10 ? true : index >= 0; index += 1) {}
        return 1
      }
    `)
    const file = 'ternary-spin.ts'
    // The width parameter is never read, so no assumes line prints for it: nothing the
    // entry states rests on its trust.
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'spin',
      assumptions: [],
      partialReasons: [`the loop at ${file}:3:9 never exits on any analyzed path`],
      observed: [],
    }])
  })

  test('snaps integer bounds so contradictory refinements cannot strand the evaluation', () => {
    // Without snapping, the first loop's non-strict exit refinement kept index as an
    // integer-flagged [3.2, ...] interval; downstream, the bounds view and the integer view
    // disagreed, a comparison pruned both branch edges, and the analysis crashed with no
    // path end. Snapped, the exit gives index >= 4, and the second loop is correctly
    // recorded as never exiting.
    const report = analyzeSource('integer-snap.ts', `
      export function stall(width: number): number {
        let index = Math.floor(width)
        for (; index < 3.2; index += 1) {}
        for (; 3.4 < index; index -= 0) {}
        if (index < 3.9) return 1
        return 2
      }
    `)
    const file = 'integer-snap.ts'
    expect(report.functions).toEqual([{
      kind: 'partial',
      name: 'stall',
      assumptions: ['width is finite and not NaN'],
      partialReasons: [`the loop at ${file}:5:9 never exits on any analyzed path`],
      observed: [],
    }])
  })

  test('lowers boolean logical operators with short-circuit shape', () => {
    const report = analyzeSource('logical.ts', `
      export function inRange(v: number): boolean {
        return 0 <= v && v <= 100
      }
      export function settled(v: number, target: number): number {
        if (Math.abs(v) < 0.01 && Math.abs(target - v) < 0.01) return 0
        return 1
      }
      export function either(v: number): boolean {
        return !(v > 0) || v > 100
      }
    `)
    expect(analyzedFunction(report, 'inRange').ensures).toEqual(['return is boolean'])
    expect(analyzedFunction(report, 'settled').ensures)
      .toEqual(['return is a finite integer number from 0 through 1'])
    expect(analyzedFunction(report, 'either').ensures).toEqual(['return is boolean'])
  })

  test('lowers object destructuring declarations to property reads', () => {
    const report = analyzeSource('destructure.ts', `
      type Spring = {pos: number; dest: number}
      export function gap(config: Spring): number {
        const {pos, dest: destination} = config
        return Math.abs(destination - pos)
      }
    `)
    const fn = analyzedFunction(report, 'gap')
    expect(fn.assumptions).toEqual([])
    expect(fn.ensures).toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${'destructure.ts'}:5:25)`])
  })

  test('global Infinity remains exact while a local binding can shadow it', () => {
    // `-Infinity` must fold to one constant at lowering: lowered as `0 - Infinity` it would
    // collapse to unknown-including-NaN (interval arithmetic gives up on non-finite
    // operands), and no clamp recovers a possibly-NaN value. With the fold, the clamp
    // recovers an exact range. A local named Infinity shadows the global, same defense as
    // the Math dispatch.
    const report = analyzeSource('infinity.ts', `
      export function clampFromBelow(): number {
        const floor = -Infinity
        return Math.max(0, Math.min(floor, 100))
      }
      export function unbounded(): number {
        return Infinity
      }
      export function shadowed(): number {
        const Infinity = 5
        return Infinity
      }
    `)
    expect(analyzedFunction(report, 'clampFromBelow').ensures).toEqual(['return is a finite integer number from 0 through 0'])
    expect(analyzedFunction(report, 'unbounded').ensures).toEqual(['return is a possibly non-finite number from Infinity through Infinity'])
    expect(analyzedFunction(report, 'shadowed').ensures).toEqual(['return is a finite integer number from 5 through 5'])
  })

  test('publishes module values past skipped top-level statements and demotes what they write', () => {
    const report = analyzeSource('module-skip.ts', `
      const gap = 24
      window.addEventListener('resize', () => {})
      let after = 5
      let poked = 10
      document.title = String(poked = 20)
      export function readGap(): number { return gap }
      export function readAfter(): number { return after }
      export function readPoked(): number { return poked }
    `)
    const file = 'module-skip.ts'
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'module initialization',
      assumptions: [],
      partialReasons: [],
      skipped: [`function call window.addEventListener at ${file}:3:7`],
      observed: [],
    })
    // Bindings around the skipped statements still publish exactly...
    expect(analyzedFunction(report, 'readGap').ensures)
      .toEqual(['return is a finite integer number from 24 through 24'])
    expect(analyzedFunction(report, 'readAfter').ensures)
      .toEqual(['return is a finite integer number from 5 through 5'])
    // ...but a binding the skipped statement writes keeps only its declared kind.
    const poked = analyzedFunction(report, 'readPoked')
    expect(poked.assumptions).toEqual(['poked is finite and not NaN'])
    expect(poked.ensures).toEqual(['return is a finite number'])
  })

  test('does not launder stale values through statements after a skip', () => {
    // The skip demotes scale, but without a slot reset the initializer would keep
    // computing with the stale 1, publishing doubled as exactly 2 while runtime says 6.
    // The havoc at the skip point resets the slot to a truly covering value — NaN
    // included, since the skipped code could have computed anything (e.g.
    // Number.parseFloat) and `doubled` publishes with no assumes line to carry a
    // finiteness condition.
    const report = analyzeSource('module-launder.ts', `
      let scale = 1
      scale = Math.hypot(3, 4)
      const doubled = scale * 2
      export function getDoubled(): number { return doubled }
    `)
    expect(analyzedFunction(report, 'getDoubled').ensures)
      .toEqual(['return is a possibly NaN number from -Infinity through Infinity'])
  })

  test('a floored divisor mints a requirement and a finite quotient', () => {
    // Math.floor is now nameable in requirements, and a floored divisor is an integer, so
    // under the nonzero requirement its magnitude is at least 1 and the quotient is finite.
    const report = analyzeSource('floor-divisor.ts', `
      export function perColumn(width: number, cols: number): number {
        return width / Math.floor(cols)
      }
    `)
    const fn = analyzedFunction(report, 'perColumn')
    expect(requirementsBesidesInputFiniteness(fn))
      .toEqual([`Math.floor(cols) is nonzero (division at ${'floor-divisor.ts'}:3:16)`])
    expect(fn.ensures).toEqual(['return is a finite number'])
  })

  test('platform catalog entries give DOM reads real ranges', () => {
    const report = analyzeSource('platform.ts', `
      export function columnsForViewport(): number {
        const width = document.documentElement.clientWidth
        return Math.max(1, Math.min(7, Math.floor((width - 24) / 244)))
      }
      export function frameBudgetUsed(startMs: number): number {
        return Math.max(0, performance.now() - startMs)
      }
    `)
    // No parameters at all: the 1..7 range is proven entirely from clientWidth's catalog
    // entry (a nonnegative integer).
    expect(analyzedFunction(report, 'columnsForViewport').ensures)
      .toEqual(['return is a finite integer number from 1 through 7'])
    expect(analyzedFunction(report, 'frameBudgetUsed').ensures)
      .toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${'platform.ts'}:7:28)`])
  })

  test('a possibly NaN value keeps the comparison branch NaN takes at runtime', () => {
    // v * 2 - v * 3 can be Infinity - Infinity = NaN; the clamp carries NaN through, and
    // NaN > -1 is false, so the 0 arm is reachable. Interval refinement alone would call
    // the false branch empty ([0,100] refined by <= -1) and wrongly prove the return is 1.
    const report = analyzeSource('nan-branch.ts', `
      export function clampedBranch(v: number): number {
        const x = Math.max(0, Math.min(v * 2 - v * 3, 100))
        return x > -1 ? 1 : 0
      }
    `)
    expect(analyzedFunction(report, 'clampedBranch').ensures)
      .toEqual(['return is a finite integer number from 0 through 1'])
  })

  test('NaN attribution names the operation that introduces NaN, not an earlier overflow', () => {
    const report = analyzeSource('nan-attribution.ts', `
      export function differenceAfterOverflow(left: number, right: number): number {
        const product = left * right
        return product - product
      }
    `)
    expect(analyzedFunction(report, 'differenceAfterOverflow').ensures).toEqual([
      'return is a possibly NaN integer number from 0 through 0 (NaN possible from the operation at nan-attribution.ts:4:16)',
    ])
  })

  test('a refinement that clips to finite bounds also proves finiteness', () => {
    // a * b can overflow, but Infinity fails x < 100, so inside both guards the value is
    // genuinely finite — the wording must not say "possibly non-finite from 0 through 100".
    const report = analyzeSource('finite-narrow.ts', `
      export function narrowed(a: number, b: number): number {
        const x = a * b
        if (x > 0) { if (x < 100) return x }
        return 0
      }
    `)
    // `x < 100` proves less-than: the exact upper bound is the double just below 100,
    // and the prose says so instead of over-covering with 'through 100'.
    expect(analyzedFunction(report, 'narrowed').ensures)
      .toEqual(['return is a finite number at least 0 and less than 100'])
  })

  test('rejects assignments used as values inside larger expressions', () => {
    // Assignments lower only in statement position, so ternary and logical arms are
    // provably assignment-free and their join carries exactly the result. Statement-level
    // if/else assignment stays fully supported.
    const report = analyzeSource('value-assign.ts', `
      export function golf(width: number): number {
        let x = 0
        return width > 5 ? (x = 1) : 2
      }
      export function statement(width: number): number {
        let result = 10
        if (width > 10) result = width
        return result
      }
    `)
    const file = 'value-assign.ts'
    expect(report.functions.find(fn => fn.name === 'golf')).toEqual({
      kind: 'unsupported',
      name: 'golf',
      unsupported: `an assignment used as a value (write it as its own statement) at ${file}:4:29`,
    })
    expect(analyzedFunction(report, 'statement').ensures)
      .toEqual(['return is a finite number at least 10'])
  })

  test('object spread rejects; explicit-field rebuilding analyzes', () => {
    const report = analyzeSource('spread.ts', `
      type Spring = {pos: number; dest: number; v: number}
      export function settleSpread(s: Spring): Spring {
        return {...s, pos: s.dest, v: 0}
      }
      export function settleExplicit(s: Spring): Spring {
        return {pos: s.dest, dest: s.dest, v: 0}
      }
      export function localSpread(): number {
        const defaults = {width: 300, height: 200}
        const sized = {...defaults, width: 150}
        return sized.width + sized.height
      }
    `)
    expect(report.functions.find(candidate => candidate.name === 'settleSpread')?.kind).toBe('unsupported')
    expect(report.functions.find(candidate => candidate.name === 'localSpread')?.kind).toBe('unsupported')
    expect(formatReport(report)).toContain('object spread (list every field explicitly')
    expect(analyzedFunction(report, 'settleExplicit').ensures).toEqual([
      'return.pos is a finite number',
      'return.dest is a finite number',
      'return.v is a finite integer number from 0 through 0',
    ])
  })

  test('rejects in-operator narrowing over record unions', () => {
    // Width subtyping permits a value of the second variant to carry an extra x property,
    // so runtime presence cannot prove which declared variant the value inhabits.
    const report = analyzeSource('in-check.ts', `
      type Route = {type: 'withX'; x: number} | {type: 'withoutX'; y: number}
      export function readX(route: Route): number {
        if ('x' in route) return route.x
        return 0
      }
    `)
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'readX',
      unsupported: 'the `in` operator (use a distinct string or boolean tag when property presence distinguishes union variants) at in-check.ts:4:13',
    }])
  })

  test('carries a module read assumption to callers of the reading function', () => {
    const report = analyzeSource('module-assumption-chain.ts', `
      let scaleFactor = 2
      export function bumpScale(): void {
        scaleFactor = scaleFactor + 1
      }
      function currentScale(): number {
        return scaleFactor
      }
      export function scaledUp(): number {
        return Math.max(1, currentScale())
      }
    `)
    // scaledUp never reads scaleFactor itself, but its result rests on currentScale's
    // assumed-finite read; without the line its ensures would overclaim finiteness.
    const reader = analyzedFunction(report, 'currentScale')
    expect(reader.assumptions).toEqual(['scaleFactor is finite and not NaN'])
    expect(reader.ensures).toEqual(['return is a finite number'])
    const caller = analyzedFunction(report, 'scaledUp')
    expect(caller.assumptions).toEqual(['scaleFactor is finite and not NaN'])
    expect(caller.ensures).toEqual(['return is a finite number at least 1'])
  })

  test('reads imported const numeric literals exactly; other imports still stop', () => {
    const importsFixture = new URL('./fixtures/module-imports.ts', import.meta.url).pathname
    const importsReportPath = 'tests/fixtures/module-imports.ts'
    const report = analyzeFile(importsFixture)
    expect(report.functions).toEqual([{
      // importedPad resolves to `export const importedPad = 7` in the helper file, so the
      // read carries exactly 7 instead of stopping — no assumes line about importedPad.
      kind: 'analyzed',
      name: 'paddedBy',
      assumptions: [],
      requires: [`Number.isFinite(width) (input at ${importsReportPath}:4:26)`],
      ensures: ['return is a finite number at least 7'],
    }, {
      // importedOffset is a `let` export the other module can reassign; still a stop.
      kind: 'partial',
      name: 'shiftedBy',
      assumptions: ['width is finite and not NaN'],
      partialReasons: [`reads importedOffset, which is imported from another module (read at ${importsReportPath}:10:18)`],
      observed: [],
    }])
  })

  test('converges on a numeric for loop without unrolling it', () => {
    const report = analyzeSource('numeric-loop.ts', `
      function increment(state: {value: number}): {value: number} {
        return {value: state.value + 1}
      }

      export function iterationsBeforeLimit(limit: number): number {
        let iteration = 0
        for (; iteration < limit; iteration += 1) {}
        return iteration
      }

      export function updatesBeforeLimit(limit: number): number {
        let state = {value: 0}
        for (let iteration = 0; iteration < limit; iteration++) state = increment(state)
        return state.value
      }
    `)
    expect(analyzedFunction(report, 'iterationsBeforeLimit').ensures)
      .toEqual(['return is a finite integer number at least 0'])
    expect(analyzedFunction(report, 'updatesBeforeLimit').ensures)
      .toEqual(['return is a finite integer number at least 0'])
  })
})
