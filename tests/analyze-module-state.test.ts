import {describe, expect, test} from 'bun:test'
import {analyzeSource, formatReport} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

describe('module state and nullability', () => {
  test('flows exact module constants into functions', () => {
    const report = analyzeSource('module-constants.ts', `
      const boxesGapX = 24
      const debugMode = false
      export function paddedWidth(width: number): number {
        return Math.max(0, width) + boxesGapX
      }
      export function debugOffset(): number {
        if (debugMode) return 1
        return 0
      }
    `)
    // "at least 24" proves the exact 24 flowed in: a declared-kind-only read would have
    // contributed an arbitrary finite number and destroyed the lower bound.
    const padded = analyzedFunction(report, 'paddedWidth')
    expect(padded.assumptions).toEqual([])
    expect(padded.ensures).toEqual(['return is a finite number at least 24'])
    // The exact `false` prunes the true branch entirely.
    expect(analyzedFunction(report, 'debugOffset').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    // A fully analyzed initializer gets no report entry.
    expect(report.functions.map(fn => fn.name)).toEqual(['paddedWidth', 'debugOffset'])
  })

  test('publishes flat and nested module records exactly', () => {
    const report = analyzeSource('module-record.ts', `
      const gridSize = {cols: 8, rows: 6}
      const config = {margins: {left: 4, right: 12}, snap: true}
      export function cellCount(): number {
        return gridSize.cols * gridSize.rows
      }
      export function leftEdge(): number {
        return config.margins.left
      }
    `)
    // The exact 48 proves the record's property values flowed in, not just its shape; and
    // a trusted exact value needs no assumption line.
    expect(analyzedFunction(report, 'cellCount').ensures)
      .toEqual(['return is a finite integer number from 48 through 48'])
    // Module state is a tree of records hanging off roots; publishing reaches the leaves.
    expect(analyzedFunction(report, 'leftEdge').ensures)
      .toEqual(['return is a finite integer number from 4 through 4'])
  })

  test('keeps only the declared shape of a module record that a function rebinds', () => {
    const report = analyzeSource('module-record-written.ts', `
      let pointer = {x: 0, y: 0}
      export function movePointer(newX: number): void {
        pointer = {x: newX, y: pointer.y}
      }
      export function pointerX(): number {
        return pointer.x
      }
    `)
    // The record analog of the scalar declared-kind hedge: per-property assumption lines,
    // and the read gives some finite number instead of the initializer's exact 0.
    const reader = analyzedFunction(report, 'pointerX')
    expect(reader.assumptions).toEqual([
      'pointer.x is finite and not NaN',
      'pointer.y is finite and not NaN',
    ])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('a module record rebound by a skipped statement keeps only its declared shape', () => {
    // The rebind's right-hand side does not lower, so the statement is skipped — and the
    // binding must stop publishing its initializer's exact value, or the skip would launder
    // a stale 2 into every reader.
    const report = analyzeSource('module-record-skip.ts', `
      let scale = {factor: 2}
      scale = {factor: window.devicePixelRatio}
      export function scaledBy(width: number): number {
        return Math.min(width, scale.factor)
      }
    `)
    const reader = analyzedFunction(report, 'scaledBy')
    expect(reader.assumptions).toEqual([
      'scale.factor is finite and not NaN',
    ])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('a skipped statement resets scalars only when it can run code that writes them', () => {
    const inertWrite = analyzeSource('module-inert-write.ts', `
      let value = 1
      function changeValue(): void { value = Infinity }
      document.title = 'Gallery'
      const doubled = value * 2
      export function readDoubled(): number { return doubled }
    `)
    expect(analyzedFunction(inertWrite, 'readDoubled').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])

    const unknownCall = analyzeSource('module-unknown-call.ts', `
      let value = 1
      function changeValue(): void { value = Infinity }
      console.log('ready')
      const doubled = value * 2
      export function readDoubled(): number { return doubled }
    `)
    expect(analyzedFunction(unknownCall, 'readDoubled').ensures[0]).toContain('possibly NaN')

    const directWrite = analyzeSource('module-direct-write.ts', `
      let changed = 2
      let untouched = 3
      function changeUntouched(): void { untouched = Infinity }
      changed **= 3
      const changedResult = changed * 2
      const untouchedResult = untouched * 2
      export function readChanged(): number { return changedResult }
      export function readUntouched(): number { return untouchedResult }
    `)
    expect(analyzedFunction(directWrite, 'readChanged').ensures[0]).toContain('possibly NaN')
    expect(analyzedFunction(directWrite, 'readUntouched').ensures)
      .toEqual(['return is a finite integer number from 6 through 6'])
  })

  test('creating functions defers their bodies, while iterators and computed names run now', () => {
    for (const [file, declaration] of [
      ['module-arrow.ts', 'const callback = (): void => { value = Infinity }'],
      ['module-default-function.ts', 'export default function () { value = Infinity }'],
      ['module-method.ts', 'const holder = {run(): void { value = Infinity }}'],
    ] as const) {
      const report = analyzeSource(file, `
        let value = 1
        ${declaration}
        const doubled = value * 2
        export function readDoubled(): number { return doubled }
      `)
      expect(analyzedFunction(report, 'readDoubled').ensures)
        .toEqual(['return is a finite integer number from 2 through 2'])
    }

    const iterator = analyzeSource('module-iterator.ts', `
      let value = 1
      function changeValue(): void { value = Infinity }
      let first: number | undefined
      const source = {*[Symbol.iterator]() { changeValue(); yield 1 }}
      const before = value * 2
      ;[first] = source
      const after = value * 2
      export function readBefore(): number { return before }
      export function readAfter(): number { return after }
    `)
    expect(analyzedFunction(iterator, 'readBefore').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])
    expect(analyzedFunction(iterator, 'readAfter').ensures[0]).toContain('possibly NaN')

    const computedName = analyzeSource('module-computed-name.ts', `
      let value = 1
      function changeValue(): string { value = Infinity; return 'run' }
      const holder = {[changeValue()](): void {}}
      const doubled = value * 2
      export function readDoubled(): number { return doubled }
    `)
    expect(analyzedFunction(computedName, 'readDoubled').ensures[0]).toContain('possibly NaN')
  })

  test('module arrays publish exactly in fully analyzed files, hedge otherwise', () => {
    const report = analyzeSource('module-array.ts', `
      const items = [3, 5]
      export function itemCount(): number {
        return items.length
      }
    `)
    expect(analyzedFunction(report, 'itemCount').ensures)
      .toEqual(['return is a finite integer number from 2 through 2'])
    // With unanalyzed code in the file, the array — alias-mutable at runtime like any
    // record — falls back to its declared shape.
    const hedged = analyzeSource('module-array-hedged.ts', `
      const items = [3, 5]
      export function mutateSomehow(): void {
        items.push(7)
      }
      export function itemCount(): number {
        return items.length
      }
    `)
    const reader = hedged.functions.find(fn => fn.name === 'itemCount')
    expect(reader?.kind).toBe('analyzed')
    expect(reader?.kind === 'analyzed' ? reader.assumptions : []).toEqual([
      'items is a plain array — its length counts its elements, and every index below the length holds an element',
      'every items element is finite and not NaN',
    ])
  })

  test('exact record publishing requires a fully analyzed file', () => {
    // Analyzed code cannot write into an object, but rejected function bodies run at
    // runtime too and can mutate a record through an alias the write scan cannot see,
    // e.g. Object.assign(gridSize, ...) — the binding sits in argument position, not
    // write position. With any unanalyzed code in the file, records fall back to the
    // declared-shape hedge. Scalars are copied on read, so gap keeps its exact value.
    const report = analyzeSource('module-record-gate.ts', `
      const gridSize = {cols: 8, rows: 6}
      const gap = 24
      export function mutateSomehow(): void {
        Object.assign(gridSize, {cols: 1})
      }
      export function cellCount(): number {
        return gridSize.cols * gridSize.rows
      }
      export function readGap(): number {
        return gap
      }
    `)
    const reader = analyzedFunction(report, 'cellCount')
    expect(reader.assumptions).toEqual([
      'gridSize.cols is finite and not NaN',
      'gridSize.rows is finite and not NaN',
    ])
    expect(reader.ensures).toEqual([`return is a possibly non-finite number from -Infinity through Infinity (can overflow at ${'module-record-gate.ts'}:8:16)`])
    expect(analyzedFunction(report, 'readGap').ensures)
      .toEqual(['return is a finite integer number from 24 through 24'])
  })

  test('rejects unions whose same-named property mixes kinds', () => {
    // The union shape gate compares property kinds, not just names: admitting
    // {value: number} | {value: boolean} would let a spread or a narrowed read reach the
    // property the record join has to drop.
    const report = analyzeSource('mixed-kind-property.ts', `
      export function mix(steps: number): number {
        const toggle = steps > 0 ? {value: 1} : {value: true}
        return steps
      }
    `)
    const file = 'mixed-kind-property.ts'
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'mix',
      unsupported: `value of type { value: number; } | { value: boolean; } at ${file}:3:24`,
    }])
  })

  test('joins of wide return values drop a kind-mismatched extra property instead of crashing', () => {
    // Width subtyping lets both wide literals return where {x: number} is declared; the
    // two records meet at the return join with y carrying different kinds. The declared
    // return type never exposes y, so the join drops it and every readable property
    // survives.
    const report = analyzeSource('wide-return-join.ts', `
      export function pick(flag: number): {x: number} {
        const wideA = {x: 1, y: 2}
        const wideB = {x: 3, y: true}
        if (flag > 0) return wideA
        return wideB
      }
    `)
    const picked = analyzedFunction(report, 'pick')
    expect(picked.ensures).toEqual(['return.x is a finite integer number from 1 through 3'])
  })

  test('optional properties read and fill as maybe-undefined values', () => {
    // session?: boolean reads as boolean | undefined — exactly what the missing-value
    // machinery models. Object literals fill omitted optionals with an explicit undefined
    // (so `omitted` proves exactly 5 through the ?? fallback), and the assumes prose
    // carries the honest condition. Sound
    // even when exactOptionalPropertyTypes is disabled: ordinary reads cannot distinguish
    // absence from explicit undefined, while supported presence checks stay conservative.
    const report = analyzeSource('optional-properties.ts', `
      type Config = {gain: number; volume?: number}
      export function effectiveVolume(): number {
        const merged: Config = {gain: 1}
        return merged.gain
      }
      export function readOptional(config: Config): number {
        return config.volume ?? 10
      }
      export function omitted(): number {
        const config: Config = {gain: 2}
        return config.volume ?? 5
      }
    `)
    expect(analyzedFunction(report, 'effectiveVolume').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
    // readOptional never reads config.gain, so no gain line prints; the optional
    // property it does read carries the honest undefined disjunct.
    expect(analyzedFunction(report, 'readOptional').assumptions).toEqual([
      'config.volume is undefined or a finite non-NaN number',
    ])
    expect(analyzedFunction(report, 'readOptional').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'omitted').ensures).toEqual(['return is a finite integer number from 5 through 5'])
  })

  test('optional properties inside tagged-union variants classify too', () => {
    const report = analyzeSource('optional-variant.ts', `
      type Route = {type: 'style-creator'; scroll?: number} | {type: 'home'; scroll: number}
      export function scrollOf(route: Route): number {
        if (route.type === 'home') return route.scroll
        return route.scroll ?? 0
      }
    `)
    expect(analyzedFunction(report, 'scrollOf').assumptions)
      .toEqual([
        "route.scroll is undefined or a finite non-NaN number (when route.type is 'style-creator')",
        "route.scroll is finite and not NaN (when route.type is 'home')",
      ])
    expect(analyzedFunction(report, 'scrollOf').ensures).toEqual(['return is a finite number'])
  })

  test('a recursive generic module type stays opaque instead of crashing the shape walk', () => {
    // Every level of Nested<T> is a fresh instantiation, so a seen-set alone cannot
    // recognize the recursion; the depth cap stops the walk (and the checker's
    // instantiation chain) and the binding stays opaque.
    const report = analyzeSource('recursive-generic.ts', `
      type Nested<T> = {value: number; inner: Nested<{deeper: T}>}
      let chain: Nested<number> | null = null
      export function probe(): number {
        return 1
      }
    `)
    expect(analyzedFunction(report, 'probe').ensures)
      .toEqual(['return is a finite integer number from 1 through 1'])
  })

  test('a skip havocs every record binding, closing argument-position mutation', () => {
    // Object.assign(config, ...) holds the binding in argument position — no write-position
    // mention anywhere, and an alias variant mentions the binding nowhere at all — so no
    // mention scan is sound for records. Every record binding resets to covering values at
    // the skip; the derived scalar honestly reports the NaN the skipped call could produce.
    const report = analyzeSource('module-record-argument-write.ts', `
      type Config = {zoom: number}
      let config: Config = {zoom: 1}
      Object.assign(config, {zoom: Number.NaN})
      const doubled = config.zoom * 2
      export function readDoubled(): number {
        return doubled
      }
    `)
    expect(analyzedFunction(report, 'readDoubled').ensures)
      .toEqual(['return is a possibly NaN number from -Infinity through Infinity'])
  })

  test('untagged record unions reject even when their shapes match', () => {
    // A record union needs a string or boolean tag. Without one, separately declared
    // members reject whether their shapes differ or happen to match. Code with one shared
    // shape can state that directly, e.g. {mode: 1 | 2} instead of
    // {mode: 1} | {mode: 2}.
    const report = analyzeSource('union-shapes.ts', `
      type Loaded = {status: string; data: {metrics: {width: number}}}
      type Failed = {status: string; data: {metrics: {code: number}}}
      export function measure(loadedCount: number): number {
        const state: Loaded | Failed = loadedCount > 0
          ? {status: 'loaded', data: {metrics: {width: 640}}}
          : {status: 'failed', data: {metrics: {code: 404}}}
        return loadedCount
      }
      type Speed = {mode: 1} | {mode: 2}
      export function speedMode(fast: number): number {
        const speed: Speed = fast > 0 ? {mode: 1} : {mode: 2}
        return speed.mode + 1
      }
    `)
    expect(report.functions.find(candidate => candidate.name === 'measure')?.kind).toBe('unsupported')
    expect(report.functions.find(candidate => candidate.name === 'speedMode')?.kind).toBe('unsupported')
  })

  test('a declaration-file-typed property remains an opaque leaf', () => {
    // Project records can contain foreign types such as HTMLDivElement. The foreign value
    // carries no claims, while the record's own numeric properties remain analyzable.
    const report = analyzeSource('dom-leaf-shape.ts', `
      type Spring = {pos: number, dest: number}
      type Box = {id: string, x: Spring, node: HTMLDivElement}
      export function hitTest(data: Box[], pointerX: number): number | null {
        for (let i = 0; i < data.length; i++) {
          const {x} = data[i]!
          if (x.dest <= pointerX) { return i }
        }
        return null
      }
    `)
    expect(analyzedFunction(report, 'hitTest').ensures)
      .toEqual(['return is null or a finite integer number from 0 through 4294967294'])
  })

  test('rejects reads of inherited prototype members', () => {
    // toString type-checks on every object literal, but the record value carries only its
    // own properties; the callable type fails the value-kind gate.
    const report = analyzeSource('prototype-member.ts', `
      export function labelledX(x: number): number {
        const point = {x}
        const stringify = point.toString
        return point.x
      }
    `)
    const file = 'prototype-member.ts'
    expect(report.functions).toEqual([{
      kind: 'unsupported',
      name: 'labelledX',
      unsupported: `read of the inherited prototype member toString (records carry only their own data properties) at ${file}:4:27`,
    }])
  })

  test('an anonymous default export function is a recorded skip, not invisible code', () => {
    // Named function declarations become report entries; an anonymous export default has
    // no name to collect under, so it must fall through to a recorded initializer skip —
    // otherwise its body would be runtime code no publish gate accounts for, and appZoom
    // would publish its exact initial value while the body mutates it.
    const report = analyzeSource('anonymous-default.ts', `
      const appZoom = {level: 5}
      export function currentZoom(): number {
        return appZoom.level
      }
      export default function () {
        Object.assign(appZoom, {level: 999})
      }
    `)
    const reader = analyzedFunction(report, 'currentZoom')
    expect(reader.assumptions).toEqual(['appZoom.level is finite and not NaN'])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('rejects the constructs whose checker word the analysis cannot confirm', () => {
    // Four gates from one review round: a type predicate is the checker taking the
    // author's word (a lying one exposes properties the value never carries); an async
    // body's runtime result is a Promise, not its return value; `{}` is inhabited by
    // every non-null value, numbers included, so it is not a record shape; and __proto__
    // in a literal sets the prototype rather than creating a property.
    const report = analyzeSource('checker-word.ts', `
      type Circle = {kind: number; radius: number}
      export function isCircle(shape: {kind: number}): shape is Circle {
        return shape.kind > 0
      }
      export async function fetchDelay(): Promise<number> {
        return 16
      }
      export function chooseMarker(flag: number): number {
        const marker: {} = 5
        return flag
      }
      export function protoDepth(): number {
        const carrier = {__proto__: {depth: 7}}
        return 0
      }
    `)
    const formatted = formatReport(report)
    expect(formatted).toContain('a type predicate (the checker takes the predicate on faith; return a plain boolean and check properties where they are read)')
    expect(formatted).toContain("an async or generator function (the runtime result is a Promise or iterator, not the body's return value)")
    expect(formatted).toContain('value of type {}')
    expect(formatted).toContain('a property named __proto__ (prototype-setting syntax at runtime, not a data property)')
  })

  test('the parameter gate classifies through valueKind', () => {
    // One definition of every kind across gates: a 1 | 2 discriminant property is a
    // number in a parameter exactly as at the declarator, and an index-signature
    // parameter type rejects instead of seeding a record the type licenses more reads
    // against than it carries (the destructured read of `latency` would crash the engine).
    const report = analyzeSource('parameter-kinds.ts', `
      export function modeOf(zoom: {mode: 1 | 2}): number {
        return zoom.mode
      }
      export function readGauge(board: {base: number; [gauge: string]: number}): number {
        return board.base
      }
    `)
    expect(analyzedFunction(report, 'modeOf').assumptions)
      .toEqual(['zoom.mode is a finite integer number from 1 through 2'])
    expect(analyzedFunction(report, 'modeOf').ensures)
      .toEqual(['return is a finite integer number from 1 through 2'])
    const gauge = report.functions.find(candidate => candidate.name === 'readGauge')
    expect(gauge?.kind).toBe('unsupported')

    const reset = analyzeSource('literal-union-reset.ts', `
      let mode: 1 | 2 = 1
      mode = JSON.parse('100')
      const result = mode * 10
      export function readResult(): number { return result }
    `)
    expect(analyzedFunction(reset, 'readResult').ensures[0]).toContain('possibly NaN')
  })

  test('the false branch of a comparison with a possibly-NaN operand refines nothing', () => {
    // NaN fails every comparison, so the false branch is also where a NaN operand lands —
    // with the OTHER operand unconstrained. clampedTarget keeps mayBeNaN through the clamp
    // (scale * scale * dt can be Infinity * 0), so narrowing pointerX to "at least 10" in
    // the else branch would be contradicted by follow(-5, 1e308, 0) === -5 at runtime.
    const report = analyzeSource('nan-false-branch.ts', `
      export function follow(pointerX: number, scale: number, dt: number): number {
        const clampedTarget = Math.max(10, Math.min(scale * scale * dt, 20))
        if (pointerX < clampedTarget) return 10
        return pointerX
      }
    `)
    expect(analyzedFunction(report, 'follow').ensures).toEqual(['return is a finite number'])
  })

  test('null checks narrow, and compound guards narrow through the short-circuit', () => {
    // `maybe !== null && maybe > 3` lowers as two chained branches sharing the false
    // target, so each check refines on its own — the inline guard narrows exactly like
    // the nested-if spelling.
    const report = analyzeSource('nullish-guard.ts', `
      export function doubled(maybe: number | null): number {
        if (maybe !== null && maybe > 3) {
          return maybe * 2
        }
        return 0
      }
    `)
    const fn = analyzedFunction(report, 'doubled')
    expect(fn.assumptions).toEqual(['maybe is null or a finite non-NaN number'])
    expect(fn.ensures).toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${'nullish-guard.ts'}:4:18)`])
  })

  test('narrowing a property read sticks across re-reads of the same property', () => {
    // The refinement writes the narrowed value back through the producer chain into the
    // record — sound because values are immutable, so the property cannot differ between
    // the checked read and the next one.
    const report = analyzeSource('nullish-property.ts', `
      export function pick(seed: number): number {
        const point = {x: seed > 0 ? null : 5}
        if (point.x !== null) {
          return point.x + 1
        }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures)
      .toEqual(['return is a finite integer number from 0 through 6'])
  })

  test('strict null checks consult the possible sentinels', () => {
    // `values !== null` on number | undefined can never be false at runtime (undefined
    // !== null is true), so the else branch is pruned and the result is exactly 0.
    const report = analyzeSource('nullish-matrix.ts', `
      export function fromIndex(values: number | undefined): number {
        if (values !== null) {
          return 0
        }
        return 1
      }
      export function looseClears(value: number | undefined): number {
        return value == null ? 16 : value * 1
      }
    `)
    expect(analyzedFunction(report, 'fromIndex').assumptions)
      .toEqual(['values is undefined or a finite non-NaN number'])
    expect(analyzedFunction(report, 'fromIndex').ensures)
      .toEqual(['return is a finite integer number from 0 through 0'])
    // Loose == null tests both sentinels, so the false arm is a plain number.
    expect(analyzedFunction(report, 'looseClears').ensures)
      .toEqual(['return is a finite number'])
  })

  test('?? takes the value or the fallback, exactly', () => {
    const report = analyzeSource('nullish-coalesce.ts', `
      export function clampedStart(animatedUntilTime: number | null): number {
        const start = animatedUntilTime ?? 16
        return Math.max(0, Math.min(start, 100))
      }
      export function mixedArms(seed: number): number {
        const grid = seed > 0 ? null : {cols: 3}
        const chosen = grid ?? 0
        return 1
      }
    `)
    expect(analyzedFunction(report, 'clampedStart').ensures)
      .toEqual(['return is a finite number from 0 through 100'])
    // ?? whose arms mix kinds (record vs number) rejects at the type gate.
    const mixed = report.functions.find(fn => fn.name === 'mixedArms')
    expect(mixed?.kind).toBe('unsupported')
  })

  test('a narrowing shape the analysis does not model stops the path honestly', () => {
    // A claim-free opaque (here from a kind-changing cast) flowing into arithmetic is a
    // narrowing the analysis does not model — the backstop records a stop instead of
    // crashing the run, and the sibling function still reports. (The previous fixture
    // used a ternary with an &&-joined guard, which lowers through the statement-if
    // branching now and analyzes fully.)
    const report = analyzeSource('nullish-backstop.ts', `
      export function carriedOpaque(value: unknown, flag: boolean): number {
        let n = 1
        if (flag) { n = value as number }
        return n * 2
      }
      export function healthy(x: number): number {
        return x + 1
      }
      export function ternaryGuard(maybe: number | null): number {
        return maybe !== null && maybe > 3 ? maybe * 2 : 0
      }
    `)
    const file = 'nullish-backstop.ts'
    expect(report.functions[0]).toEqual({
      kind: 'partial',
      name: 'carriedOpaque',
      assumptions: ['flag is a boolean'],
      partialReasons: [`uses a value whose runtime kind the analysis cannot establish (at ${file}:5:16)`],
      // The branches merge before the multiply, and the joined n is opaque, so both
      // paths stop there — no completed return remains to report as evidence.
      observed: [],
    })
    expect(analyzedFunction(report, 'healthy').ensures).toEqual(['return is a finite number'])
    // The ternary's compound guard short-circuits like the statement spelling, so both
    // conjuncts refine the true arm: the null check discharges and maybe > 3 bounds the
    // multiplication (which can still overflow at the finite extremes).
    expect(analyzedFunction(report, 'ternaryGuard').ensures)
      .toEqual([`return is a possibly non-finite number from 0 through Infinity (can overflow at ${file}:11:46)`])
  })

  test('nullish module bindings seed their declared kind with sentinel prose', () => {
    const report = analyzeSource('nullish-module.ts', `
      let animatedUntilTime: number | null = null
      export function frame(now: number): void {
        animatedUntilTime = now
      }
      export function readIt(): number {
        return animatedUntilTime ?? 16
      }
    `)
    const reader = analyzedFunction(report, 'readIt')
    expect(reader.assumptions).toEqual(['animatedUntilTime is null or a finite non-NaN number'])
    expect(reader.ensures).toEqual(['return is a finite number'])
  })

  test('a read module binding keeps all its lines; an unread one contributes nothing', () => {
    // Module bindings filter at whole-binding granularity: a callee's reads reach the
    // caller as a binding ID with no path detail, so a read binding keeps every line —
    // ratioOnly reads only viewport.ratio yet prints the width line too. An unread
    // binding supports no claim and prints nothing, like an unread parameter.
    const report = analyzeSource('binding-read-filter.ts', `
      let viewport = {width: 800, ratio: 2}
      export function resize(width: number): void {
        viewport = {width, ratio: 2}
      }
      export function ratioOnly(x: number): number {
        return x * viewport.ratio
      }
      export function ignoresViewport(x: number): number {
        return x * 2
      }
    `)
    expect(analyzedFunction(report, 'ratioOnly').assumptions).toEqual([
      'viewport.width is finite and not NaN',
      'viewport.ratio is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'ignoresViewport').assumptions).toEqual([])
  })

})
