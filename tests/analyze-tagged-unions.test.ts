import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

describe('tagged unions and narrowing', () => {
  test('tagged unions: checks narrow, else-if chains prune, switch dispatches, literals build variants', () => {
    // A union of record shapes told apart by route.type carries one record per variant.
    // Tag checks keep matching variants per branch; a single-variant union stays a union,
    // so later checks against other tags are definitely false and dead branches prune —
    // by the third arm of the chain, route is provably the lightbox shape and its index
    // reads. Literals remember which variant they build, so branches building different
    // variants join per tag and callers narrow them back apart.
    const report = analyzeSource('tagged-unions.ts', `
      type Route =
        | {type: 'explore'; filter: string}
        | {type: 'lightbox'; id: string; index: number}
        | {type: 'archive'; page: number}
      export function elseIfChain(route: Route): number {
        if (route.type === 'explore') { return 1 }
        if (route.type === 'archive') { return route.page }
        return route.index
      }
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      export function pick(wide: boolean): Frame {
        if (wide) { return {type: 'sidebar', width: 240} }
        return {type: 'mobile', scale: 0.5}
      }
      export function useIt(wide: boolean): number {
        const frame = pick(wide)
        if (frame.type === 'sidebar') { return frame.width }
        return frame.scale * 100
      }
      export function switchOnTag(frame: Frame): number {
        switch (frame.type) {
          case 'sidebar': return frame.width
          default: return frame.scale
        }
      }
      export function total(frames: Frame[]): number {
        let sum = 0
        for (const frame of frames) {
          if (frame.type === 'sidebar') { sum = sum + frame.width }
        }
        return sum
      }
    `)
    expect(analyzedFunction(report, 'elseIfChain').assumptions).toEqual([
      "route.index is finite and not NaN (when route.type is 'lightbox')",
      "route.page is finite and not NaN (when route.type is 'archive')",
    ])
    expect(analyzedFunction(report, 'elseIfChain').ensures).toEqual(['return is a finite number'])
    // The two variants' exact constants survive the join and re-split at the caller.
    expect(analyzedFunction(report, 'useIt').ensures).toEqual(['return is a finite integer number from 50 through 240'])
    expect(analyzedFunction(report, 'switchOnTag').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'pick').ensures).toEqual([
      "return.type is 'sidebar' or 'mobile'",
      "return.width is a finite integer number from 240 through 240 (when return.type is 'sidebar')",
      "return.scale is a finite number from 0.5 through 0.5 (when return.type is 'mobile')",
    ])
    expect(analyzedFunction(report, 'total').assumptions).toEqual([
      'frames is a plain array — its length counts its elements, and every index below the length holds an element',
      "frames[each].width is finite and not NaN (when frames[each].type is 'sidebar')",
      "frames[each].scale is finite and not NaN (when frames[each].type is 'mobile')",
    ])
  })

  test('tagged unions: nullable wrappers carry them, and nesting mirrors the type tree', () => {
    const report = analyzeSource('nullable-tagged.ts', `
      type Owner = {type: 'explore'; page: number} | {type: 'imagine'; count: number}
      type Lightbox = {type: 'lightbox'; index: number; owner: null | Owner}
      export function ownerPage(box: Lightbox): number {
        const owner = box.owner
        if (owner === null) { return box.index }
        if (owner.type === 'explore') { return owner.page }
        return owner.count
      }
    `)
    // box.owner is nullish-wrapped, and nullish subtrees never fold (their lines carry
    // the null caveat the folded assertion cannot), so only box.index counts toward the
    // fold threshold and every line stays exact.
    expect(analyzedFunction(report, 'ownerPage').assumptions).toEqual([
      "box.owner is null or box.owner.page is finite and not NaN (when box.owner.type is 'explore')",
      "box.owner is null or box.owner.count is finite and not NaN (when box.owner.type is 'imagine')",
    ])
    expect(analyzedFunction(report, 'ownerPage').ensures).toEqual(['return is a finite number'])
  })

  test('tagged unions: boolean tags and literal-union tags dispatch like string tags', () => {
    // The Result pattern (`ok: true` / `ok: false`) and a variant whose tag is a union of
    // literals both count as discriminants now. A multi-literal tag expands into one
    // variant per literal sharing the record shape, so the check machinery only ever sees
    // single-literal tags; `if (result.ok)` narrows like `result.ok === true`, and the
    // negated and strict-compare spellings narrow too. The tag property contributes no
    // line of its own — the `(when ...)` qualifier already pins it.
    const report = analyzeSource('near-miss-tags.ts', `
      type Parsed = {ok: true; value: number} | {ok: false; code: number}
      export function unwrapOr(result: Parsed, fallback: number): number {
        if (result.ok) { return result.value }
        return fallback
      }
      export function negated(result: Parsed): number {
        if (!result.ok) { return result.code }
        return 0
      }
      export function makeBoth(raw: number): Parsed {
        if (raw > 0) { return {ok: true, value: raw} }
        return {ok: false, code: 400}
      }
      type Nav =
        | {type: 'desktopCollapsedNav' | 'desktopExpandedNav'; navWidth: number}
        | {type: 'mobileNav'; sheetHeight: number}
      export function navSpace(nav: Nav): number {
        switch (nav.type) {
          case 'desktopCollapsedNav': return nav.navWidth
          case 'desktopExpandedNav': return nav.navWidth
          case 'mobileNav': return nav.sheetHeight
        }
      }
    `)
    // unwrapOr reads result.value but never result.code, so only the value line prints;
    // the tag property contributes no line of its own either way.
    expect(analyzedFunction(report, 'unwrapOr').assumptions).toEqual([
      'result.value is finite and not NaN (when result.ok is true)',
    ])
    expect(analyzedFunction(report, 'negated').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'makeBoth').ensures).toEqual([
      'return.ok is true or false',
      'return.value is a finite number more than 0 (when return.ok is true)',
      'return.code is a finite integer number from 400 through 400 (when return.ok is false)',
    ])
    // Tagged unions never fold: the qualified lines scope each assumption to its
    // variant, which one folded line cannot express.
    expect(analyzedFunction(report, 'navSpace').assumptions).toEqual([
      "nav.navWidth is finite and not NaN (when nav.type is 'desktopCollapsedNav')",
      "nav.navWidth is finite and not NaN (when nav.type is 'desktopExpandedNav')",
      "nav.sheetHeight is finite and not NaN (when nav.type is 'mobileNav')",
    ])
  })

  test('casts cannot launder tag claims or stale aliases through joins', () => {
    // Three counterexamples from one round. (1) `true as {} as number` is diagnostic-clean
    // TypeScript (comparability through {}), so the erasure rule must not trust "cross-kind
    // casts go through as-unknown" — any kind-CHANGING cast erases to opaque now, and the
    // laundered write joins instead of crashing. (2) Two variants sharing a tag value
    // (here from the boolean expansion) must not publish each other's exclusive properties
    // as unconditional — claims group by tag value with presence qualifiers. (3) A bounds
    // pair proven against one array value must not certify reads of a later module value.
    const report = analyzeSource('round-counterexamples.ts', `
      export function launderJoin(flag: boolean): number {
        let value: number = 1
        if (flag) { value = true as {} as number }
        return value * 2
      }
      const boolFlags: boolean[] = [true, false]
      export function launderElements(index: number): number {
        const values = boolFlags as unknown[] as number[]
        const first = values[0]!
        return index > 0 ? first : 3
      }
      export function launderTuple(flag: boolean): number {
        const pair = [true, false] as [unknown, unknown] as [number, number]
        return flag ? pair[0]! : 3
      }
      export function launderCondition(setting: unknown): number {
        if (setting as boolean) { return 1 }
        return 0
      }
      type Frame = {kind: 'lightbox'; width: number} | {kind: 'archive'; count: number}
      function measureFrame(frame: Frame): number {
        if (frame.kind === 'archive') { return frame.count }
        return frame.width
      }
      export function launderTag(raw: string): number {
        return measureFrame({kind: raw as 'lightbox', width: 100})
      }
      export function launderQuotedTag(raw: string): number {
        return measureFrame({'kind': raw as 'lightbox', width: 100})
      }
      export function rebuildKeepsPin(frame: Frame): Frame {
        if (frame.kind === 'lightbox') { return {kind: frame.kind, width: frame.width + 4} }
        return frame
      }
      type Mixed = {ok: boolean; x: number} | {ok: false; y: number}
      export function makeMixed(useFirst: boolean): Mixed {
        if (useFirst) { return {ok: false, x: 1} }
        return {ok: false, y: 2}
      }
      let arrOne = [1, 2, 3, 4, 5, 6, 7]
      export function guardStaleAlias(i: number): number {
        const alias = arrOne
        arrOne = [7]
        if (Number.isInteger(i) && i >= 0 && i < alias.length) {
          return arrOne[i]!
        }
        return -1
      }
    `)
    // The laundered value is claim-free: the multiply stops, nothing crashes, and the
    // sibling functions still report. The element-level spellings (containers match,
    // elements differ — a later round's catch) erase the same way, because sameness is
    // a recursive type-shape comparison, not the top-level kind.
    expect(report.functions.find(fn => fn.name === 'launderJoin')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'launderElements')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'launderTuple')?.kind).toBe('partial')
    // A cast in condition position stops honestly instead of crashing the terminator's
    // boolean read, and a cast in an object literal's TAG position must not pin the
    // variant (the asserted literal is the checker's word, not the runtime tag — pinning
    // it published a dead-branch ensures falsified at runtime).
    expect(report.functions.find(fn => fn.name === 'launderCondition')?.kind).toBe('partial')
    // The tag pin is value-driven (known string content / exact booleans), so no
    // type-channel spelling — direct cast or quoted key — can pin a variant the runtime
    // tag does not hold, while the explicit rebuild
    // {kind: frame.kind, ...} keeps its pin through the declared variant's exact tag
    // value (the narrowed union's tag read carries the value itself).
    expect(report.functions.find(fn => fn.name === 'launderTag')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'launderQuotedTag')?.kind).toBe('partial')
    expect(analyzedFunction(report, 'rebuildKeepsPin').ensures)
      .toContain("return.kind is 'lightbox' or 'archive'")
    expect(analyzedFunction(report, 'makeMixed').ensures).toEqual([
      'return.ok is false',
      'return.x is a finite integer number from 1 through 1 (when return.ok is false and return.x is present)',
      'return.y is a finite integer number from 2 through 2 (when return.ok is false and return.y is present)',
    ])
    // The read keeps its honest in-bounds assumption instead of a false certification.
    expect(analyzedFunction(report, 'guardStaleAlias').assumptions.join(' ')).toContain('is in bounds')
  })

  test('single-variant presets survive tagged-union joins', () => {
    // A preset annotated as one member shape used to throw at the join. A record meeting
    // a union now degrades to their shared properties instead of crashing.
    const report = analyzeSource('union-round1.ts', `
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      const sidebarPreset: {type: 'sidebar'; width: number} = {type: 'sidebar', width: 200}
      export function pick(compact: boolean): Frame {
        return compact ? {type: 'mobile', scale: 0.5} : sidebarPreset
      }
    `)
    // The preset's variant is unknown to the analysis, so the join degrades to the shared
    // properties — an honest near-empty contract, never a crash.
    expect(analyzedFunction(report, 'pick').ensures).toEqual([])
  })

  test('exhaustive switches analyze and narrowing writes back through unions', () => {
    // The fall-off-the-end of a non-void function is a per-path stop now, not a
    // whole-function rejection — and an exhaustive switch over the variants makes that
    // path provably unreachable, so the function analyzes clean, matching TypeScript's
    // own exhaustiveness acceptance. Property refinements also write back through union
    // parents, so a range check inside a variant sticks.
    const report = analyzeSource('union-round1b.ts', `
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      export function widthOf(frame: Frame): number {
        switch (frame.type) {
          case 'sidebar': return frame.width
          case 'mobile': return frame.scale * 320
        }
      }
      type Overlay = {mode: 'zoom'; level: number} | {mode: 'pan'; dx: number}
      export function levelOf(panel: {overlay: Overlay}): number {
        if (panel.overlay.mode === 'zoom') { return panel.overlay.level }
        return panel.overlay.dx
      }
    `)
    const widthOf = analyzedFunction(report, 'widthOf')
    expect(widthOf.ensures[0]).toContain('possibly non-finite')
    expect(analyzedFunction(report, 'levelOf').ensures).toEqual(['return is a finite number'])
  })

  test('unclassifiable properties become opaque leaves and intersections classify', () => {
    // A recursive or mixed-literal property no longer vetoes its record: it is carried
    // without claims, numeric use of it rejects at the read position, and the record's
    // numeric contract survives its weird neighbors. Route variants written as
    // intersections (Base & {...}) classify like the merged record they are.
    const report = analyzeSource('opaque-leaves.ts', `
      type Filter = {kind: 'all'} | {kind: 'top'}
      type Base = {type: 'explore'; scroll: number}
      type ExploreRoute = Base & {filter: Filter | null; recursive: ExploreRoute | null}
      type Route = ExploreRoute | {type: 'home'; depth: number}
      export function scrollOf(route: Route): number {
        if (route.type === 'explore') { return route.scroll }
        return route.depth
      }
    `)
    expect(analyzedFunction(report, 'scrollOf').assumptions).toEqual([
      "route.scroll is finite and not NaN (when route.type is 'explore')",
      "route.depth is finite and not NaN (when route.type is 'home')",
    ])
    expect(analyzedFunction(report, 'scrollOf').ensures).toEqual(['return is a finite number'])
  })

  test('variant literals fill their optionals, so reads after joins never miss', () => {
    const report = analyzeSource('variant-fill.ts', `
      type Route = {type: 'archive'; folder?: string; page: number} | {type: 'home'; scroll: number}
      export function build(deep: boolean): Route {
        if (deep) { return {type: 'archive', folder: 'x', page: 2} }
        return {type: 'archive', page: 1}
      }
      export function pageOf(deep: boolean): number {
        const route = build(deep)
        if (route.type === 'archive') { return route.page }
        return 0
      }
    `)
    // 1 through 2, not 0 through 2: build only ever returns archive variants, so the
    // home arm is provably dead and prunes.
    expect(analyzedFunction(report, 'pageOf').ensures).toEqual(['return is a finite integer number from 1 through 2'])
  })

  test('tag checks on plain-record operands dispatch without narrowing', () => {
    // A builder whose declared return is a single variant produces a plain record; the
    // caller's union-typed binding then tag-checks it. The record's tag was never
    // learned, so the check is honestly unknown and both branches analyze — the round-2
    // regression (a kind-mismatch stop) healed.
    const report = analyzeSource('record-dispatch.ts', `
      type Route = {kind: 'home'; scroll: number} | {kind: 'about'; scroll: number}
      function openHome(): {kind: 'home'; scroll: number} { return {kind: 'home', scroll: 3} }
      function openAbout(): {kind: 'about'; scroll: number} { return {kind: 'about', scroll: 14} }
      export function currentScroll(flag: boolean): number {
        const route: Route = flag ? openHome() : openAbout()
        if (route.kind === 'home') { return route.scroll }
        return route.scroll
      }
    `)
    expect(analyzedFunction(report, 'currentScroll').ensures)
      .toEqual(['return is a finite integer number from 3 through 14'])
  })

  test('throw guards discharge obligations; always-throwing functions never return', () => {
    // A thrown path simply ends — no exception modeling needed, because the subset has no
    // catch: nothing analyzed can observe anything after a throw. The guard clause's
    // branch refinement then discharges the division, a function that throws on every
    // path is analyzed with no ensures (it never returns normally), and its callers stop
    // with the honest reason.
    const report = analyzeSource('throw-guards.ts', `
      export function divideWidth(width: number, columns: number): number {
        if (columns === 0) { throw new Error('bad grid') }
        return width / columns
      }
      export function fail(code: number): number {
        throw new Error('nope ' + code)
      }
      export function caller(x: number): number {
        if (x < 0) { return fail(x) }
        return x
      }
    `)
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'divideWidth'))).toEqual([])
    expect(analyzedFunction(report, 'fail').ensures).toEqual([])
    // A guarded call to an always-throwing helper behaves exactly like an inline throw:
    // the path ends silently and the returning path carries the full contract.
    expect(analyzedFunction(report, 'caller').ensures).toEqual(['return is a finite number at least 0'])
  })

  test('boolean equality, string length, typeof strings, and nullable switches analyze', () => {
    const report = analyzeSource('sweep-group2.ts', `
      export function boolEq(config: {enabled: boolean}, x: number): number {
        if (config.enabled === true) { return x }
        return 0
      }
      export function nameLength(name: string): number {
        return Math.min(name.length, 40)
      }
      export function typeofString(input: string | undefined, x: number): number {
        if (typeof input === 'string') { return x }
        return 0
      }
      export function switchNullable(mode: string | undefined, a: number, b: number): number {
        switch (mode) {
          case 'wide': return a
          default: return b
        }
      }
    `)
    expect(analyzedFunction(report, 'boolEq').ensures).toEqual(['return is a finite number'])
    // .length is a fresh nonnegative integer; the clamp gives the exact range.
    expect(analyzedFunction(report, 'nameLength').ensures).toEqual(['return is a finite integer number from 0 through 40'])
    expect(analyzedFunction(report, 'typeofString').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'switchNullable').ensures).toEqual(['return is a finite number'])
  })

  test('parse functions, callback and unknown parameters, and instanceof analyze', () => {
    // parseFloat is an honest NaN source and the isFinite narrowing launders it — the
    // parse-then-clamp idiom proves its bound. Callback and unknown parameters carry
    // opaquely (calls to a carried callback still reject at the call gate; unknown is the
    // safe any — the checker forces narrowing before use). instanceof on a carried value
    // answers unknown: both branches analyze, no claims.
    const report = analyzeSource('sweep-group3.ts', `
      export function parsed(text: string): number {
        const value = Number.parseFloat(text)
        if (Number.isFinite(value)) { return Math.min(value, 100) }
        return 0
      }
      export function withCallback(onDone: () => void, x: number): number {
        const kept = onDone
        return x + 1
      }
      export function carries(data: unknown, x: number): number {
        const kept = data
        return x * 2
      }
      export function domCheck(el: unknown, x: number): number {
        if (el instanceof HTMLDivElement) { return x }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'parsed').ensures).toEqual(['return is a finite number at most 100'])
    expect(analyzedFunction(report, 'withCallback').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'carries').ensures[0]).toContain('possibly non-finite')
    expect(analyzedFunction(report, 'domCheck').ensures).toEqual(['return is a finite number'])
  })

  test('logical assignments, remainder, optional chaining, and destructured parameters are classified', () => {
    const report = analyzeSource('sweep-group4.ts', `
      export function nullishAssign(timeout: number | null): number {
        let effective = timeout
        effective ??= 250
        return effective
      }
      export function modulo(index: number, length: number): number {
        if (length === 0) { return 0 }
        return index % length
      }
      export function moduloRequires(index: number, length: number): number {
        return index % length
      }
      export function chainRead(config: {volume: number} | null): number {
        return config?.volume ?? 5
      }
      type Size = {width: number; height: number}
      export function area({width, height}: Size): number {
        return Math.min(width * height, 5000)
      }
      export function ratioReq({width, height}: Size): number {
        return width / height
      }
      export function destructuredOther(
        {enabled, fallback}: {enabled: boolean; fallback: number | null},
      ): number {
        return enabled ? fallback ?? 0 : 0
      }
      type DestructuredChoice =
        | {kind: 'small'; value: number}
        | {kind: 'large'; value: number}
      export function destructuredChoice({kind, value}: DestructuredChoice): number {
        return kind === 'small' ? value : 0
      }
    `)
    const file = 'sweep-group4.ts'
    expect(analyzedFunction(report, 'nullishAssign').ensures).toEqual(['return is a finite number'])
    // The === 0 guard discharges the remainder's obligation like division's.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'modulo'))).toEqual([])
    expect(analyzedFunction(report, 'modulo').ensures).toEqual(['return is a finite number'])
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'moduloRequires')))
      .toEqual([`length is nonzero (remainder at ${file}:12:16)`])
    expect(analyzedFunction(report, 'chainRead').assumptions)
      .toEqual(['config is null or config.volume is finite and not NaN'])
    expect(analyzedFunction(report, 'chainRead').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'area').assumptions).toEqual([])
    expect(analyzedFunction(report, 'area').requires[0])
      .toContain('width and height are finite')
    // Requirements use the local names written by the destructuring pattern.
    expect(requirementsBesidesInputFiniteness(analyzedFunction(report, 'ratioReq')))
      .toEqual([`height is nonzero (division at ${file}:22:16)`])
    expect(analyzedFunction(report, 'destructuredOther').assumptions).toEqual([
      'enabled is a boolean',
      'fallback is null or a finite non-NaN number',
    ])
    expect(analyzedFunction(report, 'destructuredChoice').assumptions).toEqual([
      "value is finite and not NaN (when kind is 'small')",
      "value is finite and not NaN (when kind is 'large')",
    ])
  })

  test('module refinements require a local snapshot', () => {
    const report = analyzeSource('module-narrow.ts', `
      let setting: number | null = null
      export function setSetting(value: number | null): void {
        setting = value
      }
      export function direct(): number {
        if (setting !== null) { return setting }
        return 0
      }
      export function snapshot(): number {
        const current = setting
        if (current !== null) { return current }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'direct').ensures).toEqual(['return is null or a finite number'])
    expect(analyzedFunction(report, 'snapshot').ensures).toEqual(['return is a finite number'])
  })

  test('mixed joins degrade to opaque', () => {
    const report = analyzeSource('stale-and-mixed.ts', `
      export function numberOr(value: unknown, fallback: number): number {
        return typeof value === 'number' ? value : fallback
      }
    `)
    expect(analyzedFunction(report, 'numberOr').ensures).toEqual([])
  })

  test('sentinel checks on opaque values stay live', () => {
    // An unknown-typed value can be undefined at runtime, so `=== undefined` keeps both
    // branches live — checked directly and through a null join.
    const report = analyzeSource('merge-and-sentinel.ts', `
      export function viaNullJoin(value: unknown, useNull: boolean, useLeft: boolean, n: number): number {
        const withNull = useNull ? value : null
        const v = useLeft ? withNull : n
        if (v === undefined) { return -1 }
        return 0
      }
      export function direct(value: unknown): number {
        if (value === undefined) { return -1 }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'viaNullJoin').ensures).toEqual(['return is a finite integer number from -1 through 0'])
    expect(analyzedFunction(report, 'direct').ensures).toEqual(['return is a finite integer number from -1 through 0'])
  })

  test('a function that only switches on a union tag prints an empty assumes block', () => {
    // The real specimen behind the read filter: mj-gallery's submissionCreatesVideo
    // switches on submissionType.type and returns a boolean, reading exactly one
    // property — yet it used to print dozens of per-variant array and number lines about
    // properties it never touched. The boolean ensures rests on nothing in any variant's
    // slots (a smuggled non-boolean cannot reach the return through the tag dispatch),
    // so the honest assumes block is empty. The tag read itself keeps nothing: a string
    // tag is opaque and prints no line anyway.
    const report = analyzeSource('tag-switch-only.ts', `
      type SubmitJob =
        | {type: 'image'; imagePrompts: string[]; weights: number[]}
        | {type: 'video'; frames: number[]; durationMs: number}
      export function createsVideo(job: SubmitJob): boolean {
        switch (job.type) {
          case 'image': return false
          case 'video': return true
        }
      }
    `)
    const specimen = analyzedFunction(report, 'createsVideo')
    expect(specimen.assumptions).toEqual([])
    expect(specimen.ensures).toEqual(['return is boolean'])
  })

})
