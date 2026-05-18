import * as ts from 'typescript'

export type FitDomainPath = {
  root: string
  segments: FitDomainPathSegment[]
}

export type FitDomainPathSegment =
  | {kind: 'prop'; name: string}
  | {kind: 'item'; label?: string; offset?: number}

export type ParsedFitExpression = {
  expression: ts.Expression
  domainPaths: Map<string, FitDomainPath>
}

export type FitExpression = {
  text: string
  parsed: ParsedFitExpression
  scopeSourceId?: string
}

export type FitExpressionLike = string | FitExpression

export type FitRangeCase = {
  lower: FitExpression
  upper: FitExpression
  lowerValue: number | null
  upperValue: number | null
  lowerInclusive: boolean
  upperInclusive: boolean
}

export type FitRange = FitRangeCase & {
  valueKind: 'int' | 'number'
  alternatives?: FitRangeCase[]
  finiteValues?: number[]
  text: string
}

export type FitSpec =
  | {
      kind: 'given-range'
      expression: FitExpression
      range: FitRange
      text: string
      line?: number
    }
  | {
      kind: 'given-comparison'
      left: FitExpression
      op: ComparisonOperator
      right: FitExpression
      text: string
      line?: number
    }
  | {
      kind: 'check-range'
      expression: FitExpression
      range: FitRange
      text: string
      line?: number
    }
  | {
      kind: 'check-comparison'
      left: FitExpression
      op: ComparisonOperator
      right: FitExpression
      text: string
      line?: number
    }
  | {
      kind: 'check-atom'
      name: string
      args: FitExpression[]
      text: string
      line?: number
    }

export type ComparisonOperator = '==' | '>=' | '<=' | '>' | '<'
export type FitCheckSpec = Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'}>
export type FitGivenSpec = Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>

export type FitInlineSpecTemplate =
  | {
      kind: 'range'
      range: FitRange
      line?: number
    }
  | {
      kind: 'comparison'
      op: ComparisonOperator
      right: FitExpression
      line?: number
    }

export type FitBodySpecIndex = {
  localSpecsByStatement: Map<ts.VariableStatement, FitCheckSpec[]>
  returnSpecsByNode: Map<ts.Node, FitCheckSpec[]>
  objectPropertyTemplatesByNode: Map<ts.PropertyAssignment | ts.ShorthandPropertyAssignment, FitInlineSpecTemplate[]>
  loopSpecsByStatement: Map<ts.ForOfStatement | ts.ForStatement, FitSpec[]>
}

type FitExpressionParser = (text: string) => FitExpression

const identifierPattern = '[A-Za-z_$][\\w$]*'
const indexLabelPattern = '\\$[A-Za-z_][\\w$]*(?:\\s*[+-]\\s*\\d+)?'
const domainPathPattern = new RegExp(`${identifierPattern}(?:(?:\\.${identifierPattern})|(?:\\[(?:\\]|${indexLabelPattern}\\])))+`, 'g')
export const fitReturnPublicRoot = 'return'
export const fitReturnInternalRoot = '__fit_return'
const publicReturnRootPattern = /(?<![\w$.])return(?![\w$])/g
const internalReturnRootPattern = /(?<![\w$.])__fit_return(?![\w$])/g
const parsedExpressionCache = new Map<string, ParsedFitExpression>()
const parsedExpressionFailures = new Map<string, string>()

export type FitCommentLine = {
  text: string
  line: number
  pos: number
}

export function normalizeFitText(text: string) {
  if (!text.includes(fitReturnPublicRoot)) return text
  return text.replace(publicReturnRootPattern, fitReturnInternalRoot)
}

export function publicFitText(text: string) {
  if (!text.includes(fitReturnInternalRoot)) return text
  return text.replace(internalReturnRootPattern, fitReturnPublicRoot)
}

export function publicParsedExpressionText(parsed: ParsedFitExpression, expression: ts.Expression) {
  let text = expression.getText()
  for (const [synthetic, domainPath] of parsed.domainPaths) {
    text = text.replace(new RegExp(`(?<![\\w$])${escapeRegExp(synthetic)}(?![\\w$])`, 'g'), domainPathText(domainPath))
  }
  return publicFitText(text)
}

export function parseFitExpressionText(text: string): FitExpression {
  const normalizedText = normalizeFitText(text)
  return {text: normalizedText, parsed: cachedParsedFitExpression(normalizedText)}
}

export function fitExpressionText(expression: FitExpressionLike) {
  return typeof expression === 'string' ? expression : expression.text
}

export function fitExpressionParsed(expression: FitExpressionLike) {
  return typeof expression === 'string' ? parseFitExpression(expression) : expression.parsed
}

function fitExpressionFromParsedExpression(parsed: ParsedFitExpression, expression: ts.Expression): FitExpression {
  return {
    text: normalizeFitText(publicParsedExpressionText(parsed, expression)),
    parsed: {expression, domainPaths: parsed.domainPaths},
  }
}

export function fitExpressionScopeSourceId(expression: FitExpressionLike) {
  return typeof expression === 'string' ? undefined : expression.scopeSourceId
}

export function withFitExpressionScope(expression: FitExpression, scopeSourceId: string | undefined): FitExpression {
  return scopeSourceId == null ? expression : {...expression, scopeSourceId}
}

export function fitRangeCases(range: FitRange): FitRangeCase[] {
  return range.alternatives ?? [{
    lower: range.lower,
    upper: range.upper,
    lowerValue: range.lowerValue,
    upperValue: range.upperValue,
    lowerInclusive: range.lowerInclusive,
    upperInclusive: range.upperInclusive,
  }]
}

export function parseFitSpecs(sourceText: string, node: ts.Node): FitSpec[] {
  const comments = fitCommentLines(sourceText, node)
  const specs: FitSpec[] = []

  for (const lines of comments) {
    if (lines.some(line => line.text === '@fit-loop')) throw new Error('Use @fit for loop specs; @fit-loop is not supported')
    if (!lines.some(line => line.text === '@fit')) continue
    for (const line of lines) {
      if (line.text.length === 0 || line.text === '@fit') continue
      if (line.text.startsWith('@fit')) throw new Error(`Unsupported @fit marker: ${line.text}`)
      specs.push(parseFitSpecLine(line.text, line.line))
    }
  }

  return specs
}

export function fitBlockSpecCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  const lines: FitCommentLine[] = []
  for (const commentLines of fitCommentLines(sourceText, node)) {
    if (commentLines.some(line => line.text === '@fit-loop')) throw new Error('Use @fit for loop specs; @fit-loop is not supported')
    if (!commentLines.some(line => line.text === '@fit')) continue
    for (const line of commentLines) {
      if (line.text.length === 0 || line.text === '@fit') continue
      if (line.text.startsWith('@fit')) throw new Error(`Unsupported @fit marker: ${line.text}`)
      lines.push(line)
    }
  }
  return lines
}

export function parseFunctionFitSpecs(
  sourceText: string,
  specNode: ts.Node,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
): FitSpec[] {
  return [
    ...parseFitSpecs(sourceText, specNode),
    ...parameters.flatMap(param => parseParamFitSpecs(sourceText, param)),
  ]
}

export function parseParamFitSpecs(sourceText: string, param: ts.ParameterDeclaration): FitGivenSpec[] {
  rejectInlineBlockFitComments(sourceText, param)
  const lines = inlineFitCommentLines(sourceText, param)
  if (lines.length === 0) return []
  if (!ts.isIdentifier(param.name)) throw new Error('Param @fit comments support simple identifier parameters')
  const paramName = param.name.text
  return instantiateInlineFitTemplates(lines.map(parseInlineFitTemplate), paramName, 'given')
}

export function hasFitComment(sourceText: string, node: ts.Node): boolean {
  return fitCommentLines(sourceText, node).some(lines => lines.some(line => line.text === '@fit'))
}

export function hasInlineFitComment(sourceText: string, node: ts.Node): boolean {
  rejectInlineBlockFitComments(sourceText, node)
  return inlineFitCommentLines(sourceText, node).length > 0
}

export function parseLocalFitSpecs(sourceText: string, statement: ts.VariableStatement): FitCheckSpec[] {
  rejectInlineBlockFitComments(sourceText, statement)
  const lines = inlineFitCommentLines(sourceText, statement)
  if (lines.length === 0) return []
  const declarations = statement.declarationList.declarations
  if (declarations.length !== 1 || !ts.isIdentifier(declarations[0]!.name)) {
    throw new Error('Inline @fit comments support one simple variable declaration')
  }
  const expression = declarations[0]!.name.text
  return instantiateInlineFitTemplates(lines.map(parseInlineFitTemplate), expression, 'check')
}

export function parseInlineFitSpecsForExpression(sourceText: string, node: ts.Node, expression: string): FitCheckSpec[] {
  rejectInlineBlockFitComments(sourceText, node)
  return instantiateInlineFitTemplates(parseInlineFitTemplatesForNode(sourceText, node), expression, 'check')
}

export function parseInlineGivenFitSpecsForExpression(sourceText: string, node: ts.Node, expression: string): FitGivenSpec[] {
  rejectInlineBlockFitComments(sourceText, node)
  return instantiateInlineFitTemplates(parseInlineFitTemplatesForNode(sourceText, node), expression, 'given')
}

export function inlineFitCommentLinesForNode(sourceText: string, node: ts.Node): FitCommentLine[] {
  return inlineFitCommentLines(sourceText, node)
}

export function parseInlineFitTemplatesForNode(sourceText: string, node: ts.Node): FitInlineSpecTemplate[] {
  rejectInlineBlockFitComments(sourceText, node)
  return inlineFitCommentLines(sourceText, node).map(parseInlineFitTemplate)
}

export function instantiateInlineFitTemplates(templates: FitInlineSpecTemplate[], expression: string, mode: 'check'): FitCheckSpec[]
export function instantiateInlineFitTemplates(templates: FitInlineSpecTemplate[], expression: string, mode: 'given'): FitGivenSpec[]
export function instantiateInlineFitTemplates(
  templates: FitInlineSpecTemplate[],
  expression: string,
  mode: 'check' | 'given',
): FitCheckSpec[] | FitGivenSpec[] {
  const parsedExpression = parseFitExpressionText(expression)
  const publicExpression = publicFitText(expression)
  const specs: FitSpec[] = []
  for (const template of templates) {
    switch (template.kind) {
      case 'comparison': {
        const text = `${publicExpression} ${template.op} ${publicFitText(template.right.text)}`
        specs.push(mode === 'given'
          ? {
            kind: 'given-comparison',
            left: parsedExpression,
            op: template.op,
            right: template.right,
            text: `given ${text}`,
            ...(template.line == null ? {} : {line: template.line}),
          }
          : {
            kind: 'check-comparison',
            left: parsedExpression,
            op: template.op,
            right: template.right,
            text,
            ...(template.line == null ? {} : {line: template.line}),
          })
        break
      }
      case 'range': {
        const text = `${publicExpression}: ${publicFitText(template.range.text)}`
        specs.push(mode === 'given'
          ? {
            kind: 'given-range',
            expression: parsedExpression,
            range: template.range,
            text: `given ${text}`,
            ...(template.line == null ? {} : {line: template.line}),
          }
          : {
            kind: 'check-range',
            expression: parsedExpression,
            range: template.range,
            text,
            ...(template.line == null ? {} : {line: template.line}),
          })
        break
      }
    }
  }
  return mode === 'given' ? specs as FitGivenSpec[] : specs as FitCheckSpec[]
}

export function emptyFitBodySpecIndex(): FitBodySpecIndex {
  return {
    localSpecsByStatement: new Map(),
    returnSpecsByNode: new Map(),
    objectPropertyTemplatesByNode: new Map(),
    loopSpecsByStatement: new Map(),
  }
}

export function fitBodySpecIndexHasWork(index: FitBodySpecIndex | undefined) {
  return index != null
    && (index.localSpecsByStatement.size > 0
      || index.returnSpecsByNode.size > 0
      || index.objectPropertyTemplatesByNode.size > 0
      || index.loopSpecsByStatement.size > 0)
}

export function parseFunctionBodyFitSpecIndex(sourceText: string, fn: ts.FunctionLikeDeclaration): FitBodySpecIndex {
  const index = emptyFitBodySpecIndex()
  if (ts.isArrowFunction(fn) && ts.isExpression(fn.body)) {
    const specs = parseInlineFitSpecsForExpression(sourceText, fn, fitReturnPublicRoot)
    if (specs.length > 0) index.returnSpecsByNode.set(fn, specs)
    collectBodyFitSpecIndex(sourceText, fn.body, index)
    return index
  }
  if (fn.body == null) return index
  collectBodyFitSpecIndex(sourceText, fn.body, index)
  return index
}

export function parseTopLevelFitSpecIndex(sourceText: string, sourceFile: ts.SourceFile): FitBodySpecIndex {
  const index = emptyFitBodySpecIndex()
  for (const statement of sourceFile.statements) {
    if (topLevelDeclarationOnly(statement)) continue
    collectBodyFitSpecIndexForNode(sourceText, statement, index)
  }
  return index
}

function collectBodyFitSpecIndex(sourceText: string, root: ts.Node, index: FitBodySpecIndex) {
  const visit = (node: ts.Node) => {
    if (node !== root && isFunctionLikeWithBodyNode(node)) return
    collectBodyFitSpecIndexForNode(sourceText, node, index)
    ts.forEachChild(node, visit)
  }
  visit(root)
}

function collectBodyFitSpecIndexForNode(sourceText: string, node: ts.Node, index: FitBodySpecIndex) {
  if (ts.isVariableStatement(node)) {
    const specs = parseLocalFitSpecs(sourceText, node)
    if (specs.length > 0) index.localSpecsByStatement.set(node, specs)
    return
  }
  if (ts.isReturnStatement(node) && node.expression != null) {
    const specs = parseInlineFitSpecsForExpression(sourceText, node, fitReturnPublicRoot)
    if (specs.length > 0) index.returnSpecsByNode.set(node, specs)
    return
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    const templates = parseInlineFitTemplatesForNode(sourceText, node)
    if (templates.length > 0) index.objectPropertyTemplatesByNode.set(node, templates)
    return
  }
  if (ts.isForOfStatement(node) || ts.isForStatement(node)) {
    const specs = parseFitSpecs(sourceText, node)
    if (specs.length > 0) index.loopSpecsByStatement.set(node, specs)
  }
}

function topLevelDeclarationOnly(statement: ts.Statement) {
  return ts.isImportDeclaration(statement)
    || ts.isExportDeclaration(statement)
    || ts.isFunctionDeclaration(statement)
    || ts.isClassDeclaration(statement)
    || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || ts.isModuleDeclaration(statement)
    || ts.isEnumDeclaration(statement)
}

function isFunctionLikeWithBodyNode(node: ts.Node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
}

function fitCommentLines(sourceText: string, node: ts.Node): FitCommentLine[][] {
  const commentRanges = ts.getLeadingCommentRanges(sourceText, node.pos) ?? []
  return commentRanges.map(range => commentRangeLines(sourceText, range))
}

function inlineFitCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  const commentRanges = ts.getLeadingCommentRanges(sourceText, node.pos) ?? []
  return uniqueLines([
    ...commentRanges
      .filter(range => range.kind === ts.SyntaxKind.SingleLineCommentTrivia)
      .flatMap(range => commentRangeLines(sourceText, range))
      .filter(line => line.text.startsWith('@fit ')),
    ...trailingLineFitCommentLines(sourceText, node),
  ])
}

function inlineBlockFitCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  const commentRanges = ts.getLeadingCommentRanges(sourceText, node.pos) ?? []
  return uniqueLines([
    ...commentRanges
      .filter(range => range.kind === ts.SyntaxKind.MultiLineCommentTrivia)
      .flatMap(range => {
        const lines = commentRangeLines(sourceText, range)
        return lines.some(line => line.text === '@fit') ? [] : lines
      })
      .filter(line => line.text.startsWith('@fit')),
    ...trailingBlockFitCommentLines(sourceText, node),
  ])
}

function rejectInlineBlockFitComments(sourceText: string, node: ts.Node) {
  const line = inlineBlockFitCommentLines(sourceText, node)[0]
  if (line == null) return
  throw new Error(`Block @fit comments are only supported for function, loop, and type contract blocks; use // @fit for attached facts near line ${line.line}`)
}

function trailingLineFitCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  const lineEnd = sourceText.indexOf('\n', node.end)
  const restOfLine = sourceText.slice(node.end, lineEnd < 0 ? sourceText.length : lineEnd)
  const commentStart = restOfLine.indexOf('//')
  if (commentStart < 0) return []
  const line = cleanCommentLine(restOfLine.slice(commentStart))
  return line.startsWith('@fit ')
    ? [{text: line, line: lineNumberAtPosition(sourceText, node.end + commentStart), pos: node.end + commentStart}]
    : []
}

function trailingBlockFitCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  const lineEnd = sourceText.indexOf('\n', node.end)
  const restOfLine = sourceText.slice(node.end, lineEnd < 0 ? sourceText.length : lineEnd)
  const commentPattern = /\/\*[\s\S]*?\*\//g
  const lines: FitCommentLine[] = []
  for (;;) {
    const match = commentPattern.exec(restOfLine)
    if (match == null) break
    const pos = node.end + match.index
    lines.push(...commentRangeLines(sourceText, {
      pos,
      end: pos + match[0].length,
      kind: ts.SyntaxKind.MultiLineCommentTrivia,
      hasTrailingNewLine: false,
    }).filter(line => line.text.startsWith('@fit')))
  }
  return lines
}

function uniqueLines(lines: FitCommentLine[]) {
  const seen = new Set<string>()
  const unique: FitCommentLine[] = []
  for (const line of lines) {
    const key = `${line.line}:${line.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(line)
  }
  return unique
}

function commentRangeLines(sourceText: string, range: ts.CommentRange): FitCommentLine[] {
  const lines: FitCommentLine[] = []
  const text = sourceText.slice(range.pos, range.end)
  const rawLines = text.split(/\r?\n/)
  let offset = 0
  for (const rawLine of rawLines) {
    lines.push({
      text: cleanCommentLine(rawLine),
      line: lineNumberAtPosition(sourceText, range.pos + offset),
      pos: range.pos + offset,
    })
    offset += rawLine.length
    const next = sourceText.slice(range.pos + offset, range.pos + offset + 2)
    offset += next === '\r\n' ? 2 : sourceText[range.pos + offset] === '\n' ? 1 : 0
  }
  return lines
}

function cleanCommentLine(line: string) {
  return line
    .replace(/^\s*\/\*\*?/, '')
    .replace(/^\s*\/\//, '')
    .replace(/\*\/\s*$/, '')
    .replace(/^\s*\*\s?/, '')
    .trim()
}

function lineNumberAtPosition(sourceText: string, position: number) {
  let line = 1
  for (let index = 0; index < position; index++) {
    if (sourceText.charCodeAt(index) === 10) line++
  }
  return line
}

const numberPattern = '-?\\d+(?:\\.\\d+)?'
const rangeNumberPattern = new RegExp(`^(?:${numberPattern}|-?Infinity)$`)

export function parseFitSpecLine(line: string, lineNumber?: number): FitSpec {
  const givenRange = /^given\s+(.+)\s*:\s*(.+)$/.exec(line)
  if (givenRange != null) {
    const expression = parseFitExpressionText(givenRange[1]!.trim())
    const range = parseFitRangeText(givenRange[2]!.trim())
    if (range == null) throw new Error(`Unsupported @fit range: ${line}`)
    return {
      kind: 'given-range',
      expression,
      range,
      text: line,
      ...(lineNumber == null ? {} : {line: lineNumber}),
    }
  }

  const givenComparison = /^given\s+(.+?)\s*(==|>=|<=|>|<)\s*(.+)$/.exec(line)
  if (givenComparison != null) {
    const left = parseFitExpressionText(givenComparison[1]!.trim())
    const right = parseFitExpressionText(givenComparison[3]!.trim())
    return {
      kind: 'given-comparison',
      left,
      op: givenComparison[2]! as ComparisonOperator,
      right,
      text: line,
      ...(lineNumber == null ? {} : {line: lineNumber}),
    }
  }

  const checkRange = /^(.+)\s*:\s*(.+)$/.exec(line)
  if (checkRange != null) {
    const expression = parseFitExpressionText(checkRange[1]!.trim())
    const range = parseFitRangeText(checkRange[2]!.trim())
    if (range == null) throw new Error(`Unsupported @fit range: ${line}`)
    return {
      kind: 'check-range',
      expression,
      range,
      text: line,
      ...(lineNumber == null ? {} : {line: lineNumber}),
    }
  }

  const checkComparison = /^(.+?)\s*(==|>=|<=|>|<)\s*(.+)$/.exec(line)
  if (checkComparison != null) {
    const left = parseFitExpressionText(checkComparison[1]!.trim())
    const right = parseFitExpressionText(checkComparison[3]!.trim())
    return {
      kind: 'check-comparison',
      left,
      op: checkComparison[2]! as ComparisonOperator,
      right,
      text: line,
      ...(lineNumber == null ? {} : {line: lineNumber}),
    }
  }

  const checkAtom = parseCheckAtom(line, lineNumber)
  if (checkAtom != null) return checkAtom

  throw new Error(`Unsupported @fit line: ${line}`)
}

export function parseFitRangeText(text: string, parseExpression: FitExpressionParser = parseFitExpressionText): FitRange | null {
  const valueKindMatch = /^(?:(int)\s+)?([\s\S]+)$/.exec(text)
  if (valueKindMatch == null) return null
  const body = valueKindMatch[2]!.trim()
  const valueKind = valueKindMatch[1] == null ? 'number' : 'int'

  const alternatives = splitTopLevelAlternatives(body)
  if (alternatives != null) {
    const cases = alternatives.map(part => parseFitRangeCaseText(part, parseExpression))
    if (cases.some(item => item == null)) return null
    const rangeCases = cases as FitRangeCase[]
    const envelope = rangeCaseEnvelope(rangeCases)
    const finiteValues = finiteValuesFromRangeCases(rangeCases)
    return {
      valueKind,
      ...envelope,
      ...(rangeCases.length === 1 ? {} : {alternatives: rangeCases}),
      ...(finiteValues == null ? {} : {finiteValues}),
      text,
    }
  }

  const single = parseFitRangeCaseText(body, parseExpression)
  if (single == null) return null
  return {
    valueKind,
    ...single,
    text,
  }
}

function parseFitRangeCaseText(text: string, parseExpression: FitExpressionParser): FitRangeCase | null {
  const bounds = splitRangeBounds(text)
  if (bounds != null) {
    const {upperInclusive} = bounds
    const lower = normalizeFitText(bounds.lower)
    const upper = normalizeFitText(bounds.upper)
    if (!isRangeBoundText(lower) || !isRangeBoundText(upper)) return null
    return {
      lower: parseExpression(lower),
      upper: parseExpression(upper),
      lowerValue: parseRangeBoundNumber(lower),
      upperValue: parseRangeBoundNumber(upper),
      lowerInclusive: true,
      upperInclusive,
    }
  }
  if (isRangeBoundText(text)) {
    const normalizedBody = normalizeFitText(text)
    const expression = parseExpression(normalizedBody)
    return {
      lower: expression,
      upper: expression,
      lowerValue: parseRangeBoundNumber(normalizedBody),
      upperValue: parseRangeBoundNumber(normalizedBody),
      lowerInclusive: true,
      upperInclusive: true,
    }
  }
  return null
}

function rangeCaseEnvelope(cases: FitRangeCase[]): FitRangeCase {
  const lowerCase = cases.reduce((best, current) => rangeCaseLowerSortValue(current) < rangeCaseLowerSortValue(best) ? current : best)
  const upperCase = cases.reduce((best, current) => rangeCaseUpperSortValue(current) > rangeCaseUpperSortValue(best) ? current : best)
  return {
    lower: lowerCase.lower,
    upper: upperCase.upper,
    lowerValue: cases.every(item => item.lowerValue != null) ? Math.min(...cases.map(item => item.lowerValue!)) : null,
    upperValue: cases.every(item => item.upperValue != null) ? Math.max(...cases.map(item => item.upperValue!)) : null,
    lowerInclusive: lowerCase.lowerInclusive,
    upperInclusive: upperCase.upperInclusive,
  }
}

function rangeCaseLowerSortValue(rangeCase: FitRangeCase) {
  return rangeCase.lowerValue ?? Number.NEGATIVE_INFINITY
}

function rangeCaseUpperSortValue(rangeCase: FitRangeCase) {
  return rangeCase.upperValue ?? Number.POSITIVE_INFINITY
}

function finiteValuesFromRangeCases(cases: FitRangeCase[]): number[] | null {
  const values: number[] = []
  for (const rangeCase of cases) {
    if (
      rangeCase.lowerValue == null
      || rangeCase.upperValue == null
      || rangeCase.lowerValue !== rangeCase.upperValue
      || !Number.isFinite(rangeCase.lowerValue)
      || !rangeCase.lowerInclusive
      || !rangeCase.upperInclusive
    ) return null
    values.push(rangeCase.lowerValue)
  }
  const unique = [...new Set(values)]
  return unique.length === 0 ? null : unique.sort((left, right) => left - right)
}

function splitTopLevelAlternatives(text: string): string[] | null {
  const parts: string[] = []
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let quote: '"' | "'" | '`' | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote != null) {
      if (char === '\\') i++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') parenDepth++
    else if (char === ')') parenDepth--
    else if (char === '[') bracketDepth++
    else if (char === ']') bracketDepth--
    else if (char === '{') braceDepth++
    else if (char === '}') braceDepth--
    else if (char === '|' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (text[i - 1] === '|' || text[i + 1] === '|') return null
      const part = text.slice(start, i).trim()
      if (part.length === 0) return null
      parts.push(part)
      start = i + 1
    }
  }
  if (parts.length === 0) return null
  const last = text.slice(start).trim()
  if (last.length === 0) return null
  parts.push(last)
  return parts
}

function splitRangeBounds(text: string): {lower: string; upper: string; upperInclusive: boolean} | null {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let quote: '"' | "'" | '`' | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote != null) {
      if (char === '\\') i++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') parenDepth++
    else if (char === ')') parenDepth--
    else if (char === '[') bracketDepth++
    else if (char === ']') bracketDepth--
    else if (char === '{') braceDepth++
    else if (char === '}') braceDepth--
    else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (text.startsWith('..<', i)) {
        const lower = text.slice(0, i).trim()
        const upper = text.slice(i + 3).trim()
        return lower.length === 0 || upper.length === 0 ? null : {lower, upper, upperInclusive: false}
      }
      if (text.startsWith('..', i) && !text.startsWith('...', i)) {
        const lower = text.slice(0, i).trim()
        const upper = text.slice(i + 2).trim()
        return lower.length === 0 || upper.length === 0 ? null : {lower, upper, upperInclusive: true}
      }
    }
  }
  return null
}

function parseInlineFitTemplate(line: FitCommentLine): FitInlineSpecTemplate {
  const body = line.text.slice('@fit'.length).trim()
  const comparison = /^(==|>=|<=|>|<)\s*(.+)$/.exec(body)
  if (comparison != null) {
    const right = parseFitExpressionText(comparison[2]!.trim())
    return {
      kind: 'comparison',
      op: comparison[1]! as ComparisonOperator,
      right,
      line: line.line,
    }
  }
  const range = parseFitRangeText(body)
  if (range == null) throw new Error(`Unsupported inline @fit range: ${line.text}`)
  return {
    kind: 'range',
    range,
    line: line.line,
  }
}

function isRangeBoundText(text: string) {
  if (rangeNumberPattern.test(text)) return true
  try {
    parseExpression(text)
    return true
  } catch {
    return false
  }
}

function parseRangeBoundNumber(text: string): number | null {
  if (text === 'Infinity') return Number.POSITIVE_INFINITY
  if (text === '-Infinity') return Number.NEGATIVE_INFINITY
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function parseCheckAtom(line: string, lineNumber?: number): Extract<FitSpec, {kind: 'check-atom'}> | null {
  const parsed = parseFitExpressionText(line)
  const expression = parsed.parsed.expression
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return null
  return {
    kind: 'check-atom',
    name: expression.expression.text,
    args: expression.arguments.map(argument => fitExpressionFromParsedExpression(parsed.parsed, argument)),
    text: line,
    ...(lineNumber == null ? {} : {line: lineNumber}),
  }
}

export function parseExpression(text: string): ts.Expression {
  return parseFitExpression(text).expression
}

export function parseFitExpression(text: string): ParsedFitExpression {
  return cachedParsedFitExpression(normalizeFitText(text))
}

function cachedParsedFitExpression(normalizedText: string): ParsedFitExpression {
  const cached = parsedExpressionCache.get(normalizedText)
  if (cached != null) return cached
  const failure = parsedExpressionFailures.get(normalizedText)
  if (failure != null) throw new Error(failure)
  try {
    const parsed = parseNormalizedFitExpression(normalizedText)
    parsedExpressionCache.set(normalizedText, parsed)
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    parsedExpressionFailures.set(normalizedText, message)
    throw error
  }
}

function parseNormalizedFitExpression(normalizedText: string): ParsedFitExpression {
  const domainPaths = new Map<string, FitDomainPath>()
  const sourceText = normalizedText.replace(domainPathPattern, match => {
    const domainPath = parseDomainPathText(match)
    if (domainPath == null || !domainPath.segments.some(segment => segment.kind === 'item')) return match
    const synthetic = domainPathSyntheticName(match)
    domainPaths.set(synthetic, domainPath)
    return synthetic
  })
  const sourceFile = ts.createSourceFile('fit-spec-expression.ts', `const value = ${sourceText}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const parseDiagnostics = (sourceFile as ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}).parseDiagnostics
  if (parseDiagnostics.length > 0 || sourceFile.statements.length !== 1) throw new Error(`Could not parse @fit expression: ${normalizedText}`)
  const statement = sourceFile.statements[0]
  if (statement == null || !ts.isVariableStatement(statement)) throw new Error(`Could not parse @fit expression: ${normalizedText}`)
  const declaration = statement.declarationList.declarations[0]
  if (declaration == null || declaration.initializer == null) throw new Error(`Could not parse @fit expression: ${normalizedText}`)
  return {expression: declaration.initializer, domainPaths}
}

export function parseDomainPathText(text: string): FitDomainPath | null {
  const match = new RegExp(`^(${identifierPattern})((?:\\.${identifierPattern}|\\[(?:\\]|${indexLabelPattern}\\]))*)$`).exec(text)
  if (match == null) return null
  const root = match[1]!
  const suffix = match[2]!
  const segments: FitDomainPathSegment[] = []
  let index = 0
  while (index < suffix.length) {
    if (suffix.startsWith('[]', index)) {
      segments.push({kind: 'item'})
      index += 2
      continue
    }
    const itemLabel = new RegExp(`^\\[(${indexLabelPattern})\\]`).exec(suffix.slice(index))
    if (itemLabel != null) {
      const parsed = parseIndexLabelText(itemLabel[1]!)
      if (parsed == null) return null
      segments.push({kind: 'item', label: parsed.label, offset: parsed.offset})
      index += itemLabel[0].length
      continue
    }
    if (suffix[index] !== '.') return null
    const next = new RegExp(`^\\.(${identifierPattern})`).exec(suffix.slice(index))
    if (next == null) return null
    segments.push({kind: 'prop', name: next[1]!})
    index += next[0].length
  }
  return {root, segments}
}

export function domainPathSyntheticName(text: string) {
  const parts = text
    .replace(/\[\s*\]/g, '.__item')
    .replace(/\[\s*(\$[A-Za-z_][\w$]*)(?:\s*([+-])\s*(\d+))?\s*\]/g, (_match, label: string, sign: string | undefined, offset: string | undefined) => {
      const suffix = offset == null ? '' : sign === '-' ? `_minus_${offset}` : `_plus_${offset}`
      return `.__item_${label}${suffix}`
    })
    .split('.')
    .filter(part => part.length > 0)
    .map(part => part.replace(/[^\w$]/g, '_'))
  return `__fit_domain_${parts.join('_')}`
}

function domainPathText(domainPath: FitDomainPath) {
  let text = domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') {
      text += `.${segment.name}`
      continue
    }
    if (segment.label == null || segment.offset == null) {
      text += '[]'
      continue
    }
    if (segment.offset === 0) {
      text += `[${segment.label}]`
      continue
    }
    const sign = segment.offset < 0 ? '-' : '+'
    text += `[${segment.label} ${sign} ${Math.abs(segment.offset)}]`
  }
  return publicFitText(text)
}

function escapeRegExp(text: string) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function parseIndexLabelText(text: string): {label: string; offset: number} | null {
  const match = /^(\$[A-Za-z_][\w$]*)(?:\s*([+-])\s*(\d+))?$/.exec(text)
  if (match == null) return null
  const magnitude = match[3] == null ? 0 : Number(match[3])
  if (!Number.isSafeInteger(magnitude)) return null
  return {
    label: match[1]!,
    offset: match[2] === '-' ? -magnitude : magnitude,
  }
}
