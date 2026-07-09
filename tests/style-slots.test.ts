import {describe, expect, test} from 'bun:test'
import {analyzeFile, analyzeSource} from '../src/index.ts'

// Each numeric JSX style value is analyzed as its own synthetic function. These
// checks cover collection, const following, input snapshots, verdicts, and fallbacks.
const slotLines = (source: string): string[] => {
  const report = analyzeSource('slots.tsx', source)
  return report.styleSlots.map(slot => `${slot.verdict}: ${slot.line}`)
}

describe('style slots', () => {
  test('direct and template-string divisions report the same guard', () => {
    expect(slotLines(`
export function LoadBar(props: {loaded: number; total: number}) {
  return <div style={{width: (props.loaded / props.total) * 100}} />
}
export function TemplateLoadBar(props: {loaded: number; total: number}) {
  return <div style={{width: \`\${(props.loaded / props.total) * 100}%\`}} />
}
`)).toEqual([
      'may be NaN: style.width at 3:30: the value is a possibly NaN number from -Infinity through Infinity (NaN possible from the operation at slots.tsx:3:31); guard to add: props.total is nonzero (division at slots.tsx:3:31); assumes: props.loaded is finite and not NaN, props.total is finite and not NaN',
      'may be NaN: style.width at 6:33: the value is a possibly NaN number from -Infinity through Infinity (NaN possible from the operation at slots.tsx:6:34); guard to add: props.total is nonzero (division at slots.tsx:6:34); assumes: props.loaded is finite and not NaN, props.total is finite and not NaN',
    ])
  })

  test('a division hidden behind consts flags too, pointing at the const line', () => {
    expect(slotLines(`
type Job = {width: number; height: number}
export function ImageCard(props: {job: Job; columnWidth: number}) {
  const padding = 16
  const usableWidth = props.columnWidth - padding * 2
  const cardHeight = (usableWidth * props.job.height) / props.job.width
  return <div style={{height: cardHeight}} />
}
`)).toEqual([
      'may be NaN: style.height at 7:31: the value is a possibly NaN number from -Infinity through Infinity (NaN possible from the operation at slots.tsx:6:23); guard to add: props.job.width is nonzero (division at slots.tsx:6:22); assumes: props.job.width is finite and not NaN, props.job.height is finite and not NaN, props.columnWidth is finite and not NaN',
    ])
  })

  test('a clamped const chain proves its exact range', () => {
    expect(slotLines(`
type Job = {width: number; height: number}
export function SafeCard(props: {job: Job; columnWidth: number}) {
  const safeWidth = Math.max(1, props.job.width)
  const cardHeight = Math.min(600, (props.columnWidth * props.job.height) / safeWidth)
  return <div style={{height: Math.max(0, cardHeight)}} />
}
`)).toEqual([
      'ok: style.height at 6:31: the value is a finite number from 0 through 600; assumes: props.job.width is finite and not NaN, props.job.height is finite and not NaN, props.columnWidth is finite and not NaN',
    ])
  })

  test('follows primitive unions instead of widening them to an arbitrary input', () => {
    expect(slotLines(`
export function Progress(props: {useSmallTarget: boolean}) {
  const target = props.useSmallTarget ? 200 : 550
  const width = 100 / target
  return <div style={{width}} />
}
`)).toEqual([
      'ok: style.width at 5:23: the value is a finite number from 0.18181818181818182 through 0.5; assumes: props.useSmallTarget is a boolean',
    ])
  })

  test('follows imported numeric literals inside style const chains', () => {
    const fixture = new URL('./fixtures/style-imports.tsx', import.meta.url).pathname
    const report = analyzeFile(fixture)
    expect(report.styleSlots).toHaveLength(1)
    expect(report.styleSlots[0]?.verdict).toBe('may overflow to Infinity')
    expect(report.styleSlots[0]?.guard).toBeNull()
    expect(report.styleSlots[0]?.line).not.toContain('possibly NaN')
    expect(report.styleSlots[0]?.line).toContain('assumes: props.useSmallTarget is a boolean, props.total is finite and not NaN')
  })

  test('a reassigned variable is observed separately across the write', () => {
    // early was computed with scale = 2, the slot reads scale after the `scale = 0` line;
    // following the const must give those two reads separate input values. An earlier
    // multiplication may overflow, so subtracting the later multiplication may be NaN.
    expect(slotLines(`
export function Mutated(props: {count: number}) {
  let scale = 2
  const early = props.count * scale
  scale = 0
  return <div style={{width: early - props.count * scale}} />
}
`)).toEqual([
      'may be NaN: style.width at 6:30: the value is a possibly NaN number from -Infinity through Infinity (NaN possible from the operation at slots.tsx:4:17); assumes: props.count is finite and not NaN, scale is finite and not NaN',
    ])
  })

  test('a mutable object is observed separately across a property write', () => {
    // sizeRef the binding is never reassigned, but sizeRef.current.w is. The earlier
    // multiplication and the style line therefore receive separate sizeRef inputs.
    expect(slotLines(`
export function Gauge(props: {ratio: number}) {
  const sizeRef = {current: {w: 4}}
  const early = sizeRef.current.w * 2
  sizeRef.current.w = 9
  return <div style={{width: early - sizeRef.current.w}} />
}
`)).toEqual([
      'may overflow to Infinity: style.width at 6:30: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:4:17); assumes: sizeRef.current.w is finite and not NaN',
    ])
  })

  test('consecutive consts share inputs, while an intervening statement uses fresh inputs', () => {
    expect(slotLines(`
export function Widget(props: {sizes: number[]}) {
  const count = props.sizes.length
  const width = count > 0 ? Math.max(0, props.sizes[0]!) : 0
  return <div style={{width}} />
}
`)).toEqual([
      'ok: style.width at 5:23: the value is a finite number at least 0; assumes: every props.sizes element is finite and not NaN',
    ])
    // count is captured before dropLast(), while width reads the aliased array afterward.
    // No mutation scan could discover that relationship from the call itself. Treating
    // both const initializers with the same inputs would incorrectly prove the index valid.
    expect(slotLines(`
let shared: number[] = []
function dropLast(): void { shared.pop() }
export function Widget(props: {sizes: number[]}) {
  shared = props.sizes
  const count = props.sizes.length
  dropLast()
  const width = count > 0 ? Math.max(0, Math.min(100, props.sizes[0]!)) : 0
  return <div style={{width}} />
}
`)).toEqual([
      'needs a guard: style.width at 9:23: only safe when 0 is a valid props.sizes index (element read at slots.tsx:8:55); the value is a finite number from 0 through 100; assumes: every props.sizes element is finite and not NaN',
    ])
  })

  test('calls hidden in variable declarations separate mutable inputs', () => {
    // A destructuring default is part of the binding pattern rather than the declaration's
    // right-hand side, but the default still runs. It must separate count from width just
    // like a standalone dropLast() statement does.
    const destructuringDefault = slotLines(`
let shared: number[] = []
function dropLast(): number { shared.pop(); return 0 }
export function Widget(props: {sizes: number[]; options: {padding?: number}}) {
  shared = props.sizes
  const count = props.sizes.length
  const {padding = dropLast()} = props.options
  const width = count > 0 ? Math.max(0, Math.min(100, props.sizes[0]!)) : 0
  return <div style={{width}} />
}
`)
    expect(destructuringDefault).toHaveLength(1)
    expect(destructuringDefault[0]).toContain('only safe when 0 is a valid props.sizes index (element read at slots.tsx:8:55)')

    // The same rule applies when a call is one declarator inside a larger const statement.
    const multipleDeclarators = slotLines(`
let shared: number[] = []
function dropLast(values: number[]): number { shared = values; shared.pop(); return 0 }
export function Widget(props: {sizes: number[]}) {
  const count = props.sizes.length,
    extra = dropLast(props.sizes),
    width = count > 0 ? Math.max(0, Math.min(100, props.sizes[0]!)) : 0
  return <div style={{width}} />
}
`)
    expect(multipleDeclarators).toHaveLength(1)
    expect(multipleDeclarators[0]).toContain('only safe when 0 is a valid props.sizes index')
  })

  test('a primitive const remains one captured value across intervening code', () => {
    // The call is deliberately not followed, but captured is an immutable number. copied
    // must retain that same value so the nonzero check discharges the later division guard.
    expect(slotLines(`
function readOffset(): number { return 4 }
export function Widget() {
  const captured = readOffset()
  const copied = captured
  const left = captured !== 0 ? Math.max(-100, Math.min(100, 10 / copied)) : 0
  return <div style={{left}} />
}
`)).toEqual([
      'ok: style.left at 7:23: the value is a finite number from -100 through 100; assumes: captured is finite and not NaN',
    ])

    // An intervening call separates ordinary mutable inputs, but it cannot change a const's
    // captured number. The equivalent let may be reassigned by code the pass does not read.
    expect(slotLines(`
function readOffset(): number { return 4 }
function poke(): void {}
export function Widget() {
  const captured = readOffset()
  const nonzero = captured !== 0
  poke()
  const left = nonzero ? Math.max(-100, Math.min(100, 10 / captured)) : 0
  return <div style={{left}} />
}
`)).toEqual([
      'ok: style.left at 9:23: the value is a finite number from -100 through 100; assumes: captured is finite and not NaN',
    ])
    expect(slotLines(`
function readOffset(): number { return 4 }
export function Widget() {
  let captured = readOffset()
  function clearOffset(): void { captured = 0 }
  const nonzero = captured !== 0
  clearOffset()
  const left = nonzero ? Math.max(-100, Math.min(100, 10 / captured)) : 0
  return <div style={{left}} />
}
`)).toEqual([
      'needs a guard: style.left at 9:23: only safe when captured is nonzero (division at slots.tsx:8:55); the value is a finite number from -100 through 100; assumes: captured is finite and not NaN',
    ])
  })

  test('module scalars may follow after top-level writes but not writes inside functions', () => {
    // Top-level assignments finish during module initialization, before a component runs.
    expect(slotLines(`
let scale = 1
scale = 3
export function Widget(props: {count: number}) {
  const width = props.count * scale
  return <div style={{width}} />
}
`)).toEqual([
      'may overflow to Infinity: style.width at 6:23: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:5:17); assumes: props.count is finite and not NaN',
    ])

    // A function may write scale between the const line and the style expression, so the
    // const initializer must stay hidden and early must be treated as an input.
    expect(slotLines(`
let scale = 1
function bump(): void { scale = 3 }
export function Widget(props: {count: number}) {
  const early = props.count * scale
  bump()
  return <div style={{width: early - props.count * scale}} />
}
`)).toEqual([
      'may overflow to Infinity: style.width at 7:30: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:7:38); assumes: early is finite and not NaN, props.count is finite and not NaN, scale is finite and not NaN',
    ])
  })

  test('non-DOM and non-literal style forms are named skips', () => {
    // Only a DOM tag renders its style values as CSS; a component's style prop is an
    // ordinary value the component may forward, transform, or ignore — even one holding
    // a division by zero stays uncheckable from here.
    expect(slotLines(`
function Inner(props: {style: {width: number}}) {
  return null
}
export function Outer(props: {size: number}) {
  return <Inner style={{width: props.size / 0}} />
}
export function Precomputed(props: {panel: {width: number}}) {
  return <div style={props.panel} />
}
export function Spread(props: {base: {width: number}; size: number}) {
  return <div style={{...props.base, width: props.size}} />
}
`)).toEqual([
      'skipped: style at 6:17: style on a component, not a DOM tag — only DOM tags render style values as CSS at slots.tsx:6:17',
      'skipped: style at 9:22: expression (PropertyAccessExpression) at slots.tsx:9:22',
      'skipped: style at 12:23: expression (SpreadAssignment) at slots.tsx:12:23',
    ])
  })

  test('the Infinity tiers: reachable through a zero divisor vs overflow-only', () => {
    // 10 / parts cannot be NaN (the numerator is a nonzero constant) but a zero divisor
    // makes it Infinity from everyday values — a warning-tier finding with a named guard.
    expect(slotLines(`
export function FixedNumerator(props: {parts: number}) {
  return <div style={{width: 10 / props.parts}} />
}
export function Doubled(props: {size: number}) {
  return <div style={{width: props.size * 2, left: props.size}} />
}
`)).toEqual([
      'may reach Infinity: style.width at 3:30: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:3:30); guard to add: props.parts is nonzero (division at slots.tsx:3:30); assumes: props.parts is finite and not NaN',
      // size * 2 only reaches Infinity near the top of what a JS number holds; left has no
      // sign constraint, so the bare finite value is fine there.
      'may overflow to Infinity: style.width at 6:30: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:6:30); assumes: props.size is finite and not NaN',
      'ok: style.left at 6:52: the value is a finite number; assumes: props.size is finite and not NaN',
    ])
  })

  test('shorthand members and module constants retain their exact values', () => {
    expect(slotLines(`
export function Shorthand(props: {size: number}) {
  const width = Math.max(0, props.size)
  return <div style={{width}} />
}
const CARD_GAP = 8
export function Gapped(props: {index: number}) {
  return <div style={{left: CARD_GAP * 2}} />
}
`)).toEqual([
      'ok: style.width at 4:23: the value is a finite number at least 0; assumes: props.size is finite and not NaN',
      'ok: style.left at 8:29: the value is a finite integer number from 16 through 16',
    ])
  })

  test('a write through an alias cannot produce a stale exact claim', () => {
    // The review round's headline finding: `alias.current.w = 0` marks alias, never
    // sizeRef, so no syntactic scan can close aliasing. The fix is structural — object
    // and array literals never inline (their exact contents could go stale), so the slot
    // reads sizeRef as an input at its declared type and honestly reports the division.
    // Before the fix this claimed `ok: the value is a finite number from 25 through 25`
    // while the rendered value was Infinity.
    expect(slotLines(`
export function Gallery() {
  const sizeRef = {current: {w: 4}}
  const alias = sizeRef
  alias.current.w = 0
  return <div style={{width: 100 / sizeRef.current.w}} />
}
`)).toEqual([
      'may reach Infinity: style.width at 6:30: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:6:30); guard to add: sizeRef.current.w is nonzero (division at slots.tsx:6:30); assumes: sizeRef.current.w is finite and not NaN',
    ])
  })

  test('a number-or-undefined style value is checked on its number-when-present part', () => {
    // The React conditional-style idiom: undefined means the declaration is simply not
    // applied (no silent failure), and the number arm carries the usual hazards. A review
    // round found these slots were invisible — neither checked nor counted.
    expect(slotLines(`
export function Panel(props: {open: boolean; panelWidth: number; total: number}) {
  return <div style={{width: props.open ? props.panelWidth / props.total : undefined}} />
}
`)).toEqual([
      'may reach Infinity: style.width at 3:30: when present, the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:3:43); guard to add: props.total is nonzero (division at slots.tsx:3:43); assumes: props.open is a boolean, props.panelWidth is finite and not NaN, props.total is finite and not NaN',
    ])
  })

  test('a stale length read cannot discharge the style line element read', () => {
    // Two review-round shapes. A module record's array popped through an alias inside a
    // body-called function: the const chain refuses to follow anything touching a
    // record-holding module binding, so the element read keeps its in-bounds guard. And
    // an alias const (`const stale = props.sizes`) may not inline — only primitive-valued
    // consts do — so the style line cannot receive the instance observed at the const's
    // line. Before these rules, both shapes printed a guard-free finite claim while the
    // runtime rendered NaN.
    const moduleStore = slotLines(`
const store = {sizes: [10, 20, 30]}
export function dropLast() { const sizesAlias = store.sizes; sizesAlias.pop() }
export function Widget(props: {position: number}) {
  const index = Math.floor(Math.min(Math.max(props.position, 0), 9))
  const count = store.sizes.length
  dropLast()
  return <div style={{width: index < count ? store.sizes[index]! - 0 : 0}} />
}
`)
    expect(moduleStore).toHaveLength(1)
    expect(moduleStore[0]).toContain('guard to add: the element read at slots.tsx:8:46 is in bounds')
    const aliasConst = slotLines(`
export function Widget(props: {sizes: number[]; position: number}) {
  const stale = props.sizes
  const count = props.sizes.length
  const index = Math.floor(Math.min(Math.max(props.position, 0), 9))
  const local = props.sizes
  local.pop()
  return <div style={{width: index < count ? stale[index]! - 0 : 0}} />
}
`)
    expect(aliasConst).toHaveLength(1)
    expect(aliasConst[0]).toContain('guard to add: the element read at slots.tsx:8:46 is in bounds')
  })

  test('const-following fallbacks preserve both useful and unsafe results', () => {
    // The width const's ternary condition is a bare number — outside the subset, found
    // only when the lowering runs. The slot must fall back to plain parameter treatment,
    // not demote to skipped: an earlier version lost six gallery findings exactly here.
    expect(slotLines(`
export function Retry(props: {mode: number; size: number}) {
  const width = props.mode ? props.size : 100
  return <div style={{width: width * 2}} />
}
export function Carried(value: any, flag: boolean) {
  const carried: number = flag ? value : 1
  return <div style={{width: carried * 2}} />
}
export function InvalidIndex(props: {values: number[]}) {
  const width = props.values[-1]!
  return <div style={{width}} />
}
`)).toEqual([
      'may overflow to Infinity: style.width at 4:30: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:4:30); assumes: width is finite and not NaN',
      // The any-valued branch lowers, but its mixed abstract value stops when multiplied.
      // Treating carried as a declared-number input still preserves the useful finding.
      'may overflow to Infinity: style.width at 8:30: the value is a possibly non-finite number from -Infinity through Infinity (can overflow at slots.tsx:8:30); assumes: carried is finite and not NaN',
      // Falling back must not hide an actual rejection found in the plain expression.
      'skipped: style.width at 12:23: reads an element provably outside the array (at slots.tsx:11:17)',
    ])
  })
})
