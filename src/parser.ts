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

export type FitRange = {
  valueKind: 'int' | 'number'
  lower: string
  upper: string
  lowerValue: number | null
  upperValue: number | null
  lowerInclusive: boolean
  upperInclusive: boolean
  text: string
}

export type FitSpec =
  | {
      kind: 'given-range'
      expression: string
      range: FitRange
      text: string
    }
  | {
      kind: 'given-comparison'
      left: string
      op: ComparisonOperator
      right: string
      text: string
    }
  | {
      kind: 'check-range'
      expression: string
      range: FitRange
      text: string
    }
  | {
      kind: 'check-comparison'
      left: string
      op: ComparisonOperator
      right: string
      text: string
    }
  | {
      kind: 'check-atom'
      name: string
      args: string[]
      text: string
    }

export type ComparisonOperator = '==' | '>=' | '<=' | '>' | '<'

const identifierPattern = '[A-Za-z_$][\\w$]*'
const indexLabelPattern = '\\$[A-Za-z_][\\w$]*(?:\\s*[+-]\\s*\\d+)?'
const domainPathPattern = new RegExp(`${identifierPattern}(?:(?:\\.${identifierPattern})|(?:\\[(?:\\]|${indexLabelPattern}\\])))+`, 'g')

export function parseFitSpecs(sourceText: string, node: ts.Node): FitSpec[] {
  const comments = fitCommentLines(sourceText, node)
  const specs: FitSpec[] = []

  for (const lines of comments) {
    if (lines.some(line => line === '@fit-loop')) throw new Error('Use @fit for loop specs; @fit-loop is not supported')
    if (!lines.some(line => line === '@fit')) continue
    for (const line of lines) {
      if (line.length === 0 || line === '@fit') continue
      if (line.startsWith('@fit')) throw new Error(`Unsupported @fit marker: ${line}`)
      specs.push(parseFitSpecLine(line))
    }
  }

  return specs
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

export function parseParamFitSpecs(sourceText: string, param: ts.ParameterDeclaration): Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>[] {
  const lines = inlineFitCommentLines(sourceText, param)
  if (lines.length === 0) return []
  if (!ts.isIdentifier(param.name)) throw new Error('Param @fit comments support simple identifier parameters')
  const paramName = param.name.text
  return lines.map(line => parseInlineFitSpecLine(line, paramName, 'given-range'))
}

export function hasFitComment(sourceText: string, node: ts.Node): boolean {
  return fitCommentLines(sourceText, node).some(lines => lines.some(line => line === '@fit'))
}

export function hasInlineFitComment(sourceText: string, node: ts.Node): boolean {
  return inlineFitCommentLines(sourceText, node).length > 0
}

export function parseLocalFitSpecs(sourceText: string, statement: ts.VariableStatement): Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'}>[] {
  const lines = inlineFitCommentLines(sourceText, statement)
  if (lines.length === 0) return []
  const declarations = statement.declarationList.declarations
  if (declarations.length !== 1 || !ts.isIdentifier(declarations[0]!.name)) {
    throw new Error('Inline @fit comments support one simple variable declaration')
  }
  const expression = declarations[0]!.name.text
  return lines.map(line => parseInlineFitSpecLine(line, expression))
}

export function parseInlineFitSpecsForExpression(sourceText: string, node: ts.Node, expression: string): Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'}>[] {
  return inlineFitCommentLines(sourceText, node).map(line => parseInlineFitSpecLine(line, expression))
}

function fitCommentLines(sourceText: string, node: ts.Node): string[][] {
  const commentRanges = ts.getLeadingCommentRanges(sourceText, node.pos) ?? []
  return commentRanges.map(range => commentRangeLines(sourceText, range))
}

function inlineFitCommentLines(sourceText: string, node: ts.Node): string[] {
  const commentRanges = ts.getLeadingCommentRanges(sourceText, node.pos) ?? []
  return uniqueLines([
    ...commentRanges
      .flatMap(range => commentRangeLines(sourceText, range))
      .filter(line => line.startsWith('@fit ')),
    ...trailingLineFitCommentLines(sourceText, node),
  ])
}

function trailingLineFitCommentLines(sourceText: string, node: ts.Node): string[] {
  const lineEnd = sourceText.indexOf('\n', node.end)
  const restOfLine = sourceText.slice(node.end, lineEnd < 0 ? sourceText.length : lineEnd)
  const commentStart = restOfLine.indexOf('//')
  if (commentStart < 0) return []
  const line = cleanCommentLine(restOfLine.slice(commentStart))
  return line.startsWith('@fit ') ? [line] : []
}

function uniqueLines(lines: string[]) {
  return [...new Set(lines)]
}

function commentRangeLines(sourceText: string, range: ts.CommentRange): string[] {
  return sourceText.slice(range.pos, range.end).split(/\r?\n/).map(cleanCommentLine)
}

function cleanCommentLine(line: string) {
  return line
    .replace(/^\s*\/\*\*?/, '')
    .replace(/^\s*\/\//, '')
    .replace(/\*\/\s*$/, '')
    .replace(/^\s*\*\s?/, '')
    .trim()
}

const numberPattern = '-?\\d+(?:\\.\\d+)?'
const rangeNumberPattern = new RegExp(`^(?:${numberPattern}|-?Infinity)$`)

export function parseFitSpecLine(line: string): FitSpec {
  const givenRange = /^given\s+(.+)\s*:\s*(.+)$/.exec(line)
  if (givenRange != null) {
    const expression = givenRange[1]!.trim()
    const range = parseRangeText(givenRange[2]!.trim())
    if (range == null) throw new Error(`Unsupported @fit range: ${line}`)
    parseExpression(expression)
    return {
      kind: 'given-range',
      expression,
      range,
      text: line,
    }
  }

  const givenComparison = /^given\s+(.+?)\s*(==|>=|<=|>|<)\s*(.+)$/.exec(line)
  if (givenComparison != null) {
    const left = givenComparison[1]!.trim()
    const right = givenComparison[3]!.trim()
    parseExpression(left)
    parseExpression(right)
    return {
      kind: 'given-comparison',
      left,
      op: givenComparison[2]! as ComparisonOperator,
      right,
      text: line,
    }
  }

  const checkRange = /^(.+)\s*:\s*(.+)$/.exec(line)
  if (checkRange != null) {
    const expression = checkRange[1]!.trim()
    const range = parseRangeText(checkRange[2]!.trim())
    if (range == null) throw new Error(`Unsupported @fit range: ${line}`)
    parseExpression(expression)
    return {
      kind: 'check-range',
      expression,
      range,
      text: line,
    }
  }

  const checkComparison = /^(.+?)\s*(==|>=|<=|>|<)\s*(.+)$/.exec(line)
  if (checkComparison != null) {
    const left = checkComparison[1]!.trim()
    const right = checkComparison[3]!.trim()
    parseExpression(left)
    parseExpression(right)
    return {
      kind: 'check-comparison',
      left,
      op: checkComparison[2]! as ComparisonOperator,
      right,
      text: line,
    }
  }

  const checkAtom = parseCheckAtom(line)
  if (checkAtom != null) return checkAtom

  throw new Error(`Unsupported @fit line: ${line}`)
}

function parseRangeText(text: string): FitRange | null {
  const valueKindMatch = /^(?:(int)\s+)?([\s\S]+)$/.exec(text)
  if (valueKindMatch == null) return null
  const body = valueKindMatch[2]!.trim()
  const valueKind = valueKindMatch[1] == null ? 'number' : 'int'
  const bounds = splitRangeBounds(body)
  if (bounds != null) {
    const {lower, upper, upperInclusive} = bounds
    if (!isRangeBoundText(lower) || !isRangeBoundText(upper)) return null
    return {
      valueKind,
      lower,
      upper,
      lowerValue: parseRangeBoundNumber(lower),
      upperValue: parseRangeBoundNumber(upper),
      lowerInclusive: true,
      upperInclusive,
      text,
    }
  }
  if (isRangeBoundText(body)) {
    return {
      valueKind,
      lower: body,
      upper: body,
      lowerValue: parseRangeBoundNumber(body),
      upperValue: parseRangeBoundNumber(body),
      lowerInclusive: true,
      upperInclusive: true,
      text,
    }
  }
  return null
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

function parseInlineFitSpecLine(line: string, expression: string): Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'}>
function parseInlineFitSpecLine(line: string, expression: string, kind: 'given-range'): Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}>
function parseInlineFitSpecLine(
  line: string,
  expression: string,
  kind: 'check-range' | 'given-range' = 'check-range',
): Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'}> | Extract<FitSpec, {kind: 'given-range'} | {kind: 'given-comparison'}> {
  const body = line.slice('@fit'.length).trim()
  const comparison = /^(==|>=|<=|>|<)\s*(.+)$/.exec(body)
  if (comparison != null) {
    const right = comparison[2]!.trim()
    parseExpression(expression)
    parseExpression(right)
    if (kind === 'given-range') {
      return {
        kind: 'given-comparison',
        left: expression,
        op: comparison[1]! as ComparisonOperator,
        right,
        text: `given ${expression} ${comparison[1]} ${right}`,
      }
    }
    return {
      kind: 'check-comparison',
      left: expression,
      op: comparison[1]! as ComparisonOperator,
      right,
      text: `${expression} ${comparison[1]} ${right}`,
    }
  }
  const range = parseRangeText(body)
  if (range == null) throw new Error(`Unsupported inline @fit range: ${line}`)
  parseExpression(expression)
  if (kind === 'given-range') {
    return {
      kind,
      expression,
      range,
      text: `given ${expression}: ${body}`,
    }
  }
  return {
    kind,
    expression,
    range,
    text: `${expression}: ${body}`,
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

function parseCheckAtom(line: string): Extract<FitSpec, {kind: 'check-atom'}> | null {
  const expression = parseExpression(line)
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return null
  return {
    kind: 'check-atom',
    name: expression.expression.text,
    args: expression.arguments.map(argument => argument.getText()),
    text: line,
  }
}

export function parseExpression(text: string): ts.Expression {
  return parseFitExpression(text).expression
}

export function parseFitExpression(text: string): ParsedFitExpression {
  const domainPaths = new Map<string, FitDomainPath>()
  const sourceText = text.replace(domainPathPattern, match => {
    const domainPath = parseDomainPathText(match)
    if (domainPath == null || !domainPath.segments.some(segment => segment.kind === 'item')) return match
    const synthetic = domainPathSyntheticName(match)
    domainPaths.set(synthetic, domainPath)
    return synthetic
  })
  const sourceFile = ts.createSourceFile('fit-spec-expression.ts', `const value = ${sourceText}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const parseDiagnostics = (sourceFile as ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}).parseDiagnostics
  if (parseDiagnostics.length > 0 || sourceFile.statements.length !== 1) throw new Error(`Could not parse @fit expression: ${text}`)
  const statement = sourceFile.statements[0]
  if (statement == null || !ts.isVariableStatement(statement)) throw new Error(`Could not parse @fit expression: ${text}`)
  const declaration = statement.declarationList.declarations[0]
  if (declaration == null || declaration.initializer == null) throw new Error(`Could not parse @fit expression: ${text}`)
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
