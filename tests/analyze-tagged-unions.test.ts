import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

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
      function pick(wide: boolean): Frame {
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
    `)
    expect(analyzedFunction(report, 'elseIfChain').assumptions).toEqual([
      "route.index is finite and not NaN (when route.type is 'lightbox')",
      "route.page is finite and not NaN (when route.type is 'archive')",
    ])
    expect(analyzedFunction(report, 'elseIfChain').ensures).toEqual(['return is a finite number'])
    // The two variants' exact constants survive the join and re-split at the caller.
    expect(analyzedFunction(report, 'useIt').ensures).toEqual(['return is a finite number from 50 through 240'])
    expect(analyzedFunction(report, 'switchOnTag').ensures).toEqual(['return is a finite number'])
  })

  test('tagged unions: duplicate tag values keep both variants, and in-checks tell them apart', () => {
    // UpdatesRoute-style: two variants share the tag 'updates' and differ by which
    // property exists — exactly what TypeScript's own narrowing needs an in-check for.
    const report = analyzeSource('duplicate-tags.ts', `
      type Route = {type: 'updates'; tab: number} | {type: 'updates'; article: string} | {type: 'home'; scroll: number}
      export function tabOf(route: Route): number {
        if (route.type === 'updates' && 'tab' in route) { return route.tab }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'tabOf').ensures).toEqual(['return is a finite number'])
  })

  test('tagged unions: nullable wrappers carry them, and nesting mirrors the type tree', () => {
    const report = analyzeSource('nullable-tagged.ts', `
      type Owner = {type: 'explore'; page: number} | {type: 'imagine'; count: number}
      type Lightbox = {type: 'lightbox'; index: number; owner: null | Owner}
      export function ownerPage(box: Lightbox): number {
        const owner = box.owner
        if (owner === null) { return 0 }
        if (owner.type === 'explore') { return owner.page }
        return owner.count
      }
    `)
    expect(analyzedFunction(report, 'ownerPage').assumptions).toEqual([
      'box.index is finite and not NaN',
      "box.owner is null or box.owner.page is finite and not NaN (when box.owner.type is 'explore')",
      "box.owner is null or box.owner.count is finite and not NaN (when box.owner.type is 'imagine')",
    ])
    expect(analyzedFunction(report, 'ownerPage').ensures).toEqual(['return is a finite number'])
  })

  test('tagged unions: per-variant return facts, and loops over unions converge', () => {
    const report = analyzeSource('tagged-returns.ts', `
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      export function pick(wide: boolean): Frame {
        if (wide) { return {type: 'sidebar', width: 240} }
        return {type: 'mobile', scale: 0.5}
      }
      export function total(frames: Frame[]): number {
        let sum = 0
        for (const frame of frames) {
          if (frame.type === 'sidebar') { sum = sum + frame.width }
        }
        return sum
      }
    `)
    expect(analyzedFunction(report, 'pick').ensures).toEqual([
      "return.type is 'sidebar' or 'mobile'",
      "return.width is a finite integer number from 240 through 240 (when return.type is 'sidebar')",
      "return.scale is a finite number from 0.5 through 0.5 (when return.type is 'mobile')",
    ])
    expect(analyzedFunction(report, 'total').assumptions).toEqual([
      "frames[each].width is finite and not NaN (when frames[each].type is 'sidebar')",
      "frames[each].scale is finite and not NaN (when frames[each].type is 'mobile')",
    ])
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
    expect(analyzedFunction(report, 'unwrapOr').assumptions).toEqual([
      'result.value is finite and not NaN (when result.ok is true)',
      'result.code is finite and not NaN (when result.ok is false)',
      'fallback is finite and not NaN',
    ])
    expect(analyzedFunction(report, 'negated').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'makeBoth').ensures).toEqual([
      'return.ok is true or false',
      'return.value is a finite number more than 0 (when return.ok is true)',
      'return.code is a finite integer number from 400 through 400 (when return.ok is false)',
    ])
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
    // pair proven against a pre-rebind alias must not certify reads of the rebound array:
    // the canonical key is binding-rooted only while the slot version still matches.
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
      export function launderSpreadTag(raw: string): number {
        const template = {kind: raw as 'lightbox', width: 100}
        return measureFrame({...template, width: 200})
      }
      export function rebuildKeepsPin(frame: Frame): Frame {
        if (frame.kind === 'lightbox') { return {...frame, width: frame.width + 4} }
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
    const file = 'round-counterexamples.ts'
    // The laundered value is claim-free: the multiply stops, nothing crashes, and the
    // sibling functions still report. The element-level spellings (containers match,
    // elements differ — a later round's catch) erase the same way, because sameness is
    // the recursive shape fingerprint, not the top-level kind.
    expect(report.functions.find(fn => fn.name === 'launderJoin')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'launderElements')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'launderTuple')?.kind).toBe('partial')
    // A cast in condition position stops honestly instead of crashing the terminator's
    // boolean read, and a cast in an object literal's TAG position must not pin the
    // variant (the asserted literal is the checker's word, not the runtime tag — pinning
    // it published a dead-branch ensures falsified at runtime).
    expect(report.functions.find(fn => fn.name === 'launderCondition')?.kind).toBe('partial')
    // The tag pin is value-driven (known string content / exact booleans), so no
    // type-channel spelling — direct cast, quoted key, spread of a cast-tagged template —
    // can pin a variant the runtime tag does not hold, while the rebuild idiom keeps its
    // pin through the declared variant's exact tag value.
    expect(report.functions.find(fn => fn.name === 'launderTag')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'launderQuotedTag')?.kind).toBe('partial')
    expect(report.functions.find(fn => fn.name === 'launderSpreadTag')?.kind).toBe('partial')
    expect(analyzedFunction(report, 'rebuildKeepsPin').ensures)
      .toContain("return.kind is 'lightbox' or 'archive'")
    expect(analyzedFunction(report, 'makeMixed').ensures).toEqual([
      'return.ok is false',
      'return.x is a finite integer number from 1 through 1 (when return.ok is false and return.x is present)',
      'return.y is a finite integer number from 2 through 2 (when return.ok is false and return.y is present)',
    ])
    // The read keeps its honest in-bounds assumption instead of a false certification.
    expect(analyzedFunction(report, 'guardStaleAlias').assumptions).toContain(
      `the element read at ${file}:50:18 is in bounds`,
    )
  })

  test('duplicate-tag variants survive self-joins, rebuilds, and presets', () => {
    // Round-1 findings: (1) joining a state with itself paired same-tag variants by tag
    // alone and intersected away the property an in-check needs — variants now pair by
    // tag AND property-name shape, so the article branch stays reachable; (2) the rebuild
    // idiom {...frame, width: ...} and a preset annotated as one member shape used to
    // throw at the join — the literal's own checked type now names the variant, and a
    // record meeting a union degrades to the shared hull instead of crashing.
    const report = analyzeSource('union-round1.ts', `
      type Updates = {type: 'updates'; tab: number} | {type: 'updates'; article: number}
      export function badgeJoined(route: Updates, verbose: boolean): number {
        let base = 0
        if (verbose) { base = 1 }
        if ('article' in route) { return route.article + base }
        return base
      }
      type Frame = {type: 'sidebar'; width: number} | {type: 'mobile'; scale: number}
      export function widen(frame: Frame): Frame {
        if (frame.type === 'sidebar') { return {...frame, width: frame.width + 40} }
        return frame
      }
      const sidebarPreset: {type: 'sidebar'; width: number} = {type: 'sidebar', width: 200}
      export function pick(compact: boolean): Frame {
        return compact ? {type: 'mobile', scale: 0.5} : sidebarPreset
      }
    `)
    // The article branch is reachable: the ensures must cover route.article + base.
    expect(analyzedFunction(report, 'badgeJoined').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'widen').ensures).toContain("return.type is 'sidebar' or 'mobile'")
    // The preset's variant is unknown to the analysis, so the join degrades to the shared
    // hull — an honest near-empty contract, never a crash.
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
    expect(widthOf.ensures[0]).toContain('number')
    expect(analyzedFunction(report, 'levelOf').ensures).toEqual(['return is a finite number'])
  })

  test('unclassifiable properties become opaque leaves; intersections classify; hull reads stop honestly', () => {
    // A recursive or mixed-literal property no longer vetoes its record: it is carried
    // without claims, numeric use of it rejects at the read position, and the record's
    // numeric contract survives its weird neighbors. Route variants written as
    // intersections (Base & {...}) classify like the merged record they are. And a read
    // past a degraded hull (a union that met a plain record) stops honestly instead of
    // crashing the run.
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

  test('tag checks on plain-record operands dispatch blind; inherited lib properties stay boundary leaves', () => {
    // A builder whose declared return is a single variant produces a plain record; the
    // caller's union-typed binding then tag-checks it. The record's tag was never
    // learned, so the check is honestly unknown and both branches analyze — the round-2
    // regression (a kind-mismatch stop) healed. And a project interface extending a lib
    // interface contracts only the properties the project wrote.
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

  test('in-checks on joined records never prune the absent side', () => {
    // The join of {kind, scroll} and {kind, tab} keeps only 'kind' — the missing 'tab' is
    // a join casualty, not proof of runtime absence, so the in-check's true branch stays
    // reachable (probe(false) returns 999 at runtime). Only the present direction
    // decides: a join never invents a property.
    const report = analyzeSource('in-joined-record.ts', `
      type Route = {kind: 'home'; scroll: number} | {kind: 'about'; tab: number}
      function openHome(): {kind: 'home'; scroll: number} { return {kind: 'home', scroll: 3} }
      function openAbout(): {kind: 'about'; tab: number} { return {kind: 'about', tab: 5} }
      export function probe(flag: boolean): number {
        const route: Route = flag ? openHome() : openAbout()
        if ('tab' in route) { return 999 }
        return 1
      }
    `)
    expect(analyzedFunction(report, 'probe').ensures)
      .toEqual(['return is a finite integer number from 1 through 999'])
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
    expect(analyzedFunction(report, 'divideWidth').requires).toEqual([])
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
    expect(analyzedFunction(report, 'carries').ensures[0]).toContain('number')
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
    `)
    const file = 'sweep-group4.ts'
    expect(analyzedFunction(report, 'nullishAssign').ensures).toEqual(['return is a finite number'])
    // The === 0 guard discharges the remainder's obligation like division's.
    expect(analyzedFunction(report, 'modulo').requires).toEqual([])
    expect(analyzedFunction(report, 'modulo').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'moduloRequires').requires)
      .toEqual([`length is nonzero (remainder at ${file}:12:16)`])
    expect(analyzedFunction(report, 'chainRead').assumptions)
      .toEqual(['config is null or config.volume is finite and not NaN'])
    expect(analyzedFunction(report, 'chainRead').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'area').assumptions).toEqual([
      '{width, height}.width is finite and not NaN',
      '{width, height}.height is finite and not NaN',
    ])
    // Requirements name destructured properties through the synthetic record parameter.
    expect(analyzedFunction(report, 'ratioReq').requires)
      .toEqual([`{width, height}.height is nonzero (division at ${file}:22:16)`])
  })

  test('module reads narrow their slot: re-reads keep refinements, parse-then-throw launders', () => {
    // A refinement on a module read writes into the slot, so the read-check-read spelling
    // works without the old copy-to-a-local workaround, and a top-level parse guarded by
    // an isNaN throw publishes its value NaN-free (Infinity stays possible — parseFloat
    // of '1e999' is honest overflow).
    const report = analyzeSource('module-narrow.ts', `
      const raw = Number.parseFloat('42.5')
      if (Number.isNaN(raw)) { throw new Error('bad build constant') }
      export function scaled(): number {
        return raw
      }
      const config: {scale: number | null} = {scale: 3}
      export function reader(): number {
        if (config.scale !== null) { return config.scale + 1 }
        return 0
      }
    `)
    expect(analyzedFunction(report, 'scaled').ensures[0]).not.toContain('NaN')
    expect(analyzedFunction(report, 'reader').ensures).toEqual(['return is a finite integer number from 4 through 4'])
  })

  test('slot narrowing survives the stale-snapshot attack; mixed joins degrade to opaque', () => {
    // Read a snapshot, rebind the module binding, then branch on the snapshot: the
    // refinement must NOT clobber the fresh slot with the refined stale value (a review
    // round ran the counterexample — the ensures excluded the runtime -1). The version
    // guard keeps the slot narrowing only while no write touched the slot since the
    // read. And typeof value === 'number' ? value : fallback on
    // unknown joins opaque with number — the join absorbs into a claim-free opaque
    // instead of crashing, so the function analyzes with honest empty ensures.
    const report = analyzeSource('stale-and-mixed.ts', `
      let counter = 0
      export function setCounter(v: number): void { counter = v }
      export function stale(): number {
        const snapshot = counter
        counter = -1
        if (snapshot > 5) { return counter }
        return 0
      }
      export function numberOr(value: unknown, fallback: number): number {
        return typeof value === 'number' ? value : fallback
      }
    `)
    expect(analyzedFunction(report, 'stale').ensures).toEqual(['return is a finite integer number from -1 through 0'])
    expect(analyzedFunction(report, 'numberOr').ensures).toEqual([])
  })

  test('slot narrowing survives the merge-conflation attack; sentinel checks on opaque stay live', () => {
    // Two counterexamples from a review round. First: the ternary merge makes the two
    // paths' states structurally equal, so the merge keeps the stored path's bookkeeping,
    // and `counter = chosen` puts a value back in the slot — but on the false path that
    // value is `other`, not the snapshot, so `snapshot > 5` must not narrow the slot
    // (runtime: setCounter(10) then subtle(false, -3) returns -3; the old ensures said at
    // least 0). The version guard drops the narrowing because the write stamped a fresh
    // version that no longer matches the one the read observed. Second: an unknown-typed
    // value can BE undefined at runtime, so `=== undefined` keeps both branches live —
    // checked directly on the parameter and through a null join (which wraps the opaque
    // in a maybeNullish whose sentinels list only null).
    const report = analyzeSource('merge-and-sentinel.ts', `
      let counter = 0
      export function setCounter(v: number): void { counter = v }
      export function subtle(flag: boolean, other: number): number {
        const snapshot = counter
        const chosen = flag ? snapshot : other
        counter = chosen
        if (snapshot > 5) { return counter }
        return 0
      }
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
    expect(analyzedFunction(report, 'subtle').ensures).toEqual(['return is a finite number'])
    expect(analyzedFunction(report, 'viaNullJoin').ensures).toEqual(['return is a finite integer number from -1 through 0'])
    expect(analyzedFunction(report, 'direct').ensures).toEqual(['return is a finite integer number from -1 through 0'])
  })

})
