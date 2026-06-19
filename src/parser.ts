import * as ts from 'typescript'
import {isFunctionImplementation} from './function-shape.ts'

export type FitDomainPath = {
  root: string
  segments: FitDomainPathSegment[]
}

export type FitDomainPathSegment =
  | {kind: 'prop'; name: string}
  | {kind: 'index'; index: number}
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

export type FitValueSpec = {
  kind: 'type'
  typeText: string
  ranges: Map<string, FitRange>
  typeNode: ts.TypeNode
}

export type FitSpecRole = 'assume' | 'prove'

export type FitTypeCheckOrigin = {
  sourceId: string
  pos: number
}

type FitSpecBase<R extends FitSpecRole, K extends string> = {
  role: R
  kind: K
  text: string
  line?: number
  typeCheckOrigin?: FitTypeCheckOrigin
  typeCheckSourceId?: string
}

export type FitRangeSpec<R extends FitSpecRole = FitSpecRole> = FitSpecBase<R, 'range'> & {
  expression: FitExpression
  range: FitRange
  implicitFinite?: true
  finiteWhenNumeric?: true
}

export type FitComparisonSpec<R extends FitSpecRole = FitSpecRole> = FitSpecBase<R, 'comparison'> & {
  left: FitExpression
  op: ComparisonOperator
  right: FitExpression
}

export type FitExpressionSpec<R extends FitSpecRole = FitSpecRole> = FitSpecBase<R, 'expression'> & {
  expression: FitExpression
}

export type FitValueCheckSpec = FitSpecBase<'prove', 'value'> & {
  expression: FitExpression
  value: FitValueSpec
}

// `pure`: a function-level claim that the function has no observable effect and
// is deterministic. It has no expression — it is checked against the function's
// effect summary, not by evaluating a value — so it skips the TypeScript
// lowering the expression-bearing specs go through.
export type FitPureSpec = FitSpecBase<'prove', 'pure'>

export type FitRangeGivenSpec = FitRangeSpec<'assume'>
export type FitComparisonGivenSpec = FitComparisonSpec<'assume'>
export type FitExpressionGivenSpec = FitExpressionSpec<'assume'>
export type FitRangeCheckSpec = FitRangeSpec<'prove'>
export type FitComparisonCheckSpec = FitComparisonSpec<'prove'>
export type FitExpressionCheckSpec = FitExpressionSpec<'prove'>

export type FitSpec =
  | FitRangeGivenSpec
  | FitComparisonGivenSpec
  | FitExpressionGivenSpec
  | FitRangeCheckSpec
  | FitValueCheckSpec
  | FitComparisonCheckSpec
  | FitExpressionCheckSpec
  | FitPureSpec

export type ComparisonOperator = '==' | '>=' | '<=' | '>' | '<'
export type FitCheckSpec = FitRangeCheckSpec | FitValueCheckSpec | FitComparisonCheckSpec | FitExpressionCheckSpec
export type FitFunctionCheckSpec = FitCheckSpec | FitPureSpec
export type FitLoopSpec = Exclude<FitSpec, FitPureSpec>
export type FitInlineCheckSpec = FitRangeCheckSpec | FitComparisonCheckSpec
export type FitGivenSpec = FitRangeGivenSpec | FitComparisonGivenSpec | FitExpressionGivenSpec

export function fitSpecIsAssumption(spec: FitSpec): spec is FitGivenSpec {
  return spec.role === 'assume'
}

export function fitSpecIsProof(spec: FitSpec): spec is FitFunctionCheckSpec {
  return spec.role === 'prove'
}

export function fitSpecTextForRole(role: FitSpecRole, text: string) {
  return role === 'assume' ? `given ${text}` : text
}

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
  localSpecsByStatement: Map<ts.VariableStatement, FitInlineCheckSpec[]>
  returnSpecsByNode: Map<ts.Node, FitInlineCheckSpec[]>
  objectPropertyTemplatesByNode: Map<ts.PropertyAssignment | ts.ShorthandPropertyAssignment, FitInlineSpecTemplate[]>
  loopSpecsByStatement: Map<ts.ForOfStatement | ts.ForStatement, FitLoopSpec[]>
  // @fit comments in places the checker does not evaluate (e.g. inside a map
  // callback). Reported as unsupported: a written contract is never ignored
  // silently.
  unsupportedPlacements: {line: number; text: string; reason: string}[]
}

type FitExpressionParser = (text: string) => FitExpression

// Identifiers as the language defines them, not ASCII approximations.
const identifierPattern = '[\\p{ID_Start}_$][\\p{ID_Continue}$\\u200C\\u200D]*'
const indexLabelPattern = '\\$[\\p{ID_Start}_][\\p{ID_Continue}$\\u200C\\u200D]*(?:\\s*[+-]\\s*\\d+)?'
const numericPropertyPattern = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const quotedPropertyPattern = `(?:(?:"(?:\\\\.|[^"\\\\])*")|(?:'(?:\\\\.|[^'\\\\])*'))`
const domainPathPattern = new RegExp(
  `${identifierPattern}(?:(?:\\.${identifierPattern})|(?:\\[(?:${indexLabelPattern}|${numericPropertyPattern}|${quotedPropertyPattern})?\\]))+`,
  'gu',
)
export const fitReturnPublicRoot = 'return'
export const fitReturnInternalRoot = '__fit_return'
const publicReturnRootPattern = /(?<![\w$.])return(?![\w$])/g
const internalReturnRootPattern = /(?<![\w$.])__fit_return(?![\w$])/g
const fitValueRangeTypeName = '__FRNumber'
const parsedExpressionCache = new Map<string, ParsedFitExpression>()
const parsedExpressionFailures = new Map<string, string>()

export type FitCommentLine = {
  text: string
  line: number
  pos: number
}

export function normalizeFitText(text: string) {
  if (!text.includes(fitReturnPublicRoot)) return text
  return replaceFitCode(text, publicReturnRootPattern, () => fitReturnInternalRoot)
}

export function publicFitText(text: string) {
  if (!text.includes(fitReturnInternalRoot)) return text
  return replaceFitCode(text, internalReturnRootPattern, () => fitReturnPublicRoot)
}

export function replaceFitCode(text: string, pattern: RegExp, replace: (match: string) => string) {
  const protectedRanges = fitTextProtectedRanges(text)
  return text.replace(pattern, (match: string, ...args: unknown[]) => {
    const offset = args.at(-2)
    if (typeof offset !== 'number') throw new Error('Expected a regex replacement offset')
    if (protectedRanges.some(range => offset >= range.start && offset < range.end)) return match
    return replace(match)
  })
}

export function replaceFitIdentifiers(text: string, replacements: ReadonlyMap<string, string>) {
  if (replacements.size === 0) return text
  const prefix = 'const __fit_value = '
  const fileName = 'fit-identifier-replacement.ts'
  const sourceFile = ts.createSourceFile(fileName, `${prefix}${text}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const options: ts.CompilerOptions = {noLib: true, noResolve: true, target: ts.ScriptTarget.Latest}
  const host = ts.createCompilerHost(options)
  host.getSourceFile = requested => requested === fileName ? sourceFile : undefined
  host.fileExists = requested => requested === fileName
  host.readFile = requested => requested === fileName ? sourceFile.text : undefined
  host.writeFile = () => {}
  const checker = ts.createProgram([fileName], options, host).getTypeChecker()
  const statement = sourceFile.statements[0]
  const declaration = statement != null && ts.isVariableStatement(statement)
    ? statement.declarationList.declarations[0]
    : null
  const initializer = declaration?.initializer
  if (initializer == null) return text

  const edits: {start: number; end: number; text: string}[] = []
  const addEdit = (node: ts.Node, replacement: string) => {
    edits.push({start: node.getStart(sourceFile) - prefix.length, end: node.getEnd() - prefix.length, text: replacement})
  }
  const visit = (node: ts.Node) => {
    if (ts.isTypeNode(node)) return
    if (ts.isShorthandPropertyAssignment(node)) {
      const replacement = replacements.get(node.name.text)
      const valueSymbol = checker.getShorthandAssignmentValueSymbol(node)
      if (replacement != null && valueSymbol == null) addEdit(node.name, `${node.name.text}: ${replacement}`)
      if (node.objectAssignmentInitializer != null) visit(node.objectAssignmentInitializer)
      return
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression)
      visit(node.initializer)
      return
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression)
      return
    }
    if (ts.isIdentifier(node)) {
      const replacement = replacements.get(node.text)
      if (replacement != null && checker.getSymbolAtLocation(node) == null) addEdit(node, replacement)
      return
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const replacement = replacements.get('this')
      if (replacement != null && !thisHasNonArrowFunctionOwner(node)) addEdit(node, replacement)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(initializer)
  let result = text
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.start < 0 || edit.end > text.length) continue
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

function thisHasNonArrowFunctionOwner(node: ts.Node) {
  let current = node.parent
  while (current != null) {
    if (ts.isArrowFunction(current)) {
      current = current.parent
      continue
    }
    if (ts.isFunctionLike(current)) return true
    current = current.parent
  }
  return false
}

function fitTextProtectedRanges(text: string): {start: number; end: number}[] {
  const ranges: {start: number; end: number}[] = []
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text)
  while (true) {
    const kind = scanner.scan()
    if (kind === ts.SyntaxKind.EndOfFileToken) break
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      ranges.push({start: scanner.getTokenPos(), end: scanner.getTextPos()})
    }
  }

  const prefix = 'const __fit_value = '
  const sourceFile = ts.createSourceFile('fit-protected-ranges.ts', `${prefix}${text}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const protectNode = (node: ts.Node) => {
    ranges.push({start: node.getStart(sourceFile) - prefix.length, end: node.getEnd() - prefix.length})
  }
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      protectNode(node)
    }
    if (ts.isTemplateExpression(node)) {
      protectNode(node.head)
      for (const span of node.templateSpans) protectNode(span.literal)
    }
    if (
      ts.isPropertyAssignment(node)
      && !ts.isComputedPropertyName(node.name)
      && sourceFile.text.slice(node.name.end, node.end).includes(':')
    ) protectNode(node.name)
    if (ts.isReturnStatement(node) && returnKeywordIsStatementStart(sourceFile, node.getStart(sourceFile))) {
      const start = node.getStart(sourceFile) - prefix.length
      ranges.push({start, end: start + 'return'.length})
    }
    if (ts.isBindingElement(node) && node.propertyName != null && !ts.isComputedPropertyName(node.propertyName)) {
      protectNode(node.propertyName)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return ranges.filter(range => range.end > 0 && range.start < text.length)
}

function returnKeywordIsStatementStart(sourceFile: ts.SourceFile, start: number) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, sourceFile.text)
  let previous = ts.SyntaxKind.Unknown
  while (true) {
    const kind = scanner.scan()
    if (kind === ts.SyntaxKind.EndOfFileToken || scanner.getTokenPos() >= start) break
    previous = kind
  }
  return previous === ts.SyntaxKind.OpenBraceToken
    || previous === ts.SyntaxKind.SemicolonToken
    || previous === ts.SyntaxKind.CloseParenToken
    || previous === ts.SyntaxKind.ElseKeyword
    || previous === ts.SyntaxKind.ColonToken
    || previous === ts.SyntaxKind.DoKeyword
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

export function fitExpressionScopeSourceId(expression: FitExpressionLike) {
  return typeof expression === 'string' ? undefined : expression.scopeSourceId
}

export function fitExpressionDomainPath(expression: FitExpressionLike): FitDomainPath | null {
  const parsed = fitExpressionParsed(expression)
  return fitDomainPathFromExpression(parsed.expression, parsed.domainPaths)
}

export function fitDomainPathFromExpression(expression: ts.Expression, domainPaths: ReadonlyMap<string, FitDomainPath>): FitDomainPath | null {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) current = current.expression

  if (ts.isIdentifier(current)) return domainPaths.get(current.text) ?? {root: current.text, segments: []}
  if (current.kind === ts.SyntaxKind.ThisKeyword) return {root: 'this', segments: []}
  if (ts.isPropertyAccessExpression(current)) {
    const parent = fitDomainPathFromExpression(current.expression, domainPaths)
    return parent == null ? null : {...parent, segments: [...parent.segments, {kind: 'prop', name: current.name.text}]}
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression != null) {
    const parent = fitDomainPathFromExpression(current.expression, domainPaths)
    if (parent == null) return null
    const argument = current.argumentExpression
    if (ts.isStringLiteralLike(argument)) {
      return {...parent, segments: [...parent.segments, domainSegmentForPropertyName(argument.text)]}
    }
    if (ts.isNumericLiteral(argument)) {
      return appendNumericDomainPathSegment(parent, Number(argument.text))
    }
    if (
      ts.isPrefixUnaryExpression(argument)
      && argument.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(argument.operand)
    ) {
      return appendNumericDomainPathSegment(parent, -Number(argument.operand.text))
    }
  }
  return null
}

function appendNumericDomainPathSegment(parent: FitDomainPath, value: number): FitDomainPath | null {
  if (!Number.isFinite(value)) return null
  const segment: FitDomainPathSegment = Number.isSafeInteger(value) && value >= 0
    ? {kind: 'index', index: value}
    : {kind: 'prop', name: String(value)}
  return {...parent, segments: [...parent.segments, segment]}
}

function domainSegmentForPropertyName(name: string): FitDomainPathSegment {
  if (/^(?:0|[1-9]\d*)$/.test(name)) {
    const index = Number(name)
    if (Number.isSafeInteger(index) && index < 0xffff_ffff) return {kind: 'index', index}
  }
  return {kind: 'prop', name}
}

export function fitDomainPathKey(path: FitDomainPath) {
  const segments = path.segments.map(segment => {
    switch (segment.kind) {
      case 'prop': return `p${segment.name.length}:${segment.name}`
      case 'index': return `n${segment.index}`
      case 'item': return `i${segment.label ?? ''}:${segment.offset ?? ''}`
    }
  })
  return `${path.root.length}:${path.root}/${segments.join('/')}`
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

export function fitValueSpecExpressions(spec: FitValueSpec): FitExpressionLike[] {
  return fitValueTypeExpressions(spec.typeNode, spec.ranges)
}

export function fitSpecMentionsRoot(spec: FitSpec, root: string) {
  return fitSpecExpressions(spec).some(expression => fitExpressionMentionsRoot(expression, root))
}

function fitSpecExpressions(spec: FitSpec): FitExpressionLike[] {
  switch (spec.kind) {
    case 'range':
      return [spec.expression]
    case 'value':
      return [spec.expression, ...fitValueSpecExpressions(spec.value)]
    case 'comparison':
      return [spec.left, spec.right]
    case 'expression':
      return [spec.expression]
    case 'pure':
      return []
  }
}

function fitExpressionMentionsRoot(expression: FitExpressionLike, root: string) {
  const parsed = fitExpressionParsed(expression)
  if ([...parsed.domainPaths.values()].some(domainPath => domainPath.root === root)) return true
  return nodeMentionsIdentifier(parsed.expression, root)
}

function nodeMentionsIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeMentionsIdentifier(child, name)) found = true
  })
  return found
}

function fitValueTypeExpressions(node: ts.TypeNode, ranges: Map<string, FitRange>): FitExpressionLike[] {
  if (ts.isParenthesizedTypeNode(node)) return fitValueTypeExpressions(node.type, ranges)
  if (ts.isTypeOperatorNode(node)) return fitValueTypeExpressions(node.type, ranges)
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(type => fitValueTypeExpressions(type, ranges))
  if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(type => fitValueTypeExpressions(type, ranges))
  const range = fitValueSpecRangeForTypeNode(node, ranges)
  if (range != null) return fitRangeCases(range).flatMap(rangeCase => [rangeCase.lower, rangeCase.upper])
  if (ts.isTypeLiteralNode(node)) {
    return node.members.flatMap(member => ts.isPropertySignature(member) && member.type != null ? fitValueTypeExpressions(member.type, ranges) : [])
  }
  if (ts.isArrayTypeNode(node)) return fitValueTypeExpressions(node.elementType, ranges)
  if (ts.isTupleTypeNode(node)) return node.elements.flatMap(element => fitTupleElementExpressions(element, ranges))
  if (ts.isTypeReferenceNode(node)) return node.typeArguments?.flatMap(type => fitValueTypeExpressions(type, ranges)) ?? []
  return []
}

function fitTupleElementExpressions(node: ts.TypeNode | ts.NamedTupleMember, ranges: Map<string, FitRange>): FitExpressionLike[] {
  if (ts.isNamedTupleMember(node)) return []
  if (ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node)) return fitValueTypeExpressions(node.type, ranges)
  return fitValueTypeExpressions(node, ranges)
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
  return instantiateInlineFitTemplates(lines.map(parseInlineFitTemplate), paramName, 'assume')
}

export function parseLocalFitSpecs(sourceText: string, statement: ts.VariableStatement): FitInlineCheckSpec[] {
  rejectInlineBlockFitComments(sourceText, statement)
  const lines = inlineFitCommentLines(sourceText, statement)
  if (lines.length === 0) return []
  const declarations = statement.declarationList.declarations
  if (declarations.length !== 1 || !ts.isIdentifier(declarations[0]!.name)) {
    throw new Error('Inline @fit comments support one simple variable declaration')
  }
  const expression = declarations[0]!.name.text
  return instantiateInlineFitTemplates(lines.map(parseInlineFitTemplate), expression, 'prove')
}

export function parseInlineFitSpecsForExpression(sourceText: string, node: ts.Node, expression: string): FitInlineCheckSpec[] {
  rejectInlineBlockFitComments(sourceText, node)
  return instantiateInlineFitTemplates(parseInlineFitTemplatesForNode(sourceText, node), expression, 'prove')
}

export function inlineFitCommentLinesForNode(sourceText: string, node: ts.Node): FitCommentLine[] {
  return inlineFitCommentLines(sourceText, node)
}

export function parseInlineFitTemplatesForNode(sourceText: string, node: ts.Node): FitInlineSpecTemplate[] {
  rejectInlineBlockFitComments(sourceText, node)
  return inlineFitCommentLines(sourceText, node).map(parseInlineFitTemplate)
}

export function instantiateInlineFitTemplates(templates: FitInlineSpecTemplate[], expression: string, role: 'prove'): FitInlineCheckSpec[]
export function instantiateInlineFitTemplates(templates: FitInlineSpecTemplate[], expression: string, role: 'assume'): FitGivenSpec[]
export function instantiateInlineFitTemplates(
  templates: FitInlineSpecTemplate[],
  expression: string,
  role: 'prove' | 'assume',
): FitInlineCheckSpec[] | FitGivenSpec[] {
  const parsedExpression = parseFitExpressionText(expression)
  const publicExpression = publicFitText(expression)
  const specs: FitSpec[] = []
  for (const template of templates) {
    switch (template.kind) {
      case 'comparison': {
        const text = fitSpecTextForRole(role, `${publicExpression} ${template.op} ${publicFitText(template.right.text)}`)
        specs.push({
          role,
          kind: 'comparison',
          left: parsedExpression,
          op: template.op,
          right: template.right,
          text,
          ...(template.line == null ? {} : {line: template.line}),
        })
        break
      }
      case 'range': {
        const text = fitSpecTextForRole(role, `${publicExpression}: ${publicFitText(template.range.text)}`)
        specs.push({
          role,
          kind: 'range',
          expression: parsedExpression,
          range: template.range,
          text,
          ...(template.line == null ? {} : {line: template.line}),
        })
        break
      }
    }
  }
  return role === 'assume' ? specs as FitGivenSpec[] : specs as FitInlineCheckSpec[]
}

export function emptyFitBodySpecIndex(): FitBodySpecIndex {
  return {
    localSpecsByStatement: new Map(),
    returnSpecsByNode: new Map(),
    objectPropertyTemplatesByNode: new Map(),
    loopSpecsByStatement: new Map(),
    unsupportedPlacements: [],
  }
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

export function parseTopLevelFitSpecIndex(
  sourceText: string,
  sourceFile: ts.SourceFile,
  functionNodes: Set<ts.Node> = new Set(),
): FitBodySpecIndex {
  const index = emptyFitBodySpecIndex()
  for (const statement of sourceFile.statements) {
    if (topLevelDeclarationOnly(statement)) continue
    collectBodyFitSpecIndex(sourceText, statement, index, functionNodes)
  }
  return index
}

function collectBodyFitSpecIndex(
  sourceText: string,
  root: ts.Node,
  index: FitBodySpecIndex,
  ignoredFunctions: Set<ts.Node> = new Set(),
) {
  const visit = (node: ts.Node) => {
    if (node !== root && isFunctionImplementation(node)) {
      if (ignoredFunctions.has(node)) return
      collectUnsupportedNestedFitComments(sourceText, node, index)
      return
    }
    collectBodyFitSpecIndexForNode(sourceText, node, index)
    ts.forEachChild(node, visit)
  }
  visit(root)
}

// The checker does not evaluate nested function bodies statement by statement,
// so @fit comments inside them are not provable where they are written. Record
// them so the report can say so instead of staying silent.
function collectUnsupportedNestedFitComments(sourceText: string, nested: ts.Node, index: FitBodySpecIndex) {
  const seen = new Set<number>()
  const reason = 'Unsupported @fit placement: contracts inside a nested function are not checked; move the contract onto the enclosing statement or a named function'
  const record = (lines: FitCommentLine[]) => {
    for (const line of lines) {
      if (seen.has(line.pos) || index.unsupportedPlacements.some(existing => existing.line === line.line && existing.text === line.text)) continue
      seen.add(line.pos)
      index.unsupportedPlacements.push({line: line.line, text: line.text, reason})
    }
  }
  const visit = (node: ts.Node) => {
    record(fitCommentLines(sourceText, node).flat().filter(line => line.text.startsWith('@fit')))
    record(inlineFitCommentLines(sourceText, node))
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(nested, visit)
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
    const loopSpecs: FitLoopSpec[] = []
    for (const spec of specs) {
      if (spec.kind === 'pure') {
        index.unsupportedPlacements.push({
          line: spec.line ?? lineNumberAtPosition(sourceText, node.getStart()),
          text: spec.text,
          reason: 'Unsupported @fit placement: `pure` can only appear in a function-level @fit block',
        })
      } else {
        loopSpecs.push(spec)
      }
    }
    if (loopSpecs.length > 0) index.loopSpecsByStatement.set(node, loopSpecs)
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

// A line comment trails a node only when nothing but whitespace and the
// closing , or ; sits between them. With two declarations on one line, the
// comment belongs to the one it follows, not to every node ending on the line.
const trailingGapPattern = /^[\s,;]*$/

function trailingLineFitCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  const lineEnd = sourceText.indexOf('\n', node.end)
  const restOfLine = sourceText.slice(node.end, lineEnd < 0 ? sourceText.length : lineEnd)
  const commentStart = restOfLine.indexOf('//')
  if (commentStart < 0) return []
  if (!trailingGapPattern.test(restOfLine.slice(0, commentStart))) return []
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
  let gapStart = 0
  for (;;) {
    const match = commentPattern.exec(restOfLine)
    if (match == null) break
    if (!trailingGapPattern.test(restOfLine.slice(gapStart, match.index))) break
    gapStart = match.index + match[0].length
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
  const givenMatch = /^given\s+([\s\S]+)$/.exec(line)
  const body = givenMatch?.[1] ?? line
  const role: FitSpecRole = givenMatch == null ? 'prove' : 'assume'
  const lineFields = lineNumber == null ? {} : {line: lineNumber}

  if (role === 'prove' && body.trim() === 'pure') return {role, kind: 'pure', text: line, ...lineFields}

  const colonSplit = findTopLevelColon(body)
  if (colonSplit != null) {
    const expression = parseFitExpressionText(colonSplit.left)
    const rangeBody = colonSplit.right
    if (role === 'prove' && shouldParseFitValueSpec(rangeBody)) {
      const value = parseFitValueSpecText(rangeBody)
      if (value == null) throw new Error(`Unsupported @fit value spec: ${line}`)
      return {role, kind: 'value', expression, value, text: line, ...lineFields}
    }
    const range = parseFitRangeText(rangeBody)
    if (range == null) throw new Error(`Unsupported @fit range: ${line}`)
    return {role, kind: 'range', expression, range, text: line, ...lineFields}
  }

  const comparison = findTopLevelComparison(body)
  if (comparison != null) {
    const left = parseFitExpressionText(comparison.left)
    const right = parseFitExpressionText(comparison.right)
    return {role, kind: 'comparison', left, op: comparison.op, right, text: line, ...lineFields}
  }

  return {role, kind: 'expression', expression: parseFitExpressionText(body), text: line, ...lineFields}
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
    rejectNaNRangeCases(rangeCases)
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
  rejectNaNRangeCases([single])
  return {
    valueKind,
    ...single,
    text,
  }
}

function rejectNaNRangeCases(cases: FitRangeCase[]) {
  if (cases.some(rangeCase => fitExpressionUsesNaN(rangeCase.lower) || fitExpressionUsesNaN(rangeCase.upper))) {
    throw new Error('NaN is outside the checked numerical domain')
  }
}

function fitExpressionUsesNaN(expression: FitExpression) {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === 'NaN') {
      const parent = node.parent
      if (!ts.isPropertyAccessExpression(parent) || parent.name !== node
        || (ts.isIdentifier(parent.expression) && parent.expression.text === 'Number')) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(expression.parsed.expression)
  return found
}

function shouldParseFitValueSpec(text: string): boolean {
  const body = text.trim()
  if (body.length === 0) return false
  if (body.startsWith('{') || body.startsWith('[') || quotedStringText(body) != null || body === 'true' || body === 'false' || body === 'number' || body === 'boolean') return true
  const alternatives = splitTopLevelAlternatives(body)
  if (alternatives != null && alternatives.some(shouldParseFitValueSpec)) return true
  return parseFitRangeText(body) == null && parseFitValueSpecText(body) != null
}

export function parseFitValueSpecText(text: string, parseExpression: FitExpressionParser = parseFitExpressionText): FitValueSpec | null {
  const lowered = lowerFitValueSpecTextForTypeScript(text, parseExpression)
  if (lowered == null) return null
  const typeNode = parseFitValueSpecTypeNode(lowered.typeText)
  return typeNode == null ? null : {...lowered, kind: 'type', typeNode}
}

export function lowerFitValueSpecTextForTypeScript(text: string, parseExpression: FitExpressionParser = parseFitExpressionText): Omit<FitValueSpec, 'kind' | 'typeNode'> | null {
  const ranges = new Map<string, FitRange>()
  const typeText = lowerFitValueRangeLeaves(text.trim(), ranges, parseExpression)
  return typeText == null ? null : {typeText, ranges}
}

function lowerFitValueRangeLeaves(text: string, ranges: Map<string, FitRange>, parseExpression: FitExpressionParser): string | null {
  if (text.length === 0) return null
  let result = text
  let searchStart = 0
  for (;;) {
    const operator = findFitRangeOperator(result, searchStart)
    if (operator == null) break
    const bounds = rangeLeafBounds(result, operator)
    if (bounds == null) return null
    const rangeText = result.slice(bounds.start, bounds.end).trim()
    const range = parseFitRangeText(rangeText, parseExpression)
    if (range == null) return null
    const id = `r${ranges.size}`
    ranges.set(id, range)
    const replacement = `${fitValueRangeTypeName}<"${id}">`
    result = `${result.slice(0, bounds.start)}${replacement}${result.slice(bounds.end)}`
    searchStart = bounds.start + replacement.length
  }
  return result
}

type FitRangeOperator = {
  position: number
  length: 2 | 3 | 4
}

function findFitRangeOperator(text: string, start: number): FitRangeOperator | null {
  let quote: '"' | "'" | '`' | null = null
  for (let index = start; index < text.length - 1; index++) {
    const char = text[index]
    if (quote != null) {
      if (char === '\\') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (!text.startsWith('..', index) || text[index - 1] === '.' || text.startsWith('...', index)) continue
    // Cover the whole token including exclusion markers, so the leaf scans
    // around it never mistake a marker `<` for a generic-argument delimiter.
    const lowerMark = text[index - 1] === '<' ? 1 : 0
    const upperMark = text.startsWith('..<', index) ? 1 : 0
    return {position: index - lowerMark, length: (2 + lowerMark + upperMark) as 2 | 3 | 4}
  }
  return null
}

function rangeLeafBounds(text: string, operator: FitRangeOperator): {start: number; end: number} | null {
  const start = rangeLeafStart(text, operator.position)
  const end = rangeLeafEnd(text, operator.position + operator.length)
  return start == null || end == null || start >= operator.position || end <= operator.position + operator.length
    ? null
    : {start, end}
}

function rangeLeafStart(text: string, position: number): number | null {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = position - 1; index >= 0; index--) {
    const char = text[index]
    if (char == null) continue
    if (char === '"' || char === "'" || char === '`') {
      index = stringStartBefore(text, index, char)
      continue
    }
    if (char === ')') parenDepth++
    else if (char === ']') bracketDepth++
    else if (char === '}') braceDepth++
    else if (char === '(') {
      if (parenDepth === 0) return trimmedStart(text, index + 1, position)
      parenDepth--
    } else if (char === '[') {
      if (bracketDepth === 0) return trimmedStart(text, index + 1, position)
      bracketDepth--
    } else if (char === '{') {
      if (braceDepth === 0) return trimmedStart(text, index + 1, position)
      braceDepth--
    } else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && isRangeLeafStartDelimiter(char)) {
      return trimmedStart(text, index + 1, position)
    }
  }
  return trimmedStart(text, 0, position)
}

function rangeLeafEnd(text: string, position: number): number | null {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let quote: '"' | "'" | '`' | null = null
  for (let index = position; index < text.length; index++) {
    const char = text[index]
    if (char == null) continue
    if (quote != null) {
      if (char === '\\') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') parenDepth++
    else if (char === '[') bracketDepth++
    else if (char === '{') braceDepth++
    else if (char === ')') {
      if (parenDepth === 0) return trimmedEnd(text, position, index)
      parenDepth--
    } else if (char === ']') {
      if (bracketDepth === 0) return trimmedEnd(text, position, index)
      bracketDepth--
    } else if (char === '}') {
      if (braceDepth === 0) return trimmedEnd(text, position, index)
      braceDepth--
    } else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && isRangeLeafEndDelimiter(char)) {
      return trimmedEnd(text, position, index)
    }
  }
  return trimmedEnd(text, position, text.length)
}

function isRangeLeafStartDelimiter(char: string) {
  return char === ':' || char === ',' || char === ';' || char === '|' || char === '&' || char === '<'
}

function isRangeLeafEndDelimiter(char: string) {
  return char === ',' || char === ';' || char === '|' || char === '&' || char === '>'
}

function stringStartBefore(text: string, quoteEnd: number, quote: string) {
  for (let index = quoteEnd - 1; index >= 0; index--) {
    if (text[index] !== quote) continue
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) backslashes++
    if (backslashes % 2 === 0) return index
  }
  return -1
}

function trimmedStart(text: string, start: number, end: number) {
  while (start < end && /\s/.test(text[start]!)) start++
  return start
}

function trimmedEnd(text: string, start: number, end: number) {
  while (end > start && /\s/.test(text[end - 1]!)) end--
  return end
}

function parseFitValueSpecTypeNode(typeText: string): ts.TypeNode | null {
  const sourceFile = ts.createSourceFile('fit-value-spec.ts', `type __FRValueSpec = ${typeText}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const parseDiagnostics = (sourceFile as ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}).parseDiagnostics
  if (parseDiagnostics.length > 0 || sourceFile.statements.length !== 1) return null
  const statement = sourceFile.statements[0]
  return statement != null && ts.isTypeAliasDeclaration(statement) ? statement.type : null
}

export function fitValueSpecRangeForTypeNode(node: ts.TypeNode, ranges: Map<string, FitRange>): FitRange | null {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) || node.typeName.text !== fitValueRangeTypeName) return null
  const argument = node.typeArguments?.[0]
  if (argument == null || !ts.isLiteralTypeNode(argument) || !ts.isStringLiteralLike(argument.literal)) return null
  return ranges.get(argument.literal.text) ?? null
}

export function fitValueSpecLiteralValues(node: ts.LiteralTypeNode): (string | boolean)[] | null {
  if (ts.isStringLiteralLike(node.literal)) return [node.literal.text]
  if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return [true]
  if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return [false]
  return null
}

export function fitValueSpecNumberLiteralValue(node: ts.LiteralTypeNode): number | null {
  if (ts.isNumericLiteral(node.literal)) return Number(node.literal.text)
  if (ts.isPrefixUnaryExpression(node.literal) && ts.isNumericLiteral(node.literal.operand)) {
    const value = Number(node.literal.operand.text)
    return node.literal.operator === ts.SyntaxKind.MinusToken ? -value : value
  }
  return null
}

export function fitValueSpecPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function quotedStringText(text: string): string | null {
  if (text.length < 2) return null
  const quote = text[0]
  if ((quote !== '"' && quote !== "'") || text.at(-1) !== quote) return null
  const sourceFile = ts.createSourceFile('fit-spec-literal.ts', `const value = ${text}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = sourceFile.statements[0]
  if (statement == null || !ts.isVariableStatement(statement)) return null
  const initializer = statement.declarationList.declarations[0]?.initializer
  return initializer != null && ts.isStringLiteralLike(initializer) ? initializer.text : null
}

export function findTopLevelColon(text: string): {left: string; right: string} | null {
  const result = scanTopLevel(text, kind => kind === ts.SyntaxKind.ColonToken ? ':' : null)
  if (result == null) return null
  const left = text.slice(0, result.position).trim()
  const right = text.slice(result.position + 1).trim()
  return left.length === 0 || right.length === 0 ? null : {left, right}
}

export function findTopLevelComparison(text: string): {left: string; op: ComparisonOperator; right: string} | null {
  const result = scanTopLevel<ComparisonOperator>(text, (kind, position) => {
    switch (kind) {
      case ts.SyntaxKind.EqualsEqualsToken: return '=='
      case ts.SyntaxKind.LessThanEqualsToken: return '<='
      case ts.SyntaxKind.GreaterThanToken:
        // The scanner refuses to combine `>` with the next char (generic-close ambiguity), so check
        // the source for a trailing `=` ourselves to recover `>=`.
        return text[position + 1] === '=' ? '>=' : '>'
      case ts.SyntaxKind.LessThanToken:
        // Skip the `<` of a `..<` upper bound or a `<..` lower bound. Range
        // syntax isn't valid TypeScript, so the scanner has no notion of the
        // range tokens — peek the source instead.
        return text[position - 1] === '.' || text.startsWith('..', position + 1) ? null : '<'
      default: return null
    }
  })
  if (result == null) return null
  const left = text.slice(0, result.position).trim()
  const right = text.slice(result.position + result.token.length).trim()
  return left.length === 0 || right.length === 0 ? null : {left, op: result.token, right}
}

// Yields tokens at brace/bracket/paren depth zero (TypeScript's scanner handles strings, templates,
// and regex for us — none of those interiors yield tokens here).
function* topLevelTokens(text: string): Generator<{kind: ts.SyntaxKind; position: number}> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true)
  scanner.setText(text)
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  while (true) {
    const kind = scanner.scan()
    if (kind === ts.SyntaxKind.EndOfFileToken) return
    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) yield {kind, position: scanner.getTokenStart()}
    if (kind === ts.SyntaxKind.OpenParenToken) parenDepth++
    else if (kind === ts.SyntaxKind.CloseParenToken) parenDepth--
    else if (kind === ts.SyntaxKind.OpenBracketToken) bracketDepth++
    else if (kind === ts.SyntaxKind.CloseBracketToken) bracketDepth--
    else if (kind === ts.SyntaxKind.OpenBraceToken) braceDepth++
    else if (kind === ts.SyntaxKind.CloseBraceToken) braceDepth--
  }
}

export function scanTopLevel<T extends string>(
  text: string,
  visit: (kind: ts.SyntaxKind, position: number) => T | null,
): {position: number; token: T} | null {
  for (const {kind, position} of topLevelTokens(text)) {
    const token = visit(kind, position)
    if (token != null) return {position, token}
  }
  return null
}

function parseFitRangeCaseText(text: string, parseExpression: FitExpressionParser): FitRangeCase | null {
  const bounds = splitRangeBounds(text)
  if (bounds != null) {
    const {lowerInclusive, upperInclusive} = bounds
    const lower = normalizeFitText(bounds.lower)
    const upper = normalizeFitText(bounds.upper)
    if (!isRangeBoundText(lower) || !isRangeBoundText(upper)) return null
    return {
      lower: parseExpression(lower),
      upper: parseExpression(upper),
      lowerValue: parseRangeBoundNumber(lower),
      upperValue: parseRangeBoundNumber(upper),
      lowerInclusive,
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
  // On equal extremal bounds, the inclusive case decides: an endpoint
  // admitted by any one case is admitted by the union (0<..5 | 0..3 has an
  // inclusive lower 0), so a strict envelope there would exclude real values.
  const lowerCase = cases.reduce((best, current) => {
    const currentValue = rangeCaseLowerSortValue(current)
    const bestValue = rangeCaseLowerSortValue(best)
    return currentValue < bestValue || (currentValue === bestValue && current.lowerInclusive && !best.lowerInclusive) ? current : best
  })
  const upperCase = cases.reduce((best, current) => {
    const currentValue = rangeCaseUpperSortValue(current)
    const bestValue = rangeCaseUpperSortValue(best)
    return currentValue > bestValue || (currentValue === bestValue && current.upperInclusive && !best.upperInclusive) ? current : best
  })
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
  for (const {kind, position} of topLevelTokens(text)) {
    if (kind === ts.SyntaxKind.BarBarToken) return null
    if (kind !== ts.SyntaxKind.BarToken) continue
    const part = text.slice(start, position).trim()
    if (part.length === 0) return null
    parts.push(part)
    start = position + 1
  }
  if (parts.length === 0) return null
  const last = text.slice(start).trim()
  if (last.length === 0) return null
  parts.push(last)
  return parts
}

function splitRangeBounds(text: string): {lower: string; upper: string; lowerInclusive: boolean; upperInclusive: boolean} | null {
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
    else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && text.startsWith('..', i)) {
      // The delimiter is exactly two dots: a longer dot run (`0...10`) is no
      // range — without this both-sides check it would silently split as
      // `0.` + `10`. A `<` glued to either side excludes that endpoint, so
      // the family reads as the comparison chain it means: a..b, a..<b,
      // a<..b, a<..<b. A `<` can end no TS expression, so it is always ours.
      if (text[i - 1] === '.' || text.startsWith('...', i)) continue
      const lowerInclusive = text[i - 1] !== '<'
      const upperInclusive = !text.startsWith('..<', i)
      const lower = text.slice(0, lowerInclusive ? i : i - 1).trim()
      const upper = text.slice(i + (upperInclusive ? 2 : 3)).trim()
      return lower.length === 0 || upper.length === 0 ? null : {lower, upper, lowerInclusive, upperInclusive}
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
  const domainNames = new Map<string, string>()
  const sourceText = replaceFitCode(normalizedText, domainPathPattern, match => {
    const domainPath = parseDomainPathText(match)
    if (domainPath == null || !domainPath.segments.some(segment => segment.kind === 'item')) return match
    const key = fitDomainPathKey(domainPath)
    const existing = domainNames.get(key)
    if (existing != null) return existing
    const synthetic = unusedDomainPathSyntheticName(match, normalizedText, domainPaths)
    domainPaths.set(synthetic, domainPath)
    domainNames.set(key, synthetic)
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
  const match = new RegExp(`^(${identifierPattern})`, 'u').exec(text)
  if (match == null) return null
  const root = match[1]!
  const suffix = text.slice(match[0].length)
  const segments: FitDomainPathSegment[] = []
  let index = 0
  while (index < suffix.length) {
    if (suffix.startsWith('[]', index)) {
      segments.push({kind: 'item'})
      index += 2
      continue
    }
    const itemLabel = new RegExp(`^\\[(${indexLabelPattern})\\]`, 'u').exec(suffix.slice(index))
    if (itemLabel != null) {
      const parsed = parseIndexLabelText(itemLabel[1]!)
      if (parsed == null) return null
      segments.push({kind: 'item', label: parsed.label, offset: parsed.offset})
      index += itemLabel[0].length
      continue
    }
    const numericProperty = new RegExp(`^\\[(${numericPropertyPattern})\\]`).exec(suffix.slice(index))
    if (numericProperty != null) {
      const value = Number(numericProperty[1])
      const withSegment = appendNumericDomainPathSegment({root, segments}, value)
      if (withSegment == null) return null
      segments.push(withSegment.segments.at(-1)!)
      index += numericProperty[0].length
      continue
    }
    const quotedProperty = /^\[((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\]/.exec(suffix.slice(index))
    if (quotedProperty != null) {
      const sourceFile = ts.createSourceFile('fit-property-name.ts', `const value = ${quotedProperty[1]!}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const statement = sourceFile.statements[0]
      const declaration = statement != null && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0] : null
      if (declaration?.initializer == null || !ts.isStringLiteralLike(declaration.initializer)) return null
      segments.push(domainSegmentForPropertyName(declaration.initializer.text))
      index += quotedProperty[0].length
      continue
    }
    if (suffix[index] !== '.') return null
    const next = new RegExp(`^\\.(${identifierPattern})`, 'u').exec(suffix.slice(index))
    if (next == null) return null
    segments.push({kind: 'prop', name: next[1]!})
    index += next[0].length
  }
  return {root, segments}
}

export function domainPathSyntheticName(text: string) {
  const path = parseDomainPathText(text)
  if (path != null && domainPathCanUseReadableSyntheticName(path)) {
    const parts = [path.root]
    for (const segment of path.segments) {
      if (segment.kind === 'prop') parts.push(segment.name)
      else if (segment.kind === 'index') parts.push(`__index_${segment.index}`)
      else if (segment.label == null || segment.offset == null) parts.push('__item')
      else parts.push(`__item_${segment.label}${segment.offset === 0 ? '' : segment.offset < 0 ? `_minus_${-segment.offset}` : `_plus_${segment.offset}`}`)
    }
    return `__fit_domain_${parts.join('_')}`
  }
  return `__fit_domain_${Array.from(text, char => char.codePointAt(0)!.toString(16)).join('_')}`
}

const domainPathLinearNameMarker = '#fit-domain:'

export function domainPathLinearName(text: string) {
  return `${domainPathSyntheticName(text)}${domainPathLinearNameMarker}${encodeURIComponent(text)}`
}

export function publicLinearName(name: string) {
  const marker = name.indexOf(domainPathLinearNameMarker)
  if (marker < 0) return name
  const encodedStart = marker + domainPathLinearNameMarker.length
  const suffixStart = name.indexOf('@', encodedStart)
  const encodedEnd = suffixStart < 0 ? name.length : suffixStart
  try {
    return decodeURIComponent(name.slice(encodedStart, encodedEnd)) + name.slice(encodedEnd)
  } catch {
    return name
  }
}

function domainPathCanUseReadableSyntheticName(path: FitDomainPath) {
  const safe = (name: string) => /^[A-Za-z$][A-Za-z0-9$]*$/.test(name)
  return safe(path.root) && path.segments.every(segment => {
    if (segment.kind === 'prop') return safe(segment.name)
    if (segment.kind === 'index') return true
    return segment.label == null || safe(segment.label.slice(1))
  })
}

export function unusedDomainPathSyntheticName(text: string, sourceText: string, domainPaths: ReadonlyMap<string, FitDomainPath>) {
  let synthetic = domainPathSyntheticName(text)
  while (sourceText.includes(synthetic) || domainPaths.has(synthetic)) synthetic += '_'
  return synthetic
}

export function formatFitDomainPath(domainPath: FitDomainPath) {
  let text = domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') {
      text += new RegExp(`^${identifierPattern}$`, 'u').test(segment.name)
        ? `.${segment.name}`
        : `[${JSON.stringify(segment.name)}]`
      continue
    }
    if (segment.kind === 'index') {
      text += `[${segment.index}]`
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

const domainPathText = formatFitDomainPath

function escapeRegExp(text: string) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function parseIndexLabelText(text: string): {label: string; offset: number} | null {
  const match = new RegExp(`^(\\$[\\p{ID_Start}_][\\p{ID_Continue}$\\u200C\\u200D]*)(?:\\s*([+-])\\s*(\\d+))?$`, 'u').exec(text)
  if (match == null) return null
  const magnitude = match[3] == null ? 0 : Number(match[3])
  if (!Number.isSafeInteger(magnitude)) return null
  return {
    label: match[1]!,
    offset: match[2] === '-' ? -magnitude : magnitude,
  }
}
