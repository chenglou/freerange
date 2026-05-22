import ts from 'typescript'
import {
  fitExpressionText,
  lowerFitValueSpecTextForTypeScript,
  parseFitSpecLine,
  parseFunctionBodyFitSpecIndex,
  parseFunctionFitSpecs,
  type FitRange,
  type FitSpec,
  type FitValueSpec,
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

function expectSpecKind<K extends FitSpec['kind']>(spec: FitSpec, kind: K): Extract<FitSpec, {kind: K}> {
  expect(spec.kind === kind, `expected ${kind}, got ${spec.kind}`)
  return spec as Extract<FitSpec, {kind: K}>
}

function expectValueKind<K extends FitValueSpec['kind']>(value: FitValueSpec, kind: K): Extract<FitValueSpec, {kind: K}> {
  expect(value.kind === kind, `expected ${kind}, got ${value.kind}`)
  return value as Extract<FitValueSpec, {kind: K}>
}

function objectProp(object: Extract<FitValueSpec, {kind: 'object'}>, name: string) {
  const prop = object.props.find(item => item.name === name)
  expect(prop != null, `expected object prop ${name}`)
  return prop.value
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
    '{kind: "small"; width: __FRNumber<"r0">; cols: __FRNumber<"r1">} | {kind: "large"; width: __FRNumber<"r2">; cols: __FRNumber<"r3">}',
    'expected range leaves to become branded number slots',
  )
  expectEqual(lowered.ranges.size, 4, 'expected one side-table range per numeric leaf')

  const spec = expectSpecKind(
    parseFitSpecLine('return: {kind: "small", width: 100..200, cols: int 1..<7} | {kind: "large", width: minWidth()..maxWidth(), cols: 7}', 12),
    'check-value',
  )
  expectEqual(fitExpressionText(spec.expression), '__fit_return', 'expected return to be normalized')
  expectEqual(spec.line, 12, 'expected line number to be carried')
  const value = expectValueKind(spec.value, 'union')
  expectEqual(value.cases.length, 2, 'expected two whole-value cases')

  const small = expectValueKind(value.cases[0]!, 'object')
  const smallKind = expectValueKind(objectProp(small, 'kind'), 'literal')
  expectEqual(smallKind.values[0], 'small', 'expected string literal')
  const smallWidth = expectValueKind(objectProp(small, 'width'), 'number')
  expectRange(smallWidth.range, '100..200', 'number')
  const smallCols = expectValueKind(objectProp(small, 'cols'), 'number')
  expectRange(smallCols.range, 'int 1..<7', 'int')
  expectEqual(smallCols.range.upperInclusive, false, 'expected exclusive upper bound')

  const large = expectValueKind(value.cases[1]!, 'object')
  const largeWidth = expectValueKind(objectProp(large, 'width'), 'number')
  expectRange(largeWidth.range, 'minWidth()..maxWidth()', 'number')
}

{
  const spec = expectSpecKind(parseFitSpecLine('given foo() > bar(10, "px")'), 'given-comparison')
  expectEqual(fitExpressionText(spec.left), 'foo()', 'expected left expression')
  expectEqual(spec.op, '>', 'expected comparison op')
  expectEqual(fitExpressionText(spec.right), 'bar(10, "px")', 'expected right expression')
}

{
  const spec = expectSpecKind(parseFitSpecLine('return: {rows: {height: 10..20}[], snap: [0..10, 20..30]}'), 'check-value')
  const root = expectValueKind(spec.value, 'object')
  const rows = expectValueKind(objectProp(root, 'rows'), 'array')
  const row = expectValueKind(rows.element, 'object')
  const rowHeight = expectValueKind(objectProp(row, 'height'), 'number')
  expectRange(rowHeight.range, '10..20', 'number')
  const snap = expectValueKind(objectProp(root, 'snap'), 'tuple')
  expectEqual(snap.elements.length, 2, 'expected tuple length')
  expectRange(expectValueKind(snap.elements[0]!, 'number').range, '0..10', 'number')
  expectRange(expectValueKind(snap.elements[1]!, 'number').range, '20..30', 'number')
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
  expectSpecKind(specs[0]!, 'given-range')
  expectSpecKind(specs[1]!, 'check-value')
  expectSpecKind(specs[2]!, 'check-expression')
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
