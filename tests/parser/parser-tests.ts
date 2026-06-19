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

function expect(condition: boolean, message: string): asserts condition {
  if (condition) return
  throw new Error(message)
}

{
  expectEqual(normalizeFitText('({return: return})'), '({return: __fit_return})', 'expected return replacement to preserve a static property name')
  expectEqual(
    normalizeFitText('rows.every(row => { return row.height > 0 })'),
    'rows.every(row => { return row.height > 0 })',
    'expected a callback return statement to remain source code',
  )
  expectEqual(
    normalizeFitText('rows.every(row => { return return.length > 0 })'),
    'rows.every(row => { return __fit_return.length > 0 })',
    'expected a callback return keyword and contract return value to stay distinct',
  )
  expectEqual(
    normalizeFitText('(({return: value}) => value)(return)'),
    '(({return: value}) => value)(__fit_return)',
    'expected a binding property named return to stay distinct from the contract return value',
  )

  const literal = parseFitExpressionText('label == "return rows[].height"')
  expectEqual(literal.parsed.domainPaths.size, 0, 'expected strings not to create domain paths')
  expectEqual(literal.parsed.expression.getText(), 'label == "return rows[].height"', 'expected string contents to stay unchanged')

  const regex = parseFitExpressionText('/return rows[].height/.test(label)')
  expectEqual(regex.parsed.domainPaths.size, 0, 'expected regex literals not to create domain paths')
  expectEqual(publicParsedExpressionText(regex.parsed, regex.parsed.expression), '/return rows[].height/.test(label)', 'expected regex contents to stay unchanged')

  const template = parseFitExpressionText('`before ${rows[].height} after return rows[].width`')
  expectEqual(template.parsed.domainPaths.size, 1, 'expected only the template expression to create a domain path')
  expectEqual(
    publicParsedExpressionText(template.parsed, template.parsed.expression),
    '`before ${rows[].height} after return rows[].width`',
    'expected template tail contents to stay unchanged',
  )

  const distinct = parseFitExpressionText('rows[].b_c == rows[].b.c')
  expectEqual(distinct.parsed.domainPaths.size, 2, 'expected distinct wildcard paths to keep distinct placeholders')
  expectEqual(publicParsedExpressionText(distinct.parsed, distinct.parsed.expression), 'rows[].b_c == rows[].b.c', 'expected wildcard paths to render back independently')

  const collision = parseFitExpressionText('rows[].height == __fit_domain_rows___item_height')
  expectEqual(collision.parsed.domainPaths.size, 1, 'expected one wildcard path beside a similarly named user identifier')
  expect(
    collision.parsed.expression.getText().split('==')[0]!.trim() !== collision.parsed.expression.getText().split('==')[1]!.trim(),
    'expected generated placeholders not to collide with user identifiers',
  )
  expectEqual(
    publicLinearName(`${domainPathLinearName('rows[].height')}@rows@loop1`),
    'rows[].height@rows@loop1',
    'expected internal path identity to render as the source path in reports',
  )

  const unicodeIndex = parseFitExpressionText('rows[$行 + 1].top >= rows[$行].bottom')
  expectEqual(unicodeIndex.parsed.domainPaths.size, 2, 'expected Unicode named indexes to parse')

  const compactPath = fitExpressionDomainPath(parseFitExpressionText('input.width'))
  const spacedPath = fitExpressionDomainPath(parseFitExpressionText('(input . width)'))
  expectEqual(JSON.stringify(spacedPath), JSON.stringify(compactPath), 'expected trivia and parentheses not to change path identity')
  expect(sameExpressionText('input.width', '(input . width)'), 'expected path proof identity to ignore trivia and parentheses')
  expect(sameExpressionText('input["width"]', 'input.width'), 'expected quoted and dotted static properties to share proof identity')

  const quotedPath = fitExpressionDomainPath(parseFitExpressionText('input["available-width"]'))
  expectEqual(quotedPath?.segments[0]?.kind, 'prop', 'expected quoted property path')
  expectEqual(quotedPath?.segments[0]?.kind === 'prop' ? quotedPath.segments[0].name : null, 'available-width', 'expected quoted property name')

  const decimalPath = fitExpressionDomainPath(parseFitExpressionText('input[1.5]'))
  const negativePath = fitExpressionDomainPath(parseFitExpressionText('input[-1]'))
  expectEqual(decimalPath?.segments[0]?.kind === 'prop' ? decimalPath.segments[0].name : null, '1.5', 'expected decimal numeric property name')
  expectEqual(negativePath?.segments[0]?.kind === 'prop' ? negativePath.segments[0].name : null, '-1', 'expected negative numeric property name')
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
  const spec = expectSpec(parseFitSpecLine('given x: 0<..10'), 'assume', 'range')
  expectRange(spec.range, '0<..10', 'number')
  expectEqual(spec.range.lowerInclusive, false, 'expected exclusive lower bound')
  expectEqual(spec.range.upperInclusive, true, 'expected inclusive upper bound')

  const open = expectSpec(parseFitSpecLine('given r: 0<..<1'), 'assume', 'range')
  expectEqual(open.range.lowerInclusive, false, 'expected open interval to exclude its lower bound')
  expectEqual(open.range.upperInclusive, false, 'expected open interval to exclude its upper bound')

  const finite = expectSpec(parseFitSpecLine('given pos: -Infinity<..<Infinity'), 'assume', 'range')
  expectEqual(finite.range.lowerValue, Number.NEGATIVE_INFINITY, 'expected -Infinity lower value')
  expectEqual(finite.range.lowerInclusive, false, 'expected finiteness spelling to exclude -Infinity')
  expectEqual(finite.range.upperInclusive, false, 'expected finiteness spelling to exclude Infinity')

  const intRange = expectSpec(parseFitSpecLine('given n: int 0<..10'), 'assume', 'range')
  expectRange(intRange.range, 'int 0<..10', 'int')
  expectEqual(intRange.range.lowerInclusive, false, 'expected exclusive int lower bound')

  const lowered = lowerFitValueSpecTextForTypeScript('{ratio: 0<..<1}')
  expect(lowered != null, 'expected exclusive-lower leaf to lower in value-spec position')
  expectEqual(lowered.typeText, '{ratio: __FRNumber<"r0">}', 'expected exclusive-lower leaf to become a branded number slot')
  expectEqual(lowered.ranges.get('r0')!.lowerInclusive, false, 'expected lowered leaf to keep exclusive lower')

  // The delimiter is exactly two dots: before the dot-run check, `0...10`
  // silently split as `0.` + `10` and meant 0..10.
  for (const bad of ['given x: 0...10', 'given x: 0<...10', 'given x: 0 < .. 10']) {
    try {
      parseFitSpecLine(bad)
      throw new Error(`expected '${bad}' to be rejected`)
    } catch (error) {
      expect(error instanceof Error, 'expected parser error')
      expect(error.message.includes('Unsupported @fit range'), `expected loud range rejection for '${bad}'`)
    }
  }

  for (const nan of ['given x: NaN', 'given x: Number.NaN', 'given x: 0..NaN', 'given x: 0..3 | NaN']) {
    try {
      parseFitSpecLine(nan)
      throw new Error(`expected '${nan}' to be rejected`)
    } catch (error) {
      expect(error instanceof Error, 'expected parser error')
      expect(error.message.includes('NaN is outside the checked numerical domain'), `expected direct NaN rejection for '${nan}'`)
    }
  }

  parseFitSpecLine('return: "NaN"')
  parseFitSpecLine('given input.NaN: 0..3')
  parseFitSpecLine('given x: 0..input.NaN')
  parseFitSpecLine('given x: 0..input . NaN')
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
  const stringLiteral = parseFitSpecLine('label == "return"', 1)
  const returnReference = parseFitSpecLine('return == label', 2)
  expect(!fitSpecMentionsRoot(stringLiteral, fitReturnInternalRoot), 'expected a string literal containing return not to become a return claim')
  expect(fitSpecMentionsRoot(returnReference, fitReturnInternalRoot), 'expected the parsed return identifier to be recognized')
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
