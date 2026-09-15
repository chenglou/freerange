import {describe, expect, test} from 'bun:test'
import {analyzeProgram} from '../src/engine/analyze.ts'
import {blockDominance, cyclicBlocks} from '../src/engine/join-flow.ts'
import {createStaticRelationCounters, createValueNumbering} from '../src/engine/transfer.ts'
import {analyzeSource} from '../src/index.ts'
import type {InstructionIR} from '../src/ir/instructions.ts'
import {lowerSource} from '../src/lower/program.ts'
import {createReport, type AnalysisReport} from '../src/report/index.ts'
import {createExpressionContext} from '../src/requirements/infer.ts'
import {checkSource} from '../src/typescript/check.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

// The static-relations prototype is selected per analysis here instead of through
// FREERANGE_STATIC_RELATIONS, so tests in the same process cannot leak the mode. Passing a
// counters object turns the mode on and collects that analysis's cap hits.
function analyze(source: string, staticRelations: boolean, counters = createStaticRelationCounters()): AnalysisReport {
  const program = lowerSource(checkSource('relations.ts', source))
  return createReport(program, analyzeProgram(program, staticRelations ? counters : null))
}

function assertionVerdicts(report: AnalysisReport, name: string): string[] {
  return analyzedFunction(report, name).assertions?.map(assertion => assertion.verdict) ?? []
}

function verdictsOffAndOn(source: string, name: string): {off: string[]; on: string[]} {
  return {
    off: assertionVerdicts(analyze(source, false), name),
    on: assertionVerdicts(analyze(source, true), name),
  }
}

function range(count: number): number[] {
  return Array.from({length: count}, (_, index) => index)
}

describe('static relations', () => {
  test('are off by default', () => {
    const source = `
      export function transitive(a: number, b: number, c: number) {
        console.assert(a <= b)
        console.assert(b <= c)
        const low = a
        console.assert(low <= c)
      }
    `
    expect(assertionVerdicts(analyzeSource('relations.ts', source), 'transitive')).toEqual(['unproven'])
    expect(verdictsOffAndOn(source, 'transitive')).toEqual({off: ['unproven'], on: ['proven']})
  })

  test('value numbering proves a guard on a recomputed formula and a literal written twice', () => {
    const source = `
      export function recomputedGuard(containerWidth: number) {
        console.assert(containerWidth >= 0)
        console.assert(containerWidth <= 3000)
        const bubbleWidth = Math.max(48, Math.min(280, containerWidth - 16))
        const availableWidth = containerWidth - 16
        if (availableWidth >= 280) console.assert(bubbleWidth >= 280)
      }
      export function literalFactorTwice(firstColumn: number) {
        console.assert(Number.isInteger(firstColumn))
        console.assert(firstColumn >= 0)
        console.assert(firstColumn <= 1000)
        const start = Math.max(0, firstColumn - 2) * 2
        const visibleStart = firstColumn * 2
        console.assert(visibleStart >= start)
      }
    `
    expect(verdictsOffAndOn(source, 'recomputedGuard')).toEqual({off: ['unproven'], on: ['proven']})
    expect(verdictsOffAndOn(source, 'literalFactorTwice')).toEqual({off: ['unproven'], on: ['proven']})
  })

  test('value numbering keeps 0 and -0 apart and never merges two module reads', () => {
    const program = lowerSource(checkSource('relations.ts', `
      export function zeros(x: number): number {
        const plus = x + 0
        const minus = x + -0
        const plusAgain = x + 0
        return plus + minus + plusAgain
      }
    `))
    const fn = program.functions.find(candidate => candidate.name === 'zeros')
    if (fn?.kind !== 'lowered') throw new Error('Expected zeros to lower')
    const numbering = createValueNumbering(createExpressionContext(fn, fn.parameters.map((_, index) => ({kind: 'parameter', index}))))
    const instructions: InstructionIR[] = fn.blocks.flatMap(block => block.instructions)
    const constants = instructions.filter(instruction => instruction.kind === 'constant')
    const positiveZero = constants.find(instruction => Object.is(instruction.value, 0))
    const negativeZero = constants.find(instruction => Object.is(instruction.value, -0))
    if (positiveZero == null || negativeZero == null) throw new Error('Expected both zero constants')
    expect(numbering.ofValue(positiveZero.result)).not.toBe(numbering.ofValue(negativeZero.result))
    const [plus, minus, plusAgain] = instructions.filter(instruction => instruction.kind === 'binary')
    if (plus == null || minus == null || plusAgain == null) throw new Error('Expected three additions')
    expect(numbering.ofValue(plus.result)).toBe(numbering.ofValue(plusAgain.result))
    expect(numbering.ofValue(plus.result)).not.toBe(numbering.ofValue(minus.result))

    const moduleReads = `
      let offset = 0
      export function bump(): void {
        offset = offset + 1
      }
      export function readsAcrossWrite(x: number) {
        console.assert(x >= 0)
        console.assert(x <= 100)
        const before = offset + x
        bump()
        const after = offset + x
        console.assert(after <= before)
      }
    `
    expect(verdictsOffAndOn(moduleReads, 'readsAcrossWrite').on).not.toContain('proven')
  })

  test('order closure chains recorded facts, tracks strictness, and answers max(xs) <= min(ys)', () => {
    const source = `
      export function strictChain(a: number, b: number, c: number) {
        console.assert(a < b)
        console.assert(b <= c)
        const low = a
        console.assert(low < c)
      }
      export function nonStrictChain(a: number, b: number, c: number) {
        console.assert(a <= b)
        console.assert(b <= c)
        const low = a
        console.assert(low < c)
      }
      export function windowOrder(gridWidth: number, gridHeight: number, scrollTop: number, itemCount: number, requestedColumns: number, overscanRows: number) {
        console.assert(gridWidth >= 0)
        console.assert(gridWidth <= 3000)
        console.assert(gridHeight >= 0)
        console.assert(gridHeight <= 3000)
        console.assert(scrollTop >= 0)
        console.assert(scrollTop <= 100000000)
        console.assert(itemCount >= 0)
        console.assert(itemCount <= 10000)
        console.assert(requestedColumns >= 0)
        console.assert(requestedColumns <= 12)
        console.assert(overscanRows >= 0)
        console.assert(overscanRows <= 10)
        const columns = Math.max(1, Math.floor(requestedColumns))
        const cellWidth = gridWidth > 0 ? gridWidth / columns : 1
        const rowHeight = Math.max(1, cellWidth)
        const boundedCount = Math.max(0, Math.floor(itemCount))
        const totalRows = Math.ceil(boundedCount / columns)
        const overscan = Math.max(0, Math.floor(overscanRows))
        const endRow = Math.min(totalRows, Math.ceil((Math.max(0, scrollTop) + Math.max(0, gridHeight)) / rowHeight) + overscan)
        const startRow = Math.max(0, Math.min(Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan, endRow - 1))
        const startIndex = Math.min(boundedCount, startRow * columns)
        const endIndex = Math.min(boundedCount, endRow * columns)
        console.assert(startRow <= endRow)
        console.assert(startIndex <= endIndex)
      }
    `
    expect(verdictsOffAndOn(source, 'strictChain')).toEqual({off: ['unproven'], on: ['proven']})
    expect(verdictsOffAndOn(source, 'nonStrictChain')).toEqual({off: ['unproven'], on: ['unproven']})
    expect(verdictsOffAndOn(source, 'windowOrder')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'proven']})
  })

  test('possibly NaN values stay unproven', () => {
    const source = `
      export function minimumWithParsed(a: number, text: string) {
        const parsed = Number.parseFloat(text)
        const low = Math.min(a, parsed)
        console.assert(low <= a)
      }
    `
    expect(verdictsOffAndOn(source, 'minimumWithParsed').on).toEqual(['unproven'])
  })

  test('sign through order proves a halved slack and a quotient by at least 1, and only for nonnegative bases', () => {
    const source = `
      export function halfSlack(availableWidth: number, requested: number) {
        console.assert(availableWidth >= 0)
        console.assert(availableWidth <= 4000)
        console.assert(requested >= 0)
        console.assert(requested <= 4000)
        const width = Math.min(availableWidth, requested)
        const slack = availableWidth - width
        const half = slack / 2
        console.assert(half >= 0)
      }
      export function quotientAtMostBase(width: number, reserved: number, columns: number) {
        console.assert(width >= 0)
        console.assert(width <= 1000000)
        console.assert(reserved >= 0)
        console.assert(reserved <= 1000000)
        console.assert(Number.isInteger(columns))
        console.assert(columns >= 1)
        console.assert(columns <= 1000)
        const available = width - reserved
        if (available >= 0) {
          const columnWidth = available / columns
          console.assert(columnWidth <= available)
          console.assert(columnWidth <= width)
        }
      }
      export function quotientOfSignedBase(x: number, divisor: number) {
        console.assert(x >= -10)
        console.assert(x <= 10)
        console.assert(divisor >= 1)
        console.assert(divisor <= 10)
        const quotient = x / divisor
        console.assert(quotient <= x)
      }
    `
    expect(verdictsOffAndOn(source, 'halfSlack')).toEqual({off: ['unproven'], on: ['proven']})
    expect(verdictsOffAndOn(source, 'quotientAtMostBase')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'proven']})
    expect(verdictsOffAndOn(source, 'quotientOfSignedBase').on).toEqual(['unproven'])
  })

  test('float round trips and cancellation stay unproven', () => {
    const source = `
      export function roundTrip(right: number, width: number) {
        console.assert(right >= 0)
        console.assert(right <= 5000)
        console.assert(width >= 0)
        console.assert(width <= 1)
        const origin = right - width
        const back = origin + width
        console.assert(back <= right)
      }
      export function cancellation(top: number) {
        console.assert(top >= 0)
        console.assert(top <= 3000)
        const shifted = top - 16
        const restored = shifted + 16
        console.assert(restored === top)
      }
    `
    expect(verdictsOffAndOn(source, 'roundTrip').on).toEqual(['unproven'])
    expect(verdictsOffAndOn(source, 'cancellation').on).toEqual(['unproven'])

    // The guard written as origin + size <= farEdge instead of origin <= farEdge - size: on
    // doubles origin can exceed fl(farEdge - size) by rounding while the sum still fits, so
    // result === origin is false there, while the spelling that reuses farEdge - size proves.
    const clampOrigin = (name: string, guard: string): string => `
      export function ${name}(origin: number, size: number, nearEdge: number, farEdge: number) {
        console.assert(size >= 0)
        console.assert(size <= 4000)
        console.assert(nearEdge >= -4000)
        console.assert(nearEdge <= farEdge)
        console.assert(farEdge <= 4000)
        console.assert(origin >= -4000)
        console.assert(origin <= 4000)
        const result = Math.max(nearEdge, Math.min(origin, Math.max(nearEdge, farEdge - size)))
        const lastFittingOrigin = farEdge - size
        const trailingEdge = origin + size
        if (origin >= nearEdge && ${guard}) {
          console.assert(result === origin)
        }
      }
    `
    expect(verdictsOffAndOn(clampOrigin('inverted', 'trailingEdge <= farEdge'), 'inverted').on).toEqual(['unproven'])
    expect(verdictsOffAndOn(clampOrigin('reused', 'origin <= lastFittingOrigin'), 'reused').on).toEqual(['proven'])
  })

  test('join facts hold on every arm of a clamp, keep a sign, and drop when an arm breaks the bound', () => {
    const source = `
      export function clamp(low: number, value: number, high: number): number {
        console.assert(low <= high)
        const result = value > high ? high : value < low ? low : value
        console.assert(result >= low)
        console.assert(result <= high)
        return result
      }
      export function centeredOrNatural(center: boolean, available: number, content: number, natural: number): number {
        console.assert(available >= 0)
        console.assert(available <= 4000)
        console.assert(content >= 0)
        console.assert(content <= 4000)
        console.assert(natural >= 0)
        console.assert(natural <= 4000)
        const fitted = Math.min(content, available)
        const inner = center ? (available - fitted) / 2 : natural
        const navRight = 70
        const inputLeft = navRight + inner
        console.assert(navRight <= inputLeft)
        return inputLeft
      }
      export function bumpedArm(bumped: boolean, high: number): number {
        console.assert(high >= 0)
        console.assert(high <= 100)
        const result = bumped ? high + 1 : high
        console.assert(result <= high)
        return result
      }
      export function lateArm(flag: boolean, other: boolean, high: number): number {
        console.assert(high >= 0)
        console.assert(high <= 100)
        let result = high
        if (flag) {
          result = high
        } else {
          const bumped = high + 1
          result = other ? bumped : high + 1
        }
        console.assert(result <= high)
        return result
      }
    `
    expect(verdictsOffAndOn(source, 'clamp')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'proven']})
    expect(verdictsOffAndOn(source, 'centeredOrNatural')).toEqual({off: ['unproven'], on: ['proven']})
    expect(verdictsOffAndOn(source, 'bumpedArm').on).toEqual(['unproven'])
    expect(verdictsOffAndOn(source, 'lateArm').on).toEqual(['unproven'])
  })

  test('declared requirements keep origin/main rules, so a call site still reports what only a new rule could discharge', () => {
    const source = `
      function ordered(low: number, high: number): number {
        console.assert(low <= high)
        return high - low
      }
      export function transitiveCaller(a: number, b: number, c: number): number {
        console.assert(a <= b)
        console.assert(b <= c)
        return ordered(a, c)
      }
    `
    const off = requirementsBesidesInputFiniteness(analyzedFunction(analyze(source, false), 'transitiveCaller'))
    const on = requirementsBesidesInputFiniteness(analyzedFunction(analyze(source, true), 'transitiveCaller'))
    expect(on).toEqual(off)
    expect(on.some(requirement => requirement.startsWith('a <= c'))).toBe(true)
  })

  test('closure visit budget: a long chain under a wide max <= min returns unproven once the budget runs out', () => {
    const chainSource = (name: string, operands: number, chainLength: number): string => {
      const parameters = [
        ...range(operands).map(index => `low${index}`),
        ...range(operands).map(index => `high${index}`),
        ...range(chainLength + 1).map(index => `step${index}`),
      ]
      const requirements = [
        ...range(operands).map(index => `console.assert(low${index} <= step0)`),
        ...range(chainLength).map(index => `console.assert(step${index} <= step${index + 1})`),
        ...range(operands).map(index => `console.assert(step${chainLength} <= high${index})`),
      ]
      return `
        export function ${name}(${parameters.map(parameter => `${parameter}: number`).join(', ')}) {
          ${requirements.join('\n')}
          const low = Math.max(${range(operands).map(index => `low${index}`).join(', ')})
          const high = Math.min(${range(operands).map(index => `high${index}`).join(', ')})
          console.assert(low <= high)
        }
      `
    }
    const shortCounters = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(chainSource('shortChain', 2, 1), true, shortCounters), 'shortChain')).toEqual(['proven'])
    expect(shortCounters.closureBudget).toBe(0)
    const longCounters = createStaticRelationCounters()
    expect(verdictsOffAndOn(chainSource('longChain', 8, 40), 'longChain').off).toEqual(['unproven'])
    expect(assertionVerdicts(analyze(chainSource('longChain', 8, 40), true, longCounters), 'longChain')).toEqual(['unproven'])
    expect(longCounters.closureBudget).toBeGreaterThan(0)
  })

  test('fact cap: a helper evaluated with more caller facts than the cap finishes and proves nothing new', () => {
    const pairs = 33
    const parameters = [
      ...range(pairs).flatMap(index => [`left${index}`, `right${index}`]),
      'start',
      'middle',
      'end',
    ]
    const source = `
      function width(low: number, high: number): number {
        const gap = high - low
        console.assert(gap >= 0)
        return gap
      }
      export function manyFacts(${parameters.map(parameter => `${parameter}: number`).join(', ')}): number {
        ${range(pairs).map(index => `console.assert(left${index} === right${index})`).join('\n')}
        console.assert(start <= middle)
        console.assert(middle <= end)
        return width(start, end)
      }
    `
    const counters = createStaticRelationCounters()
    const off = analyze(source, false)
    const on = analyze(source, true, counters)
    expect(counters.factCap).toBeGreaterThan(0)
    expect(assertionVerdicts(on, 'width')).toEqual(assertionVerdicts(off, 'width'))
    expect(requirementsBesidesInputFiniteness(analyzedFunction(on, 'manyFacts')))
      .toEqual(requirementsBesidesInputFiniteness(analyzedFunction(off, 'manyFacts')))
  })

  test('join candidate cap keeps the first 32 verified candidates in a stable order', () => {
    const bounds = 34
    const parameters = ['flag: boolean', 'first: number', 'second: number', ...range(bounds).map(index => `bound${index}: number`)]
    const requirements = range(bounds).flatMap(index => [
      `console.assert(first <= bound${index})`,
      `console.assert(second <= bound${index})`,
    ])
    const source = `
      export function manyBounds(${parameters.join(', ')}) {
        ${requirements.join('\n')}
        const chosen = flag ? first : second
        console.assert(chosen <= bound29)
        console.assert(chosen <= bound30)
      }
    `
    // Candidates on the first arrival, in order: chosen >= 0 fails; chosen <= first and
    // first <= chosen hold (2); second fails both ways; chosen <= bound0 .. bound29 hold (32).
    const counters = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(source, false), 'manyBounds')).toEqual(['unproven', 'unproven'])
    expect(assertionVerdicts(analyze(source, true, counters), 'manyBounds')).toEqual(['proven', 'unproven'])
    expect(counters.joinCandidates).toBeGreaterThan(0)
  })

  test('join facts per state cap: sequential joins keep the newest 64 facts', () => {
    // Each `if` ends in a join with one parameter, and each join verifies up to 32 facts
    // about that parameter, so facts about earlier joins pile up past the cap within a few
    // statements. The last join's facts are the newest, so the assert about x3 still proves.
    // 12 statements hit the cap without exhausting the evaluation's work budget.
    const bounds = range(16).map(index => `b${index}`)
    const source = `
      export function sequentialJoins(s: number, lo: number, hi: number, ${bounds.map(bound => `${bound}: number`).join(', ')}) {
        console.assert(s >= 0)
        console.assert(s <= 12)
        console.assert(lo >= 0)
        console.assert(hi <= 1000)
        ${bounds.map(bound => `console.assert(lo <= ${bound})\nconsole.assert(${bound} <= hi)`).join('\n')}
        let x0 = lo
        let x1 = lo
        let x2 = hi
        let x3 = hi
        ${range(12).map(index => `if (s > ${index}) x${index % 4} = b${index % 16}`).join('\n')}
        console.assert(x3 <= hi)
      }
    `
    const counters = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(source, false), 'sequentialJoins')).toEqual(['unproven'])
    expect(assertionVerdicts(analyze(source, true, counters), 'sequentialJoins')).toEqual(['proven'])
    expect(counters.joinFacts).toBeGreaterThan(0)
    expect(counters.evaluationWork).toBe(0)
  })

  test('evaluation work budget: a function with many wide joins stops relational work, and other functions keep theirs', () => {
    // 16 variables reassigned inside each of 60 sequential ifs: every join has 16 parameters,
    // each proposing candidates against every bound. Without a total budget the work grows
    // roughly with the cube of the statement count (400 ifs ran past 300 s).
    const variables = range(16)
    const source = `
      export function wideJoins(s: number, lo: number, hi: number, b0: number, b1: number, b2: number, b3: number) {
        console.assert(s >= 0)
        console.assert(s <= 60)
        console.assert(lo >= 0)
        console.assert(hi <= 1000)
        ${range(4).map(index => `console.assert(lo <= b${index})\nconsole.assert(b${index} <= hi)`).join('\n')}
        ${variables.map(index => `let x${index} = lo`).join('\n')}
        ${range(60).map(join => `if (s > ${join}) {\n${variables.map(index => `x${index} = b${(join + index) % 4}`).join('\n')}\n}`).join('\n')}
        ${variables.map(index => `console.assert(x${index} <= hi)`).join('\n')}
      }
      export function clamp(low: number, value: number, high: number): number {
        console.assert(low <= high)
        const result = value > high ? high : value < low ? low : value
        console.assert(result >= low)
        console.assert(result <= high)
        return result
      }
    `
    const counters = createStaticRelationCounters()
    const off = analyze(source, false)
    const on = analyze(source, true, counters)
    expect(counters.evaluationWork).toBeGreaterThan(0)
    const offVerdicts = assertionVerdicts(off, 'wideJoins')
    const onVerdicts = assertionVerdicts(on, 'wideJoins')
    expect(onVerdicts).toHaveLength(offVerdicts.length)
    offVerdicts.forEach((verdict, index) => {
      if (verdict === 'proven') expect(onVerdicts[index]).toBe('proven')
    })
    expect(assertionVerdicts(on, 'clamp')).toEqual(['proven', 'proven'])
  })

  test('block dominance and cycles match their definitions on random control flow graphs', () => {
    let seed = 91415
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
    // Definitions: `dominator` dominates a reachable `block` when no path from the entry
    // reaches `block` once `dominator` is removed; a block is on a cycle when it reaches itself
    // through one or more edges.
    const reachableAvoiding = (successors: number[][], entry: number, avoided: number | null): boolean[] => {
      const reached: boolean[] = []
      if (entry === avoided) return reached
      reached[entry] = true
      const queue = [entry]
      for (let index = 0; index < queue.length; index++) {
        for (const next of successors[queue[index]!]!) {
          if (next === avoided || reached[next] === true) continue
          reached[next] = true
          queue.push(next)
        }
      }
      return reached
    }
    const reachesItself = (successors: number[][], block: number): boolean => {
      const reached: boolean[] = []
      const queue = [...successors[block]!]
      for (let index = 0; index < queue.length; index++) {
        const next = queue[index]!
        if (next === block) return true
        if (reached[next] === true) continue
        reached[next] = true
        queue.push(...successors[next]!)
      }
      return false
    }
    const check = (successors: number[][]): boolean => {
      const dominance = blockDominance(successors, 0)
      const cyclic = cyclicBlocks(successors)
      const reachable = reachableAvoiding(successors, 0, null)
      for (let block = 0; block < successors.length; block++) {
        expect(`${JSON.stringify(successors)} cyclic ${block}: ${cyclic[block]}`).toBe(`${JSON.stringify(successors)} cyclic ${block}: ${reachesItself(successors, block)}`)
        for (let dominator = 0; dominator < successors.length; dominator++) {
          const claimed = dominance.dominates(dominator, block)
          if (reachable[block] !== true) {
            expect(claimed).toBe(false)
            continue
          }
          const definition = dominator === block || reachableAvoiding(successors, 0, dominator)[block] !== true
          // Reducible graphs get exact dominance; otherwise only the entry and the block itself.
          const expected = dominance.reducible ? definition : dominator === 0 || dominator === block
          expect(`${JSON.stringify(successors)} ${dominator} dominates ${block}: ${claimed}`).toBe(`${JSON.stringify(successors)} ${dominator} dominates ${block}: ${expected}`)
        }
      }
      return dominance.reducible
    }
    // Two entries into one cycle: the classic irreducible graph.
    expect(check([[1, 2], [2], [1]])).toBe(false)
    // A loop with a break and a continue, as lowered structured code produces.
    expect(check([[1], [2, 5], [3, 4], [1], [5, 1], []])).toBe(true)
    let reducible = 0
    let irreducible = 0
    for (let graph = 0; graph < 3000; graph++) {
      const blockCount = 1 + Math.floor(random() * 9)
      const successors = range(blockCount).map(() => {
        const shape = random()
        const target = (): number => Math.floor(random() * blockCount)
        return shape < 0.25 ? [] : shape < 0.6 ? [target()] : [target(), target()]
      })
      if (check(successors)) reducible++
      else irreducible++
    }
    // Both outcomes are exercised: with this seed, 67 of the 3000 graphs are irreducible.
    expect(reducible).toBeGreaterThan(30)
    expect(irreducible).toBeGreaterThan(30)
  })

  test('values computed on one arm never feed the closure after the join', () => {
    // False for x = 50, target = 5: the arm computing capped runs only when x <= 5.
    const source = `
      export function armOnlyValue(flag: boolean, x: number, target: number): number {
        console.assert(x >= 0)
        console.assert(x <= 100)
        console.assert(target >= 5)
        console.assert(target <= 100)
        let bound = 0
        if (x <= 5) {
          const capped = Math.max(x, 1)
          bound = capped
        } else {
          if (flag) {
            bound = 1
          } else {
            bound = 2
          }
        }
        console.assert(x <= target)
        return bound
      }
    `
    expect(verdictsOffAndOn(source, 'armOnlyValue').on).toEqual(['unproven'])
  })

  test('integer offsets move a bound across an exact addition, and never past 2^53', () => {
    const offset = (name: string, limit: string): string => `
      export function ${name}(rowCount: number, other: number) {
        console.assert(Number.isInteger(rowCount))
        console.assert(rowCount >= 0)
        console.assert(rowCount <= ${limit})
        console.assert(Number.isInteger(other))
        console.assert(other >= -10)
        console.assert(other <= ${limit})
        const lastRow = Math.min(rowCount - 1, other)
        const end = lastRow + 1
        console.assert(end <= rowCount)
        console.assert(lastRow < end)
      }
    `
    expect(verdictsOffAndOn(offset('safeOffset', '10000'), 'safeOffset')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'proven']})
    // rowCount = 2^53 + 2: rowCount - 1 rounds to 2^53, and 2^53 + 1 rounds back to 2^53, so
    // lastRow < end is false.
    expect(verdictsOffAndOn(offset('pastSafeRange', '9007199254740994'), 'pastSafeRange').on).toEqual(['unproven', 'unproven'])
  })

  test('no generated assert that fails on a concrete input is reported proven', () => {
    let seed = 20260914
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
    const pick = <Item>(items: Item[]): Item => items[Math.floor(random() * items.length)]!
    type Inputs = {values: Map<string, number>; flag: boolean}
    type Condition = {text: string; holds: (inputs: Inputs) => boolean}
    type Statement =
      | {kind: 'requirement' | 'assert' | 'guard'; condition: Condition}
      | {kind: 'const'; name: string; text: string; evaluate: (inputs: Inputs) => number}
    const read = (inputs: Inputs, name: string): number => {
      const value = inputs.values.get(name)
      if (value == null) throw new Error(`Unbound ${name}`)
      return value
    }
    const comparison = (left: string, operator: '<=' | '<' | '>=' | '>' | '===', right: string): Condition => ({
      text: `${left} ${operator} ${right}`,
      holds: inputs => {
        const leftValue = read(inputs, left)
        const rightValue = read(inputs, right)
        switch (operator) {
          case '<=': return leftValue <= rightValue
          case '<': return leftValue < rightValue
          case '>=': return leftValue >= rightValue
          case '>': return leftValue > rightValue
          case '===': return leftValue === rightValue
        }
      },
    })
    const bounded = (name: string, operator: '>=' | '<=', bound: number): Condition => ({
      text: `${name} ${operator} ${bound}`,
      holds: inputs => operator === '>=' ? read(inputs, name) >= bound : read(inputs, name) <= bound,
    })
    const formulas: Array<(left: string, right: string) => {text: string; evaluate: (inputs: Inputs) => number}> = [
      (left, right) => ({text: `${left} - ${right}`, evaluate: inputs => read(inputs, left) - read(inputs, right)}),
      (left, right) => ({text: `${left} + ${right}`, evaluate: inputs => read(inputs, left) + read(inputs, right)}),
      left => ({text: `${left} / 2`, evaluate: inputs => read(inputs, left) / 2}),
      left => ({text: `${left} * 2`, evaluate: inputs => read(inputs, left) * 2}),
      left => ({text: `${left} / 3`, evaluate: inputs => read(inputs, left) / 3}),
      (left, right) => ({text: `Math.min(${left}, ${right})`, evaluate: inputs => Math.min(read(inputs, left), read(inputs, right))}),
      (left, right) => ({text: `Math.max(${left}, ${right})`, evaluate: inputs => Math.max(read(inputs, left), read(inputs, right))}),
      left => ({text: `Math.max(0, ${left})`, evaluate: inputs => Math.max(0, read(inputs, left))}),
      (left, right) => ({text: `flag ? ${left} : ${right}`, evaluate: inputs => inputs.flag ? read(inputs, left) : read(inputs, right)}),
      left => ({text: `${left} - 1`, evaluate: inputs => read(inputs, left) - 1}),
      left => ({text: `${left} + 0.1`, evaluate: inputs => read(inputs, left) + 0.1}),
      (left, right) => ({text: `(${left} - ${right}) / 2`, evaluate: inputs => (read(inputs, left) - read(inputs, right)) / 2}),
      (left, right) => ({text: `Math.min(${left}, ${right} - 1)`, evaluate: inputs => Math.min(read(inputs, left), read(inputs, right) - 1)}),
      (left, right) => ({text: `${left} > ${right} ? ${right} : ${left}`, evaluate: inputs => read(inputs, left) > read(inputs, right) ? read(inputs, right) : read(inputs, left)}),
    ]
    const generate = (): Statement[] => {
      const pool = ['a', 'b', 'c']
      const statements: Statement[] = []
      for (const name of pool) {
        statements.push({kind: 'requirement', condition: bounded(name, '>=', -8)})
        statements.push({kind: 'requirement', condition: bounded(name, '<=', 8)})
      }
      if (random() < 0.5) statements.push({kind: 'requirement', condition: comparison('a', '<=', 'b')})
      if (random() < 0.3) statements.push({kind: 'requirement', condition: comparison('b', '<', 'c')})
      for (let index = 0; index < 5; index++) {
        const left = pick(pool)
        const right = pick(pool.filter(name => name !== left))
        const formula = pick(formulas)(left, right)
        const name = `v${index}`
        statements.push({kind: 'const', name, ...formula})
        pool.push(name)
      }
      const guarded = random() < 0.5
      if (guarded) {
        const left = pick(pool)
        statements.push({kind: 'guard', condition: comparison(left, '<=', pick(pool.filter(name => name !== left)))})
      }
      for (let index = 0; index < 4; index++) {
        const left = pick(pool)
        statements.push({kind: 'assert', condition: comparison(left, pick(['<=', '<', '>=', '>', '==='] as const), pick(pool.filter(name => name !== left)))})
      }
      statements.push({kind: 'assert', condition: {text: `${pool[pool.length - 1]} >= 0`, holds: inputs => read(inputs, pool[pool.length - 1]!) >= 0}})
      return statements
    }
    const functionCount = 150
    const generated = range(functionCount).map(generate)
    const source = generated.map((statements, index) => {
      const lines = statements.map(statement => {
        switch (statement.kind) {
          case 'requirement':
          case 'assert': return `console.assert(${statement.condition.text})`
          case 'guard': return `if (${statement.condition.text}) {`
          case 'const': return `const ${statement.name} = ${statement.text}`
        }
      })
      if (statements.some(statement => statement.kind === 'guard')) lines.push('}')
      return `export function generated${index}(a: number, b: number, c: number, flag: boolean): void {\n${lines.join('\n')}\n}`
    }).join('\n')
    // One concrete run: requirements that fail end the run, a failed guard skips the asserts
    // below it, and every assert that evaluates false is recorded.
    const execute = (statements: Statement[], inputs: Inputs, failed: Set<number>): void => {
      let assertIndex = 0
      for (const statement of statements) {
        switch (statement.kind) {
          case 'requirement':
            if (!statement.condition.holds(inputs)) return
            break
          case 'guard':
            if (!statement.condition.holds(inputs)) return
            break
          case 'const':
            inputs.values.set(statement.name, statement.evaluate(inputs))
            break
          case 'assert':
            if (!statement.condition.holds(inputs)) failed.add(assertIndex)
            assertIndex++
            break
        }
      }
    }
    const off = analyze(source, false)
    const on = analyze(source, true)
    const samples = [-8, -3, -1, -0.5, -0, 0, 0.1, 0.3, 1, 2, 3, 7.9, 8]
    let provenOff = 0
    let provenOn = 0
    let failingAsserts = 0
    for (let index = 0; index < functionCount; index++) {
      const statements = generated[index]!
      const failed = new Set<number>()
      for (const a of samples) for (const b of samples) for (const c of samples) for (const flag of [false, true]) {
        execute(statements, {values: new Map([['a', a], ['b', b], ['c', c]]), flag}, failed)
      }
      const onVerdicts = assertionVerdicts(on, `generated${index}`)
      const offVerdicts = assertionVerdicts(off, `generated${index}`)
      const assertCount = statements.filter(statement => statement.kind === 'assert').length
      expect(onVerdicts).toHaveLength(assertCount)
      for (let assertion = 0; assertion < assertCount; assertion++) {
        if (failed.has(assertion)) {
          failingAsserts++
          expect(`generated${index} assert ${assertion}: ${onVerdicts[assertion]}`).not.toEndWith(': proven')
        }
        if (offVerdicts[assertion] === 'proven') {
          provenOff++
          expect(onVerdicts[assertion]).toBe('proven')
        }
        if (onVerdicts[assertion] === 'proven') provenOn++
      }
    }
    expect(failingAsserts).toBeGreaterThan(100)
    expect(provenOn).toBeGreaterThan(provenOff)
  })

  test('integer linear forms prove offsets over uncomputed differences, and never for floats, past 2^53, or with one operand of a selection', () => {
    const source = `
      export function pickerWindow(count: number, endColumn: number) {
        console.assert(Number.isInteger(count))
        console.assert(count >= 1)
        console.assert(count <= 10000)
        console.assert(Number.isInteger(endColumn))
        console.assert(endColumn >= 0)
        console.assert(endColumn <= 10000)
        const end = Math.min(count, (endColumn + 2) * 2)
        const visibleEnd = Math.min(count - 1, endColumn * 2 - 1)
        const lastMounted = end - 1
        console.assert(visibleEnd <= lastMounted)
        console.assert(visibleEnd < end)
      }
      export function guards(i: number, n: number) {
        console.assert(Number.isInteger(i))
        console.assert(i >= 0)
        console.assert(i <= 1000)
        console.assert(Number.isInteger(n))
        console.assert(n >= 0)
        console.assert(n <= 1000)
        const next = i + 1
        if (i < n) {
          console.assert(next <= n)
        }
        if (i <= n) {
          console.assert(next <= n)
        }
      }
      export function fractional(x: number) {
        console.assert(x >= 0)
        console.assert(x <= 10)
        const low = Math.min(x - 1, 5)
        const back = low + 1
        console.assert(back <= x)
      }
      export function pastSafeRange(x: number) {
        console.assert(Number.isInteger(x))
        console.assert(x >= 0)
        console.assert(x <= 1152921504606846976)
        const y = x + 1
        const back = y - x
        console.assert(back >= 1)
        console.assert(x < y)
      }
      export function pickerOffByOne(count: number, endColumn: number) {
        console.assert(Number.isInteger(count))
        console.assert(count >= 1)
        console.assert(count <= 10000)
        console.assert(Number.isInteger(endColumn))
        console.assert(endColumn >= 0)
        console.assert(endColumn <= 10000)
        const end = Math.min(count, 2 * endColumn + 1)
        const visibleEnd = Math.min(count - 1, 2 * endColumn + 1)
        const lastMounted = end - 1
        console.assert(visibleEnd <= lastMounted)
      }
      export function selections(a: number, b: number) {
        console.assert(Number.isInteger(a))
        console.assert(a >= 0)
        console.assert(a <= 100)
        console.assert(Number.isInteger(b))
        console.assert(b >= 0)
        console.assert(b <= 100)
        const high = Math.max(a, b)
        const limit = a + 1
        console.assert(high <= limit)
        const low = Math.min(a, b)
        const floor = a - 1
        console.assert(floor <= low)
      }
    `
    expect(verdictsOffAndOn(source, 'pickerWindow')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'proven']})
    expect(verdictsOffAndOn(source, 'guards')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'unproven']})
    // x = 0.3: fl(fl(0.3 - 1) + 1) = 0.30000000000000004.
    expect(verdictsOffAndOn(source, 'fractional').on).toEqual(['unproven'])
    // x = 2^60: x + 1 rounds to x.
    expect(verdictsOffAndOn(source, 'pastSafeRange').on).toEqual(['unproven', 'unproven'])
    // endColumn = 0, count = 2: visibleEnd = 1 and lastMounted = 0.
    expect(verdictsOffAndOn(source, 'pickerOffByOne').on).toEqual(['unproven'])
    // b = a + 5 breaks the first, b = a - 3 the second.
    expect(verdictsOffAndOn(source, 'selections').on).toEqual(['unproven', 'unproven'])
  })

  test('linear form caps: a ninth leaf keeps the sum as one leaf, and the substitution search stops at its depth', () => {
    const sumSource = (name: string, leaves: number): string => {
      const names = range(leaves).map(index => `x${index}`)
      return `
        export function ${name}(${names.map(leaf => `${leaf}: number`).join(', ')}) {
          ${names.map(leaf => `console.assert(Number.isInteger(${leaf}))\nconsole.assert(${leaf} >= 0)\nconsole.assert(${leaf} <= 100)`).join('\n')}
          const total = ${names.join(' + ')}
          const rest = ${names.slice(1).join(' + ')}
          const withoutFirst = total - x0
          console.assert(withoutFirst <= rest)
        }
      `
    }
    const eightCounters = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(sumSource('eightLeaves', 8), false), 'eightLeaves')).toEqual(['unproven'])
    expect(assertionVerdicts(analyze(sumSource('eightLeaves', 8), true, eightCounters), 'eightLeaves')).toEqual(['proven'])
    expect(eightCounters.linearForm).toBe(0)
    const nineCounters = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(sumSource('nineLeaves', 9), true, nineCounters), 'nineLeaves')).toEqual(['unproven'])
    expect(nineCounters.linearForm).toBeGreaterThan(0)

    // Proving chain <= (k + 2) * 2 - 1 walks down every Math.min to 2 * k + 3, one substitution
    // per level plus one for the last operand.
    const chainSource = (name: string, levels: number): string => {
      const others = range(levels).map(index => `other${index}`)
      return `
        export function ${name}(k: number, ${others.map(other => `${other}: number`).join(', ')}) {
          console.assert(Number.isInteger(k))
          console.assert(k >= 0)
          console.assert(k <= 100)
          ${others.map(other => `console.assert(Number.isInteger(${other}))\nconsole.assert(${other} >= 0)\nconsole.assert(${other} <= 1000)`).join('\n')}
          const m0 = Math.min(2 * k + 3, other0)
          ${range(levels - 1).map(index => `const m${index + 1} = Math.min(m${index}, other${index + 1})`).join('\n')}
          const limit = (k + 2) * 2 - 1
          console.assert(m${levels - 1} <= limit)
        }
      `
    }
    // The shallow search also reaches the depth cap on branches that do not close, so only the
    // deep chain's verdict shows the cap costing a proof.
    expect(assertionVerdicts(analyze(chainSource('shallowChain', 5), false), 'shallowChain')).toEqual(['unproven'])
    expect(assertionVerdicts(analyze(chainSource('shallowChain', 5), true), 'shallowChain')).toEqual(['proven'])
    const deepCounters = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(chainSource('deepChain', 7), true, deepCounters), 'deepChain')).toEqual(['unproven'])
    expect(deepCounters.linearDepth).toBeGreaterThan(0)
  })

  test('linear visit budget: a wide tree of Math.min values stops the search, and a bound its first branch reaches still proves', () => {
    // Three levels of four Math.min values, each over the previous level plus 1 to 4. Against an
    // unrelated limit every branch fails, and the tree has more branches than the budget allows.
    const treeSource = (name: string, bound: string): string => {
      const lines: string[] = []
      let previous = ['p0', 'p1', 'p2', 'p3']
      for (let level = 1; level <= 3; level++) {
        const current = range(4).map(index => `l${level}v${index}`)
        current.forEach((value, index) => lines.push(`const ${value} = Math.min(${previous.map(operand => `${operand} + ${index + 1}`).join(', ')})`))
        previous = current
      }
      return `
        export function ${name}(p0: number, p1: number, p2: number, p3: number, limit: number) {
          ${['p0', 'p1', 'p2', 'p3', 'limit'].map(parameter => `console.assert(Number.isInteger(${parameter}))\nconsole.assert(${parameter} >= 0)\nconsole.assert(${parameter} <= 1000)`).join('\n')}
          ${lines.join('\n')}
          const s = Math.min(${previous.join(', ')})
          const bound = ${bound}
          console.assert(s <= bound)
        }
      `
    }
    const unrelated = createStaticRelationCounters()
    // limit = 0 with every p at 1000 makes it false.
    expect(assertionVerdicts(analyze(treeSource('unrelatedLimit', 'limit + 1'), true, unrelated), 'unrelatedLimit')).toEqual(['unproven'])
    expect(unrelated.linearBudget).toBeGreaterThan(0)
    const reached = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(treeSource('reachedLimit', 'p0 + 6'), false), 'reachedLimit')).toEqual(['unproven'])
    expect(assertionVerdicts(analyze(treeSource('reachedLimit', 'p0 + 6'), true, reached), 'reachedLimit')).toEqual(['proven'])
    expect(reached.linearBudget).toBe(0)
  })

  test('arm splitting proves every incoming argument against a bound computed after the join, and stops at the depth cap', () => {
    const source = `
      export function srefHeight(count: number, cellSize: number, expanded: boolean) {
        console.assert(Number.isInteger(count))
        console.assert(count >= 0)
        console.assert(count <= 10000)
        console.assert(cellSize >= 1)
        console.assert(cellSize <= 500)
        const rowCount = Math.ceil(count / 6)
        const visibleRows = Math.min(rowCount, expanded ? 4 : 1)
        const height = visibleRows === 0 ? 0 : visibleRows * cellSize + (visibleRows - 1) * 8
        const fourRows = 4 * cellSize + 3 * 8
        const fourRowLimit = fourRows + 0.001
        console.assert(height <= fourRowLimit)
      }
      export function falseArm(flag: boolean, a: number, b: number) {
        console.assert(a >= 0)
        console.assert(a <= 100)
        console.assert(b >= 0)
        console.assert(b <= 100)
        const chosen = flag ? a : b
        const limit = a + 0
        console.assert(chosen <= limit)
      }
      export function refinedArm(x: number) {
        console.assert(x >= 0)
        console.assert(x <= 100)
        let v = 0
        if (x > 50) {
          v = x
        } else {
          v = 10
        }
        const limit = 60
        console.assert(v <= limit)
      }
      export function armInLoop(lo: number, hi: number, steps: number, flag: boolean) {
        console.assert(lo >= 0)
        console.assert(lo < hi)
        console.assert(hi <= 100)
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 4)
        let previous = lo
        for (let i = 0; i < steps; i++) {
          const chosen = flag ? previous : lo
          const limit = lo + 0
          console.assert(chosen <= limit)
          previous = hi
        }
      }
      export function twoLevels(a: boolean, b: boolean, s: number) {
        console.assert(s >= 1)
        console.assert(s <= 100)
        const inner = a ? 2 * s : 3 * s
        const middle = b ? inner : s
        const limit = 4 * s
        console.assert(middle <= limit)
      }
    `
    expect(verdictsOffAndOn(source, 'srefHeight')).toEqual({off: ['unproven'], on: ['proven']})
    expect(verdictsOffAndOn(source, 'twoLevels')).toEqual({off: ['unproven'], on: ['proven']})
    // b > a; x = 100; previous = hi on the second iteration.
    expect(verdictsOffAndOn(source, 'falseArm').on).toEqual(['unproven'])
    expect(verdictsOffAndOn(source, 'refinedArm').on).toEqual(['unproven'])
    expect(verdictsOffAndOn(source, 'armInLoop').on).toEqual(['unproven'])

    const threeLevels = `
      export function threeLevels(a: boolean, b: boolean, c: boolean, s: number) {
        console.assert(s >= 1)
        console.assert(s <= 100)
        const inner = a ? 2 * s : 3 * s
        const middle = b ? inner : s
        const outer = c ? middle : 0
        const limit = 4 * s
        console.assert(outer <= limit)
      }
    `
    const counters = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(threeLevels, true, counters), 'threeLevels')).toEqual(['unproven'])
    expect(counters.armSplit).toBeGreaterThan(0)
  })

  test('return relations publish the order between a call result and its arguments that holds on every return path', () => {
    const source = `
      function clampOrigin(origin: number, size: number, nearEdge: number, farEdge: number): number {
        return Math.max(nearEdge, Math.min(origin, Math.max(nearEdge, farEdge - size)))
      }
      export function placed(origin: number, size: number, anchored: boolean, farEdge: number) {
        console.assert(origin >= -1000)
        console.assert(origin <= 1000)
        console.assert(size >= 0)
        console.assert(size <= 1000)
        console.assert(farEdge >= 0)
        console.assert(farEdge <= 1000)
        const margin = anchored ? 16 : 8
        const left = clampOrigin(origin, size, margin, farEdge)
        console.assert(left >= margin)
      }
      function bump(x: number): number {
        return x + 1
      }
      export function bumped(a: number) {
        console.assert(a >= 0)
        console.assert(a <= 100)
        const result = bump(a)
        console.assert(result <= a)
        console.assert(result >= a)
      }
      function pick(x: number, y: number, flag: boolean): number {
        return flag ? x : y
      }
      export function picked(a: number, b: number, flag: boolean) {
        console.assert(a >= 0)
        console.assert(a <= 100)
        console.assert(b >= 0)
        console.assert(b <= 100)
        const result = pick(a, b, flag)
        console.assert(result >= a)
      }
      function keepAbove(v: number, low: number): number {
        return Math.max(low, v)
      }
      export function twoCalls(a: number, b: number, lo1: number, lo2: number) {
        console.assert(a >= 0)
        console.assert(a <= 100)
        console.assert(b >= 0)
        console.assert(b <= 100)
        console.assert(lo1 >= 0)
        console.assert(lo1 <= 100)
        console.assert(lo2 >= 0)
        console.assert(lo2 <= 100)
        const first = keepAbove(a, lo1)
        const second = keepAbove(b, lo2)
        console.assert(first >= lo1)
        console.assert(second >= lo1)
      }
      function halve(x: number): number {
        return x / 2
      }
      export function signed(a: number, positive: boolean) {
        console.assert(a >= -10)
        console.assert(a <= 10)
        const value = positive ? Math.abs(a) : a
        const half = halve(value)
        console.assert(half <= value)
      }
    `
    expect(verdictsOffAndOn(source, 'placed')).toEqual({off: ['unproven'], on: ['proven']})
    expect(verdictsOffAndOn(source, 'bumped')).toEqual({off: ['unproven', 'unproven'], on: ['unproven', 'proven']})
    // flag false with b < a; lo2 < lo1 with b < lo1; a = -4.
    expect(verdictsOffAndOn(source, 'picked').on).toEqual(['unproven'])
    expect(verdictsOffAndOn(source, 'twoCalls').on).toEqual(['proven', 'unproven'])
    expect(verdictsOffAndOn(source, 'signed').on).toEqual(['unproven'])
    const off = requirementsBesidesInputFiniteness(analyzedFunction(analyze(source, false), 'placed'))
    const on = requirementsBesidesInputFiniteness(analyzedFunction(analyze(source, true), 'placed'))
    expect(on).toEqual(off)
  })

  test('return relation caps: a callee with more than 8 return blocks or more than 16 parameters publishes nothing past the cap', () => {
    const returnsSource = (name: string, returns: number): string => `
      function keepAbove(k: number, v: number, low: number): number {
        ${range(returns - 1).map(index => `if (k === ${index}) return Math.max(low, v - ${index})`).join('\n')}
        return Math.max(low, v)
      }
      export function ${name}(k: number, v: number, low: number) {
        console.assert(Number.isInteger(k))
        console.assert(k >= 0)
        console.assert(k <= 20)
        console.assert(v >= 0)
        console.assert(v <= 100)
        console.assert(low >= 0)
        console.assert(low <= 100)
        const result = keepAbove(k, v, low)
        console.assert(result >= low)
      }
    `
    const eightReturns = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(returnsSource('eightReturns', 8), false), 'eightReturns')).toEqual(['unproven'])
    expect(assertionVerdicts(analyze(returnsSource('eightReturns', 8), true, eightReturns), 'eightReturns')).toEqual(['proven'])
    expect(eightReturns.returnRelations).toBe(0)
    const nineReturns = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(returnsSource('nineReturns', 9), true, nineReturns), 'nineReturns')).toEqual(['unproven'])
    expect(nineReturns.returnRelations).toBeGreaterThan(0)

    const padding = range(16).map(index => `pad${index}`)
    const parametersSource = (name: string, lowFirst: boolean): string => {
      const parameters = lowFirst ? ['low', ...padding, 'v'] : [...padding, 'low', 'v']
      return `
        function keepAbove(${parameters.map(parameter => `${parameter}: number`).join(', ')}): number {
          return Math.max(low, v)
        }
        export function ${name}(v: number, low: number) {
          console.assert(v >= 0)
          console.assert(v <= 100)
          console.assert(low >= 0)
          console.assert(low <= 100)
          const result = keepAbove(${parameters.map(parameter => parameter.startsWith('pad') ? '0' : parameter).join(', ')})
          console.assert(result >= low)
        }
      `
    }
    expect(assertionVerdicts(analyze(parametersSource('lowFirst', true), true), 'lowFirst')).toEqual(['proven'])
    const lowLast = createStaticRelationCounters()
    expect(assertionVerdicts(analyze(parametersSource('lowLast', false), true, lowLast), 'lowLast')).toEqual(['unproven'])
    expect(lowLast.returnRelations).toBeGreaterThan(0)
  })

  test('join facts at loop headers hold on every arrival, and drop when an iteration breaks them', () => {
    const source = `
      export function clamped(lo: number, hi: number, steps: number) {
        console.assert(lo >= 0)
        console.assert(lo <= hi)
        console.assert(hi <= 100)
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 8)
        let x = lo
        for (let i = 0; i < steps; i++) {
          x = Math.min(x + 1, hi)
        }
        console.assert(x <= hi)
        console.assert(x >= lo)
      }
      export function counter(n: number) {
        console.assert(Number.isInteger(n))
        console.assert(n >= 0)
        console.assert(n <= 20)
        let i = 0
        while (i < n) {
          const next = i + 1
          console.assert(next <= n)
          i = next
        }
        console.assert(i <= n)
      }
      export function bumped(lo: number, hi: number, steps: number) {
        console.assert(Number.isInteger(lo))
        console.assert(lo >= 0)
        console.assert(Number.isInteger(hi))
        console.assert(lo <= hi)
        console.assert(hi <= 5)
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 8)
        let x = lo
        for (let i = 0; i < steps; i++) {
          x = x + 1
        }
        console.assert(x <= hi)
      }
      export function swapped(lo: number, hi: number, steps: number) {
        console.assert(lo >= 0)
        console.assert(lo < hi)
        console.assert(hi <= 100)
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 5)
        let a = lo
        let b = hi
        for (let i = 0; i < steps; i++) {
          const t = a
          a = b
          b = t
        }
        console.assert(a <= b)
      }
      export function shifted(lo: number, hi: number, steps: number) {
        console.assert(lo >= 0)
        console.assert(lo < hi)
        console.assert(hi <= 100)
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 8)
        let p0 = lo
        let p1 = lo
        let p2 = lo
        for (let i = 0; i < steps; i++) {
          p2 = p1
          p1 = p0
          p0 = hi
        }
        console.assert(p2 <= lo)
      }
      export function innerJoin(lo: number, hi: number, steps: number) {
        console.assert(lo >= 0)
        console.assert(lo < hi)
        console.assert(hi <= 100)
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 6)
        let m = lo
        for (let i = 0; i < steps; i++) {
          const v = i % 2 === 0 ? hi : lo
          m = v
        }
        console.assert(m <= lo)
      }
      export function outerBound(steps: number) {
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 4)
        let x = 0
        for (let j = 0; j < steps; j++) {
          const limit = j
          for (let k = 0; k < 2; k++) {
            x = limit
          }
        }
        console.assert(x <= 0)
      }
      export function offByOne(n: number) {
        console.assert(Number.isInteger(n))
        console.assert(n >= 0)
        console.assert(n <= 20)
        let i = 0
        while (i <= n) {
          i = i + 1
        }
        console.assert(i <= n)
      }
    `
    expect(verdictsOffAndOn(source, 'clamped')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'proven']})
    expect(verdictsOffAndOn(source, 'counter')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'proven']})
    // Each is false for some in-domain input: hi - lo + 1 steps, one step, three steps, the
    // first step, two steps, and every n.
    for (const name of ['bumped', 'swapped', 'shifted', 'innerJoin', 'outerBound', 'offByOne']) {
      expect(`${name}: ${verdictsOffAndOn(source, name).on.join(', ')}`).toBe(`${name}: unproven`)
    }
  })

  test('loop header re-runs that only drop join facts stop at their cap and add no loop limit stop', () => {
    // 20 variables shift one step per iteration. Each keeps `p <= lo` and `lo <= p` at the header
    // until the value of other reaches it, one variable per re-run, while every interval stays the
    // same: the drops are the only change, and there are more of them than the cap allows.
    const variables = range(20)
    const source = `
      export function shiftRegister(lo: number, other: number, steps: number) {
        console.assert(Number.isInteger(steps))
        console.assert(steps >= 0)
        console.assert(steps <= 50)
        ${variables.map(index => `let p${index} = lo`).join('\n')}
        for (let i = 0; i < steps; i++) {
          ${variables.slice(1).reverse().map(index => `p${index} = p${index - 1}`).join('\n')}
          p0 = other
        }
        console.assert(p19 <= lo)
      }
    `
    const counters = createStaticRelationCounters()
    const on = analyze(source, true, counters)
    expect(counters.loopJoinFacts).toBeGreaterThan(0)
    expect(analyzedFunction(on, 'shiftRegister').kind).toBe('analyzed')
    expect(assertionVerdicts(on, 'shiftRegister')).toEqual(assertionVerdicts(analyze(source, false), 'shiftRegister'))
  })
})
