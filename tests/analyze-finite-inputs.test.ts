import {describe, expect, test} from 'bun:test'
import {analyzeSource} from '../src/index.ts'
import {analyzedFunction} from './analyze-helpers.ts'

describe('finite number input contracts', () => {
  test('used number parameters become requirements without checking returns', () => {
    const report = analyzeSource('finite-scalars.ts', `
      function double(value: number): number {
        return value * 2
      }
      function literal(value: 1 | 2): number {
        return value + 1
      }
      function safe(): number {
        return double(4)
      }
      function overflow(): number {
        return double(1e308)
      }
      function conditional(useValue: boolean, value: number): number {
        if (useValue) return value
        return 0
      }
      function dead(value: number): number {
        if (false) return value
        return 0
      }
      function firstIteration(count: number, value: number): number {
        for (let index = 0; index < count; index++) return value
        return 0
      }
      function ignored(value: number): number {
        return 0
      }
      function ignoredWrapper(value: number): number {
        return ignored(value)
      }
      function ignoredJoin(flag: boolean, left: number, right: number): number {
        const selected = flag ? left : right
        return ignored(selected)
      }
      function skippedNonfiniteBranches(): number {
        return conditional(false, Infinity)
          + dead(Infinity)
          + firstIteration(0, Infinity)
          + ignoredWrapper(Infinity)
          + ignoredJoin(true, Infinity, Infinity)
      }
      function bad(): number {
        return double(Infinity)
      }
      function badConditional(): number {
        return conditional(true, Infinity)
      }
      function selectedInfinity(useValue: boolean, value: number): number {
        const selected = useValue ? value : Infinity
        return double(selected)
      }
      function selectedValue(value: number): number {
        return selectedInfinity(true, value)
      }
      function selectedInfinityPath(): number {
        return selectedInfinity(false, 1)
      }
    `)

    const double = analyzedFunction(report, 'double')
    expect(double.assumptions).toEqual([])
    expect(double.requires[0]).toContain('Number.isFinite(value)')
    expect(double.ensures[0]).toContain('possibly non-finite')
    expect(analyzedFunction(report, 'literal').requires).toEqual([])
    expect(analyzedFunction(report, 'literal').ensures[0]).toContain('from 2 through 3')
    expect(analyzedFunction(report, 'safe').requires).toEqual([])
    expect(analyzedFunction(report, 'overflow').requires).toEqual([])
    expect(analyzedFunction(report, 'ignoredWrapper').requires).toEqual([])
    expect(analyzedFunction(report, 'ignoredJoin').requires).toEqual([])
    expect(analyzedFunction(report, 'skippedNonfiniteBranches').ensures[0]).toContain('from 0 through 0')

    const bad = report.functions.find(fn => fn.name === 'bad')
    if (bad?.kind !== 'partial') throw new Error('Expected bad to be partial')
    expect(bad.partialReasons[0]).toContain('passes a number that is definitely not finite')
    const badConditional = report.functions.find(fn => fn.name === 'badConditional')
    if (badConditional?.kind !== 'partial') throw new Error('Expected badConditional to be partial')
    expect(badConditional.partialReasons[0]).toContain('passes a number that is definitely not finite')
    const selected = report.functions.find(fn => fn.name === 'selectedInfinity')
    if (selected?.kind !== 'partial') throw new Error('Expected selectedInfinity to be partial')
    expect(selected.partialReasons[0]).toContain('definitely not finite')
    expect(analyzedFunction(report, 'selectedValue').requires[0]).toContain('Number.isFinite(value)')
    expect(report.functions.find(fn => fn.name === 'selectedInfinityPath')?.kind).toBe('partial')
  })

  test('required record fields use exact paths and destructured local names', () => {
    const report = analyzeSource('finite-records.ts', `
      type Size = {width: number; nested: {height: number}; ignored: number}
      function area(size: Size): number {
        return size.width * size.nested.height
      }
      function passSize(size: Size): Size {
        return size
      }
      function passPossiblyOverflowingSize(value: number): Size {
        const doubled = value * 2
        return passSize({width: doubled, nested: {height: 3}, ignored: 1})
      }
      function returnWidth(size: Size): number {
        return size.width
      }
      function derivedWidth(value: number): number {
        return returnWidth({width: value * 2, nested: {height: 3}, ignored: 1})
      }
      function ignoreSize(size: Size): number {
        return 0
      }
      function ignoredPackedValue(value: number): number {
        return ignoreSize({width: value, nested: {height: 3}, ignored: 1})
      }
      function ignoredJoinedPackedValue(flag: boolean, value: number): number {
        const size = flag
          ? {width: value, nested: {height: 3}, ignored: 1}
          : {width: value, nested: {height: 4}, ignored: 2}
        return ignoreSize(size)
      }
      function ignoredPackedInfinityIsFine(): number {
        return ignoredPackedValue(Infinity)
      }
      type Pair = {gate: number; payload: number}
      function conditionalPair(pair: Pair): Pair {
        if (!Number.isFinite(pair.gate)) {
          return {gate: 0, payload: pair.payload + 0}
        }
        return pair
      }
      function conditionalPairWrapper(gate: number, payload: number): Pair {
        return conditionalPair({gate: gate * 2, payload: payload * 2})
      }
      function overflowingConditionalPayload(): number {
        return conditionalPairWrapper(1, 1.7976931348623157e308).payload
      }
      type ChainNode = {value: number; next: ChainNode | null}
      function buildUnusedChain(value: number, count: number): number {
        let node: ChainNode = {value, next: null}
        for (let index = 0; index < count; index++) {
          node = {value: 0, next: node}
        }
        return 0
      }
      type SwapPair = {left: number; right: number}
      function afterSwaps(value: number, count: number): number {
        let pair: SwapPair = {left: 0, right: value}
        for (let index = 0; index < count; index++) {
          pair = {left: pair.right, right: pair.left}
        }
        return pair.left
      }
      function badSwap(): number {
        return afterSwaps(Infinity, 1)
      }
      function wrappedArea(size: Size): number {
        return area(size)
      }
      function reorderedArea(useInput: boolean, size: Size): number {
        return area(size)
      }
      function nestedReorderedArea(size: Size, useInput: boolean): number {
        return reorderedArea(useInput, size)
      }
      function joinedArea(useFirst: boolean, first: Size, second: Size): number {
        const selected = useFirst ? first : second
        return area(selected)
      }
      function destructured({width: frameWidth}: Size): number {
        return frameWidth
      }
      function selectedWidth(size: Size, useInput: boolean): number {
        const selected = useInput ? size : {width: 1, nested: {height: 2}, ignored: 3}
        return selected.width
      }
      function conditionalWidth(useInput: boolean, size: Size): number {
        if (useInput) return size.width
        return 0
      }
      function ignoredInfinityIsFine(): number {
        return area({width: 2, nested: {height: 3}, ignored: Infinity})
      }
      function joinedIgnoredInfinityIsFine(): number {
        return selectedWidth({width: 2, nested: {height: 3}, ignored: Infinity}, true)
      }
      function skippedJoinedWidthIsFine(): number {
        return selectedWidth({width: Infinity, nested: {height: 3}, ignored: 1}, false)
      }
      function skippedJoinedAreaIsFine(): number {
        return joinedArea(
          true,
          {width: 2, nested: {height: 3}, ignored: 1},
          {width: Infinity, nested: {height: Infinity}, ignored: 1},
        )
      }
      function skippedWidthIsFine(): number {
        return conditionalWidth(false, {width: Infinity, nested: {height: 3}, ignored: 1})
      }
      function badWidth(): number {
        return area({width: Infinity, nested: {height: 3}, ignored: 1})
      }
      function badWrappedWidth(): number {
        return wrappedArea({width: Infinity, nested: {height: 3}, ignored: 1})
      }
    `)

    expect(analyzedFunction(report, 'area').requires.map(line => line.split(' (input')[0])).toEqual([
      'Number.isFinite(size.width)',
      'Number.isFinite(size.nested.height)',
    ])
    expect(analyzedFunction(report, 'passSize').requires).toEqual([])
    expect(analyzedFunction(report, 'passPossiblyOverflowingSize').ensures
      .find(line => line.startsWith('return.width'))).toContain('possibly non-finite')
    const derivedWidth = analyzedFunction(report, 'derivedWidth')
    expect(derivedWidth.requires.some(line => line.includes('Number.isFinite(value)'))).toBe(true)
    expect(derivedWidth.requires.some(line => line.includes('Number.isFinite((value * 2))'))).toBe(true)
    expect(derivedWidth.ensures[0]).not.toContain('possibly non-finite')
    expect(analyzedFunction(report, 'ignoredPackedValue').requires).toEqual([])
    expect(analyzedFunction(report, 'ignoredJoinedPackedValue').requires).toEqual([])
    expect(analyzedFunction(report, 'ignoredPackedInfinityIsFine').ensures[0]).toContain('from 0 through 0')
    expect(analyzedFunction(report, 'conditionalPairWrapper').ensures
      .find(line => line.startsWith('return.payload'))).toContain('possibly non-finite')
    expect(analyzedFunction(report, 'overflowingConditionalPayload').ensures[0]).toContain('possibly non-finite')
    expect(report.functions.find(fn => fn.name === 'buildUnusedChain')?.kind).toBe('partial')
    expect(analyzedFunction(report, 'afterSwaps').requires
      .some(line => line.includes('Number.isFinite(value)'))).toBe(true)
    expect(report.functions.find(fn => fn.name === 'badSwap')?.kind).toBe('partial')
    expect(analyzedFunction(report, 'wrappedArea').requires.map(line => line.split(' (input')[0])).toEqual([
      'Number.isFinite(size.width)',
      'Number.isFinite(size.nested.height)',
    ])
    expect(analyzedFunction(report, 'nestedReorderedArea').requires.map(line => line.split(' (input')[0])).toEqual([
      'Number.isFinite(size.width)',
      'Number.isFinite(size.nested.height)',
    ])
    expect(analyzedFunction(report, 'joinedArea').requires.map(line => line.split(' (input')[0])).toEqual([
      'Number.isFinite(first.width)',
      'Number.isFinite(first.nested.height)',
      'Number.isFinite(second.width)',
      'Number.isFinite(second.nested.height)',
    ])
    expect(analyzedFunction(report, 'destructured').requires[0]).toContain('Number.isFinite(frameWidth)')
    expect(analyzedFunction(report, 'selectedWidth').requires.map(line => line.split(' (input')[0])).toEqual([
      'Number.isFinite(size.width)',
    ])
    expect(analyzedFunction(report, 'ignoredInfinityIsFine').requires).toEqual([])
    expect(analyzedFunction(report, 'joinedIgnoredInfinityIsFine').requires).toEqual([])
    expect(analyzedFunction(report, 'skippedJoinedWidthIsFine').ensures[0]).toContain('from 1 through 1')
    expect(analyzedFunction(report, 'skippedJoinedAreaIsFine').requires).toEqual([])
    expect(analyzedFunction(report, 'skippedWidthIsFine').ensures[0]).toContain('from 0 through 0')

    const bad = report.functions.find(fn => fn.name === 'badWidth')
    if (bad?.kind !== 'partial') throw new Error('Expected badWidth to be partial')
    expect(bad.partialReasons[0]).toContain('definitely not finite')
    const badWrapped = report.functions.find(fn => fn.name === 'badWrappedWidth')
    if (badWrapped?.kind !== 'partial') throw new Error('Expected badWrappedWidth to be partial')
    expect(badWrapped.partialReasons[0]).toContain('definitely not finite')
  })

  test('arrays, nullable values, and tagged unions retain their existing assumptions', () => {
    const report = analyzeSource('finite-boundaries.ts', `
      function nullable(value: number | null): number {
        return value === null ? 0 : value
      }
      function first(values: number[]): number {
        return values[0]!
      }
      type Result = {ok: true; value: number} | {ok: false; value: number}
      function variant(result: Result): number {
        return result.ok === true ? result.value : 0
      }
      function checkedVariant(result: Result): number {
        console.assert(Number.isFinite(result.value))
        return result.value
      }
      function wrappedVariant(result: Result): number {
        return checkedVariant(result)
      }
      function nullableCheckedVariant(result: Result | null): number {
        if (result === null) return 0
        return checkedVariant(result)
      }
      function rebuiltVariant(result: Result): number {
        if (result.ok) return checkedVariant({ok: true, value: result.value})
        return checkedVariant({ok: false, value: result.value})
      }
      function joinedRebuiltVariant(result: Result, chooseSuccess: boolean): number {
        const rebuilt: Result = chooseSuccess
          ? {ok: true, value: result.value}
          : {ok: false, value: result.value}
        return checkedVariant(rebuilt)
      }
      function chooseVariant(useFirst: boolean, first: Result, second: Result): number {
        const selected = useFirst ? first : second
        return checkedVariant(selected)
      }
      function chooseFirstVariant(first: Result, second: Result): number {
        return chooseVariant(true, first, second)
      }
      function checkVariantsInLoop(first: Result, second: Result, count: number): number {
        let current = first
        for (let index = 0; index < count; index++) {
          checkedVariant(current)
          current = second
        }
        return 0
      }
    `)

    expect(analyzedFunction(report, 'nullable').requires).toEqual([])
    expect(analyzedFunction(report, 'nullable').assumptions[0]).toContain('null or')
    expect(analyzedFunction(report, 'first').requires.some(line => line.includes('Number.isFinite'))).toBe(false)
    expect(analyzedFunction(report, 'first').assumptions.some(line => line.includes('every values element'))).toBe(true)
    expect(analyzedFunction(report, 'variant').requires).toEqual([])
    expect(analyzedFunction(report, 'checkedVariant').requires[0]).toContain('Number.isFinite(result.value)')
    expect(analyzedFunction(report, 'wrappedVariant').requires[0]).toContain('Number.isFinite(result.value)')
    expect(analyzedFunction(report, 'nullableCheckedVariant').requires).toEqual([])
    expect(analyzedFunction(report, 'nullableCheckedVariant').assumptions[0]).toContain('result is null or')
    expect(analyzedFunction(report, 'rebuiltVariant').requires[0]).toContain('Number.isFinite(result.value)')
    expect(analyzedFunction(report, 'joinedRebuiltVariant').requires[0]).toContain('Number.isFinite(result.value)')
    const chooseFirst = analyzedFunction(report, 'chooseFirstVariant')
    expect(chooseFirst.requires).toHaveLength(1)
    expect(chooseFirst.requires[0]).toContain('Number.isFinite(first.value)')
    const loop = analyzedFunction(report, 'checkVariantsInLoop')
    expect(loop.requires.some(line => line.includes('Number.isFinite(first.value)'))).toBe(true)
    expect(loop.requires.some(line => line.includes('Number.isFinite(second.value)'))).toBe(true)
  })

  test('written number checks share one condition with the automatic contract', () => {
    const report = analyzeSource('finite-written.ts', `
      function explicitlyFinite(value: number): number {
        console.assert(Number.isFinite(value))
        return value
      }
      function integer(value: number): number {
        console.assert(Number.isInteger(value))
        return value
      }
      function finiteLiteral(value: 1 | 2): number {
        console.assert(Number.isFinite(value))
        return value
      }
      function finiteLiteralWrapper(value: 1 | 2): number {
        return explicitlyFinite(value)
      }
      function violatesWrittenFiniteRequirement(): number {
        return explicitlyFinite(Infinity)
      }
      function reorderedWrapper(ignored: 1 | 2, value: number): number {
        return explicitlyFinite(value)
      }
      function nestedWrapper(value: number): number {
        return reorderedWrapper(1, value)
      }
      function reorderedLiteral(value: 1 | 2, ignored: number): number {
        return explicitlyFinite(value)
      }
      function nestedReorderedLiteral(ignored: number, value: 1 | 2): number {
        return reorderedLiteral(value, ignored)
      }
      function finiteChoice(useSafe: boolean, safe: 1 | 2, risky: number): number {
        const selected = useSafe ? safe : risky * 2
        return explicitlyFinite(selected)
      }
      function finiteDerivedChoice(useSafe: boolean, safe: 1 | 2, risky: number): number {
        const selected = useSafe ? safe + 0 : risky * 2
        return explicitlyFinite(selected)
      }
      function overflowingLiteral(value: 1 | 2): number {
        return explicitlyFinite(value * 1.7976931348623157e308)
      }
      type Size = {width: number}
      function destructured({width}: Size): number {
        console.assert(Number.isFinite(width))
        return width
      }
    `)

    const finite = analyzedFunction(report, 'explicitlyFinite')
    expect(finite.requires).toHaveLength(1)
    expect(finite.requires[0]).toContain('Number.isFinite(value)')
    const integer = analyzedFunction(report, 'integer')
    expect(integer.requires).toHaveLength(1)
    expect(integer.requires[0]).toContain('Number.isInteger(value)')
    expect(analyzedFunction(report, 'finiteLiteral').requires).toEqual([])
    expect(analyzedFunction(report, 'finiteLiteralWrapper').requires).toEqual([])
    const violation = report.functions.find(fn => fn.name === 'violatesWrittenFiniteRequirement')
    if (violation?.kind !== 'partial') throw new Error('Expected violatesWrittenFiniteRequirement to be partial')
    expect(violation.partialReasons[0]).toContain('declared requirement definitely false')
    expect(analyzedFunction(report, 'reorderedWrapper').requires[0]).toContain('Number.isFinite(value)')
    expect(analyzedFunction(report, 'nestedWrapper').requires[0]).toContain('Number.isFinite(value)')
    expect(analyzedFunction(report, 'reorderedLiteral').requires).toEqual([])
    expect(analyzedFunction(report, 'nestedReorderedLiteral').requires).toEqual([])
    const finiteChoice = analyzedFunction(report, 'finiteChoice')
    expect(finiteChoice.requires.some(line => line.includes('Number.isFinite(safe)'))).toBe(false)
    expect(finiteChoice.requires.some(line => line.includes('Number.isFinite((risky * 2))'))).toBe(true)
    const finiteDerivedChoice = analyzedFunction(report, 'finiteDerivedChoice')
    expect(finiteDerivedChoice.requires.some(line => line.includes('safe + 0'))).toBe(false)
    expect(finiteDerivedChoice.requires.some(line => line.includes('Number.isFinite((risky * 2))'))).toBe(true)
    expect(analyzedFunction(report, 'overflowingLiteral').requires[0]).toContain(
      'Number.isFinite((value * 1.7976931348623157e+308))',
    )
    expect(analyzedFunction(report, 'destructured').requires).toHaveLength(1)
  })

  test('same-file calls propagate nameable conditions and specialize unnameable values', () => {
    const report = analyzeSource('finite-calls.ts', `
      function identity(value: number): number {
        return value
      }
      function scaled(value: number): number {
        const product = value * 2
        const output = identity(product)
        console.assert(Number.isFinite(product))
        return output
      }
      function parsed(text: string): number {
        const value = Number.parseFloat(text)
        const output = identity(value)
        console.assert(Number.isFinite(value))
        return output
      }
    `)

    const scaled = analyzedFunction(report, 'scaled')
    expect(scaled.requires.some(line => line.includes('Number.isFinite((value * 2))'))).toBe(true)
    expect(scaled.assertions?.[0]?.verdict).toBe('proven')
    const parsed = analyzedFunction(report, 'parsed')
    expect(parsed.requires).toEqual([])
    expect(parsed.ensures[0]).toContain('possibly NaN')
    expect(parsed.assertions?.[0]?.verdict).toBe('unproven')
  })
})
