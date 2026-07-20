import {expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {
  analyzeSource,
  auditSource,
  formatFileAuditUnit,
  refactorGuide,
  refactorGuides,
  type AnalysisReport,
  type RefactorGuideID,
} from '../src/index.ts'

function functionReport(report: AnalysisReport, name: string) {
  const result = report.functions.find(candidate => candidate.name === name)
  if (result == null) throw new Error(`Missing function ${name}`)
  return result
}

function analyzed(report: AnalysisReport, name: string) {
  const result = functionReport(report, name)
  if (result.kind !== 'analyzed') throw new Error(`Expected ${name} to be analyzed, got ${result.kind}`)
  return result
}

function nonInputRequirements(report: AnalysisReport, name: string): string[] {
  return analyzed(report, name).requires.filter(requirement =>
    !requirement.startsWith('Number.isFinite(')
    && !requirement.startsWith('every number field in '))
}

function isNonInputRequirement(reference: ReturnType<typeof auditSource>['references'][number]): boolean {
  if (reference.reason.kind !== 'requires') return false
  const {precondition} = reference.reason
  return precondition.kind !== 'declaredNumberCheck' || precondition.predicate !== 'finite'
}

function guide(id: RefactorGuideID) {
  return refactorGuide(id)
}

async function loadGuideModule(source: string): Promise<Record<string, unknown>> {
  const javascript = new Bun.Transpiler({loader: 'ts'}).transformSync(source)
  const encoded = Buffer.from(javascript).toString('base64')
  const loaded: unknown = await import(`data:text/javascript;base64,${encoded}`)
  if (typeof loaded !== 'object' || loaded == null) throw new Error('Expected guide source to load as a module')
  return loaded as Record<string, unknown>
}

function exportedFunction(module: Record<string, unknown>, name: string): (...arguments_: unknown[]) => unknown {
  const candidate = module[name]
  if (typeof candidate !== 'function') throw new Error(`Expected ${name} to be exported`)
  return (...arguments_): unknown => Reflect.apply(candidate, undefined, arguments_)
}

function returnedNumber(fn: (...arguments_: unknown[]) => unknown, ...arguments_: unknown[]): number {
  const result = fn(...arguments_)
  if (typeof result !== 'number') throw new Error('Expected a number')
  return result
}

test('the README documents every audit suggestion code', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const guide of refactorGuides) expect(readme).toContain(`\`[${guide.id}]\``)
})

test('every suggested rewrite changes the analyzer result as claimed', () => {
  const guarded = guide('guard-derived-value')
  expect(nonInputRequirements(analyzeSource('guard-before.ts', guarded.before), 'remap')).toHaveLength(1)
  expect(nonInputRequirements(analyzeSource('guard-after.ts', guarded.after), 'remap')).toEqual([])

  const normalized = guide('encode-input-rule')
  expect(analyzed(analyzeSource('normalize-before.ts', normalized.before), 'perColumn').ensures.join('\n'))
    .toContain('possibly non-finite')
  expect(analyzed(analyzeSource('normalize-after.ts', normalized.after), 'perColumn').ensures)
    .toEqual(['return is a finite number'])

  const direct = guide('use-direct-operands')
  const directBefore = analyzed(analyzeSource('direct-before.ts', direct.before), 'fittedHeight')
  expect(nonInputRequirements(analyzeSource('direct-before.ts', direct.before), 'fittedHeight')).toHaveLength(2)
  expect(directBefore.ensures.join('\n')).toContain('possibly NaN')
  const directAfter = analyzed(analyzeSource('direct-after.ts', direct.after), 'fittedHeight')
  expect(nonInputRequirements(analyzeSource('direct-after.ts', direct.after), 'fittedHeight')).toEqual([])
  expect(directAfter.ensures.join('\n')).toContain('possibly non-finite')
  expect(directAfter.ensures.join('\n')).not.toContain('possibly NaN')

  const explicit = guide('write-explicit-condition')
  expect(functionReport(analyzeSource('condition-before.ts', explicit.before), 'safeWidth').kind)
    .toBe('unsupported')
  expect(analyzed(analyzeSource('condition-after.ts', explicit.after), 'safeWidth').ensures)
    .toEqual(['return is a finite number'])

  const loop = guide('use-loop-for-aggregation')
  expect(functionReport(analyzeSource('loop-before.ts', loop.before), 'total').kind).toBe('unsupported')
  expect(analyzed(analyzeSource('loop-after.ts', loop.after), 'total').ensures.join('\n'))
    .toContain('possibly non-finite')

  const missing = guide('handle-missing-element')
  expect(analyzed(analyzeSource('missing-after.ts', missing.after), 'incrementAt').ensures)
    .toEqual(['return is a finite number'])

  const indexed = guide('guard-array-index')
  expect(nonInputRequirements(analyzeSource('index-before.ts', indexed.before), 'valueAt')).toHaveLength(1)
  expect(nonInputRequirements(analyzeSource('index-after.ts', indexed.after), 'valueAt')).toEqual([])
})

test('behavior tests pin the suggestion caveats', async () => {
  const guarded = guide('guard-derived-value')
  const remapBefore = exportedFunction(await loadGuideModule(guarded.before), 'remap')
  const remapAfter = exportedFunction(await loadGuideModule(guarded.after), 'remap')
  for (const arguments_ of [
    [5, 0, 10, 0, 100],
    [5, 2, 2, 0, 100],
    [5, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0, 100],
    [5, Number.NaN, 10, 0, 100],
  ]) {
    expect(Object.is(returnedNumber(remapBefore, ...arguments_), returnedNumber(remapAfter, ...arguments_))).toBe(true)
  }

  const normalized = guide('encode-input-rule')
  const perColumnBefore = exportedFunction(await loadGuideModule(normalized.before), 'perColumn')
  const perColumnAfter = exportedFunction(await loadGuideModule(normalized.after), 'perColumn')
  expect(returnedNumber(perColumnBefore, 12, 3)).toBe(returnedNumber(perColumnAfter, 12, 3))
  expect(returnedNumber(perColumnBefore, 10, 1.5)).not.toBe(returnedNumber(perColumnAfter, 10, 1.5))
  expect(returnedNumber(perColumnBefore, 10, -0.5)).not.toBe(returnedNumber(perColumnAfter, 10, -0.5))
  expect(Number.isNaN(returnedNumber(perColumnAfter, 10, Number.NaN))).toBe(true)

  const direct = guide('use-direct-operands')
  const fittedBefore = exportedFunction(await loadGuideModule(direct.before), 'fittedHeight')
  const fittedAfter = exportedFunction(await loadGuideModule(direct.after), 'fittedHeight')
  expect(returnedNumber(fittedBefore, 100, 4, 2)).toBe(returnedNumber(fittedAfter, 100, 4, 2))
  expect(returnedNumber(fittedBefore, 1, Number.MIN_VALUE, 2)).toBe(Number.POSITIVE_INFINITY)
  expect(returnedNumber(fittedAfter, 1, Number.MIN_VALUE, 2)).toBe(2)
  expect(Number.isNaN(returnedNumber(fittedAfter, 1, Number.NaN, 2))).toBe(true)

  const explicit = guide('write-explicit-condition')
  const safeBefore = exportedFunction(await loadGuideModule(explicit.before), 'safeWidth')
  const safeAfter = exportedFunction(await loadGuideModule(explicit.after), 'safeWidth')
  for (const value of [-2, 0, 3]) {
    expect(Object.is(returnedNumber(safeBefore, value), returnedNumber(safeAfter, value))).toBe(true)
  }
  expect(returnedNumber(safeBefore, Number.NaN)).toBe(1)
  expect(Number.isNaN(returnedNumber(safeAfter, Number.NaN))).toBe(true)

  const loop = guide('use-loop-for-aggregation')
  const totalBefore = exportedFunction(await loadGuideModule(loop.before), 'total')
  const totalAfter = exportedFunction(await loadGuideModule(loop.after), 'total')
  expect(returnedNumber(totalBefore, [1, 2, 3])).toBe(returnedNumber(totalAfter, [1, 2, 3]))
  const sparse = new Array<number>(2)
  sparse[1] = 2
  expect(returnedNumber(totalBefore, sparse)).toBe(2)
  expect(Number.isNaN(returnedNumber(totalAfter, sparse))).toBe(true)

  const missing = guide('handle-missing-element')
  const incrementBefore = exportedFunction(await loadGuideModule(missing.before), 'incrementAt')
  const incrementAfter = exportedFunction(await loadGuideModule(missing.after), 'incrementAt')
  expect(returnedNumber(incrementBefore, [4], 0)).toBe(returnedNumber(incrementAfter, [4], 0))
  expect(Number.isNaN(returnedNumber(incrementBefore, [4], 1))).toBe(true)
  expect(returnedNumber(incrementAfter, [4], 1)).toBe(1)
  const missingSparse = new Array<number>(1)
  expect(Number.isNaN(returnedNumber(incrementBefore, missingSparse, 0))).toBe(true)
  expect(returnedNumber(incrementAfter, missingSparse, 0)).toBe(1)

  const indexed = guide('guard-array-index')
  const valueAtBefore = exportedFunction(await loadGuideModule(indexed.before), 'valueAt')
  const valueAtAfter = exportedFunction(await loadGuideModule(indexed.after), 'valueAt')
  expect(valueAtBefore([4, 8], 1)).toBe(valueAtAfter([4, 8], 1))
  expect(valueAtBefore([4, 8], 9)).toBeUndefined()
  expect(valueAtAfter([4, 8], 9)).toBe(0)
})

test('file audits lead with honest coverage and route only relevant checked patterns', () => {
  const audit = auditSource('layout.ts', `
    declare const paint: (width: number) => void
    type Layout = {width: number; height: number}

    export function divide(width: number, columns: number): number {
      return width / columns
    }
    export function resize(layout: Layout, width: number): Layout {
      layout.width = width
      return layout
    }
    export function safeWidth(width: number): number {
      return width || 1
    }
    export function total(values: number[]): number {
      return values.reduce((sum, value) => sum + value, 0)
    }
    export function valueAt(values: number[], index: number): number {
      return values[index]!
    }
    export function render(width: number): number {
      paint(width)
      return width
    }
  `)

  expect(audit.coverage).toEqual({
    functions: 6,
    analyzed: 2,
    partial: 0,
    unsupported: 4,
    initializer: 'analyzed',
    initializerSkips: 1,
  })
  expect(audit.guideIDs).toEqual([
    'guard-derived-value',
    'encode-input-rule',
    'write-explicit-condition',
    'use-loop-for-aggregation',
    'guard-array-index',
  ])
  expect(audit.references.map(reference => reference.span.start))
    .toEqual([...audit.references].map(reference => reference.span.start).sort((left, right) => left - right))
  const arrayCall = audit.references.find(reference =>
    reference.reason.kind === 'unsupported'
    && reference.reason.reason.kind === 'call'
    && reference.reason.reason.arrayMethod === 'reduce')
  expect(arrayCall?.guideIDs).toEqual(['use-loop-for-aggregation'])
  const paintCall = audit.references.find(reference =>
    reference.reason.kind === 'unsupported'
    && reference.reason.reason.kind === 'call'
    && reference.reason.reason.callee === 'paint')
  expect(paintCall?.guideIDs).toEqual([])
  const propertyWrite = audit.references.find(reference =>
    reference.reason.kind === 'unsupported'
    && reference.reason.reason.kind === 'propertyWrite')
  expect(propertyWrite?.guideIDs).toEqual([])
  const output = formatFileAuditUnit(audit)
  expect(output).toStartWith('# layout.ts (2/6 functions fully analyzed; 4 unsupported; 1 module statement skipped)')
  // Analysis entries always print before suggestions within a unit.
  expect(output.indexOf('## Contracts')).toBeGreaterThan(0)
  expect(output.indexOf('## Contracts')).toBeLessThan(output.indexOf('## Refactoring suggestions'))
  expect(output).toContain('layout.ts(6,14): suggestion [guard-derived-value]: Check the exact divisor.')
  for (const guideID of [
    'guard-derived-value',
    'write-explicit-condition',
    'use-loop-for-aggregation',
    'guard-array-index',
  ] as const) {
    const guide = refactorGuide(guideID)
    expect(output).toContain(`[${guide.id}]`)
    expect(output).toContain(guide.title)
    expect(output).toContain(guide.summary)
    expect(output).not.toContain(guide.caveat)
    expect(output).not.toContain(guide.after)
  }
  expect(output).toContain('suggestion [encode-input-rule]: Encode a real input rule where the calculation begins.')
  expect(output).not.toContain('Example rewrite:')
  expect(output).not.toContain('Other options')
  expect(output).not.toContain(refactorGuide('encode-input-rule').before)

  const coloredOutput = formatFileAuditUnit(audit, true)
  expect(coloredOutput).toContain('# \u001B[96mlayout.ts\u001B[0m (')
  expect(coloredOutput).toContain('at \u001B[96mlayout.ts\u001B[0m:\u001B[93m2\u001B[0m:\u001B[93m19\u001B[0m')
  expect(coloredOutput).toContain('\u001B[96mlayout.ts\u001B[0m:\u001B[93m6\u001B[0m:\u001B[93m14\u001B[0m - \u001B[96msuggestion\u001B[0m\u001B[90m [guard-derived-value]: \u001B[0mCheck the exact divisor.')
  expect(coloredOutput).not.toContain('layout.ts:')
  expect(output).not.toContain('\u001B[')

  // A do-while stays outside the subset (while itself lowers now), and no catalog guide
  // claims a safe rewrite for one, so the audit must say plainly that nothing applies.
  const unsupportedWithoutGuide = auditSource('unsupported.ts', `
    export function wait(width: number): number {
      do { width = width - 1 } while (width > 0)
      return width
    }
  `)
  expect(unsupportedWithoutGuide.guideIDs).toEqual([])
  expect(formatFileAuditUnit(unsupportedWithoutGuide)).not.toContain('## Refactoring suggestions')
})

test('audit references preserve each propagated requirement payload', () => {
  const audit = auditSource('propagated.ts', `
    type Grid = {columns: number}
    export function divide(width: number, columns: number): number {
      return width / columns
    }
    export function wrapper(width: number, grid: Grid): number {
      return divide(width, grid.columns)
    }
    export function adapted(width: number, gap: number): number {
      return divide(width, width - gap)
    }
  `)
  const requirements = audit.references.filter(isNonInputRequirement)
  expect(requirements).toHaveLength(3)
  expect(requirements.map(reference => [
    reference.functionName,
    reference.reason.kind === 'requires' && 'expression' in reference.reason.precondition
      ? reference.reason.precondition.expression.kind
      : null,
    reference.guideIDs,
  ])).toEqual([
    ['divide', 'parameter', ['guard-derived-value', 'encode-input-rule']],
    ['wrapper', 'property', ['guard-derived-value', 'encode-input-rule']],
    ['adapted', 'binary', ['guard-derived-value']],
  ])
})

test('guide routing requires the exact supported operation and value kind', () => {
  const audit = auditSource('routing.ts', `
    export function dividedRatio(total: number, width: number, height: number): number {
      return total / (width / height)
    }
    export function remainderRatio(total: number, width: number, height: number): number {
      return total % (width / height)
    }
    export function flooredRatio(total: number, width: number, height: number): number {
      return total / Math.floor(width / height)
    }
    export function nullableFallback(value: number | null): number {
      return value || 1
    }
    export function assertedRatio(values: number[]): number {
      return 1 / values[0]!
    }
  `)
  const outerRequirement = (functionName: string) => audit.references.find(reference =>
    reference.functionName === functionName
    && isNonInputRequirement(reference)
    && reference.reason.kind === 'requires'
    && 'expression' in reference.reason.precondition
    && reference.reason.precondition.expression.kind !== 'parameter')
  expect(outerRequirement('dividedRatio')?.guideIDs).toEqual(['use-direct-operands', 'guard-derived-value'])
  expect(outerRequirement('remainderRatio')?.guideIDs).toEqual(['guard-derived-value'])
  expect(outerRequirement('flooredRatio')?.guideIDs).toEqual(['guard-derived-value'])
  const nullableFallback = audit.references.find(reference => reference.functionName === 'nullableFallback')
  expect(nullableFallback?.reason).toMatchObject({
    kind: 'unsupported',
    reason: {kind: 'nonBooleanCondition', conditionKind: 'other'},
  })
  expect(nullableFallback?.guideIDs).toEqual([])

  const provenOutOfBounds = auditSource('wrong-index.ts', `
    export function wrong(): number {
      const values = [1]
      return values[2]!
    }
  `)
  const provenStop = provenOutOfBounds.references.find(reference =>
    reference.reason.kind === 'partialSupport'
      && reference.reason.reason.kind === 'requirementFailure'
      && reference.reason.reason.failure.kind === 'elementInBounds')
  expect(provenStop?.guideIDs).toEqual([])
  expect(formatFileAuditUnit(provenOutOfBounds)).not.toContain('### Check an asserted array index')

  const divisorAssumption = audit.references.find(reference =>
    reference.functionName === 'assertedRatio' && reference.reason.kind === 'assumes')
  expect(divisorAssumption?.guideIDs).toEqual(['guard-derived-value'])
})

test('zero function coverage does not claim skipped callable forms are absent', () => {
  const audit = auditSource('arrow.ts', `
    export const width = (value: number): number => value
  `)
  expect(audit.coverage).toMatchObject({functions: 0, initializerSkips: 1})
  const output = formatFileAuditUnit(audit)
  expect(output).toStartWith('# arrow.ts (no named function declarations')
  expect(output).toContain('1 module statement skipped')
  expect(output).not.toContain('## Refactoring suggestions')

  const constantsOnly = formatFileAuditUnit(auditSource('constants.ts', 'export const width = 24'))
  expect(constantsOnly).not.toContain('## Contracts')
})

test('partial audits retain requirements found before a path became unsupported', () => {
  const audit = auditSource('partial.ts', `
    declare const paint: (width: number) => number
    export function blocked(width: number): number {
      return paint(width)
    }
    export function partial(width: number, columns: number): number {
      const result = width / columns
      return blocked(result)
    }
  `)
  expect(audit.coverage).toMatchObject({functions: 2, analyzed: 0, partial: 1, unsupported: 1})
  const observedRequirement = audit.references.find(reference =>
    reference.functionName === 'partial' && isNonInputRequirement(reference))
  expect(observedRequirement?.guideIDs).toEqual(['guard-derived-value', 'encode-input-rule'])
  expect(formatFileAuditUnit(audit)).toContain('suggestion [guard-derived-value]: Check the exact divisor.')
})

test('array callbacks route by structured method kind', () => {
  const map = auditSource('map.ts', `
    export function doubled(values: number[]): number[] {
      return values.map(value => value * 2)
    }
  `)
  expect(map.guideIDs).toEqual([])
  expect(map.references[0]?.reason).toMatchObject({
    kind: 'unsupported',
    reason: {kind: 'call', arrayMethod: 'other'},
  })
})
