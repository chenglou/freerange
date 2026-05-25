import ts from 'typescript'
import {
  fitExpressionText,
  fitValueSpecExpressions,
  lowerFitValueSpecTextForTypeScript,
  parseFitSpecLine,
  parseFunctionBodyFitSpecIndex,
  parseFunctionFitSpecs,
  type FitRange,
  type FitSpec,
} from './src/parser.ts'

function expect(condition: boolean, message: string): asserts condition {
  if (condition) return
  throw new Error(message)
}

function expectEqual<T>(actual: T, expected: T, message: string) {
  if (Object.is(actual, expected)) return
  throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

function sourceFile(source: string) {
  return ts.createSourceFile('parser-test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function firstFunction(source: string) {
  const file = sourceFile(source)
  const fn = file.statements.find(ts.isFunctionDeclaration)
  expect(fn != null, 'expected a function declaration')
  return {file, fn}
}

function expectSpec<R extends FitSpec['role'], K extends Extract<FitSpec, {role: R}>['kind']>(
  spec: FitSpec,
  role: R,
  kind: K,
): Extract<FitSpec, {role: R; kind: K}> {
  expect(spec.role === role, `expected ${role}, got ${spec.role}`)
  expect(spec.kind === kind, `expected ${kind}, got ${spec.kind}`)
  return spec as Extract<FitSpec, {role: R; kind: K}>
}

function expectRange(range: FitRange, text: string, valueKind: 'number' | 'int') {
  expectEqual(range.text, text, 'expected range text')
  expectEqual(range.valueKind, valueKind, 'expected range value kind')
}

{
  const lowered = lowerFitValueSpecTextForTypeScript('{kind: "small", width: 100..200, cols: int 1..<7} | {kind: "large", width: minWidth()..maxWidth(), cols: 7}')
  expect(lowered != null, 'expected whole-value spec to lower to TS type syntax')
  expectEqual(
    lowered.typeText,
    '{kind: "small", width: __FRNumber<"r0">, cols: __FRNumber<"r1">} | {kind: "large", width: __FRNumber<"r2">, cols: 7}',
    'expected range leaves to become branded number slots',
  )
  expectEqual(lowered.ranges.size, 3, 'expected one side-table range per range leaf')

  const spec = expectSpec(
    parseFitSpecLine('return: {kind: "small", width: 100..200, cols: int 1..<7} | {kind: "large", width: minWidth()..maxWidth(), cols: 7}', 12),
    'prove',
    'value',
  )
  expectEqual(fitExpressionText(spec.expression), '__fit_return', 'expected return to be normalized')
  expectEqual(spec.line, 12, 'expected line number to be carried')
  expectEqual(spec.value.typeText, lowered.typeText, 'expected value spec to keep lowered TS type text')
  expectEqual(spec.value.ranges.size, 3, 'expected range side table to stay attached')
  expectEqual(ts.isUnionTypeNode(spec.value.typeNode), true, 'expected TS union type node')
  expectRange(spec.value.ranges.get('r0')!, '100..200', 'number')
  const smallCols = spec.value.ranges.get('r1')!
  expectRange(smallCols, 'int 1..<7', 'int')
  expectEqual(smallCols.upperInclusive, false, 'expected exclusive upper bound')
  expectRange(spec.value.ranges.get('r2')!, 'minWidth()..maxWidth()', 'number')
}

{
  const spec = expectSpec(parseFitSpecLine('given foo() > bar(10, "px")'), 'assume', 'comparison')
  expectEqual(fitExpressionText(spec.left), 'foo()', 'expected left expression')
  expectEqual(spec.op, '>', 'expected comparison op')
  expectEqual(fitExpressionText(spec.right), 'bar(10, "px")', 'expected right expression')
}

{
  const spec = expectSpec(parseFitSpecLine('given isSorted(items)'), 'assume', 'expression')
  expectEqual(fitExpressionText(spec.expression), 'isSorted(items)', 'expected given expression body')
}

{
  const spec = expectSpec(parseFitSpecLine('return >= min'), 'prove', 'comparison')
  expectEqual(fitExpressionText(spec.left), '__fit_return', 'expected return to be normalized in prove comparison')
}

{
  try {
    parseFitSpecLine('given return: {width: 0..10}')
    throw new Error('expected given whole-value spec to be rejected')
  } catch (error) {
    expect(error instanceof Error, 'expected parser error')
    expect(error.message.includes('Unsupported @fit range'), 'expected given value-shape syntax rejection')
  }
}

{
  const spec = expectSpec(parseFitSpecLine('return: {rows: {height: 10..20}[], snap: [0..10, 20..30]}'), 'prove', 'value')
  expectEqual(spec.value.typeText, '{rows: {height: __FRNumber<"r0">}[], snap: [__FRNumber<"r1">, __FRNumber<"r2">]}', 'expected nested spec to lower to TS type syntax')
  expectEqual(spec.value.ranges.size, 3, 'expected nested range side table')
  expectEqual(fitValueSpecExpressions(spec.value).map(fitExpressionText).join(', '), '10, 20, 0, 10, 20, 30', 'expected expressions to come from side-table ranges')
}

{
  const spec = expectSpec(parseFitSpecLine('return: ({left: 0..10} & {width: int 1..5}) | {kind: "empty", width: 0}'), 'prove', 'value')
  expectEqual(spec.value.typeText, '({left: __FRNumber<"r0">} & {width: __FRNumber<"r1">}) | {kind: "empty", width: 0}', 'expected intersections to stay TypeScript type syntax')
  expectEqual(ts.isUnionTypeNode(spec.value.typeNode), true, 'expected intersection union to parse through TS')
  expectEqual(spec.value.ranges.size, 2, 'expected range slots only for range leaves')
}

{
  const spec = expectSpec(parseFitSpecLine('return: Box<{width: 0..maxWidth()}>'), 'prove', 'value')
  expectEqual(spec.value.typeText, 'Box<{width: __FRNumber<"r0">}>', 'expected generic type syntax to stay in TypeScript form')
  expectEqual(ts.isTypeReferenceNode(spec.value.typeNode), true, 'expected generic type reference to parse through TS')
  expectEqual(fitValueSpecExpressions(spec.value).map(fitExpressionText).join(', '), '0, maxWidth()', 'expected expressions inside type arguments')
}

{
  try {
    parseFitSpecLine('return: {width: dynamicWidth()}')
    throw new Error('expected unsupported value expression leaf to be rejected')
  } catch (error) {
    expect(error instanceof Error, 'expected parser error')
    expect(error.message.includes('Unsupported @fit value spec'), 'expected unsupported value spec error')
  }
}

{
  const source = `/** @fit
 * given availableWidth: minWidth()..maxWidth()
 * return: {tiles: {width: 0..100}[], snap: [0..10, 20..30]}
 * hasPositiveArea(return)
 */
function layout(availableWidth: number) {
  return {tiles: [], snap: [0, 20]}
}
`
  const {fn} = firstFunction(source)
  const specs = parseFunctionFitSpecs(source, fn, fn.parameters)
  expectEqual(specs.length, 3, 'expected block specs')
  expectSpec(specs[0]!, 'assume', 'range')
  expectSpec(specs[1]!, 'prove', 'value')
  expectSpec(specs[2]!, 'prove', 'expression')
}

{
  const source = `function layout(availableWidth: number) {
  const columnWidth = availableWidth / 3 // @fit > 0
  return {
    width: columnWidth, // @fit > 0
    height: 10, // @fit 1..20
  }
}
`
  const {fn} = firstFunction(source)
  const index = parseFunctionBodyFitSpecIndex(source, fn)
  expectEqual(index.localSpecsByStatement.size, 1, 'expected one local inline spec')
  expectEqual(index.objectPropertyTemplatesByNode.size, 2, 'expected two object property inline specs')
  expectEqual(index.returnSpecsByNode.size, 0, 'expected no return inline spec')
}

{
  const source = `function layout(
  width: number, // @fit 0..10
) {
  const visibleWidth = width // @fit >= 0
  return visibleWidth // @fit <= 10
}
`
  const {fn} = firstFunction(source)
  const inputSpecs = parseFunctionFitSpecs(source, fn, fn.parameters)
  expectSpec(inputSpecs[0]!, 'assume', 'range')
  const index = parseFunctionBodyFitSpecIndex(source, fn)
  const localSpecs = [...index.localSpecsByStatement.values()][0] ?? []
  const returnSpecs = [...index.returnSpecsByNode.values()][0] ?? []
  expectSpec(localSpecs[0]!, 'prove', 'comparison')
  expectSpec(returnSpecs[0]!, 'prove', 'comparison')
}

{
  const source = `function layout() {
  // @fit return: {width: 0..10}
  return {width: 5}
}
`
  const {fn} = firstFunction(source)
  try {
    parseFunctionBodyFitSpecIndex(source, fn)
    throw new Error('expected inline block-style return syntax to be rejected')
  } catch (error) {
    expect(error instanceof Error, 'expected parser error')
    expect(error.message.includes('Unsupported inline @fit range: @fit return: {width: 0..10}'), 'expected inline return syntax rejection')
  }
}

{
  const source = `function layout(
  value: number /* @fit 0..10 */,
) {
  return value
}
`
  const {fn} = firstFunction(source)
  try {
    parseFunctionFitSpecs(source, fn, fn.parameters)
    throw new Error('expected inline block comment to be rejected')
  } catch (error) {
    expect(error instanceof Error, 'expected parser error')
    expect(error.message.includes('Block @fit comments are only supported for function, loop, and type contract blocks'), 'expected inline block comment rejection')
  }
}

console.log('parser: syntax layer checks passed')
