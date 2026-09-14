import {describe, expect, test} from 'bun:test'
import {analyzeProgram} from '../src/engine/analyze.ts'
import {createValueNumbering, staticRelationCapHits} from '../src/engine/transfer.ts'
import {analyzeSource} from '../src/index.ts'
import type {InstructionIR} from '../src/ir/instructions.ts'
import {lowerSource} from '../src/lower/program.ts'
import {createReport, type AnalysisReport} from '../src/report/index.ts'
import {createExpressionContext} from '../src/requirements/infer.ts'
import {checkSource} from '../src/typescript/check.ts'
import {analyzedFunction, requirementsBesidesInputFiniteness} from './analyze-helpers.ts'

// The static-relations prototype is selected per analysis here instead of through
// FREERANGE_STATIC_RELATIONS, so tests in the same process cannot leak the mode.
function analyze(source: string, staticRelations: boolean): AnalysisReport {
  const program = lowerSource(checkSource('relations.ts', source))
  return createReport(program, analyzeProgram(program, staticRelations))
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
    const before = staticRelationCapHits.closureBudget
    expect(verdictsOffAndOn(chainSource('shortChain', 2, 1), 'shortChain')).toEqual({off: ['unproven'], on: ['proven']})
    expect(staticRelationCapHits.closureBudget).toBe(before)
    expect(verdictsOffAndOn(chainSource('longChain', 8, 40), 'longChain')).toEqual({off: ['unproven'], on: ['unproven']})
    expect(staticRelationCapHits.closureBudget).toBeGreaterThan(before)
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
    const before = staticRelationCapHits.factCap
    const off = analyze(source, false)
    const on = analyze(source, true)
    expect(staticRelationCapHits.factCap).toBeGreaterThan(before)
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
    const before = staticRelationCapHits.joinCandidates
    expect(verdictsOffAndOn(source, 'manyBounds')).toEqual({off: ['unproven', 'unproven'], on: ['proven', 'unproven']})
    expect(staticRelationCapHits.joinCandidates).toBeGreaterThan(before)
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
})
