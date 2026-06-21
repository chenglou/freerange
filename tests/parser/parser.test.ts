import {expect} from 'bun:test'
import ts from 'typescript'
import {sameExpressionText} from '../../src/linear.ts'
import {
  domainPathLinearName,
  fitExpressionText,
  fitReturnInternalRoot,
  fitSpecMentionsRoot,
  fitExpressionDomainPath,
  fitValueSpecExpressions,
  lowerFitValueSpecTextForTypeScript,
  normalizeFitText,
  parseFitExpressionText,
  parseFitSpecLine,
  publicParsedExpressionText,
  parseFunctionBodyFitSpecIndex,
  parseFunctionFitSpecs,
  publicLinearName,
  type FitRange,
  type FitSpec,
} from '../../src/parser.ts'
import {testSuite} from '../test-suite.ts'

testSuite('parser suite', () => {

function expectPresent<T>(value: T | null | undefined): asserts value is T {
  expect(value).not.toBe(null)
  expect(value).toBeDefined()
}

{
  expect(normalizeFitText('({return: return})')).toBe('({return: __fit_return})')
  expect(normalizeFitText('rows.every(row => { return row.height > 0 })'))
    .toBe('rows.every(row => { return row.height > 0 })')
  expect(normalizeFitText('rows.every(row => { return return.length > 0 })'))
    .toBe('rows.every(row => { return __fit_return.length > 0 })')
  expect(normalizeFitText('(({return: value}) => value)(return)'))
    .toBe('(({return: value}) => value)(__fit_return)')

  const literal = parseFitExpressionText('label == "return rows[].height"')
  expect(literal.parsed.domainPaths.size).toBe(0)
  expect(literal.parsed.expression.getText()).toBe('label == "return rows[].height"')

  const regex = parseFitExpressionText('/return rows[].height/.test(label)')
  expect(regex.parsed.domainPaths.size).toBe(0)
  expect(publicParsedExpressionText(regex.parsed, regex.parsed.expression)).toBe('/return rows[].height/.test(label)')

  const template = parseFitExpressionText('`before ${rows[].height} after return rows[].width`')
  expect(template.parsed.domainPaths.size).toBe(1)
  expect(publicParsedExpressionText(template.parsed, template.parsed.expression))
    .toBe('`before ${rows[].height} after return rows[].width`')

  const distinct = parseFitExpressionText('rows[].b_c == rows[].b.c')
  expect(distinct.parsed.domainPaths.size).toBe(2)
  expect(publicParsedExpressionText(distinct.parsed, distinct.parsed.expression)).toBe('rows[].b_c == rows[].b.c')

  const collision = parseFitExpressionText('rows[].height == __fit_domain_rows___item_height')
  expect(collision.parsed.domainPaths.size).toBe(1)
  expect(collision.parsed.expression.getText().split('==')[0]!.trim())
    .not.toBe(collision.parsed.expression.getText().split('==')[1]!.trim())
  expect(publicLinearName(`${domainPathLinearName('rows[].height')}@rows@loop1`)).toBe('rows[].height@rows@loop1')

  const unicodeIndex = parseFitExpressionText('rows[$行 + 1].top >= rows[$行].bottom')
  expect(unicodeIndex.parsed.domainPaths.size).toBe(2)

  const compactPath = fitExpressionDomainPath(parseFitExpressionText('input.width'))
  const spacedPath = fitExpressionDomainPath(parseFitExpressionText('(input . width)'))
  expect(spacedPath).toEqual(compactPath)
  expect(sameExpressionText('input.width', '(input . width)')).toBe(true)
  expect(sameExpressionText('input["width"]', 'input.width')).toBe(true)

  const quotedPath = fitExpressionDomainPath(parseFitExpressionText('input["available-width"]'))
  expect(quotedPath?.segments[0]?.kind).toBe('prop')
  expect(quotedPath?.segments[0]?.kind === 'prop' ? quotedPath.segments[0].name : null).toBe('available-width')

  const decimalPath = fitExpressionDomainPath(parseFitExpressionText('input[1.5]'))
  const negativePath = fitExpressionDomainPath(parseFitExpressionText('input[-1]'))
  expect(decimalPath?.segments[0]?.kind === 'prop' ? decimalPath.segments[0].name : null).toBe('1.5')
  expect(negativePath?.segments[0]?.kind === 'prop' ? negativePath.segments[0].name : null).toBe('-1')
}

function sourceFile(source: string) {
  return ts.createSourceFile('parser-test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function firstFunction(source: string) {
  const file = sourceFile(source)
  const fn = file.statements.find(ts.isFunctionDeclaration)
  expectPresent(fn)
  return {file, fn}
}

function expectSpec<R extends FitSpec['role'], K extends Extract<FitSpec, {role: R}>['kind']>(
  spec: FitSpec,
  role: R,
  kind: K,
): Extract<FitSpec, {role: R; kind: K}> {
  expect(spec.role).toBe(role)
  expect(spec.kind).toBe(kind)
  return spec as Extract<FitSpec, {role: R; kind: K}>
}

function expectRange(range: FitRange, text: string, valueKind: 'number' | 'int') {
  expect(range.text).toBe(text)
  expect(range.valueKind).toBe(valueKind)
}

{
  const lowered = lowerFitValueSpecTextForTypeScript('{kind: "small", width: 100..200, cols: int 1..<7} | {kind: "large", width: minWidth()..maxWidth(), cols: 7}')
  expectPresent(lowered)
  expect(lowered.typeText)
    .toBe('{kind: "small", width: __FRNumber<"r0">, cols: __FRNumber<"r1">} | {kind: "large", width: __FRNumber<"r2">, cols: 7}')
  expect(lowered.ranges.size).toBe(3)

  const spec = expectSpec(
    parseFitSpecLine('return: {kind: "small", width: 100..200, cols: int 1..<7} | {kind: "large", width: minWidth()..maxWidth(), cols: 7}', 12),
    'prove',
    'value',
  )
  expect(fitExpressionText(spec.expression)).toBe('__fit_return')
  expect(spec.line).toBe(12)
  expect(spec.value.typeText).toBe(lowered.typeText)
  expect(spec.value.ranges.size).toBe(3)
  expect(ts.isUnionTypeNode(spec.value.typeNode)).toBe(true)
  expectRange(spec.value.ranges.get('r0')!, '100..200', 'number')
  const smallCols = spec.value.ranges.get('r1')!
  expectRange(smallCols, 'int 1..<7', 'int')
  expect(smallCols.upperInclusive).toBe(false)
  expectRange(spec.value.ranges.get('r2')!, 'minWidth()..maxWidth()', 'number')
}

{
  const spec = expectSpec(parseFitSpecLine('given x: 0<..10'), 'assume', 'range')
  expectRange(spec.range, '0<..10', 'number')
  expect(spec.range.lowerInclusive).toBe(false)
  expect(spec.range.upperInclusive).toBe(true)

  const open = expectSpec(parseFitSpecLine('given r: 0<..<1'), 'assume', 'range')
  expect(open.range.lowerInclusive).toBe(false)
  expect(open.range.upperInclusive).toBe(false)

  const finite = expectSpec(parseFitSpecLine('given pos: -Infinity<..<Infinity'), 'assume', 'range')
  expect(finite.range.lowerValue).toBe(Number.NEGATIVE_INFINITY)
  expect(finite.range.lowerInclusive).toBe(false)
  expect(finite.range.upperInclusive).toBe(false)

  const intRange = expectSpec(parseFitSpecLine('given n: int 0<..10'), 'assume', 'range')
  expectRange(intRange.range, 'int 0<..10', 'int')
  expect(intRange.range.lowerInclusive).toBe(false)

  const lowered = lowerFitValueSpecTextForTypeScript('{ratio: 0<..<1}')
  expectPresent(lowered)
  expect(lowered.typeText).toBe('{ratio: __FRNumber<"r0">}')
  expect(lowered.ranges.get('r0')!.lowerInclusive).toBe(false)

  // The delimiter is exactly two dots: before the dot-run check, `0...10`
  // silently split as `0.` + `10` and meant 0..10.
  for (const bad of ['given x: 0...10', 'given x: 0<...10', 'given x: 0 < .. 10']) {
    expect(() => parseFitSpecLine(bad)).toThrow('Unsupported @fit range')
  }

  for (const nan of ['given x: NaN', 'given x: Number.NaN', 'given x: 0..NaN', 'given x: 0..3 | NaN']) {
    expect(() => parseFitSpecLine(nan)).toThrow('NaN is outside the checked numerical domain')
  }

  parseFitSpecLine('return: "NaN"')
  parseFitSpecLine('given input.NaN: 0..3')
  parseFitSpecLine('given x: 0..input.NaN')
  parseFitSpecLine('given x: 0..input . NaN')
}

{
  const spec = expectSpec(parseFitSpecLine('given foo() > bar(10, "px")'), 'assume', 'comparison')
  expect(fitExpressionText(spec.left)).toBe('foo()')
  expect(spec.op).toBe('>')
  expect(fitExpressionText(spec.right)).toBe('bar(10, "px")')
}

{
  const spec = expectSpec(parseFitSpecLine('given isSorted(items)'), 'assume', 'expression')
  expect(fitExpressionText(spec.expression)).toBe('isSorted(items)')
}

{
  const spec = expectSpec(parseFitSpecLine('return >= min'), 'prove', 'comparison')
  expect(fitExpressionText(spec.left)).toBe('__fit_return')
}

{
  expect(() => parseFitSpecLine('given return: {width: 0..10}')).toThrow('Unsupported @fit range')
}

{
  const spec = expectSpec(parseFitSpecLine('return: {rows: {height: 10..20}[], snap: [0..10, 20..30]}'), 'prove', 'value')
  expect(spec.value.typeText).toBe('{rows: {height: __FRNumber<"r0">}[], snap: [__FRNumber<"r1">, __FRNumber<"r2">]}')
  expect(spec.value.ranges.size).toBe(3)
  expect(fitValueSpecExpressions(spec.value).map(fitExpressionText).join(', ')).toBe('10, 20, 0, 10, 20, 30')
}

{
  const spec = expectSpec(parseFitSpecLine('return: ({left: 0..10} & {width: int 1..5}) | {kind: "empty", width: 0}'), 'prove', 'value')
  expect(spec.value.typeText).toBe('({left: __FRNumber<"r0">} & {width: __FRNumber<"r1">}) | {kind: "empty", width: 0}')
  expect(ts.isUnionTypeNode(spec.value.typeNode)).toBe(true)
  expect(spec.value.ranges.size).toBe(2)
}

{
  const spec = expectSpec(parseFitSpecLine('return: Box<{width: 0..maxWidth()}>'), 'prove', 'value')
  expect(spec.value.typeText).toBe('Box<{width: __FRNumber<"r0">}>')
  expect(ts.isTypeReferenceNode(spec.value.typeNode)).toBe(true)
  expect(fitValueSpecExpressions(spec.value).map(fitExpressionText).join(', ')).toBe('0, maxWidth()')
}

{
  expect(() => parseFitSpecLine('return: {width: dynamicWidth()}')).toThrow('Unsupported @fit value spec')
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
  expect(specs).toHaveLength(3)
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
  expect(index.localSpecsByStatement.size).toBe(1)
  expect(index.objectPropertyTemplatesByNode.size).toBe(2)
  expect(index.returnSpecsByNode.size).toBe(0)
}

{
  const stringLiteral = parseFitSpecLine('label == "return"', 1)
  const returnReference = parseFitSpecLine('return == label', 2)
  expect(fitSpecMentionsRoot(stringLiteral, fitReturnInternalRoot)).toBe(false)
  expect(fitSpecMentionsRoot(returnReference, fitReturnInternalRoot)).toBe(true)
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
  expect(() => parseFunctionBodyFitSpecIndex(source, fn))
    .toThrow('Unsupported inline @fit range: @fit return: {width: 0..10}')
}

{
  const source = `function layout(
  value: number /* @fit 0..10 */,
) {
  return value
}
`
  const {fn} = firstFunction(source)
  expect(() => parseFunctionFitSpecs(source, fn, fn.parameters))
    .toThrow('Block @fit comments are only supported for function, loop, and type contract blocks')
}

})
